import fs from 'fs';
import path from 'path';

import { DIST_DIR } from '../config/constants';
import { GeneratedRuleset } from './writeRules';

type ManifestV3 = {
  manifest_version: 3;
  name: string;
  version: string;
  permissions?: string[];
  declarative_net_request?: {
    rule_resources: GeneratedRuleset[];
  };
  [key: string]: unknown;
};

export function generateManifest(ruleResources: GeneratedRuleset[]): void {
  const sourceManifestPath = path.resolve('./manifest.json');
  const outputManifestPath = path.join(DIST_DIR, 'manifest.json');

  const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8')) as ManifestV3;

  const outputManifest: ManifestV3 = {
    ...sourceManifest,
    declarative_net_request: {
      rule_resources: ruleResources
    }
  };

  fs.writeFileSync(outputManifestPath, JSON.stringify(outputManifest, null, 2));

  console.log(`✔ manifest.json (${ruleResources.length} rulesets)`);
}
