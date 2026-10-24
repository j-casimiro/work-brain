// npm run jira-sync                      -> fetch from Jira with JIRA_EMAIL / JIRA_API_TOKEN (brain-server\.env)
// npm run jira-sync -- <result.json> ... -> use saved Atlassian MCP search results instead
import { config } from "../config.js";
import { openDb } from "../db.js";
import { Indexer } from "../indexer.js";
import { searchAll } from "../jira-api.js";
import { readIssues, syncIssues, type JiraIssue } from "../jira-sync.js";
import { embedPending } from "../vectors.js";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let issues: JiraIssue[];
try {
  issues = files.length
    ? files.flatMap(readIssues)
    : await searchAll({ site: config.jiraSite, email: config.jiraEmail, token: config.jiraApiToken }, config.jiraJql);
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(2);
}

const db = openDb(config.dbPath, { model: config.embedModel, dim: config.embedDim });
const indexer = new Indexer(db, config.vaultDir, config.brain);
indexer.reindexAll(); // so existing notes (incl. hand edits) are found by key

const stats = syncIssues(db, indexer, { brain: config.brain, vaultDir: config.vaultDir, doneStatuses: config.jiraDoneStatuses }, issues);
const embedded = process.argv.includes("--no-embed") ? 0 : await embedPending(db);
const done = db.prepare("SELECT count(*) AS n FROM notes WHERE type='ticket' AND done IS NOT NULL").get() as { n: number };
db.close();

console.log(`jira-sync (${files.length ? "files" : "Jira API"}) into ${config.vaultDir}`);
console.log(`  created ${stats.created.length} · updated ${stats.updated.length} · unchanged ${stats.unchanged.length} · skipped ${stats.skipped.length} · failed ${stats.failed.length} · embedded ${embedded} chunks`);
if (stats.updated.length) console.log(`  updated: ${stats.updated.join(", ")}`);
if (stats.skipped.length) console.log(`  skipped (no key/summary): ${stats.skipped.join(", ")}`);
console.log(`  ${done.n} ticket notes have a done date`);
process.exit(stats.failed.length ? 1 : 0);
