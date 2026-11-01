/**
 * Keeps the entry chunk (assets/index-*.js) a leaf that no other chunk imports. index.html's boot-retry script
 * loads it again as index-*.js?r=… when the plain URL was answered with something else (an edge's cached
 * index.html); a chunk importing "./index-*.js" would still get the bad copy, and the app would never start.
 * So everything src/main.ts reaches by static imports (not main.ts itself) goes into one 'shell' chunk, with
 * Vite's preload helper and modulepreload polyfill; what only the dynamic import('./ui/app') reaches stays put.
 */

/** The part of Rollup's manualChunks meta used here. */
export interface ChunkMeta {
  getModuleIds(): IterableIterator<string>;
  getModuleInfo(id: string): { importedIds: readonly string[] } | null;
}

const MAIN = /[\\/]src[\\/]main\.ts$/;
const VITE_HELPERS = /vite\/(preload-helper|modulepreload-polyfill)/;

/** A manualChunks function (one per build: it remembers the shell's modules once the graph is complete). */
export function shellChunks(): (id: string, meta: ChunkMeta) => string | undefined {
  let shell: Set<string> | null = null;
  return (id, meta) => {
    if (MAIN.test(id)) return undefined;
    if (VITE_HELPERS.test(id)) return 'shell';
    shell ??= staticallyReached(meta);
    return shell.has(id) ? 'shell' : undefined;
  };
}

/** Every module src/main.ts reaches through static imports, main.ts excluded. */
function staticallyReached(meta: ChunkMeta): Set<string> {
  const seen = new Set<string>();
  const main = [...meta.getModuleIds()].find((id) => MAIN.test(id));
  const todo = main ? [...(meta.getModuleInfo(main)?.importedIds ?? [])] : [];
  for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
    if (seen.has(id) || MAIN.test(id)) continue;
    seen.add(id);
    todo.push(...(meta.getModuleInfo(id)?.importedIds ?? []));
  }
  return seen;
}
