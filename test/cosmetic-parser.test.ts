import assert from 'node:assert/strict';

import { parseCosmeticFilterLine } from '../src/parser/cosmetic';

const regular = parseCosmeticFilterLine('howtogeek.com##.ad-zone');
assert.ok(regular);
assert.equal(regular.kind, 'css-selector');
assert.deepEqual(regular.domains, ['howtogeek.com']);
if (regular.kind === 'css-selector') {
  assert.equal(regular.selector, '.ad-zone');
}
assert.equal(regular.isException, false);

const exception = parseCosmeticFilterLine('example.com#@#.sponsored');
assert.ok(exception);
assert.equal(exception.kind, 'css-selector');
assert.deepEqual(exception.domains, ['example.com']);
if (exception.kind === 'css-selector') {
  assert.equal(exception.selector, '.sponsored');
}
assert.equal(exception.isException, true);

const scriptlet = parseCosmeticFilterLine('howtogeek.com##+js(acs, document.createElement, admiral)');
assert.ok(scriptlet);
assert.equal(scriptlet.kind, 'scriptlet');
if (scriptlet.kind === 'scriptlet') {
  assert.equal(scriptlet.invocation, '+js(acs, document.createElement, admiral)');
  assert.equal(scriptlet.name, 'acs');
  assert.deepEqual(scriptlet.args, ['document.createElement', 'admiral']);
}
assert.deepEqual(scriptlet.domains, ['howtogeek.com']);
assert.equal(scriptlet.isException, false);

const scriptletException = parseCosmeticFilterLine('example.com#@#+js(set, ads, false)');
assert.ok(scriptletException);
assert.equal(scriptletException.kind, 'scriptlet');
if (scriptletException.kind === 'scriptlet') {
  assert.equal(scriptletException.name, 'set');
  assert.deepEqual(scriptletException.args, ['ads', 'false']);
}
assert.equal(scriptletException.isException, true);

console.log('cosmetic parser regression checks passed');
