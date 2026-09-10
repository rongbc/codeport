/**
 * Find All References for a Markdown symbol.
 *
 * The index cannot answer this (it stores no call graph — plan section 7), so the
 * mention is first resolved to a real definition and the language server is then
 * asked for references *at that definition*, where a genuine position exists.
 */

import * as vscode from 'vscode';
import type { CodePort } from '../core/CodePort.ts';
import type { Location } from '../types.ts';
import { toVsLocation } from '../vscode/convert.ts';

/** How many resolved definitions to expand into reference searches. */
const MAX_DEFINITIONS = 5;

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

      for (const candidate of outcome.candidates.slice(0, MAX_DEFINITIONS)) {
        if (token.isCancellationRequested) break;
        const target = codeport.targetForLocation(candidate.location);
        if (!target) continue;
        try {
          const references = await codeport.findReferences(
            target,
            candidate.location,
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
