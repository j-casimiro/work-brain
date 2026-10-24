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
src/cli/         reindex [--full] [--no-embed], search, mcp-smoke
```

## Next

5b. Hono REST adapter over the same core (`/memories`, `/search`, `/timeline`, `/related`), bearer token, 127.0.0.1 only
