(() => {
  const isYouTube = /(^|\.)youtube\.com$/i.test(location.hostname);
  if (!isYouTube) {
    return;
  }

  const PRUNE_KEYS = new Set([
    'adPlacements',
    'playerAds',
    'adSlots',
    'adBreakHeartbeatParams'
  ]);

  function prunePlayerResponse(payload) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    for (const key of PRUNE_KEYS) {
      if (key in payload) {
        delete payload[key];
      }
    }

    if (payload.playerConfig && typeof payload.playerConfig === 'object') {
      delete payload.playerConfig.adConfig;
    }

    return payload;
  }

  function maybeProcessPlayerPayload(input) {
    if (!input || typeof input !== 'object') {
      return input;
    }

    return prunePlayerResponse(input);
  }

  // Hook ytInitialPlayerResponse assignment.
  try {
    let ytInitialPlayerResponseValue;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => ytInitialPlayerResponseValue,
      set: (value) => {
        ytInitialPlayerResponseValue = maybeProcessPlayerPayload(value);
      }
    });
  } catch {
    // Ignore if YouTube or another script locked this property first.
  }

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);

    try {
      const requestUrl = String(args[0]?.url || args[0] || '');
      if (!requestUrl.includes('/youtubei/v1/player')) {
        return response;
      }

      const clone = response.clone();
      const bodyText = await clone.text();
      if (!bodyText) {
        return response;
      }

      const parsed = JSON.parse(bodyText);
      const pruned = maybeProcessPlayerPayload(parsed);
      const nextBody = JSON.stringify(pruned);

      return new Response(nextBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch {
      return response;
    }
  };

  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    let requestUrl = '';

    const open = xhr.open;
    xhr.open = function patchedOpen(method, url, ...rest) {
      requestUrl = String(url || '');
      return open.call(this, method, url, ...rest);
    };

    const onReadyStateChange = () => {
      try {
        if (xhr.readyState !== 4 || !requestUrl.includes('/youtubei/v1/player')) {
          return;
        }

        const text = xhr.responseText;
        if (!text) {
          return;
        }

        const parsed = JSON.parse(text);
        const pruned = maybeProcessPlayerPayload(parsed);
        const nextText = JSON.stringify(pruned);

        try {
          Object.defineProperty(xhr, 'responseText', {
            configurable: true,
            get: () => nextText
          });
        } catch {
          // If not patchable, fallback is content-script skip logic.
        }
      } catch {
        // Ignore parse/mutation issues.
      }
    };

    xhr.addEventListener('readystatechange', onReadyStateChange);
    return xhr;
  }

  Object.setPrototypeOf(PatchedXHR, OriginalXHR);
  PatchedXHR.prototype = OriginalXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;
})();
