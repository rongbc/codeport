/**
 * Go-to-definition for symbols inside Markdown code blocks and inline code.
 *
 * This is the capability that existed in `md-code-links`, now served by the
 * resolver pipeline: the index may answer instantly, clangd confirms when the
 * evidence is weak, and the user sees exactly what happened in the log.
 */

import * as vscode from 'vscode';
import type { CodePort } from '../core/CodePort.ts';
import { toVsLocation } from '../vscode/convert.ts';
import { describeLocation } from '../vscode/convert.ts';

export function createDefinitionProvider(codeport: CodePort): vscode.DefinitionProvider {
  return {
    async provideDefinition(
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
      const config = codeport.getConfig();
      if (!config.enabled || !config.definitionEnabled) return undefined;

      const reference = codeport.symbolAtPosition(document, position);
      if (!reference) return undefined;

      const outcome = await codeport.resolve(reference, document, token);
      if (token.isCancellationRequested) return undefined;

      if (outcome.candidates.length === 0) {
        const detail = outcome.results.find((result) => result.error)?.error;
        void vscode.window.setStatusBarMessage(
          `$(search) CodePort: no definition found for "${reference.name}"` +
            (detail ? ` (${detail})` : indexHint(codeport, document)),
          5000
        );
        return undefined;
      }

      if (outcome.candidates.length === 1) {
        const best = outcome.candidates[0]!;
        codeport.logger.trace(
          `definition: ${best.source} -> ${describeLocation(best.location)} ` +
            `(${best.confidence.toFixed(2)}: ${best.reason ?? 'no reason'})`
        );
      }
      return outcome.candidates.map((candidate) => toVsLocation(candidate.location));
    },
  };
}

/** Explain the two common reasons an indexed lookup can miss. */
function indexHint(codeport: CodePort, document: vscode.TextDocument): string {
  const config = codeport.getConfig();
  if (!config.indexEnabled) return '';
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  if (!root) return '';
  const stats = codeport.indexStats(root);
  if (!stats) return ' — index not built yet, try again shortly';
  if (stats.symbols === 0) return ' — index is empty (still building?)';
  return '';
}
