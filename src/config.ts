/**
 * Configuration access plus the `mdCodeLinks.*` -> `codeport.*` migration.
 *
 * The migration is non-destructive by design: legacy values are copied to the
 * new keys, the old keys are left alone, and nothing is written until the user
 * accepts the prompt (or runs the explicit command). Nothing is silently
 * overridden either — a new key that the user already set always wins.
 */

import * as vscode from 'vscode';
import { CONFIG_SECTION, LEGACY_CONFIG_SECTION } from './constants.ts';
import type { PolicyId } from './resolution/Policy.ts';
import type { LogLevel } from './logger.ts';

export interface CodePortConfig {
  readonly enabled: boolean;
  readonly definitionEnabled: boolean;
  readonly referencesEnabled: boolean;
  readonly hoverEnabled: boolean;
  readonly codeLinkEnabled: boolean;
  readonly codeLinkRelativeToMarkdown: boolean;
  readonly policy: PolicyId;
  readonly indexAcceptConfidence: number;
  readonly indexEnabled: boolean;
  readonly indexPrewarm: boolean;
  readonly indexReferences: boolean;
  readonly indexMaxFileSize: number;
  readonly indexExclude: readonly string[];
  readonly languages: Readonly<Record<string, string>>;
  readonly clangdPath: string;
  readonly clangdArguments: readonly string[];
  readonly clangdCompileCommandsDir: string;
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
    policy: config.get<PolicyId>('policy', 'index-first'),
    indexAcceptConfidence: config.get<number>('policy.indexAcceptConfidence', 0.85),
    indexEnabled: config.get<boolean>('index.enabled', true),
    indexPrewarm: config.get<boolean>('index.prewarm', true),
    indexReferences: config.get<boolean>('index.references', false),
    indexMaxFileSize: config.get<number>('index.maxFileSize', 2 * 1024 * 1024),
    indexExclude: config.get<string[]>('index.exclude', []),
    languages: config.get<Record<string, string>>('languages', {}),
    clangdPath: config.get<string>('clangd.path', ''),
    clangdArguments: config.get<string[]>('clangd.arguments', []),
    clangdCompileCommandsDir: config.get<string>('clangd.compileCommandsDir', ''),
    trace: config.get<LogLevel>('trace', 'messages'),
  };
}

/* --------------------------- legacy migration --------------------------- */

interface MigrationSpec {
  readonly legacyKey: string;
  readonly newKey: string;
}

/** The three settings the old `md-code-links` extension contributed. */
const MIGRATIONS: readonly MigrationSpec[] = [
  { legacyKey: 'enableFunctionJump', newKey: 'definition.enabled' },
  { legacyKey: 'prewarmIndex', newKey: 'index.prewarm' },
  { legacyKey: 'clangdPath', newKey: 'clangd.path' },
];

export interface PendingMigration {
  readonly from: string;
  readonly to: string;
  readonly value: unknown;
  readonly target: vscode.ConfigurationTarget;
}

/**
 * Legacy settings that hold an explicit value while the new key does not.
 * `undefined` values (i.e. only the default) are never migrated.
 */
export function pendingMigrations(): PendingMigration[] {
  const pending: PendingMigration[] = [];

  for (const spec of MIGRATIONS) {
    const legacy = vscode.workspace
      .getConfiguration(LEGACY_CONFIG_SECTION)
      .inspect(spec.legacyKey);
    if (!legacy) continue;

    // Prefer the most specific scope the user actually set.
    let value: unknown;
    let target = vscode.ConfigurationTarget.Global;
    if (legacy.workspaceFolderValue !== undefined) {
      value = legacy.workspaceFolderValue;
      // `update` needs a resource for WorkspaceFolder scope; Workspace is the
      // closest safe equivalent when migrating from another window's config.
      target = vscode.ConfigurationTarget.Workspace;
    } else if (legacy.workspaceValue !== undefined) {
      value = legacy.workspaceValue;
      target = vscode.ConfigurationTarget.Workspace;
    } else if (legacy.globalValue !== undefined) {
      value = legacy.globalValue;
      target = vscode.ConfigurationTarget.Global;
    } else {
      continue;
    }

    const current = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect(spec.newKey);
    const alreadySet =
      current !== undefined &&
      (current.globalValue !== undefined ||
        current.workspaceValue !== undefined ||
        current.workspaceFolderValue !== undefined);
    if (alreadySet) continue;

    pending.push({
      from: `${LEGACY_CONFIG_SECTION}.${spec.legacyKey}`,
      to: `${CONFIG_SECTION}.${spec.newKey}`,
      value,
      target,
    });
  }

  return pending;
}

/** Write migrated values. Returns how many were written. */
export async function applyMigrations(list: readonly PendingMigration[]): Promise<number> {
  let written = 0;
  for (const migration of list) {
    const key = migration.to.slice(CONFIG_SECTION.length + 1);
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(key, migration.value, migration.target);
    written++;
  }
  return written;
}

/**
 * Called once at activation: offer (never force) the migration.
 * The "never show again" choice is stored in `globalState`, not in settings, so
 * CodePort does not have to register a configuration key just for itself.
 */
export async function offerLegacyMigration(context: vscode.ExtensionContext): Promise<void> {
  const DISMISS_KEY = 'codeport.legacyMigrationDismissed';
  if (context.globalState.get<boolean>(DISMISS_KEY)) return;

  const pending = pendingMigrations();
  if (pending.length === 0) return;

  const summary = pending.map((entry) => `${entry.from} → ${entry.to}`).join(', ');
  const choice = await vscode.window.showInformationMessage(
    `CodePort replaced the md-code-links extension. Migrate ${pending.length} setting(s)? (${summary})`,
    'Migrate',
    'Later',
    'Never show again'
  );

  if (choice === 'Migrate') {
    const written = await applyMigrations(pending);
    void vscode.window.showInformationMessage(`CodePort: migrated ${written} setting(s).`);
  } else if (choice === 'Never show again') {
    await context.globalState.update(DISMISS_KEY, true);
  }
}
