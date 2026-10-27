import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { legsTable, sortGlyph, startTable, toggleSort } from '../src/ui/table';
import { fixtureRace, m24Race } from './helpers';

/** Each sortable header: its th's attributes, the button's text (its accessible name) and the glyph's class. */
const heads = (html: string): { key: string; th: string; name: string; glyph: string }[] =>
  [...html.matchAll(/<th([^>]*)><button type="button" class="sort" data-sort="([^"]+)">([\s\S]*?)(<span class="si [^"]+" aria-hidden="true">[\s\S]*?<\/span>)<\/button><\/th>/g)].map((m) => ({
    th: m[1],
    key: m[2],
    name: m[3].replace(/<br>/g, ' ').replace(/<[^>]+>/g, '').trim(),
    glyph: /class="si ([^"]+)"/.exec(m[4])![1],
  }));

describe('sortable headers', () => {
  const a = analyzeRace(fixtureRace());
  const s = analyzeRace(m24Race());
  const tables = [
    ['Performance Metrics', (sort?: Parameters<typeof legsTable>[2]) => legsTable(a, null, sort), a],
    ['Start by boat', (sort?: Parameters<typeof startTable>[2]) => startTable(s, null, sort), s],
  ] as const;

  for (const [name, render, race] of tables) {
    it(`${name}: every header is a real button with a name and a quiet up/down glyph at rest, and no aria-sort`, () => {
      const html = render();
      const hs = heads(html);
      expect(hs.length).toBeGreaterThan(2);
      // Every sort button is in a header, and every header found has one.
      expect(hs.length).toBe((html.match(/class="sort"/g) ?? []).length);
      for (const h of hs) {
        expect(h.name.length).toBeGreaterThan(0);
        expect(h.glyph).toBe('si-none');
        expect(h.th).not.toContain('aria-sort');
        expect(h.th).toContain('scope="col"');
      }
      expect(html).not.toContain('aria-sort');
    });

    it(`${name}: the sorted header alone has aria-sort and the matching filled arrow`, () => {
      const key = heads(render())[1].key;
      const first = toggleSort(race, null, key)!;
      const second = toggleSort(race, first, key)!;
      for (const sort of [first, second]) {
        const hs = heads(render(sort));
        const on = hs.filter((h) => h.th.includes('aria-sort'));
        expect(on.map((h) => h.key)).toEqual([key]);
        expect(on[0].th).toContain(`aria-sort="${sort.dir === 'asc' ? 'ascending' : 'descending'}"`);
        expect(on[0].glyph).toBe(`si-${sort.dir}`);
        expect(on[0].th).toMatch(/class="[^"]*\bsorted\b/);
        expect(hs.filter((h) => h.key !== key).every((h) => h.glyph === 'si-none')).toBe(true);
      }
      expect(first.dir).not.toBe(second.dir);
    });

    it(`${name}: the sorted button's accessible name says which way; the others keep just their label`, () => {
      const rest = heads(render());
      const key = rest[1].key;
      for (const h of rest) expect(h.name).not.toMatch(/sorted/);
      const first = toggleSort(race, null, key)!;
      const second = toggleSort(race, first, key)!;
      for (const sort of [first, second]) {
        const hs = heads(render(sort));
        const dir = sort.dir === 'asc' ? 'ascending' : 'descending';
        const on = hs.find((h) => h.key === key)!;
        const label = rest.find((h) => h.key === key)!.name;
        // e.g. "SOG kn, sorted descending": the visible label, then the state in text (visually hidden), not in aria-hidden
        expect(on.name).toBe(`${label}, sorted ${dir}`);
        expect(render(sort)).toContain(`<span class="vh">, sorted ${dir}</span><span class="si si-${sort.dir}" aria-hidden="true">`);
        for (const h of hs.filter((x) => x.key !== key)) expect(h.name).toBe(rest.find((x) => x.key === h.key)!.name);
      }
    });
  }

  it('draws an up/down pair at rest, an up arrow ascending, a down arrow descending', () => {
    const path = (g: string): string => /<path d="([^"]+)"/.exec(g)![1];
    const [none, asc, desc] = [sortGlyph(null), sortGlyph('asc'), sortGlyph('desc')];
    // At rest: two triangles (two subpaths), one pointing up from the top, one down from the bottom.
    expect(path(none).match(/M/g)).toHaveLength(2);
    expect(path(none)).toMatch(/^M4 0 .*M4 12 /);
    // Sorted: one arrow with a stem; its tip at the top (asc) or the bottom (desc).
    expect(path(asc)).toMatch(/^M4 0 /);
    expect(path(desc)).toMatch(/^M4 12 /);
    for (const g of [none, asc, desc]) {
      expect(g).toContain('aria-hidden="true"');
      expect(g).toContain('focusable="false"');
    }
    expect(new Set([path(none), path(asc), path(desc)]).size).toBe(3);
  });

  it('styles them as controls: pointer, hover and focus states, the whole cell the target, 44 px on touch', () => {
    const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
    const rule = (sel: string): string => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    expect(rule('.metrics th .sort')).toContain('cursor: pointer');
    expect(rule('.metrics th .sort')).toContain('margin: 0');
    expect(rule('.metrics th:has(> .sort)')).toContain('padding: 0');
    expect(rule('.metrics th .sort:hover')).toMatch(/background: /);
    expect(rule('.metrics th .sort:focus-visible')).toContain('outline-offset');
    // Rest glyph in ink-3, never the accent (sorting is a control, not a data action).
    expect(rule('.metrics th .si')).toContain('color: var(--ink-3)');
    expect(css).not.toMatch(/\.metrics th [^{]*\{[^}]*--act-/);
    const coarse = /@media \(pointer: coarse\) \{\s*\.metrics \{ --fin-w: 44px; \}\s*\.metrics th \.sort \{ min-height: 44px; min-width: 44px; \}/.exec(css);
    expect(coarse).not.toBeNull();
    // and after the base --fin-w, so it wins
    expect(css.indexOf(coarse![0])).toBeGreaterThan(css.indexOf('.metrics { --rank-w: 48px; --fin-w: 42px; }'));
  });
});
