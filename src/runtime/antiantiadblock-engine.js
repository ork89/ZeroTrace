(function initAntiAntiAdblockEngine(globalScope) {
  const PROFILE_SCAN_SELECTORS = 'div, section, aside, article, dialog';
  const PRIMARY_CONTENT_SELECTORS = 'main, [role="main"], article';
  const PAYWALL_MARKER_TOKENS = ['paywall', 'gateway', 'regiwall'];
  const OVERLAY_MARKER_TOKENS = ['overlay', 'modal', 'backdrop', 'scrim'];
  const GENERIC_CANDIDATE_SELECTORS = [
    'dialog[open]',
    '[role="dialog"][aria-modal="true"]',
    'iframe[src*="piano" i]',
    'iframe[src*="tinypass" i]',
    'iframe[src*="paywall" i]',
    '[class*="paywall" i]',
    '[id*="paywall" i]',
    '[class*="gateway" i]',
    '[id*="gateway" i]',
    '[class*="regiwall" i]',
    '[id*="regiwall" i]',
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
    /please allow ads/i,
    /(?:site|website) is supported by ads/i,
    /whitelist/i,
    /ads? (?:are|aren't|were) (?:being )?displayed/i,
    /create (?:a )?free account/i,
    /continue reading/i,
    /unlimited access/i,
    /email address/i,
  ];
  const GENERIC_BLOCKING_TEXT_PATTERNS = [
    /ad[\s-]?blocker/i,
    /disable (?:your )?ad[\s-]?blocker/i,
    /allow ads/i,
    /please allow ads/i,
    /(?:site|website) is supported by ads/i,
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

  function hasAnyTokenMarker(element, tokens) {
    const className = typeof element?.className === 'string' ? element.className.toLowerCase() : '';
    const id = typeof element?.id === 'string' ? element.id.toLowerCase() : '';
    if (!className && !id) {
      return false;
    }

    return tokens.some((token) => className.includes(token) || id.includes(token));
  }

  function isPaywallMarker(element) {
    return hasAnyTokenMarker(element, PAYWALL_MARKER_TOKENS);
  }

  function isOverlayMarker(element) {
    return hasAnyTokenMarker(element, OVERLAY_MARKER_TOKENS);
  }

  function isLikelyContentContainer(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.matches?.('main, article, #site-content, #app')) {
      return true;
    }

    if (element.querySelector('main article, article, [data-testid="story"]')) {
      return true;
    }

    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    const paragraphCount = element.querySelectorAll('p').length;
    return text.length > 2500 && paragraphCount >= 8;
  }

  function containsMainContent(element, doc, primaryContent) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    // Never suppress an element that is an ancestor of the page's primary content area.
    if (primaryContent && element.contains(primaryContent)) {
      return true;
    }

    return isLikelyContentContainer(element);
  }

  function hasStrongSelfMarker(element) {
    return isAdblockMarker(element) || isPaywallMarker(element) || isOverlayMarker(element);
  }

  /**
   * Walk up to find the direct child of <body> that is an ancestor of `node`.
   * React portals and similar patterns append paywall roots directly to <body>
   * as siblings to the main app container. Hiding the portal root suppresses
   * both the backdrop and the form in a single operation.
   */
  function findPortalRoot(node, doc) {
    let current = node;
    while (current && current !== doc.documentElement) {
      if (current.parentElement === doc.body) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  /**
   * A "portal overlay" is a direct child of <body> that does not wrap the
   * primary content area. These are safe to suppress without requiring
   * overlay-like CSS positioning, because they are always siblings — never
   * ancestors — of <main>.
   */
  function isPortalOverlay(element, doc, primaryContent) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (isProtectedContainer(element, doc)) {
      return false;
    }

    if (element.parentElement !== doc.body) {
      return false;
    }

    if (containsMainContent(element, doc, primaryContent)) {
      return false;
    }

    // Must have a visible presence worth hiding.
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function shouldSuppressCandidate(node, win, doc, primaryContent) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    if (isProtectedContainer(node, doc)) {
      return false;
    }

    // Absolute guard: never hide an element that wraps the page's primary content.
    if (containsMainContent(node, doc, primaryContent)) {
      return false;
    }

    // Portal overlays (direct body children that don't wrap main) are safe to
    // suppress without requiring overlay-like CSS positioning.
    if (isPortalOverlay(node, doc, primaryContent)) {
      return true;
    }

    if (!isOverlayLike(node, win)) {
      return false;
    }

    if (hasStrongSelfMarker(node)) {
      return true;
    }

    return !isLikelyContentContainer(node);
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

  function isFixedContentScrollPrison(computedStyle) {
    if (computedStyle.position !== 'fixed') {
      return false;
    }

    const overflow = computedStyle.overflow;
    const overflowY = computedStyle.overflowY;
    const overflowX = computedStyle.overflowX;
    const clipsContent =
      overflow === 'hidden' ||
      overflowY === 'hidden' ||
      overflow === 'clip' ||
      overflowY === 'clip' ||
      // Common pattern: overflow-x hidden with overflow-y auto still traps content
      // inside a fixed-height viewport container.
      (overflowX === 'hidden' && overflowY === 'auto');

    return clipsContent;
  }

  function hasViewportReadableSignal(doc, win) {
    if (typeof doc.elementsFromPoint !== 'function') {
      return true;
    }

    const samples = [
      [Math.floor(win.innerWidth * 0.5), Math.floor(win.innerHeight * 0.5)],
      [Math.floor(win.innerWidth * 0.35), Math.floor(win.innerHeight * 0.5)],
      [Math.floor(win.innerWidth * 0.65), Math.floor(win.innerHeight * 0.5)],
      [Math.floor(win.innerWidth * 0.5), Math.floor(win.innerHeight * 0.35)],
      [Math.floor(win.innerWidth * 0.5), Math.floor(win.innerHeight * 0.7)],
    ];

    for (const [x, y] of samples) {
      const stack = doc.elementsFromPoint(x, y).slice(0, 8);
      for (const node of stack) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        if (node === doc.body || node === doc.documentElement) {
          continue;
        }

        const rect = node.getBoundingClientRect();
        if (rect.width * rect.height < 1200) {
          continue;
        }

        if (node.matches('img,video,canvas,svg,a,button,input,article,section,main,[role="main"]')) {
          return true;
        }

        const text = (node.textContent || '').trim();
        if (text.length >= 8) {
          return true;
        }
      }
    }

    return false;
  }

  function shouldForceUnlockByViewport(doc, win) {
    if (!doc.body) {
      return false;
    }

    const bodyTextLength = (doc.body.innerText || doc.body.textContent || '').trim().length;
    if (bodyTextLength < 1200) {
      return false;
    }

    return !hasViewportReadableSignal(doc, win);
  }

  function hasPotentialRootScrollPrison(doc, win) {
    if (!doc.documentElement) {
      return false;
    }

    const candidates = [win.getComputedStyle(doc.documentElement)];
    if (doc.body) {
      candidates.push(win.getComputedStyle(doc.body));
    }

    return candidates.some((style) => {
      const clipped = style.overflow === 'clip' || style.overflowY === 'clip';
      const hiddenXAutoY = style.overflowX === 'hidden' && style.overflowY === 'auto';
      return clipped || hiddenXAutoY;
    });
  }

  function releaseContentScrollLocks(doc, win, contentLockState) {
    const contentAnchor = doc.querySelector(PRIMARY_CONTENT_SELECTORS);
    if (!contentAnchor) {
      return;
    }

    let ancestor = contentAnchor.parentElement;
    while (ancestor && ancestor !== doc.documentElement && ancestor !== doc.body) {
      if (ancestor instanceof HTMLElement) {
        const computed = win.getComputedStyle(ancestor);
        if (isFixedContentScrollPrison(computed)) {
          if (!contentLockState.has(ancestor)) {
            contentLockState.set(ancestor, {
              overflowY: captureInlineStyleState(ancestor, 'overflow-y'),
              height: captureInlineStyleState(ancestor, 'height'),
            });
          }

          ancestor.style.setProperty('overflow-y', 'auto', 'important');
          ancestor.style.setProperty('height', '100vh', 'important');
        }
      }

      ancestor = ancestor.parentElement;
    }
  }

  function gatherPaywallContainerChildren(doc, win, primaryContent) {
    const out = [];
    for (const node of doc.querySelectorAll(GENERIC_CANDIDATE_SELECTORS)) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (!hasStrongSelfMarker(node) || !containsMainContent(node, doc, primaryContent)) {
        continue;
      }

      for (const child of node.children) {
        if (!(child instanceof HTMLElement)) {
          continue;
        }

        if (containsMainContent(child, doc, primaryContent)) {
          continue;
        }

        if (isOverlayLike(child, win)) {
          out.push(child);
        }
      }
    }

    return out;
  }

  function createEngine({ win = window, doc = document, pageLocation = location } = {}) {
    const hiddenOverlayState = new Map();
    const pointerBypassState = new Map();
    const inertRemovedState = new Map();
    const dialogClosedState = new Set();
    const contentLockState = new Map();
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
          position: captureInlineStyleState(doc.documentElement, 'position'),
        },
        body: doc.body
          ? {
              overflow: captureInlineStyleState(doc.body, 'overflow'),
              pointerEvents: captureInlineStyleState(doc.body, 'pointer-events'),
              position: captureInlineStyleState(doc.body, 'position'),
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
      const isScrollLocked = (s) =>
        s != null &&
        (s.overflow === 'hidden' || s.overflowY === 'hidden' || s.pointerEvents === 'none' || s.position === 'fixed');
      return isScrollLocked(rootStyle) || isScrollLocked(bodyStyle) || inertRemovedState.size > 0;
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

        const ancestors = collectAncestors(node, profile.maxAncestorDepth || 12, doc.documentElement, (candidate) =>
          isSuppressibleOverlayCandidate(candidate, win, doc),
        );
        if (ancestors.length === 0 && isSuppressibleOverlayCandidate(node, win, doc)) {
          out.push(node);
          continue;
        }

        out.push(...ancestors);
      }

      return out;
    }

    function gatherViewportTextSignalCandidates(primaryContent) {
      if (typeof doc.elementsFromPoint !== 'function') {
        return [];
      }

      const out = [];
      const seen = new Set();
      const samples = [
        [Math.floor(win.innerWidth * 0.5), Math.floor(win.innerHeight * 0.5)],
        [Math.floor(win.innerWidth * 0.5), Math.floor(win.innerHeight * 0.35)],
        [Math.floor(win.innerWidth * 0.5), Math.floor(win.innerHeight * 0.65)],
      ];

      function addCandidate(node) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
      }

      for (const [x, y] of samples) {
        const stack = doc.elementsFromPoint(x, y).slice(0, 10);
        for (const node of stack) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }

          if (!hasAnyTextPattern(node.textContent || '', GENERIC_BLOCKING_TEXT_PATTERNS)) {
            continue;
          }

          const ancestors = collectAncestors(node, 6, doc.documentElement, (candidate) =>
            shouldSuppressCandidate(candidate, win, doc, primaryContent),
          );

          if (ancestors.length === 0 && shouldSuppressCandidate(node, win, doc, primaryContent)) {
            addCandidate(node);
            continue;
          }

          for (const candidate of ancestors) {
            addCandidate(candidate);
          }
        }
      }

      return out;
    }

    function shouldIncludeGenericCandidate(
      node,
      hasTextSignal,
      hasStrongMarkerSignal,
      hasOverlayMarkerSignal,
      lockDetected,
    ) {
      const lockAwareOverlaySignal = lockDetected && hasOverlayMarkerSignal;
      return hasTextSignal || hasStrongMarkerSignal || lockAwareOverlaySignal;
    }

    function gatherGenericCandidates(lockDetected = false) {
      const out = [];
      const seen = new Set();

      function addCandidate(node) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
      }

      for (const node of doc.querySelectorAll(GENERIC_CANDIDATE_SELECTORS)) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        const hasTextSignal = hasAnyTextPattern(node.textContent || '', GENERIC_TEXT_PATTERNS);
        const hasStrongMarkerSignal = isAdblockMarker(node) || isPaywallMarker(node);
        const hasOverlayMarkerSignal = isOverlayMarker(node);

        if (
          !shouldIncludeGenericCandidate(
            node,
            hasTextSignal,
            hasStrongMarkerSignal,
            hasOverlayMarkerSignal,
            lockDetected,
          )
        ) {
          continue;
        }

        // For paywall/gateway/adblock markers: target the portal root first.
        // Hiding the portal root suppresses both the scrim/backdrop and the
        // subscribe form in a single operation, and is guaranteed not to wrap <main>.
        if (hasStrongMarkerSignal) {
          const portalRoot = findPortalRoot(node, doc);
          if (portalRoot) {
            addCandidate(portalRoot);
          }
        }

        // Always include the matched node itself — do not skip it in favour
        // of ancestors. The node may be the best target (e.g. #gateway-content)
        // and climbing further up can reach containers that wrap <main>.
        addCandidate(node);

        // For text-matched and lock-aware overlay signals, also walk up to
        // capture any positioned overlay ancestor that wraps the signal node.
        const lockAwareOverlaySignal = lockDetected && hasOverlayMarkerSignal;
        if (hasTextSignal || lockAwareOverlaySignal) {
          const ancestors = collectAncestors(node, 6, doc.documentElement, (candidate) =>
            isSuppressibleOverlayCandidate(candidate, win, doc),
          );
          for (const a of ancestors) {
            addCandidate(a);
          }
        }
      }

      return out;
    }

    function suppress() {
      const lockDetected = shouldReleaseRootLocks();
      const potentialRootPrison = hasPotentialRootScrollPrison(doc, win);
      const forceUnlockByViewport = (lockDetected || potentialRootPrison) && shouldForceUnlockByViewport(doc, win);
      const primaryContent = doc.querySelector(PRIMARY_CONTENT_SELECTORS);
      const profile = resolveSiteProfile(pageLocation.hostname);
      const candidates = [
        ...(profile ? gatherProfileCandidates(profile) : []),
        ...gatherGenericCandidates(lockDetected),
        ...gatherViewportTextSignalCandidates(primaryContent),
        ...gatherPaywallContainerChildren(doc, win, primaryContent),
      ];
      const uniqueOverlays = new Set(
        candidates.filter((node) => shouldSuppressCandidate(node, win, doc, primaryContent)),
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

      // Only release global/ancestor scroll locks if we actually suppressed a
      // blocking overlay signal on this run. Releasing locks with no suppression
      // can hijack legitimate layout state and jump scroll unexpectedly.
      const shouldReleaseLocks =
        (lockDetected || forceUnlockByViewport) &&
        (hiddenCount > 0 || inertRemovedState.size > 0 || forceUnlockByViewport);

      if (shouldReleaseLocks) {
        // The scroll prison is often a fixed wrapper div (not body/html), so we
        // still walk ancestors when lock release is warranted.
        releaseContentScrollLocks(doc, win, contentLockState);

        ensureOverflowOverrideState();
        const htmlComputed = win.getComputedStyle(doc.documentElement);
        doc.documentElement.style.setProperty('overflow', 'auto', 'important');
        doc.documentElement.style.setProperty('pointer-events', 'auto', 'important');
        if (htmlComputed.position === 'fixed') {
          doc.documentElement.style.setProperty('position', 'unset', 'important');
        }
        if (doc.body) {
          const bodyComputed = win.getComputedStyle(doc.body);
          doc.body.style.setProperty('overflow', 'auto', 'important');
          doc.body.style.setProperty('pointer-events', 'auto', 'important');
          // Unset position:fixed scroll-lock (e.g. react-modal's body.ReactModal__Body--open).
          // This pattern encodes the current scroll offset as body.style.top = -scrollYpx.
          // We must restore the scroll position after releasing the lock or the page
          // appears to jump to the top.
          if (bodyComputed.position === 'fixed') {
            const encodedTop = parseInt(doc.body.style.top || '0', 10);
            doc.body.style.setProperty('position', 'static', 'important');
            doc.body.style.removeProperty('top');
            if (forceUnlockByViewport) {
              win.scrollTo(0, 0);
            } else if (encodedTop < 0) {
              win.scrollTo(0, -encodedTop);
            }
          }
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

      for (const [element, state] of contentLockState) {
        restoreInlineStyleState(element, 'overflow-y', state.overflowY);
        restoreInlineStyleState(element, 'height', state.height);
      }
      contentLockState.clear();

      if (!overflowState) {
        return;
      }

      restoreInlineStyleState(doc.documentElement, 'overflow', overflowState.documentElement.overflow);
      restoreInlineStyleState(doc.documentElement, 'pointer-events', overflowState.documentElement.pointerEvents);
      restoreInlineStyleState(doc.documentElement, 'position', overflowState.documentElement.position);

      if (doc.body) {
        restoreInlineStyleState(doc.body, 'overflow', overflowState.body?.overflow);
        restoreInlineStyleState(doc.body, 'pointer-events', overflowState.body?.pointerEvents);
        restoreInlineStyleState(doc.body, 'position', overflowState.body?.position);
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
      isPaywallMarker,
      isPaywallMarkerByTokens: (className, id = '') => isPaywallMarker({ className, id }),
      isOverlayMarkerByTokens: (className, id = '') => isOverlayMarker({ className, id }),
      shouldSuppressCandidateByShape: ({
        hasStrongSelfMarker = false,
        isSuppressibleOverlay = false,
        isProtected = false,
        isLikelyContent = false,
        containsMainContent = false,
      } = {}) => {
        if (!isSuppressibleOverlay) {
          return false;
        }

        // Absolute guard mirrors containsMainContent in the real implementation.
        if (containsMainContent) {
          return false;
        }

        if (hasStrongSelfMarker) {
          return !isProtected;
        }

        return !isLikelyContent;
      },
      isLikelyContentContainerByShape: ({ hasMainArticle = false, textLength = 0, paragraphCount = 0 } = {}) =>
        Boolean(hasMainArticle) || (Number(textLength) > 2500 && Number(paragraphCount) >= 8),
      isProtectedContainerTag: (tagName) => ['HTML', 'BODY', 'MAIN'].includes(String(tagName || '').toUpperCase()),
      getProfiles: () => SITE_PROFILES.map((profile) => profile.id),
      genericPatternCount: GENERIC_TEXT_PATTERNS.length,
      blockingPatternCount: GENERIC_BLOCKING_TEXT_PATTERNS.length,
      PRIMARY_CONTENT_SELECTORS,
      PAYWALL_MARKER_TOKENS,
      OVERLAY_MARKER_TOKENS,
      // Test hooks for new functions
      findPortalRoot,
      isFixedContentScrollPrison,
      hasViewportReadableSignal,
      shouldForceUnlockByViewport,
      hasPotentialRootScrollPrison,
      releaseContentScrollLocks,
      gatherPaywallContainerChildren,
    },
  };

  globalScope.ZeroTraceAntiAntiAdblockEngine = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(globalThis);
