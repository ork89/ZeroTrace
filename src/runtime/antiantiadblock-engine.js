(function initAntiAntiAdblockEngine(globalScope) {
  const PROFILE_SCAN_SELECTORS = 'div, section, aside, article, dialog';
  const GENERIC_CANDIDATE_SELECTORS = [
    'dialog[open]',
    '[role="dialog"][aria-modal="true"]',
    '[class*="adblock" i]',
    '[id*="adblock" i]',
    '[class*="overlay" i]',
    '[id*="overlay" i]',
    '[class*="modal" i]',
    '[id*="modal" i]',
  ].join(', ');
  const GENERIC_TEXT_PATTERNS = [
    /ad[\s-]?blocker/i,
    /disable (?:your )?ad[\s-]?blocker/i,
    /allow ads/i,
    /whitelist/i,
    /ads? (?:are|aren't|were) (?:being )?displayed/i,
  ];
  const SITE_PROFILES = [
    {
      id: 'howtogeek',
      hostMatcher: /(^|\.)howtogeek\.com$/i,
      blockerSelectors: 'dialog[open], .adblock, [class*="adblock" i], [id*="adblock" i]',
      textPatterns: [/we noticed that ads aren't being displayed\./i],
      maxAncestorDepth: 16,
      scanSelectors: PROFILE_SCAN_SELECTORS,
    },
  ];

  function captureInlineStyleState(element, propertyName) {
    return {
      value: element.style.getPropertyValue(propertyName),
      priority: element.style.getPropertyPriority(propertyName),
    };
  }

  function restoreInlineStyleState(element, propertyName, state) {
    if (!state || !state.value) {
      element.style.removeProperty(propertyName);
      return;
    }

    element.style.setProperty(propertyName, state.value, state.priority || '');
  }

  function resolveSiteProfile(hostname) {
    if (typeof hostname !== 'string' || !hostname) {
      return null;
    }

    return SITE_PROFILES.find((profile) => profile.hostMatcher.test(hostname)) || null;
  }

  function hasAnyTextPattern(text, patterns) {
    if (typeof text !== 'string' || !text) {
      return false;
    }

    return patterns.some((pattern) => pattern.test(text));
  }

  function isAdblockMarker(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const className = typeof element.className === 'string' ? element.className.toLowerCase() : '';
    const id = (element.id || '').toLowerCase();
    return className.includes('adblock') || id.includes('adblock');
  }

  function isOverlayLike(element, win) {
    const computed = win.getComputedStyle(element);
    const zIndex = Number.parseInt(computed.zIndex || '0', 10);
    const fixedOrAbsolute = computed.position === 'fixed' || computed.position === 'absolute';
    if (!fixedOrAbsolute && zIndex < 100 && element.tagName !== 'DIALOG') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const viewportArea = Math.max(1, win.innerWidth * win.innerHeight);
    const overlapArea = Math.max(0, Math.min(rect.width, win.innerWidth) * Math.min(rect.height, win.innerHeight));
    const significantCoverage = overlapArea / viewportArea >= 0.25;
    return significantCoverage || fixedOrAbsolute || element.tagName === 'DIALOG' || zIndex >= 100;
  }

  function isProtectedContainer(element, doc) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element === doc.documentElement || element === doc.body) {
      return true;
    }

    return element.tagName === 'HTML' || element.tagName === 'BODY' || element.tagName === 'MAIN';
  }

  function isSuppressibleOverlayCandidate(element, win, doc) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (isProtectedContainer(element, doc)) {
      return false;
    }

    return isOverlayLike(element, win);
  }

  function collectAncestors(element, maxDepth, rootElement, predicate) {
    const out = [];
    let current = element;
    for (let depth = 0; depth < maxDepth && current && current !== rootElement; depth += 1) {
      if (predicate(current)) {
        out.push(current);
      }
      current = current.parentElement;
    }
    return out;
  }

  function createEngine({ win = window, doc = document, pageLocation = location } = {}) {
    const hiddenOverlayState = new Map();
    const pointerBypassState = new Map();
    const inertRemovedState = new Map();
    const dialogClosedState = new Set();
    let overflowState = null;

    function markHidden(element) {
      if (!hiddenOverlayState.has(element)) {
        hiddenOverlayState.set(element, {
          display: captureInlineStyleState(element, 'display'),
          visibility: captureInlineStyleState(element, 'visibility'),
        });
      }

      element.style.setProperty('display', 'none', 'important');
      element.style.setProperty('visibility', 'hidden', 'important');
      element.dataset.ztHiddenOverlay = '1';
    }

    function markPointerBypassed(element) {
      if (!pointerBypassState.has(element)) {
        pointerBypassState.set(element, captureInlineStyleState(element, 'pointer-events'));
      }

      element.style.setProperty('pointer-events', 'none', 'important');
    }

    function ensureOverflowOverrideState() {
      if (overflowState) {
        return;
      }

      overflowState = {
        documentElement: {
          overflow: captureInlineStyleState(doc.documentElement, 'overflow'),
          pointerEvents: captureInlineStyleState(doc.documentElement, 'pointer-events'),
        },
        body: doc.body
          ? {
              overflow: captureInlineStyleState(doc.body, 'overflow'),
              pointerEvents: captureInlineStyleState(doc.body, 'pointer-events'),
            }
          : null,
      };
    }

    function shouldReleaseRootLocks() {
      if (!doc.documentElement) {
        return false;
      }

      const rootStyle = win.getComputedStyle(doc.documentElement);
      const bodyStyle = doc.body ? win.getComputedStyle(doc.body) : null;
      return (
        rootStyle.overflow === 'hidden' ||
        rootStyle.pointerEvents === 'none' ||
        bodyStyle?.overflow === 'hidden' ||
        bodyStyle?.pointerEvents === 'none' ||
        inertRemovedState.size > 0
      );
    }

    function removeInertLocks(overlayNodes) {
      const overlaySet = new Set(overlayNodes);
      const inertNodes = doc.querySelectorAll('[inert]');
      for (const node of inertNodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        if ([...overlaySet].some((overlay) => overlay.contains(node))) {
          continue;
        }

        if (!inertRemovedState.has(node)) {
          inertRemovedState.set(node, node.getAttribute('inert'));
        }

        node.removeAttribute('inert');
      }
    }

    function gatherProfileCandidates(profile) {
      const out = [];
      for (const node of doc.querySelectorAll(profile.blockerSelectors)) {
        if (isSuppressibleOverlayCandidate(node, win, doc)) {
          out.push(node);
        }
      }

      for (const node of doc.querySelectorAll(profile.scanSelectors || PROFILE_SCAN_SELECTORS)) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        if (!hasAnyTextPattern(node.textContent || '', profile.textPatterns)) {
          continue;
        }

        const ancestors = collectAncestors(
          node,
          profile.maxAncestorDepth || 12,
          doc.documentElement,
          (candidate) => isSuppressibleOverlayCandidate(candidate, win, doc),
        );
        out.push(...ancestors);
      }

      return out;
    }

    function gatherGenericCandidates() {
      const out = [];
      for (const node of doc.querySelectorAll(GENERIC_CANDIDATE_SELECTORS)) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        const hasTextSignal = hasAnyTextPattern(node.textContent || '', GENERIC_TEXT_PATTERNS);
        const hasMarkerSignal = isAdblockMarker(node);
        if (!hasTextSignal && !hasMarkerSignal) {
          continue;
        }

        const ancestors = collectAncestors(
          node,
          10,
          doc.documentElement,
          (candidate) => isSuppressibleOverlayCandidate(candidate, win, doc),
        );
        if (ancestors.length === 0 && isSuppressibleOverlayCandidate(node, win, doc)) {
          out.push(node);
          continue;
        }

        out.push(...ancestors);
      }

      return out;
    }

    function suppress() {
      const profile = resolveSiteProfile(pageLocation.hostname);
      const candidates = [...(profile ? gatherProfileCandidates(profile) : []), ...gatherGenericCandidates()];
      const uniqueOverlays = new Set(
        candidates.filter((node) => isSuppressibleOverlayCandidate(node, win, doc)),
      );

      let hiddenCount = 0;
      for (const node of uniqueOverlays) {
        if (node.dataset.ztHiddenOverlay !== '1') {
          markHidden(node);
          hiddenCount += 1;
        }

        markPointerBypassed(node);
        if (node instanceof HTMLDialogElement && node.open) {
          dialogClosedState.add(node);
          try {
            node.close();
          } catch {
            // ignore close failures
          }
        }
      }

      removeInertLocks(uniqueOverlays);

      if ((hiddenCount > 0 || pointerBypassState.size > 0) && shouldReleaseRootLocks()) {
        ensureOverflowOverrideState();
        doc.documentElement.style.setProperty('overflow', 'auto', 'important');
        doc.documentElement.style.setProperty('pointer-events', 'auto', 'important');
        if (doc.body) {
          doc.body.style.setProperty('overflow', 'auto', 'important');
          doc.body.style.setProperty('pointer-events', 'auto', 'important');
        }
      }

      return hiddenCount;
    }

    function restore() {
      for (const [element, state] of hiddenOverlayState) {
        restoreInlineStyleState(element, 'display', state.display);
        restoreInlineStyleState(element, 'visibility', state.visibility);
        delete element.dataset.ztHiddenOverlay;
      }
      hiddenOverlayState.clear();

      for (const [element, state] of pointerBypassState) {
        restoreInlineStyleState(element, 'pointer-events', state);
      }
      pointerBypassState.clear();

      for (const [node, value] of inertRemovedState) {
        if (!node.isConnected) {
          continue;
        }
        if (value === null) {
          node.setAttribute('inert', '');
        } else {
          node.setAttribute('inert', value);
        }
      }
      inertRemovedState.clear();

      for (const dialog of dialogClosedState) {
        if (!dialog.isConnected) {
          continue;
        }
        dialog.setAttribute('open', '');
      }
      dialogClosedState.clear();

      if (!overflowState) {
        return;
      }

      restoreInlineStyleState(doc.documentElement, 'overflow', overflowState.documentElement.overflow);
      restoreInlineStyleState(doc.documentElement, 'pointer-events', overflowState.documentElement.pointerEvents);

      if (doc.body) {
        restoreInlineStyleState(doc.body, 'overflow', overflowState.body?.overflow);
        restoreInlineStyleState(doc.body, 'pointer-events', overflowState.body?.pointerEvents);
      }

      overflowState = null;
    }

    return {
      suppress,
      restore,
    };
  }

  const api = {
    createEngine,
    __test: {
      resolveSiteProfile,
      hasAnyTextPattern,
      isProtectedContainerTag: (tagName) => ['HTML', 'BODY', 'MAIN'].includes(String(tagName || '').toUpperCase()),
      getProfiles: () => SITE_PROFILES.map((profile) => profile.id),
      genericPatternCount: GENERIC_TEXT_PATTERNS.length,
    },
  };

  globalScope.ZeroTraceAntiAntiAdblockEngine = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(globalThis);
