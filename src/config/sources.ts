export type SourceConfig = {
  url: string;
  trustedHosts: readonly string[];
};

const EASYLIST_TRUSTED_HOSTS = ['easylist.to'] as const;

export const SOURCES: Record<string, SourceConfig> = {
  ads: {
    url: 'https://easylist.to/easylist/easylist.txt',
    trustedHosts: EASYLIST_TRUSTED_HOSTS,
  },
  tracking: {
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    trustedHosts: EASYLIST_TRUSTED_HOSTS,
  },
  annoyances: {
    url: 'https://easylist.to/easylist/fanboy-annoyance.txt',
    trustedHosts: EASYLIST_TRUSTED_HOSTS,
  },
  social: {
    url: 'https://easylist.to/easylist/fanboy-social.txt',
    trustedHosts: EASYLIST_TRUSTED_HOSTS,
  },
};
