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
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
src/config.ts    env (.env) -> paths, brain name, token
src/schema.ts    zod: frontmatter + POST /memories payload; brain/type enums
src/db.ts        SQLite schema (notes, chunks, chunks_fts, links, note_tags)
src/parse.ts     gray-matter -> header chunk + one chunk per heading; wikilinks
src/indexer.ts   hash-skip, transactional upsert, prune, link resolution
src/search.ts    FTS5 search (quoted tokens, exact ext_id boosted first) + timeline
src/cli/         reindex, search
```

## Next (build order)

4. chokidar watcher + embeddings (`chunks_vec` via sqlite-vec) + RRF fusion
5. Hono REST adapter (`/memories`, `/search`, `/timeline`, `/related`) then MCP adapter
6. Hook up the Claude desktop app · 7. Jira ticket skill
