const tabStats = new Map();
const THEME_MODE_VALUES = new Set(['system', 'light', 'dark']);
const NOTIFICATION_WINDOW_MS = 60_000;
const NOTIFICATION_MAX_PER_WINDOW = 3;
const NOTIFICATION_DEDUP_MS = 12_000;
const CURATED_SCRIPTLET_ALLOWLIST = new Set(['adsLoaded', 'canRunAds', 'blockAdBlock', 'fuckAdBlock']);
const EMPTY_SCRIPTLET_INDEX = Object.freeze({
  globalScriptlets: [],
  domainToChunk: {},
});

const DEFAULT_SETTINGS = {
  'zt.enabled': true,
  'zt.networkBlockingEnabled': true,
  'zt.blockAdsEnabled': true,
  'zt.blockTrackingEnabled': true,
  'zt.blockAnnoyancesEnabled': true,
  'zt.blockSocialEnabled': true,
  'zt.cosmeticFilteringEnabled': true,
  'zt.scriptletRuntimeEnabled': true,
  'zt.badgeEnabled': true,
  'zt.themeMode': 'system',
  'zt.notificationsEnabled': false,
  'zt.debugDiagnosticsEnabled': false,
  'zt.compactPopupMode': false,
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
const notificationDedup = new Map();
let notificationWindow = [];
let cosmeticRulesPromise = null;
let networkUnsupportedSummaryPromise = null;
const runtimeDiagnostics = {
  selector: {
    applySuccesses: 0,
    applyFailures: 0,
  },
  scriptlet: {
    runs: 0,
    failures: 0,
    ignored: 0,
  },
  hostBypassTransitions: {},
};

function normalizeThemeMode(value) {
  return typeof value === 'string' && THEME_MODE_VALUES.has(value) ? value : DEFAULT_SETTINGS['zt.themeMode'];
}

function incrementCounter(bucket, key, amount = 1) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return;
  }

  bucket[key] = (bucket[key] || 0) + amount;
}

function logDiagnostics(event, payload = {}) {
  if (!currentSettings['zt.debugDiagnosticsEnabled']) {
    return;
  }

  console.info('[ZeroTrace diagnostics]', {
    event,
    ...payload,
  });
}

function isNotificationAllowed() {
  return Boolean(chrome.notifications?.create) && Boolean(currentSettings['zt.notificationsEnabled']);
}

function checkNotificationWindow() {
  const now = Date.now();
  notificationWindow = notificationWindow.filter((at) => now - at < NOTIFICATION_WINDOW_MS);
  return notificationWindow.length < NOTIFICATION_MAX_PER_WINDOW;
}

function shouldNotify(key) {
  if (!isNotificationAllowed() || !checkNotificationWindow()) {
    return false;
  }

  const now = Date.now();
  const lastSent = notificationDedup.get(key) || 0;
  if (now - lastSent < NOTIFICATION_DEDUP_MS) {
    return false;
  }

  notificationDedup.set(key, now);
  notificationWindow.push(now);
  return true;
}

function sendNotification(key, title, message) {
  if (!shouldNotify(key)) {
    return;
  }

  try {
    chrome.notifications.create(
      `zt-${key}`,
      {
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title,
        message,
      },
      () => {
        // ignore create callback/runtime errors to keep host actions reliable
      },
    );
  } catch {
    // ignore notification failures to keep runtime stable
  }
}

function notifyHostStateChange(host, state) {
  if (!host) {
    return;
  }

  if (state === 'paused') {
    sendNotification(`host-paused-${host}`, `ZeroTrace paused on ${host}`, 'Blocking is paused for this site.');
    return;
  }

  if (state === 'whitelisted') {
    sendNotification(`host-whitelisted-${host}`, `ZeroTrace disabled on ${host}`, 'This site is now whitelisted.');
    return;
  }

  if (state === 'normal') {
    sendNotification(`host-resumed-${host}`, `ZeroTrace active on ${host}`, 'Protection is active again for this site.');
  }
}

function notifySettingsTransitions(previousSettings, nextSettings) {
  if (!nextSettings['zt.notificationsEnabled']) {
    return;
  }

  if (previousSettings['zt.enabled'] !== nextSettings['zt.enabled']) {
    if (nextSettings['zt.enabled']) {
      sendNotification('setting-enabled-on', 'ZeroTrace protection active', 'Core protections are running again.');
    } else {
      sendNotification(
        'setting-enabled-off',
        'ZeroTrace protection paused',
        'Network and cosmetic protections are off until re-enabled.',
      );
    }
  }

  if (
    previousSettings['zt.networkBlockingEnabled'] !== nextSettings['zt.networkBlockingEnabled'] &&
    nextSettings['zt.enabled']
  ) {
    if (nextSettings['zt.networkBlockingEnabled']) {
      sendNotification('setting-network-on', 'Network blocking active', 'Request-level blocking is active again.');
    } else {
      sendNotification('setting-network-off', 'Network blocking paused', 'Request-level blocking is currently disabled.');
    }
  }
}

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

  const previousState = resolveHostState(normalizedHost);

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
  const payload = getHostStateResponse(normalizedHost);
  const transitionKey = `${previousState}->${payload.state}`;
  if (previousState !== payload.state) {
    incrementCounter(runtimeDiagnostics.hostBypassTransitions, transitionKey);
    logDiagnostics('host-bypass-transition', {
      host: normalizedHost,
      transition: transitionKey,
    });
  }

  return payload;
}

function normalizeSettings(raw) {
  const next = { ...DEFAULT_SETTINGS };

  for (const key of SETTINGS_KEYS) {
    const value = raw?.[key];

    if (key === 'zt.themeMode') {
      next[key] = normalizeThemeMode(value);
      continue;
    }

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

function isAnnoyancesListEnabled(settings = currentSettings) {
  return isNetworkEnabled(settings) && settings['zt.blockAnnoyancesEnabled'];
}

function isSocialListEnabled(settings = currentSettings) {
  return isNetworkEnabled(settings) && settings['zt.blockSocialEnabled'];
}

function isRulesetEnabledForSettings(rulesetId, settings = currentSettings) {
  if (rulesetId.startsWith('ads_') || rulesetId.startsWith('youtube_ads_')) {
    return isAdsListEnabled(settings);
  }

  if (rulesetId.startsWith('tracking_')) {
    return isTrackingListEnabled(settings);
  }

  if (rulesetId.startsWith('annoyances_')) {
    return isAnnoyancesListEnabled(settings);
  }

  if (rulesetId.startsWith('social_')) {
    return isSocialListEnabled(settings);
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
  const normalizedSettings = normalizeSettings(storedSettings);
  const requiresMigration = SETTINGS_KEYS.some((key) => normalizedSettings[key] !== storedSettings?.[key]);

  currentSettings = normalizedSettings;

  if (requiresMigration) {
    await setStorageSettings(currentSettings);
  }

  settingsReady = true;
  await applyNetworkRulesetState(currentSettings);
  if (!isBadgeEnabled(currentSettings)) {
    await clearBadgesForAllTabs();
  }
}

async function applySettingsChanges(changedValues) {
  const previousSettings = currentSettings;
  currentSettings = normalizeSettings({
    ...currentSettings,
    ...changedValues,
  });

  await applyNetworkRulesetState(currentSettings);

  if (!isBadgeEnabled(currentSettings)) {
    await clearBadgesForAllTabs();
  }

  notifySettingsTransitions(previousSettings, currentSettings);

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

function isScriptletRuntimeEnabled(settings = currentSettings) {
  return isMasterEnabled(settings) && settings['zt.scriptletRuntimeEnabled'];
}

async function loadJsonAsset(relativePath) {
  try {
    const response = await fetch(chrome.runtime.getURL(relativePath));
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

async function getNetworkUnsupportedSummaryMetadata() {
  if (!networkUnsupportedSummaryPromise) {
    networkUnsupportedSummaryPromise = loadJsonAsset('network-unsupported-summary.json').then((payload) =>
      payload && typeof payload === 'object' ? payload : null,
    );
  }

  return networkUnsupportedSummaryPromise;
}

async function getRuntimeDiagnosticsSnapshot() {
  const networkUnsupportedSummary = await getNetworkUnsupportedSummaryMetadata();
  return {
    selector: {
      ...runtimeDiagnostics.selector,
    },
    scriptlet: {
      ...runtimeDiagnostics.scriptlet,
    },
    hostBypassTransitions: {
      ...runtimeDiagnostics.hostBypassTransitions,
    },
    networkUnsupportedSummary: {
      available: Boolean(networkUnsupportedSummary),
      metadata: networkUnsupportedSummary,
    },
  };
}

async function getCosmeticRules() {
  if (!cosmeticRulesPromise) {
    cosmeticRulesPromise = loadJsonAsset('cosmetic-rules.json').then((payload) =>
      payload && typeof payload === 'object' ? payload : {},
    );
  }

  return cosmeticRulesPromise;
}

function getDomainChain(host) {
  if (!host) {
    return [];
  }

  const parts = host.split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    out.push(parts.slice(i).join('.'));
  }

  return out;
}

function pickScriptletIndex(indexRoot) {
  if (!indexRoot || typeof indexRoot !== 'object') {
    return EMPTY_SCRIPTLET_INDEX;
  }

  const globalScriptlets = Array.isArray(indexRoot.globalScriptlets) ? indexRoot.globalScriptlets : [];
  const domainToChunk =
    indexRoot.domainToChunk && typeof indexRoot.domainToChunk === 'object' ? indexRoot.domainToChunk : {};

  return {
    globalScriptlets,
    domainToChunk,
  };
}

async function loadDomainScriptlets(host, indexRoot) {
  const index = pickScriptletIndex(indexRoot);
  const chunkNames = new Set();
  for (const domain of getDomainChain(host)) {
    const chunkName = index.domainToChunk?.[domain];
    if (typeof chunkName === 'string' && chunkName) {
      chunkNames.add(chunkName);
    }
  }

  if (!chunkNames.size) {
    return [];
  }

  const chunkPayloads = await Promise.all([...chunkNames].map((chunkName) => loadJsonAsset(`cosmetic/${chunkName}`)));
  const scriptlets = [];
  for (const payload of chunkPayloads) {
    if (!payload || typeof payload !== 'object') {
      continue;
    }

    for (const domain of getDomainChain(host)) {
      const domainScriptlets = payload[domain];
      if (Array.isArray(domainScriptlets)) {
        scriptlets.push(...domainScriptlets);
      }
    }
  }

  return scriptlets;
}

function normalizeScriptletEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || !CURATED_SCRIPTLET_ALLOWLIST.has(name)) {
    return null;
  }

  if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== 'string')) {
    return null;
  }

  if (raw.args.length !== 0) {
    return null;
  }

  const invocation =
    typeof raw.invocation === 'string' && raw.invocation.trim() ? raw.invocation.trim() : `+js(${name})`;

  return {
    name,
    args: [],
    invocation,
  };
}

async function resolveScriptletsForHost(host) {
  const rules = await getCosmeticRules();
  const scriptletIndex = pickScriptletIndex(rules?.scriptlets);
  const exceptionIndex = pickScriptletIndex(rules?.exceptions?.scriptlets);
  const candidates = [...scriptletIndex.globalScriptlets, ...(await loadDomainScriptlets(host, scriptletIndex))];
  const exceptions = [...exceptionIndex.globalScriptlets, ...(await loadDomainScriptlets(host, exceptionIndex))];

  const allowed = new Map();
  let ignored = 0;
  for (const candidate of candidates) {
    const normalized = normalizeScriptletEntry(candidate);
    if (normalized) {
      allowed.set(normalized.invocation, normalized);
    } else {
      ignored += 1;
    }
  }

  for (const exception of exceptions) {
    const normalized = normalizeScriptletEntry(exception);
    if (normalized) {
      if (allowed.delete(normalized.invocation)) {
        ignored += 1;
      }
    }
  }

  return {
    scriptlets: [...allowed.values()],
    ignored,
  };
}

function executeScriptlets(tabId, scriptlets) {
  if (!scriptlets.length) {
    return;
  }

  chrome.scripting.executeScript(
    {
      target: { tabId },
      world: 'MAIN',
      injectImmediately: true,
      args: [scriptlets],
      func: (entries) => {
        try {
          const ALLOWED = new Set(['adsLoaded', 'canRunAds', 'blockAdBlock', 'fuckAdBlock']);
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

          const ensureBlockAdBlock = () => {
            if (!window.blockAdBlock) {
              window.blockAdBlock = {
                onDetected: () => window.blockAdBlock,
                onNotDetected: () => window.blockAdBlock,
                check: () => {},
                clearEvent: () => {},
              };
            }

            return window.blockAdBlock;
          };

          for (const entry of Array.isArray(entries) ? entries : []) {
            if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !ALLOWED.has(entry.name)) {
              continue;
            }

            const args = Array.isArray(entry.args) ? entry.args : [];
            if (args.length !== 0) {
              continue;
            }

            switch (entry.name) {
              case 'adsLoaded':
              case 'canRunAds':
                setTruthy(entry.name);
                break;
              case 'blockAdBlock':
                ensureBlockAdBlock();
                break;
              case 'fuckAdBlock':
                window.fuckAdBlock = ensureBlockAdBlock();
                break;
              default:
                break;
            }
          }
        } catch {
          // ignore scriptlet errors to avoid page disruption
        }
      },
    },
    () => {
      if (chrome.runtime.lastError) {
        incrementCounter(runtimeDiagnostics.scriptlet, 'failures', scriptlets.length);
        logDiagnostics('scriptlet-run-failed', {
          tabId,
          count: scriptlets.length,
          error: chrome.runtime.lastError.message,
        });
        return;
      }

      const stats = getStats(tabId);
      stats.scriptlet += scriptlets.length;
      incrementCounter(runtimeDiagnostics.scriptlet, 'runs', scriptlets.length);
      updateBadge(tabId);
    },
  );
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

  if (isHostBypassed(host) || !isScriptletRuntimeEnabled()) {
    incrementCounter(runtimeDiagnostics.scriptlet, 'ignored', 1);
    updateBadge(tabId);
    return;
  }

  resolveScriptletsForHost(host)
    .then(({ scriptlets, ignored }) => {
      incrementCounter(runtimeDiagnostics.scriptlet, 'ignored', ignored);
      executeScriptlets(tabId, scriptlets);
    })
    .catch(() => {
      // ignore scriptlet resolution failures to keep runtime stable
    });
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
        notifyHostStateChange(payload?.host, payload?.state);
        sendResponse?.(payload);
      })
      .catch((error) => {
        sendResponse?.({
          ok: false,
          error: error instanceof Error && error.message ? error.message : 'Unable to update site controls.',
        });
      });
    return true;
  }

  if (message.type === 'zt-resume-host') {
    const host = normalizeHost(message.host) || hostFromUrl(message.url) || hostFromUrl(sender?.tab?.url || '');
    updateHostControl(host, 'normal')
      .then((payload) => {
        notifyHostStateChange(payload?.host, payload?.state);
        sendResponse?.(payload);
      })
      .catch((error) => {
        sendResponse?.({
          ok: false,
          error: error instanceof Error && error.message ? error.message : 'Unable to update site controls.',
        });
      });
    return true;
  }

  if (message.type === 'zt-whitelist-host') {
    const host = normalizeHost(message.host) || hostFromUrl(message.url) || hostFromUrl(sender?.tab?.url || '');
    updateHostControl(host, 'whitelisted')
      .then((payload) => {
        notifyHostStateChange(payload?.host, payload?.state);
        sendResponse?.(payload);
      })
      .catch((error) => {
        sendResponse?.({
          ok: false,
          error: error instanceof Error && error.message ? error.message : 'Unable to update site controls.',
        });
      });
    return true;
  }

  if (message.type === 'zt-unwhitelist-host') {
    const host = normalizeHost(message.host) || hostFromUrl(message.url) || hostFromUrl(sender?.tab?.url || '');
    updateHostControl(host, 'normal')
      .then((payload) => {
        notifyHostStateChange(payload?.host, payload?.state);
        sendResponse?.(payload);
      })
      .catch((error) => {
        sendResponse?.({
          ok: false,
          error: error instanceof Error && error.message ? error.message : 'Unable to update site controls.',
        });
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

  if (message.type === 'zt-get-runtime-diagnostics') {
    getRuntimeDiagnosticsSnapshot()
      .then((diagnostics) => {
        sendResponse?.({
          ok: true,
          diagnostics,
        });
      })
      .catch(() => {
        sendResponse?.({
          ok: false,
          error: 'Failed to collect runtime diagnostics.',
        });
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
  const selectorAppliedCount = Number.isFinite(message.selectorAppliedCount)
    ? Math.max(0, Number(message.selectorAppliedCount))
    : Math.max(0, Number(message.count) || 0);
  const selectorFailedCount = Number.isFinite(message.selectorFailedCount) ? Math.max(0, Number(message.selectorFailedCount)) : 0;
  incrementCounter(runtimeDiagnostics.selector, 'applySuccesses', selectorAppliedCount);
  incrementCounter(runtimeDiagnostics.selector, 'applyFailures', selectorFailedCount);
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
