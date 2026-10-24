import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { DB } from "./db.js";
import type { Indexer } from "./indexer.js";
import { WritePayload, type NoteType } from "./schema.js";

/** Local calendar date (the laptop's timezone), not UTC. */
export const today = () => new Date().toLocaleDateString("en-CA");

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Where a new note of this type goes (vault-relative, forward slashes). */
export function notePath(type: NoteType, extId: string, date: string): string {
  const [yyyy, mm] = date.split("-");
  switch (type) {
    case "ticket": return `tickets/${yyyy}/${extId}.md`;
    case "journal": return `journal/${yyyy}/${mm}/${extId}.md`;
    case "decision": return `decisions/${extId.startsWith(date) ? extId : `${date}-${slugify(extId)}`}.md`;
    case "module": return `modules/${extId}.md`;
    case "feature": return `features/${extId}.md`;
    case "calc": return `calcs/${extId}.md`;
  }
}

interface Section { heading: string; lines: string[] }

/** Split on "## " headings (outside code fences). sections[0] is the preamble, heading "". */
function splitSections(body: string): Section[] {
  const out: Section[] = [{ heading: "", lines: [] }];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^##\s+(.*)$/);
    if (h) out.push({ heading: h[1].trim(), lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

function joinSections(sections: Section[]): string {
  return sections
    .map((s) => {
      const text = s.lines.join("\n").trim();
      return s.heading ? `## ${s.heading}\n${text ? `\n${text}\n` : ""}` : text ? `${text}\n` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Replace sections present in `update` (matched by heading, case-insensitive); keep the rest; append new ones. */
export function mergeBody(existing: string, update: string): string {
  const base = splitSections(existing);
  for (const s of splitSections(update)) {
    if (!s.heading) {
      if (s.lines.join("").trim()) base[0] = s;
      continue;
    }
    const i = base.findIndex((b) => b.heading.toLowerCase() === s.heading.toLowerCase());
    if (i >= 0) base[i] = { heading: base[i].heading, lines: s.lines };
    else base.push(s);
  }
  return joinSections(base);
}

/** Section headings from the vault's template for this type, as an empty body. */
function templateBody(vaultDir: string, type: NoteType): string {
  const file = path.join(vaultDir, "_templates", `${type}.md`);
  if (!fs.existsSync(file)) return "";
  return splitSections(matter(fs.readFileSync(file, "utf8")).content)
    .filter((s) => s.heading)
    .map((s) => `## ${s.heading}\n`)
    .join("\n");
}

// YAML scalars: plain when obviously safe, otherwise JSON-quoted (JSON strings are valid YAML).
const yamlScalar = (v: string) => (/^[A-Za-z0-9][\w .\/-]*$/.test(v) && !/:\s|\s#/.test(v) ? v : JSON.stringify(v));
const yamlList = (xs: string[]) => `[${xs.map(yamlScalar).join(", ")}]`;
const FM_ORDER = ["brain", "type", "id", "title", "date", "updated", "status", "source", "commit_sha", "tags", "links"];

function renderFrontmatter(data: Record<string, unknown>): string {
  const keys = [...FM_ORDER.filter((k) => k in data), ...Object.keys(data).filter((k) => !FM_ORDER.includes(k))];
  const lines = keys
    .filter((k) => data[k] !== undefined && data[k] !== null && data[k] !== "")
    .map((k) => {
      const v = data[k];
      if (Array.isArray(v)) return `${k}: ${yamlList(v.map(String))}`;
      if (v instanceof Date) return `${k}: ${v.toISOString().slice(0, 10)}`;
      return `${k}: ${yamlScalar(String(v))}`;
    });
  return `---\n${lines.join("\n")}\n---\n`;
}

const union = (a: unknown, b: string[]) => [...new Set([...(Array.isArray(a) ? a.map(String) : []), ...b])];

export interface WriteResult { path: string; created: boolean; indexed: string }

/**
 * Upsert a note, idempotent on (brain, type, ext_id). On update: keeps `date` and unknown frontmatter keys,
 * merges tags/links, replaces only the body sections the payload sends, and leaves everything else as written.
 */
export function writeNote(db: DB, indexer: Indexer, vaultDir: string, input: unknown): WriteResult {
  const p = WritePayload.parse(input);
  const row = db.prepare<[string, string, string], { path: string }>(
    "SELECT path FROM notes WHERE brain=? AND type=? AND lower(ext_id)=lower(?)").get(p.brain, p.type, p.ext_id);
  const rel = row?.path ?? notePath(p.type, p.ext_id, p.date);
  const abs = path.join(vaultDir, ...rel.split("/"));
  const created = !fs.existsSync(abs);

  const old = created ? { data: {} as Record<string, unknown>, content: templateBody(vaultDir, p.type) }
                      : matter(fs.readFileSync(abs, "utf8"));
  const data: Record<string, unknown> = {
    ...old.data,
    brain: p.brain, type: p.type, id: (old.data.id as string) ?? p.ext_id, title: p.title,
    date: old.data.date ?? p.date, updated: today(),
    status: p.status ?? old.data.status, source: p.source, commit_sha: p.commit_sha ?? old.data.commit_sha,
    tags: union(old.data.tags, p.tags), links: union(old.data.links, p.links),
  };
  const update = [p.summary.trim() ? `## Summary\n\n${p.summary.trim()}\n` : "", p.body].join("\n");
  const body = mergeBody(old.content, update);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${renderFrontmatter(data)}\n${body}`);
  const indexed = indexer.indexFile(abs);
  indexer.resolveLinks();
  return { path: rel, created, indexed };
}

/** Add a bullet under a section of a day's journal (default today, section "Did"), creating it from the template. */
export function appendLog(db: DB, indexer: Indexer, vaultDir: string, brain: string,
                          text: string, section = "Did", date = today()): WriteResult {
  const row = db.prepare<[string, string], { path: string }>(
    "SELECT path FROM notes WHERE brain=? AND type='journal' AND ext_id=?").get(brain, date);
  const rel = row?.path ?? notePath("journal", date, date);
  const abs = path.join(vaultDir, ...rel.split("/"));
  const created = !fs.existsSync(abs);

  const old = created
    ? { data: { brain, type: "journal", id: date, title: `Journal ${date}`, date, source: "agent", tags: [], links: [] } as Record<string, unknown>,
        content: templateBody(vaultDir, "journal") }
    : matter(fs.readFileSync(abs, "utf8"));
  const sections = splitSections(old.content);
  let s = sections.find((x) => x.heading.toLowerCase() === section.toLowerCase());
  if (!s) { s = { heading: section, lines: [] }; sections.push(s); }
  while (s.lines.length && !s.lines[s.lines.length - 1].trim()) s.lines.pop();
  s.lines.push(...text.trim().split(/\r?\n/).map((l, i) => (i === 0 && !/^\s*[-*] /.test(l) ? `- ${l}` : l)));

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${renderFrontmatter({ ...old.data, updated: today() })}\n${joinSections(sections)}`);
  const indexed = indexer.indexFile(abs);
  indexer.resolveLinks();
  return { path: rel, created, indexed };
}
