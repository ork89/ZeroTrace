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
        ...parsed
      });
    }

    console.log(`Parsed ${rules.length} rules for ${groupName}`);

    const resources = writeRuleset(groupName, rules);
    allRuleResources.push(...resources);
  }

  writeCosmeticRules(cosmeticEntries);
  copyRuntimeAssets();
  generateManifest(allRuleResources);

  console.log('\nBuild complete. Load the unpacked extension from dist/.');
}
