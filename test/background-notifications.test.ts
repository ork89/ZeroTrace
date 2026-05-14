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
  'zt.compactPopupMode'?: boolean;
  'zt.themeMode'?: 'system' | 'light' | 'dark';
};

type NotificationCall = {
  id: string;
  options: { title?: string; message?: string; type?: string; iconUrl?: string };
};

function createBackgroundChromeMock(storedSettings: SettingsShape, withNotifications = true) {
  const notificationCalls: NotificationCall[] = [];
  let onMessageListener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown) | null =
    null;
  let localState = { ...storedSettings };

  const chrome: Record<string, unknown> = {
    runtime: {
      lastError: null,
      getManifest: () => ({
        declarative_net_request: {
          rule_resources: [{ id: 'ads_1', enabled: true }],
        },
      }),
      onMessage: {
        addListener: (
          callback: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown,
        ) => {
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
      executeScript: (_payload: unknown, cb: () => void) => cb(),
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

  if (withNotifications) {
    chrome.notifications = {
      create: (
        id: string,
        options: { title?: string; message?: string; type?: string; iconUrl?: string },
        cb?: () => void,
      ) => {
        notificationCalls.push({ id, options });
        cb?.();
      },
    };
  }

  return {
    chrome,
    notificationCalls,
    getOnMessageListener: () => onMessageListener,
  };
}

async function loadBackground(storedSettings: SettingsShape, withNotifications = true) {
  const backgroundPath = path.resolve('./src/runtime/background.js');
  const code = fs.readFileSync(backgroundPath, 'utf8');
  const { chrome, notificationCalls, getOnMessageListener } = createBackgroundChromeMock(storedSettings, withNotifications);

  const context = vm.createContext({
    chrome,
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

  const listener = getOnMessageListener();
  assert.ok(listener, 'Expected runtime.onMessage listener to be registered');

  return {
    listener,
    notificationCalls,
  };
}

async function sendMessage(
  listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown,
  message: unknown,
  sender: unknown = { tab: { url: 'https://example.com/' } },
): Promise<unknown> {
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
  {
    const { listener, notificationCalls } = await loadBackground({
      'zt.notificationsEnabled': false,
      'zt.enabled': true,
      'zt.networkBlockingEnabled': true,
    });

    const response = (await sendMessage(listener, {
      type: 'zt-pause-host',
      host: 'example.com',
      url: 'https://example.com/',
    })) as { ok?: boolean };

    assert.equal(response?.ok, true);
    assert.equal(notificationCalls.length, 0);
  }

  {
    const { listener, notificationCalls } = await loadBackground({
      'zt.notificationsEnabled': true,
      'zt.enabled': true,
      'zt.networkBlockingEnabled': true,
    });

    const response = (await sendMessage(listener, {
      type: 'zt-pause-host',
      host: 'example.com',
      url: 'https://example.com/',
    })) as { ok?: boolean };

    assert.equal(response?.ok, true);
    assert.equal(notificationCalls.length, 1);
    assert.match(notificationCalls[0].options.title || '', /paused on example\.com/i);
  }

  {
    const { listener, notificationCalls } = await loadBackground({
      'zt.notificationsEnabled': true,
      'zt.enabled': true,
      'zt.networkBlockingEnabled': true,
    });

    const response = (await sendMessage(listener, {
      type: 'zt-settings-updated',
      settings: {
        'zt.enabled': false,
      },
    })) as { ok?: boolean };

    assert.equal(response?.ok, true);
    assert.equal(notificationCalls.length, 1);
    assert.match(notificationCalls[0].options.title || '', /protection paused/i);
  }

  {
    const { listener, notificationCalls } = await loadBackground({
      'zt.notificationsEnabled': true,
      'zt.enabled': true,
      'zt.networkBlockingEnabled': true,
    });

    const first = (await sendMessage(listener, {
      type: 'zt-pause-host',
      host: 'example.com',
      url: 'https://example.com/',
    })) as { ok?: boolean };
    const second = (await sendMessage(listener, {
      type: 'zt-pause-host',
      host: 'example.com',
      url: 'https://example.com/',
    })) as { ok?: boolean };

    assert.equal(first?.ok, true);
    assert.equal(second?.ok, true);
    assert.equal(notificationCalls.length, 1);
  }

  {
    const { listener, notificationCalls } = await loadBackground(
      {
        'zt.notificationsEnabled': true,
        'zt.enabled': true,
        'zt.networkBlockingEnabled': true,
      },
      false,
    );

    const response = (await sendMessage(listener, {
      type: 'zt-whitelist-host',
      host: 'example.com',
      url: 'https://example.com/',
    })) as { ok?: boolean };

    assert.equal(response?.ok, true);
    assert.equal(notificationCalls.length, 0);
  }

  console.log('background notifications regression checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
