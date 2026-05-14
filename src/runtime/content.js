(() => {
  const STYLE_ID = 'zerotrace-cosmetic-style';
  const EMPTY_RULES = { globalSelectors: [], domainToChunk: {} };
  const DEFAULT_SETTINGS = {
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAnnoyancesEnabled': true,
    'zt.cosmeticFilteringEnabled': true,
    'zt.badgeEnabled': true,
  };
  const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
  const HOST_STATE_CHANGED_MESSAGE_TYPE = 'zt-host-state-changed';
  const storageApi = (() => {
    try {
      return chrome.storage || null;
    } catch {
      return null;
    }
  })();
  const hasStorageApi = Boolean(storageApi?.local);

  let currentSettings = { ...DEFAULT_SETTINGS };
  let hostBypassed = false;
  let observer = null;
  let rafPending = false;
  const hiddenOverlayState = new Map();
  const pointerBypassState = new Map();
  const inertRemovedNodes = new Set();
  let overflowState = null;

  function normalizeHost(host) {
    if (typeof host !== 'string') {
      return null;
    }

    const normalized = host.trim().toLowerCase().replace(/\.+$/, '');
    return normalized || null;
  }

  function getCurrentHost() {
    return normalizeHost(location.hostname);
  }

  function normalizeSettings(raw) {
    const next = { ...DEFAULT_SETTINGS };

    for (const key of SETTINGS_KEYS) {
      const value = raw?.[key];
      if (typeof value === 'boolean') {
        next[key] = value;
      }
    }

    return next;
  }

  async function loadSettings() {
    if (!hasStorageApi) {
      return { ...DEFAULT_SETTINGS };
    }

    return new Promise((resolve) => {
      storageApi.local.get(SETTINGS_KEYS, (result) => {
        resolve(normalizeSettings(result));
      });
    });
  }

  function isCosmeticEnabled(settings = currentSettings) {
    return settings['zt.enabled'] && settings['zt.cosmeticFilteringEnabled'];
  }

  function isCosmeticActive() {
    return isCosmeticEnabled() && !hostBypassed;
  }

  function isAnnoyancesEnabled(settings = currentSettings) {
    return isCosmeticEnabled(settings) && settings['zt.blockAnnoyancesEnabled'];
  }

  function captureInlineStyleState(element, propertyName) {
    return {
      value: element.style.getPropertyValue(propertyName),
      priority: element.style.getPropertyPriority(propertyName),
    };
  }

  function restoreInlineStyleState(element, propertyName, state) {
    if (!state || !state.value) {
      element.style.removeProperty(propertyName);
      return;
    }

    element.style.setProperty(propertyName, state.value, state.priority || '');
  }

  function markHidden(element) {
    if (!hiddenOverlayState.has(element)) {
      hiddenOverlayState.set(element, {
        display: captureInlineStyleState(element, 'display'),
        visibility: captureInlineStyleState(element, 'visibility'),
      });
    }

    element.style.setProperty('display', 'none', 'important');
    element.style.setProperty('visibility', 'hidden', 'important');
    element.dataset.ztHiddenOverlay = '1';
  }

  function markPointerBypassed(element) {
    if (!pointerBypassState.has(element)) {
      pointerBypassState.set(element, captureInlineStyleState(element, 'pointer-events'));
    }

    element.style.setProperty('pointer-events', 'none', 'important');
  }

  function restorePointerBypassed() {
    for (const [element, state] of pointerBypassState) {
      restoreInlineStyleState(element, 'pointer-events', state);
    }

    pointerBypassState.clear();
  }

  function removeInertLocks() {
    for (const node of document.querySelectorAll('[inert]')) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (!inertRemovedNodes.has(node)) {
        inertRemovedNodes.add(node);
      }

      node.removeAttribute('inert');
    }
  }

  function restoreInertLocks() {
    for (const node of inertRemovedNodes) {
      if (node.isConnected) {
        node.setAttribute('inert', '');
      }
    }

    inertRemovedNodes.clear();
  }

  function ensureOverflowOverrideState() {
    if (overflowState) {
      return;
    }

    overflowState = {
      documentElement: {
        overflow: captureInlineStyleState(document.documentElement, 'overflow'),
        pointerEvents: captureInlineStyleState(document.documentElement, 'pointer-events'),
      },
      body: document.body
        ? {
            overflow: captureInlineStyleState(document.body, 'overflow'),
            pointerEvents: captureInlineStyleState(document.body, 'pointer-events'),
          }
        : null,
    };
  }

  function restoreSuppressedOverlays() {
    for (const [element, state] of hiddenOverlayState) {
      restoreInlineStyleState(element, 'display', state.display);
      restoreInlineStyleState(element, 'visibility', state.visibility);
      delete element.dataset.ztHiddenOverlay;
    }

    hiddenOverlayState.clear();
    restorePointerBypassed();
    restoreInertLocks();

    if (!overflowState) {
      return;
    }

    restoreInlineStyleState(document.documentElement, 'overflow', overflowState.documentElement.overflow);
    restoreInlineStyleState(document.documentElement, 'pointer-events', overflowState.documentElement.pointerEvents);

    if (document.body) {
      restoreInlineStyleState(document.body, 'overflow', overflowState.body?.overflow);
      restoreInlineStyleState(document.body, 'pointer-events', overflowState.body?.pointerEvents);
    }

    overflowState = null;
  }

  function suppressKnownAntiAdblockOverlays() {
    if (!/(^|\.)howtogeek\.com$/i.test(location.hostname)) {
      return 0;
    }

    const textPattern = /we noticed that ads aren't being displayed\./i;
    const knownBlockers = document.querySelectorAll('dialog[open], .adblock, [class*="adblock"], [id*="adblock"]');
    const candidates = document.querySelectorAll('div, section, aside, article, dialog');
    let hiddenCount = 0;

    for (const node of knownBlockers) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (node.dataset.ztHiddenOverlay !== '1') {
        markHidden(node);
        hiddenCount += 1;
      }

      markPointerBypassed(node);

      if (node instanceof HTMLDialogElement && node.open) {
        try {
          node.close();
        } catch {
          // ignore dialog close failures
        }
      }
    }

    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (!textPattern.test(node.textContent || '')) {
        continue;
      }

      let current = node;
      for (let depth = 0; depth < 16 && current && current !== document.documentElement; depth += 1) {
        const computed = getComputedStyle(current);
        const zIndex = Number.parseInt(computed.zIndex || '0', 10);
        const className = typeof current.className === 'string' ? current.className.toLowerCase() : '';
        const overlayLike =
          current.tagName === 'DIALOG' ||
          className.includes('adblock') ||
          computed.position === 'fixed' ||
          computed.position === 'absolute' ||
          zIndex >= 100;

        if (overlayLike) {
          if (current.dataset.ztHiddenOverlay !== '1') {
            markHidden(current);
            hiddenCount += 1;
          }

          markPointerBypassed(current);
        }

        current = current.parentElement;
      }
    }

    removeInertLocks();

    if (hiddenCount > 0 || pointerBypassState.size > 0 || inertRemovedNodes.size > 0) {
      ensureOverflowOverrideState();
      document.documentElement.style.setProperty('overflow', 'auto', 'important');
      document.documentElement.style.setProperty('pointer-events', 'auto', 'important');

      if (document.body) {
        document.body.style.setProperty('overflow', 'auto', 'important');
        document.body.style.setProperty('pointer-events', 'auto', 'important');
      }
    }

    return hiddenCount;
  }

  function removeStyle() {
    const style = document.getElementById(STYLE_ID);
    if (style) {
      style.remove();
    }
  }

  async function loadRulesIndex() {
    try {
      const url = chrome.runtime.getURL('cosmetic-rules.json');
      const res = await fetch(url);
      if (!res.ok) {
        return EMPTY_RULES;
      }

      return await res.json();
    } catch {
      return EMPTY_RULES;
    }
  }

  async function loadChunk(fileName) {
    try {
      const url = chrome.runtime.getURL(`cosmetic/${fileName}`);
      const res = await fetch(url);
      if (!res.ok) {
        return {};
      }

      return await res.json();
    } catch {
      return {};
    }
  }

  function domainChain(hostname) {
    const parts = hostname.split('.').filter(Boolean);
    const out = [];

    for (let i = 0; i < parts.length - 1; i += 1) {
      out.push(parts.slice(i).join('.'));
    }

    return out;
  }

  function computeSelectors(indexRules, chunkPayloads) {
    const selectors = new Set(indexRules.globalSelectors || []);
    const domainToChunk = indexRules.domainToChunk || {};
    const mergedDomainRules = {};

    for (const payload of chunkPayloads) {
      Object.assign(mergedDomainRules, payload);
    }

    for (const domain of domainChain(location.hostname)) {
      if (!domainToChunk[domain]) {
        continue;
      }

      const domainRules = mergedDomainRules[domain];
      if (!domainRules) {
        continue;
      }

      for (const selector of domainRules) {
        selectors.add(selector);
      }
    }

    return [...selectors];
  }

  function ensureStyle(selectors, lastCssRef) {
    if (!selectors.length) {
      return 0;
    }

    let style = document.getElementById(STYLE_ID);
    const isNewStyleNode = !style;
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.documentElement || document.head || document.body)?.appendChild(style);
    }

    const signature = selectors.join('\n');
    if (!isNewStyleNode && lastCssRef.value === signature) {
      const cachedCount = Number.parseInt(style.dataset.appliedCount || '0', 10);
      return Number.isFinite(cachedCount) ? cachedCount : 0;
    }

    const ruleBody = 'display: none !important; visibility: hidden !important;';

    // Use per-selector insertion so one invalid selector does not invalidate all rules.
    const sheet = style.sheet;
    let appliedCount = 0;
    if (sheet) {
      while (sheet.cssRules.length > 0) {
        sheet.deleteRule(sheet.cssRules.length - 1);
      }

      for (const selector of selectors) {
        try {
          sheet.insertRule(`${selector} { ${ruleBody} }`, sheet.cssRules.length);
          appliedCount += 1;
        } catch {
          // Skip unsupported cosmetic selector syntaxes (e.g. +js, :has-text).
        }
      }
    } else {
      style.textContent = selectors.map((selector) => `${selector} { ${ruleBody} }`).join('\n');
      appliedCount = selectors.length;
    }

    style.dataset.appliedCount = String(appliedCount);
    lastCssRef.value = signature;

    return appliedCount;
  }

  function reportCosmeticCount(count) {
    chrome.runtime.sendMessage({
      type: 'zerotrace-cosmetic-applied',
      tabUrl: location.href,
      count,
    });
  }

  function stopObserver() {
    if (!observer) {
      return;
    }

    observer.disconnect();
    observer = null;
  }

  function startObserver(apply) {
    if (observer) {
      return;
    }

    observer = new MutationObserver(() => {
      if (rafPending) {
        return;
      }

      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        apply();
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function applyMode(selectors, cssRef) {
    if (!isCosmeticActive()) {
      stopObserver();
      removeStyle();
        restoreSuppressedOverlays();
      reportCosmeticCount(0);
      return;
    }

      const annoyancesEnabled = isAnnoyancesEnabled();
      if (!annoyancesEnabled) {
        restoreSuppressedOverlays();
      }

    const appliedCount = ensureStyle(selectors, cssRef);
      const suppressedCount = annoyancesEnabled ? suppressKnownAntiAdblockOverlays() : 0;
    reportCosmeticCount(appliedCount + suppressedCount);
    startObserver(() => {
      ensureStyle(selectors, cssRef);
        if (isAnnoyancesEnabled()) {
        suppressKnownAntiAdblockOverlays();
        } else {
          restoreSuppressedOverlays();
      }
    });
  }

  async function start() {
    let selectors = [];
    let selectorsLoaded = false;
    const cssRef = { value: '' };

    async function ensureSelectorsLoaded() {
      if (selectorsLoaded) {
        return selectors;
      }

      const rulesIndex = await loadRulesIndex();
      const domainToChunk = rulesIndex.domainToChunk || {};

      const chunkNames = new Set();
      for (const domain of domainChain(location.hostname)) {
        const chunkName = domainToChunk[domain];
        if (chunkName) {
          chunkNames.add(chunkName);
        }
      }

      const chunkPayloads = await Promise.all([...chunkNames].map((chunkName) => loadChunk(chunkName)));
      selectors = computeSelectors(rulesIndex, chunkPayloads);
      selectorsLoaded = true;

      return selectors;
    }

    async function applyCurrentMode() {
      if (!isCosmeticActive()) {
        applyMode([], cssRef);
        return;
      }

      const loadedSelectors = await ensureSelectorsLoaded();
      applyMode(loadedSelectors, cssRef);
    }

    currentSettings = await loadSettings();

    const hostState = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'zt-get-host-state',
            host: getCurrentHost(),
            url: location.href,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }

            resolve(response || null);
          },
        );
      } catch {
        resolve(null);
      }
    });

    hostBypassed = Boolean(hostState?.bypassed);
    await applyCurrentMode();

    if (storageApi?.onChanged) {
      storageApi.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') {
          return;
        }

        let hasRelevantChange = false;
        const nextValues = { ...currentSettings };

        for (const key of SETTINGS_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(changes, key)) {
            continue;
          }

          hasRelevantChange = true;
          const value = changes[key].newValue;
          nextValues[key] = typeof value === 'boolean' ? value : DEFAULT_SETTINGS[key];
        }

        if (!hasRelevantChange) {
          return;
        }

        currentSettings = normalizeSettings(nextValues);
        applyCurrentMode().catch(() => {
          // ignore dynamic apply errors to keep pages stable
        });
      });
    }

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== HOST_STATE_CHANGED_MESSAGE_TYPE) {
        return;
      }

      const currentHost = getCurrentHost();
      if (!currentHost || normalizeHost(message.host) !== currentHost) {
        return;
      }

      hostBypassed = Boolean(message.bypassed);
      applyCurrentMode().catch(() => {
        // ignore dynamic host-state apply errors to keep pages stable
      });
    });
  }

  start();
})();
