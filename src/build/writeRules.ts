import fs from 'fs';
import path from 'path';

import { MAX_RULES_PER_FILE, RULES_DIR } from '../config/constants';
import { DnrRule } from '../types/dnr';
import { chunk } from '../utils/array';

export type GeneratedRuleset = {
  id: string;
  enabled: boolean;
  path: string;
};

export function writeRuleset(groupName: string, rules: DnrRule[]): GeneratedRuleset[] {
  const ruleChunks = chunk(rules, MAX_RULES_PER_FILE);

  return ruleChunks.map((chunkRules, index) => {
    const fileName = `${groupName}_${index + 1}.json`;
    const filePath = path.join(RULES_DIR, fileName);

    fs.writeFileSync(filePath, JSON.stringify(chunkRules, null, 2));

    console.log(`✔ rules/${fileName} (${chunkRules.length} rules)`);

    return {
      id: `${groupName}_${index + 1}`,
      enabled: true,
      path: `rules/${fileName}`,
    };
  });
}
