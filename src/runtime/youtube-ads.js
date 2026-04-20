/**
 * ZeroTrace – YouTube Ad Blocker
 *
 * This script runs in the ISOLATED world as a content script on youtube.com.
 * It uses DOM observation to detect and skip/fast-forward video ads,
 * hides ad overlays, and clicks skip buttons automatically.
 */
(() => {
  if (window.__ztYouTubeAdBlocker) return;
  window.__ztYouTubeAdBlocker = true;

  const DEFAULT_SETTINGS = {
    'zt.enabled': true,
    'zt.networkBlockingEnabled': true,
    'zt.blockAdsEnabled': true,
    'zt.blockTrackingEnabled': true,
    'zt.cosmeticFilteringEnabled': true,
    'zt.badgeEnabled': true,
  };
  const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
  const storageApi = (() => {
    try {
      return chrome.storage || null;
    } catch {
      return null;
    }
  })();

  let youtubeEnabled = false;
  let currentSettings = { ...DEFAULT_SETTINGS };
  let initialized = false;
  let globalObserver = null;

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

  function shouldEnableYouTubeBlocking(settings) {
    // DOM-level YouTube ad blocking (skip-button clicks, overlay removal) is
    // driven by the cosmetic/network master toggles, not the Ads list toggle.
    // The Ads list only controls the DNR rulesets for ads_* and youtube_ads_*.
    return settings['zt.enabled'] && (settings['zt.networkBlockingEnabled'] || settings['zt.cosmeticFilteringEnabled']);
  }

  function notifyMainWorld(enabled) {
    window.dispatchEvent(
      new CustomEvent('zt-youtube-settings', {
        detail: { enabled },
      }),
    );
  }

  // ─── Cosmetic: inject aggressive CSS to hide ad UI ───────────────────
  const AD_CSS = `
    /* Hide ad video frames so the user never sees even a flash */
    #movie_player.ad-showing .html5-main-video,
    #movie_player.ad-interrupting .html5-main-video,
    .html5-video-player.ad-showing .html5-main-video,
    .html5-video-player.ad-interrupting .html5-main-video {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    /* Hide the player chrome (progress bar, yellow scrubber, controls) during
       ads so neither the yellow seek bar nor the ad timer are ever visible */
    #movie_player.ad-showing .ytp-chrome-bottom,
    #movie_player.ad-interrupting .ytp-chrome-bottom,
    .html5-video-player.ad-showing .ytp-chrome-bottom,
    .html5-video-player.ad-interrupting .ytp-chrome-bottom,
    #movie_player.ad-showing .ytp-gradient-bottom,
    #movie_player.ad-interrupting .ytp-gradient-bottom {
      display: none !important;
    }

    /* Video ad overlays */
    .video-ads,
    .ytp-ad-module,
    .ytp-ad-overlay-container,
    .ytp-ad-overlay-slot,
    .ytp-ad-image-overlay,
    .ytp-ad-text-overlay,
    .ytp-ad-message-container,
    .ytp-ad-player-overlay-layout,
    .ytp-ad-action-interstitial,
    .ytp-ad-action-interstitial-background-container,
    .ytp-ad-action-interstitial-slot,
    .ytp-ad-visited,
    .ytp-ad-progress-list,
    .ytp-ad-survey,
    .ytp-ad-persistent-progress-bar-container,
    #player-ads,
    #panels.ytd-watch-flexy > ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
    /* Sidebar / feed ads */
    ytd-compact-promoted-item-renderer,
    ytd-compact-promoted-video-renderer,
    ytd-promoted-sparkles-web-renderer,
    ytd-promoted-sparkles-text-search-renderer,
    ytd-display-ad-renderer,
    ytd-banner-promo-renderer,
    ytd-statement-banner-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-ad-slot-renderer,
    ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer),
    ytd-rich-section-renderer:has(> #content > ytd-ad-slot-renderer),
    ytd-search-pyv-renderer,
    /* Masthead ad */
    #masthead-ad,
    /* Merch shelf */
    ytd-merch-shelf-renderer,
    /* Movie offers */
    ytd-movie-offer-module-renderer,
    /* Engagement panel ads */
    tp-yt-paper-dialog:has(> ytd-mealbar-promo-renderer) {
      display: none !important;
    }
  `;

  function injectAdCSS() {
    const id = 'zt-yt-ad-css';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = AD_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeAdCSS() {
    const style = document.getElementById('zt-yt-ad-css');
    if (style) {
      style.remove();
    }
  }

  // ─── Continuous promoted/companion node removal ───────────────────
  const AD_ELEMENT_SELECTORS = [
    'ytd-compact-promoted-item-renderer',
    'ytd-compact-promoted-video-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-sparkles-text-search-renderer',
    'ytd-display-ad-renderer',
    'ytd-banner-promo-renderer',
    'ytd-statement-banner-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-ad-slot-renderer',
    'ytd-search-pyv-renderer',
    'ytd-movie-offer-module-renderer',
    'ytd-merch-shelf-renderer',
    'ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)',
    '#player-ads',
    '#masthead-ad',
    '.ytp-ad-overlay-container',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    'tp-yt-paper-dialog:has(> ytd-mealbar-promo-renderer)',
    // Companion ad slots (right side of video)
    'ytd-companion-slot-renderer',
    '#companion',
    '.ytd-watch-flexy > ytd-ad-slot-renderer',
  ];

  function removeAdElements() {
    if (!youtubeEnabled) {
      return;
    }

    for (const sel of AD_ELEMENT_SELECTORS) {
      try {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          el.remove();
        }
      } catch {
        // invalid selector in this browser, skip
      }
    }
  }

  let adCleanupInterval = null;

  function startAdCleanupLoop() {
    if (adCleanupInterval) {
      return;
    }

    adCleanupInterval = setInterval(() => {
      removeAdElements();
      tryClickSkip();
    }, 250);
  }

  function stopAdCleanupLoop() {
    if (!adCleanupInterval) {
      return;
    }

    clearInterval(adCleanupInterval);
    adCleanupInterval = null;
  }

  // ─── DOM-based ad detection and skipping ─────────────────────────────
  const SKIP_SELECTORS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    'button.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-overlay-close-button',
    '[id^="skip-button"]',
    '[id^="ad-text:skip"]',
  ];

  function tryClickSkip() {
    if (!youtubeEnabled) {
      return false;
    }

    for (const sel of SKIP_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function getPlayer() {
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }

  function getVideo() {
    const player = getPlayer();
    return player ? player.querySelector('video') : document.querySelector('video');
  }

  function isAdPlaying() {
    const player = getPlayer();
    if (!player) return false;
    return player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  }

  function bypassAdFrame() {
    if (!youtubeEnabled) {
      return;
    }

    const video = getVideo();
    if (!video) return;

    // Save original state only once, before the first bypass.
    if (!video.__ztBypassing) {
      video.__ztBypassing = true;
      video.__ztPrevMuted = video.muted;
      video.__ztPrevRate = video.playbackRate;
    }

    // Enforce mute + 16x on EVERY tick. YouTube's player resets these
    // on ad segment boundaries, baked-in cue points, and VAST events.
    video.muted = true;
    video.playbackRate = 16;
    if (video.paused) video.play().catch(() => {});
  }

  function restoreVideoState() {
    const video = getVideo();
    if (video && video.__ztBypassing) {
      video.muted = video.__ztPrevMuted || false;
      video.playbackRate = video.__ztPrevRate || 1;
      delete video.__ztBypassing;
      delete video.__ztPrevMuted;
      delete video.__ztPrevRate;
    }
  }

  let adCheckInterval = null;

  function handleAdState() {
    if (!youtubeEnabled) {
      restoreVideoState();
      stopAdCleanupLoop();
      if (adCheckInterval) {
        clearInterval(adCheckInterval);
        adCheckInterval = null;
      }
      return;
    }

    if (!isAdPlaying()) {
      restoreVideoState();
      stopAdCleanupLoop();
      if (adCheckInterval) {
        clearInterval(adCheckInterval);
        adCheckInterval = null;
      }
      return;
    }

    // Try to skip first
    if (tryClickSkip()) return;

    // Force ad completion.
    bypassAdFrame();
  }

  function onAdDetected() {
    if (!youtubeEnabled) {
      return;
    }

    handleAdState();
    startAdCleanupLoop();
    // Keep checking rapidly until ad is gone
    if (!adCheckInterval) {
      adCheckInterval = setInterval(handleAdState, 50);
    }
  }

  // ─── MutationObserver on the player element ──────────────────────────
  let playerObserver = null;

  function observePlayer() {
    if (!youtubeEnabled) {
      return;
    }

    const player = getPlayer();
    if (!player || playerObserver) return;

    // Check initial state
    if (isAdPlaying()) onAdDetected();

    playerObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          if (isAdPlaying()) {
            onAdDetected();
          } else {
            restoreVideoState();
            stopAdCleanupLoop();
            if (adCheckInterval) {
              clearInterval(adCheckInterval);
              adCheckInterval = null;
            }
          }
        }
      }
    });

    playerObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  // ─── Global observer to catch player creation and ad elements ────────
  function setupGlobalObserver() {
    if (globalObserver) {
      return;
    }

    let observerRafPending = false;

    globalObserver = new MutationObserver((mutations) => {
      if (!youtubeEnabled) {
        return;
      }

      let shouldProcess = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList' || (mutation.type === 'attributes' && mutation.attributeName === 'class')) {
          shouldProcess = true;
          break;
        }
      }

      if (!shouldProcess || observerRafPending) {
        return;
      }

      observerRafPending = true;
      requestAnimationFrame(() => {
        observerRafPending = false;
        injectAdCSS();

        if (!playerObserver || !getPlayer()) {
          if (playerObserver) {
            playerObserver.disconnect();
            playerObserver = null;
          }
          observePlayer();
        }

        if (isAdPlaying()) {
          onAdDetected();
        }
      });
    });

    globalObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  function applyEnableState(enabled) {
    youtubeEnabled = enabled;

    try {
      window.localStorage.setItem('__ztYouTubeEnabled', enabled ? '1' : '0');
    } catch {
      // localStorage access is best-effort.
    }

    notifyMainWorld(enabled);

    if (enabled) {
      injectAdCSS();
      removeAdElements();
      observePlayer();
      if (!globalObserver) {
        setupGlobalObserver();
      }
      return;
    }

    removeAdCSS();
    restoreVideoState();
    stopAdCleanupLoop();
    if (adCheckInterval) {
      clearInterval(adCheckInterval);
      adCheckInterval = null;
    }
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }
    if (globalObserver) {
      globalObserver.disconnect();
      globalObserver = null;
    }
  }

  async function loadAndApplySettings() {
    if (!storageApi?.local) {
      currentSettings = { ...DEFAULT_SETTINGS };
      applyEnableState(shouldEnableYouTubeBlocking(currentSettings));
      return;
    }

    const settings = await new Promise((resolve) => {
      storageApi.local.get(SETTINGS_KEYS, (result) => {
        resolve(normalizeSettings(result));
      });
    });

    currentSettings = settings;
    applyEnableState(shouldEnableYouTubeBlocking(currentSettings));
  }

  // ─── SPA navigation handling ─────────────────────────────────────────
  // YouTube is a SPA, so we need to re-check on navigation
  let lastUrl = location.href;

  function onNavigate() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    stopAdCleanupLoop();
    restoreVideoState();
    if (adCheckInterval) {
      clearInterval(adCheckInterval);
      adCheckInterval = null;
    }

    // Re-attach player observer for new video
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }

    // Small delay for YouTube to render the new player
    setTimeout(observePlayer, 500);
    setTimeout(observePlayer, 1500);
  }

  // Use standard DOM events for SPA navigation detection.
  // Content scripts run in isolated world so history patching would not intercept
  // the page's main-world navigation calls and is therefore ineffective.
  window.addEventListener('popstate', () => setTimeout(onNavigate, 0));

  // Also listen for yt-navigate-finish (YouTube-specific event)
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(observePlayer, 300);
  });

  // ─── Bootstrap ───────────────────────────────────────────────────────
  function init() {
    if (initialized) {
      return;
    }

    initialized = true;

    if (!youtubeEnabled) {
      return;
    }

    injectAdCSS();
    removeAdElements();
    observePlayer();
    setupGlobalObserver();
  }

  if (storageApi?.onChanged) {
    storageApi.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      let hasRelevantChange = false;
      const nextValues = { ...currentSettings };

      for (const key of SETTINGS_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(changes, key)) {
          continue;
        }

        hasRelevantChange = true;
        const value = changes[key].newValue;
        nextValues[key] = typeof value === 'boolean' ? value : DEFAULT_SETTINGS[key];
      }

      if (!hasRelevantChange) {
        return;
      }

      currentSettings = normalizeSettings(nextValues);
      applyEnableState(shouldEnableYouTubeBlocking(currentSettings));
    });
  }

  loadAndApplySettings().catch(() => {
    applyEnableState(true);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
