import { CosmeticFilterEntry } from '../types/cosmetic';

export function parseCosmeticFilterLine(line: string): CosmeticFilterEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('!')) {
    return null;
  }

  const isException = trimmed.includes('#@#');
  const marker = isException ? '#@#' : '##';

  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const domainSpec = trimmed.slice(0, markerIndex).trim();
  const selector = trimmed.slice(markerIndex + marker.length).trim();
  if (!selector) {
    return null;
  }

  const domains = parseDomainSpec(domainSpec);

  return {
    domains,
    selector,
    isException
  };
}

function parseDomainSpec(spec: string): string[] | null {
  if (!spec) {
    return null;
  }

  const domains = spec
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token && !token.startsWith('~'))
    .map((token) => sanitizeDomain(token))
    .filter((token): token is string => Boolean(token));

  return domains.length ? domains : null;
}

function sanitizeDomain(input: string): string | null {
  const normalized = input.replace(/^\*\./, '').replace(/^\./, '').toLowerCase();
  if (!normalized || normalized.includes(' ') || normalized.includes('/')) {
    return null;
  }

  return normalized;
}
