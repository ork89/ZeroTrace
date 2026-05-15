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

assert.equal(antiAntiAdblockEngine.__test.isProtectedContainerTag('body'), true);
assert.equal(antiAntiAdblockEngine.__test.isProtectedContainerTag('main'), true);
assert.equal(antiAntiAdblockEngine.__test.isProtectedContainerTag('div'), false);

assert.equal(antiAntiAdblockEngine.__test.genericPatternCount > 0, true);

console.log('anti-anti-adblock engine model checks passed');
