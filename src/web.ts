// Ticket dashboard: npm run web -> http://127.0.0.1:4317
// Local only: bound to 127.0.0.1, Host-checked, and writes need a custom header (blocks cross-site requests).
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import matter from "gray-matter";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { jiraConfigured, searchAll } from "./jira-api.js";
import { syncIssues } from "./jira-sync.js";
import { embedPending } from "./vectors.js";
import { watchVault } from "./watch.js";
import { setDone, splitSections, today } from "./writer.js";

const db = openDb(config.dbPath, { model: config.embedModel, dim: config.embedDim });
const indexer = new Indexer(db, config.vaultDir, config.brain);
indexer.reindexAll();

// Live updates: every watcher batch pings connected pages, which re-fetch. (Embedding is left to the MCP server.)
const clients = new Set<(event: string) => void>();
const broadcast = async () => { for (const send of clients) send("changed"); };
watchVault(config.vaultDir, indexer, broadcast);

interface TicketRow {
  ext_id: string; title: string; status: string | null; date: string; updated: string;
  done: string | null; assignee: string | null; path: string;
}

function readTicket(row: TicketRow) {
  const raw = fs.readFileSync(path.join(config.vaultDir, ...row.path.split("/")), "utf8");
  const sections: Record<string, string> = {};
  for (const s of splitSections(matter(raw).content)) if (s.heading) sections[s.heading] = s.lines.join("\n").trim();
  const pr = (sections["What changed"] ?? "").match(/^\s*[-*]\s*PR:\s*(\S+)/m)?.[1] ?? null;
  const branch = (sections["What changed"] ?? "").match(/\b((?:fix|feature)\/[\w.-]+)/)?.[1] ?? null;
  return { ...row, jira_url: config.jiraBrowseUrl + row.ext_id, pr, branch, sections };
}

/** Tickets assigned to me, plus any with no assignee recorded; `hidden` counts the ones assigned to others. */
function tickets() {
  const rows = db.prepare(
    "SELECT ext_id, title, status, date, updated, done, assignee, path FROM notes WHERE brain = ? AND type = 'ticket'",
  ).all(config.brain) as TicketRow[];
  const me = config.jiraAssignee.trim().toLowerCase();
  const mine = rows.filter((r) => !r.assignee || r.assignee.trim().toLowerCase() === me);
  return {
    assignee: config.jiraAssignee,
    hidden: rows.length - mine.length,
    tickets: mine.flatMap((row) => {
      try { return [readTicket(row)]; } catch { return []; } // file deleted since it was indexed; the watcher will prune it
    }),
  };
}

const app = new Hono();
const allowedHosts = new Set([`127.0.0.1:${config.webPort}`, `localhost:${config.webPort}`]);

app.use("*", async (c, next) => {
  if (!allowedHosts.has(c.req.header("host") ?? "")) return c.text("forbidden host", 403);
  if (c.req.method !== "GET") {
    const origin = c.req.header("origin");
    if (c.req.header("x-brain") !== "1" || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, "")))) {
      return c.text("forbidden", 403);
    }
  }
  await next();
});

const page = path.join(config.root, "src", "web", "dashboard.html");
app.get("/", (c) => c.html(fs.readFileSync(page, "utf8")));

// --- Refresh from Jira (REST, API token). One run at a time; state is pushed to pages over SSE. ---
const jiraAuth = { site: config.jiraSite, email: config.jiraEmail, token: config.jiraApiToken };
interface RefreshState {
  configured: boolean; running: boolean; finishedAt: string | null; error: string | null;
  counts: { created: number; updated: number; unchanged: number; failed: number } | null;
}
const refresh: RefreshState = { configured: jiraConfigured(jiraAuth), running: false, finishedAt: null, error: null, counts: null };

async function runRefresh() {
  refresh.running = true; refresh.error = null;
  void broadcast();
  try {
    const issues = await searchAll(jiraAuth, config.jiraJql);
    const s = syncIssues(db, indexer, { brain: config.brain, vaultDir: config.vaultDir, doneStatuses: config.jiraDoneStatuses }, issues);
    refresh.counts = { created: s.created.length, updated: s.updated.length, unchanged: s.unchanged.length, failed: s.failed.length };
    if (s.failed.length) refresh.error = `${s.failed.length} ticket(s) failed: ${s.failed.join(", ")}`;
    void embedPending(db).catch((e) => console.error(`embedding failed: ${e}`)); // keeps semantic search current
  } catch (e) {
    refresh.error = e instanceof Error ? e.message : String(e);
  } finally {
    refresh.running = false; refresh.finishedAt = new Date().toISOString();
    void broadcast();
  }
}

app.post("/api/refresh", (c) => {
  if (!refresh.configured) return c.json({ ...refresh, error: "Add JIRA_EMAIL and JIRA_API_TOKEN to brain-server\\.env, then restart the dashboard." }, 400);
  if (!refresh.running) void runRefresh();
  return c.json(refresh, 202);
});

app.get("/api/tickets", (c) => c.json({ today: today(), refresh, ...tickets() }));

app.post("/api/tickets/:key/done", async (c) => {
  const body = await c.req.json<{ date?: string; undo?: boolean }>().catch(() => ({} as { date?: string; undo?: boolean }));
  if (body.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  try {
    const r = setDone(db, indexer, config.vaultDir, config.brain, c.req.param("key"), body.undo ? null : body.date ?? today());
    void broadcast();
    return c.json(r);
  } catch (e) {
    return c.json({ error: String(e) }, 404);
  }
});

app.get("/api/events", (c) => streamSSE(c, async (stream) => {
  const send = (event: string) => void stream.writeSSE({ event, data: String(Date.now()) });
  clients.add(send);
  stream.onAbort(() => { clients.delete(send); });
  while (!stream.aborted) {
    await stream.writeSSE({ event: "ping", data: "" }); // keeps proxies/browsers from timing out
    await stream.sleep(25_000);
  }
}));

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.webPort }, (info) =>
  console.log(`ticket dashboard on http://127.0.0.1:${info.port} (vault ${config.vaultDir})`));
