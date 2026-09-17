/**
 * Configuration access.
 *
 * The settings that configured the retired index and clangd tiers are gone:
 * CodeGraph owns both jobs now, and its own configuration lives in the project's
 * `codegraph.json` and `.codegraph/` directory, not in VS Code.
 *
 * There is deliberately **no migration** from the old `md-code-links` extension.
 * CodePort is pre-1.0 and has no released settings surface worth preserving, and
 * the one legacy key that ever had a destination (`mdCodeLinks.enableFunctionJump`)
 * pointed at a capability that no longer has a setting of its own. A migration
 * path that exists only to move a value between two names nobody has shipped is
 * pure maintenance cost.
 */

import * as vscode from 'vscode';
import { CONFIG_SECTION } from './constants.ts';
import type { LogLevel } from './logger.ts';

export interface CodePortConfig {
  readonly enabled: boolean;
  readonly definitionEnabled: boolean;
  readonly referencesEnabled: boolean;
  readonly hoverEnabled: boolean;
  readonly codeLinkEnabled: boolean;
  readonly codeLinkRelativeToMarkdown: boolean;
  readonly trace: LogLevel;
}

export function readConfig(): CodePortConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: config.get<boolean>('enabled', true),
    definitionEnabled: config.get<boolean>('definition.enabled', true),
    referencesEnabled: config.get<boolean>('references.enabled', true),
    hoverEnabled: config.get<boolean>('hover.enabled', true),
    codeLinkEnabled: config.get<boolean>('codeLink.enabled', true),
    codeLinkRelativeToMarkdown: config.get<boolean>(
      'codeLink.resolveRelativeToMarkdownFile',
      false
    ),
    trace: config.get<LogLevel>('trace', 'messages'),
  };
}
