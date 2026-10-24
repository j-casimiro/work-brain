import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,          -- vault-relative, forward slashes
  brain TEXT NOT NULL,
  type TEXT NOT NULL,
  ext_id TEXT,
  title TEXT,
  date TEXT,
  updated TEXT,
  status TEXT,
  source TEXT,
  commit_sha TEXT,
  content_hash TEXT,
  UNIQUE (brain, type, ext_id)
);
CREATE INDEX IF NOT EXISTS idx_notes_filter ON notes (brain, type, date);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  heading TEXT,
  body TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_note ON chunks (note_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  heading, body, content='chunks', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, heading, body) VALUES (new.id, new.heading, new.body);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, heading, body) VALUES ('delete', old.id, old.heading, old.body);
END;

-- chunks_vec (sqlite-vec) is added in step 4 once the embedding model is chosen.

CREATE TABLE IF NOT EXISTS links (
  src_note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  dst_name TEXT NOT NULL,
  dst_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_links_src ON links (src_note_id);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links (dst_note_id);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tags ON note_tags (tag);
`;

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000"); // MCP server and CLI reindex may write at the same time
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/** The index is disposable: delete it (and WAL side files) to rebuild from scratch. */
export function dropDb(dbPath: string) {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
}
