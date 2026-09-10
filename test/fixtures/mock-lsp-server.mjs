/**
 * A tiny, dependency-free LSP server used to exercise `LspClient`.
 *
 * clangd is not installed in every environment, so the transport is verified
 * against this script instead. It deliberately:
 *   - speaks the same `Content-Length` framing (so a client framing bug shows up)
 *   - sends a server -> client request (`workspace/configuration`) at startup, to
 *     prove the client answers instead of deadlocking the server
 *   - round-trips multi-byte UTF-8 text, to prove byte-accurate framing
 *
 * Run with: node test/fixtures/mock-lsp-server.mjs
 */

let buffer = Buffer.alloc(0);
const opened = new Map();
let lastOpenedUri = null;

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

const SYMBOLS = [
  {
    name: 'nx_start',
    kind: 12,
    containerName: 'nx',
    location: {
      uri: 'file:///ws/sched/init/nx_start.c',
      range: { start: { line: 122, character: 5 }, end: { line: 122, character: 13 } },
    },
  },
  {
    name: 'nx_start_extra',
    kind: 12,
    location: {
      uri: 'file:///ws/sched/init/nx_start_extra.c',
      range: { start: { line: 7, character: 5 }, end: { line: 7, character: 19 } },
    },
  },
];

function handle(message) {
  const { id, method, params } = message;

  // Responses to our own server -> client requests.
  if (method === undefined && id === 900) {
    send({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: { type: 3, message: `config-response:${JSON.stringify(message.result)}` },
    });
    return;
  }

  switch (method) {
    case 'initialize':
      respond(id, {
        capabilities: {
          workspaceSymbolProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          hoverProvider: true,
        },
        serverInfo: { name: 'mock-lsp', version: '1.0.0' },
      });
      break;

    case 'initialized':
      // Ask the client something so we can prove it replies.
      send({
        jsonrpc: '2.0',
        id: 900,
        method: 'workspace/configuration',
        params: { items: [{ section: 'codeport' }, { section: 'codeport.index' }] },
      });
      break;

    case 'workspace/symbol': {
      const query = params?.query ?? '';
      respond(
        id,
        SYMBOLS.filter((symbol) => symbol.name.includes(query))
      );
      break;
    }

    case 'textDocument/definition':
      respond(id, SYMBOLS[0].location);
      break;

    case 'textDocument/references':
      respond(id, [SYMBOLS[0].location, SYMBOLS[1].location]);
      break;

    case 'textDocument/hover':
      respond(id, {
        contents: { kind: 'markdown', value: '```c\nvoid nx_start(void)\n```\n\n调度器初始化 🚀' },
      });
      break;

    case 'textDocument/didOpen': {
      const doc = params?.textDocument;
      if (doc?.uri) {
        opened.set(doc.uri, doc.text ?? '');
        lastOpenedUri = doc.uri;
      }
      break;
    }

    case 'textDocument/didClose':
      break;

    case '$/codeport/lastOpened': {
      const text = lastOpenedUri ? opened.get(lastOpenedUri) ?? '' : '';
      respond(id, { uri: lastOpenedUri, text, length: text.length });
      break;
    }

    case 'shutdown':
      respond(id, null);
      break;

    case 'exit':
      process.exit(0);
      break;

    default:
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unhandled ${method}` } });
      }
  }
}

process.stdin.on('data', (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // A malformed frame means the test should fail; surface it loudly.
      send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 1, message: 'parse-error' } });
    }
  }
});
