'use strict';

/**
 * Markdown Code Links
 *
 * 两类能力：
 *  1) 路径/行号链接：`` `/abs/path/file.c:502` `` 或 `` `project/path/file.c:502` `` → Ctrl+Click 打开文件定位行
 *  2) 【函数名跳转】代码块 / 行内代码里的标识符（如 `start_worker`）→ F12 或 Ctrl+Click
 *     直接调用 clangd（workspace/symbol）跳到定义，体验与 .c/.h 里一致
 *
 * 通用约定（不针对特定项目）：
 *  - compile_commands.json 必须在项目根目录（工作区根），不向上/向下搜索
 * clangd 客户端是最小 LSP over stdio 实现（零 npm 依赖），懒启动、常驻，
 * 首次查询时若后台索引未就绪会提示。
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/* ============================== 配置 ============================== */

function cfg() {
  return vscode.workspace.getConfiguration('mdCodeLinks');
}

/* ======================= 路径/行号链接（原有） ====================== */

const LINK_RE =
  /(?<!\]\()(?<![A-Za-z0-9_/.:\]\[])([A-Za-z0-9_.+/-]+\.(?:[ch]|cc|cpp|cxx|hpp|hh|S|asm))(?::(\d+))?/g;

function resolveFile(doc, p) {
  /* 1. 绝对路径 */
  if (path.isAbsolute(p)) {
    return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
  }
  /* 2. 相对项目根（工作区根） */
  const wf = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (wf) {
    const c = path.resolve(wf.uri.fsPath, p);
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch (e) { /* not exists */ }
  }
  return null;
}

function provideDocumentLinks(doc) {
  const links = [];
  const text = doc.getText();
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(text)) !== null) {
    const filePart = m[1];
    const line = m[2] ? parseInt(m[2], 10) : undefined;
    const abs = resolveFile(doc, filePart);
    if (!abs) continue;
    let uri = vscode.Uri.file(abs);
    if (line && line > 0) uri = uri.with({ fragment: 'L' + line });
    const start = doc.positionAt(m.index);
    const end = doc.positionAt(m.index + m[0].length);
    const link = new vscode.DocumentLink(new vscode.Range(start, end), uri);
    link.tooltip = abs + (line ? ':' + line : '');
    links.push(link);
  }
  return links;
}

/* ======================= 代码上下文 / 标识符 ======================= */

/** 位置是否在 fenced code block (``` 或 ~~~) 内 */
function isInFencedCode(doc, pos) {
  let open = false;
  for (let i = 0; i <= pos.line; i++) {
    const t = doc.lineAt(i).text.trim();
    if (/^(`{3,}|~{3,})/.test(t)) open = !open;
  }
  return open;
}

/** 位置是否在行内反引号代码内（本行反引号数为奇数） */
function isInInlineCode(doc, pos) {
  const line = doc.lineAt(pos.line).text;
  if (/^(`{3,}|~{3,})/.test(line.trim())) return false;
  const before = line.slice(0, pos.character);
  return (before.split('`').length - 1) % 2 === 1;
}

/** 提取位置处的标识符；位置在 . : ( 等相邻字符上时向左取最近标识符 */
function getIdentifierAt(doc, pos) {
  const line = doc.lineAt(pos.line).text;
  let ch = pos.character;
  if (ch >= line.length) ch = line.length - 1;
  if (ch < 0) return null;
  const c = line[ch];
  if (/[A-Za-z0-9_]/.test(c)) {
    let s = ch; let e = ch;
    while (s > 0 && /[A-Za-z0-9_]/.test(line[s - 1])) s--;
    while (e < line.length && /[A-Za-z0-9_]/.test(line[e])) e++;
    return { name: line.slice(s, e), range: new vscode.Range(pos.line, s, pos.line, e) };
  }
  const m = /[A-Za-z_][A-Za-z0-9_]*$/.exec(line.slice(0, ch + 1));
  if (m) {
    const s = ch + 1 - m[0].length;
    return { name: m[0], range: new vscode.Range(pos.line, s, pos.line, ch + 1) };
  }
  return null;
}

/* ============================ clangd 客户端 ========================= */

function toVscodeRange(r) {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

class ClangdClient {
  constructor(wsRoot) {
    this.wsRoot = wsRoot;
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.ready = this.start();
  }

  /** 查找 clangd 二进制：配置 → PATH → 常见系统路径 */
  static findBinary() {
    const cfgPath = vscode.workspace.getConfiguration('mdCodeLinks').get('clangdPath');
    if (cfgPath && fs.existsSync(cfgPath)) return cfgPath;
    const candidates = [
      '/usr/lib/llvm-15/bin/clangd',
      '/usr/lib/llvm-14/bin/clangd',
      '/usr/local/bin/clangd',
      '/usr/bin/clangd',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return 'clangd'; /* 让 PATH 解析 */
  }

  /**
   * compile_commands.json 必须在项目根目录（工作区根）。
   * 只认 <wsRoot>/compile_commands.json，不向上/向下搜索子目录。
   */
  static findCompileDir(wsRoot) {
    return wsRoot;
  }

  /** 从 compile_commands.json 里挑一个存在的文件作"唤醒种子" */
  static findSeedFile(wsRoot) {
    const ccd = ClangdClient.findCompileDir(wsRoot);
    try {
      const db = JSON.parse(fs.readFileSync(path.join(ccd, 'compile_commands.json'), 'utf8'));
      for (const e of db) {
        if (e.file && fs.existsSync(e.file)) return e.file;
      }
    } catch (e) { /* no compile db */ }
    return null;
  }

  start() {
    return new Promise((resolve) => {
      const bin = ClangdClient.findBinary();
      const ccd = ClangdClient.findCompileDir(this.wsRoot);
      const args = [
        `--compile-commands-dir=${ccd}`,
        '--background-index',
        '--header-insertion=never',
        '--log=error',
        '-j=4',
      ];
      try {
        this.proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        resolve();
        return;
      }
      if (!this.proc || !this.proc.stdout) { resolve(); return; }

      this.proc.stdout.on('data', (d) => this._onData(d));
      this.proc.stderr.on('data', () => { /* 丢弃 */ });
      this.proc.on('exit', () => {
        this.proc = null;
        for (const [, p] of this.pending) p({ error: { code: -32000, message: 'clangd exited' } });
        this.pending.clear();
      });

      const t = setTimeout(() => resolve(), 20000);
      this.request('initialize', {
        processId: process.pid,
        rootUri: vscode.Uri.file(this.wsRoot).toString(),
        capabilities: {
          workspace: { symbol: { dynamicRegistration: false } },
          textDocument: { definition: { dynamicRegistration: false } },
        },
        workspaceFolders: [{ uri: vscode.Uri.file(this.wsRoot).toString(), name: path.basename(this.wsRoot) }],
      }).then((res) => {
        clearTimeout(t);
        if (res && !res.error) {
          this.sendNotification('initialized', {});
          this._wakeBackgroundIndex();
        }
        resolve();
      }).catch(() => resolve());
    });
  }

  /**
   * clangd 15 的后台索引需要"第一个文件打开"才被唤醒（实测：无 didOpen 时
   * 5 分钟不建索引；didOpen 一个文件后约 20 秒全量索引即可查）。
   * 这里 didOpen 种子文件触发全量后台索引（--background-index）。
   */
  _wakeBackgroundIndex() {
    const seed = ClangdClient.findSeedFile(this.wsRoot);
    if (!seed) return;
    try {
      const text = fs.readFileSync(seed, 'utf8');
      this.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: vscode.Uri.file(seed).toString(),
          languageId: 'c',
          version: 1,
          text,
        },
      });
    } catch (e) { /* 读不到就跳过, 不影响 */ }
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\r\n\r\n')) >= 0) {
      const head = this.buf.slice(0, idx);
      const m = /Content-Length: (\d+)/i.exec(head);
      if (!m) { this.buf = this.buf.slice(idx + 4); continue; }
      const len = parseInt(m[1], 10);
      if (this.buf.length < idx + 4 + len) break;
      const body = this.buf.slice(idx + 4, idx + 4 + len);
      this.buf = this.buf.slice(idx + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch (e) { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p(msg);
      }
      /* server → client 请求：回空响应 */
      if (msg.id && msg.method) {
        this.sendRaw({ jsonrpc: '2.0', id: msg.id, result: null });
      }
    }
  }

  sendRaw(obj) {
    if (!this.proc || !this.proc.stdin) return;
    const s = JSON.stringify(obj);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }

  request(method, params, timeoutMs = 15000) {
    if (!this.proc || !this.proc.stdin) return Promise.resolve({ error: { code: -32000, message: 'not running' } });
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.sendRaw(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ error: { code: -32001, message: 'timeout' } });
        }
      }, timeoutMs);
    });
  }

  sendNotification(method, params) {
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  async workspaceSymbol(query) {
    await this.ready;
    const res = await this.request('workspace/symbol', { query });
    return res && res.result ? res.result : [];
  }

  dispose() {
    if (this.proc) {
      try { this.proc.kill(); } catch (e) { /* ignore */ }
      this.proc = null;
    }
  }
}

/* ========================= 函数名跳转（Definition） ================== */

let clangdClient = null;

function getClangdForRoot(root) {
  if (!clangdClient || clangdClient.wsRoot !== root) {
    if (clangdClient) clangdClient.dispose();
    clangdClient = new ClangdClient(root);
  }
  return clangdClient;
}

function getClangd(doc) {
  const wf = vscode.workspace.getWorkspaceFolder(doc.uri);
  const root = wf ? wf.uri.fsPath : path.dirname(doc.uri.fsPath);
  return getClangdForRoot(root);
}

async function resolveSymbolLocations(doc, name) {
  const client = getClangd(doc);
  const results = await client.workspaceSymbol(name);
  if (!results || !results.length) return [];
  /* 完全匹配优先；同名多定义(static/多 arch)全部保留。
   * 无完全匹配时只保留"名称包含 query 子串"的结果——
   * clangd 的 fuzzy 匹配会把 `__start` 拆成 `start`(下划线当分隔符)返回一堆无关符号,
   * includes 过滤可避免误跳。 */
  const exact = results.filter((s) => s.name === name);
  const picked = exact.length
    ? exact
    : results.filter((s) => s.name.includes(name)).slice(0, 10);
  return picked.map((s) => ({
    name: s.name,
    uri: vscode.Uri.parse(s.location.uri),
    range: toVscodeRange(s.location.range),
    kind: s.kind,
  }));
}

const definitionProvider = {
  async provideDefinition(document, position) {
    if (!cfg().get('enableFunctionJump')) return undefined;
    if (!isInFencedCode(document, position) && !isInInlineCode(document, position)) {
      return undefined; /* 只处理代码块与行内代码 */
    }
    const id = getIdentifierAt(document, position);
    if (!id) return undefined;
    const locs = await resolveSymbolLocations(document, id.name);
    if (!locs.length) {
      vscode.window.setStatusBarMessage(
        `$(search) clangd: 未找到 "${id.name}" 的定义（后台索引未就绪时请稍候重试）`, 4000);
      return undefined;
    }
    return locs.map((l) => new vscode.Location(l.uri, l.range));
  },
};

/* ============================== 生命周期 ============================ */

function activate(context) {
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      { language: 'markdown' },
      { provideDocumentLinks }
    ),
    vscode.languages.registerDefinitionProvider(
      { language: 'markdown' },
      definitionProvider
    )
  );

  /* 预热：工作区根有 compile_commands.json 时后台启动 clangd 开始建索引 */
  if (cfg().get('prewarmIndex')) {
    for (const wf of vscode.workspace.workspaceFolders || []) {
      const ccd = ClangdClient.findCompileDir(wf.uri.fsPath);
      if (fs.existsSync(path.join(ccd, 'compile_commands.json'))) {
        getClangdForRoot(wf.uri.fsPath);
        break;
      }
    }
  }
}

function deactivate() {
  if (clangdClient) {
    clangdClient.dispose();
    clangdClient = null;
  }
}

exports.activate = activate;
exports.deactivate = deactivate;
