// Bundles the reporter + CLI (and the internal shared package, zod) into a dependency-free package.
import { build } from 'esbuild';
import { rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const src = (p) => path.resolve(pkg, '../', p);
rmSync(path.join(pkg, 'dist'), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Playwright is only needed for types; never bundle it.
  external: ['@playwright/test', '@playwright/test/*'],
  legalComments: 'none',
  logLevel: 'warning',
};
await build({ ...common, entryPoints: [src('playwright-reporter/src/index.ts')], outfile: path.join(pkg, 'dist/index.js') });
await build({
  ...common,
  entryPoints: { cli: src('cli/src/bin.ts') },
  outdir: path.join(pkg, 'dist'),
  // `analyze` (with its parser) is a separate chunk, loaded only when that command runs.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  // The entry file's hashbang is kept first by esbuild. Bundled CommonJS deps may call require():
  // provide it in the ESM output.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
copyFileSync(path.join(pkg, 'src/index.d.ts'), path.join(pkg, 'dist/index.d.ts'));
console.log('turnsignal: built dist/index.js, dist/cli.js');
