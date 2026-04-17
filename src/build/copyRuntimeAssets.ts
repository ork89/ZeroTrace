import fs from 'fs';
import path from 'path';

import { DIST_DIR } from '../config/constants';

const RUNTIME_FILES = ['background.js', 'content.js'];
const ICONS_SOURCE_DIR = path.resolve('./public/icons');
const ICONS_DEST_DIR = path.join(DIST_DIR, 'icons');

export function copyRuntimeAssets(): void {
  for (const fileName of RUNTIME_FILES) {
    const sourcePath = path.resolve('./src/runtime', fileName);
    const destPath = path.join(DIST_DIR, fileName);

    fs.copyFileSync(sourcePath, destPath);
    console.log(`✔ ${fileName}`);
  }

  if (!fs.existsSync(ICONS_SOURCE_DIR)) {
    return;
  }

  fs.mkdirSync(ICONS_DEST_DIR, { recursive: true });

  for (const fileName of fs.readdirSync(ICONS_SOURCE_DIR)) {
    const sourcePath = path.join(ICONS_SOURCE_DIR, fileName);
    const destPath = path.join(ICONS_DEST_DIR, fileName);

    if (!fs.statSync(sourcePath).isFile()) {
      continue;
    }

    fs.copyFileSync(sourcePath, destPath);
    console.log(`✔ icons/${fileName}`);
  }
}
