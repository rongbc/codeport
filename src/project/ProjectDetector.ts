/**
 * Project detection abstraction (plan section 5).
 *
 * Adapters own their detector; the core never asks "where is
 * compile_commands.json" directly, it asks a detector for a `Project`.
 */

import type { Project } from './Project.ts';

export interface ProjectDetector {
  readonly id: string;
  /** Languages this detector can serve. */
  readonly languages: readonly string[];
  /**
   * Detect the project that owns `filePath` (absolute), given a workspace root.
   * Returns `undefined` when nothing matches — CodePort never guesses.
   */
  detect(filePath: string, workspaceRoot: string): Project | undefined;
  /** Detect a project for a workspace root, independent of any file. */
  detectWorkspace(workspaceRoot: string): Project | undefined;
}
