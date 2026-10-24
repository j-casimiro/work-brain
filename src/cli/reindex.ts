import { config } from "../config.js";
import { dropDb, openDb } from "../db.js";
import { Indexer } from "../indexer.js";

const full = process.argv.includes("--full");
if (full) dropDb(config.dbPath);

const t0 = performance.now();
const db = openDb(config.dbPath);
const stats = new Indexer(db, config.vaultDir, config.brain).reindexAll(full);
const { n } = db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number };
db.close();

console.log(`${full ? "full" : "incremental"} reindex of ${config.vaultDir}`);
console.log(`  indexed ${stats.indexed} · unchanged ${stats.unchanged} · skipped ${stats.skipped} · removed ${stats.removed}`);
console.log(`  ${n} notes in ${config.dbPath} (${Math.round(performance.now() - t0)} ms)`);
