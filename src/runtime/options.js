const STATUS_TIMEOUT_MS = 1800;
const settingsApi = globalThis.ZeroTraceSettings;

const form = document.getElementById('settings-form');
const status = document.getElementById('status');
const resetBtn = document.getElementById('reset-btn');
const settingsShell = document.getElementById('settings-shell');
const enabledInput = document.getElementById('zt-enabled');
const networkInput = document.getElementById('zt-network');
const adsListInput = document.getElementById('zt-list-ads');
const trackingListInput = document.getElementById('zt-list-trackers');
const annoyancesListInput = document.getElementById('zt-list-annoyances');
const socialListInput = document.getElementById('zt-list-social');
const cosmeticInput = document.getElementById('zt-cosmetic');
const badgeInput = document.getElementById('zt-badge');
const themeModeInput = document.getElementById('zt-theme-mode');
const notificationsInput = document.getElementById('zt-notifications');
const debugDiagnosticsInput = document.getElementById('zt-debug-diagnostics');
const popupCompactInput = document.getElementById('zt-popup-compact');
const diagnosticsSnapshot = document.getElementById('zt-diagnostics-snapshot');
const refreshDiagnosticsButton = document.getElementById('zt-refresh-diagnostics');
const protectionMode = document.getElementById('zt-protection-mode');
const protectionNote = document.getElementById('zt-protection-note');
const chipEnabled = document.getElementById('chip-enabled');
const chipNetwork = document.getElementById('chip-network');
const chipCosmetic = document.getElementById('chip-cosmetic');
const chipBadge = document.getElementById('chip-badge');

let statusTimer = null;

function resolveEffectiveTheme(themeMode) {
  if (typeof settingsApi.resolveEffectiveTheme === 'function') {
    return settingsApi.resolveEffectiveTheme(themeMode);
  }

  if (themeMode === 'light' || themeMode === 'dark') {
    return themeMode;
  }

  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(settings) {
  const effectiveTheme = resolveEffectiveTheme(settings['zt.themeMode']);
  document.documentElement.dataset.ztTheme = effectiveTheme;
}

function readFormSettings() {
  return {
    'zt.enabled': enabledInput.checked,
    'zt.networkBlockingEnabled': networkInput.checked,
    'zt.blockAdsEnabled': adsListInput.checked,
    'zt.blockTrackingEnabled': trackingListInput.checked,
    'zt.blockAnnoyancesEnabled': annoyancesListInput.checked,
    'zt.blockSocialEnabled': socialListInput.checked,
    'zt.cosmeticFilteringEnabled': cosmeticInput.checked,
    'zt.badgeEnabled': badgeInput.checked,
    'zt.themeMode': themeModeInput.value,
    'zt.notificationsEnabled': notificationsInput.checked,
    'zt.debugDiagnosticsEnabled': debugDiagnosticsInput.checked,
    'zt.compactPopupMode': popupCompactInput.checked,
  };
}

function isAnyBlockListEnabled(settings) {
  return (
    settings['zt.blockAdsEnabled'] ||
    settings['zt.blockTrackingEnabled'] ||
    settings['zt.blockAnnoyancesEnabled'] ||
    settings['zt.blockSocialEnabled']
  );
}

function setChipState(element, state, value) {
  element.dataset.state = state;
  const valueNode = element.querySelector('.chip-value');

  if (valueNode) {
    valueNode.textContent = value;
  }
}

function renderSummary(settings) {
  const enabled = settings['zt.enabled'];
  const networkEnabled = enabled && settings['zt.networkBlockingEnabled'] && isAnyBlockListEnabled(settings);
  const cosmeticEnabled = enabled && settings['zt.cosmeticFilteringEnabled'];
  const badgeEnabled = enabled && settings['zt.badgeEnabled'];

  settingsShell.dataset.protection = enabled ? 'on' : 'off';
  protectionMode.textContent = enabled ? 'Protection active' : 'Protection paused';
  if (!enabled) {
    protectionNote.textContent = 'Master protection is off. Network, cosmetic, and badge controls are paused.';
  } else if (!settings['zt.networkBlockingEnabled']) {
    protectionNote.textContent = 'Network blocking is paused. Cosmetic filtering and badge updates can still run.';
  } else if (!isAnyBlockListEnabled(settings)) {
    protectionNote.textContent = 'Network blocking is on, but no block lists are selected yet.';
  } else {
    protectionNote.textContent = 'Core filtering is on for all sites.';
  }

  setChipState(chipEnabled, enabled ? 'on' : 'off', enabled ? 'On' : 'Off');
  setChipState(chipNetwork, networkEnabled ? 'on' : 'off', networkEnabled ? 'Active' : 'Off');
  setChipState(chipCosmetic, cosmeticEnabled ? 'on' : 'off', cosmeticEnabled ? 'Active' : 'Off');
  setChipState(chipBadge, badgeEnabled ? 'on' : 'off', badgeEnabled ? 'Visible' : 'Hidden');
}

function renderForm(settings) {
  enabledInput.checked = settings['zt.enabled'];
  networkInput.checked = settings['zt.networkBlockingEnabled'];
  adsListInput.checked = settings['zt.blockAdsEnabled'];
  trackingListInput.checked = settings['zt.blockTrackingEnabled'];
  annoyancesListInput.checked = settings['zt.blockAnnoyancesEnabled'];
  socialListInput.checked = settings['zt.blockSocialEnabled'];
  cosmeticInput.checked = settings['zt.cosmeticFilteringEnabled'];
  badgeInput.checked = settings['zt.badgeEnabled'];
  themeModeInput.value = settings['zt.themeMode'];
  notificationsInput.checked = settings['zt.notificationsEnabled'];
  debugDiagnosticsInput.checked = settings['zt.debugDiagnosticsEnabled'];
  popupCompactInput.checked = settings['zt.compactPopupMode'];

  const controlsDisabled = !settings['zt.enabled'];
  const listControlsDisabled = controlsDisabled || !settings['zt.networkBlockingEnabled'];
  networkInput.disabled = controlsDisabled;
  adsListInput.disabled = listControlsDisabled;
  trackingListInput.disabled = listControlsDisabled;
  annoyancesListInput.disabled = listControlsDisabled;
  socialListInput.disabled = listControlsDisabled;
  cosmeticInput.disabled = controlsDisabled;
  badgeInput.disabled = controlsDisabled;
  notificationsInput.disabled = controlsDisabled;
  debugDiagnosticsInput.disabled = controlsDisabled;
  popupCompactInput.disabled = controlsDisabled;
  applyTheme(settings);
  renderSummary(settings);
}

async function refreshRuntimeDiagnostics() {
  if (!diagnosticsSnapshot) {
    return;
  }

  diagnosticsSnapshot.textContent = 'Loading diagnostics...';
  const payload = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'zt-get-runtime-diagnostics' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }

        resolve(response || { ok: false, error: 'No diagnostics response.' });
      });
    } catch {
      resolve({ ok: false, error: 'Runtime diagnostics unavailable.' });
    }
  });

  diagnosticsSnapshot.textContent = JSON.stringify(payload, null, 2);
}

function setStatus(message) {
  status.textContent = message;

  if (statusTimer) {
    clearTimeout(statusTimer);
  }

  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, STATUS_TIMEOUT_MS);
}

async function handleSave(event) {
  event.preventDefault();

  const currentSettings = await settingsApi.getSettings();
  const nextSettings = settingsApi.normalizeSettings({
    ...currentSettings,
    ...readFormSettings(),
  });
  await settingsApi.saveSettings(nextSettings);
  renderForm(nextSettings);
  setStatus('Settings saved.');
}

async function handleReset() {
  await settingsApi.resetSettings();
  renderForm(settingsApi.DEFAULT_SETTINGS);
  setStatus('Defaults restored.');
}

async function init() {
  const settings = await settingsApi.getSettings();
  renderForm(settings);

  if (!settingsApi.hasStorageApi) {
    setStatus('Storage API unavailable in this context.');
  }

  form.addEventListener('submit', handleSave);
  resetBtn.addEventListener('click', handleReset);
  refreshDiagnosticsButton?.addEventListener('click', () => {
    refreshRuntimeDiagnostics().catch(() => {
      if (diagnosticsSnapshot) {
        diagnosticsSnapshot.textContent = JSON.stringify({ ok: false, error: 'Unable to refresh diagnostics.' }, null, 2);
      }
    });
  });
  for (const input of [
    enabledInput,
    networkInput,
    adsListInput,
    trackingListInput,
    annoyancesListInput,
    socialListInput,
    cosmeticInput,
    badgeInput,
    themeModeInput,
    notificationsInput,
    debugDiagnosticsInput,
    popupCompactInput,
  ]) {
    input.addEventListener('change', () => {
      const draft = settingsApi.normalizeSettings(readFormSettings());
      renderForm(draft);
    });
  }

  const systemThemeQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  if (systemThemeQuery) {
    const refreshSystemTheme = () => {
      const selectedThemeMode = typeof settingsApi.normalizeThemeMode === 'function'
        ? settingsApi.normalizeThemeMode(themeModeInput.value)
        : themeModeInput.value;

      if (selectedThemeMode === 'system') {
        applyTheme({ 'zt.themeMode': selectedThemeMode });
      }
    };

    if (typeof systemThemeQuery.addEventListener === 'function') {
      systemThemeQuery.addEventListener('change', refreshSystemTheme);
    } else if (typeof systemThemeQuery.addListener === 'function') {
      systemThemeQuery.addListener(refreshSystemTheme);
    }
  }

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      const relevantKeys = Object.keys(settingsApi.DEFAULT_SETTINGS);
      const hasRelevantChange = relevantKeys.some((key) => Object.prototype.hasOwnProperty.call(changes, key));
      if (!hasRelevantChange) {
        return;
      }

      settingsApi
        .getSettings()
        .then(renderForm)
        .catch(() => {
          // ignore storage refresh errors in the options surface
      });
    });
  }

  refreshRuntimeDiagnostics().catch(() => {
    if (diagnosticsSnapshot) {
      diagnosticsSnapshot.textContent = JSON.stringify({ ok: false, error: 'Unable to load diagnostics.' }, null, 2);
    }
  });
}

init();
