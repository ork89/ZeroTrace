import { ALL_RESOURCE_TYPES, DEFAULT_RESOURCE_TYPES } from '../config/constants';
import { DnrRuleWithoutId } from '../types/dnr';

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

export function parseEasylistLine(line: string): DnrRuleWithoutId | null {
  if (isIgnorable(line)) {
    return null;
  }

  const isException = line.startsWith('@@');
  const clean = isException ? line.slice(2) : line;
  const [rulePart, modifierPart] = clean.split('$');

  const normalizedRulePart = rulePart.trim();

  // Drop exception rules that allow known ad-serving hosts.
  if (isException && isSuppressedExceptionHost(normalizedRulePart)) {
    return null;
  }

  const urlFilter = convertToUrlFilter(normalizedRulePart);
  if (!urlFilter) {
    return null;
  }

  const parsedModifiers = parseModifiers(modifierPart);

  return {
    priority: isException ? 1 : 2,
    action: { type: isException ? 'allow' : 'block' },
    condition: {
      urlFilter,
      ...parsedModifiers,
    },
  };
}

function isIgnorable(line: string): boolean {
  return !line || line.startsWith('!') || line.includes('##') || line.includes('#@#') || line.includes('#?#');
}

function parseModifiers(modifiers?: string): {
  resourceTypes?: string[];
  domainType?: 'firstParty' | 'thirdParty';
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
} {
  if (!modifiers) {
    return { resourceTypes: [...DEFAULT_RESOURCE_TYPES] };
  }

  const resourceTypeMap: Record<string, string> = {
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
    xmlhttprequest: 'xmlhttprequest',
    ping: 'ping',
    websocket: 'websocket',
    webtransport: 'webtransport',
    webbundle: 'webbundle',
    other: 'other',
  };

  const includeResourceTypes = new Set<string>();
  const excludedResourceTypes = new Set<string>();
  const initiatorDomains = new Set<string>();
  const excludedInitiatorDomains = new Set<string>();
  let domainType: 'firstParty' | 'thirdParty' | undefined;

  for (const rawModifier of modifiers.split(',')) {
    const modifier = rawModifier.trim();
    if (!modifier) {
      continue;
    }

    if (modifier === 'third-party') {
      domainType = 'thirdParty';
      continue;
    }

    if (modifier === '~third-party') {
      domainType = 'firstParty';
      continue;
    }

    if (modifier.startsWith('domain=')) {
      parseDomainModifier(modifier.slice('domain='.length), initiatorDomains, excludedInitiatorDomains);
      continue;
    }

    const isExcluded = modifier.startsWith('~');
    const normalized = isExcluded ? modifier.slice(1) : modifier;
    const resourceType = resourceTypeMap[normalized];

    if (!resourceType) {
      continue;
    }

    if (isExcluded) {
      excludedResourceTypes.add(resourceType);
    } else {
      includeResourceTypes.add(resourceType);
    }
  }

  const resolvedResourceTypes = resolveResourceTypes(includeResourceTypes, excludedResourceTypes);

  return {
    resourceTypes: resolvedResourceTypes,
    domainType,
    initiatorDomains: initiatorDomains.size ? [...initiatorDomains] : undefined,
    excludedInitiatorDomains: excludedInitiatorDomains.size ? [...excludedInitiatorDomains] : undefined,
  };
}

function parseDomainModifier(rawValue: string, includeSet: Set<string>, excludeSet: Set<string>): void {
  for (const rawDomain of rawValue.split('|')) {
    const domainToken = rawDomain.trim();
    if (!domainToken) {
      continue;
    }

    const isExcluded = domainToken.startsWith('~');
    const domain = sanitizeDomain(isExcluded ? domainToken.slice(1) : domainToken);
    if (!domain) {
      continue;
    }

    if (isExcluded) {
      excludeSet.add(domain);
    } else {
      includeSet.add(domain);
    }
  }
}

function sanitizeDomain(domain: string): string | null {
  const normalized = domain.replace(/^\*\./, '').replace(/^\./, '').toLowerCase();
  if (!normalized || normalized.includes('/') || normalized.includes(' ')) {
    return null;
  }

  return normalized;
}

function resolveResourceTypes(includeSet: Set<string>, excludeSet: Set<string>): string[] {
  const base = includeSet.size ? [...includeSet] : [...DEFAULT_RESOURCE_TYPES];

  const filtered = base.filter((type) => !excludeSet.has(type));
  if (filtered.length) {
    return filtered;
  }

  const allFiltered = ALL_RESOURCE_TYPES.filter((type) => !excludeSet.has(type));
  return allFiltered.length ? allFiltered : [...DEFAULT_RESOURCE_TYPES];
}

function extractHostFromRule(rule: string): string | null {
  if (!rule.startsWith('||')) {
    return null;
  }

  const withoutPrefix = rule.slice(2).toLowerCase();
  const rawHost = withoutPrefix.split(/[\/^?|]/)[0]?.replace(/^\*\.?/, '').replace(/^\./, '');

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

function convertToUrlFilter(rule: string): string | null {
  if (rule.startsWith('||')) {
    // Chrome DNR natively supports ^ as a separator match character.
    // Replace || with domain-match prefix, leave ^ intact.
    const withoutPrefix = rule.slice(2);
    return '*://*.' + withoutPrefix;
  }

  if (rule.startsWith('|http')) {
    return rule.slice(1);
  }

  if (rule.startsWith('|')) {
    // Left-anchored rule (non-http)
    return rule.slice(1);
  }

  if (rule.startsWith('/')) {
    // Path-only: prefix with * for substring matching
    return '*' + rule;
  }

  // Plain substring filter (e.g. "-ad-manager/", ".ads.controller.js")
  if (!rule.includes('#') && isSafePlainSubstringRule(rule)) {
    return '*' + rule + '*';
  }

  return null;
}
