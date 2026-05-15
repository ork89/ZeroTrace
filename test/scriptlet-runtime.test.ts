import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { writeCosmeticRules } from '../src/build/writeCosmeticRules';
import { parseCosmeticFilterLine } from '../src/parser/cosmetic';
import { CosmeticFilterEntry } from '../src/types/cosmetic';

type SettingsShape = {
  'zt.enabled'?: boolean;
  'zt.networkBlockingEnabled'?: boolean;
  'zt.blockAdsEnabled'?: boolean;
  'zt.blockTrackingEnabled'?: boolean;
  'zt.blockAnnoyancesEnabled'?: boolean;
  'zt.blockSocialEnabled'?: boolean;
  'zt.cosmeticFilteringEnabled'?: boolean;
  'zt.scriptletRuntimeEnabled'?: boolean;
  'zt.badgeEnabled'?: boolean;
  'zt.notificationsEnabled'?: boolean;
  'zt.compactPopupMode'?: boolean;
  'zt.themeMode'?: 'system' | 'light' | 'dark';
};

type RuntimeMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;

type TabsOnUpdatedListener = (tabId: number, info: { status?: string }, tab: { url?: string }) => void;

function createBackgroundChromeMock(storedSettings: SettingsShape) {
  let onMessageListener: RuntimeMessageListener | null = null;
  let onUpdatedListener: TabsOnUpdatedListener | null = null;
  const executeScriptCalls: Array<Record<string, unknown>> = [];
  let localState = { ...storedSettings };

  const chrome: Record<string, unknown> = {
    runtime: {
      lastError: null,
      getManifest: () => ({
        declarative_net_request: {
          rule_resources: [{ id: 'ads_1', enabled: true }],
        },
      }),
      getURL: (relativePath: string) => `chrome-extension://unit/${relativePath}`,
      onMessage: {
        addListener: (callback: RuntimeMessageListener) => {
          onMessageListener = callback;
        },
      },
    },
    declarativeNetRequest: {
      updateEnabledRulesets: (_payload: unknown, cb: () => void) => cb(),
      getSessionRules: (cb: (rules: unknown[]) => void) => cb([]),
      updateSessionRules: (_payload: unknown, cb: () => void) => cb(),
    },
    tabs: {
      query: (_query: unknown, cb: (tabs: unknown[]) => void) => cb([]),
      sendMessage: () => {
        // no-op in tests
      },
      onUpdated: {
        addListener: (callback: TabsOnUpdatedListener) => {
          onUpdatedListener = callback;
        },
      },
      onRemoved: {
        addListener: () => {
          // no-op in tests
        },
      },
    },
    scripting: {
      executeScript: (payload: Record<string, unknown>, cb: () => void) => {
        executeScriptCalls.push(payload);
        cb();
      },
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      setTitle: () => {},
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
        get: (_keys: unknown, cb: (result: SettingsShape) => void) => cb({ ...localState }),
        set: (values: SettingsShape, cb: () => void) => {
          localState = { ...localState, ...values };
          cb();
        },
      },
      session: {
        get: (_keys: unknown, cb: (result: Record<string, unknown>) => void) => cb({}),
        set: (_values: unknown, cb: () => void) => cb(),
      },
      onChanged: {
        addListener: () => {
          // no-op in tests
        },
      },
    },
  };

  return {
    chrome,
    executeScriptCalls,
    getOnMessageListener: () => onMessageListener,
    getOnUpdatedListener: () => onUpdatedListener,
  };
}

async function loadBackground(storedSettings: SettingsShape) {
  const backgroundPath = path.resolve('./src/runtime/background.js');
  const code = fs.readFileSync(backgroundPath, 'utf8');
  const { chrome, executeScriptCalls, getOnMessageListener, getOnUpdatedListener } = createBackgroundChromeMock(storedSettings);

  const fetchAsset = async (url: string) => {
    const marker = 'chrome-extension://unit/';
    const relativePath = url.startsWith(marker) ? url.slice(marker.length) : url;
    const absolutePath = path.resolve('./dist', relativePath);
    if (!fs.existsSync(absolutePath)) {
      return { ok: false, json: async () => ({}) };
    }

    const json = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    return {
      ok: true,
      json: async () => json,
    };
  };

  const context = vm.createContext({
    chrome,
    fetch: fetchAsset,
    URL,
    Promise,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
  });

  vm.runInContext(code, context, { filename: 'background.js' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const onUpdated = getOnUpdatedListener();
  assert.ok(onUpdated, 'Expected tabs.onUpdated listener to be registered');

  const onMessage = getOnMessageListener();
  assert.ok(onMessage, 'Expected runtime.onMessage listener to be registered');

  return {
    executeScriptCalls,
    onUpdated,
    onMessage,
  };
}

async function sendMessage(listener: RuntimeMessageListener, message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(response);
    };

    const maybeAsync = listener(message, { tab: { url: 'https://example.com/' } }, finish);
    if (maybeAsync !== true && !settled) {
      setImmediate(() => finish(null));
    }
  });
}

function compileScriptletFixture(lines: string[]) {
  const entries = lines
    .map((line) => parseCosmeticFilterLine(line))
    .filter((entry): entry is CosmeticFilterEntry => Boolean(entry));
  writeCosmeticRules(entries);
}

async function run() {
  compileScriptletFixture([
    '##+js(adsLoaded)',
    '##+js(unknown-scriptlet)',
    '##+js(adsLoaded, invalid)',
    'example.com##+js(canRunAds)',
    'example.com#@#+js(canRunAds)',
  ]);

  {
    const { executeScriptCalls, onUpdated } = await loadBackground({
      'zt.enabled': true,
      'zt.networkBlockingEnabled': true,
      'zt.scriptletRuntimeEnabled': true,
    });

    onUpdated(3, { status: 'loading' }, { url: 'https://example.com/article' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(executeScriptCalls.length, 1, 'Expected one scriptlet execution batch');
    const payloadEntries = (executeScriptCalls[0].args as unknown[])[0] as Array<{ name: string; args: string[] }>;
    const normalizedPayload = JSON.parse(JSON.stringify(payloadEntries));
    assert.deepEqual(normalizedPayload, [{ name: 'adsLoaded', args: [], invocation: '+js(adsLoaded)' }]);
  }

  {
    const { executeScriptCalls, onUpdated } = await loadBackground({
      'zt.enabled': true,
      'zt.networkBlockingEnabled': true,
      'zt.scriptletRuntimeEnabled': false,
    });

    onUpdated(4, { status: 'loading' }, { url: 'https://example.com/article' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executeScriptCalls.length, 0, 'Kill-switch should disable scriptlet execution');
  }

  {
    const { executeScriptCalls, onUpdated, onMessage } = await loadBackground({
      'zt.enabled': true,
      'zt.networkBlockingEnabled': true,
      'zt.scriptletRuntimeEnabled': true,
    });

    const pauseResponse = (await sendMessage(onMessage, {
      type: 'zt-pause-host',
      host: 'example.com',
      url: 'https://example.com/',
    })) as { ok?: boolean };
    assert.equal(pauseResponse?.ok, true);

    onUpdated(5, { status: 'loading' }, { url: 'https://example.com/article' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executeScriptCalls.length, 0, 'Bypassed host should not execute scriptlets');
  }

  console.log('scriptlet runtime regression checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
