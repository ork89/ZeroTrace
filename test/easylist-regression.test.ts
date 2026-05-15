import assert from 'node:assert/strict';

import { parseEasylistLine } from '../src/parser/easylist';
import { createNetworkInstrumentationObserver } from '../src/parser/network-instrumentation';

function expectNull(line: string): void {
  const parsed = parseEasylistLine(line);
  assert.equal(parsed, null, `Expected null for: ${line}`);
}

function expectParsed(line: string): NonNullable<ReturnType<typeof parseEasylistLine>> {
  const parsed = parseEasylistLine(line);
  assert.ok(parsed, `Expected parsed rule for: ${line}`);
  return parsed;
}

// Exception rules for known ad infrastructure should be suppressed, including
// common EasyList separators/path suffixes.
expectNull('@@||tpc.googlesyndication.com^$script');
expectNull('@@||sub.pagead2.googlesyndication.com/path^$image');
expectNull('@@||googleads.g.doubleclick.net/pagead^$script');
expectNull('@@||googleads.g.doubleclick.net:443/pagead^$script');

// Non-suppressed exceptions should still pass through as allow rules.
const allowRule = expectParsed('@@||cdn.example.com^$script');
assert.equal(allowRule.action.type, 'allow');
assert.equal(allowRule.priority, 1);

// Block rules should keep higher priority than allow rules.
const blockRule = expectParsed('||ads.example.com^$script');
assert.equal(blockRule.action.type, 'block');
assert.equal(blockRule.priority, 2);

// Very broad plain tokens should no longer be promoted to wildcard substring
// filters to avoid false positives.
expectNull('ad');
expectNull('abc');

// Structured plain tokens still map to substring urlFilter rules.
const structuredRule = expectParsed('-ad-manager/');
assert.equal(structuredRule.condition.urlFilter, '*-ad-manager/*');

// DNR-compatible high-impact modifiers should compile.
const importantRule = expectParsed('||cdn.example.com^$important,match-case,script');
assert.equal(importantRule.priority, 3);
assert.equal(importantRule.condition.isUrlFilterCaseSensitive, true);

const allTypesRule = expectParsed('||cdn.example.com^$all,~image,beacon');
assert.ok(allTypesRule.condition.resourceTypes?.includes('main_frame'));
assert.equal(allTypesRule.condition.resourceTypes?.includes('image'), false);
assert.ok(allTypesRule.condition.resourceTypes?.includes('ping'));

// Unsupported/unknown modifiers should be tracked deterministically.
const { observer, getSummary } = createNetworkInstrumentationObserver();
expectParsed('||ads.example.com^$script,badfilter,unknownxyz');
expectNull('/regex[0-9]+/$script');
expectNull('example.com##.banner');
parseEasylistLine('||ads.example.com^$domain=foo.com|http://bad domain', observer);
parseEasylistLine('||ads.example.com^$script,badfilter,unknownxyz', observer);
parseEasylistLine('/regex[0-9]+/$script', observer);
parseEasylistLine('example.com##.banner', observer);

const summary = getSummary();
assert.equal(summary.rules['ignored-cosmetic'], 1);
assert.equal(summary.rules['unsupported-pattern'], 1);
assert.equal(summary.modifiers['unsupported-modifier'], 1);
assert.equal(summary.modifiers['unknown-modifier'], 1);
assert.equal(summary.modifiers['invalid-domain-token'], 1);

console.log('easylist parser regression checks passed');
