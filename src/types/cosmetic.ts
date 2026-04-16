export type CosmeticFilterEntry = {
  domains: string[] | null;
  selector: string;
  isException: boolean;
};

export type CosmeticRulesetIndex = {
  globalSelectors: string[];
  domainToChunk: Record<string, string>;
};

export type CosmeticChunk = Record<string, string[]>;
