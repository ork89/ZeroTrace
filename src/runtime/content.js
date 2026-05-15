(() => {
  const STYLE_ID = 'zerotrace-cosmetic-style';
  const EMPTY_RULES = { globalSelectors: [], domainToChunk: {} };
  const DEFAULT_SETTINGS = {
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAnnoyancesEnabled': true,
    'zt.cosmeticFilteringEnabled': true,
    'zt.scriptletRuntimeEnabled': true,
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
  const antiAntiAdblockEngine = globalThis.ZeroTraceAntiAntiAdblockEngine?.createEngine({
    win: window,
    doc: document,
    pageLocation: location,
  });

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

  function restoreSuppressedOverlays() {
    antiAntiAdblockEngine?.restore();
  }

  function suppressKnownAntiAdblockOverlays() {
    if (!antiAntiAdblockEngine) {
      return 0;
    }

    return antiAntiAdblockEngine.suppress();
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
      return { appliedCount: 0, failedCount: 0 };
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
      const appliedCount = Number.isFinite(cachedCount) ? cachedCount : 0;
      return {
        appliedCount,
        failedCount: Math.max(0, selectors.length - appliedCount),
      };
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

    return {
      appliedCount,
      failedCount: Math.max(0, selectors.length - appliedCount),
    };
  }

  function reportCosmeticCount(count, selectorAppliedCount = 0, selectorFailedCount = 0) {
    chrome.runtime.sendMessage({
      type: 'zerotrace-cosmetic-applied',
      tabUrl: location.href,
      count,
      selectorAppliedCount,
      selectorFailedCount,
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
      reportCosmeticCount(0, 0, 0);
      return;
    }

    const annoyancesEnabled = isAnnoyancesEnabled();
    if (!annoyancesEnabled) {
      restoreSuppressedOverlays();
    }

    const selectorResult = ensureStyle(selectors, cssRef);
    const suppressedCount = annoyancesEnabled ? suppressKnownAntiAdblockOverlays() : 0;
    reportCosmeticCount(selectorResult.appliedCount + suppressedCount, selectorResult.appliedCount, selectorResult.failedCount);
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
