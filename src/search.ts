import type { DB } from "./db.js";
import { embedQuery } from "./embed.js";
import { knn } from "./vectors.js";

export interface SearchFilters { brain?: string; type?: string; from?: string; to?: string; limit?: number }
export interface SearchHit {
  path: string; title: string; type: string; ext_id: string; date: string;
  heading: string; snippet: string; score: number;
}
export interface HybridHit extends SearchHit { match: "keyword" | "semantic" | "both" }

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

/** Keyword search (BM25). */
export function searchFts(db: DB, q: string, f: SearchFilters = {}): (SearchHit & { chunk_id: number })[] {
  const fts = toFtsQuery(q);
  if (!fts) return [];
  const params: unknown[] = [fts];
  const sql = `
    SELECT c.id AS chunk_id, n.path, n.title, n.type, n.ext_id, n.date, c.heading,
           snippet(chunks_fts, 1, '**', '**', '…', 16) AS snippet,
           bm25(chunks_fts, 2.0, 1.0) AS score
    FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN notes n ON n.id = c.note_id
    WHERE chunks_fts MATCH ?${filterSql(f, params)}
    ORDER BY (lower(n.ext_id) = lower(?)) DESC, score
    LIMIT ?`;
  params.push(q.trim(), f.limit ?? 10);
  return db.prepare(sql).all(...params) as (SearchHit & { chunk_id: number })[];
}

const RRF_K = 60;
const POOL = 30; // candidates taken from each list before fusing
const KNN_K = 100; // vector neighbours fetched before filters are applied
// bge-small puts unrelated text around 0.5 cosine distance and related text below ~0.4. Tune on real notes.
const MAX_DISTANCE = 0.45;

/**
 * Hybrid search: BM25 top-k and vector kNN top-k, fused by reciprocal rank (1/(60+rank)).
 * An exact ext_id match always ranks first. Falls back to keyword-only if embedding fails.
 */
export async function search(db: DB, q: string, f: SearchFilters = {}): Promise<HybridHit[]> {
  const limit = f.limit ?? 10;
  const kw = searchFts(db, q, { ...f, limit: POOL });
  let sem: (SearchHit & { chunk_id: number })[] = [];
  try {
    const near = knn(db, await embedQuery(q), KNN_K).filter((n) => n.distance <= MAX_DISTANCE);
    if (near.length) {
      const params: unknown[] = [JSON.stringify(near.map((n) => n.id))];
      const rows = db.prepare(`
        SELECT c.id AS chunk_id, n.path, n.title, n.type, n.ext_id, n.date, c.heading, c.body
        FROM chunks c JOIN notes n ON n.id = c.note_id
        WHERE c.id IN (SELECT value FROM json_each(?))${filterSql(f, params)}`).all(...params) as (SearchHit & { chunk_id: number; body: string })[];
      const dist = new Map(near.map((n) => [n.id, n.distance]));
      sem = rows
        .map(({ body, ...r }) => ({ ...r, snippet: body.length > 200 ? `${body.slice(0, 200)}…` : body, score: dist.get(r.chunk_id)! }))
        .sort((a, b) => a.score - b.score)
        .slice(0, POOL);
    }
  } catch (err) {
    console.error(`semantic search unavailable, keyword only: ${err}`);
  }

  const fused = new Map<number, HybridHit>();
  const add = (list: (SearchHit & { chunk_id: number })[], kind: "keyword" | "semantic") =>
    list.forEach(({ chunk_id, ...h }, rank) => {
      const prev = fused.get(chunk_id);
      const rrf = 1 / (RRF_K + rank + 1);
      if (prev) { prev.score += rrf; prev.match = "both"; if (kind === "keyword") prev.snippet = h.snippet; }
      else fused.set(chunk_id, { ...h, score: rrf, match: kind });
    });
  add(kw, "keyword");
  add(sem, "semantic");

  const exact = q.trim().toLowerCase();
  const hits = [...fused.values()].sort((a, b) =>
    Number(b.ext_id.toLowerCase() === exact) - Number(a.ext_id.toLowerCase() === exact) || b.score - a.score);
  // One hit per note: the best-ranked chunk, so a single long note can't crowd out the rest.
  const seen = new Set<string>();
  return hits.filter((h) => !seen.has(h.path) && seen.add(h.path)).slice(0, limit);
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
