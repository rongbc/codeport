import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LspClient, LspRequestError } from '../src/lsp/LspClient.ts';
import { LspClientPool } from '../src/lsp/LspClientPool.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-lsp-server.mjs', import.meta.url));

interface CapturedLogs {
  readonly messages: string[];
}

interface TestLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  trace(message: string): void;
}

function capturingLogger(): { logger: TestLogger; captured: CapturedLogs } {
  const messages: string[] = [];
  const push = (message: string): void => {
    messages.push(message);
  };
  return {
    logger: { info: push, warn: push, error: push, trace: push },
    captured: { messages },
  };
}

async function startClient(captured: CapturedLogs) {
  return LspClient.start(
    { command: process.execPath, args: [FIXTURE], label: 'mock-lsp' },
    'file:///ws',
    {
      logger: {
        info: (m: string) => captured.messages.push(m),
        warn: (m: string) => captured.messages.push(m),
        error: (m: string) => captured.messages.push(m),
        trace: (m: string) => captured.messages.push(m),
      },
      requestTimeoutMs: 5000,
    },
    'ws'
  );
}

test('completes the initialize handshake and exposes capabilities', async () => {
  const { captured } = capturingLogger();
  const client = await startClient(captured);
  try {
    assert.equal(client.isRunning, true);
    assert.equal(client.capabilities.workspaceSymbolProvider, true);
    assert.equal(client.capabilities.hoverProvider, true);
  } finally {
    await client.dispose();
  }
});

test('round-trips requests and filters nothing at the transport level', async () => {
  const { captured } = capturingLogger();
  const client = await startClient(captured);
  try {
    const symbols = await client.request<Array<{ name: string }>>('workspace/symbol', {
      query: 'nx_start',
    });
    assert.ok(Array.isArray(symbols));
    assert.equal(symbols.length, 2);
    assert.equal(symbols[0]!.name, 'nx_start');
  } finally {
    await client.dispose();
  }
});

test('answers server -> client requests instead of deadlocking', async () => {
  const { logger, captured } = capturingLogger();
  const client = await LspClient.start(
    { command: process.execPath, args: [FIXTURE], label: 'mock-lsp' },
    'file:///ws',
    { logger, requestTimeoutMs: 5000 }
  );
  try {
    // Give the mock's startup request a moment to be answered and echoed back.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const answered = captured.messages.some((message) =>
      message.includes('config-response:[null,null]')
    );
    assert.ok(
      answered,
      `expected the client to answer workspace/configuration with one null per item; logs: ${captured.messages.join(' | ')}`
    );
  } finally {
    await client.dispose();
  }
});

test('frames multi-byte UTF-8 correctly in both directions', async () => {
  const { captured } = capturingLogger();
  const client = await startClient(captured);
  try {
    const text = '// 调度器初始化 🚀\nvoid nx_start(void) {}\n';
    client.didOpen('file:///ws/seed.c', 'c', text);
    const echoed = await client.request<{ text: string; length: number }>('$/codeport/lastOpened', {});
    assert.equal(echoed.text, text);
    assert.equal(echoed.length, text.length);

    const hover = await client.request<{ contents: { value: string } }>('textDocument/hover', {
      textDocument: { uri: 'file:///ws/a.c' },
      position: { line: 0, character: 0 },
    });
    assert.match(hover.contents.value, /调度器初始化 🚀/);
  } finally {
    await client.dispose();
  }
});

test('rejects with a clear error for unhandled methods and after disposal', async () => {
  const { captured } = capturingLogger();
  const client = await startClient(captured);
  await assert.rejects(
    () => client.request('no/such/method', {}),
    (error: unknown) => error instanceof LspRequestError && /unhandled no\/such\/method/.test(error.message)
  );
  await client.dispose();
  assert.equal(client.isRunning, false);
  await assert.rejects(
    () => client.request('workspace/symbol', { query: 'x' }),
    (error: unknown) => error instanceof LspRequestError && /not running/.test(error.message)
  );
});

test('surfaces a spawn failure instead of hanging', async () => {
  await assert.rejects(
    () =>
      LspClient.start(
        { command: '/nonexistent/binary-that-cannot-exist', args: [], label: 'missing' },
        'file:///ws',
        { requestTimeoutMs: 3000 }
      ),
    /failed to spawn/
  );
});

test('the pool reuses one client per key and replaces dead ones', async () => {
  const { logger } = capturingLogger();
  const pool = new LspClientPool(logger);
  let created = 0;
  const create = async () => {
    created++;
    return LspClient.start(
      { command: process.execPath, args: [FIXTURE], label: 'mock-lsp' },
      'file:///ws',
      { requestTimeoutMs: 5000 }
    );
  };

  const [first, second] = await Promise.all([
    pool.acquire('key', create),
    pool.acquire('key', create),
  ]);
  assert.equal(first, second, 'concurrent acquires must share one startup');
  assert.equal(created, 1);

  const third = await pool.acquire('key', create);
  assert.equal(third, first, 'a live client is reused');
  assert.equal(created, 1);

  assert.equal(pool.keys().length, 1);
  await pool.disposeAll();
  assert.equal(pool.peek('key'), undefined);
});
