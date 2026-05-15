export type CosmeticFilterBase = {
  domains: string[] | null;
  isException: boolean;
};

export type CosmeticSelectorEntry = CosmeticFilterBase & {
  kind: 'css-selector';
  selector: string;
};

export type CosmeticScriptletEntry = CosmeticFilterBase & {
  kind: 'scriptlet';
  invocation: string;
  name: string;
  args: string[];
};

export type CosmeticFilterEntry = CosmeticSelectorEntry | CosmeticScriptletEntry;

export type CosmeticCompiledScriptlet = {
  invocation: string;
  name: string;
  args: string[];
};

export type CosmeticSelectorChunk = Record<string, string[]>;
export type CosmeticScriptletChunk = Record<string, CosmeticCompiledScriptlet[]>;

export type CosmeticSelectorIndex = {
  globalSelectors: string[];
  domainToChunk: Record<string, string>;
};

export type CosmeticScriptletIndex = {
  globalScriptlets: CosmeticCompiledScriptlet[];
  domainToChunk: Record<string, string>;
};

export type CosmeticRulesetIndex = {
  // Legacy selector fields consumed by the current runtime.
  globalSelectors: string[];
  domainToChunk: Record<string, string>;
  // Explicit type-partitioned indexes for future runtime wiring.
  selectors: CosmeticSelectorIndex;
  scriptlets: CosmeticScriptletIndex;
  exceptions: {
    selectors: CosmeticSelectorIndex;
    scriptlets: CosmeticScriptletIndex;
  };
};
