/**
 * Find All References for a Markdown symbol.
 *
 * CodeGraph keeps a static call/reference graph, and its edges carry the exact
 * line and column of every usage, so the mention is resolved once and each
 * candidate's node id is expanded into reference sites.
 *
 * The trade-off versus the language server this replaced: CodeGraph resolves
 * references by name and import, not semantically, so overloads and
 * macro-expanded call sites can be attributed to the wrong target.
 */

import * as vscode from 'vscode';
import type { CodePort } from '../core/CodePort.ts';
import type { Location } from '../types.ts';
import { toVsLocation } from '../vscode/convert.ts';

export function createReferenceProvider(codeport: CodePort): vscode.ReferenceProvider {
  return {
    async provideReferences(
      document: vscode.TextDocument,
      position: vscode.Position,
      context: vscode.ReferenceContext,
      token: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
      const config = codeport.getConfig();
      if (!config.enabled || !config.referencesEnabled) return undefined;

      const reference = codeport.symbolAtPosition(document, position);
      if (!reference) return undefined;

      const outcome = await codeport.resolve(reference, document, token);
      if (token.isCancellationRequested || outcome.candidates.length === 0) {
        void vscode.window.setStatusBarMessage(
          `$(search) CodePort: no definition to search references for "${reference.name}"`,
          5000
        );
        return undefined;
      }

      const seen = new Set<string>();
      const locations: vscode.Location[] = [];

      for (const candidate of outcome.candidates.slice(0, codeport.referenceTargetLimit())) {
        if (token.isCancellationRequested) break;
        try {
          const references = await codeport.referencesFor(
            candidate.location,
            candidate.symbol?.id,
            context.includeDeclaration
          );
          for (const found of references) {
            const key = locationKey(found);
            if (seen.has(key)) continue;
            seen.add(key);
            locations.push(toVsLocation(found));
          }
        } catch (error) {
          codeport.logger.warn(
            `references at ${candidate.location.uri} failed: ${(error as Error).message}`
          );
        }
      }

      if (locations.length === 0) {
        void vscode.window.setStatusBarMessage(
          `$(search) CodePort: no references found for "${reference.name}"`,
          5000
        );
        return undefined;
      }
      return locations;
    },
  };
}

function locationKey(location: Location): string {
  return `${location.uri}:${location.range.start.line}:${location.range.start.character}`;
}
