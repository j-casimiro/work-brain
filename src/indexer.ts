import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import type { DB } from "./db.js";
import { parseNote, sha1 } from "./parse.js";

export const IGNORED_DIRS = new Set(["_templates", ".obsidian", ".git", ".trash", "node_modules"]);

/** Vault-relative path with forward slashes, so the DB is identical on Windows and Unix. */
export const toRel = (vaultDir: string, abs: string) => path.relative(vaultDir, abs).split(path.sep).join("/");

export function walkVault(vaultDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) walk(path.join(dir, e.name)); }
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md") && dir !== vaultDir) out.push(path.join(dir, e.name));
    }
  };
  walk(vaultDir);
  return out;
}

export type IndexResult = "indexed" | "unchanged" | "skipped";

export class Indexer {
  private q;

  constructor(private db: DB, private vaultDir: string, private brain: string) {
    this.q = this.prepare();
  }

  private prepare() { return {
    byPath: this.db.prepare<[string], { id: number; content_hash: string }>("SELECT id, content_hash FROM notes WHERE path = ?"),
    upsert: this.db.prepare(`
      INSERT INTO notes (path, brain, type, ext_id, title, date, updated, status, source, commit_sha, done, assignee, content_hash)
      VALUES (@path, @brain, @type, @ext_id, @title, @date, @updated, @status, @source, @commit_sha, @done, @assignee, @content_hash)
      ON CONFLICT(path) DO UPDATE SET brain=excluded.brain, type=excluded.type, ext_id=excluded.ext_id,
        title=excluded.title, date=excluded.date, updated=excluded.updated, status=excluded.status,
        source=excluded.source, commit_sha=excluded.commit_sha, done=excluded.done, assignee=excluded.assignee,
        content_hash=excluded.content_hash
      RETURNING id`),
    delChunks: this.db.prepare("DELETE FROM chunks WHERE note_id = ?"),
    chunksOf: this.db.prepare<[number], { id: number; hash: string }>("SELECT id, hash FROM chunks WHERE note_id = ?"),
    delChunk: this.db.prepare("DELETE FROM chunks WHERE id = ?"),
    setOrd: this.db.prepare("UPDATE chunks SET ord = ? WHERE id = ?"),
    delLinks: this.db.prepare("DELETE FROM links WHERE src_note_id = ?"),
    delTags: this.db.prepare("DELETE FROM note_tags WHERE note_id = ?"),
    delNote: this.db.prepare("DELETE FROM notes WHERE id = ?"),
    insChunk: this.db.prepare("INSERT INTO chunks (note_id, ord, heading, body, hash) VALUES (?, ?, ?, ?, ?)"),
    insLink: this.db.prepare("INSERT INTO links (src_note_id, dst_name) VALUES (?, ?)"),
    insTag: this.db.prepare("INSERT INTO note_tags (note_id, tag) VALUES (?, ?)"),
    allPaths: this.db.prepare<[], { id: number; path: string }>("SELECT id, path FROM notes"),
    resolve: this.db.prepare(`
      UPDATE links SET dst_note_id = (
        SELECT n.id FROM notes n WHERE lower(n.ext_id) = lower(links.dst_name)
           OR lower(n.title) = lower(links.dst_name) LIMIT 1)`),
  }; }

  /** Index one file. Returns "skipped" (with a warning) for files with bad frontmatter. */
  indexFile(abs: string, force = false): IndexResult {
    const rel = toRel(this.vaultDir, abs);
    const raw = fs.readFileSync(abs, "utf8");
    const hash = sha1(raw);
    const existing = this.q.byPath.get(rel);
    if (!force && existing?.content_hash === hash) return "unchanged";

    let parsed;
    try { parsed = parseNote(raw); }
    catch (err) {
      const msg = err instanceof ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(err);
      console.warn(`  skip ${rel} — ${msg}`);
      if (existing) this.removeById(existing.id);
      return "skipped";
    }
    const { fm, chunks, links } = parsed;
    if (fm.brain !== this.brain) {
      console.warn(`  skip ${rel} — brain "${fm.brain}" does not belong in the ${this.brain} vault`);
      return "skipped";
    }

    this.db.transaction(() => {
      // Free the (brain,type,ext_id) slot if another path held it (file renamed/moved).
      const clash = this.db.prepare<[string, string, string, string], { id: number }>(
        "SELECT id FROM notes WHERE brain=? AND type=? AND ext_id=? AND path<>?").get(fm.brain, fm.type, fm.id, rel);
      if (clash) { console.warn(`  duplicate id ${fm.type}/${fm.id}: ${rel} replaces older path`); this.removeById(clash.id); }

      const { id } = this.q.upsert.get({
        path: rel, brain: fm.brain, type: fm.type, ext_id: fm.id, title: fm.title, date: fm.date,
        updated: fm.updated ?? fm.date, status: fm.status ?? null, source: fm.source ?? null,
        commit_sha: fm.commit_sha ?? null, done: fm.done ?? null, assignee: fm.assignee ?? null, content_hash: hash,
      }) as { id: number };
      this.q.delLinks.run(id); this.q.delTags.run(id);
      // Keep rows (and so their embeddings) for chunks whose content hash is unchanged; replace the rest.
      const old = new Map<string, number[]>();
      for (const c of this.q.chunksOf.all(id)) old.set(c.hash, [...(old.get(c.hash) ?? []), c.id]);
      for (const c of chunks) {
        const keep = old.get(c.hash)?.shift();
        if (keep !== undefined) this.q.setOrd.run(c.ord, keep);
        else this.q.insChunk.run(id, c.ord, c.heading, c.body, c.hash);
      }
      for (const ids of old.values()) for (const stale of ids) this.q.delChunk.run(stale);
      for (const l of links) this.q.insLink.run(id, l);
      for (const t of new Set(fm.tags)) this.q.insTag.run(id, t);
    })();
    return "indexed";
  }

  private removeById(id: number) {
    this.q.delChunks.run(id); // explicit so the FTS delete trigger always fires
    this.q.delNote.run(id);
  }

  removeFile(abs: string) {
    const row = this.q.byPath.get(toRel(this.vaultDir, abs));
    if (row) this.db.transaction(() => this.removeById(row.id))();
  }

  resolveLinks() { this.q.resolve.run(); }

  /** Walk the vault, index changed files, prune notes whose file is gone. */
  reindexAll(force = false) {
    const files = walkVault(this.vaultDir);
    const seen = new Set(files.map((f) => toRel(this.vaultDir, f)));
    const stats = { indexed: 0, unchanged: 0, skipped: 0, removed: 0 };
    for (const f of files) stats[this.indexFile(f, force)]++;
    for (const row of this.q.allPaths.all()) {
      if (!seen.has(row.path)) { this.db.transaction(() => this.removeById(row.id))(); stats.removed++; }
    }
    this.resolveLinks();
    return stats;
  }
}
