import { buildExtension } from './src/scripts/build-extension';

buildExtension().catch((err) => {
  console.error(err);
  process.exit(1);
});
