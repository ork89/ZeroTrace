const STATUS_TIMEOUT_MS = 1800;
const settingsApi = globalThis.ZeroTraceSettings;

const form = document.getElementById('settings-form');
const status = document.getElementById('status');
const resetBtn = document.getElementById('reset-btn');
const settingsShell = document.getElementById('settings-shell');
const enabledInput = document.getElementById('zt-enabled');
const networkInput = document.getElementById('zt-network');
const cosmeticInput = document.getElementById('zt-cosmetic');
const badgeInput = document.getElementById('zt-badge');
const protectionMode = document.getElementById('zt-protection-mode');
const protectionNote = document.getElementById('zt-protection-note');
const chipEnabled = document.getElementById('chip-enabled');
const chipNetwork = document.getElementById('chip-network');
const chipCosmetic = document.getElementById('chip-cosmetic');
const chipBadge = document.getElementById('chip-badge');

let statusTimer = null;

function readFormSettings() {
  return {
    'zt.enabled': enabledInput.checked,
    'zt.networkBlockingEnabled': networkInput.checked,
    'zt.cosmeticFilteringEnabled': cosmeticInput.checked,
    'zt.badgeEnabled': badgeInput.checked,
  };
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
  const networkEnabled = enabled && settings['zt.networkBlockingEnabled'];
  const cosmeticEnabled = enabled && settings['zt.cosmeticFilteringEnabled'];
  const badgeEnabled = enabled && settings['zt.badgeEnabled'];

  settingsShell.dataset.protection = enabled ? 'on' : 'off';
  protectionMode.textContent = enabled ? 'Protection active' : 'Protection paused';
  protectionNote.textContent = enabled
    ? 'Core filtering is on for all sites.'
    : 'Master protection is off. Network, cosmetic, and badge controls are paused.';

  setChipState(chipEnabled, enabled ? 'on' : 'off', enabled ? 'On' : 'Off');
  setChipState(chipNetwork, networkEnabled ? 'on' : 'off', networkEnabled ? 'Active' : 'Off');
  setChipState(chipCosmetic, cosmeticEnabled ? 'on' : 'off', cosmeticEnabled ? 'Active' : 'Off');
  setChipState(chipBadge, badgeEnabled ? 'on' : 'off', badgeEnabled ? 'Visible' : 'Hidden');
}

function renderForm(settings) {
  enabledInput.checked = settings['zt.enabled'];
  networkInput.checked = settings['zt.networkBlockingEnabled'];
  cosmeticInput.checked = settings['zt.cosmeticFilteringEnabled'];
  badgeInput.checked = settings['zt.badgeEnabled'];

  const controlsDisabled = !settings['zt.enabled'];
  networkInput.disabled = controlsDisabled;
  cosmeticInput.disabled = controlsDisabled;
  badgeInput.disabled = controlsDisabled;
  renderSummary(settings);
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

  const nextSettings = settingsApi.normalizeSettings(readFormSettings());
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
  enabledInput.addEventListener('change', () => {
    const draft = settingsApi.normalizeSettings(readFormSettings());
    renderForm(draft);
  });

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
}

init();
