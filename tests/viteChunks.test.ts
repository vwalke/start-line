import { describe, expect, it } from 'vitest';
import { shellChunks, type ChunkMeta } from '../vite.chunks';

/** A module graph's static imports, as Rollup's manualChunks meta reports it (dynamic imports aren't listed). */
const meta = (graph: Record<string, string[]>): ChunkMeta => ({
  getModuleIds: () => Object.keys(graph)[Symbol.iterator](),
  getModuleInfo: (id) => (id in graph ? { importedIds: graph[id] } : null),
});

const R = '/repo/src';
const graph = {
  '/repo/index.html': [`${R}/main.ts`, '\0vite/modulepreload-polyfill.js'],
  '\0vite/modulepreload-polyfill.js': [],
  [`${R}/main.ts`]: [`${R}/boot.ts`, `${R}/theme.ts`, `${R}/style.css`, '\0vite/preload-helper.js'],
  [`${R}/boot.ts`]: [],
  [`${R}/theme.ts`]: [`${R}/format.ts`, `${R}/main.ts`],
  [`${R}/format.ts`]: [],
  [`${R}/style.css`]: [],
  '\0vite/preload-helper.js': [],
  // Reached only by main's import('./ui/app'), and what it imports.
  [`${R}/ui/app.ts`]: [`${R}/ui/map.ts`, `${R}/format.ts`],
  [`${R}/ui/map.ts`]: [],
};

describe('vite.chunks.ts shellChunks', () => {
  const chunkOf = (ids: string[]) => {
    const fn = shellChunks();
    const m = meta(graph);
    return Object.fromEntries(ids.map((id) => [id, fn(id, m)]));
  };

  it("puts all that main.ts reaches by static imports in 'shell', and Vite's helpers", () => {
    const ids = [`${R}/boot.ts`, `${R}/theme.ts`, `${R}/format.ts`, `${R}/style.css`, '\0vite/preload-helper.js', '\0vite/modulepreload-polyfill.js'];
    for (const [id, chunk] of Object.entries(chunkOf(ids))) expect(chunk, id).toBe('shell');
  });

  it('leaves main.ts itself (the entry), the HTML and what only the app reaches where Rollup puts them', () => {
    const ids = [`${R}/main.ts`, '/repo/index.html', `${R}/ui/app.ts`, `${R}/ui/map.ts`];
    for (const [id, chunk] of Object.entries(chunkOf(ids))) expect(chunk, id).toBeUndefined();
  });

  it('puts nothing in shell without a src/main.ts', () => {
    expect(shellChunks()(`${R}/boot.ts`, meta({ [`${R}/boot.ts`]: [] }))).toBeUndefined();
  });
});
