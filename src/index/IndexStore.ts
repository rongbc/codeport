/**
 * `IndexStore` — the SQLite persistence layer of the CodePort index.
 *
 * Uses Node's built-in `node:sqlite` (Node 22.5+, shipped by VS Code's bundled
 * Node), so CodePort needs no native module and no `npm rebuild` step. The module
 * is loaded lazily and defensively: if the running host lacks it, `open()` returns
 * `undefined` and CodePort degrades to language-server-only resolution.
 *
 * Only a small structural slice of the API is used, and it is declared locally
 * rather than imported, so the store compiles even when `@types/node` predates
 * `node:sqlite`.
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { SymbolKind } from '../types.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

/* --------------------- minimal node:sqlite surface --------------------- */

type SqlParameter = null | number | bigint | string | Uint8Array;

interface SqliteStatement {
  run(...params: SqlParameter[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlParameter[]): unknown;
  all(...params: SqlParameter[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase;
}

/**
 * A `require` that works both in the bundled CommonJS extension host and when the
 * sources are executed as ESM (Node's type-stripping, used by the unit tests).
 * The base path is only a placeholder: builtin specifiers such as `node:sqlite`
 * resolve independently of it.
 */
const lazyRequire = createRequire(path.join(process.cwd(), 'codeport-runtime.cjs'));

function loadSqlite(): SqliteModule | undefined {
  try {
    return lazyRequire('node:sqlite') as SqliteModule;
  } catch {
    return undefined;
  }
}

/* ------------------------------- records ------------------------------- */

export interface IndexedSymbol {
  readonly name: string;
  readonly qualifiedName?: string;
  readonly kind: SymbolKind;
  readonly container?: string;
  /** Zero-based. */
  readonly line: number;
  /** Zero-based. */
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly signature?: string;
}

export interface IndexedReference {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly column: number;
}

export interface FileRecord {
  readonly id: number;
  readonly path: string;
  readonly language?: string;
  readonly size: number;
  readonly mtime: number;
  readonly hash?: string;
}

export interface SymbolHit extends IndexedSymbol {
  /** Absolute path of the defining file. */
  readonly file: string;
  readonly language?: string;
}

export interface SymbolQuery {
  readonly name: string;
  readonly language?: string;
  readonly kinds?: readonly SymbolKind[];
  readonly limit?: number;
}

export interface IndexStats {
  readonly files: number;
  readonly symbols: number;
  readonly references: number;
  readonly includes: number;
  readonly schemaVersion: number;
}

const DEFAULT_QUERY_LIMIT = 50;

/* -------------------------------- store -------------------------------- */

export class IndexStore {
  private static sqliteChecked = false;
  private static sqlite: SqliteModule | undefined;

  private readonly db: SqliteDatabase;
  readonly dbPath: string;
  private closed = false;

  private constructor(db: SqliteDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /** True when the host provides `node:sqlite`. Cached after the first probe. */
  static isAvailable(): boolean {
    if (!IndexStore.sqliteChecked) {
      IndexStore.sqlite = loadSqlite();
      IndexStore.sqliteChecked = true;
    }
    return IndexStore.sqlite !== undefined;
  }

  /**
   * Open (creating if needed) the index database at `dbPath`.
   * Returns `undefined` when SQLite is unavailable or the file cannot be opened.
   */
  static open(dbPath: string): IndexStore | undefined {
    if (!IndexStore.isAvailable()) return undefined;
    const sqlite = IndexStore.sqlite!;
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec(SCHEMA_SQL);
      const store = new IndexStore(db, dbPath);
      store.initialiseMeta();
      return store;
    } catch {
      return undefined;
    }
  }

  /** Create the schema in a fresh in-memory database (used by tests). */
  static openInMemory(): IndexStore {
    if (!IndexStore.isAvailable()) {
      throw new Error('node:sqlite is not available in this Node runtime');
    }
    const db = new IndexStore.sqlite!.DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const store = new IndexStore(db, ':memory:');
    store.initialiseMeta();
    return store;
  }

  private initialiseMeta(): void {
    const current = this.getMeta('schema_version');
    if (current === undefined) {
      this.setMeta('schema_version', String(SCHEMA_VERSION));
      return;
    }
    if (current !== String(SCHEMA_VERSION)) {
      // Simple, honest migration strategy: rebuild from scratch. The index is a
      // cache — everything in it can be regenerated from the sources.
      this.dropAll();
      this.db.exec(SCHEMA_SQL);
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }
  }

  private dropAll(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS includes;
      DROP TABLE IF EXISTS symbol_references;
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS meta;
    `);
  }

  /* ------------------------------ meta ------------------------------ */

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /* --------------------------- transactions --------------------------- */

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  /* ------------------------------ files ------------------------------ */

  getFile(filePath: string): FileRecord | undefined {
    const row = this.db
      .prepare('SELECT id, path, language, size, mtime, hash FROM files WHERE path = ?')
      .get(filePath) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      path: String(row.path),
      language: row.language == null ? undefined : String(row.language),
      size: Number(row.size ?? 0),
      mtime: Number(row.mtime ?? 0),
      hash: row.hash == null ? undefined : String(row.hash),
    };
  }

  /** Insert or update a file row, returning its id. */
  upsertFile(record: {
    path: string;
    language?: string;
    size: number;
    mtime: number;
    hash?: string;
  }): number {
    const existing = this.getFile(record.path);
    if (existing) {
      this.db
        .prepare('UPDATE files SET language = ?, size = ?, mtime = ?, hash = ? WHERE id = ?')
        .run(record.language ?? null, record.size, record.mtime, record.hash ?? null, existing.id);
      return existing.id;
    }
    const info = this.db
      .prepare('INSERT INTO files(path, language, size, mtime, hash) VALUES(?, ?, ?, ?, ?)')
      .run(record.path, record.language ?? null, record.size, record.mtime, record.hash ?? null);
    return Number(info.lastInsertRowid);
  }

  deleteFile(filePath: string): boolean {
    const info = this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    return Number(info.changes) > 0;
  }

  /** Delete rows for files that no longer exist on disk. Returns the count. */
  pruneFiles(keep: ReadonlySet<string>): number {
    const rows = this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
    const stale = rows.map((row) => row.path).filter((p) => !keep.has(p));
    if (stale.length === 0) return 0;
    this.transaction(() => {
      const stmt = this.db.prepare('DELETE FROM files WHERE path = ?');
      for (const p of stale) stmt.run(p);
    });
    return stale.length;
  }

  allFilePaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM files ORDER BY path').all() as Array<{
      path: string;
    }>;
    return rows.map((row) => row.path);
  }

  /**
   * Replace everything recorded for a file. Callers are expected to wrap this in
   * `transaction()` when indexing many files.
   */
  replaceFileContent(
    fileId: number,
    symbols: readonly IndexedSymbol[],
    references: readonly IndexedReference[] = [],
    includes: readonly string[] = []
  ): void {
    this.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM symbol_references WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM includes WHERE file_id = ?').run(fileId);

    const insertSymbol = this.db.prepare(`
      INSERT INTO symbols(name, qualified_name, kind, container, line, column, end_line, end_column, signature, file_id)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const symbolIds = new Map<string, number>();
    for (const symbol of symbols) {
      const info = insertSymbol.run(
        symbol.name,
        symbol.qualifiedName ?? null,
        symbol.kind,
        symbol.container ?? null,
        symbol.line,
        symbol.column,
        symbol.endLine ?? null,
        symbol.endColumn ?? null,
        symbol.signature ?? null,
        fileId
      );
      // Remember the first definition of each name so references can be linked.
      if (!symbolIds.has(symbol.name)) symbolIds.set(symbol.name, Number(info.lastInsertRowid));
    }

    if (references.length > 0) {
      const insertReference = this.db.prepare(`
        INSERT INTO symbol_references(file_id, symbol_id, name, kind, line, column)
        VALUES(?, ?, ?, ?, ?, ?)
      `);
      for (const reference of references) {
        insertReference.run(
          fileId,
          symbolIds.get(reference.name) ?? null,
          reference.name,
          reference.kind,
          reference.line,
          reference.column
        );
      }
    }

    if (includes.length > 0) {
      const insertInclude = this.db.prepare('INSERT INTO includes(file_id, target) VALUES(?, ?)');
      for (const target of includes) insertInclude.run(fileId, target);
    }
  }

  /* ----------------------------- queries ----------------------------- */

  /** Exact-name lookup (plan section 10, step 1). */
  queryExact(query: SymbolQuery): SymbolHit[] {
    return this.queryByName(query, 'exact');
  }

  /** Substring-prefix fallback used when an exact lookup finds nothing. */
  queryByPrefix(query: SymbolQuery): SymbolHit[] {
    return this.queryByName(query, 'prefix');
  }

  private queryByName(query: SymbolQuery, mode: 'exact' | 'prefix'): SymbolHit[] {
    const where: string[] = [];
    const params: SqlParameter[] = [];

    if (mode === 'exact') {
      where.push('s.name = ?');
      params.push(query.name);
    } else {
      where.push("s.name LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(query.name)}%`);
    }
    if (query.language) {
      where.push('f.language = ?');
      params.push(query.language);
    }
    if (query.kinds && query.kinds.length > 0) {
      where.push(`s.kind IN (${query.kinds.map(() => '?').join(',')})`);
      params.push(...query.kinds);
    }

    params.push(query.limit ?? DEFAULT_QUERY_LIMIT);
    const sql = `
      SELECT s.name, s.qualified_name, s.kind, s.container, s.line, s.column,
             s.end_line, s.end_column, s.signature, f.path AS file, f.language AS language
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.line ASC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToHit);
  }

  /** All definitions of `names`, used to link references in bulk. */
  queryNames(names: readonly string[]): SymbolHit[] {
    if (names.length === 0) return [];
    const placeholders = names.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT s.name, s.qualified_name, s.kind, s.container, s.line, s.column,
                s.end_line, s.end_column, s.signature, f.path AS file, f.language AS language
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name IN (${placeholders})`
      )
      .all(...names) as Array<Record<string, unknown>>;
    return rows.map(rowToHit);
  }

  /* ------------------------------ stats ------------------------------ */

  private count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      | { n?: number | bigint }
      | undefined;
    return Number(row?.n ?? 0);
  }

  stats(): IndexStats {
    return {
      files: this.count('files'),
      symbols: this.count('symbols'),
      references: this.count('symbol_references'),
      includes: this.count('includes'),
      schemaVersion: Number(this.getMeta('schema_version') ?? SCHEMA_VERSION),
    };
  }

  /** Remove every indexed row but keep the schema. */
  clear(): void {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM includes;
        DELETE FROM symbol_references;
        DELETE FROM symbols;
        DELETE FROM files;
      `);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // Fold the WAL back into the main database before closing.
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

function rowToHit(row: Record<string, unknown>): SymbolHit {
  return {
    name: String(row.name),
    qualifiedName: row.qualified_name == null ? undefined : String(row.qualified_name),
    kind: String(row.kind) as SymbolKind,
    container: row.container == null ? undefined : String(row.container),
    line: Number(row.line),
    column: Number(row.column),
    endLine: row.end_line == null ? undefined : Number(row.end_line),
    endColumn: row.end_column == null ? undefined : Number(row.end_column),
    signature: row.signature == null ? undefined : String(row.signature),
    file: String(row.file),
    language: row.language == null ? undefined : String(row.language),
  };
}

/** Escape `LIKE` wildcards so a symbol named `a_b` cannot match `axb`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
