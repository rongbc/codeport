/**
 * CodePort build script.
 *
 *  - bundles src/extension.ts -> dist/extension.js (CommonJS, external: vscode)
 *
 * There are no assets to copy any more. The tree-sitter WASM runtime and the C++
 * grammar used to be vendored into dist/wasm/ for the local index; CodeGraph owns
 * indexing now, and it ships (and loads) its own parsers. That removed ~5.4 MB
 * from the package.
 *
 * CodeGraph itself is never bundled either — the per-platform bundle is ~123 MB.
 * `src/codegraph/sdk.ts` loads an installed copy at runtime through a computed
 * dynamic `import()`, which esbuild leaves alone.
 *
 * Usage:
 *   node scripts/build.mjs            one-shot build
 *   node scripts/build.mjs --watch    rebuild on change
 *   node scripts/build.mjs --prod     minified build
 */
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

const buildOptions = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(outdir, 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
  // `vscode` is injected by the extension host.
  external: ['vscode'],
  banner: {
    js: '/* CodePort — generated bundle. Source: https://github.com/rongbc/codeport */',
  },
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('[build] watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('[build] done -> dist/extension.js');
}
