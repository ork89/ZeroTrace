export type DnrActionType = 'block' | 'allow';

export type DnrDomainType = 'firstParty' | 'thirdParty';

export type DnrRule = {
  id: number;
  priority: number;
  action: { type: DnrActionType };
  condition: {
    urlFilter: string;
    resourceTypes?: string[];
    domainType?: DnrDomainType;
    initiatorDomains?: string[];
    excludedInitiatorDomains?: string[];
  };
};

export type DnrRuleWithoutId = Omit<DnrRule, 'id'>;
