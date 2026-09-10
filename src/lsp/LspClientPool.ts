/**
 * A small pool of language-server clients, keyed by `adapter id + project root`.
 *
 * Concurrent requests for the same key share one startup, and a dead client is
 * transparently replaced on the next acquire.
 */

import type { LspClient, LspLogger } from './LspClient.ts';

export class LspClientPool {
  private readonly live = new Map<string, LspClient>();
  private readonly inflight = new Map<string, Promise<LspClient>>();
  private readonly logger: LspLogger;

  constructor(logger: LspLogger) {
    this.logger = logger;
  }

  /**
   * Return a running client for `key`, creating it with `create` when necessary.
   * A rejected `create` is not cached, so a later call can retry.
   */
  async acquire(key: string, create: () => Promise<LspClient>): Promise<LspClient> {
    const existing = this.live.get(key);
    if (existing?.isRunning) return existing;

    if (existing) {
      this.logger.warn(`[pool] replacing dead client for ${key}`);
      this.live.delete(key);
      void existing.dispose();
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const creation = (async () => {
      try {
        const client = await create();
        this.live.set(key, client);
        return client;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, creation);
    return creation;
  }

  /** The live client for `key`, if any. */
  peek(key: string): LspClient | undefined {
    const client = this.live.get(key);
    return client?.isRunning ? client : undefined;
  }

  keys(): string[] {
    return [...new Set([...this.live.keys(), ...this.inflight.keys()])];
  }

  async disposeKey(key: string): Promise<void> {
    const client = this.live.get(key);
    this.live.delete(key);
    if (client) await client.dispose();
  }

  async disposeAll(): Promise<void> {
    const clients = [...this.live.values()];
    this.live.clear();
    await Promise.all(clients.map((client) => client.dispose()));
  }
}
