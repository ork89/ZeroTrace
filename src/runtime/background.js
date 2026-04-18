const tabStats = new Map();

const DEFAULT_SETTINGS = {
  'zt.enabled': true,
  'zt.networkBlockingEnabled': true,
  'zt.cosmeticFilteringEnabled': true,
  'zt.badgeEnabled': true,
};

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
const SETTINGS_MESSAGE_TYPE = 'zt-settings-updated';
const DEFAULT_ACTION_TITLE = 'ZeroTrace – Ad & Tracker Blocker';
const storageApi = (() => {
  try {
    return chrome.storage || null;
  } catch {
    return null;
  }
})();
const hasStorageApi = Boolean(storageApi?.local);

const manifestRuleResources = chrome.runtime.getManifest().declarative_net_request?.rule_resources || [];
const allRulesetIds = manifestRuleResources.map((resource) => resource.id);
const defaultEnabledRulesetIds = manifestRuleResources
  .filter((resource) => resource.enabled)
  .map((resource) => resource.id);

let settingsReady = false;
let currentSettings = { ...DEFAULT_SETTINGS };

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

function isMasterEnabled(settings = currentSettings) {
  return settings['zt.enabled'];
}

function isNetworkEnabled(settings = currentSettings) {
  return isMasterEnabled(settings) && settings['zt.networkBlockingEnabled'];
}

function isCosmeticEnabled(settings = currentSettings) {
  return isMasterEnabled(settings) && settings['zt.cosmeticFilteringEnabled'];
}

function isBadgeEnabled(settings = currentSettings) {
  return isMasterEnabled(settings) && settings['zt.badgeEnabled'];
}

async function getStorageSettings() {
  if (!hasStorageApi) {
    return {};
  }

  return new Promise((resolve) => {
    storageApi.local.get(SETTINGS_KEYS, (result) => {
      resolve(result || {});
    });
  });
}

async function setStorageSettings(values) {
  if (!hasStorageApi) {
    return;
  }

  return new Promise((resolve) => {
    storageApi.local.set(values, () => {
      resolve();
    });
  });
}

async function applyNetworkRulesetState(settings = currentSettings) {
  const shouldEnableNetwork = isNetworkEnabled(settings);
  const enableRulesetIds = shouldEnableNetwork ? defaultEnabledRulesetIds : [];
  const disableRulesetIds = shouldEnableNetwork
    ? allRulesetIds.filter((id) => !defaultEnabledRulesetIds.includes(id))
    : allRulesetIds;

  if (!enableRulesetIds.length && !disableRulesetIds.length) {
    return;
  }

  return new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.updateEnabledRulesets(
      {
        enableRulesetIds,
        disableRulesetIds,
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve();
      },
    );
  });
}

function clearBadgeForTab(tabId) {
  chrome.action.setBadgeText({ tabId, text: '' });
  chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE });
}

async function clearBadgesForAllTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (typeof tab.id === 'number') {
          clearBadgeForTab(tab.id);
        }
      }

      resolve();
    });
  });
}

function broadcastSettings(settings = currentSettings) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') {
        continue;
      }

      chrome.tabs.sendMessage(tab.id, {
        type: SETTINGS_MESSAGE_TYPE,
        settings,
      });
    }
  });
}

async function loadSettings() {
  const storedSettings = await getStorageSettings();
  currentSettings = normalizeSettings(storedSettings);
  settingsReady = true;
  await applyNetworkRulesetState(currentSettings);
  if (!isBadgeEnabled(currentSettings)) {
    await clearBadgesForAllTabs();
  }
}

async function applySettingsChanges(changedValues) {
  currentSettings = normalizeSettings({
    ...currentSettings,
    ...changedValues,
  });

  await applyNetworkRulesetState(currentSettings);

  if (!isBadgeEnabled(currentSettings)) {
    await clearBadgesForAllTabs();
  }

  broadcastSettings(currentSettings);
}

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
  if (!settingsReady || !isBadgeEnabled()) {
    clearBadgeForTab(tabId);
    return;
  }

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
  if (!settingsReady || !isNetworkEnabled() || info.status !== 'loading' || !tab.url || !/^https?:/i.test(tab.url)) {
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
  if (!message) {
    return;
  }

  if (message.type === SETTINGS_MESSAGE_TYPE) {
    applySettingsChanges(message.settings || {})
      .then(() => {
        sendResponse?.({ ok: true });
      })
      .catch(() => {
        sendResponse?.({ ok: false });
      });
    return true;
  }

  if (message.type === 'zt-reset-settings') {
    setStorageSettings(DEFAULT_SETTINGS)
      .then(() => applySettingsChanges(DEFAULT_SETTINGS))
      .then(() => {
        sendResponse?.({ ok: true });
      })
      .catch(() => {
        sendResponse?.({ ok: false });
      });
    return true;
  }

  if (message.type !== 'zerotrace-cosmetic-applied' || !settingsReady || !isCosmeticEnabled()) {
    sendResponse?.({ ok: true });
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
    if (!settingsReady || !isNetworkEnabled() || details.tabId < 0 || details.error !== 'net::ERR_BLOCKED_BY_CLIENT') {
      return;
    }

    const stats = getStats(details.tabId);
    stats.network += 1;
    updateBadge(details.tabId);
  },
  { urls: ['<all_urls>'] },
);

if (storageApi?.onChanged) {
  storageApi.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    const nextValues = {};
    let hasRelevantChange = false;

    for (const key of SETTINGS_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) {
        continue;
      }

      hasRelevantChange = true;
      nextValues[key] = changes[key].newValue;
    }

    if (!hasRelevantChange) {
      return;
    }

    applySettingsChanges(nextValues).catch(() => {
      // ignore storage change failures to keep runtime stable
    });
  });
}

loadSettings().catch(() => {
  settingsReady = true;
});
