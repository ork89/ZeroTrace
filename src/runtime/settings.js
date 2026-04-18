(() => {
  const DEFAULT_SETTINGS = Object.freeze({
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.cosmeticFilteringEnabled': true,
    'zt.badgeEnabled': true,
  });

  const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
  const storageApi = (() => {
    try {
      return chrome.storage || null;
    } catch {
      return null;
    }
  })();

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

  async function getSettings() {
    if (!storageApi?.local) {
      return { ...DEFAULT_SETTINGS };
    }

    return new Promise((resolve) => {
      storageApi.local.get(SETTINGS_KEYS, (result) => {
        resolve(normalizeSettings(result));
      });
    });
  }

  async function saveSettings(nextSettings) {
    if (!storageApi?.local) {
      return;
    }

    return new Promise((resolve) => {
      storageApi.local.set(normalizeSettings(nextSettings), () => {
        resolve();
      });
    });
  }

  async function resetSettings() {
    return saveSettings(DEFAULT_SETTINGS);
  }

  globalThis.ZeroTraceSettings = {
    DEFAULT_SETTINGS,
    hasStorageApi: Boolean(storageApi?.local),
    getSettings,
    normalizeSettings,
    resetSettings,
    saveSettings,
  };
})();
