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

Tools: `search`, `timeline`, `get_note`, `related`, `write_note`, `append_log`. Until the watcher exists, each call runs an incremental reindex first, so hand edits are picked up. `write_note` merges by `## ` section (see `src/writer.ts`).

## Layout

```
src/config.ts    env (.env) -> paths, brain name, token
src/schema.ts    zod: frontmatter + POST /memories payload; brain/type enums
src/db.ts        SQLite schema (notes, chunks, chunks_fts, links, note_tags)
src/parse.ts     gray-matter -> header chunk + one chunk per heading; wikilinks
src/indexer.ts   hash-skip, transactional upsert, prune, link resolution
src/search.ts    FTS5 search (quoted tokens, exact ext_id boosted first), timeline, findNote, related
src/writer.ts    write_note / append_log: payload -> markdown at the right path, section merge, then index
src/mcp.ts       MCP adapter (stdio)
src/cli/         reindex, search, mcp-smoke
```

## Next (build order)

4. chokidar watcher + embeddings (transformers.js, `chunks_vec` via sqlite-vec) + RRF fusion
5b. Hono REST adapter over the same core (`/memories`, `/search`, `/timeline`, `/related`), bearer token, 127.0.0.1 only
