/**
 * A detected language project (plan section 5).
 *
 * `Project` is the only thing the core ever knows about a language's build
 * layout: C/C++ reports `compile_commands.json`, Rust will report `Cargo.toml`,
 * and so on. CodePort itself never reads those files.
 */

export interface Project {
  /** Absolute project root. */
  readonly root: string;
  /** Adapter that owns this project, e.g. `clangd`. */
  readonly adapterId: string;
  /** Primary language id, e.g. `cpp`. */
  readonly language: string;
  /** Files that made detection succeed, for UI/logging. */
  readonly markers: readonly string[];
  /** For C/C++: the directory holding `compile_commands.json`. */
  readonly compileCommandsDir?: string;
}

/** Stable cache key for a project. */
export function projectKey(project: Project): string {
  return `${project.adapterId}:${project.root}`;
}
