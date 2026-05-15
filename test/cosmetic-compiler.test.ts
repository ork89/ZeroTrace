import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { writeCosmeticRules } from '../src/build/writeCosmeticRules';
import { CosmeticFilterEntry, CosmeticRulesetIndex } from '../src/types/cosmetic';

const distDir = path.resolve('./dist');
const cosmeticDir = path.join(distDir, 'cosmetic');
const rulesPath = path.join(distDir, 'cosmetic-rules.json');

const entries: CosmeticFilterEntry[] = [
  { kind: 'css-selector', selector: '.global-ad', domains: null, isException: false },
  { kind: 'css-selector', selector: '.global-banner', domains: null, isException: false },
  { kind: 'css-selector', selector: '.example-ad', domains: ['example.com'], isException: false },
  { kind: 'css-selector', selector: '.news-ad', domains: ['news.example.com'], isException: false },
  { kind: 'css-selector', selector: '.allow-this', domains: ['example.com'], isException: true },
  { kind: 'css-selector', selector: '.allow-global', domains: null, isException: true },
  {
    kind: 'scriptlet',
    invocation: '+js(set, ads, false)',
    name: 'set',
    args: ['ads', 'false'],
    domains: ['example.com'],
    isException: false,
  },
  {
    kind: 'scriptlet',
    invocation: '+js(abort-current-inline-script, Math, adblock)',
    name: 'abort-current-inline-script',
    args: ['Math', 'adblock'],
    domains: null,
    isException: false,
  },
  {
    kind: 'scriptlet',
    invocation: '+js(set, ads, true)',
    name: 'set',
    args: ['ads', 'true'],
    domains: ['example.com'],
    isException: true,
  },
];

writeCosmeticRules(entries);

const index = JSON.parse(fs.readFileSync(rulesPath, 'utf8')) as CosmeticRulesetIndex;

// Legacy selector runtime contract remains stable.
assert.deepEqual(index.globalSelectors, ['.global-ad', '.global-banner']);
assert.deepEqual(index.domainToChunk, { 'example.com': 'chunk-1.json', 'news.example.com': 'chunk-1.json' });

// New partitioned shape is emitted for future runtime wiring.
assert.deepEqual(index.selectors.globalSelectors, ['.global-ad', '.global-banner']);
assert.equal(index.selectors.domainToChunk['example.com'], 'chunk-1.json');
assert.equal(index.scriptlets.domainToChunk['example.com'], 'scriptlets-chunk-1.json');
assert.equal(index.exceptions.selectors.domainToChunk['example.com'], 'selector-exceptions-chunk-1.json');
assert.equal(index.exceptions.scriptlets.domainToChunk['example.com'], 'scriptlet-exceptions-chunk-1.json');
assert.deepEqual(index.scriptlets.globalScriptlets, [
  {
    invocation: '+js(abort-current-inline-script, Math, adblock)',
    name: 'abort-current-inline-script',
    args: ['Math', 'adblock'],
  },
]);
assert.deepEqual(index.exceptions.selectors.globalSelectors, ['.allow-global']);

const selectorChunk = JSON.parse(
  fs.readFileSync(path.join(cosmeticDir, 'chunk-1.json'), 'utf8'),
) as Record<string, string[]>;
assert.deepEqual(selectorChunk['example.com'], ['.example-ad']);
assert.deepEqual(selectorChunk['news.example.com'], ['.news-ad']);

const scriptletChunk = JSON.parse(
  fs.readFileSync(path.join(cosmeticDir, 'scriptlets-chunk-1.json'), 'utf8'),
) as Record<string, Array<{ invocation: string; name: string; args: string[] }>>;
assert.deepEqual(scriptletChunk['example.com'], [
  {
    invocation: '+js(set, ads, false)',
    name: 'set',
    args: ['ads', 'false'],
  },
]);

const selectorExceptionChunk = JSON.parse(
  fs.readFileSync(path.join(cosmeticDir, 'selector-exceptions-chunk-1.json'), 'utf8'),
) as Record<string, string[]>;
assert.deepEqual(selectorExceptionChunk['example.com'], ['.allow-this']);

const scriptletExceptionChunk = JSON.parse(
  fs.readFileSync(path.join(cosmeticDir, 'scriptlet-exceptions-chunk-1.json'), 'utf8'),
) as Record<string, Array<{ invocation: string; name: string; args: string[] }>>;
assert.deepEqual(scriptletExceptionChunk['example.com'], [
  {
    invocation: '+js(set, ads, true)',
    name: 'set',
    args: ['ads', 'true'],
  },
]);

console.log('cosmetic compiler partition checks passed');
