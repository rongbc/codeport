/**
 * Hover for a Markdown symbol.
 *
 * Shows the signature when CodeGraph reports one, falls back to the symbol's own
 * source when it does not, and — uniquely useful for a navigation aid — documents
 * *why* CodePort picked this definition (which engine, on what evidence).
 */

import * as vscode from 'vscode';
import path from 'node:path';
import type { CodePort } from '../core/CodePort.ts';
import { toVsRange } from '../vscode/convert.ts';
import { tryUriToPath } from '../util/uri.ts';

export function createHoverProvider(codeport: CodePort): vscode.HoverProvider {
  return {
    async provideHover(
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
      const config = codeport.getConfig();
      if (!config.enabled || !config.hoverEnabled) return undefined;

      const reference = codeport.symbolAtPosition(document, position);
      if (!reference) return undefined;

      const outcome = await codeport.resolve(reference, document, token);
      if (token.isCancellationRequested || outcome.candidates.length === 0) return undefined;

      const best = outcome.candidates[0]!;
      const markdown = new vscode.MarkdownString(undefined, true);
      markdown.supportThemeIcons = true;

      markdown.appendMarkdown(`**${escapeMarkdown(reference.raw)}**`);
      const kind = best.symbol?.kind;
      const container = best.symbol?.container;
      if (container || kind) {
        // Inside a code span nothing needs escaping; escaping put literal
        // backslashes into path-like text.
        const label = [container, kind].filter(Boolean).join(' · ');
        markdown.appendMarkdown(` — \`${label!}\``);
      }

      // Prefer CodeGraph's `signature` field; when it has none, show the symbol's
      // own source, which CodeGraph reads straight from disk.
      let signature = best.symbol?.signature;
      if (!signature) {
        try {
          signature = await codeport.symbolSource(best.location, best.symbol?.id);
        } catch (error) {
          codeport.logger.trace(`source lookup failed: ${(error as Error).message}`);
        }
      }
      if (signature) {
        markdown.appendMarkdown('\n\n');
        markdown.appendCodeblock(truncate(signature, 600), languageForFence(reference.language));
      }

      const targetPath = tryUriToPath(best.location.uri);
      const display = targetPath
        ? path.relative(
            vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? '',
            targetPath
          ) || targetPath
        : best.location.uri;
      markdown.appendMarkdown(
        `\n\n$(file-code) \`${display}:${best.location.range.start.line + 1}\``
      );

      const others = outcome.candidates.length - 1;
      markdown.appendMarkdown(
        `\n\n$(circuit-board) ${best.source}` +
          (best.reason ? ` · ${escapeMarkdown(best.reason)}` : '') +
          (others > 0 ? ` · +${others} more definition(s)` : '')
      );

      return new vscode.Hover(markdown, toVsRange(reference.range));
    },
  };
}

function languageForFence(language: string | undefined): string {
  if (!language) return 'c';
  return language === 'cpp' ? 'cpp' : language;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}
