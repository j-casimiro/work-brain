import type { DB } from "./db.js";
import { embed } from "./embed.js";

const BATCH = 32;
const blob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** Embed every chunk that has no vector yet. Returns how many were embedded. */
export async function embedPending(db: DB): Promise<number> {
  const pending = db.prepare<[number], { id: number; heading: string | null; body: string }>(
    "SELECT id, heading, body FROM chunks WHERE id NOT IN (SELECT rowid FROM chunks_vec) ORDER BY id LIMIT ?");
  const still = db.prepare<[number], { id: number }>("SELECT id FROM chunks WHERE id = ?");
  const del = db.prepare("DELETE FROM chunks_vec WHERE rowid = ?");
  const ins = db.prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)");
  let total = 0;
  for (;;) {
    const rows = pending.all(BATCH);
    if (!rows.length) return total;
    const vecs = await embed(rows.map((r) => (r.heading ? `${r.heading}\n${r.body}` : r.body)));
    db.transaction(() => {
      rows.forEach((r, i) => {
        if (!still.get(r.id)) return; // chunk replaced while we were embedding
        del.run(BigInt(r.id)); // another server process may have embedded it meanwhile
        ins.run(BigInt(r.id), blob(vecs[i]));
      });
    }).immediate();
    total += rows.length;
  }
}

/** Nearest chunks by cosine distance (0 = identical). */
export function knn(db: DB, query: Float32Array, k: number): { id: number; distance: number }[] {
  return db.prepare("SELECT rowid AS id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance")
    .all(blob(query), k) as { id: number; distance: number }[];
}
