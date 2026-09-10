/**
 * CodePort build script.
 *
 *  - bundles src/extension.ts -> dist/extension.js (CommonJS, external: vscode, node:sqlite)
 *  - copies the tree-sitter WASM runtime + grammar(s) from @vscode/tree-sitter-wasm
 *    into dist/wasm/ so the packaged extension is self-contained (no node_modules at runtime)
 *
 * Usage:
 *   node scripts/build.mjs            one-shot build
 *   node scripts/build.mjs --watch    rebuild on change
 *   node scripts/build.mjs --prod     minified build
 */
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');
const wasmOut = path.join(outdir, 'wasm');

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

/**
 * Grammars copied into the package. `cpp` also parses C (the C++ grammar is a
 * superset). Add `rust` / `go` / `typescript` here when their adapters land.
 */
const GRAMMARS = ['tree-sitter-cpp.wasm'];

/** Files every install needs: the runtime glue + the engine itself. */
const RUNTIME_FILES = ['tree-sitter.js', 'tree-sitter.wasm'];

const wasmSrc = path.join(root, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');

function copyWasm() {
  if (!fs.existsSync(wasmSrc)) {
    throw new Error(
      `Missing ${path.relative(root, wasmSrc)} — run \`npm install\` before building.`
    );
  }
  fs.mkdirSync(wasmOut, { recursive: true });
  for (const file of [...RUNTIME_FILES, ...GRAMMARS]) {
    const from = path.join(wasmSrc, file);
    if (!fs.existsSync(from)) throw new Error(`Missing tree-sitter asset: ${file}`);
    fs.copyFileSync(from, path.join(wasmOut, file));
  }
  return [...RUNTIME_FILES, ...GRAMMARS];
}

/** esbuild plugin: re-copy WASM assets whenever the bundle is rebuilt in watch mode. */
const wasmPlugin = {
  name: 'codeport-wasm',
  setup(build) {
    build.onStart(() => {
      const files = copyWasm();
      console.log(`[build] copied ${files.length} tree-sitter asset(s) -> dist/wasm/`);
    });
  },
};

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
  // `vscode` is injected by the extension host. `node:sqlite` is loaded lazily with
  // try/catch so the extension still works on hosts whose Node lacks it.
  external: ['vscode', 'node:sqlite'],
  plugins: [wasmPlugin],
  banner: {
    js: '/* CodePort — generated bundle. Source: https://github.com/rongbc/codenav */',
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
