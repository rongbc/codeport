/**
 * `LanguageManager` — the three-level language strategy (plan section 7).
 *
 * 1. A code fence's info string is the strongest signal.
 * 2. Otherwise the document's own project (a `docs/` folder inside a CMake tree
 *    is still C/C++).
 * 3. Otherwise CodePort tries every project in the workspace and, if none
 *    answers, reports "no definition found" rather than guessing.
 *
 * It implements `LspTargetProvider`, which is how the resolver layer gets
 * adapter/project pairs without knowing anything about workspaces or settings.
 */

import type { AdapterRegistry } from '../adapters/AdapterRegistry.ts';
import type { LanguageAdapter } from '../adapters/LanguageAdapter.ts';
import type { Project } from '../project/Project.ts';
import type { ResolveContext } from '../resolution/Resolver.ts';
import type { LspTarget, LspTargetProvider } from '../resolution/LspResolver.ts';
import type { ResolvedTarget } from '../types.ts';
import { projectKey } from '../project/Project.ts';
import { tryUriToPath } from '../util/uri.ts';
import type { ProjectManager } from './ProjectManager.ts';
import type { CodePortConfig } from '../config.ts';
import type { Logger } from '../logger.ts';

export interface LanguageManagerOptions {
  readonly registry: AdapterRegistry;
  readonly projects: ProjectManager;
  readonly getConfig: () => CodePortConfig;
  readonly logger: Logger;
}

export class LanguageManager implements LspTargetProvider {
  private readonly registry: AdapterRegistry;
  private readonly projects: ProjectManager;
  private readonly getConfig: () => CodePortConfig;
  private readonly logger: Logger;

  constructor(options: LanguageManagerOptions) {
    this.registry = options.registry;
    this.projects = options.projects;
    this.getConfig = options.getConfig;
    this.logger = options.logger;
  }

  /**
   * Which level decided the language, for a given fence language and document.
   * Used for logging and for the hover's "why" line.
   */
  describeTarget(
    fenceLanguage: string | undefined,
    documentUri: string
  ): ResolvedTarget | undefined {
    const config = this.getConfig();
    const documentPath = tryUriToPath(documentUri);

    if (fenceLanguage) {
      const adapter = this.registry.forLanguage(fenceLanguage, config.languages);
      if (adapter) {
        const project = this.projects.projectForAdapter(
          adapter,
          documentPath,
          documentPath ? this.projects.workspaceRootForPath(documentPath) : undefined
        );
        return {
          language: fenceLanguage,
          adapterId: adapter.id,
          projectRoot: project?.root,
          source: 'fence',
        };
      }
    }

    if (documentPath) {
      const project = this.projects.projectForPath(documentPath);
      if (project) {
        return {
          language: project.language,
          adapterId: project.adapterId,
          projectRoot: project.root,
          source: 'workspace',
        };
      }
    }

    return undefined;
  }

  /**
   * Adapter/project pairs to try for a mention, most specific first.
   * An empty list means CodePort will report "no definition found".
   */
  async resolveTargets(context: ResolveContext): Promise<readonly LspTarget[]> {
    const config = this.getConfig();
    const documentPath = tryUriToPath(context.documentUri);
    const workspaceRoot =
      context.workspaceRoot ?? (documentPath ? this.projects.workspaceRootForPath(documentPath) : undefined);

    const targets: LspTarget[] = [];
    const seen = new Set<string>();
    const add = (adapter: LanguageAdapter, project: Project | undefined): void => {
      if (!project) return;
      const key = projectKey(project);
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ adapter, project });
    };

    // Level 1: the fence told us the language.
    if (context.reference.language) {
      const adapter = this.registry.forLanguage(context.reference.language, config.languages);
      if (adapter) {
        add(adapter, this.projects.projectForAdapter(adapter, documentPath, workspaceRoot));
        if (targets.length > 0) {
          this.logger.trace(`[language] level 1 (fence "${context.reference.language}")`);
          return targets;
        }
      }
    }

    // Level 2: the document lives inside a detected project.
    if (documentPath) {
      const project = this.projects.projectForPath(documentPath);
      if (project) {
        const adapter = this.registry.get(project.adapterId);
        if (adapter) {
          add(adapter, project);
          this.logger.trace(`[language] level 2 (document project ${project.root})`);
        }
      }
    }

    // Level 3: try every project in the workspace; if none, nothing is guessed.
    if (targets.length === 0 && workspaceRoot) {
      for (const project of this.projects.projectsInWorkspace(workspaceRoot)) {
        const adapter = this.registry.get(project.adapterId);
        if (adapter) add(adapter, project);
      }
      if (targets.length > 0) {
        this.logger.trace(`[language] level 3 (workspace projects of ${workspaceRoot})`);
      }
    }

    return targets;
  }

  /** Adapter/project pair owning an absolute source file. */
  targetForFile(filePath: string): LspTarget | undefined {
    const project = this.projects.projectForFile(filePath);
    if (!project) return undefined;
    const adapter = this.registry.get(project.adapterId);
    if (!adapter) return undefined;
    return { adapter, project };
  }

  /**
   * Every adapter/project pair detected directly in a workspace root.
   * Used only to pre-warm engines; on-demand detection stays file-driven so a
   * project rooted in a subdirectory is still found when it is needed.
   */
  targetsForWorkspace(workspaceRoot: string): LspTarget[] {
    const targets: LspTarget[] = [];
    for (const project of this.projects.projectsInWorkspace(workspaceRoot)) {
      const adapter = this.registry.get(project.adapterId);
      if (adapter) targets.push({ adapter, project });
    }
    return targets;
  }
}
