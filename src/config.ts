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
  readonly codeLinkSearchPaths: readonly string[];
  readonly trace: LogLevel;
}

export function readConfig(): CodePortConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: config.get<boolean>('enabled', true),
    definitionEnabled: config.get<boolean>('definition.enabled', true),
    referencesEnabled: config.get<boolean>('references.enabled', true),
    hoverEnabled: config.get<boolean>('hover.enabled', true),
    codeLinkSearchPaths: readSearchPaths(config),
    trace: config.get<LogLevel>('trace', 'messages'),
  };
}

/** Additional path-link bases: strings only, trimmed, blanks dropped. */
function readSearchPaths(config: vscode.WorkspaceConfiguration): readonly string[] {
  const configured = config.get<unknown>('codeLink.searchPaths', []);
  if (!Array.isArray(configured)) return [];
  return configured
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
