import assert from 'node:assert/strict';

import {
  compileNetworkRuleAst,
  parseEasylistLine,
  parseEasylistNetworkRuleAst,
  tokenizeEasylistNetworkRule,
} from '../src/parser/easylist';

const tokenized = tokenizeEasylistNetworkRule(
  '@@||cdn.example.com^$script,third-party,domain=foo.com|~bar.com,match-case,important,unknown',
);
assert.ok(tokenized, 'Expected tokenized rule');
assert.equal(tokenized.isException, true);
assert.equal(tokenized.rulePart, '||cdn.example.com^');
assert.deepEqual(tokenized.modifierTokens, [
  'script',
  'third-party',
  'domain=foo.com|~bar.com',
  'match-case',
  'important',
  'unknown',
]);

const ast = parseEasylistNetworkRuleAst(tokenized);
assert.ok(ast, 'Expected parsed AST');
assert.equal(ast.isException, true);
assert.equal(ast.pattern.kind, 'domain');
assert.equal(ast.pattern.raw, 'cdn.example.com^');
assert.equal(ast.modifiers.some((modifier) => modifier.kind === 'resourceType' && modifier.value === 'script'), true);
assert.equal(ast.modifiers.some((modifier) => modifier.kind === 'domainType' && modifier.value === 'thirdParty'), true);
assert.equal(ast.modifiers.some((modifier) => modifier.kind === 'initiatorDomain' && modifier.value === 'foo.com'), true);
assert.equal(ast.modifiers.some((modifier) => modifier.kind === 'matchCase'), true);
assert.equal(ast.modifiers.some((modifier) => modifier.kind === 'important'), true);
assert.equal(
  ast.modifiers.some(
    (modifier) => modifier.kind === 'initiatorDomain' && modifier.value === 'bar.com' && modifier.excluded,
  ),
  true,
);
assert.equal(ast.modifiers.some((modifier) => modifier.kind === 'unknown' && modifier.raw === 'unknown'), true);

const compiled = compileNetworkRuleAst(ast);
assert.equal(compiled.action.type, 'allow');
assert.equal(compiled.priority, 2);
assert.equal(compiled.condition.urlFilter, '*://*.cdn.example.com^');
assert.equal(compiled.condition.isUrlFilterCaseSensitive, true);
assert.deepEqual(compiled.condition.resourceTypes, ['script']);
assert.equal(compiled.condition.domainType, 'thirdParty');
assert.deepEqual(compiled.condition.initiatorDomains, ['foo.com']);
assert.deepEqual(compiled.condition.excludedInitiatorDomains, ['bar.com']);

const direct = parseEasylistLine('||ads.example.com^$script,~image,domain=foo.com|~bar.com');
assert.ok(direct, 'Expected direct parser output');

const stagedTokenized = tokenizeEasylistNetworkRule('||ads.example.com^$script,~image,domain=foo.com|~bar.com');
assert.ok(stagedTokenized, 'Expected staged tokenized output');
const stagedAst = parseEasylistNetworkRuleAst(stagedTokenized);
assert.ok(stagedAst, 'Expected staged AST');
const stagedCompiled = compileNetworkRuleAst(stagedAst);

assert.deepEqual(stagedCompiled, direct);

const aliasRule = parseEasylistLine('||ads.example.com^$3p,beacon,all,~script');
assert.ok(aliasRule, 'Expected alias network modifiers to compile');
assert.equal(aliasRule.condition.domainType, 'thirdParty');
assert.ok(aliasRule.condition.resourceTypes?.includes('ping'));
assert.equal(aliasRule.condition.resourceTypes?.includes('script'), false);
assert.ok(aliasRule.condition.resourceTypes?.includes('main_frame'));

const suppressedTokenized = tokenizeEasylistNetworkRule('@@||googleads.g.doubleclick.net/pagead^$script');
assert.ok(suppressedTokenized, 'Expected tokenized suppressed exception');
assert.equal(parseEasylistNetworkRuleAst(suppressedTokenized), null);

console.log('network rule AST stage checks passed');
