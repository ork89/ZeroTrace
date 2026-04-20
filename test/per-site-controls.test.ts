import assert from 'node:assert/strict';

import {
  SESSION_RULE_PRIORITY,
  buildPerSiteSessionRules,
  buildPerSiteSessionRuleSync,
  buildPopupHostControlsModel,
  getDeterministicSessionRuleId,
  normalizeHostnameFromUrl,
  resolveHostControlState,
  setHostPaused,
  setHostWhitelisted,
} from '../src/runtime/siteControlsModel';

// Hostname normalization should always use URL hostname lowercased.
assert.equal(normalizeHostnameFromUrl('https://Sub.Example.COM:443/path?q=1'), 'sub.example.com');

// State precedence: global off > whitelisted > paused > normal.
assert.equal(
  resolveHostControlState({
    globalEnabled: false,
    host: 'example.com',
    pausedHosts: ['example.com'],
    whitelistedHosts: ['example.com'],
  }),
  'global-off',
);
assert.equal(
  resolveHostControlState({
    globalEnabled: true,
    host: 'example.com',
    pausedHosts: ['example.com'],
    whitelistedHosts: ['example.com'],
  }),
  'whitelisted',
);
assert.equal(
  resolveHostControlState({
    globalEnabled: true,
    host: 'example.com',
    pausedHosts: ['example.com'],
    whitelistedHosts: [],
  }),
  'paused',
);
assert.equal(
  resolveHostControlState({
    globalEnabled: true,
    host: 'example.com',
    pausedHosts: [],
    whitelistedHosts: [],
  }),
  'normal',
);

// Mutual exclusion: whitelisting removes pause.
const whitelisted = setHostWhitelisted(
  {
    pausedHosts: ['example.com'],
    whitelistedHosts: [],
  },
  'example.com',
);
assert.deepEqual(whitelisted.pausedHosts, []);
assert.deepEqual(whitelisted.whitelistedHosts, ['example.com']);

// Mutual exclusion: pausing removes whitelist.
const paused = setHostPaused(
  {
    pausedHosts: [],
    whitelistedHosts: ['example.com'],
  },
  'example.com',
);
assert.deepEqual(paused.pausedHosts, ['example.com']);
assert.deepEqual(paused.whitelistedHosts, []);

// DNR rule IDs must be deterministic and distinct by kind.
const whitelistRuleIdA = getDeterministicSessionRuleId('whitelist', 'example.com');
const whitelistRuleIdB = getDeterministicSessionRuleId('whitelist', 'example.com');
const pausedRuleId = getDeterministicSessionRuleId('paused', 'example.com');
assert.equal(whitelistRuleIdA, whitelistRuleIdB);
assert.notEqual(whitelistRuleIdA, pausedRuleId);

// DNR session rules should use allowAllRequests + priority + requestDomains host.
const rules = buildPerSiteSessionRules({
  pausedHosts: ['paused.example.com'],
  whitelistedHosts: ['white.example.com'],
});
assert.equal(rules.length, 2);

const pausedRule = rules.find((rule) => rule.condition.requestDomains[0] === 'paused.example.com');
assert.ok(pausedRule);
assert.equal(pausedRule.id, getDeterministicSessionRuleId('paused', 'paused.example.com'));
assert.equal(pausedRule.priority, SESSION_RULE_PRIORITY);
assert.equal(pausedRule.action.type, 'allowAllRequests');
assert.deepEqual(pausedRule.condition.requestDomains, ['paused.example.com']);

const whitelistRule = rules.find((rule) => rule.condition.requestDomains[0] === 'white.example.com');
assert.ok(whitelistRule);
assert.equal(whitelistRule.id, getDeterministicSessionRuleId('whitelist', 'white.example.com'));
assert.equal(whitelistRule.priority, SESSION_RULE_PRIORITY);
assert.equal(whitelistRule.action.type, 'allowAllRequests');
assert.deepEqual(whitelistRule.condition.requestDomains, ['white.example.com']);

// Session sync payload should remove stale IDs and add only new rules.
const sync = buildPerSiteSessionRuleSync(
  {
    pausedHosts: ['remove.example.com'],
    whitelistedHosts: ['keep.example.com'],
  },
  {
    pausedHosts: ['add.example.com'],
    whitelistedHosts: ['keep.example.com'],
  },
);
assert.deepEqual(sync.removeRuleIds, [getDeterministicSessionRuleId('paused', 'remove.example.com')]);
assert.equal(sync.addRules.length, 1);
assert.equal(sync.addRules[0].id, getDeterministicSessionRuleId('paused', 'add.example.com'));
assert.equal(sync.addRules[0].priority, SESSION_RULE_PRIORITY);
assert.equal(sync.addRules[0].action.type, 'allowAllRequests');
assert.deepEqual(sync.addRules[0].condition.requestDomains, ['add.example.com']);

// Popup host-controls pure model states.
assert.equal(
  buildPopupHostControlsModel({
    activeTabUrl: 'https://news.example.com/article',
    globalEnabled: true,
    pausedHosts: [],
    whitelistedHosts: [],
  }).state,
  'normal',
);
assert.equal(
  buildPopupHostControlsModel({
    activeTabUrl: 'https://news.example.com/article',
    globalEnabled: true,
    pausedHosts: ['news.example.com'],
    whitelistedHosts: [],
  }).state,
  'paused',
);
assert.equal(
  buildPopupHostControlsModel({
    activeTabUrl: 'https://news.example.com/article',
    globalEnabled: true,
    pausedHosts: [],
    whitelistedHosts: ['news.example.com'],
  }).state,
  'whitelisted',
);
assert.equal(
  buildPopupHostControlsModel({
    activeTabUrl: 'chrome://extensions',
    globalEnabled: true,
    pausedHosts: [],
    whitelistedHosts: [],
  }).state,
  'unsupported-url',
);
assert.equal(
  buildPopupHostControlsModel({
    activeTabUrl: 'https://news.example.com/article',
    globalEnabled: false,
    pausedHosts: ['news.example.com'],
    whitelistedHosts: ['news.example.com'],
  }).state,
  'global-off',
);

console.log('per-site pause + whitelist feature tests passed');
