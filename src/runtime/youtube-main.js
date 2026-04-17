(() => {
  const YT_HOST_RE = /(^|\.)youtube\.com$/i;
  const PLAYER_ENDPOINT_RE = /\/youtubei\/v1\/(player|next)(?:\?|$)/i;
  const PATCH_FLAG = '__zerotraceYouTubePatchV1';
  const AD_MARKER_RE = /"adPlacements"|"playerAds"|"adSlots"|"adBreakHeartbeatParams"/;

  if (!YT_HOST_RE.test(location.hostname)) {
    return;
  }

  if (window[PATCH_FLAG]) {
    return;
  }

  Object.defineProperty(window, PATCH_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  const xhrMeta = new WeakMap();
  const xhrOverrides = new WeakMap();

  function sanitizePlayerResponse(payload) {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    let changed = false;

    const visit = (node) => {
      if (!node || typeof node !== 'object') {
        return;
      }

      if (Object.prototype.hasOwnProperty.call(node, 'adPlacements')) {
        node.adPlacements = [];
        changed = true;
      }

      if (Object.prototype.hasOwnProperty.call(node, 'playerAds')) {
        node.playerAds = [];
        changed = true;
      }

      if (Object.prototype.hasOwnProperty.call(node, 'adSlots')) {
        node.adSlots = [];
        changed = true;
      }

      if (Object.prototype.hasOwnProperty.call(node, 'adBreakHeartbeatParams')) {
        try {
          delete node.adBreakHeartbeatParams;
          changed = true;
        } catch {
          // ignore delete failures
        }
      }

      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
          visit(value);
        }
      }
    };

    visit(payload);
    return changed;
  }

  function sanitizeAnyPayload(value) {
    if (!value) {
      return { changed: false, value };
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        const changed = sanitizePlayerResponse(parsed);
        if (!changed) {
          return { changed: false, value };
        }

        return { changed: true, value: JSON.stringify(parsed) };
      } catch {
        return { changed: false, value };
      }
    }

    if (typeof value === 'object') {
      const changed = sanitizePlayerResponse(value);
      return { changed, value };
    }

    return { changed: false, value };
  }

  function extractUrl(input) {
    if (typeof input === 'string') {
      return input;
    }

    if (input && typeof input.url === 'string') {
      return input.url;
    }

    return '';
  }

  function shouldPatchUrl(url) {
    return typeof url === 'string' && PLAYER_ENDPOINT_RE.test(url);
  }

  function buildResponseFromJson(json, response) {
    const body = JSON.stringify(json);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  }

  async function tryPatchFetchResponse(url, response) {
    if (!shouldPatchUrl(url)) {
      return response;
    }

    try {
      const text = await response.clone().text();
      if (!text) {
        return response;
      }

      if (!AD_MARKER_RE.test(text)) {
        return response;
      }

      const json = JSON.parse(text);
      const changed = sanitizePlayerResponse(json);

      if (!changed) {
        return response;
      }

      return buildResponseFromJson(json, response);
    } catch {
      return response;
    }
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function') {
      return;
    }

    const nativeFetch = window.fetch.bind(window);

    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const url = extractUrl(args[0]);
      return tryPatchFetchResponse(url, response);
    };
  }

  function patchXhr() {
    const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!xhrProto) {
      return;
    }

    const nativeOpen = xhrProto.open;
    const nativeSend = xhrProto.send;

    xhrProto.open = function open(method, url, ...rest) {
      xhrMeta.set(this, { url: typeof url === 'string' ? url : String(url || '') });
      return nativeOpen.call(this, method, url, ...rest);
    };

    xhrProto.send = function send(...args) {
      const onReadyStateChange = () => {
        if (this.readyState !== 4) {
          return;
        }

        this.removeEventListener('readystatechange', onReadyStateChange);

        try {
          const meta = xhrMeta.get(this);
          if (!meta || !shouldPatchUrl(meta.url)) {
            return;
          }

          if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') {
            return;
          }

          if (this.responseType === 'json') {
            const responseJson = this.response;
            if (!responseJson || typeof responseJson !== 'object') {
              return;
            }

            const changed = sanitizePlayerResponse(responseJson);
            if (!changed) {
              return;
            }

            xhrOverrides.set(this, {
              text: JSON.stringify(responseJson),
              json: responseJson,
            });
            return;
          }

          const sourceText = this.responseText;
          if (!sourceText) {
            return;
          }

          if (!AD_MARKER_RE.test(sourceText)) {
            return;
          }

          const parsed = JSON.parse(sourceText);
          const changed = sanitizePlayerResponse(parsed);
          if (!changed) {
            return;
          }

          xhrOverrides.set(this, {
            text: JSON.stringify(parsed),
            json: parsed,
          });
        } catch {
          // ignore parsing/patch failures to avoid playback regressions
        }
      };

      this.addEventListener('readystatechange', onReadyStateChange);

      return nativeSend.apply(this, args);
    };

    const responseTextDesc = Object.getOwnPropertyDescriptor(xhrProto, 'responseText');
    const responseDesc = Object.getOwnPropertyDescriptor(xhrProto, 'response');

    if (responseTextDesc && typeof responseTextDesc.get === 'function') {
      Object.defineProperty(xhrProto, 'responseText', {
        configurable: true,
        enumerable: responseTextDesc.enumerable,
        get() {
          const override = xhrOverrides.get(this);
          if (override && typeof override.text === 'string') {
            return override.text;
          }

          return responseTextDesc.get.call(this);
        },
      });
    }

    if (responseDesc && typeof responseDesc.get === 'function') {
      Object.defineProperty(xhrProto, 'response', {
        configurable: true,
        enumerable: responseDesc.enumerable,
        get() {
          const override = xhrOverrides.get(this);
          if (!override) {
            return responseDesc.get.call(this);
          }

          if (this.responseType === 'json') {
            return override.json;
          }

          if (!this.responseType || this.responseType === 'text') {
            return override.text;
          }

          return responseDesc.get.call(this);
        },
      });
    }
  }

  function patchInitialPlayerResponse() {
    try {
      let currentValue = window.ytInitialPlayerResponse;
      const initial = sanitizeAnyPayload(currentValue);
      currentValue = initial.value;

      Object.defineProperty(window, 'ytInitialPlayerResponse', {
        configurable: true,
        enumerable: true,
        get() {
          return currentValue;
        },
        set(value) {
          const sanitized = sanitizeAnyPayload(value);
          currentValue = sanitized.value;
        },
      });
    } catch {
      // ignore property patch failures
    }
  }

  patchFetch();
  patchXhr();
  patchInitialPlayerResponse();
})();
