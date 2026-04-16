import fs from 'fs';
import path from 'path';

import { DIST_DIR } from '../config/constants';

const RUNTIME_FILES = ['background.js', 'content.js'];

export function copyRuntimeAssets(): void {
  for (const fileName of RUNTIME_FILES) {
    const sourcePath = path.resolve('./src/runtime', fileName);
    const destPath = path.join(DIST_DIR, fileName);

    fs.copyFileSync(sourcePath, destPath);
    console.log(`✔ ${fileName}`);
  }
}
