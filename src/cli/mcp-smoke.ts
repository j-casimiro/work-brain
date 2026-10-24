// End-to-end check of the MCP server against a throwaway vault: npm run mcp:smoke
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { config } from "../config.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-smoke-"));
const vault = path.join(tmp, "vault");
fs.cpSync(path.join(config.vaultDir, "_templates"), path.join(vault, "_templates"), { recursive: true });

const dbPath = path.join(tmp, "memory.db");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(config.root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(config.root, "src", "mcp.ts")],
  // MODELS_DIR is reused so the test doesn't download the model again.
  env: { ...(process.env as Record<string, string>), VAULT_DIR: vault, DB_PATH: dbPath, MODELS_DIR: config.modelsDir },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

let failures = 0;
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0].text, isError: !!r.isError };
};
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
};
const read = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Read-only peek at the server's index (WAL lets us read while it writes).
const peek = <T>(sql: string, ...params: unknown[]): T => {
  const d = new Database(dbPath, { readonly: true });
  sqliteVec.load(d);
  try { return d.prepare(sql).get(...params) as T; } finally { d.close(); }
};
const whyChunk = () => peek<{ id: number } | undefined>(
  "SELECT c.id FROM chunks c JOIN notes n ON n.id = c.note_id WHERE n.ext_id = 'SMS-1' AND c.heading = 'Why'")?.id;

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("lists 6 tools", tools.join() === "append_log,get_note,related,search,timeline,write_note", tools.join());

let r = await call("write_note", {
  type: "ticket", ext_id: "SMS-1", title: "Smoke ticket", date: "2026-10-24", status: "In Progress", source: "jira",
  summary: "Work requests show in planner.", tags: ["planner"], links: ["SMS-170", "planner-module"],
  body: "## Why\n\nSetting gates it.\n",
});
check("write_note creates ticket", !r.isError && JSON.parse(r.text).created === true, r.text);
const rel = "tickets/2026/SMS-1.md";
check("file at tickets/<yyyy>/<KEY>.md", fs.existsSync(path.join(vault, rel)));
check("template sections present", ["## What changed", "## Modules touched", "## Follow-ups"].every((h) => read(rel).includes(h)));

const whyBefore = whyChunk();
// Hand edit, then a partial update: only What changed should be replaced.
fs.writeFileSync(path.join(vault, rel), read(rel).replace("## Follow-ups\n", "## Follow-ups\n\n- hand-written note\n"));
r = await call("write_note", {
  type: "ticket", ext_id: "SMS-1", title: "Smoke ticket", date: "2030-01-01", status: "Done in BRANCH", source: "jira",
  tags: ["settings"], body: "## What changed\n\n- Branch fix/SMS-1-smoke\n",
});
const merged = read(rel);
check("update keeps hand edit", merged.includes("- hand-written note"));
check("update keeps Summary and Why", merged.includes("Work requests show in planner.") && merged.includes("Setting gates it."));
check("update sets What changed", merged.includes("- Branch fix/SMS-1-smoke"));
check("update keeps original date", /^date: 2026-10-24$/m.test(merged), merged);
check("status with spaces round-trips", /^status: Done in BRANCH$/m.test(merged), merged);
check("tags merged", /^tags: \[planner, settings\]$/m.test(merged), merged);
check("unchanged section keeps its chunk id", whyBefore !== undefined && whyChunk() === whyBefore, `${whyBefore} -> ${whyChunk()}`);

r = await call("search", { q: "work request" });
check("search finds stemmed words", r.text.includes("SMS-1"), r.text);
r = await call("search", { q: "SMS-1" });
check("search by key ranks note first", JSON.parse(r.text)[0]?.ext_id === "SMS-1", r.text);

r = await call("write_note", { type: "module", ext_id: "planner-module", title: "Planner", date: "2026-10-24", body: "## Purpose\n\nPlans work.\n" });
r = await call("related", { id: "planner-module" });
check("related shows backlink from ticket", JSON.parse(r.text).incoming?.some((n: { ext_id: string }) => n.ext_id === "SMS-1"), r.text);
r = await call("related", { id: "SMS-1" });
const out = JSON.parse(r.text).outgoing as { name: string; ext_id: string | null }[];
check("related resolves and keeps unresolved", out.some((o) => o.ext_id === "planner-module") && out.some((o) => o.name === "SMS-170" && !o.ext_id), r.text);

r = await call("get_note", { id: "sms-1" });
check("get_note is case-insensitive", r.text.includes("Smoke ticket"));
r = await call("get_note", { id: "SMS-404" });
check("get_note missing is an error", r.isError);

await call("append_log", { text: "Worked on SMS-1", date: "2026-10-24" });
r = await call("append_log", { text: "FTS needs stemming", section: "Learned", date: "2026-10-24" });
const j = read("journal/2026/10/2026-10-24.md");
check("append_log creates journal from template", JSON.parse(r.text).path === "journal/2026/10/2026-10-24.md" && j.includes("## Tomorrow"), j);
check("append_log bullets in right sections", /## Did\n\n- Worked on SMS-1\n/.test(j) && /## Learned\n\n- FTS needs stemming\n/.test(j), j);

r = await call("timeline", { from: "2026-10-01", to: "2026-10-31" });
check("timeline lists the month", JSON.parse(r.text).length === 3, r.text);

r = await call("write_note", { type: "ticket", ext_id: "../evil", title: "x", date: "2026-10-24" });
check("rejects unsafe ext_id", r.isError, r.text);

// Semantic: no shared words between query and note.
await call("write_note", {
  type: "ticket", ext_id: "SMS-2", title: "Invoice rounding", date: "2026-11-02", status: "To Do",
  body: "## Why\n\nInvoice totals are rounded per line before the discount is applied, so the grand total drifts.\n",
});
r = await call("search", { q: "billing amounts off by a cent" });
const sem = (JSON.parse(r.text) as { ext_id: string; match: string }[]).find((h) => h.ext_id === "SMS-2");
check("semantic search finds a paraphrase", sem?.match === "semantic", r.text);
r = await call("search", { q: "zebra migration patterns in the serengeti" });
check("unrelated query returns nothing", JSON.parse(r.text).length === 0, r.text);
r = await call("timeline", { by: "updated", from: new Date().toLocaleDateString("en-CA") });
check("timeline by updated finds notes touched today", (JSON.parse(r.text) as { ext_id: string }[]).some((n) => n.ext_id === "SMS-2"), r.text);
const cov = peek<{ c: number; v: number }>("SELECT (SELECT count(*) FROM chunks) AS c, (SELECT count(*) FROM chunks_vec) AS v");
check("every chunk is embedded", cov.c > 0 && cov.c === cov.v, JSON.stringify(cov));

// Watcher: files written or deleted on disk, without any tool call.
const hand = path.join(vault, "decisions", "2026-11-03-use-wasm.md");
fs.mkdirSync(path.dirname(hand), { recursive: true });
fs.writeFileSync(hand, "---\nbrain: work\ntype: decision\nid: 2026-11-03-use-wasm\ntitle: Run embeddings on WASM\ndate: 2026-11-03\ntags: []\nlinks: []\n---\n\n## Decision\n\nNative onnxruntime segfaults here; use onnxruntime-web.\n");
let found = false;
for (let i = 0; i < 20 && !found; i++) { await sleep(250); found = (await call("search", { q: "segfaults" })).text.includes("use-wasm"); }
check("watcher indexes a new file", found);
fs.rmSync(hand);
let gone = false;
for (let i = 0; i < 20 && !gone; i++) { await sleep(250); gone = (await call("get_note", { id: "2026-11-03-use-wasm" })).isError; }
check("watcher removes a deleted file", gone);

await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
