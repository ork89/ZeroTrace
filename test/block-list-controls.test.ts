import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

type SettingsShape = {
  'zt.enabled'?: boolean;
  'zt.networkBlockingEnabled'?: boolean;
  'zt.blockAdsEnabled'?: boolean;
  'zt.blockTrackingEnabled'?: boolean;
  'zt.cosmeticFilteringEnabled'?: boolean;
  'zt.badgeEnabled'?: boolean;
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
  });
  assert.deepEqual(adsOff.enableRulesetIds, ['tracking_1']);
  assert.deepEqual(adsOff.disableRulesetIds, ['ads_1', 'youtube_ads_1']);

  const trackingOff = await loadBackgroundAndGetLatestRulesetUpdate({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAdsEnabled': true,
    'zt.blockTrackingEnabled': false,
  });
  assert.deepEqual(trackingOff.enableRulesetIds, ['ads_1', 'youtube_ads_1']);
  assert.deepEqual(trackingOff.disableRulesetIds, ['tracking_1']);

  const networkOff = await loadBackgroundAndGetLatestRulesetUpdate({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': false,
    'zt.blockAdsEnabled': true,
    'zt.blockTrackingEnabled': true,
  });
  assert.deepEqual(networkOff.enableRulesetIds, []);
  assert.deepEqual(networkOff.disableRulesetIds, ['ads_1', 'tracking_1', 'youtube_ads_1']);

  const allOn = await loadBackgroundAndGetLatestRulesetUpdate({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAdsEnabled': true,
    'zt.blockTrackingEnabled': true,
  });
  assert.deepEqual(allOn.enableRulesetIds, ['ads_1', 'tracking_1', 'youtube_ads_1']);
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
        DEFAULT_SETTINGS: Record<string, boolean>;
        normalizeSettings: (raw: Record<string, unknown>) => Record<string, boolean>;
      };
    }
  ).ZeroTraceSettings;
  assert.ok(api, 'Expected ZeroTraceSettings API to be initialized');

  const defaults = api.DEFAULT_SETTINGS;
  assert.equal(defaults['zt.blockAdsEnabled'], true);
  assert.equal(defaults['zt.blockTrackingEnabled'], true);

  const normalized = api.normalizeSettings({
    'zt.blockAdsEnabled': false,
    'zt.blockTrackingEnabled': true,
    'zt.networkBlockingEnabled': false,
  });

  assert.equal(normalized['zt.blockAdsEnabled'], false);
  assert.equal(normalized['zt.blockTrackingEnabled'], true);
  assert.equal(normalized['zt.networkBlockingEnabled'], false);
  assert.equal(normalized['zt.enabled'], true);
}

async function run() {
  await runBackgroundRulesetScenarios();
  await runSettingsNormalizationChecks();
  console.log('block-list controls regression checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
