// npm run jira-sync -- <search-result.json> [more.json ...]
// Input: saved results of the Atlassian MCP JQL search for the user's assigned tickets (see the jira-sync skill).
import { config } from "../config.js";
import { openDb } from "../db.js";
import { Indexer } from "../indexer.js";
import { readIssues, syncIssue, type SyncAction } from "../jira-sync.js";
import { embedPending } from "../vectors.js";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: npm run jira-sync -- <search-result.json> [more.json ...]");
  process.exit(2);
}

const db = openDb(config.dbPath, { model: config.embedModel, dim: config.embedDim });
const indexer = new Indexer(db, config.vaultDir, config.brain);
indexer.reindexAll(); // so existing notes (incl. hand edits) are found by key

const opts = { brain: config.brain, vaultDir: config.vaultDir, doneStatuses: config.jiraDoneStatuses };
const stats: Record<SyncAction, string[]> = { created: [], updated: [], unchanged: [], skipped: [] };
let failed = 0;
for (const file of files) {
  for (const issue of readIssues(file)) {
    try { stats[syncIssue(db, indexer, opts, issue)].push(issue.key); }
    catch (e) { failed++; console.error(`  ${issue.key}: ${e}`); }
  }
}
indexer.resolveLinks();
const embedded = process.argv.includes("--no-embed") ? 0 : await embedPending(db);
const done = db.prepare("SELECT count(*) AS n FROM notes WHERE type='ticket' AND done IS NOT NULL").get() as { n: number };
db.close();

console.log(`jira-sync into ${config.vaultDir}`);
console.log(`  created ${stats.created.length} · updated ${stats.updated.length} · unchanged ${stats.unchanged.length} · skipped ${stats.skipped.length} · failed ${failed} · embedded ${embedded} chunks`);
if (stats.updated.length) console.log(`  updated: ${stats.updated.join(", ")}`);
if (stats.skipped.length) console.log(`  skipped (no key/summary): ${stats.skipped.join(", ")}`);
console.log(`  ${done.n} ticket notes have a done date`);
process.exit(failed ? 1 : 0);
