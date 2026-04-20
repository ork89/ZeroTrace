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
const pauseHostBtn = document.getElementById('popup-pause-host');
const whitelistHostBtn = document.getElementById('popup-whitelist-host');
const popupSiteNote = document.getElementById('popup-site-note');

let statusTimer = null;
let siteActionBusy = false;
const siteControls = {
  url: null,
  host: null,
  unsupportedReason: 'Site controls unavailable for this tab.',
  hostState: null,
};

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

function normalizeHostFromUrl(url) {
  if (typeof url !== 'string' || !url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return null;
    }

    const normalized = parsed.hostname.trim().toLowerCase().replace(/\.+$/, '');
    return normalized || null;
  } catch {
    return null;
  }
}

function getUnsupportedReason(url) {
  if (typeof url !== 'string' || !url) {
    return 'Site controls unavailable for this tab.';
  }

  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return 'Site controls work only on http/https pages.';
    }

    if (!parsed.hostname) {
      return 'Site controls unavailable for this page.';
    }

    return '';
  } catch {
    return 'Site controls unavailable for this tab.';
  }
}

function queryActiveTab() {
  if (!chrome.tabs?.query) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(Array.isArray(tabs) ? tabs[0] || null : null);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response || null);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function renderSiteControls(settings) {
  if (!pauseHostBtn || !whitelistHostBtn || !popupSiteNote) {
    return;
  }

  const hostState = siteControls.hostState?.state || 'normal';
  const pauseActive = hostState === 'paused';
  const whitelistActive = hostState === 'whitelisted';

  pauseHostBtn.textContent = pauseActive ? 'Resume on this site' : 'Pause on this site';
  whitelistHostBtn.textContent = whitelistActive ? 'Enable on this site' : 'Disable on this site';
  pauseHostBtn.dataset.active = pauseActive ? 'true' : 'false';
  whitelistHostBtn.dataset.active = whitelistActive ? 'true' : 'false';

  const unsupported = Boolean(siteControls.unsupportedReason);
  const globalEnabled = Boolean(settings['zt.enabled']);
  const controlsDisabled = siteActionBusy || unsupported || !globalEnabled || !siteControls.host;
  pauseHostBtn.disabled = controlsDisabled;
  whitelistHostBtn.disabled = controlsDisabled;

  if (unsupported) {
    popupSiteNote.textContent = siteControls.unsupportedReason;
    return;
  }

  if (!globalEnabled) {
    popupSiteNote.textContent = 'Enable ZeroTrace to use site controls.';
    return;
  }

  if (pauseActive) {
    popupSiteNote.textContent = 'ZeroTrace is paused on this site.';
    return;
  }

  if (whitelistActive) {
    popupSiteNote.textContent = 'ZeroTrace is disabled on this site.';
    return;
  }

  popupSiteNote.textContent = 'Use these controls for the current tab only.';
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
  const currentSettings = await settingsApi.getSettings();
  const nextSettings = settingsApi.normalizeSettings({
    ...currentSettings,
    ...readSettingsFromForm(),
  });
  await settingsApi.saveSettings(nextSettings);
  render(nextSettings);
  await refreshSiteControls(nextSettings);
  setStatus('Saved');
}

async function refreshSiteControls(settings) {
  const activeTab = await queryActiveTab();
  const activeUrl = activeTab?.url || null;
  const hostname = normalizeHostFromUrl(activeUrl || '');

  siteControls.url = activeUrl;
  siteControls.host = hostname;
  siteControls.hostState = null;
  siteControls.unsupportedReason = chrome.tabs?.query ? getUnsupportedReason(activeUrl || '') : 'Tabs API unavailable.';

  popupHost.textContent = hostname ? `Current site: ${hostname}` : 'Current site: unsupported page';

  if (!siteControls.unsupportedReason && hostname) {
    try {
      const response = await sendRuntimeMessage({
        type: 'zt-get-host-state',
        host: hostname,
        url: activeUrl,
      });

      if (response?.ok) {
        siteControls.hostState = response;
      } else {
        siteControls.unsupportedReason = 'Unable to load site controls for this tab.';
      }
    } catch {
      siteControls.unsupportedReason = 'Unable to load site controls for this tab.';
    }
  }

  renderSiteControls(settings);
}

async function applySiteAction({ actionType, successMessage }) {
  if (!siteControls.host) {
    return;
  }

  const currentSettings = await settingsApi.getSettings();
  siteActionBusy = true;
  renderSiteControls(currentSettings);

  try {
    const response = await sendRuntimeMessage({
      type: actionType,
      host: siteControls.host,
      url: siteControls.url,
    });

    if (!response?.ok) {
      throw new Error('action-failed');
    }

    setStatus(successMessage(siteControls.host));
  } catch {
    setStatus('Site action failed');
  } finally {
    siteActionBusy = false;
    const nextSettings = await settingsApi.getSettings();
    await refreshSiteControls(nextSettings);
  }
}

async function init() {
  const settings = await settingsApi.getSettings();
  render(settings);
  await refreshSiteControls(settings);

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

  pauseHostBtn?.addEventListener('click', () => {
    const paused = siteControls.hostState?.state === 'paused';
    applySiteAction({
      actionType: paused ? 'zt-resume-host' : 'zt-pause-host',
      successMessage: (host) => (paused ? `Resumed on ${host}` : `Paused on ${host}`),
    }).catch(() => {
      setStatus('Site action failed');
    });
  });

  whitelistHostBtn?.addEventListener('click', () => {
    const whitelisted = siteControls.hostState?.state === 'whitelisted';
    applySiteAction({
      actionType: whitelisted ? 'zt-unwhitelist-host' : 'zt-whitelist-host',
      successMessage: (host) => (whitelisted ? `Enabled on ${host}` : `Disabled on ${host}`),
    }).catch(() => {
      setStatus('Site action failed');
    });
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
        .then((nextSettings) => {
          render(nextSettings);
          return refreshSiteControls(nextSettings);
        })
        .catch(() => {
          // ignore storage refresh errors in the popup surface
        });
    });
  }
}

init();
