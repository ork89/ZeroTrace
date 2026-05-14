import assert from 'node:assert/strict';

import { parseCosmeticFilterLine } from '../src/parser/cosmetic';

const regular = parseCosmeticFilterLine('howtogeek.com##.ad-zone');
assert.ok(regular);
assert.deepEqual(regular.domains, ['howtogeek.com']);
assert.equal(regular.selector, '.ad-zone');
assert.equal(regular.isException, false);

const exception = parseCosmeticFilterLine('example.com#@#.sponsored');
assert.ok(exception);
assert.deepEqual(exception.domains, ['example.com']);
assert.equal(exception.selector, '.sponsored');
assert.equal(exception.isException, true);

const scriptlet = parseCosmeticFilterLine('howtogeek.com##+js(acs, document.createElement, admiral)');
assert.equal(scriptlet, null);

console.log('cosmetic parser regression checks passed');
