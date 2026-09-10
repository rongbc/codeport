/**
 * Minimal, dependency-free subset of the Language Server Protocol used by CodePort.
 *
 * Everything here is plain data so the LSP layer never touches the `vscode` API.
 */

import type { Location, Position, Range, SymbolKind } from '../types.ts';

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspSymbolInformation {
  readonly name: string;
  readonly kind: number;
  readonly location: LspLocation;
  readonly containerName?: string;
}

export interface LspHover {
  readonly contents:
    | string
    | { readonly kind: 'plaintext' | 'markdown'; readonly value: string }
    | ReadonlyArray<string | { readonly kind: 'plaintext' | 'markdown'; readonly value: string }>;
  readonly range?: LspRange;
}

export interface LspDocumentSymbol {
  readonly name: string;
  readonly kind: number;
  readonly range: LspRange;
  readonly selectionRange: LspRange;
  readonly children?: readonly LspDocumentSymbol[];
}

export interface LspServerCapabilities {
  readonly workspaceSymbolProvider?: boolean | Record<string, unknown>;
  readonly definitionProvider?: boolean | Record<string, unknown>;
  readonly referencesProvider?: boolean | Record<string, unknown>;
  readonly hoverProvider?: boolean | Record<string, unknown>;
  readonly typeDefinitionProvider?: boolean | Record<string, unknown>;
  readonly implementationProvider?: boolean | Record<string, unknown>;
  readonly documentSymbolProvider?: boolean | Record<string, unknown>;
  readonly textDocumentSync?: number | Record<string, unknown>;
}

export interface LspInitializeResult {
  readonly capabilities?: LspServerCapabilities;
  readonly serverInfo?: { readonly name: string; readonly version?: string };
}

/* ------------------------------- conversion ------------------------------- */

export function toLspPosition(position: Position): LspPosition {
  return { line: position.line, character: position.character };
}

export function toLspRange(range: Range): LspRange {
  return { start: toLspPosition(range.start), end: toLspPosition(range.end) };
}

export function fromLspPosition(position: LspPosition): Position {
  return { line: position.line, character: position.character };
}

export function fromLspRange(range: LspRange): Range {
  return { start: fromLspPosition(range.start), end: fromLspPosition(range.end) };
}

export function fromLspLocation(location: LspLocation): Location {
  return { uri: location.uri, range: fromLspRange(location.range) };
}

/** LSP `SymbolKind` numbers (3.17) mapped onto CodePort's string union. */
export function fromLspSymbolKind(kind: number | undefined): SymbolKind | undefined {
  switch (kind) {
    case 1: // File
    case 2: // Module
    case 4: // Package
      return 'module';
    case 3:
      return 'namespace';
    case 5:
      return 'class';
    case 6:
      return 'method';
    case 7:
    case 8:
      return 'field';
    case 9:
      return 'constructor';
    case 10:
      return 'enum';
    case 11:
      return 'interface';
    case 12:
      return 'function';
    case 13:
    case 14:
      return 'variable';
    case 22:
      return 'enumerator';
    case 23:
      return 'struct';
    case 26:
      return 'type';
    default:
      return undefined;
  }
}

/** Flatten LSP `Hover.contents` into plain Markdown text. */
export function hoverText(hover: LspHover | null | undefined): string | undefined {
  if (!hover) return undefined;
  const parts: string[] = [];
  const push = (entry: string | { kind: string; value: string }): void => {
    if (typeof entry === 'string') parts.push(entry);
    else if (entry && typeof entry.value === 'string') parts.push(entry.value);
  };
  if (Array.isArray(hover.contents)) hover.contents.forEach(push);
  else push(hover.contents as string | { kind: string; value: string });
  const text = parts.join('\n').trim();
  return text.length > 0 ? text : undefined;
}
