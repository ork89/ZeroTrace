(() => {
  const YT_HOST_RE = /(^|\.)youtube\.com$/i;
  const CLEANUP_INTERVAL_MS = 250;

  if (!YT_HOST_RE.test(location.hostname)) {
    return;
  }

  const SELECTORS = {
    adState: ['.ad-showing', '.ytp-ad-player-overlay', '.video-ads', '.ytp-ad-skip-button', '.ytp-skip-ad-button'],
    skipButtons: [
      '.ytp-ad-skip-button',
      '.ytp-skip-ad-button',
      'button.ytp-skip-ad-button',
      'button[aria-label*="Skip"]',
      'button[aria-label*="skip"]',
    ],
    overlays: ['.ytp-ad-overlay-container', '.ytp-ad-player-overlay', '.video-ads', '.ytp-ad-text-overlay'],
  };

  function getPlayerElement() {
    return document.getElementById('movie_player');
  }

  function isAdUiActive() {
    const player = getPlayerElement();
    if (player && player.classList.contains('ad-showing')) {
      return true;
    }

    return SELECTORS.adState.some((selector) => document.querySelector(selector));
  }

  function clickSkipButtons() {
    for (const selector of SELECTORS.skipButtons) {
      const buttons = document.querySelectorAll(selector);
      for (const button of buttons) {
        try {
          button.click();
        } catch {
          // ignore click failures
        }
      }
    }
  }

  function removeOverlays() {
    for (const selector of SELECTORS.overlays) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        try {
          element.remove();
        } catch {
          // ignore removal failures
        }
      }
    }
  }

  function cleanup() {
    if (!isAdUiActive()) {
      return;
    }

    clickSkipButtons();
    removeOverlays();
  }

  let cleanupIntervalId = null;

  function stopCleanupLoop() {
    if (cleanupIntervalId === null) {
      return;
    }

    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  function startCleanupLoop() {
    if (cleanupIntervalId !== null) {
      return;
    }

    cleanupIntervalId = setInterval(() => {
      if (!isAdUiActive()) {
        stopCleanupLoop();
        return;
      }

      cleanup();
    }, CLEANUP_INTERVAL_MS);
  }

  function syncCleanupLoop() {
    if (isAdUiActive()) {
      cleanup();
      startCleanupLoop();
      return;
    }

    stopCleanupLoop();
  }

  const playerObserver = new MutationObserver(() => {
    syncCleanupLoop();
  });

  const rootObserver = new MutationObserver(() => {
    const player = getPlayerElement();
    if (!player) {
      return;
    }

    playerObserver.observe(player, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });

    rootObserver.disconnect();
    syncCleanupLoop();
  });

  const initialPlayer = getPlayerElement();
  if (initialPlayer) {
    playerObserver.observe(initialPlayer, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
    syncCleanupLoop();
  } else {
    rootObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
})();
