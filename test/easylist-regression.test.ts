import assert from 'node:assert/strict';

import { parseEasylistLine } from '../src/parser/easylist';

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

console.log('easylist parser regression checks passed');
