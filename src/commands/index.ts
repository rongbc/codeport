/** CodePort command registrations. */

import * as vscode from 'vscode';
import type { CodePort } from '../core/CodePort.ts';
import { applyMigrations, pendingMigrations } from '../config.ts';
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
      const stats = await codeport.rebuildIndex();
      if (!stats) return;
      void vscode.window.showInformationMessage(
        `CodePort: indexed ${stats.indexedFiles} file(s), ${stats.symbols} symbol(s) ` +
          `in ${(stats.durationMs / 1000).toFixed(1)}s (${stats.unchangedFiles} unchanged, ` +
          `${stats.removedFiles} removed).`
      );
    }),

    vscode.commands.registerCommand('codeport.showIndexStats', async () => {
      const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
      if (roots.length === 0) {
        void vscode.window.showInformationMessage('CodePort: no workspace folder is open.');
        return;
      }

      const lines: string[] = [];
      for (const root of roots) {
        const stats = codeport.indexStats(root);
        if (!stats) {
          lines.push(`${root}: index not built yet`);
          continue;
        }
        lines.push(
          `${root}: ${stats.files} file(s), ${stats.symbols} symbol(s), ` +
            `${stats.references} reference(s), ${stats.includes} include(s), schema v${stats.schemaVersion}`
        );
      }

      const detail = lines.join('\n');
      codeport.logger.section('index statistics');
      codeport.logger.info(detail);
      const choice = await vscode.window.showInformationMessage(detail, 'Show Log', 'Rebuild Index');
      if (choice === 'Show Log') codeport.logger.show();
      if (choice === 'Rebuild Index') await codeport.rebuildIndex();
    }),

    vscode.commands.registerCommand('codeport.showLog', () => codeport.logger.show()),

    vscode.commands.registerCommand('codeport.migrateSettings', async () => {
      const pending = pendingMigrations();
      if (pending.length === 0) {
        void vscode.window.showInformationMessage(
          'CodePort: nothing to migrate (no mdCodeLinks.* settings found, or codeport.* is already set).'
        );
        return;
      }
      const written = await applyMigrations(pending);
      void vscode.window.showInformationMessage(
        `CodePort: migrated ${written} setting(s): ${pending.map((entry) => entry.to).join(', ')}`
      );
    }),
  ];
}
