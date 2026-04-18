(() => {
  if (window.__ztYtMainPatchApplied) {
    return;
  }
  window.__ztYtMainPatchApplied = true;
  let youtubeMainEnabled = (() => {
    try {
      const persisted = window.localStorage.getItem('__ztYouTubeEnabled');
      if (persisted === '0') {
        return false;
      }
      if (persisted === '1') {
        return true;
      }
    } catch {
      // localStorage access is best-effort.
    }

    return true;
  })();

  window.addEventListener('zt-youtube-settings', (event) => {
    const enabled = event?.detail?.enabled;
    if (typeof enabled === 'boolean') {
      youtubeMainEnabled = enabled;
    }
  });

  const AD_FIELDS = [
    'adPlacements',
    'playerAds',
    'adSlots',
    'adBreakHeartbeatParams',
    'adBreakParams',
    'adShortFormVideoAdsConfig',
  ];

  const PLAYER_ENDPOINT_HINTS = ['/youtubei/v1/player', '/youtubei/v1/next'];

  function stripAdFields(target) {
    if (!target || typeof target !== 'object') {
      return target;
    }

    for (const field of AD_FIELDS) {
      if (field.includes('.')) {
        const [root, child] = field.split('.');
        if (target[root] && typeof target[root] === 'object' && child in target[root]) {
          delete target[root][child];
        }
      } else if (field in target) {
        delete target[field];
      }
    }

    return target;
  }

  function deepStripPlayerPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    stripAdFields(payload);

    // Also nuke the ad config block that controls client-side ad injection
    if (payload.playerConfig && typeof payload.playerConfig === 'object') {
      delete payload.playerConfig.adConfig;
    }

    if (payload.playerResponse && typeof payload.playerResponse === 'object') {
      stripAdFields(payload.playerResponse);
      if (payload.playerResponse.playerConfig && typeof payload.playerResponse.playerConfig === 'object') {
        delete payload.playerResponse.playerConfig.adConfig;
      }
    }
    if (payload.response && typeof payload.response === 'object') {
      stripAdFields(payload.response);
      if (payload.response.playerResponse && typeof payload.response.playerResponse === 'object') {
        stripAdFields(payload.response.playerResponse);
        if (
          payload.response.playerResponse.playerConfig &&
          typeof payload.response.playerResponse.playerConfig === 'object'
        ) {
          delete payload.response.playerResponse.playerConfig.adConfig;
        }
      }
    }

    return payload;
  }

  function isPlayerEndpoint(url) {
    return typeof url === 'string' && PLAYER_ENDPOINT_HINTS.some((hint) => url.includes(hint));
  }

  function patchWindowProperty(name) {
    let currentValue = window[name];

    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get() {
        return currentValue;
      },
      set(value) {
        if (youtubeMainEnabled && value && typeof value === 'object') {
          deepStripPlayerPayload(value);
        }
        currentValue = value;
      },
    });

    if (youtubeMainEnabled && currentValue && typeof currentValue === 'object') {
      deepStripPlayerPayload(currentValue);
    }
  }

  try {
    patchWindowProperty('ytInitialPlayerResponse');
    patchWindowProperty('ytInitialData');
  } catch {
    // Property patching is best-effort.
  }

  try {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      if (!youtubeMainEnabled) {
        return response;
      }

      const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (!isPlayerEndpoint(reqUrl)) {
        return response;
      }

      try {
        const bodyText = await response.clone().text();
        const data = JSON.parse(bodyText);
        deepStripPlayerPayload(data);
        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        return response;
      }
    };
  } catch {
    // Fetch patching is best-effort.
  }

  try {
    // Replace the XHR constructor rather than patching the prototype.
    // This ensures our readystatechange listener is added before YouTube's own
    // listeners, so we can redefine responseText before they read it.
    const OriginalXHR = window.XMLHttpRequest;
    function PatchedXHR() {
      const xhr = new OriginalXHR();
      let requestUrl = '';

      const originalOpen = xhr.open;
      xhr.open = function (method, url, ...rest) {
        requestUrl = typeof url === 'string' ? url : '';
        return originalOpen.call(this, method, url, ...rest);
      };

      xhr.addEventListener('readystatechange', function () {
        if (!youtubeMainEnabled || this.readyState !== 4 || !isPlayerEndpoint(requestUrl)) {
          return;
        }
        try {
          const data = JSON.parse(this.responseText);
          deepStripPlayerPayload(data);
          const stripped = JSON.stringify(data);
          Object.defineProperty(this, 'responseText', {
            configurable: true,
            get: () => stripped,
          });
          Object.defineProperty(this, 'response', {
            configurable: true,
            get: () => (this.responseType === 'json' ? JSON.parse(stripped) : stripped),
          });
        } catch {
          // Ignore non-JSON or already-overridden payloads.
        }
      });

      return xhr;
    }

    // Forward static properties (e.g. DONE, LOADING) so instanceof/const checks work.
    Object.setPrototypeOf(PatchedXHR, OriginalXHR);
    PatchedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
  } catch {
    // XHR patching is best-effort.
  }
})();
