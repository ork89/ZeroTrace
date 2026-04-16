(() => {
  const STYLE_ID = 'zerotrace-cosmetic-style';
  const EMPTY_RULES = { globalSelectors: [], domainToChunk: {} };

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
      return;
    }

    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.documentElement || document.head || document.body)?.appendChild(style);
    }

    const cssText = `${selectors.join(',\n')} { display: none !important; visibility: hidden !important; }`;
    if (lastCssRef.value !== cssText) {
      style.textContent = cssText;
      lastCssRef.value = cssText;
    }
  }

  function reportCosmeticCount(count) {
    chrome.runtime.sendMessage({
      type: 'zerotrace-cosmetic-applied',
      tabUrl: location.href,
      count,
    });
  }

  async function start() {
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
    const selectors = computeSelectors(rulesIndex, chunkPayloads);
    const cssRef = { value: '' };

    const apply = () => ensureStyle(selectors, cssRef);

    apply();
    reportCosmeticCount(selectors.length);

    let rafPending = false;

    const observer = new MutationObserver(() => {
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

  start();
})();
