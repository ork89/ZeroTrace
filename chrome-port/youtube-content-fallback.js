(() => {
  if (!/(^|\.)youtube\.com$/i.test(location.hostname)) {
    return;
  }

  const AD_RENDERER_SELECTOR = [
    'ytd-display-ad-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer',
    'ytd-compact-promoted-video-renderer',
    'ytd-video-masthead-ad-v3-renderer',
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-statement-banner-renderer',
    'ytd-companion-slot-renderer',
    'ytd-action-companion-ad-renderer',
    '.ytp-ad-overlay-container',
    '.ytp-ad-image-overlay',
    'a[href*="googleadservices.com"]',
    'a[href*="doubleclick.net"]',
    'a[href*="googlesyndication.com"]'
  ].join(', ');

  function removeAdNodes() {
    const nodes = document.querySelectorAll(AD_RENDERER_SELECTOR);
    for (const node of nodes) {
      node.remove();
    }
  }

  function skipPlayerAds() {
    const player = document.querySelector('.html5-video-player');
    const adShowing = Boolean(player && player.classList.contains('ad-showing'));

    if (adShowing) {
      const video = document.querySelector('video');
      if (video && Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.max(video.duration - 0.05, 0);
      }
    }

    const skipButton = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if (skipButton) {
      skipButton.click();
    }

    const closeButton = document.querySelector('.ytp-ad-overlay-close-button');
    if (closeButton) {
      closeButton.click();
    }
  }

  function tick() {
    try {
      removeAdNodes();
      skipPlayerAds();
    } catch {
      // Ignore transient DOM update issues.
    }
  }

  tick();

  // Keep high-frequency polling only while an in-player ad is active.
  let adPollInterval = null;

  function isAdShowing() {
    const player = document.querySelector('.html5-video-player');
    return Boolean(player && player.classList.contains('ad-showing'));
  }

  function ensureAdPollState() {
    if (isAdShowing()) {
      if (!adPollInterval) {
        adPollInterval = setInterval(skipPlayerAds, 250);
      }
      return;
    }

    if (adPollInterval) {
      clearInterval(adPollInterval);
      adPollInterval = null;
    }
  }

  let rafPending = false;
  const scheduleTick = () => {
    if (rafPending) {
      return;
    }

    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      tick();
      ensureAdPollState();
    });
  };

  const observer = new MutationObserver(scheduleTick);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
})();
