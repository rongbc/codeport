/**
 * The `LanguageAdapter` abstraction (plan sections 3-4).
 *
 * CodePort Core knows only this interface. It never mentions clangd, clang,
 * rust-analyzer or any other server: an adapter supplies the command to run, the
 * files that wake its index, and how to map LSP results to CodePort's types.
 *
 * The base class implements every capability on top of standard LSP requests, so
 * a new adapter usually only needs `serverSpec` and `seedFiles`.
 */

import path from 'node:path';
import type { LspClient, LspLogger, LspServerSpec } from '../lsp/LspClient.ts';
import type { ProjectDetector } from '../project/ProjectDetector.ts';
import type { Project } from '../project/Project.ts';
import type { Location, Position, ResolvedSymbol } from '../types.ts';
import { pathToUri } from '../util/uri.ts';
import {
  fromLspLocation,
  fromLspSymbolKind,
  hoverText,
  toLspPosition,
  type LspHover,
  type LspLocation,
  type LspSymbolInformation,
} from '../lsp/protocol.ts';

/** A file the server should `didOpen` to wake its background index. */
export interface SeedFile {
  readonly path: string;
  readonly languageId: string;
}

/** How well a language-server hit matches the query. Drives confidence scoring. */
export type SymbolMatchKind = 'exact' | 'qualified' | 'fuzzy';

export interface SymbolMatch {
  readonly symbol: ResolvedSymbol;
  readonly location: Location;
  readonly match: SymbolMatchKind;
}

export abstract class LanguageAdapter {
  /** Stable adapter id, e.g. `clangd`. */
  abstract readonly id: string;
  /** Display name for logs and UI. */
  abstract readonly displayName: string;
  /** Language ids this adapter can serve. */
  abstract readonly languages: readonly string[];
  /** Project detector that produces `Project`s for this adapter. */
  abstract readonly detector: ProjectDetector;

  /** How to launch the language server for a project. */
  abstract serverSpec(project: Project): LspServerSpec;

  /** Files to open so the server starts indexing. Best effort. */
  abstract seedFiles(project: Project, limit?: number): readonly SeedFile[];

  /** Max number of `workspace/symbol` hits to keep. */
  protected maxSymbolResults = 50;

  /** LSP `languageId` for a language id / fence info string. */
  languageId(language: string): string {
    return language;
  }

  /** LSP `rootUri` for a project. */
  rootUri(project: Project): string {
    return pathToUri(project.root);
  }

  /**
   * Resolve a (possibly qualified) name to candidate definitions through the
   * server's workspace symbol index. The default implementation filters fuzzy
   * noise: exact matches win, otherwise substring matches, capped.
   */
  async workspaceSymbol(
    client: LspClient,
    query: string,
    container?: string
  ): Promise<SymbolMatch[]> {
    if (!client.isRunning) return [];
    const raw = await client.request<LspSymbolInformation[] | null>('workspace/symbol', {
      query,
    });
    return this.toSymbolMatches(raw, query, container);
  }

  /** Ask the server for the definition at a position inside a real source file. */
  async definition(client: LspClient, uri: string, position: Position): Promise<Location[]> {
    const result = await client.request<LspLocation | LspLocation[] | null>(
      'textDocument/definition',
      { textDocument: { uri }, position: toLspPosition(position) }
    );
    return normalizeLocations(result);
  }

  /** Ask the server for all references to the symbol at a position. */
  async references(
    client: LspClient,
    uri: string,
    position: Position,
    includeDeclaration = true
  ): Promise<Location[]> {
    const result = await client.request<LspLocation[] | null>('textDocument/references', {
      textDocument: { uri },
      position: toLspPosition(position),
      context: { includeDeclaration },
    });
    return normalizeLocations(result);
  }

  /** Hover text (Markdown) for a position inside a real source file. */
  async hover(client: LspClient, uri: string, position: Position): Promise<string | undefined> {
    const result = await client.request<LspHover | null>('textDocument/hover', {
      textDocument: { uri },
      position: toLspPosition(position),
    });
    return hoverText(result);
  }

  /** Shared `workspace/symbol` normalisation used by every adapter. */
  protected toSymbolMatches(
    raw: LspSymbolInformation[] | null | undefined,
    query: string,
    container?: string
  ): SymbolMatch[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const matches: SymbolMatch[] = [];
    const fuzzy: SymbolMatch[] = [];
    for (const info of raw) {
      if (!info?.name || !info.location?.uri) continue;
      const symbol: ResolvedSymbol = {
        name: info.name,
        kind: fromLspSymbolKind(info.kind),
        container: info.containerName,
      };
      const location = fromLspLocation(info.location);
      if (info.name === query) {
        const qualifiedName = info.containerName ? `${info.containerName}::${info.name}` : undefined;
        matches.push({
          symbol: { ...symbol, qualifiedName },
          location,
          match: containerMatches(info.containerName, container) ? 'qualified' : 'exact',
        });
      } else if (info.name.includes(query)) {
        fuzzy.push({ symbol, location, match: 'fuzzy' });
      }
    }

    // Exact hits always win; substring hits are a bounded fallback. Anything
    // looser is dropped rather than risking a wrong jump.
    const chosen = matches.length > 0 ? matches : fuzzy;
    return chosen.slice(0, this.maxSymbolResults);
  }
}

/** True when the server's container name agrees with the reference's qualifier. */
export function containerMatches(serverContainer?: string, referenceContainer?: string): boolean {
  if (!serverContainer || !referenceContainer) return false;
  const normalize = (value: string): string => value.replace(/^::/, '').replace(/\s+/g, '');
  const a = normalize(serverContainer);
  const b = normalize(referenceContainer);
  return a === b || a.endsWith(`::${b}`) || b.endsWith(`::${a}`);
}

function normalizeLocations(
  result: LspLocation | LspLocation[] | null | undefined
): Location[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list
    .filter((entry): entry is LspLocation => Boolean(entry?.uri && entry.range))
    .map(fromLspLocation);
}

/** Convenience for adapters that need a path relative to their project root. */
export function relativeToProject(project: Project, filePath: string): string {
  return path.relative(project.root, filePath);
}

export type { LspLogger };
