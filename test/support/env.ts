/** Shared test helpers. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TreeSitterParser as TreeSitterParserType } from '../../src/index/TreeSitterParser.ts';
import { TreeSitterParser } from '../../src/index/TreeSitterParser.ts';

/** Grammar/runtime directory shipped by `@vscode/tree-sitter-wasm`. */
export const WASM_DIR = fileURLToPath(
  new URL('../../node_modules/@vscode/tree-sitter-wasm/wasm/', import.meta.url)
);

export const silentLogger = { info(): void {}, warn(): void {} };

/** A tree-sitter parser for the tests, or `undefined` when assets are missing. */
export function createTestParser(): Promise<TreeSitterParserType | undefined> {
  return TreeSitterParser.create({ wasmDir: WASM_DIR, logger: silentLogger });
}

export function tempDir(prefix = 'codeport-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
