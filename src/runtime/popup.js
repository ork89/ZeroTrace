const STATUS_TIMEOUT_MS = 1400;
const settingsApi = globalThis.ZeroTraceSettings;

const enabledInput = document.getElementById('popup-enabled');
const networkInput = document.getElementById('popup-network');
const cosmeticInput = document.getElementById('popup-cosmetic');
const badgeInput = document.getElementById('popup-badge');
const openOptionsBtn = document.getElementById('open-options-btn');
const popupSummary = document.getElementById('popup-summary');
const popupHost = document.getElementById('popup-host');
const popupMasterPill = document.getElementById('popup-master-pill');
const popupStatus = document.getElementById('popup-status');

let statusTimer = null;

function readSettingsFromForm() {
  return {
    'zt.enabled': enabledInput.checked,
    'zt.networkBlockingEnabled': networkInput.checked,
    'zt.cosmeticFilteringEnabled': cosmeticInput.checked,
    'zt.badgeEnabled': badgeInput.checked,
  };
}

function render(settings) {
  enabledInput.checked = settings['zt.enabled'];
  networkInput.checked = settings['zt.networkBlockingEnabled'];
  cosmeticInput.checked = settings['zt.cosmeticFilteringEnabled'];
  badgeInput.checked = settings['zt.badgeEnabled'];

  const controlsDisabled = !settings['zt.enabled'];
  networkInput.disabled = controlsDisabled;
  cosmeticInput.disabled = controlsDisabled;
  badgeInput.disabled = controlsDisabled;

  popupMasterPill.dataset.state = controlsDisabled ? 'off' : 'on';
  popupMasterPill.textContent = controlsDisabled ? 'Paused' : 'Live';
  popupSummary.textContent = controlsDisabled
    ? 'Protection is paused. Secondary controls are temporarily disabled.'
    : 'Protection is active across your browsing session.';
}

function setStatus(message) {
  popupStatus.textContent = message;

  if (statusTimer) {
    clearTimeout(statusTimer);
  }

  statusTimer = setTimeout(() => {
    popupStatus.textContent = '';
  }, STATUS_TIMEOUT_MS);
}

async function persistCurrentSettings() {
  const nextSettings = settingsApi.normalizeSettings(readSettingsFromForm());
  await settingsApi.saveSettings(nextSettings);
  render(nextSettings);
  setStatus('Saved');
}

async function renderActiveSite() {
  if (!chrome.tabs?.query) {
    return;
  }

  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const [activeTab] = tabs;

      try {
        const hostname = activeTab?.url ? new URL(activeTab.url).hostname : '';
        if (hostname) {
          popupHost.textContent = `Current site: ${hostname}`;
        }
      } catch {
        // ignore restricted or non-http tab URLs
      }

      resolve();
    });
  });
}

async function init() {
  const settings = await settingsApi.getSettings();
  render(settings);
  await renderActiveSite();

  if (!settingsApi.hasStorageApi) {
    setStatus('Storage unavailable');
  }

  for (const input of [enabledInput, networkInput, cosmeticInput, badgeInput]) {
    input.addEventListener('change', () => {
      persistCurrentSettings().catch(() => {
        setStatus('Save failed');
      });
    });
  }

  openOptionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
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
        .then(render)
        .catch(() => {
          // ignore storage refresh errors in the popup surface
        });
    });
  }
}

init();
