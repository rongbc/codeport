/**
 * `ProjectManager` — the VS Code side of project discovery.
 *
 * Wraps every adapter's `ProjectDetector` with caching, because detection touches
 * the file system and is asked for on every hover / definition request. Results
 * are cached both per workspace folder and per Markdown directory.
 */

import * as vscode from 'vscode';
import path from 'node:path';
import type { AdapterRegistry } from '../adapters/AdapterRegistry.ts';
import type { LanguageAdapter } from '../adapters/LanguageAdapter.ts';
import type { Project } from '../project/Project.ts';
import type { Logger } from '../logger.ts';

export interface ProjectManagerOptions {
  readonly registry: AdapterRegistry;
  readonly logger: Logger;
}

export class ProjectManager {
  private readonly registry: AdapterRegistry;
  private readonly logger: Logger;

  /** workspace root -> projects detected for that root. */
  private readonly byWorkspace = new Map<string, Project[]>();
  /** `<workspaceRoot>\0<directory>` -> project owning that directory. */
  private readonly byDirectory = new Map<string, Project | undefined>();
  /** Absolute file path -> project owning that file. */
  private readonly byFile = new Map<string, Project | undefined>();

  constructor(options: ProjectManagerOptions) {
    this.registry = options.registry;
    this.logger = options.logger;
  }

  /** Absolute root of the workspace folder containing `uri`. */
  workspaceRootFor(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder?.uri.fsPath;
  }

  /** Absolute root of the workspace folder containing a file path. */
  workspaceRootForPath(filePath: string): string | undefined {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      if (filePath === root || filePath.startsWith(root + path.sep)) return root;
    }
    return undefined;
  }

  /** The project that owns a Markdown/source file, if any adapter claims it. */
  projectForPath(filePath: string): Project | undefined {
    const root = this.workspaceRootForPath(filePath);
    if (!root) return undefined;

    const key = `${root}\0${path.dirname(filePath)}`;
    if (this.byDirectory.has(key)) return this.byDirectory.get(key);

    let found: Project | undefined;
    for (const adapter of this.registry.all()) {
      const project = adapter.detector.detect(filePath, root);
      if (project) {
        found = project;
        break;
      }
    }
    this.byDirectory.set(key, found);
    if (found) {
      this.logger.trace(
        `[project] ${filePath} -> ${found.adapterId} @ ${found.root} [${found.markers.join(', ')}]`
      );
    }
    return found;
  }

  /** The project for one adapter, detected from a file (or the workspace root). */
  projectForAdapter(
    adapter: LanguageAdapter,
    filePath: string | undefined,
    workspaceRoot: string | undefined
  ): Project | undefined {
    if (filePath) {
      const root = this.workspaceRootForPath(filePath) ?? workspaceRoot;
      if (root) {
        const project = adapter.detector.detect(filePath, root);
        if (project) return project;
      }
    }
    if (workspaceRoot) return adapter.detector.detectWorkspace(workspaceRoot);
    return undefined;
  }

  /** Every project detectable in a workspace root, across all adapters. */
  projectsInWorkspace(workspaceRoot: string): Project[] {
    const cached = this.byWorkspace.get(workspaceRoot);
    if (cached) return cached;

    const projects: Project[] = [];
    for (const adapter of this.registry.all()) {
      const project = adapter.detector.detectWorkspace(workspaceRoot);
      if (project) projects.push(project);
    }
    this.byWorkspace.set(workspaceRoot, projects);
    return projects;
  }

  /** Project owning an absolute source file path (uses a separate cache). */
  projectForFile(filePath: string): Project | undefined {
    if (this.byFile.has(filePath)) return this.byFile.get(filePath);
    const project = this.projectForPath(filePath);
    this.byFile.set(filePath, project);
    return project;
  }

  /** Drop cached detection results (configuration changed, folders changed). */
  invalidate(): void {
    this.byWorkspace.clear();
    this.byDirectory.clear();
    this.byFile.clear();
  }
}
