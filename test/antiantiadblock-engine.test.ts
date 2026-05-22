import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const antiAntiAdblockEngine = require('../src/runtime/antiantiadblock-engine.js');

assert.ok(antiAntiAdblockEngine?.createEngine);
assert.ok(antiAntiAdblockEngine?.__test);

const profile = antiAntiAdblockEngine.__test.resolveSiteProfile('news.howtogeek.com');
assert.ok(profile);
assert.equal(profile.id, 'howtogeek');

const unmatchedProfile = antiAntiAdblockEngine.__test.resolveSiteProfile('example.com');
assert.equal(unmatchedProfile, null);

assert.equal(
  antiAntiAdblockEngine.__test.hasAnyTextPattern(
    "We noticed that ads aren't being displayed. Please disable ad blocker.",
    [/we noticed that ads aren't being displayed\./i],
  ),
  true,
);
assert.equal(
  antiAntiAdblockEngine.__test.hasAnyTextPattern('Please allow ads on our site', [/please allow ads/i]),
  true,
);

assert.equal(antiAntiAdblockEngine.__test.isProtectedContainerTag('body'), true);
assert.equal(antiAntiAdblockEngine.__test.isProtectedContainerTag('main'), true);
assert.equal(antiAntiAdblockEngine.__test.isProtectedContainerTag('div'), false);
assert.equal(antiAntiAdblockEngine.__test.isPaywallMarkerByTokens('site-gateway-paywall', ''), true);
assert.equal(antiAntiAdblockEngine.__test.isPaywallMarkerByTokens('', 'gateway-content'), true);
assert.equal(antiAntiAdblockEngine.__test.isPaywallMarkerByTokens('subscribe-banner', ''), false);
assert.equal(antiAntiAdblockEngine.__test.isPaywallMarkerByTokens('article-layout', 'content'), false);
assert.equal(antiAntiAdblockEngine.__test.isOverlayMarkerByTokens('paywall-backdrop', ''), true);
assert.equal(antiAntiAdblockEngine.__test.isOverlayMarkerByTokens('', 'modal-overlay'), true);
assert.equal(antiAntiAdblockEngine.__test.isOverlayMarkerByTokens('story-content', 'site-content'), false);
// Strong marker without containsMainContent → suppress
assert.equal(
  antiAntiAdblockEngine.__test.shouldSuppressCandidateByShape({
    hasStrongSelfMarker: true,
    isSuppressibleOverlay: true,
    isProtected: false,
    isLikelyContent: true,
    containsMainContent: false,
  }),
  true,
);
// Strong marker but wraps primary content → never suppress
assert.equal(
  antiAntiAdblockEngine.__test.shouldSuppressCandidateByShape({
    hasStrongSelfMarker: true,
    isSuppressibleOverlay: true,
    isProtected: false,
    isLikelyContent: false,
    containsMainContent: true,
  }),
  false,
);
assert.equal(
  antiAntiAdblockEngine.__test.shouldSuppressCandidateByShape({
    hasStrongSelfMarker: true,
    isSuppressibleOverlay: true,
    isProtected: true,
    isLikelyContent: false,
  }),
  false,
);
assert.equal(
  antiAntiAdblockEngine.__test.shouldSuppressCandidateByShape({
    hasStrongSelfMarker: false,
    isSuppressibleOverlay: true,
    isProtected: false,
    isLikelyContent: true,
  }),
  false,
);
assert.equal(
  antiAntiAdblockEngine.__test.isLikelyContentContainerByShape({
    hasMainArticle: true,
    textLength: 1000,
    paragraphCount: 2,
  }),
  true,
);
assert.equal(
  antiAntiAdblockEngine.__test.isLikelyContentContainerByShape({
    hasMainArticle: false,
    textLength: 3200,
    paragraphCount: 10,
  }),
  true,
);
assert.equal(
  antiAntiAdblockEngine.__test.isLikelyContentContainerByShape({
    hasMainArticle: false,
    textLength: 600,
    paragraphCount: 2,
  }),
  false,
);

assert.equal(antiAntiAdblockEngine.__test.genericPatternCount > 0, true);
assert.equal(antiAntiAdblockEngine.__test.blockingPatternCount > 0, true);

// Test shape for findPortalRoot: returns direct child of body
assert.ok(antiAntiAdblockEngine.__test.findPortalRoot);

// Test shape for isFixedContentScrollPrison: detects fixed scroll prisons
const mockFixedHiddenStyle = {
  position: 'fixed',
  overflow: 'hidden',
  overflowY: 'hidden',
  overflowX: 'auto',
};
assert.equal(antiAntiAdblockEngine.__test.isFixedContentScrollPrison(mockFixedHiddenStyle), true);

const mockNotFixedStyle = {
  position: 'static',
  overflow: 'hidden',
  overflowY: 'hidden',
};
assert.equal(antiAntiAdblockEngine.__test.isFixedContentScrollPrison(mockNotFixedStyle), false);

const mockFixedVisibleStyle = {
  position: 'fixed',
  overflow: 'auto',
  overflowY: 'auto',
};
assert.equal(antiAntiAdblockEngine.__test.isFixedContentScrollPrison(mockFixedVisibleStyle), false);

// Test shape for releaseContentScrollLocks: exists and is callable
assert.ok(typeof antiAntiAdblockEngine.__test.releaseContentScrollLocks === 'function');

// Test blank-viewport helpers: conservative force-unlock for content-rich blank viewports
assert.equal(typeof antiAntiAdblockEngine.__test.hasViewportReadableSignal, 'function');
assert.equal(typeof antiAntiAdblockEngine.__test.shouldForceUnlockByViewport, 'function');
assert.equal(typeof antiAntiAdblockEngine.__test.hasPotentialRootScrollPrison, 'function');

const mockWin = { innerWidth: 1200, innerHeight: 800 };
const mockBlankDoc = {
  body: { innerText: 'x'.repeat(1600), textContent: 'x'.repeat(1600) },
  elementsFromPoint: () => [],
};
assert.equal(antiAntiAdblockEngine.__test.shouldForceUnlockByViewport(mockBlankDoc, mockWin), true);

const mockBoundaryDoc = {
  body: { innerText: 'x'.repeat(1200), textContent: 'x'.repeat(1200) },
  elementsFromPoint: () => [],
};
assert.equal(antiAntiAdblockEngine.__test.shouldForceUnlockByViewport(mockBoundaryDoc, mockWin), true);

const mockBelowBoundaryDoc = {
  body: { innerText: 'x'.repeat(1199), textContent: 'x'.repeat(1199) },
  elementsFromPoint: () => [],
};
assert.equal(antiAntiAdblockEngine.__test.shouldForceUnlockByViewport(mockBelowBoundaryDoc, mockWin), false);

const mockTinyDoc = {
  body: { innerText: 'short', textContent: 'short' },
  elementsFromPoint: () => [],
};
assert.equal(antiAntiAdblockEngine.__test.shouldForceUnlockByViewport(mockTinyDoc, mockWin), false);

const originalHTMLElement = globalThis.HTMLElement;
class MockHTMLElement {
  constructor(textContent) {
    this.textContent = textContent;
    this.innerText = '';
  }
  matches() {
    return false;
  }
  getBoundingClientRect() {
    return { width: 40, height: 40 };
  }
}
globalThis.HTMLElement = MockHTMLElement;
try {
  const textOnlyNode = new MockHTMLElement('visible text');
  const textOnlyDoc = {
    body: {},
    documentElement: {},
    elementsFromPoint: () => [textOnlyNode],
  };
  assert.equal(antiAntiAdblockEngine.__test.hasViewportReadableSignal(textOnlyDoc, mockWin), true);

  const shortTextNode = new MockHTMLElement('1234567');
  const shortTextDoc = {
    body: {},
    documentElement: {},
    elementsFromPoint: () => [shortTextNode],
  };
  assert.equal(antiAntiAdblockEngine.__test.hasViewportReadableSignal(shortTextDoc, mockWin), false);
} finally {
  if (originalHTMLElement === undefined) {
    delete globalThis.HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
}

const mockPrisonDoc = {
  documentElement: {},
  body: {},
};
const mockPrisonWin = {
  getComputedStyle: (node) =>
    node === mockPrisonDoc.documentElement
      ? { overflow: 'visible', overflowY: 'auto', overflowX: 'hidden' }
      : { overflow: 'visible', overflowY: 'visible', overflowX: 'visible' },
};
assert.equal(antiAntiAdblockEngine.__test.hasPotentialRootScrollPrison(mockPrisonDoc, mockPrisonWin), true);

// Test shape for gatherPaywallContainerChildren: exists and is callable
assert.ok(typeof antiAntiAdblockEngine.__test.gatherPaywallContainerChildren === 'function');

// Test exported constants are available
assert.ok(antiAntiAdblockEngine.__test.PRIMARY_CONTENT_SELECTORS);
assert.ok(antiAntiAdblockEngine.__test.PAYWALL_MARKER_TOKENS);
assert.ok(antiAntiAdblockEngine.__test.OVERLAY_MARKER_TOKENS);
assert.ok(Array.isArray(antiAntiAdblockEngine.__test.PAYWALL_MARKER_TOKENS));
assert.ok(Array.isArray(antiAntiAdblockEngine.__test.OVERLAY_MARKER_TOKENS));

console.log('anti-anti-adblock engine model checks passed');
