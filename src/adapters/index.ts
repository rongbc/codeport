/** Built-in adapters and a helper that wires them into a registry. */

import { ClangdAdapter, type ClangdAdapterOptions } from './clangd/ClangdAdapter.ts';
import { AdapterRegistry } from './AdapterRegistry.ts';
import type { LanguageAdapter } from './LanguageAdapter.ts';

export interface BuiltInAdapterOptions {
  readonly clangd?: ClangdAdapterOptions;
}

/** Every adapter CodePort ships today. Rust/Go/TypeScript plug in here later. */
export function createBuiltInAdapters(options: BuiltInAdapterOptions = {}): LanguageAdapter[] {
  return [new ClangdAdapter(options.clangd)];
}

export function createAdapterRegistry(options: BuiltInAdapterOptions = {}): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const adapter of createBuiltInAdapters(options)) registry.register(adapter);
  return registry;
}

export { AdapterRegistry } from './AdapterRegistry.ts';
export { LanguageAdapter } from './LanguageAdapter.ts';
export type { SeedFile, SymbolMatch, SymbolMatchKind } from './LanguageAdapter.ts';
export { ClangdAdapter } from './clangd/ClangdAdapter.ts';
export type { ClangdAdapterOptions } from './clangd/ClangdAdapter.ts';
