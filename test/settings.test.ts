import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

type ZeroTraceSettingsApi = {
  saveSettings: (nextSettings: Record<string, unknown>) => Promise<void>;
  getSettings: () => Promise<Record<string, unknown>>;
};

function loadSettingsApi(lastErrorMessage?: string) {
  const settingsPath = path.resolve('./src/runtime/settings.js');
  const code = fs.readFileSync(settingsPath, 'utf8');
  let stored: Record<string, unknown> = {};

  const chrome = {
    runtime: {
      lastError: null as { message: string } | null,
    },
    storage: {
      local: {
        get: (_keys: unknown, cb: (result: Record<string, unknown>) => void) => cb({ ...stored }),
        set: (values: Record<string, unknown>, cb: () => void) => {
          stored = { ...stored, ...values };
          if (lastErrorMessage) {
            chrome.runtime.lastError = { message: lastErrorMessage };
          }

          cb();
          chrome.runtime.lastError = null;
        },
      },
    },
  };

  const context = vm.createContext({
    chrome,
    matchMedia: () => ({ matches: false }),
  });

  vm.runInContext(code, context, { filename: 'settings.js' });

  const api = (context as { ZeroTraceSettings?: ZeroTraceSettingsApi }).ZeroTraceSettings;
  assert.ok(api, 'Expected ZeroTraceSettings API to be initialized');
  return api;
}

async function run() {
  {
    const api = loadSettingsApi();
    await api.saveSettings({
      'zt.enabled': false,
      'zt.themeMode': 'dark',
    });

    const next = await api.getSettings();
    assert.equal(next['zt.enabled'], false);
    assert.equal(next['zt.themeMode'], 'dark');
  }

  {
    const api = loadSettingsApi('Storage write denied.');
    await assert.rejects(
      api.saveSettings({
        'zt.enabled': false,
      }),
      /Storage write denied\./,
    );
  }

  console.log('settings API storage failure checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
