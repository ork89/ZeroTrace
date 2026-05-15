import { DnrDomainType } from './dnr';

export type NetworkRulePatternKind = 'domain' | 'anchoredHttp' | 'leftAnchored' | 'path' | 'substring';

export type NetworkRulePatternAst = {
  kind: NetworkRulePatternKind;
  raw: string;
};

export type NetworkRuleModifierAst =
  | {
      kind: 'domainType';
      value: DnrDomainType;
      raw: string;
    }
  | {
      kind: 'resourceType';
      value: string;
      excluded: boolean;
      raw: string;
    }
  | {
      kind: 'initiatorDomain';
      value: string;
      excluded: boolean;
      raw: string;
    }
  | {
      kind: 'allResourceTypes';
      raw: string;
    }
  | {
      kind: 'important';
      raw: string;
    }
  | {
      kind: 'matchCase';
      raw: string;
    }
  | {
      kind: 'unknown';
      raw: string;
    };

export type NetworkRuleAst = {
  isException: boolean;
  pattern: NetworkRulePatternAst;
  modifiers: NetworkRuleModifierAst[];
};

export type TokenizedNetworkRule = {
  original: string;
  isException: boolean;
  rulePart: string;
  modifierTokens: string[];
};
