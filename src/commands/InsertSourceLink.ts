/**
 * "Insert Source Link" (plan section 13) — the other direction of navigation.
 *
 * Rewrites an inline code span into a Markdown link pointing at the resolved
 * definition:
 *
 *     `nx_start()`   ->   [nx_start()](../sched/init/nx_start.c#L123)
 *
 * Fenced blocks are deliberately not rewritten: Markdown does not render links
 * inside a code block, so the result would be worse than the original text.
 */

import * as vscode from 'vscode';
import type { CodePort } from '../core/CodePort.ts';
import { relativeLinkPath } from '../util/path.ts';
import { tryUriToPath } from '../util/uri.ts';
import { toVsRange } from '../vscode/convert.ts';

export async function insertSourceLink(codeport: CodePort): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    void vscode.window.showInformationMessage(
      'CodePort: open a Markdown file and put the cursor on a symbol in inline code.'
    );
    return;
  }

  const document = editor.document;
  const reference = codeport.symbolAtPosition(document, editor.selection.active);
  if (!reference) {
    void vscode.window.showInformationMessage(
      'CodePort: no symbol under the cursor. Put the cursor on a name inside inline code (`` `like_this()` ``).'
    );
    return;
  }

  if (!reference.inline) {
    void vscode.window.showWarningMessage(
      'CodePort: Insert Source Link rewrites inline code only — links inside a fenced code block are not rendered by Markdown.'
    );
    return;
  }

  const outcome = await codeport.resolve(reference, document);
  const best = outcome.candidates[0];
  if (!best) {
    void vscode.window.showWarningMessage(
      `CodePort: no definition found for "${reference.name}", so no link was inserted.`
    );
    return;
  }

  const targetPath = tryUriToPath(best.location.uri);
  if (!targetPath) {
    void vscode.window.showWarningMessage(
      `CodePort: cannot build a relative link to ${best.location.uri}.`
    );
    return;
  }

  const relative = relativeLinkPath(document.uri.fsPath, targetPath);
  const line = best.location.range.start.line + 1;
  const destination = /\s/.test(relative) ? `<${relative}#L${line}>` : `${relative}#L${line}`;
  const replacement = `[${reference.raw}](${destination})`;

  const applied = await editor.edit((builder) => {
    builder.replace(toVsRange(reference.codeRange), replacement);
  });

  if (applied) {
    codeport.logger.info(
      `insert source link: ${reference.raw} -> ${relative}#L${line} ` +
        `(${best.source}, ${best.reason ?? 'no evidence'})`
    );
    void vscode.window.setStatusBarMessage(
      `$(link) CodePort: inserted link to ${relative}:${line}`,
      4000
    );
  } else {
    void vscode.window.showWarningMessage('CodePort: the edit could not be applied.');
  }
}
