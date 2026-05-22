import { SOURCES } from '../config/sources';
import fs from 'fs';
import path from 'path';
import { DnrRule } from '../types/dnr';
import { CosmeticFilterEntry } from '../types/cosmetic';
import { parseEasylistLine } from '../parser/easylist';
import { parseCosmeticFilterLine } from '../parser/cosmetic';
import { createNetworkInstrumentationObserver, NetworkUnsupportedSummary } from '../parser/network-instrumentation';
import { fetchText } from '../utils/http';
import { clearDir, ensureDir } from '../utils/fs';
import { DIST_DIR, RULES_DIR, TRACKING_DEFAULT_RESOURCE_TYPES } from '../config/constants';
import { writeRuleset, GeneratedRuleset } from '../build/writeRules';
import { generateManifest } from '../build/generateManifest';
import { writeCosmeticRules } from '../build/writeCosmeticRules';
import { copyRuntimeAssets } from '../build/copyRuntimeAssets';

// Compatibility-first default for list-derived rules: when a rule has no
// explicit resource-type modifier, do not block scripts by default. This avoids
// blank-page regressions when a site initialises through third-party SDKs with
// generic host/path rules (e.g. */gpt.js, *.kueezrtb.com, *.script.ac).
//
// Script blocking still applies when list rules explicitly include $script.
const NON_SCRIPT_DEFAULT_GROUPS = new Set(['ads', 'tracking', 'annoyances', 'social']);

export async function buildExtension(): Promise<void> {
  clearDir(DIST_DIR);
  ensureDir(RULES_DIR);

  let globalId = 1;
  const allRuleResources: GeneratedRuleset[] = [];
  const cosmeticEntries: CosmeticFilterEntry[] = [];
  const instrumentation = createNetworkInstrumentationObserver();

  for (const [groupName, source] of Object.entries(SOURCES)) {
    console.log(`\nFetching ${groupName}...`);

    const text = await fetchText(source.url, source.trustedHosts);
    const lines = text.split('\n');

    const rules: DnrRule[] = [];

    const parseOptions = NON_SCRIPT_DEFAULT_GROUPS.has(groupName)
      ? { defaultResourceTypes: TRACKING_DEFAULT_RESOURCE_TYPES }
      : undefined;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      const cosmetic = parseCosmeticFilterLine(line);
      if (cosmetic) {
        cosmeticEntries.push(cosmetic);
      }

      const parsed = parseEasylistLine(line, instrumentation.observer, parseOptions);
      if (!parsed) {
        continue;
      }

      rules.push({
        id: globalId++,
        ...parsed,
      });
    }

    console.log(`Parsed ${rules.length} rules for ${groupName}`);

    const resources = writeRuleset(groupName, rules);
    allRuleResources.push(...resources);
  }

  // ─── YouTube hard endpoint block rules ─────────────────────────────
  // These are high-priority static rules for YouTube ad/telemetry endpoints
  // that must be blocked regardless of EasyList allow-rules.
  const youtubeAdRules: DnrRule[] = [
    '/api/stats/ads',
    '/pagead/',
    '/adview',
    '/ptracking',
    '/get_midroll_',
    '/youtubei/v1/player/ad_break',
    '/api/stats/qoe?*adformat',
    '/generate_204?*ad_',
    '/youtubei/v1/log_event?*adPlacements',
  ].map((path, i) => ({
    id: globalId++,
    priority: 3, // Higher than both block (2) and allow (1)
    action: { type: 'block' as const },
    condition: {
      urlFilter: `*://*.youtube.com${path}`,
      resourceTypes: ['xmlhttprequest', 'image', 'media', 'ping', 'other', 'script'],
    },
  }));

  // Also block known ad-serving domains at highest priority
  const adInfraRules: DnrRule[] = [
    '*://*.doubleclick.net/*',
    '*://*.googlesyndication.com/*',
    '*://*.googleadservices.com/*',
    '*://*.google-analytics.com/collect*',
    '*://*.youtube.com/api/stats/ads*',
  ].map((urlFilter, i) => ({
    id: globalId++,
    priority: 3,
    action: { type: 'block' as const },
    condition: {
      urlFilter,
      resourceTypes: ['script', 'image', 'xmlhttprequest', 'sub_frame', 'ping', 'media', 'other'],
    },
  }));

  const ytRules = [...youtubeAdRules, ...adInfraRules];
  const ytResources = writeRuleset('youtube_ads', ytRules);
  allRuleResources.push(...ytResources);

  console.log(`Added ${ytRules.length} YouTube/ad-infra hard-block rules`);

  // ─── Custom YouTube cosmetic selectors ─────────────────────────────
  const YOUTUBE_CUSTOM_COSMETIC: CosmeticFilterEntry[] = [
    'ytd-compact-promoted-item-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-sparkles-text-search-renderer',
    'ytd-display-ad-renderer',
    'ytd-banner-promo-renderer',
    'ytd-statement-banner-renderer',
    '#player-ads.ytd-watch-flexy',
    'ytd-in-feed-ad-layout-renderer',
  ].map((selector) => ({ kind: 'css-selector' as const, selector, domains: ['youtube.com'], isException: false }));

  cosmeticEntries.push(...YOUTUBE_CUSTOM_COSMETIC);

  const CURATED_RUNTIME_SCRIPTLETS: CosmeticFilterEntry[] = [
    { kind: 'scriptlet', invocation: '+js(adsLoaded)', name: 'adsLoaded', args: [], domains: null, isException: false },
    { kind: 'scriptlet', invocation: '+js(canRunAds)', name: 'canRunAds', args: [], domains: null, isException: false },
    {
      kind: 'scriptlet',
      invocation: '+js(blockAdBlock)',
      name: 'blockAdBlock',
      args: [],
      domains: null,
      isException: false,
    },
    {
      kind: 'scriptlet',
      invocation: '+js(fuckAdBlock)',
      name: 'fuckAdBlock',
      args: [],
      domains: null,
      isException: false,
    },
  ];

  cosmeticEntries.push(...CURATED_RUNTIME_SCRIPTLETS);

  writeCosmeticRules(cosmeticEntries);
  copyRuntimeAssets();
  generateManifest(allRuleResources);
  const unsupportedSummary = instrumentation.getSummary();
  writeUnsupportedSummaryMetadata(unsupportedSummary);
  printUnsupportedSummary(unsupportedSummary);

  console.log('\nBuild complete. Load the unpacked extension from dist/.');
}

function writeUnsupportedSummaryMetadata(summary: NetworkUnsupportedSummary): void {
  const outputPath = path.join(DIST_DIR, 'network-unsupported-summary.json');
  fs.writeFileSync(
    outputPath,
    JSON.stringify({
      hasUnsupportedEntries: Boolean(Object.keys(summary.rules).length || Object.keys(summary.modifiers).length),
      summary,
    }),
  );
}

function printUnsupportedSummary(summary: NetworkUnsupportedSummary): void {
  const ruleEntries = Object.entries(summary.rules);
  const modifierEntries = Object.entries(summary.modifiers);
  if (!ruleEntries.length && !modifierEntries.length) {
    return;
  }

  console.log('\nNetwork parser unsupported summary:');
  if (ruleEntries.length) {
    console.log('  Rules skipped by reason:');
    for (const [reason, count] of ruleEntries) {
      console.log(`    - ${reason}: ${count}`);
    }
  }

  if (modifierEntries.length) {
    console.log('  Modifier issues:');
    for (const [key, count] of modifierEntries) {
      console.log(`    - ${key}: ${count}`);
    }
  }
}
