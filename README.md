# brain-server

Memory core for the Work brain. The vault (`../work-vault`) is the source of truth; `data/memory.db` is a disposable index.

## Setup (PowerShell, from `work-brain\`)

```powershell
cd work-vault;   git init; git add -A; git commit -m "Vault skeleton"; cd ..
cd brain-server; git init; copy .env.example .env; npm install
npm run reindex -- --full
npm run search -- "PROJ-1423"
```

## Commands

| Command | Does |
|---|---|
| `npm run reindex` | Incremental: re-indexes changed files, prunes deleted ones |
| `npm run reindex -- --full` | Deletes `memory.db` and rebuilds from the vault |
| `npm run search -- <words> [--type ticket]` | Keyword (FTS5/BM25) search for manual testing |
| `npm run mcp` | Start the MCP server on stdio (normally Claude Code starts it) |
| `npm run mcp:smoke` | End-to-end check of all MCP tools against a throwaway vault |
| `npm run typecheck` | `tsc --noEmit` |

## MCP server

Registered for Claude Code at user scope (all projects) as `work-brain`, stdio:

```powershell
claude mcp add --scope user work-brain -- "C:\Program Files\nodejs\node.exe" C:\Users\jehu.casimiro\work-brain\brain-server\node_modules\tsx\dist\cli.mjs C:\Users\jehu.casimiro\work-brain\brain-server\src\mcp.ts
```

`claude` isn't on PATH here; the desktop app's copy is under `%APPDATA%\Claude\claude-code\<version>\...\claude.exe`.

Tools: `search`, `timeline`, `get_note`, `related`, `write_note`, `append_log`. `write_note` merges by `## ` section (see `src/writer.ts`).
On start the server runs an incremental reindex, then a chokidar watcher keeps the index current while it runs (hand edits in Obsidian/VS Code included).

## Ticket dashboard

```powershell
npm run web    # http://127.0.0.1:4317
```

- Tickets from the brain, grouped by `done` date: Today, This week (Mon–), Last week, This month, Last month, All done, plus Open (no `done` yet). Click a row for Summary / What changed / Follow-ups, the PR link and branch.
- **Done** = dev implementation/fix finished, separate from the Jira status. Set by `jira-pr-creator` when it creates a PR, by MCP `mark_done` when you tell Claude a ticket is done, or by the page's Mark done / Reopen button. Stored as `done: YYYY-MM-DD` in the note.
- Only tickets assigned to `JIRA_ASSIGNEE` (default "Jehu Casimiro") are shown; notes with no `assignee` still show; the header counts the hidden ones.
- Live: the server watches the vault and pushes an SSE event on every change; the page re-fetches. Changes from skills, MCP tools and hand edits show within about a second.
- Local only: bound to 127.0.0.1, rejects other `Host` headers (DNS rebinding), and writes need an `x-brain` header plus same-origin (no cross-site requests). No CDN assets.

## Brain tab

http://127.0.0.1:4317/#brain (`GET /api/brain`, `src/brain-stats.ts`), live like the tracker:

- **Tiles:** notes by type, tickets done/open, % of sections embedded, journal entries in the last 20 weekdays.
- **Activity calendar:** ~26 weeks; per day, notes created + last updated + done. The index keeps only each note's latest `updated`, so it's "last touched", not full history.
- **Epics and tickets:** epic → ticket → subtask clusters from each ticket's first Jira-key link (its parent). Done = filled, open = ring. Click a ticket to open it in the tracker.
- **Gaps:** empty sections per ticket, tickets without Summary/Why, `[[links]]` to notes that don't exist (Jira-key parents excluded), weekdays without a journal.
- **Search health:** sections vs embedded, model, valid files, index size, last Jira refresh. **Top tags.**

## Jira sync

Three ways in, same write logic (`src/jira-sync.ts`):

- **Dashboard "Refresh from Jira" button** → `POST /api/refresh` → Jira REST (`src/jira-api.ts`, enhanced search `/rest/api/3/search/jql`, paged by `nextPageToken`). Needs `JIRA_EMAIL` + `JIRA_API_TOKEN` in `.env` (restart the dashboard after editing). About 1–2 s, no Claude usage. The token is sent only to `JIRA_SITE` over https and is never logged or exposed to the page.
- **`npm run jira-sync`** (no args) → the same REST fetch from the command line.
- **`npm run jira-sync -- <search-result.json> [...]`** → saved Atlassian MCP JQL results (the `jira-sync` skill's fallback when no token is set).

The query is `JIRA_JQL` (default `project = SMS AND assignee = currentUser() ORDER BY updated DESC`). REST descriptions come as ADF and are flattened to text for the Summary.

- Owns only: title, Jira status, assignee, parent-epic link, issue-type tag, Summary (first prose paragraph of the description, only if the note has none), and `done` when unset.
- `done` = date of `statuscategorychangedate` when the status is in `JIRA_DONE_STATUSES` (default `Done in BRANCH,Done in PROD`). An existing done date (from a PR or `mark_done`) is never changed or cleared.
- Writes only when something it owns changed, so re-running doesn't bump `updated` (the journal relies on that). When it does write, `updated` = the later of the ticket's Jira `updated` date and the note's own.

## Search and embeddings

- `search` = BM25 top 30 + vector kNN top 30, fused by reciprocal rank (`1/(60+rank)`); exact `ext_id` first; one hit per note; each hit says `keyword`, `semantic` or `both`.
- Embeddings: `Xenova/bge-small-en-v1.5` (384-dim, int8 ONNX, ~32 MB in `models/`, downloaded once from Hugging Face). Runs in-process on **onnxruntime-web (WASM)** with `@huggingface/tokenizers`: no note text leaves the laptop. ~12 ms per query.
- Why not `@huggingface/transformers`: its Node build uses native `onnxruntime-node`, which segfaults on this laptop's Windows build (any version/options tested). WASM avoids native code entirely.
- Vectors live in `chunks_vec` (sqlite-vec, cosine). Unchanged chunks keep their row id, so only edited sections are re-embedded. `meta.embed` records `model|dim`; changing `EMBED_MODEL`/`EMBED_DIM` drops the vectors and re-embeds on next start.
- Semantic hits are cut at cosine distance 0.45 (`MAX_DISTANCE` in `src/search.ts`); tune once real notes exist.

## Layout

```
src/config.ts    env (.env) -> paths, brain name, token
src/schema.ts    zod: frontmatter + POST /memories payload; brain/type enums
src/db.ts        SQLite schema (notes, chunks, chunks_fts, links, note_tags)
src/parse.ts     gray-matter -> header chunk + one chunk per heading; wikilinks
src/indexer.ts   hash-skip, transactional upsert, prune, link resolution
src/search.ts    hybrid search (FTS5 + kNN, RRF), timeline, findNote, related
src/embed.ts     tokenizer + onnxruntime-web (WASM) -> normalised CLS embeddings
src/vectors.ts   embedPending (only chunks without a vector), knn
src/watch.ts     chokidar watcher, debounced batches
src/writer.ts    write_note / append_log: payload -> markdown at the right path, section merge, then index
src/mcp.ts       MCP adapter (stdio)
src/web.ts       ticket dashboard + REST (Hono), SSE live updates
src/web/         dashboard.html (single file, no external assets)
src/jira-sync.ts Jira issue -> ticket note (only-if-changed), done from status
src/jira-api.ts  Jira REST search with API token (Refresh button, CLI)
src/brain-stats.ts  Brain tab: counts, gaps, search health, activity, epic graph
src/cli/         reindex [--full] [--no-embed], search, mcp-smoke
```

## Next

5b. More REST routes on `src/web.ts` (`/memories`, `/search`, `/timeline`, `/related`) if something outside Claude needs them
