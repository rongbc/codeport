/**
 * Clickable `path/to/file.ext:42` links in Markdown.
 *
 * A mention is anything that looks like a file: it carries an extension of **any**
 * kind (there is no source-code whitelist), or it contains a directory separator
 * (so extensionless names such as `src/Makefile` work too). Guessing is safe
 * because a link is created only when the target really exists — a wrong guess
 * costs a `stat`, not a link to nowhere.
 *
 * Relative mentions are tried against every base, in order:
 *
 *   1. `codeport.codeLink.searchPaths`, each entry absolute or workspace-root-relative;
 *   2. the workspace root;
 *   3. the directory holding the Markdown file, so a note can always point at
 *      something next to it.
 *
 * Absolute mentions are used as-is. All of this is a regex plus `fs.statSync` —
 * no code graph is involved, which is why the tests assert it survives every
 * CodeGraph failure mode.
 */

import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import type { CodePort } from '../core/CodePort.ts';

/**
 * Matches a file mention, with an optional `:line` suffix.
 *
 * Two shapes, tried in this order:
 *
 * - a path: one or more `dir/` segments (the leading slash is kept, so an
 *   absolute mention stays absolute) and a final segment that may itself be
 *   dotted;
 * - a bare filename with an extension, including dotfiles.
 *
 * Requiring a slash or a dot is what keeps every prose word out of the scan, and
 * the lookbehinds avoid re-linking an existing Markdown link target and starting
 * mid-word, mid-path, or inside a URL (whose segments follow a `/`).
 */
const LINK_RE =
  /(?<!\]\()(?<![A-Za-z0-9_/.:\]\[])(\/?(?:[A-Za-z0-9_.+-]+\/)+[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*|[A-Za-z0-9_+-]*(?:\.[A-Za-z0-9_+-]+)+)(?::(\d+))?/g;

/** Bases a relative mention is resolved against, most explicit first. */
interface TargetOptions {
  readonly searchPaths: readonly string[];
}

export function createDocumentLinkProvider(codeport: CodePort): vscode.DocumentLinkProvider {
  return {
    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
      const config = codeport.getConfig();
      if (!config.enabled) return [];

      const options: TargetOptions = { searchPaths: config.codeLinkSearchPaths };

      const links: vscode.DocumentLink[] = [];
      const text = document.getText();
      LINK_RE.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = LINK_RE.exec(text)) !== null) {
        const filePart = match[1]!;
        const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
        const resolved = resolveTarget(document, filePart, options);
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

/** Absolute as-is, otherwise every configured/base directory, first existing file wins. */
function resolveTarget(
  document: vscode.TextDocument,
  candidate: string,
  options: TargetOptions
): string | undefined {
  if (path.isAbsolute(candidate)) {
    return isFile(candidate) ? candidate : undefined;
  }

  for (const base of relativeBases(document, options)) {
    const resolved = path.resolve(base, candidate);
    if (isFile(resolved)) return resolved;
  }

  return undefined;
}

/**
 * Bases for a relative mention: configured search paths, then the workspace root,
 * then the Markdown file's own directory. Duplicates collapse, so a configured
 * path equal to the workspace root costs one `stat`, not two.
 */
function relativeBases(document: vscode.TextDocument, options: TargetOptions): string[] {
  const bases: string[] = [];
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;

  for (const configured of options.searchPaths) {
    if (path.isAbsolute(configured)) {
      bases.push(configured);
    } else if (workspaceRoot) {
      bases.push(path.resolve(workspaceRoot, configured));
    }
  }

  if (workspaceRoot) bases.push(workspaceRoot);
  bases.push(path.dirname(document.uri.fsPath));

  return [...new Set(bases)];
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
