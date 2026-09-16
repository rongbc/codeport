/**
 * CodePort — Navigate Markdown to Source Code.
 *
 * Brings source-code navigation to Markdown. Symbols written inside code blocks
 * and inline code are resolved through a CodeGraph code graph, read in-process.
 *
 * The extension entry point only wires things together; every layer below it is
 * described in `docs/ARCHITECTURE.md`.
 */

import * as vscode from 'vscode';
import { CodePort } from './core/CodePort.ts';
import { createDefinitionProvider } from './providers/DefinitionProvider.ts';
import { createReferenceProvider } from './providers/ReferenceProvider.ts';
import { createHoverProvider } from './providers/HoverProvider.ts';
import { createDocumentLinkProvider } from './providers/DocumentLinkProvider.ts';
import { registerCommands } from './commands/index.ts';

let codeport: CodePort | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const instance = new CodePort(context);
  codeport = instance;

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: 'markdown' },
      createDefinitionProvider(instance)
    ),
    vscode.languages.registerReferenceProvider(
      { language: 'markdown' },
      createReferenceProvider(instance)
    ),
    vscode.languages.registerHoverProvider({ language: 'markdown' }, createHoverProvider(instance)),
    vscode.languages.registerDocumentLinkProvider(
      { language: 'markdown' },
      createDocumentLinkProvider(instance)
    ),
    ...registerCommands(instance)
  );

  instance.initialize();
}

export async function deactivate(): Promise<void> {
  await codeport?.dispose();
  codeport = undefined;
}
