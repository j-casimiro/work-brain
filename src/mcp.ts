// MCP adapter over stdio. Claude Code starts this process; stdout carries the protocol, so log to stderr only.
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { NOTE_TYPES } from "./schema.js";
import { findNote, related, search, timeline } from "./search.js";
import { embedPending } from "./vectors.js";
import { watchVault } from "./watch.js";
import { appendLog, writeNote } from "./writer.js";

console.log = console.error; // anything that logs must not corrupt the protocol stream

const db = openDb(config.dbPath, { model: config.embedModel, dim: config.embedDim });
const indexer = new Indexer(db, config.vaultDir, config.brain);
indexer.reindexAll(); // catch up on edits made while no server was running

// One embedding pass at a time; callers await the pass that covers their change.
let embedding: Promise<unknown> = Promise.resolve();
const embedNow = () => (embedding = embedding.then(() => embedPending(db)).catch((e) => console.error(`embedding failed: ${e}`)));
embedNow(); // in the background: the server answers (keyword-only for pending chunks) while this runs
watchVault(config.vaultDir, indexer, embedNow);

const brain = config.brain;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const type = z.enum(NOTE_TYPES);
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const server = new McpServer({ name: `${brain}-brain`, version: "0.2.0" });

server.registerTool("search", {
  description: `Hybrid search over the ${brain} brain's notes (tickets with Jira keys like SMS-1011, journal, decisions, modules, features, calcs): stemmed keyword (BM25) and local semantic embeddings, fused by rank. Works for exact ids and for paraphrases ("where do work requests get scheduled"). An exact note id ranks first; one hit per note. Each hit says whether it matched by keyword, semantic or both. Use get_note for full text.`,
  inputSchema: { q: z.string().min(1), type: type.optional(), from: date.optional(), to: date.optional(), limit: z.number().int().min(1).max(50).optional() },
}, async ({ q, ...f }) => json(await search(db, q, { brain, ...f })));

server.registerTool("timeline", {
  description: "Notes dated within a range, oldest first (e.g. what was worked on this week).",
  inputSchema: { from: date.optional(), to: date.optional(), type: type.optional(), limit: z.number().int().min(1).max(500).optional() },
}, async (f) => json(timeline(db, { brain, ...f })));

server.registerTool("get_note", {
  description: "Full markdown of one note, by id (e.g. SMS-1011, a slug, or a journal date) or vault-relative path.",
  inputSchema: { id: z.string().min(1), type: type.optional() },
}, async ({ id, type }) => {
  const n = findNote(db, id, { brain, type });
  if (!n) return fail(`No note "${id}"${type ? ` of type ${type}` : ""}.`);
  return { content: [{ type: "text" as const, text: `<!-- ${n.path} -->\n${fs.readFileSync(path.join(config.vaultDir, n.path), "utf8")}` }] };
});

server.registerTool("related", {
  description: "Graph neighbours of a note: what it links to (frontmatter links and [[wikilinks]]; unresolved names included) and what links to it.",
  inputSchema: { id: z.string().min(1), type: type.optional() },
}, async ({ id, type }) => {
  const n = findNote(db, id, { brain, type });
  return n ? json({ note: n, ...related(db, n.id) }) : fail(`No note "${id}".`);
});

server.registerTool("write_note", {
  description: "Create or update a note; idempotent on (type, ext_id). On update, keeps the original date and any frontmatter it doesn't set, merges tags/links, and replaces ONLY the '## ' sections included in body (others, including hand edits, are kept). `summary`, if given, becomes the '## Summary' section. Search first so links point at existing module/feature/calc notes.",
  inputSchema: {
    type, ext_id: z.string().min(1).describe("Jira key for tickets (SMS-1011), slug otherwise, date for journal"),
    title: z.string().min(1), date: date.describe("YYYY-MM-DD; only used when the note is created"),
    summary: z.string().optional(), body: z.string().optional().describe("Markdown with '## ' sections to set"),
    tags: z.array(z.string()).optional(), links: z.array(z.string()).optional(),
    status: z.string().optional(), source: z.string().optional().describe('e.g. "jira"; default "agent"'), commit_sha: z.string().optional(),
  },
}, async (args) => {
  try { const r = writeNote(db, indexer, config.vaultDir, { brain, ...args }); await embedNow(); return json(r); }
  catch (e) { return fail(String(e)); }
});

server.registerTool("append_log", {
  description: "Append a bullet to a journal day (default today) under a section (default 'Did'; template sections: Did, Learned, Blocked / waiting, Tomorrow). Creates the day's note from the template if missing.",
  inputSchema: { text: z.string().min(1), section: z.string().optional(), date: date.optional() },
}, async ({ text, section, date }) => {
  try { const r = appendLog(db, indexer, config.vaultDir, brain, text, section, date); await embedNow(); return json(r); }
  catch (e) { return fail(String(e)); }
});

await server.connect(new StdioServerTransport());
