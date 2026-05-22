import { ALL_RESOURCE_TYPES, DEFAULT_RESOURCE_TYPES } from '../config/constants';
import { DnrRuleWithoutId } from '../types/dnr';

export type ParseEasylistOptions = {
  /** Override the resource types applied when a rule has no explicit type modifiers. */
  defaultResourceTypes?: readonly string[];
};
import {
  NetworkRuleAst,
  NetworkRuleModifierAst,
  NetworkRulePatternAst,
  TokenizedNetworkRule,
} from '../types/network-rule';
import {
  NetworkInstrumentationObserver,
  NetworkModifierIssueReason,
  NetworkRuleSkipReason,
} from './network-instrumentation';

// Exception rules for known ad-serving infrastructure that we deliberately ignore.
// EasyList ships allow-rules for these domains to prevent false positives in
// non-ad contexts, but for a strict ad-blocker they must be blocked.
const SUPPRESSED_EXCEPTION_HOSTS = new Set([
  'tpc.googlesyndication.com',
  'googlesyndication.com',
  'pagead2.googlesyndication.com',
  'googleads.g.doubleclick.net',
  'ad.doubleclick.net',
  'static.doubleclick.net',
  'www.googleadservices.com',
  'googleadservices.com',
]);

const RESOURCE_TYPE_MAP: Record<string, string> = {
  document: 'main_frame',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  media: 'media',
  object: 'object',
  xhr: 'xmlhttprequest',
  fetch: 'xmlhttprequest',
  xmlhttprequest: 'xmlhttprequest',
  beacon: 'ping',
  ping: 'ping',
  websocket: 'websocket',
  webtransport: 'webtransport',
  webbundle: 'webbundle',
  'object-subrequest': 'object',
  other: 'other',
};

const UNSUPPORTED_MODIFIER_KEYS = new Set([
  'badfilter',
  'csp',
  'denyallow',
  'header',
  'ipaddress',
  'method',
  'permissions',
  'redirect',
  'redirect-rule',
  'removeheader',
  'removeparam',
  'replace',
  'rewrite',
  'to',
  'urlskip',
  'urltransform',
]);

export function parseEasylistLine(
  line: string,
  observer?: NetworkInstrumentationObserver,
  options?: ParseEasylistOptions,
): DnrRuleWithoutId | null {
  const tokenized = tokenizeEasylistNetworkRule(line, observer);
  if (!tokenized) {
    return null;
  }

  const ast = parseEasylistNetworkRuleAst(tokenized, observer);
  if (!ast) {
    return null;
  }

  return compileNetworkRuleAst(ast, options);
}

export function tokenizeEasylistNetworkRule(
  line: string,
  observer?: NetworkInstrumentationObserver,
): TokenizedNetworkRule | null {
  const skipReason = getIgnorableReason(line);
  if (skipReason) {
    observer?.onRuleSkipped(skipReason);
    return null;
  }

  const isException = line.startsWith('@@');
  const clean = isException ? line.slice(2) : line;
  const [rulePart, modifierPart] = clean.split('$');
  const normalizedRulePart = rulePart.trim();
  const modifierTokens = modifierPart
    ? modifierPart
        .split(',')
        .map((modifier) => modifier.trim())
        .filter(Boolean)
    : [];

  return {
    original: line,
    isException,
    rulePart: normalizedRulePart,
    modifierTokens,
  };
}

export function parseEasylistNetworkRuleAst(
  tokenized: TokenizedNetworkRule,
  observer?: NetworkInstrumentationObserver,
): NetworkRuleAst | null {
  if (tokenized.isException && isSuppressedExceptionHost(tokenized.rulePart)) {
    observer?.onRuleSkipped('suppressed-exception-host');
    return null;
  }

  const pattern = parsePattern(tokenized.rulePart);
  if (!pattern) {
    observer?.onRuleSkipped('unsupported-pattern');
    return null;
  }

  return {
    isException: tokenized.isException,
    pattern,
    modifiers: parseModifierAst(tokenized.modifierTokens, observer),
  };
}

export function compileNetworkRuleAst(ast: NetworkRuleAst, options?: ParseEasylistOptions): DnrRuleWithoutId {
  const includeResourceTypes = new Set<string>();
  const excludedResourceTypes = new Set<string>();
  const initiatorDomains = new Set<string>();
  const excludedInitiatorDomains = new Set<string>();
  let domainType: 'firstParty' | 'thirdParty' | undefined;
  let forceAllResourceTypes = false;
  let isImportant = false;
  let caseSensitive = false;

  for (const modifier of ast.modifiers) {
    if (modifier.kind === 'domainType') {
      domainType = modifier.value;
      continue;
    }

    if (modifier.kind === 'resourceType') {
      if (modifier.excluded) {
        excludedResourceTypes.add(modifier.value);
      } else {
        includeResourceTypes.add(modifier.value);
      }
      continue;
    }

    if (modifier.kind === 'allResourceTypes') {
      forceAllResourceTypes = true;
      continue;
    }

    if (modifier.kind === 'important') {
      isImportant = true;
      continue;
    }

    if (modifier.kind === 'matchCase') {
      caseSensitive = true;
      continue;
    }

    if (modifier.kind === 'initiatorDomain') {
      if (modifier.excluded) {
        excludedInitiatorDomains.add(modifier.value);
      } else {
        initiatorDomains.add(modifier.value);
      }
    }
  }

  return {
    priority: resolvePriority(ast.isException, isImportant),
    action: { type: ast.isException ? 'allow' : 'block' },
    condition: {
      urlFilter: compilePattern(ast.pattern),
      isUrlFilterCaseSensitive: caseSensitive || undefined,
      resourceTypes: resolveResourceTypes(
        includeResourceTypes,
        excludedResourceTypes,
        forceAllResourceTypes,
        options?.defaultResourceTypes,
      ),
      domainType,
      initiatorDomains: initiatorDomains.size ? [...initiatorDomains] : undefined,
      excludedInitiatorDomains: excludedInitiatorDomains.size ? [...excludedInitiatorDomains] : undefined,
    },
  };
}

function getIgnorableReason(line: string): NetworkRuleSkipReason | null {
  if (!line) {
    return 'ignored-empty';
  }

  if (line.startsWith('!')) {
    return 'ignored-comment';
  }

  if (line.includes('#?#')) {
    return 'ignored-procedural-cosmetic';
  }

  if (line.includes('##') || line.includes('#@#')) {
    return 'ignored-cosmetic';
  }

  return null;
}

function parseModifierAst(modifiers: string[], observer?: NetworkInstrumentationObserver): NetworkRuleModifierAst[] {
  const parsed: NetworkRuleModifierAst[] = [];

  for (const modifier of modifiers) {
    const lowerModifier = modifier.toLowerCase();

    if (lowerModifier === 'third-party' || lowerModifier === '3p') {
      parsed.push({ kind: 'domainType', value: 'thirdParty', raw: modifier });
      continue;
    }

    if (
      lowerModifier === '~third-party' ||
      lowerModifier === '~3p' ||
      lowerModifier === 'first-party' ||
      lowerModifier === '1p'
    ) {
      parsed.push({ kind: 'domainType', value: 'firstParty', raw: modifier });
      continue;
    }

    if (lowerModifier === 'match-case') {
      parsed.push({ kind: 'matchCase', raw: modifier });
      continue;
    }

    if (lowerModifier === 'important') {
      parsed.push({ kind: 'important', raw: modifier });
      continue;
    }

    if (lowerModifier === 'all') {
      parsed.push({ kind: 'allResourceTypes', raw: modifier });
      continue;
    }

    if (lowerModifier.startsWith('domain=')) {
      parseDomainModifier(modifier.slice('domain='.length), modifier, parsed, observer);
      continue;
    }

    if (lowerModifier.startsWith('~domain=')) {
      observer?.onModifierIssue('unsupported-modifier', modifier);
      parsed.push({ kind: 'unknown', raw: modifier });
      continue;
    }

    const isExcluded = modifier.startsWith('~');
    const normalized = (isExcluded ? modifier.slice(1) : modifier).toLowerCase();
    const resourceType = RESOURCE_TYPE_MAP[normalized];

    if (!resourceType) {
      observer?.onModifierIssue(resolveUnknownModifierReason(normalized), modifier);
      parsed.push({ kind: 'unknown', raw: modifier });
      continue;
    }

    parsed.push({ kind: 'resourceType', value: resourceType, excluded: isExcluded, raw: modifier });
  }

  return parsed;
}

function parseDomainModifier(
  rawValue: string,
  rawModifier: string,
  modifiers: NetworkRuleModifierAst[],
  observer?: NetworkInstrumentationObserver,
): void {
  for (const rawDomain of rawValue.split('|')) {
    const domainToken = rawDomain.trim();
    if (!domainToken) {
      continue;
    }

    const isExcluded = domainToken.startsWith('~');
    const domain = sanitizeDomain(isExcluded ? domainToken.slice(1) : domainToken);
    if (!domain) {
      observer?.onModifierIssue('invalid-domain-token', rawModifier);
      continue;
    }

    modifiers.push({ kind: 'initiatorDomain', value: domain, excluded: isExcluded, raw: rawModifier });
  }
}

function sanitizeDomain(domain: string): string | null {
  const normalized = domain.replace(/^\*\./, '').replace(/^\./, '').toLowerCase();
  if (!normalized || normalized.includes('/') || normalized.includes(' ')) {
    return null;
  }

  return normalized;
}

function resolveResourceTypes(
  includeSet: Set<string>,
  excludeSet: Set<string>,
  forceAll = false,
  defaultTypes: readonly string[] = DEFAULT_RESOURCE_TYPES,
): string[] | undefined {
  const base = forceAll ? [...ALL_RESOURCE_TYPES] : includeSet.size ? [...includeSet] : [...defaultTypes];
  const filtered = base.filter((type) => !excludeSet.has(type));
  if (filtered.length) {
    return filtered;
  }

  const allFiltered = ALL_RESOURCE_TYPES.filter((type) => !excludeSet.has(type));
  if (allFiltered.length) {
    return allFiltered;
  }

  // All known resource types are excluded. Keep condition valid by omitting
  // resourceTypes instead of returning an empty/contradictory fallback array.
  return undefined;
}

function resolveUnknownModifierReason(normalizedModifier: string): NetworkModifierIssueReason {
  const key = normalizedModifier.split('=')[0];
  if (UNSUPPORTED_MODIFIER_KEYS.has(key)) {
    return 'unsupported-modifier';
  }

  return 'unknown-modifier';
}

function resolvePriority(isException: boolean, isImportant: boolean): number {
  if (isImportant) {
    return isException ? 2 : 3;
  }

  return isException ? 1 : 2;
}

function extractHostFromRule(rule: string): string | null {
  if (!rule.startsWith('||')) {
    return null;
  }

  const withoutPrefix = rule.slice(2).toLowerCase();
  const rawHost = withoutPrefix
    .split(/[\/^?|]/)[0]
    ?.replace(/^\*\.?/, '')
    .replace(/^\./, '');

  if (!rawHost) {
    return null;
  }

  const hostWithoutPort = rawHost.includes(':') ? rawHost.split(':')[0] : rawHost;
  return sanitizeDomain(hostWithoutPort || '');
}

function isSuppressedExceptionHost(rule: string): boolean {
  const host = extractHostFromRule(rule);
  if (!host) {
    return false;
  }

  for (const suppressed of SUPPRESSED_EXCEPTION_HOSTS) {
    if (host === suppressed || host.endsWith(`.${suppressed}`)) {
      return true;
    }
  }

  return false;
}

function isSafePlainSubstringRule(rule: string): boolean {
  if (rule.length < 4) {
    return false;
  }

  if (/\s|[\^|*]/.test(rule)) {
    return false;
  }

  return /[./_\-=?]/.test(rule);
}

function isLikelyRegexRule(rule: string): boolean {
  if (!rule.startsWith('/') || !rule.endsWith('/') || rule.length < 3) {
    return false;
  }

  const body = rule.slice(1, -1);
  return /[()[\]{}+?\\]/.test(body);
}

function parsePattern(rule: string): NetworkRulePatternAst | null {
  if (rule.startsWith('||')) {
    return { kind: 'domain', raw: rule.slice(2) };
  }

  if (rule.startsWith('|http')) {
    return { kind: 'anchoredHttp', raw: rule.slice(1) };
  }

  if (rule.startsWith('|')) {
    return { kind: 'leftAnchored', raw: rule.slice(1) };
  }

  if (rule.startsWith('/')) {
    if (isLikelyRegexRule(rule)) {
      return null;
    }
    return { kind: 'path', raw: rule };
  }

  if (!rule.includes('#') && isSafePlainSubstringRule(rule)) {
    return { kind: 'substring', raw: rule };
  }

  return null;
}

function compilePattern(pattern: NetworkRulePatternAst): string {
  if (pattern.kind === 'domain') {
    // Chrome DNR natively supports ^ as a separator match character.
    // Replace || with domain-match prefix, leave ^ intact.
    return '*://*.' + pattern.raw;
  }

  if (pattern.kind === 'anchoredHttp' || pattern.kind === 'leftAnchored') {
    return pattern.raw;
  }

  if (pattern.kind === 'path') {
    return '*' + pattern.raw;
  }

  return '*' + pattern.raw + '*';
}
