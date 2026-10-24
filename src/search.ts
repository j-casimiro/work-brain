import type { DB } from "./db.js";

export interface SearchFilters { brain?: string; type?: string; from?: string; to?: string; limit?: number }
export interface SearchHit {
  path: string; title: string; type: string; ext_id: string; date: string;
  heading: string; snippet: string; score: number;
}

/** Turn free text into a safe FTS5 query: every token quoted, ANDed. "PROJ-1423" stays a phrase. */
export function toFtsQuery(q: string): string {
  return q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

function filterSql(f: SearchFilters, params: unknown[]) {
  const where: string[] = [];
  if (f.brain) { where.push("n.brain = ?"); params.push(f.brain); }
  if (f.type) { where.push("n.type = ?"); params.push(f.type); }
  if (f.from) { where.push("n.date >= ?"); params.push(f.from); }
  if (f.to) { where.push("n.date <= ?"); params.push(f.to); }
  return where.length ? ` AND ${where.join(" AND ")}` : "";
}

/** Keyword search (BM25). Step 4 adds sqlite-vec kNN and fuses both with RRF. */
export function searchFts(db: DB, q: string, f: SearchFilters = {}): SearchHit[] {
  const fts = toFtsQuery(q);
  if (!fts) return [];
  const params: unknown[] = [fts];
  const sql = `
    SELECT n.path, n.title, n.type, n.ext_id, n.date, c.heading,
           snippet(chunks_fts, 1, '**', '**', '…', 16) AS snippet,
           bm25(chunks_fts, 2.0, 1.0) AS score
    FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN notes n ON n.id = c.note_id
    WHERE chunks_fts MATCH ?${filterSql(f, params)}
    ORDER BY (lower(n.ext_id) = lower(?)) DESC, score
    LIMIT ?`;
  params.push(q.trim(), f.limit ?? 10);
  return db.prepare(sql).all(...params) as SearchHit[];
}

export interface NoteRow { id: number; path: string; title: string; type: string; ext_id: string; date: string; status: string | null }
const NOTE_COLS = "n.id, n.path, n.title, n.type, n.ext_id, n.date, n.status";

/** Find a note by ext_id (case-insensitive, optionally narrowed by type) or by vault-relative path. */
export function findNote(db: DB, idOrPath: string, f: { brain?: string; type?: string } = {}): NoteRow | undefined {
  const params: unknown[] = [idOrPath, idOrPath.replace(/\\/g, "/")];
  return db.prepare(`SELECT ${NOTE_COLS} FROM notes n WHERE (lower(n.ext_id) = lower(?) OR n.path = ?)${filterSql(f, params)}
                     ORDER BY n.type = 'ticket' DESC LIMIT 1`).get(...params) as NoteRow | undefined;
}

/** Graph neighbours: notes this one links to (resolved or not) and notes linking to it. */
export function related(db: DB, noteId: number) {
  const outgoing = db.prepare(`SELECT l.dst_name AS name, ${NOTE_COLS} FROM links l LEFT JOIN notes n ON n.id = l.dst_note_id
                               WHERE l.src_note_id = ? ORDER BY l.dst_name`).all(noteId);
  const incoming = db.prepare(`SELECT ${NOTE_COLS} FROM links l JOIN notes n ON n.id = l.src_note_id
                               WHERE l.dst_note_id = ? ORDER BY n.date DESC`).all(noteId);
  return { outgoing, incoming };
}

/** Dated notes in a range, oldest first. No search involved. */
export function timeline(db: DB, f: SearchFilters = {}) {
  const params: unknown[] = [];
  const sql = `SELECT n.path, n.title, n.type, n.ext_id, n.date, n.status FROM notes n
               WHERE 1=1${filterSql(f, params)} ORDER BY n.date, n.path LIMIT ?`;
  params.push(f.limit ?? 200);
  return db.prepare(sql).all(...params);
}
