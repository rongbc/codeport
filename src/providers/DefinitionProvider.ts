/**
 * Go-to-definition for symbols inside Markdown code blocks and inline code.
 *
 * This is the capability that existed in `md-code-links`, now served by the
 * resolver pipeline: CodeGraph answers from its graph, and the user sees exactly
 * what happened in the log.
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
        const hint = detail ? ` (${detail})` : await graphHint(codeport, document);
        void vscode.window.setStatusBarMessage(
          `$(search) CodePort: no definition found for "${reference.name}"${hint}`,
          5000
        );
        return undefined;
      }

      if (outcome.candidates.length === 1) {
        const best = outcome.candidates[0]!;
        codeport.logger.trace(
          `definition: ${best.source} -> ${describeLocation(best.location)} ` +
            `(rank ${best.rank}: ${best.reason ?? 'no reason'})`
        );
      }
      return outcome.candidates.map((candidate) => toVsLocation(candidate.location));
    },
  };
}

/** Explain the usual reason a lookup misses. */
async function graphHint(codeport: CodePort, document: vscode.TextDocument): Promise<string> {
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  if (!root) return '';
  const summary = await codeport.graphSummary(root);
  if (!summary) {
    return ` — no CodeGraph index covers this folder; run "codegraph index ${root}"`;
  }
  // The overwhelmingly common miss with a healthy graph is a name CodeGraph does
  // not model at all — preprocessor macros have no node kind.
  return ' — not in the CodeGraph index (preprocessor macros are not indexed)';
}
