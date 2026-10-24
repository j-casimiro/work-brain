import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAINS, type Brain } from "./schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no dependency). Real env vars win.
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const brain = (process.env.BRAIN ?? "work") as Brain;
if (!BRAINS.includes(brain)) throw new Error(`BRAIN must be one of ${BRAINS.join(", ")}`);

export const config = {
  root,
  brain,
  vaultDir: path.resolve(root, process.env.VAULT_DIR ?? "../work-vault"),
  dbPath: path.resolve(root, process.env.DB_PATH ?? "./data/memory.db"),
  apiToken: process.env.API_TOKEN ?? "",
  // Local embedding model (transformers.js). Changing either value re-embeds everything on next start.
  embedModel: process.env.EMBED_MODEL ?? "Xenova/bge-small-en-v1.5",
  embedDim: Number(process.env.EMBED_DIM ?? 384),
  modelsDir: path.resolve(root, process.env.MODELS_DIR ?? "./models"),
  // Ticket dashboard (src/web.ts): always bound to 127.0.0.1.
  webPort: Number(process.env.WEB_PORT ?? 4317),
  jiraBrowseUrl: process.env.JIRA_BROWSE_URL ?? "https://samurai-cmms.atlassian.net/browse/",
  // The dashboard hides tickets assigned to anyone else (tickets with no assignee recorded still show).
  jiraAssignee: process.env.JIRA_ASSIGNEE ?? "Jehu Casimiro",
  // Jira statuses that mean dev implementation/fix is done (jira-sync sets `done` from these).
  jiraDoneStatuses: (process.env.JIRA_DONE_STATUSES ?? "Done in BRANCH,Done in PROD").split(",").map((s) => s.trim()).filter(Boolean),
};
