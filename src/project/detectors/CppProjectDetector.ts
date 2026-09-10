/**
 * C/C++ project detection.
 *
 * Looks for the two markers clangd understands: `compile_commands.json` (the
 * compilation database) and `.clangd` (a per-directory config file).
 *
 * Search order preserves the original extension's behaviour first — the
 * workspace root — and then improves on it by walking up from the Markdown file
 * to the workspace root, so a `docs/` subfolder of a CMake project just works.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ProjectDetector } from '../ProjectDetector.ts';
import type { Project } from '../Project.ts';

export interface CppProjectDetectorOptions {
  /** User-configured directory holding compile_commands.json. */
  readonly compileCommandsDir?: string;
  /** How many parent directories to inspect between the file and the root. */
  readonly maxAncestors?: number;
}

const COMPILE_COMMANDS = 'compile_commands.json';
const CLANGD_CONFIG = '.clangd';

export class CppProjectDetector implements ProjectDetector {
  readonly id = 'cpp';
  readonly languages = ['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda-cpp'];
  private readonly options: CppProjectDetectorOptions;

  constructor(options: CppProjectDetectorOptions = {}) {
    this.options = options;
  }

  detect(filePath: string, workspaceRoot: string): Project | undefined {
    const configured = this.options.compileCommandsDir;
    if (configured) {
      const project = this.projectFromDirectory(configured, 'configured compileCommandsDir');
      if (project) return project;
    }

    const direct = this.detectWorkspace(workspaceRoot);
    if (direct) return direct;

    // Walk up from the file, stopping at (and including) the workspace root.
    const root = path.resolve(workspaceRoot);
    let dir = path.dirname(path.resolve(filePath));
    const maxAncestors = this.options.maxAncestors ?? 8;
    for (let i = 0; i < maxAncestors; i++) {
      const project = this.projectFromDirectory(dir, 'ancestor of Markdown file');
      if (project) return project;
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  }

  detectWorkspace(workspaceRoot: string): Project | undefined {
    return this.projectFromDirectory(workspaceRoot, 'workspace root');
  }

  /** Build a project when `dir` holds a recognised marker. */
  private projectFromDirectory(dir: string, origin: string): Project | undefined {
    const markers: string[] = [];
    let compileCommandsDir: string | undefined;

    try {
      if (fs.statSync(dir).isDirectory()) {
        if (fs.existsSync(path.join(dir, COMPILE_COMMANDS))) {
          markers.push(COMPILE_COMMANDS);
          compileCommandsDir = dir;
        }
        if (fs.existsSync(path.join(dir, CLANGD_CONFIG))) {
          markers.push(CLANGD_CONFIG);
        }
      }
    } catch {
      return undefined;
    }

    if (markers.length === 0) return undefined;
    return {
      root: path.resolve(dir),
      adapterId: 'clangd',
      language: 'cpp',
      markers: markers.map((marker) => `${marker} (${origin})`),
      compileCommandsDir,
    };
  }
}
