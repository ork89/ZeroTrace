const tabStats = new Map();

function getStats(tabId) {
  if (!tabStats.has(tabId)) {
    tabStats.set(tabId, {
      network: 0,
      cosmetic: 0,
      scriptlet: 0,
    });
  }

  return tabStats.get(tabId);
}

function getTotal(stats) {
  return stats.network + stats.cosmetic + stats.scriptlet;
}

function updateBadge(tabId) {
  const stats = getStats(tabId);
  const total = getTotal(stats);
  const badgeText = total > 999 ? '999+' : total > 0 ? String(total) : '';

  chrome.action.setBadgeText({ tabId, text: badgeText });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#1e7a1e' });
  chrome.action.setTitle({
    tabId,
    title: `ZeroTrace\nBlocked: ${total}\nNetwork: ${stats.network}\nCosmetic: ${stats.cosmetic}\nScriptlet: ${stats.scriptlet}`,
  });
}

function resetTabStats(tabId) {
  tabStats.set(tabId, {
    network: 0,
    cosmetic: 0,
    scriptlet: 0,
  });
  updateBadge(tabId);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'loading' || !tab.url || !/^https?:/i.test(tab.url)) {
    return;
  }

  resetTabStats(tabId);

  chrome.scripting.executeScript(
    {
      target: { tabId },
      world: 'MAIN',
      injectImmediately: true,
      func: () => {
        try {
          const setTruthy = (name) => {
            try {
              Object.defineProperty(window, name, {
                configurable: true,
                get: () => true,
              });
            } catch {
              // ignore property-definition errors
            }
          };

          setTruthy('adsLoaded');
          setTruthy('canRunAds');

          if (!window.blockAdBlock) {
            window.blockAdBlock = {
              onDetected: () => window.blockAdBlock,
              onNotDetected: () => window.blockAdBlock,
              check: () => {},
              clearEvent: () => {},
            };
          }

          if (!window.fuckAdBlock) {
            window.fuckAdBlock = window.blockAdBlock;
          }
        } catch {
          // ignore scriptlet errors to avoid page disruption
        }
      },
    },
    () => {
      if (chrome.runtime.lastError) {
        return;
      }

      const stats = getStats(tabId);
      stats.scriptlet += 1;
      updateBadge(tabId);
    },
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'zerotrace-cosmetic-applied') {
    return;
  }

  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') {
    return;
  }

  const stats = getStats(tabId);
  stats.cosmetic = Number.isFinite(message.count) ? Math.max(0, Number(message.count)) : 0;
  updateBadge(tabId);
  sendResponse?.({ ok: true });
});

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId < 0 || details.error !== 'net::ERR_BLOCKED_BY_CLIENT') {
      return;
    }

    const stats = getStats(details.tabId);
    stats.network += 1;
    updateBadge(details.tabId);
  },
  { urls: ['<all_urls>'] },
);
