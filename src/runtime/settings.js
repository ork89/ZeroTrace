(() => {
  const THEME_MODE_VALUES = new Set(['system', 'light', 'dark']);
  const DEFAULT_SETTINGS = Object.freeze({
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
  });

  const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
  const storageApi = (() => {
    try {
      return chrome.storage || null;
    } catch {
      return null;
    }
  })();

  function normalizeThemeMode(value) {
    return typeof value === 'string' && THEME_MODE_VALUES.has(value) ? value : DEFAULT_SETTINGS['zt.themeMode'];
  }

  function resolveEffectiveTheme(themeMode) {
    const normalizedThemeMode = normalizeThemeMode(themeMode);
    if (normalizedThemeMode !== 'system') {
      return normalizedThemeMode;
    }

    let prefersDark = false;
    try {
      prefersDark = Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
    } catch {
      prefersDark = false;
    }

    return prefersDark ? 'dark' : 'light';
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

    return new Promise((resolve, reject) => {
      storageApi.local.set(normalizeSettings(nextSettings), () => {
        if (globalThis.chrome?.runtime?.lastError) {
          reject(new Error(globalThis.chrome.runtime.lastError.message));
          return;
        }

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
    normalizeThemeMode,
    resetSettings,
    resolveEffectiveTheme,
    saveSettings,
  };
})();
