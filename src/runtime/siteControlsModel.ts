export type HostControlState = 'normal' | 'paused' | 'whitelisted' | 'unsupported-url' | 'global-off';

export type PerSiteState = {
  pausedHosts: string[];
  whitelistedHosts: string[];
};

export type SessionRuleKind = 'paused' | 'whitelist';

export type SessionAllowRule = {
  id: number;
  priority: number;
  action: { type: 'allowAllRequests' };
  condition: { requestDomains: string[]; resourceTypes?: string[] };
};

export type PopupHostControlsModel = {
  host: string | null;
  state: HostControlState;
};

export const SESSION_RULE_PRIORITY = 10_000;

function normalizeHost(host: string): string | null {
  const normalized = host.trim().toLowerCase().replace(/\.+$/, '');
  return normalized ? normalized : null;
}

function normalizeHostList(hosts: readonly string[]): string[] {
  const out = new Set<string>();

  for (const host of hosts) {
    const normalized = normalizeHost(host);
    if (normalized) {
      out.add(normalized);
    }
  }

  return [...out].sort();
}

export function normalizeHostnameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return null;
    }

    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

export function resolveHostControlState(args: {
  globalEnabled: boolean;
  host: string;
  pausedHosts: readonly string[];
  whitelistedHosts: readonly string[];
}): HostControlState {
  if (!args.globalEnabled) {
    return 'global-off';
  }

  const host = normalizeHost(args.host);
  if (!host) {
    return 'unsupported-url';
  }

  const paused = new Set(normalizeHostList(args.pausedHosts));
  const whitelisted = new Set(normalizeHostList(args.whitelistedHosts));

  if (whitelisted.has(host)) {
    return 'whitelisted';
  }

  if (paused.has(host)) {
    return 'paused';
  }

  return 'normal';
}

export function setHostWhitelisted(state: PerSiteState, host: string): PerSiteState {
  const normalizedHost = normalizeHost(host);
  const paused = new Set(normalizeHostList(state.pausedHosts));
  const whitelisted = new Set(normalizeHostList(state.whitelistedHosts));

  if (!normalizedHost) {
    return {
      pausedHosts: [...paused],
      whitelistedHosts: [...whitelisted],
    };
  }

  paused.delete(normalizedHost);
  whitelisted.add(normalizedHost);

  return {
    pausedHosts: [...paused].sort(),
    whitelistedHosts: [...whitelisted].sort(),
  };
}

export function setHostPaused(state: PerSiteState, host: string): PerSiteState {
  const normalizedHost = normalizeHost(host);
  const paused = new Set(normalizeHostList(state.pausedHosts));
  const whitelisted = new Set(normalizeHostList(state.whitelistedHosts));

  if (!normalizedHost) {
    return {
      pausedHosts: [...paused],
      whitelistedHosts: [...whitelisted],
    };
  }

  whitelisted.delete(normalizedHost);
  paused.add(normalizedHost);

  return {
    pausedHosts: [...paused].sort(),
    whitelistedHosts: [...whitelisted].sort(),
  };
}

export function getDeterministicSessionRuleId(kind: SessionRuleKind, host: string): number {
  const normalizedHost = normalizeHost(host) || host.toLowerCase();
  const input = `${kind}:${normalizedHost}`;
  let hash = 2166136261;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return ((hash >>> 0) % 1_000_000_000) + 1;
}

export function buildPerSiteSessionRules(state: PerSiteState): SessionAllowRule[] {
  const pausedHosts = normalizeHostList(state.pausedHosts);
  const whitelistedHosts = normalizeHostList(state.whitelistedHosts);
  const rules: SessionAllowRule[] = [];

  for (const host of pausedHosts) {
    rules.push({
      id: getDeterministicSessionRuleId('paused', host),
      priority: SESSION_RULE_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [host] },
    });
  }

  for (const host of whitelistedHosts) {
    rules.push({
      id: getDeterministicSessionRuleId('whitelist', host),
      priority: SESSION_RULE_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [host] },
    });
  }

  return rules.sort((a, b) => a.id - b.id);
}

export function buildPerSiteSessionRuleSync(
  previous: PerSiteState,
  next: PerSiteState,
): {
  removeRuleIds: number[];
  addRules: SessionAllowRule[];
} {
  const previousRules = buildPerSiteSessionRules(previous);
  const nextRules = buildPerSiteSessionRules(next);
  const previousRuleIds = new Set(previousRules.map((rule) => rule.id));
  const nextRuleIds = new Set(nextRules.map((rule) => rule.id));

  const removeRuleIds = [...previousRuleIds].filter((id) => !nextRuleIds.has(id)).sort((a, b) => a - b);
  const addRules = nextRules.filter((rule) => !previousRuleIds.has(rule.id));

  return {
    removeRuleIds,
    addRules,
  };
}

export function buildPopupHostControlsModel(args: {
  activeTabUrl: string | null;
  globalEnabled: boolean;
  pausedHosts: readonly string[];
  whitelistedHosts: readonly string[];
}): PopupHostControlsModel {
  const host = args.activeTabUrl ? normalizeHostnameFromUrl(args.activeTabUrl) : null;

  if (!host) {
    return {
      host: null,
      state: 'unsupported-url',
    };
  }

  return {
    host,
    state: resolveHostControlState({
      globalEnabled: args.globalEnabled,
      host,
      pausedHosts: args.pausedHosts,
      whitelistedHosts: args.whitelistedHosts,
    }),
  };
}
