import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

type SettingsShape = {
  'zt.enabled'?: boolean;
  'zt.networkBlockingEnabled'?: boolean;
  'zt.blockAdsEnabled'?: boolean;
  'zt.blockTrackingEnabled'?: boolean;
  'zt.blockAnnoyancesEnabled'?: boolean;
  'zt.blockSocialEnabled'?: boolean;
  'zt.cosmeticFilteringEnabled'?: boolean;
  'zt.badgeEnabled'?: boolean;
  'zt.notificationsEnabled'?: boolean;
  'zt.debugDiagnosticsEnabled'?: boolean;
  'zt.compactPopupMode'?: boolean;
  'zt.themeMode'?: 'system' | 'light' | 'dark' | string;
};

type RulesetUpdate = {
  enableRulesetIds: string[];
  disableRulesetIds: string[];
};

function createBackgroundChromeMock(storedSettings: SettingsShape) {
  const updateEnabledCalls: RulesetUpdate[] = [];

  const chrome = {
    runtime: {
      lastError: null as { message: string } | null,
      getManifest: () => ({
        declarative_net_request: {
          rule_resources: [
            { id: 'ads_1', enabled: true },
            { id: 'tracking_1', enabled: true },
            { id: 'youtube_ads_1', enabled: true },
            { id: 'annoyances_1', enabled: true },
            { id: 'social_1', enabled: true },
          ],
        },
      }),
      onMessage: {
        addListener: () => {
          // no-op in tests
        },
      },
    },
    declarativeNetRequest: {
      updateEnabledRulesets: (payload: RulesetUpdate, cb: () => void) => {
        updateEnabledCalls.push({
          enableRulesetIds: [...payload.enableRulesetIds],
          disableRulesetIds: [...payload.disableRulesetIds],
        });
        cb();
      },
      getSessionRules: (cb: (rules: unknown[]) => void) => {
        cb([]);
      },
      updateSessionRules: (_payload: unknown, cb: () => void) => {
        cb();
      },
    },
    tabs: {
      query: (_query: unknown, cb: (tabs: unknown[]) => void) => {
        cb([]);
      },
      sendMessage: () => {
        // no-op in tests
      },
      onUpdated: {
        addListener: () => {
          // no-op in tests
        },
      },
      onRemoved: {
        addListener: () => {
          // no-op in tests
        },
      },
    },
    scripting: {
      executeScript: (_payload: unknown, cb: () => void) => {
        cb();
      },
    },
    action: {
      setBadgeText: () => {
        // no-op in tests
      },
      setBadgeBackgroundColor: () => {
        // no-op in tests
      },
      setTitle: () => {
        // no-op in tests
      },
    },
    webRequest: {
      onErrorOccurred: {
        addListener: () => {
          // no-op in tests
        },
      },
    },
    storage: {
      local: {
        get: (_keys: unknown, cb: (result: SettingsShape) => void) => {
          cb({ ...storedSettings });
        },
        set: (_values: unknown, cb: () => void) => {
          cb();
        },
      },
      session: {
        get: (_keys: unknown, cb: (result: Record<string, unknown>) => void) => {
          cb({});
        },
        set: (_values: unknown, cb: () => void) => {
          cb();
        },
      },
      onChanged: {
        addListener: () => {
          // no-op in tests
        },
      },
    },
  };

  return { chrome, updateEnabledCalls };
}

async function loadBackgroundAndGetLatestRulesetUpdate(storedSettings: SettingsShape): Promise<RulesetUpdate> {
  const backgroundPath = path.resolve('./src/runtime/background.js');
  const code = fs.readFileSync(backgroundPath, 'utf8');
  const { chrome, updateEnabledCalls } = createBackgroundChromeMock(storedSettings);

  const context = vm.createContext({
    chrome,
    URL,
    Promise,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  vm.runInContext(code, context, { filename: 'background.js' });

  // The script bootstraps asynchronously via Promise.all(loadSettings, loadPerSiteState).
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(updateEnabledCalls.length > 0, 'Expected at least one ruleset update call');
  return updateEnabledCalls[updateEnabledCalls.length - 1];
}

async function runBackgroundRulesetScenarios() {
  const adsOff = await loadBackgroundAndGetLatestRulesetUpdate({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAdsEnabled': false,
    'zt.blockTrackingEnabled': true,
    'zt.blockAnnoyancesEnabled': false,
    'zt.blockSocialEnabled': false,
  });
  assert.deepEqual(adsOff.enableRulesetIds, ['tracking_1']);
  assert.deepEqual(adsOff.disableRulesetIds, ['ads_1', 'youtube_ads_1', 'annoyances_1', 'social_1']);

  const trackingOff = await loadBackgroundAndGetLatestRulesetUpdate({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAdsEnabled': true,
    'zt.blockTrackingEnabled': false,
    'zt.blockAnnoyancesEnabled': false,
    'zt.blockSocialEnabled': false,
  });
  assert.deepEqual(trackingOff.enableRulesetIds, ['ads_1', 'youtube_ads_1']);
  assert.deepEqual(trackingOff.disableRulesetIds, ['tracking_1', 'annoyances_1', 'social_1']);

  const annoyancesOff = await loadBackgroundAndGetLatestRulesetUpdate({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAdsEnabled': false,
    'zt.blockTrackingEnabled': false,
    'zt.blockAnnoyancesEnabled': false,
    'zt.blockSocialEnabled': true,
  });
  assert.deepEqual(annoyancesOff.enableRulesetIds, ['social_1']);
  assert.deepEqual(annoyancesOff.disableRulesetIds, ['ads_1', 'tracking_1', 'youtube_ads_1', 'annoyances_1']);

  const socialOff = await loadBackgroundAndGetLatestRulesetUpdate({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAdsEnabled': false,
    'zt.blockTrackingEnabled': false,
    'zt.blockAnnoyancesEnabled': true,
    'zt.blockSocialEnabled': false,
  });
  assert.deepEqual(socialOff.enableRulesetIds, ['annoyances_1']);
  assert.deepEqual(socialOff.disableRulesetIds, ['ads_1', 'tracking_1', 'youtube_ads_1', 'social_1']);

  const networkOff = await loadBackgroundAndGetLatestRulesetUpdate({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': false,
    'zt.blockAdsEnabled': true,
    'zt.blockTrackingEnabled': true,
    'zt.blockAnnoyancesEnabled': true,
    'zt.blockSocialEnabled': true,
  });
  assert.deepEqual(networkOff.enableRulesetIds, []);
  assert.deepEqual(networkOff.disableRulesetIds, ['ads_1', 'tracking_1', 'youtube_ads_1', 'annoyances_1', 'social_1']);

  const allOn = await loadBackgroundAndGetLatestRulesetUpdate({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAdsEnabled': true,
    'zt.blockTrackingEnabled': true,
    'zt.blockAnnoyancesEnabled': true,
    'zt.blockSocialEnabled': true,
  });
  assert.deepEqual(allOn.enableRulesetIds, ['ads_1', 'tracking_1', 'youtube_ads_1', 'annoyances_1', 'social_1']);
  assert.deepEqual(allOn.disableRulesetIds, []);
}

async function runSettingsNormalizationChecks() {
  const settingsPath = path.resolve('./src/runtime/settings.js');
  const code = fs.readFileSync(settingsPath, 'utf8');

  const context = vm.createContext({
    chrome: {
      storage: {
        local: {
          get: (_keys: unknown, cb: (result: Record<string, unknown>) => void) => cb({}),
          set: (_values: unknown, cb: () => void) => cb(),
        },
      },
    },
    globalThis: {},
  });

  vm.runInContext(code, context, { filename: 'settings.js' });

  const api = (
    context.globalThis as {
      ZeroTraceSettings?: {
        DEFAULT_SETTINGS: Record<string, boolean | string>;
        normalizeSettings: (raw: Record<string, unknown>) => Record<string, boolean | string>;
      };
    }
  ).ZeroTraceSettings;
  assert.ok(api, 'Expected ZeroTraceSettings API to be initialized');

  const defaults = api.DEFAULT_SETTINGS;
  assert.equal(defaults['zt.blockAdsEnabled'], true);
  assert.equal(defaults['zt.blockTrackingEnabled'], true);
  assert.equal(defaults['zt.blockAnnoyancesEnabled'], true);
  assert.equal(defaults['zt.blockSocialEnabled'], true);
  assert.equal(defaults['zt.themeMode'], 'system');
  assert.equal(defaults['zt.scriptletRuntimeEnabled'], true);
  assert.equal(defaults['zt.notificationsEnabled'], false);
  assert.equal(defaults['zt.debugDiagnosticsEnabled'], false);
  assert.equal(defaults['zt.compactPopupMode'], false);

  const normalized = api.normalizeSettings({
    'zt.blockAdsEnabled': false,
    'zt.blockTrackingEnabled': true,
    'zt.blockAnnoyancesEnabled': false,
    'zt.blockSocialEnabled': true,
    'zt.networkBlockingEnabled': false,
    'zt.scriptletRuntimeEnabled': false,
    'zt.themeMode': 'dark',
    'zt.notificationsEnabled': true,
    'zt.debugDiagnosticsEnabled': true,
    'zt.compactPopupMode': true,
  });

  assert.equal(normalized['zt.blockAdsEnabled'], false);
  assert.equal(normalized['zt.blockTrackingEnabled'], true);
  assert.equal(normalized['zt.blockAnnoyancesEnabled'], false);
  assert.equal(normalized['zt.blockSocialEnabled'], true);
  assert.equal(normalized['zt.networkBlockingEnabled'], false);
  assert.equal(normalized['zt.scriptletRuntimeEnabled'], false);
  assert.equal(normalized['zt.themeMode'], 'dark');
  assert.equal(normalized['zt.notificationsEnabled'], true);
  assert.equal(normalized['zt.debugDiagnosticsEnabled'], true);
  assert.equal(normalized['zt.compactPopupMode'], true);
  assert.equal(normalized['zt.enabled'], true);

  const normalizedInvalid = api.normalizeSettings({
    'zt.themeMode': 'neon',
    'zt.notificationsEnabled': 'yes',
    'zt.debugDiagnosticsEnabled': 'yes',
    'zt.compactPopupMode': 1,
  });
  assert.equal(normalizedInvalid['zt.themeMode'], 'system');
  assert.equal(normalizedInvalid['zt.notificationsEnabled'], false);
  assert.equal(normalizedInvalid['zt.debugDiagnosticsEnabled'], false);
  assert.equal(normalizedInvalid['zt.compactPopupMode'], false);
}

async function run() {
  await runBackgroundRulesetScenarios();
  await runSettingsNormalizationChecks();
  console.log('block-list controls regression checks passed');
}

export default run();
