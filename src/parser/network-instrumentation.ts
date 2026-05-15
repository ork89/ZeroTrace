export type NetworkRuleSkipReason =
  | 'ignored-empty'
  | 'ignored-comment'
  | 'ignored-cosmetic'
  | 'ignored-procedural-cosmetic'
  | 'suppressed-exception-host'
  | 'unsupported-pattern';

export type NetworkModifierIssueReason = 'unsupported-modifier' | 'unknown-modifier' | 'invalid-domain-token';

export type NetworkInstrumentationCategory = 'rules' | 'modifiers';

export type NetworkUnsupportedSummary = {
  rules: Record<string, number>;
  modifiers: Record<string, number>;
};

export type NetworkInstrumentationObserver = {
  onRuleSkipped: (reason: NetworkRuleSkipReason) => void;
  onModifierIssue: (reason: NetworkModifierIssueReason, token: string) => void;
};

export function createNetworkInstrumentationObserver(): {
  observer: NetworkInstrumentationObserver;
  getSummary: () => NetworkUnsupportedSummary;
} {
  const rules = new Map<string, number>();
  const modifiers = new Map<string, number>();

  return {
    observer: {
      onRuleSkipped(reason) {
        increment(rules, reason);
      },
      onModifierIssue(reason, _token) {
        increment(modifiers, reason);
      },
    },
    getSummary() {
      return {
        rules: mapToRecord(rules),
        modifiers: mapToRecord(modifiers),
      };
    },
  };
}

function increment(bucket: Map<string, number>, key: string): void {
  bucket.set(key, (bucket.get(key) || 0) + 1);
}

function mapToRecord(bucket: Map<string, number>): Record<string, number> {
  return [...bucket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce<Record<string, number>>((record, [key, count]) => {
      record[key] = count;
      return record;
    }, {});
}
