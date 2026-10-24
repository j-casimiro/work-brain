import fs from "node:fs";
import path from "node:path";
import { watch } from "chokidar";
import { IGNORED_DIRS, type Indexer } from "./indexer.js";

const DEBOUNCE_MS = 300;

/**
 * Re-index vault files as they change. Editors (Obsidian, VS Code) on NTFS write in bursts,
 * so writes must settle (awaitWriteFinish) and changes are batched (debounce) before indexing.
 * `afterBatch` runs once per batch (e.g. embedding new chunks); batches never overlap.
 */
export function watchVault(vaultDir: string, indexer: Indexer, afterBatch: () => Promise<unknown>) {
  const ignored = (p: string, stats?: fs.Stats) => {
    const rel = path.relative(vaultDir, p);
    if (!rel) return false;
    if (rel.split(path.sep).some((seg) => IGNORED_DIRS.has(seg))) return true;
    // Only .md files below the root are notes (root-level files like README.md are not).
    return !!stats?.isFile() && (!p.toLowerCase().endsWith(".md") || path.dirname(p) === vaultDir);
  };
  const watcher = watch(vaultDir, {
    ignored, ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const flush = () => {
    const batch = [...pending];
    pending.clear();
    chain = chain.then(async () => {
      for (const abs of batch) {
        try {
          if (fs.existsSync(abs)) indexer.indexFile(abs);
          else indexer.removeFile(abs);
        } catch (err) { console.error(`  watch: ${abs} — ${err}`); }
      }
      indexer.resolveLinks();
      await afterBatch();
    }).catch((err) => console.error(`  watch batch failed: ${err}`));
  };
  const queue = (abs: string) => {
    pending.add(abs);
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  };

  watcher.on("add", queue).on("change", queue).on("unlink", queue);
  // A deleted or renamed folder: drop whatever was indexed under it.
  watcher.on("unlinkDir", () => { chain = chain.then(() => { indexer.reindexAll(); return afterBatch(); }).catch(() => {}); });
  watcher.on("error", (err) => console.error(`  watcher error: ${err}`));
  return watcher;
}
