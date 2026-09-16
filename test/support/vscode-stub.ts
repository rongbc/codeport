/**
 * A minimal `vscode` API stub.
 *
 * CodePort's integration layer cannot be exercised by launching VS Code in CI, so
 * this stub implements exactly the surface the extension touches. Combined with
 * the real esbuild bundle and a real temp project, it makes an end-to-end test
 * possible: Markdown text in, resolved source location out.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createRequire } from 'node:module';

/** `require` that works from this ES module. */
const requireCjs = createRequire(import.meta.url);

export interface StubOptions {
  readonly workspaceRoot: string;
  readonly settings?: Record<string, unknown>;
  /** Absolute path the extension "lives" at (so `dist/wasm` resolves). */
  readonly extensionPath: string;
}

export interface StubState {
  readonly statusMessages: string[];
  readonly infoMessages: string[];
  readonly warningMessages: string[];
  readonly logLines: string[];
  readonly registeredCommands: Map<string, (...args: any[]) => unknown>;
  readonly registeredLanguages: Set<string>;
  readonly disposed: { count: number };
}

export interface StubHandle {
  readonly vscode: any;
  readonly stub: StubState;
  /** Provider implementations captured at registration time, by kind. */
  readonly providers: Map<string, any>;
  readonly restore: () => void;
}

export function installVscodeStub(options: StubOptions): StubHandle {
  const state: StubState = {
    statusMessages: [],
    infoMessages: [],
    warningMessages: [],
    logLines: [],
    registeredCommands: new Map(),
    registeredLanguages: new Set(),
    disposed: { count: 0 },
  };

  const settings = { ...(options.settings ?? {}) };

  // NOTE: written without TypeScript parameter properties on purpose — Node's
  // type-stripping (used to run these tests) only supports strip-only syntax.
  class Position {
    line: number;
    character: number;
    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  }

  // Mirrors the real VS Code overloads: (start, end) *and*
  // (startLine, startCharacter, endLine, endCharacter).
  class Range {
    start: Position;
    end: Position;
    constructor(
      startOrLine: Position | number,
      endOrCharacter: Position | number,
      endLine?: number,
      endCharacter?: number
    ) {
      if (typeof startOrLine === 'number') {
        this.start = new Position(startOrLine, endOrCharacter as number);
        this.end = new Position(endLine ?? startOrLine, endCharacter ?? (endOrCharacter as number));
      } else {
        this.start = startOrLine;
        this.end = endOrCharacter as Position;
      }
    }
  }

  class Uri {
    readonly scheme: string;
    readonly fsPath: string;
    readonly fragment: string;
    private constructor(scheme: string, fsPath: string, fragment = '') {
      this.scheme = scheme;
      this.fsPath = fsPath;
      this.fragment = fragment;
    }

    static file(fsPath: string): Uri {
      return new Uri('file', fsPath, '');
    }

    static parse(value: string): Uri {
      const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(value);
      if (!match) return new Uri('file', value, '');
      const scheme = match[1]!;
      const rest = match[2]!;
      const hashIndex = rest.indexOf('#');
      const fragment = hashIndex >= 0 ? rest.slice(hashIndex + 1) : '';
      const withoutFragment = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
      return new Uri(scheme, decodeURIComponent(withoutFragment), fragment);
    }

    with(change: { fragment?: string }): Uri {
      return new Uri(this.scheme, this.fsPath, change.fragment ?? this.fragment);
    }

    toString(): string {
      const base = `${this.scheme}://${encodeURI(this.fsPath)}`;
      return this.fragment ? `${base}#${this.fragment}` : base;
    }
  }

  class Location {
    uri: Uri;
    range: Range;
    constructor(uri: Uri, range: Range) {
      this.uri = uri;
      this.range = range;
    }
  }

  class DocumentLink {
    range: Range;
    target?: Uri;
    tooltip?: string;
    constructor(range: Range, target?: Uri) {
      this.range = range;
      this.target = target;
    }
  }

  class MarkdownString {
    value = '';
    supportThemeIcons = false;
    isTrusted = false;
    constructor(value?: string, _supportThemeIcons?: boolean) {
      this.value = value ?? '';
    }
    appendMarkdown(text: string): MarkdownString {
      this.value += text;
      return this;
    }
    appendCodeblock(code: string, language?: string): MarkdownString {
      this.value += `\n\`\`\`${language ?? ''}\n${code}\n\`\`\`\n`;
      return this;
    }
  }

  class Hover {
    contents: MarkdownString;
    range?: Range;
    constructor(contents: MarkdownString, range?: Range) {
      this.contents = contents;
      this.range = range;
    }
  }

  const disposable = () => ({ dispose: () => void state.disposed.count++ });

  /** Provider implementations captured at registration time, keyed by kind. */
  const registered = new Map<string, any>();

  const folder = { uri: Uri.file(options.workspaceRoot), name: 'ws', index: 0 };

  function getConfiguration(section: string): any {
    const prefix = section ? `${section}.` : '';
    const scoped = new Map<string, unknown>();
    for (const [key, value] of Object.entries(settings)) {
      if (key.startsWith(prefix)) scoped.set(key.slice(prefix.length), value);
    }
    return {
      get: (key: string, fallback?: unknown) => (scoped.has(key) ? scoped.get(key) : fallback),
    };
  }

  const vscode: any = {
    Position,
    Range,
    Uri,
    Location,
    DocumentLink,
    MarkdownString,
    Hover,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
      workspaceFolders: [folder],
      getWorkspaceFolder: (uri: Uri) =>
        uri.fsPath.startsWith(options.workspaceRoot) ? folder : undefined,
      getConfiguration,
      onDidChangeConfiguration: () => disposable(),
      onDidChangeWorkspaceFolders: () => disposable(),
      onDidCloseTextDocument: () => disposable(),
    },
    languages: {
      registerDefinitionProvider: (selector: any, provider: any) => {
        state.registeredLanguages.add(selector.language);
        registered.set('definition', provider);
        return disposable();
      },
      registerReferenceProvider: (_selector: any, provider: any) => {
        registered.set('reference', provider);
        return disposable();
      },
      registerHoverProvider: (_selector: any, provider: any) => {
        registered.set('hover', provider);
        return disposable();
      },
      registerDocumentLinkProvider: (_selector: any, provider: any) => {
        registered.set('documentLink', provider);
        return disposable();
      },
    },
    window: {
      createOutputChannel: (name: string) => ({
        name,
        appendLine: (line: string) => state.logLines.push(line),
        show: () => {},
        dispose: () => {},
      }),
      setStatusBarMessage: (message: string, _promiseOrTimeout?: unknown) => {
        state.statusMessages.push(message);
        return disposable();
      },
      showInformationMessage: async (message: string) => {
        state.infoMessages.push(message);
        return undefined;
      },
      showWarningMessage: async (message: string) => {
        state.warningMessages.push(message);
        return undefined;
      },
    },
    env: {
      clipboard: {
        writeText: async (_value: string) => {},
      },
    },
    commands: {
      registerCommand: (id: string, callback: (...args: any[]) => unknown) => {
        state.registeredCommands.set(id, callback);
        return disposable();
      },
      executeCommand: async (id: string) => {
        const command = state.registeredCommands.get(id);
        if (command) await command();
      },
    },
  };

  // Intercept the bundle's `require('vscode')`.
  const nodeModule = requireCjs('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = nodeModule._load;
  nodeModule._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };

  return {
    vscode,
    stub: state,
    providers: registered,
    restore: () => {
      nodeModule._load = originalLoad;
    },
  };
}
