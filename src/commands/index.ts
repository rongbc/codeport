/** CodePort command registrations. */

import * as vscode from 'vscode';
import type { CodePort } from '../core/CodePort.ts';
import { insertSourceLink } from './InsertSourceLink.ts';

export function registerCommands(codeport: CodePort): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('codeport.goToDefinition', async () => {
      await vscode.commands.executeCommand('editor.action.revealDefinition');
    }),

    vscode.commands.registerCommand('codeport.peekDefinition', async () => {
      await vscode.commands.executeCommand('editor.action.peekDefinition');
    }),

    vscode.commands.registerCommand('codeport.findReferences', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await vscode.commands.executeCommand(
        'editor.action.findReferences',
        editor.document.uri,
        editor.selection.active
      );
    }),

    vscode.commands.registerCommand('codeport.insertSourceLink', () => insertSourceLink(codeport)),

    vscode.commands.registerCommand('codeport.rebuildIndex', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        void vscode.window.showInformationMessage('CodePort: open a folder first.');
        return;
      }
      // CodeGraph owns the index now, so CodePort never rebuilds it itself — it
      // reports state and hands over the command that does.
      const command = `codegraph index ${root}`;
      const summary = await codeport.graphSummary(root);
      const choice = await vscode.window.showInformationMessage(
        summary
          ? `CodeGraph index at ${summary.root} (${summary.fileCount} file(s)). ` +
              `Rebuild it with: ${command}`
          : `No CodeGraph index covers ${root}. Build one with: ${command}`,
        'Copy Command'
      );
      if (choice === 'Copy Command') await vscode.env.clipboard.writeText(command);
    }),

    vscode.commands.registerCommand('codeport.showIndexStats', async () => {
      const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
      if (roots.length === 0) {
        void vscode.window.showInformationMessage('CodePort: no workspace folder is open.');
        return;
      }

      const lines: string[] = [];
      for (const root of roots) {
        const summary = await codeport.graphSummary(root);
        if (!summary) {
          lines.push(`${root}: no CodeGraph index (run "codegraph index ${root}")`);
          continue;
        }
        lines.push(
          `${root}: graph at ${summary.root} — ${summary.fileCount} file(s), ` +
            `${summary.nodeCount} node(s), ${summary.edgeCount} edge(s), ` +
            `${(summary.dbSizeBytes / 1024 / 1024).toFixed(1)} MB`
        );
      }

      const detail = lines.join('\n');
      codeport.logger.section('codegraph statistics');
      codeport.logger.info(detail);
      const choice = await vscode.window.showInformationMessage(detail, 'Show Log');
      if (choice === 'Show Log') codeport.logger.show();
    }),

    vscode.commands.registerCommand('codeport.showLog', () => codeport.logger.show()),
  ];
}
