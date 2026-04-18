import { SOURCES } from '../config/sources';
import { DnrRule } from '../types/dnr';
import { CosmeticFilterEntry } from '../types/cosmetic';
import { parseEasylistLine } from '../parser/easylist';
import { parseCosmeticFilterLine } from '../parser/cosmetic';
import { fetchText } from '../utils/http';
import { clearDir, ensureDir } from '../utils/fs';
import { DIST_DIR, RULES_DIR } from '../config/constants';
import { writeRuleset, GeneratedRuleset } from '../build/writeRules';
import { generateManifest } from '../build/generateManifest';
import { writeCosmeticRules } from '../build/writeCosmeticRules';
import { copyRuntimeAssets } from '../build/copyRuntimeAssets';

export async function buildExtension(): Promise<void> {
  clearDir(DIST_DIR);
  ensureDir(RULES_DIR);

  let globalId = 1;
  const allRuleResources: GeneratedRuleset[] = [];
  const cosmeticEntries: CosmeticFilterEntry[] = [];

  for (const [groupName, url] of Object.entries(SOURCES)) {
    console.log(`\nFetching ${groupName}...`);

    const text = await fetchText(url);
    const lines = text.split('\n');

    const rules: DnrRule[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();

      const cosmetic = parseCosmeticFilterLine(line);
      if (cosmetic) {
        cosmeticEntries.push(cosmetic);
      }

      const parsed = parseEasylistLine(line);
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
  ].map((selector) => ({ selector, domains: ['youtube.com'], isException: false }));

  cosmeticEntries.push(...YOUTUBE_CUSTOM_COSMETIC);

  writeCosmeticRules(cosmeticEntries);
  copyRuntimeAssets();
  generateManifest(allRuleResources);

  console.log('\nBuild complete. Load the unpacked extension from dist/.');
}
