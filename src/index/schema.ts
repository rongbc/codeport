/**
 * SQLite schema for the CodePort index (plan section 6).
 *
 * Scope is deliberately limited to File / Symbol / Reference / Include — no call
 * graph, no inheritance graph, no template-instantiation graph (plan section 7).
 * Those would turn a navigation aid into a code-intelligence engine.
 *
 * Line/column values are zero-based, matching LSP and VS Code, and are stored as
 * integers for cheap range queries.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id       INTEGER PRIMARY KEY,
  path     TEXT NOT NULL UNIQUE,
  language TEXT,
  size     INTEGER NOT NULL DEFAULT 0,
  mtime    INTEGER NOT NULL DEFAULT 0,
  hash     TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  id             INTEGER PRIMARY KEY,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  qualified_name TEXT,
  kind           TEXT NOT NULL,
  container      TEXT,
  line           INTEGER NOT NULL,
  column         INTEGER NOT NULL,
  end_line       INTEGER,
  end_column     INTEGER,
  signature      TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

-- Named symbol_references rather than "references" (a SQL keyword) to avoid
-- quoting it in every statement.
CREATE TABLE IF NOT EXISTS symbol_references (
  id        INTEGER PRIMARY KEY,
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  line      INTEGER NOT NULL,
  column    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refs_name ON symbol_references(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON symbol_references(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_symbol ON symbol_references(symbol_id);

CREATE TABLE IF NOT EXISTS includes (
  id      INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_includes_file ON includes(file_id);
`;
