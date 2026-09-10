/**
 * Clickable `path/to/file.c:42` links in Markdown.
 *
 * Behaviour preserved from `md-code-links`: the link is created only when the
 * target really exists, and resolution is absolute-path first, then relative to
 * the workspace root. Resolving relative to the Markdown file itself is opt-in
 * (`codeport.codeLink.resolveRelativeToMarkdownFile`) because it changes which
 * file a given relative path means.
 */

import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import type { CodePort } from '../core/CodePort.ts';

/**
 * Matches `name.ext` or `name.ext:line` for source-ish extensions. The
 * lookbehinds avoid re-linking an existing Markdown link target and avoid
 * matching inside a longer word/path fragment.
 */
const LINK_RE =
  /(?<!\]\()(?<![A-Za-z0-9_/.:\]\[])([A-Za-z0-9_.+/-]+\.(?:[ch]|cc|cpp|cxx|hpp|hh|S|asm))(?::(\d+))?/g;

export function createDocumentLinkProvider(codeport: CodePort): vscode.DocumentLinkProvider {
  return {
    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
      const config = codeport.getConfig();
      if (!config.enabled || !config.codeLinkEnabled) return [];

      const links: vscode.DocumentLink[] = [];
      const text = document.getText();
      LINK_RE.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = LINK_RE.exec(text)) !== null) {
        const filePart = match[1]!;
        const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
        const resolved = resolveTarget(document, filePart, config.codeLinkRelativeToMarkdown);
        if (!resolved) continue;

        let uri = vscode.Uri.file(resolved);
        if (line !== undefined && line > 0) uri = uri.with({ fragment: `L${line}` });

        links.push(
          new vscode.DocumentLink(
            new vscode.Range(
              document.positionAt(match.index),
              document.positionAt(match.index + match[0].length)
            ),
            uri
          )
        );
        const link = links[links.length - 1]!;
        link.tooltip = `${resolved}${line !== undefined ? `:${line}` : ''}`;
      }

      return links;
    },
  };
}

/** Absolute path, then workspace-root-relative, then (opt-in) Markdown-relative. */
function resolveTarget(
  document: vscode.TextDocument,
  candidate: string,
  relativeToMarkdown: boolean
): string | undefined {
  if (path.isAbsolute(candidate)) {
    return isFile(candidate) ? candidate : undefined;
  }

  const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  if (workspaceRoot) {
    const fromRoot = path.resolve(workspaceRoot, candidate);
    if (isFile(fromRoot)) return fromRoot;
  }

  if (relativeToMarkdown) {
    const fromDocument = path.resolve(path.dirname(document.uri.fsPath), candidate);
    if (isFile(fromDocument)) return fromDocument;
  }

  return undefined;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
