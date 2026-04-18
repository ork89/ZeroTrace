import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function run(): Promise<void> {
  const testDir = path.resolve('./test');
  const files = fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();

  if (!files.length) {
    throw new Error('No test files found in test/.');
  }

  for (const file of files) {
    const absPath = path.join(testDir, file);
    await import(pathToFileURL(absPath).href);
  }

  console.log(`Executed ${files.length} test file(s)`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
