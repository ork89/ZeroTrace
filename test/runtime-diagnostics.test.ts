import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

type RuntimeMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;

type TabsOnUpdatedListener = (tabId: number, info: { status?: string }, tab: { url?: string }) => void;

function createBackgroundChromeMock() {
  let onMessageListener: RuntimeMessageListener | null = null;
  let onUpdatedListener: TabsOnUpdatedListener | null = null;

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
      executeScript: (_payload: unknown, cb: () => void) => cb(),
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
        get: (_keys: unknown, cb: (result: Record<string, unknown>) => void) =>
          cb({
            'zt.enabled': true,
            'zt.networkBlockingEnabled': true,
            'zt.cosmeticFilteringEnabled': true,
            'zt.scriptletRuntimeEnabled': true,
          }),
        set: (_values: unknown, cb: () => void) => cb(),
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
    getOnMessageListener: () => onMessageListener,
    getOnUpdatedListener: () => onUpdatedListener,
  };
}

async function loadBackground() {
  const backgroundPath = path.resolve('./src/runtime/background.js');
  const code = fs.readFileSync(backgroundPath, 'utf8');
  const { chrome, getOnMessageListener, getOnUpdatedListener } = createBackgroundChromeMock();

  const fetchAsset = async (url: string) => {
    const marker = 'chrome-extension://unit/';
    const relativePath = url.startsWith(marker) ? url.slice(marker.length) : url;
    if (relativePath === 'cosmetic-rules.json') {
      return {
        ok: true,
        json: async () => ({
          scriptlets: {
            globalScriptlets: [
              { name: 'adsLoaded', args: [], invocation: '+js(adsLoaded)' },
              { name: 'unknown-scriptlet', args: [], invocation: '+js(unknown-scriptlet)' },
            ],
            domainToChunk: {},
          },
          exceptions: {
            scriptlets: {
              globalScriptlets: [],
              domainToChunk: {},
            },
          },
        }),
      };
    }

    if (relativePath === 'network-unsupported-summary.json') {
      return {
        ok: true,
        json: async () => ({
          generatedAt: '2026-01-01T00:00:00.000Z',
          hasUnsupportedEntries: true,
          summary: {
            rules: { 'unsupported-pattern': 3 },
            modifiers: { 'unsupported-modifier': 2 },
          },
        }),
      };
    }

    return { ok: false, json: async () => ({}) };
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
    onUpdated,
    onMessage,
  };
}

async function sendMessage(listener: RuntimeMessageListener, message: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(response);
    };

    const maybeAsync = listener(message, sender, finish);
    if (maybeAsync !== true && !settled) {
      setImmediate(() => finish(null));
    }
  });
}

async function run() {
  const { onUpdated, onMessage } = await loadBackground();

  onUpdated(21, { status: 'loading' }, { url: 'https://example.com/article' });
  await new Promise((resolve) => setImmediate(resolve));

  await sendMessage(
    onMessage,
    {
      type: 'zerotrace-cosmetic-applied',
      count: 6,
      selectorAppliedCount: 5,
      selectorFailedCount: 1,
    },
    { tab: { id: 21, url: 'https://example.com/article' } },
  );

  await sendMessage(
    onMessage,
    { type: 'zt-pause-host', host: 'example.com', url: 'https://example.com/article' },
    { tab: { id: 21, url: 'https://example.com/article' } },
  );
  await sendMessage(
    onMessage,
    { type: 'zt-resume-host', host: 'example.com', url: 'https://example.com/article' },
    { tab: { id: 21, url: 'https://example.com/article' } },
  );

  const response = (await sendMessage(onMessage, { type: 'zt-get-runtime-diagnostics' }, { tab: { id: 21 } })) as {
    ok?: boolean;
    diagnostics?: {
      selector: { applySuccesses: number; applyFailures: number };
      scriptlet: { runs: number; failures: number; ignored: number };
      hostBypassTransitions: Record<string, number>;
      networkUnsupportedSummary: { available: boolean };
    };
  };

  assert.equal(response?.ok, true);
  assert.equal(response?.diagnostics?.selector.applySuccesses, 5);
  assert.equal(response?.diagnostics?.selector.applyFailures, 1);
  assert.equal(response?.diagnostics?.scriptlet.runs, 1);
  assert.equal(response?.diagnostics?.scriptlet.failures, 0);
  assert.equal(response?.diagnostics?.scriptlet.ignored, 1);
  assert.equal(response?.diagnostics?.hostBypassTransitions['normal->paused'], 1);
  assert.equal(response?.diagnostics?.hostBypassTransitions['paused->normal'], 1);
  assert.equal(response?.diagnostics?.networkUnsupportedSummary.available, true);

  console.log('runtime diagnostics regression checks passed');
}

export default run();
