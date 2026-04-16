import fs from 'fs';
import path from 'path';

import { DIST_DIR } from '../config/constants';
import { CosmeticChunk, CosmeticFilterEntry, CosmeticRulesetIndex } from '../types/cosmetic';

const COSMETIC_CHUNK_DIR = path.join(DIST_DIR, 'cosmetic');
const DOMAINS_PER_CHUNK = 200;

export function writeCosmeticRules(entries: CosmeticFilterEntry[]): void {
  const globalSelectors = new Set<string>();
  const domainSelectors = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (entry.isException) {
      continue;
    }

    if (!entry.domains) {
      globalSelectors.add(entry.selector);
      continue;
    }

    for (const domain of entry.domains) {
      if (!domainSelectors.has(domain)) {
        domainSelectors.set(domain, new Set<string>());
      }

      domainSelectors.get(domain)?.add(entry.selector);
    }
  }

  const domainRecord: Record<string, string[]> = {};
  for (const [domain, selectors] of domainSelectors.entries()) {
    domainRecord[domain] = [...selectors];
  }

  fs.rmSync(COSMETIC_CHUNK_DIR, { recursive: true, force: true });
  fs.mkdirSync(COSMETIC_CHUNK_DIR, { recursive: true });

  const domains = Object.keys(domainRecord).sort();
  const chunkCount = Math.ceil(domains.length / DOMAINS_PER_CHUNK);
  const domainToChunk: Record<string, string> = {};

  for (let i = 0; i < chunkCount; i += 1) {
    const chunkDomains = domains.slice(i * DOMAINS_PER_CHUNK, (i + 1) * DOMAINS_PER_CHUNK);
    const fileName = `chunk-${i + 1}.json`;
    const chunkPayload: CosmeticChunk = {};

    for (const domain of chunkDomains) {
      chunkPayload[domain] = domainRecord[domain];
      domainToChunk[domain] = fileName;
    }

    const chunkPath = path.join(COSMETIC_CHUNK_DIR, fileName);
    fs.writeFileSync(chunkPath, JSON.stringify(chunkPayload));
  }

  const payload: CosmeticRulesetIndex = {
    globalSelectors: [...globalSelectors],
    domainToChunk
  };

  const outputPath = path.join(DIST_DIR, 'cosmetic-rules.json');
  fs.writeFileSync(outputPath, JSON.stringify(payload));

  console.log(
    `✔ cosmetic-rules.json (${payload.globalSelectors.length} global selectors, ${domains.length} domains, ${chunkCount} chunks)`
  );
}
