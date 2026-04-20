const tabStats = new Map();

const DEFAULT_SETTINGS = {
  'zt.enabled': true,
  'zt.networkBlockingEnabled': true,
  'zt.blockAdsEnabled': true,
  'zt.blockTrackingEnabled': true,
  'zt.cosmeticFilteringEnabled': true,
  'zt.badgeEnabled': true,
};

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
const SETTINGS_MESSAGE_TYPE = 'zt-settings-updated';
const HOST_STATE_CHANGED_MESSAGE_TYPE = 'zt-host-state-changed';
const WHITELIST_STORAGE_KEY = 'zt.whitelist';
const PAUSED_HOSTS_STORAGE_KEY = 'zt.pausedHosts';
const SESSION_RULE_PRIORITY = 10_000;
const DEFAULT_ACTION_TITLE = 'ZeroTrace – Ad & Tracker Blocker';
const storageApi = (() => {
  try {
    return chrome.storage || null;
  } catch {
    return null;
  }
})();
const hasStorageApi = Boolean(storageApi?.local);
const hasSessionStorageApi = Boolean(storageApi?.session);

const manifestRuleResources = chrome.runtime.getManifest().declarative_net_request?.rule_resources || [];
const allRulesetIds = manifestRuleResources.map((resource) => resource.id);
const defaultEnabledRulesetIds = manifestRuleResources
  .filter((resource) => resource.enabled)
  .map((resource) => resource.id);

let settingsReady = false;
let currentSettings = { ...DEFAULT_SETTINGS };
let whitelistedHosts = new Set();
let pausedHosts = new Set();
const tabHosts = new Map();

function normalizeHost(host) {
  if (typeof host !== 'string') {
    return null;
  }

  const normalized = host.trim().toLowerCase().replace(/\.+$/, '');
  return normalized || null;
}

function normalizeHostList(rawHosts) {
  if (!Array.isArray(rawHosts)) {
    return [];
  }

  const out = new Set();
  for (const host of rawHosts) {
    const normalized = normalizeHost(host);
    if (normalized) {
      out.add(normalized);
    }
  }

  return [...out].sort();
}

function hostFromUrl(url) {
  if (typeof url !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(url);
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

function isHostBypassed(host) {
  return Boolean(host && (pausedHosts.has(host) || whitelistedHosts.has(host)));
}

function resolveHostState(host) {
  if (!host) {
    return 'unsupported-url';
  }

  if (!isMasterEnabled()) {
    return 'global-off';
  }

  if (whitelistedHosts.has(host)) {
    return 'whitelisted';
  }

  if (pausedHosts.has(host)) {
    return 'paused';
  }

  return 'normal';
}

function getDeterministicSessionRuleId(kind, host) {
  const input = `${kind}:${host}`;
  let hash = 2166136261;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return ((hash >>> 0) % 1_000_000_000) + 1;
}

function buildPerSiteSessionRules() {
  const rules = [];

  for (const host of pausedHosts) {
    rules.push({
      id: getDeterministicSessionRuleId('paused', host),
      priority: SESSION_RULE_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }

  for (const host of whitelistedHosts) {
    rules.push({
      id: getDeterministicSessionRuleId('whitelist', host),
      priority: SESSION_RULE_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }

  return rules.sort((a, b) => a.id - b.id);
}

async function updateSessionRules(removeRuleIds, addRules) {
  if (!removeRuleIds.length && !addRules.length) {
    return;
  }

  return new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.updateSessionRules(
      {
        removeRuleIds,
        addRules,
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

async function replaceManagedSessionRules() {
  const nextRules = buildPerSiteSessionRules();
  const nextRuleIds = new Set(nextRules.map((rule) => rule.id));

  const existingRules = await new Promise((resolve) => {
    chrome.declarativeNetRequest.getSessionRules((rules) => {
      resolve(Array.isArray(rules) ? rules : []);
    });
  });

  const managedRuleIds = existingRules
    .filter(
      (rule) =>
        Number.isFinite(rule?.id) &&
        rule?.priority === SESSION_RULE_PRIORITY &&
        rule?.action?.type === 'allowAllRequests',
    )
    .map((rule) => rule.id)
    .filter((id) => !nextRuleIds.has(id));

  await updateSessionRules(managedRuleIds, nextRules);
}

function emitHostStateChanged(host) {
  const state = resolveHostState(host);
  const payload = {
    type: HOST_STATE_CHANGED_MESSAGE_TYPE,
    host,
    state,
    globalEnabled: isMasterEnabled(),
    paused: pausedHosts.has(host),
    whitelisted: whitelistedHosts.has(host),
    bypassed: state === 'paused' || state === 'whitelisted',
  };

  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') {
        continue;
      }

      chrome.tabs.sendMessage(tab.id, payload);
    }
  });
}

function getHostStateResponse(host) {
  const state = resolveHostState(host);

  return {
    ok: true,
    host,
    state,
    globalEnabled: isMasterEnabled(),
    paused: Boolean(host && pausedHosts.has(host)),
    whitelisted: Boolean(host && whitelistedHosts.has(host)),
    bypassed: state === 'paused' || state === 'whitelisted',
  };
}

async function getPerSiteStorageState() {
  const localData = await new Promise((resolve) => {
    if (!storageApi?.local) {
      resolve({});
      return;
    }

    storageApi.local.get([WHITELIST_STORAGE_KEY], (result) => {
      resolve(result || {});
    });
  });

  const sessionData = await new Promise((resolve) => {
    if (!storageApi?.session) {
      resolve({});
      return;
    }

    storageApi.session.get([PAUSED_HOSTS_STORAGE_KEY], (result) => {
      resolve(result || {});
    });
  });

  return {
    whitelisted: normalizeHostList(localData?.[WHITELIST_STORAGE_KEY]),
    paused: normalizeHostList(sessionData?.[PAUSED_HOSTS_STORAGE_KEY]),
  };
}

async function persistPerSiteStorageState() {
  const localWrite = new Promise((resolve) => {
    if (!storageApi?.local) {
      resolve();
      return;
    }

    storageApi.local.set(
      {
        [WHITELIST_STORAGE_KEY]: [...whitelistedHosts].sort(),
      },
      () => {
        resolve();
      },
    );
  });

  const sessionWrite = new Promise((resolve) => {
    if (!storageApi?.session) {
      resolve();
      return;
    }

    storageApi.session.set(
      {
        [PAUSED_HOSTS_STORAGE_KEY]: [...pausedHosts].sort(),
      },
      () => {
        resolve();
      },
    );
  });

  await Promise.all([localWrite, sessionWrite]);
}

async function loadPerSiteState() {
  const state = await getPerSiteStorageState();
  whitelistedHosts = new Set(state.whitelisted);
  pausedHosts = new Set(state.paused.filter((host) => !whitelistedHosts.has(host)));
  await persistPerSiteStorageState();
  await replaceManagedSessionRules();
}

async function updateHostControl(host, mode) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) {
    return getHostStateResponse(null);
  }

  if (mode === 'paused') {
    whitelistedHosts.delete(normalizedHost);
    pausedHosts.add(normalizedHost);
  } else if (mode === 'whitelisted') {
    pausedHosts.delete(normalizedHost);
    whitelistedHosts.add(normalizedHost);
  } else if (mode === 'normal') {
    pausedHosts.delete(normalizedHost);
    whitelistedHosts.delete(normalizedHost);
  }

  await persistPerSiteStorageState();
  await replaceManagedSessionRules();
  emitHostStateChanged(normalizedHost);

  return getHostStateResponse(normalizedHost);
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

function isMasterEnabled(settings = currentSettings) {
  return settings['zt.enabled'];
}

function isNetworkEnabled(settings = currentSettings) {
  return isMasterEnabled(settings) && settings['zt.networkBlockingEnabled'];
}

function isAdsListEnabled(settings = currentSettings) {
  return isNetworkEnabled(settings) && settings['zt.blockAdsEnabled'];
}

function isTrackingListEnabled(settings = currentSettings) {
  return isNetworkEnabled(settings) && settings['zt.blockTrackingEnabled'];
}

function isRulesetEnabledForSettings(rulesetId, settings = currentSettings) {
  if (rulesetId.startsWith('ads_') || rulesetId.startsWith('youtube_ads_')) {
    return isAdsListEnabled(settings);
  }

  if (rulesetId.startsWith('tracking_')) {
    return isTrackingListEnabled(settings);
  }

  return isNetworkEnabled(settings);
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
  const enableRulesetIds = isNetworkEnabled(settings)
    ? allRulesetIds.filter((id) => defaultEnabledRulesetIds.includes(id) && isRulesetEnabledForSettings(id, settings))
    : [];
  const enabledRulesetIds = new Set(enableRulesetIds);
  const disableRulesetIds = allRulesetIds.filter((id) => !enabledRulesetIds.has(id));

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
  if (info.status !== 'loading' || !tab.url || !/^https?:/i.test(tab.url)) {
    return;
  }

  const host = hostFromUrl(tab.url);
  if (host) {
    tabHosts.set(tabId, host);
  } else {
    tabHosts.delete(tabId);
  }

  if (!settingsReady || !isMasterEnabled()) {
    return;
  }

  resetTabStats(tabId);

  if (isHostBypassed(host)) {
    updateBadge(tabId);
    return;
  }

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
  tabHosts.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return;
  }

  if (message.type === 'zt-get-host-state') {
    const host = normalizeHost(message.host) || hostFromUrl(message.url) || hostFromUrl(sender?.tab?.url || '') || null;
    sendResponse?.(getHostStateResponse(host));
    return;
  }

  if (message.type === 'zt-pause-host') {
    const host = normalizeHost(message.host) || hostFromUrl(message.url) || hostFromUrl(sender?.tab?.url || '');
    updateHostControl(host, 'paused')
      .then((payload) => {
        sendResponse?.(payload);
      })
      .catch(() => {
        sendResponse?.({ ok: false });
      });
    return true;
  }

  if (message.type === 'zt-resume-host') {
    const host = normalizeHost(message.host) || hostFromUrl(message.url) || hostFromUrl(sender?.tab?.url || '');
    updateHostControl(host, 'normal')
      .then((payload) => {
        sendResponse?.(payload);
      })
      .catch(() => {
        sendResponse?.({ ok: false });
      });
    return true;
  }

  if (message.type === 'zt-whitelist-host') {
    const host = normalizeHost(message.host) || hostFromUrl(message.url) || hostFromUrl(sender?.tab?.url || '');
    updateHostControl(host, 'whitelisted')
      .then((payload) => {
        sendResponse?.(payload);
      })
      .catch(() => {
        sendResponse?.({ ok: false });
      });
    return true;
  }

  if (message.type === 'zt-unwhitelist-host') {
    const host = normalizeHost(message.host) || hostFromUrl(message.url) || hostFromUrl(sender?.tab?.url || '');
    updateHostControl(host, 'normal')
      .then((payload) => {
        sendResponse?.(payload);
      })
      .catch(() => {
        sendResponse?.({ ok: false });
      });
    return true;
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

  if (isHostBypassed(tabHosts.get(tabId))) {
    const stats = getStats(tabId);
    stats.cosmetic = 0;
    updateBadge(tabId);
    sendResponse?.({ ok: true });
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

    if (isHostBypassed(tabHosts.get(details.tabId))) {
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

Promise.all([loadSettings(), loadPerSiteState()]).catch(() => {
  settingsReady = true;
});
