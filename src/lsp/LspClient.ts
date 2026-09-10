/**
 * A minimal LSP client over stdio.
 *
 * This is the generic transport that used to be hard-wired to clangd inside
 * `extension.js`. It knows nothing about any specific language server: adapters
 * supply the command, arguments and seed files.
 *
 * Framing is byte-accurate (a `Buffer` accumulator plus `Content-Length` in
 * bytes) so multi-byte UTF-8 in source text cannot desynchronise the stream.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LspInitializeResult, LspServerCapabilities } from './protocol.ts';

export interface LspServerSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Human readable label used in log messages, e.g. `clangd`. */
  readonly label?: string;
}

export interface LspLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  trace?(message: string): void;
}

export interface LspClientOptions {
  readonly logger?: LspLogger;
  /** Per-request timeout. Default 20s. */
  readonly requestTimeoutMs?: number;
  /** `initialize` handshake timeout. Default 30s. */
  readonly initializeTimeoutMs?: number;
  /** Grace period before SIGKILL on dispose. Default 2s. */
  readonly shutdownGraceMs?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export class LspRequestError extends Error {
  readonly method: string;
  readonly code: number | undefined;

  // Written out longhand (no parameter properties): Node's type-stripping used by
  // the unit tests supports only "strip-only" TypeScript syntax.
  constructor(message: string, method: string, code?: number) {
    super(message);
    this.name = 'LspRequestError';
    this.method = method;
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

export class LspClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly spec: LspServerSpec;
  private readonly options: LspClientOptions;
  private readonly logger: LspLogger;
  private readonly requestTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly opened = new Set<string>();

  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private disposed = false;
  private exited = false;
  private disposePromise: Promise<void> | undefined;
  private serverCapabilities: LspServerCapabilities = {};

  private constructor(proc: ChildProcessWithoutNullStreams, spec: LspServerSpec, options: LspClientOptions) {
    this.proc = proc;
    this.spec = spec;
    this.options = options;
    this.logger = options.logger ?? silentLogger();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.logger.trace?.(`[${this.label}] ${text}`);
    });
    proc.on('exit', (code, signal) => this.onExit(code, signal));
    proc.on('error', (error: Error) => {
      // A failed spawn emits `error` and may never emit `exit`; marking the
      // client as stopped keeps dispose() from waiting out the grace period.
      this.exited = true;
      this.logger.warn(`[${this.label}] process error: ${error.message}`);
      this.abortPending(new LspRequestError(`${this.label} failed to start: ${error.message}`, 'spawn'));
    });
  }

  get label(): string {
    return this.spec.label ?? this.spec.command;
  }

  get capabilities(): LspServerCapabilities {
    return this.serverCapabilities;
  }

  get isRunning(): boolean {
    return !this.disposed && !this.exited;
  }

  /**
   * Spawn a server and complete the `initialize` / `initialized` handshake.
   * Rejects when the process cannot be started or the handshake fails.
   */
  static async start(
    spec: LspServerSpec,
    rootUri: string,
    options: LspClientOptions = {},
    workspaceName?: string
  ): Promise<LspClient> {
    const logger = options.logger ?? silentLogger();
    logger.info(`[${spec.label ?? spec.command}] starting: ${spec.command} ${spec.args.join(' ')}`);

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`failed to spawn ${spec.command}: ${(error as Error).message}`);
    }

    const client = new LspClient(proc, spec, options);

    // `spawn` reports ENOENT asynchronously; surface it as a start failure.
    const spawnFailure = new Promise<never>((_, reject) => {
      proc.once('error', (error: Error) => {
        reject(new Error(`failed to spawn ${spec.command}: ${error.message}`));
      });
    });

    const handshake = (async (): Promise<void> => {
      const result = await client.request<LspInitializeResult>(
        'initialize',
        {
          processId: process.pid,
          clientInfo: {
            name: options.clientName ?? 'CodePort',
            version: options.clientVersion ?? '0.1.0',
          },
          rootUri,
          workspaceFolders: workspaceName ? [{ uri: rootUri, name: workspaceName }] : undefined,
          capabilities: {
            workspace: { symbol: { dynamicRegistration: false } },
            textDocument: {
              definition: { dynamicRegistration: false },
              references: { dynamicRegistration: false },
              hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
              documentSymbol: { dynamicRegistration: false },
              synchronization: { dynamicRegistration: false },
            },
          },
        },
        client.initializeTimeoutMs
      );
      client.serverCapabilities = result?.capabilities ?? {};
      client.notify('initialized', {});
    })();

    try {
      await Promise.race([handshake, spawnFailure]);
    } catch (error) {
      await client.dispose();
      throw error;
    }

    return client;
  }

  /** Send a request and resolve with its result. Rejects on LSP error or timeout. */
  request<T>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (!this.isRunning || !this.proc.stdin.writable) {
      return Promise.reject(new LspRequestError(`${this.label} is not running`, method));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspRequestError(`${method} timed out after ${timeoutMs}ms`, method));
      }, timeoutMs);
      // Do not keep the extension host alive just for a pending request.
      timer.unref?.();
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Fire-and-forget notification. */
  notify(method: string, params: unknown): void {
    if (!this.isRunning) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  didOpen(uri: string, languageId: string, text: string, version = 1): void {
    this.opened.add(uri);
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    });
  }

  /**
   * Open a document once. Needed before position-based requests
   * (`textDocument/references`, `hover`) against a file the user never opened:
   * a server may not know about it otherwise.
   */
  ensureOpen(uri: string, languageId: string, text: string, version = 1): void {
    if (this.opened.has(uri)) return;
    this.didOpen(uri, languageId, text, version);
  }

  isOpen(uri: string): boolean {
    return this.opened.has(uri);
  }

  didClose(uri: string): void {
    this.opened.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /**
   * Graceful `shutdown` / `exit`, then SIGKILL after a grace period.
   *
   * Always resolves, and is safe to call repeatedly: concurrent and later calls
   * await and return the same completion.
   */
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.runDispose();
    return this.disposePromise;
  }

  private async runDispose(): Promise<void> {
    // The graceful handshake must happen while the client still counts as
    // running, otherwise `request`/`notify` would refuse to send it and every
    // shutdown would wait out the full kill grace period.
    if (this.isRunning) {
      try {
        await this.request('shutdown', null, 2_000);
      } catch {
        /* server may already be gone */
      }
      this.notify('exit', null);
    }
    this.disposed = true;

    const exited = new Promise<void>((resolve) => {
      if (this.exited) return resolve();
      this.proc.once('exit', () => resolve());
    });
    const forced = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, this.shutdownGraceMs);
      timer.unref?.();
    });
    await Promise.race([exited, forced]);

    // Reject anything still in flight so callers do not hang.
    this.abortPending(new LspRequestError(`${this.label} was disposed`, 'dispose'));
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private write(message: unknown): void {
    if (!this.proc.stdin.writable) return;
    const json = JSON.stringify(message);
    const payload = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    try {
      this.proc.stdin.write(payload);
    } catch (error) {
      this.logger.warn(`[${this.label}] write failed: ${(error as Error).message}`);
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed header: drop it and resynchronise on the next message.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(body);
    }
  }

  private dispatch(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.logger.warn(`[${this.label}] dropped malformed JSON message`);
      return;
    }

    const id = message.id as number | undefined;
    const method = message.method as string | undefined;

    // Response to one of our requests.
    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = message.error as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(
          new LspRequestError(error.message ?? 'unknown LSP error', pending.method, error.code)
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server -> client request: answer so the server is never left blocked.
    if (id !== undefined && method !== undefined) {
      this.write({ jsonrpc: '2.0', id, result: this.serverRequestResult(method, message.params) });
      return;
    }

    // Server -> client notification.
    if (method === 'window/logMessage' || method === 'window/showMessage') {
      const params = message.params as { message?: string } | undefined;
      if (params?.message) this.logger.trace?.(`[${this.label}] ${params.message}`);
    }
  }

  private serverRequestResult(method: string, params: unknown): unknown {
    if (method === 'workspace/configuration') {
      const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
      return items.map(() => null);
    }
    // `client/registerCapability`, `window/workDoneProgress/create`, ...
    return null;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    if (this.disposed) return;
    this.logger.warn(`[${this.label}] exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    this.abortPending(new LspRequestError(`${this.label} exited`, 'exit'));
  }

  private abortPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function silentLogger(): LspLogger {
  return { info() {}, warn() {}, error() {} };
}
