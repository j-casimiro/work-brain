// Quick manual check: npm run search -- "discount rounding" [--type ticket]
import { config } from "../config.js";
import { openDb } from "../db.js";
import { search } from "../search.js";

const args = process.argv.slice(2);
const typeIdx = args.indexOf("--type");
const type = typeIdx >= 0 ? args.splice(typeIdx, 2)[1] : undefined;
const db = openDb(config.dbPath, { model: config.embedModel, dim: config.embedDim });
const hits = await search(db, args.join(" "), { brain: config.brain, type });
for (const h of hits) console.log(`${h.ext_id.padEnd(16)} ${h.type.padEnd(9)} ${h.match.padEnd(8)} ${h.path}  §${h.heading}\n    ${h.snippet.replace(/\n/g, " ")}`);
if (!hits.length) console.log("no hits");
db.close();
