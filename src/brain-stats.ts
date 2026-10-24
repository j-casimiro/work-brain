// Read-only overview of the brain for the dashboard's Brain tab.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { DB } from "./db.js";
import { walkVault } from "./indexer.js";
import { splitSections } from "./writer.js";

const TICKET_SECTIONS = ["Summary", "What changed", "Why", "Modules touched", "Follow-ups"];
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const ACTIVITY_DAYS = 182; // ~26 weeks on the calendar
const JOURNAL_LOOKBACK = 20; // weekdays

const fmt = (d: Date) => d.toLocaleDateString("en-CA");
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

interface NoteRow { id: number; path: string; type: string; ext_id: string; title: string; date: string; updated: string | null; done: string | null; status: string | null }

export function brainStats(db: DB, vaultDir: string, brain: string, today: string) {
  const notes = db.prepare(`SELECT id, path, type, ext_id, title, date, updated, done, status FROM notes WHERE brain = ?`).all(brain) as NoteRow[];
  const byId = new Map(notes.map((n) => [n.id, n]));

  // --- counts ---
  const byType: Record<string, number> = {};
  for (const n of notes) byType[n.type] = (byType[n.type] ?? 0) + 1;
  const tags = db.prepare(`SELECT t.tag, count(*) AS n FROM note_tags t JOIN notes n ON n.id = t.note_id
                           WHERE n.brain = ? GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 15`).all(brain) as { tag: string; n: number }[];

  // --- gaps: empty sections in ticket notes ---
  const sectionGaps: Record<string, number> = Object.fromEntries(TICKET_SECTIONS.map((s) => [s, 0]));
  const thin: { key: string; title: string; done: string | null; missing: string[] }[] = [];
  for (const n of notes.filter((x) => x.type === "ticket")) {
    let content = "";
    try { content = matter(fs.readFileSync(path.join(vaultDir, ...n.path.split("/")), "utf8")).content; } catch { continue; }
    const filled = new Set(splitSections(content).filter((s) => s.heading && s.lines.join("").trim()).map((s) => s.heading.toLowerCase()));
    const missing = TICKET_SECTIONS.filter((s) => !filled.has(s.toLowerCase()));
    for (const s of missing) sectionGaps[s]++;
    if (missing.includes("Summary") || missing.includes("Why")) thin.push({ key: n.ext_id, title: n.title, done: n.done, missing });
  }
  thin.sort((a, b) => (b.done ?? "").localeCompare(a.done ?? "") || a.key.localeCompare(b.key));

  // --- gaps: links to notes that don't exist (Jira keys = parent epics/other tickets, kept separate) ---
  const unresolved = db.prepare(`SELECT l.dst_name AS name, count(*) AS n, group_concat(s.ext_id, ', ') AS sources
                                 FROM links l JOIN notes s ON s.id = l.src_note_id
                                 WHERE l.dst_note_id IS NULL AND s.brain = ? GROUP BY l.dst_name ORDER BY n DESC, name`).all(brain) as { name: string; n: number; sources: string }[];

  // --- gaps: weekdays without a journal (today excluded: the day isn't over) ---
  const journals = new Set(notes.filter((n) => n.type === "journal").map((n) => n.date));
  const missingJournal: string[] = [];
  for (let d = addDays(new Date(`${today}T12:00:00`), -1), seen = 0; seen < JOURNAL_LOOKBACK; d = addDays(d, -1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    seen++;
    if (!journals.has(fmt(d))) missingJournal.push(fmt(d));
  }

  // --- search health ---
  const chunks = (db.prepare(`SELECT count(*) AS n FROM chunks c JOIN notes n ON n.id = c.note_id WHERE n.brain = ?`).get(brain) as { n: number }).n;
  const embedded = (db.prepare(`SELECT count(*) AS n FROM chunks_vec v JOIN chunks c ON c.id = v.rowid JOIN notes n ON n.id = c.note_id WHERE n.brain = ?`).get(brain) as { n: number }).n;
  const model = (db.prepare("SELECT value FROM meta WHERE key = 'embed'").get() as { value: string } | undefined)?.value ?? "";
  const files = walkVault(vaultDir).length;
  const dbFile = db.name;
  const dbBytes = ["", "-wal"].reduce((sum, ext) => sum + (fs.existsSync(dbFile + ext) ? fs.statSync(dbFile + ext).size : 0), 0);

  // --- activity: per day, notes created / last updated / done (the index keeps only each note's latest update) ---
  const since = fmt(addDays(new Date(`${today}T12:00:00`), -ACTIVITY_DAYS));
  const activity: Record<string, { created: number; updated: number; done: number }> = {};
  const bump = (day: string | null, k: "created" | "updated" | "done") => {
    if (!day || day < since || day > today) return;
    (activity[day] ??= { created: 0, updated: 0, done: 0 })[k]++;
  };
  for (const n of notes) { bump(n.date, "created"); if (n.updated && n.updated !== n.date) bump(n.updated, "updated"); bump(n.done, "done"); }

  // --- epic graph: a ticket's Jira-key links are its parents: an epic (no note) or another ticket (subtask → parent) ---
  const ticketKeys = new Set(notes.filter((n) => n.type === "ticket").map((n) => n.ext_id));
  const links = db.prepare(`SELECT l.src_note_id AS src, l.dst_name AS dst, l.dst_note_id AS dstId FROM links l ORDER BY l.rowid`).all() as { src: number; dst: string; dstId: number | null }[];
  const parentOf = new Map<string, string>();
  const knowledge = new Map<string, { key: string; type: string; title: string; tickets: string[] }>();
  for (const l of links) {
    const src = byId.get(l.src);
    if (!src || src.type !== "ticket") continue;
    if (JIRA_KEY.test(l.dst) && l.dst !== src.ext_id) {
      if (!parentOf.has(src.ext_id)) parentOf.set(src.ext_id, l.dst); // first Jira-key link = parent (the sync writes the parent first)
    } else if (l.dstId != null) {
      const dst = byId.get(l.dstId);
      if (dst && ["module", "feature", "calc", "decision"].includes(dst.type)) {
        const k = knowledge.get(dst.ext_id) ?? { key: dst.ext_id, type: dst.type, title: dst.title, tickets: [] };
        k.tickets.push(src.ext_id);
        knowledge.set(dst.ext_id, k);
      }
    }
  }
  const tickets = notes.filter((n) => n.type === "ticket")
    .map((n) => ({ key: n.ext_id, title: n.title, done: n.done, status: n.status, parent: parentOf.get(n.ext_id) ?? null }));
  const epicKeys = [...new Set([...parentOf.values()].filter((k) => !ticketKeys.has(k)))];

  return {
    today,
    counts: { notes: notes.length, byType, tags },
    gaps: {
      ticketSections: sectionGaps, tickets: byType.ticket ?? 0,
      thinTickets: thin.slice(0, 25), thinTotal: thin.length,
      unresolvedLinks: unresolved.filter((u) => !JIRA_KEY.test(u.name)),
      unresolvedJiraKeys: unresolved.filter((u) => JIRA_KEY.test(u.name)).length,
      missingJournal, journalLookback: JOURNAL_LOOKBACK,
    },
    search: { chunks, embedded, pending: chunks - embedded, model, files, indexed: notes.length, invalid: Math.max(0, files - notes.length), dbBytes },
    activity: { since, days: activity },
    graph: { epics: epicKeys, tickets, knowledge: [...knowledge.values()] },
  };
}
