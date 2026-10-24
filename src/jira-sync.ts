// Jira issues (as returned by the Atlassian MCP JQL search) -> ticket notes.
// Owns only: title, status, assignee, the parent epic link, an issue-type tag, `done` when unset,
// and Summary for notes that don't have one yet. Sections written by the jira* skills are never touched.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { DB } from "./db.js";
import type { Indexer } from "./indexer.js";
import { setDone, splitSections, writeNote } from "./writer.js";

export interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    statuscategorychangedate?: string;
    resolutiondate?: string;
    created?: string;
    updated?: string;
    parent?: { key?: string };
    issuetype?: { name?: string };
    assignee?: { displayName?: string } | null;
    description?: string | AdfNode | null; // MCP search: markdown/HTML string; REST v3: Atlassian Document Format
  };
}

export interface SyncOptions { brain: string; vaultDir: string; doneStatuses: string[] }
export type SyncAction = "created" | "updated" | "unchanged" | "skipped";

/** "2026-10-08T15:43:21.741+1000" -> "2026-10-08": the date part is already the site's local time. */
const day = (ts?: string) => (ts && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : undefined);

export interface AdfNode { type?: string; text?: string; content?: AdfNode[] }

/** ADF -> text with blank lines between blocks; headings, media and rules dropped (same rules as markdown below). */
function adfToText(node: AdfNode): string {
  const inline = (n: AdfNode): string => (n.type === "text" ? n.text ?? "" : n.type === "hardBreak" ? " " : (n.content ?? []).map(inline).join(""));
  const blocks: string[] = [];
  const walk = (n: AdfNode) => {
    if (n.type === "paragraph") blocks.push(inline(n));
    else if (["heading", "mediaSingle", "mediaGroup", "rule", "table", "codeBlock"].includes(n.type ?? "")) return;
    else (n.content ?? []).forEach(walk);
  };
  walk(node);
  return blocks.join("\n\n");
}

/** First paragraph of a Jira description as plain text, for a new note's Summary. */
function firstParagraph(raw?: string | AdfNode | null): string {
  if (!raw) return "";
  const desc = typeof raw === "string" ? raw : adfToText(raw);
  const text = desc
    .replace(/<[^>]+>/g, " ") // descriptions with mentions/panels come back as HTML
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;|&#39;/g, "'")
    .replace(/\r/g, "");
  // First block of prose: skip headings, images, rules and tables. A heading must never reach the note,
  // where "## ..." would start a new section instead of filling Summary.
  const para = text.split(/\n\s*\n/)
    .map((p) => p.split("\n").filter((l) => !/^\s*(#{1,6}\s|!\[|[-*_]{3,}\s*$|\|)/.test(l)).join(" "))
    .map((p) => p.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ").trim())
    .find(Boolean) ?? "";
  return para.length > 400 ? `${para.slice(0, 400).replace(/\s+\S*$/, "")}…` : para;
}

/** Apply one issue. Writes only when something the sync owns actually changed, so `updated` stays meaningful. */
export function syncIssue(db: DB, indexer: Indexer, o: SyncOptions, issue: JiraIssue): SyncAction {
  const f = issue.fields ?? {};
  if (!issue.key || !/^[A-Za-z0-9._-]+$/.test(issue.key) || !f.summary) return "skipped";

  const status = f.status?.name;
  const assignee = f.assignee?.displayName;
  const parent = f.parent?.key;
  const typeTag = f.issuetype?.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const isDone = !!status && o.doneStatuses.some((s) => s.toLowerCase() === status.toLowerCase());
  const doneDate = isDone ? day(f.statuscategorychangedate) ?? day(f.resolutiondate) ?? day(f.updated) : undefined;

  const row = db.prepare<[string, string], { path: string }>(
    "SELECT path FROM notes WHERE brain=? AND type='ticket' AND lower(ext_id)=lower(?)").get(o.brain, issue.key);
  const existing = row ? matter(fs.readFileSync(path.join(o.vaultDir, ...row.path.split("/")), "utf8")) : undefined;
  const data = existing?.data ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const hasSummary = !!existing && splitSections(existing.content).some((s) => s.heading.toLowerCase() === "summary" && s.lines.join("").trim());
  const summary = hasSummary ? "" : firstParagraph(f.description);

  const changed = !existing
    || data.title !== f.summary
    || (status !== undefined && data.status !== status)
    || (assignee !== undefined && data.assignee !== assignee)
    || (!!parent && !list(data.links).includes(parent))
    || (!!typeTag && !list(data.tags).includes(typeTag))
    || !!summary;

  if (changed) {
    writeNote(db, indexer, o.vaultDir, {
      brain: o.brain, type: "ticket", ext_id: issue.key, title: f.summary,
      date: day(f.created) ?? day(f.updated) ?? new Date().toLocaleDateString("en-CA"),
      status, assignee, source: "jira",
      links: parent ? [parent] : [], tags: typeTag ? [typeTag] : [],
      summary,
    });
  }
  // Never clears or moves an existing done date (a PR or "mark done" may have set it first).
  const needsDone = !!doneDate && !data.done;
  if (needsDone) setDone(db, indexer, o.vaultDir, o.brain, issue.key, doneDate!);

  if (!existing) return "created";
  return changed || needsDone ? "updated" : "unchanged";
}

export type SyncStats = Record<SyncAction, string[]> & { failed: string[] };

/** Apply many issues; one failure doesn't stop the rest. Resolves links once at the end. */
export function syncIssues(db: DB, indexer: Indexer, o: SyncOptions, issues: JiraIssue[]): SyncStats {
  const stats: SyncStats = { created: [], updated: [], unchanged: [], skipped: [], failed: [] };
  for (const issue of issues) {
    try { stats[syncIssue(db, indexer, o, issue)].push(issue.key); }
    catch (e) { stats.failed.push(issue.key); console.error(`  ${issue.key}: ${e}`); }
  }
  indexer.resolveLinks();
  return stats;
}

/** Issues from a saved Atlassian MCP search result ({ issues: { nodes } }), or a plain array of issues. */
export function readIssues(file: string): JiraIssue[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const nodes = raw?.issues?.nodes ?? raw?.issues ?? raw?.nodes ?? raw;
  if (!Array.isArray(nodes)) throw new Error(`${file}: no issues found (expected issues.nodes or an array)`);
  return nodes as JiraIssue[];
}
