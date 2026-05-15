import fs from 'fs';
import path from 'path';

import { DIST_DIR } from '../config/constants';
import {
  CosmeticCompiledScriptlet,
  CosmeticFilterEntry,
  CosmeticRulesetIndex,
  CosmeticScriptletChunk,
  CosmeticScriptletIndex,
  CosmeticSelectorChunk,
  CosmeticSelectorIndex,
} from '../types/cosmetic';

const COSMETIC_CHUNK_DIR = path.join(DIST_DIR, 'cosmetic');
const DOMAINS_PER_CHUNK = 200;

export function writeCosmeticRules(entries: CosmeticFilterEntry[]): void {
  const selectors = createSelectorAccumulator();
  const selectorExceptions = createSelectorAccumulator();
  const scriptlets = createScriptletAccumulator();
  const scriptletExceptions = createScriptletAccumulator();

  for (const entry of entries) {
    if (entry.kind === 'css-selector') {
      const target = entry.isException ? selectorExceptions : selectors;
      pushSelector(target, entry.domains, entry.selector);
      continue;
    }

    const target = entry.isException ? scriptletExceptions : scriptlets;
    pushScriptlet(target, entry.domains, {
      invocation: entry.invocation,
      name: entry.name,
      args: entry.args,
    });
  }

  fs.rmSync(COSMETIC_CHUNK_DIR, { recursive: true, force: true });
  fs.mkdirSync(COSMETIC_CHUNK_DIR, { recursive: true });

  const selectorIndex = writeSelectorPartition(selectors, 'chunk');
  const scriptletIndex = writeScriptletPartition(scriptlets, 'scriptlets-chunk');
  const selectorExceptionIndex = writeSelectorPartition(selectorExceptions, 'selector-exceptions-chunk');
  const scriptletExceptionIndex = writeScriptletPartition(scriptletExceptions, 'scriptlet-exceptions-chunk');

  const payload: CosmeticRulesetIndex = {
    // Legacy fields kept for current runtime selector consumption.
    globalSelectors: selectorIndex.globalSelectors,
    domainToChunk: selectorIndex.domainToChunk,
    selectors: selectorIndex,
    scriptlets: scriptletIndex,
    exceptions: {
      selectors: selectorExceptionIndex,
      scriptlets: scriptletExceptionIndex,
    },
  };

  const outputPath = path.join(DIST_DIR, 'cosmetic-rules.json');
  fs.writeFileSync(outputPath, JSON.stringify(payload));

  console.log(
    `✔ cosmetic-rules.json (${selectorIndex.globalSelectors.length} global selectors, ${Object.keys(selectorIndex.domainToChunk).length} selector domains, ${Object.keys(scriptletIndex.domainToChunk).length} scriptlet domains)`
  );
}

function createSelectorAccumulator(): {
  global: Set<string>;
  domains: Map<string, Set<string>>;
} {
  return {
    global: new Set<string>(),
    domains: new Map<string, Set<string>>(),
  };
}

function createScriptletAccumulator(): {
  global: Map<string, CosmeticCompiledScriptlet>;
  domains: Map<string, Map<string, CosmeticCompiledScriptlet>>;
} {
  return {
    global: new Map<string, CosmeticCompiledScriptlet>(),
    domains: new Map<string, Map<string, CosmeticCompiledScriptlet>>(),
  };
}

function pushSelector(
  bucket: ReturnType<typeof createSelectorAccumulator>,
  domains: string[] | null,
  selector: string,
): void {
  if (!domains) {
    bucket.global.add(selector);
    return;
  }

  for (const domain of domains) {
    if (!bucket.domains.has(domain)) {
      bucket.domains.set(domain, new Set<string>());
    }

    bucket.domains.get(domain)?.add(selector);
  }
}

function scriptletKey(scriptlet: CosmeticCompiledScriptlet): string {
  return scriptlet.invocation;
}

function pushScriptlet(
  bucket: ReturnType<typeof createScriptletAccumulator>,
  domains: string[] | null,
  scriptlet: CosmeticCompiledScriptlet,
): void {
  const key = scriptletKey(scriptlet);
  if (!domains) {
    bucket.global.set(key, scriptlet);
    return;
  }

  for (const domain of domains) {
    if (!bucket.domains.has(domain)) {
      bucket.domains.set(domain, new Map<string, CosmeticCompiledScriptlet>());
    }

    bucket.domains.get(domain)?.set(key, scriptlet);
  }
}

function sortScriptlets(scriptlets: CosmeticCompiledScriptlet[]): CosmeticCompiledScriptlet[] {
  return [...scriptlets].sort((a, b) => a.invocation.localeCompare(b.invocation));
}

function writeSelectorPartition(
  accumulator: ReturnType<typeof createSelectorAccumulator>,
  filePrefix: string,
): CosmeticSelectorIndex {
  const domainRecord: CosmeticSelectorChunk = {};
  for (const [domain, selectors] of accumulator.domains.entries()) {
    domainRecord[domain] = [...selectors].sort();
  }

  const chunkResult = writeDomainChunks(domainRecord, filePrefix);
  return {
    globalSelectors: [...accumulator.global].sort(),
    domainToChunk: chunkResult.domainToChunk,
  };
}

function writeScriptletPartition(
  accumulator: ReturnType<typeof createScriptletAccumulator>,
  filePrefix: string,
): CosmeticScriptletIndex {
  const domainRecord: CosmeticScriptletChunk = {};
  for (const [domain, scriptletMap] of accumulator.domains.entries()) {
    domainRecord[domain] = sortScriptlets([...scriptletMap.values()]);
  }

  const chunkResult = writeDomainChunks(domainRecord, filePrefix);
  return {
    globalScriptlets: sortScriptlets([...accumulator.global.values()]),
    domainToChunk: chunkResult.domainToChunk,
  };
}

function writeDomainChunks<T extends string[] | CosmeticCompiledScriptlet[]>(
  domainRecord: Record<string, T>,
  filePrefix: string,
): {
  domainToChunk: Record<string, string>;
  chunkCount: number;
} {
  const domains = Object.keys(domainRecord).sort();
  const chunkCount = Math.ceil(domains.length / DOMAINS_PER_CHUNK);
  const domainToChunk: Record<string, string> = {};

  for (let i = 0; i < chunkCount; i += 1) {
    const chunkDomains = domains.slice(i * DOMAINS_PER_CHUNK, (i + 1) * DOMAINS_PER_CHUNK);
    const fileName = `${filePrefix}-${i + 1}.json`;
    const chunkPayload: Record<string, T> = {};

    for (const domain of chunkDomains) {
      chunkPayload[domain] = domainRecord[domain];
      domainToChunk[domain] = fileName;
    }

    const chunkPath = path.join(COSMETIC_CHUNK_DIR, fileName);
    fs.writeFileSync(chunkPath, JSON.stringify(chunkPayload));
  }

  return { domainToChunk, chunkCount };
}
