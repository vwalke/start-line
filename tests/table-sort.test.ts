import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { BoatResult } from '../src/analysis/types';
import {
  compareValues,
  legsTable,
  legsTableKey,
  nextSort,
  rankCell,
  sortBoats,
  sortRanks,
  startTable,
  startTableKey,
  toggleSort,
  type SortVal,
} from '../src/ui/table';
import { c31Race, fixtureRace, m24Race } from './helpers';

const a = analyzeRace(fixtureRace());

describe('sort comparator', () => {
  const sorted = (vs: SortVal[], dir: 'asc' | 'desc'): SortVal[] => [...vs].sort((x, y) => compareValues(x, y, dir));

  it('orders numbers ascending and descending', () => {
    expect(sorted([3, 1, 2], 'asc')).toEqual([1, 2, 3]);
    expect(sorted([3, 1, 2], 'desc')).toEqual([3, 2, 1]);
    expect(sorted([-1.5, 0, -3], 'asc')).toEqual([-3, -1.5, 0]);
  });

  it('puts missing values last in both directions', () => {
    const vs: SortVal[] = [2, null, 5, undefined, NaN, 1];
    expect(sorted(vs, 'asc').slice(0, 3)).toEqual([1, 2, 5]);
    expect(sorted(vs, 'desc').slice(0, 3)).toEqual([5, 2, 1]);
    for (const dir of ['asc', 'desc'] as const) {
      expect(sorted(vs, dir).slice(3).every((v) => v == null || Number.isNaN(v))).toBe(true);
    }
    expect(compareValues(null, undefined, 'asc')).toBe(0);
  });

  it('orders sail numbers numerically', () => {
    expect(sorted(['10', '9', 'ITA 78', 'GER42', '2'], 'asc')).toEqual(['2', '9', '10', 'GER42', 'ITA 78']);
  });

  it('starts with the natural direction, then reverses; a new column starts over', () => {
    const s1 = nextSort(null, 'L0.sog', 'desc');
    expect(s1).toEqual({ key: 'L0.sog', dir: 'desc' });
    const s2 = nextSort(s1, 'L0.sog', 'desc');
    expect(s2).toEqual({ key: 'L0.sog', dir: 'asc' });
    expect(nextSort(s2, 'L0.sog', 'desc')).toEqual({ key: 'L0.sog', dir: 'desc' });
    expect(nextSort(s2, 'race', 'asc')).toEqual({ key: 'race', dir: 'asc' });
  });

  it('knows each column’s better end: highest speed, lowest time, finish order, deepest run TWA', () => {
    const first = (key: string) => toggleSort(a, null, key)?.dir;
    expect(first('L0.sog')).toBe('desc');
    expect(first('L0.vmg')).toBe('desc');
    expect(first('sog')).toBe('desc');
    expect(first('race')).toBe('asc');
    expect(first('L0.time')).toBe('asc');
    expect(first('fin')).toBe('asc');
    expect(first('boat')).toBe('asc');
    expect(first('dist')).toBe('asc');
    expect(first('L0.twa')).toBe('asc'); // Beat 1: closest to the wind first
    expect(first('L1.twa')).toBe('desc'); // Run 1: deepest first
    expect(toggleSort(a, null, 'nope')).toBeNull();
  });

  it('breaks ties by finish position, DNF last', () => {
    const mk = (id: string, finishPos: number | null, colorSlot: number) => ({ id, finishPos, colorSlot }) as BoatResult;
    const boats = [mk('c', null, 0), mk('b', 2, 1), mk('a', 1, 2), mk('d', 3, 3)];
    const v = (b: BoatResult): SortVal => (b.id === 'd' ? 9 : 5);
    expect(sortBoats(boats, v, 'asc').map((b) => b.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortBoats(boats, v, 'desc').map((b) => b.id)).toEqual(['d', 'a', 'b', 'c']);
    // Fin itself: DNF last either way.
    expect(sortBoats(boats, (b) => b.finishPos, 'desc').map((b) => b.id)).toEqual(['d', 'b', 'a', 'c']);
  });
});

const rowIds = (html: string): string[] => [...html.matchAll(/<tr data-id="([^"]+)"/g)].map((m) => m[1]);
const th = (html: string, key: string): string => new RegExp(`<th[^>]*>(?:(?!<th).)*data-sort="${key.replace('.', '\\.')}"`).exec(html)![0];

describe('sorted metrics table (Benelux race 8)', () => {
  it('sorts by a leg SOG column, fastest first, with aria-sort and ↓ on that header only', () => {
    const sort = toggleSort(a, null, 'L0.sog')!;
    const html = legsTable(a, null, sort);
    const want = [...a.boats].sort((x, y) => y.legs[0]!.sogKn - x.legs[0]!.sogKn).map((b) => b.id);
    expect(want).not.toEqual(a.boats.map((b) => b.id)); // a real reorder, not finish order
    expect(rowIds(html)).toEqual(want);
    expect(th(html, 'L0.sog')).toContain('aria-sort="descending"');
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
    expect(html).toMatch(/data-sort="L0\.sog">SOG<br><small>kn<\/small><span class="si" aria-hidden="true">↓<\/span><\/button>/);

    const again = legsTable(a, null, toggleSort(a, sort, 'L0.sog'));
    expect(rowIds(again)).toEqual([...want].reverse());
    expect(th(again, 'L0.sog')).toContain('aria-sort="ascending"');
    expect(again).toContain('<span class="si" aria-hidden="true">↑</span>');
  });

  it('defaults to finish order with no sort indicator', () => {
    const html = legsTable(a, null);
    expect(rowIds(html)).toEqual(a.boats.map((b) => b.id));
    expect(html).not.toContain('aria-sort');
  });

  it('sorts Boat by sail and Fin by place', () => {
    expect(rowIds(legsTable(a, null, { key: 'boat', dir: 'asc' }))).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(rowIds(legsTable(a, null, { key: 'fin', dir: 'desc' }))).toEqual(a.boats.map((b) => b.id).reverse());
  });

  it('keeps sorted rows selectable and the best/worst marks on the same boats', () => {
    const plain = legsTable(a, '3');
    const sorted = legsTable(a, '3', { key: 'L0.sog', dir: 'desc' });
    expect(sorted).toContain('<tr data-id="3" class="sel" tabindex="0">');
    const marks = (html: string) => [...html.matchAll(/<tr data-id="([^"]+)"[^>]*>(.*?)<\/tr>/g)].map((m) => `${m[1]}:${(m[2].match(/aria-label="(best|worst)"/g) ?? []).join()}`).sort();
    expect(marks(sorted)).toEqual(marks(plain));
    // Sort glyphs (↑/↓) never reuse the best/worst marks (▲/▼).
    const head = /<thead>(.*)<\/thead>/.exec(sorted)![1];
    expect(head).not.toMatch(/[▲▼]/);
  });

  it('groups each leg under a spanning header: VMG, SOG, TWA, Heel, Dist, Time, Tacks or Gybes, Data', () => {
    const html = legsTable(a, null);
    const [top, sub] = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => m[1]);
    expect(top).toContain('<th class="num sticky0" scope="col" rowspan="2"');
    expect(top).toContain('<th class="boat sticky1" scope="col" rowspan="2"');
    for (const l of a.legs) expect(top).toContain(`colspan="8" title="${l.name} to ${l.to}">${l.name}</th>`);
    expect(top).toContain('colspan="8" title="Every beat added up (reaches excluded)">Upwind</th>');
    expect(top).toContain('colspan="8" title="Every run added up (reaches excluded)">Downwind</th>');
    expect(top).toContain('colspan="6" title="Gun to finish">Race</th>');
    const keys = [...sub.matchAll(/data-sort="([^"]+)"/g)].map((m) => m[1]);
    // Beat 1 shows tacks, Run 1 gybes.
    expect(keys.slice(0, 8)).toEqual(['L0.vmg', 'L0.sog', 'L0.twa', 'L0.heel', 'L0.dist', 'L0.time', 'L0.tacks', 'L0.dq']);
    expect(keys.slice(8, 16)).toEqual(['L1.vmg', 'L1.sog', 'L1.twa', 'L1.heel', 'L1.dist', 'L1.time', 'L1.gybes', 'L1.dq']);
    expect(keys.filter((k) => k.startsWith('up.'))).toEqual(['up.vmg', 'up.sog', 'up.twa', 'up.heel', 'up.dist', 'up.time', 'up.tacks', 'up.dq']);
    expect(keys.filter((k) => k.startsWith('dn.'))).toEqual(['dn.vmg', 'dn.sog', 'dn.twa', 'dn.heel', 'dn.dist', 'dn.time', 'dn.gybes', 'dn.dq']);
    expect(keys.slice(-6)).toEqual(['dist', 'race', 'sog', 'tacks', 'gybes', 'dq']);
    // Every column header is a button.
    const nCols = (/<tr data-id[^>]*>(.*?)<\/tr>/.exec(html)![1].match(/<td/g) ?? []).length;
    expect(html.match(/<button type="button" class="sort"/g)).toHaveLength(nCols);
    // Leg time keeps the place at the mark.
    const b = a.boats[0];
    expect(html).toMatch(new RegExp(`<tr data-id="${b.id}".*?<td class="num">\\d+:\\d\\d <small class="rk">\\d+(st|nd|rd|th)</small></td>`));
  });
});

describe('sort ranks', () => {
  type VB = BoatResult & { v: SortVal };
  const mk = (id: string, v: SortVal): BoatResult => ({ id, v, finishPos: null, colorSlot: 0 }) as unknown as VB;
  const val = (b: BoatResult): SortVal => (b as VB).v;
  const ranks = (boats: BoatResult[], dir: 'asc' | 'desc'): Record<string, string> =>
    Object.fromEntries([...sortRanks(boats, val, dir)].map(([id, r]) => [id, rankCell(r).replace(/<[^>]+>/g, '')]));

  it('ranks 1 at the top of either direction', () => {
    const boats = [mk('a', 3), mk('b', 1), mk('c', 2)];
    expect(ranks(boats, 'asc')).toEqual({ b: '1', c: '2', a: '3' });
    expect(ranks(boats, 'desc')).toEqual({ a: '1', c: '2', b: '3' });
  });

  it('shares a rank on ties, then skips (1, =2, =2, 4)', () => {
    const boats = [mk('a', 5), mk('b', 7), mk('c', 7), mk('d', 9)];
    expect(ranks(boats, 'asc')).toEqual({ a: '1', b: '=2', c: '=2', d: '4' });
    expect(ranks(boats, 'desc')).toEqual({ d: '1', b: '=2', c: '=2', a: '4' });
    expect(sortRanks(boats, val, 'asc').get('b')).toEqual({ n: 2, tied: true });
    expect(rankCell({ n: 2, tied: true })).toBe('<span title="Tied 2nd">=2</span>');
  });

  it('leaves missing values unranked ("—"), without using up a place', () => {
    const boats = [mk('a', null), mk('b', 4), mk('c', NaN), mk('d', undefined), mk('e', 2)];
    for (const dir of ['asc', 'desc'] as const) {
      const r = ranks(boats, dir);
      expect([r.a, r.c, r.d]).toEqual(['—', '—', '—']);
      expect([r.b, r.e].sort()).toEqual(['1', '2']);
    }
  });

  it('ranks sail numbers as they sort (numerically)', () => {
    const boats = [mk('x', '10'), mk('y', '9'), mk('z', 'GER42'), mk('w', '2')];
    expect(ranks(boats, 'asc')).toEqual({ w: '1', y: '2', x: '3', z: '4' });
    expect(ranks(boats, 'desc')).toEqual({ z: '1', x: '2', y: '3', w: '4' });
  });
});

/** The Rank cell (first) of each row, in row order, tags stripped. */
const rankCol = (html: string): string[] =>
  [...html.matchAll(/<tr data-id="[^"]+"[^>]*><td class="num rank">(.*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));

describe('Rank column', () => {
  it('is hidden in finish order (Fin already says it)', () => {
    for (const html of [legsTable(a, null), startTable(a, null)]) {
      expect(html).not.toContain('class="num rank"');
      expect(html).not.toContain(' ranked"');
    }
  });

  it('appears once sorted, leftmost, naming the sorted column; 1 at the top either way', () => {
    const html = legsTable(a, null, { key: 'L0.sog', dir: 'desc' });
    expect(html).toContain('<table class="metrics legs ranked"');
    const top = /<thead><tr>(.*?)<\/tr>/.exec(html)![1];
    expect(top).toMatch(
      new RegExp(`^<th class="num rank" scope="col" rowspan="2" title="Rank in the current sort, by ${a.legs[0].name} SOG kn ↓" aria-label="[^"]+">Rank<small>SOG</small></th>`),
    );
    expect(rankCol(html)).toEqual(a.boats.map((_, i) => String(i + 1)));
    const rev = legsTable(a, null, { key: 'L0.sog', dir: 'asc' });
    expect(rankCol(rev)).toEqual(rankCol(html));
    expect(rev).toContain('SOG kn ↑"');
    // Every row has one more cell than there are sort buttons.
    const nTd = (/<tr data-id[^>]*>(.*?)<\/tr>/.exec(html)![1].match(/<td/g) ?? []).length;
    expect(html.match(/class="sort"/g)).toHaveLength(nTd - 1);
  });

  it('shows ties as "=n" (Beat 1 tacks: five on 2, one on 4)', () => {
    const html = legsTable(a, null, { key: 'L0.tacks', dir: 'asc' });
    expect(rankCol(html)).toEqual(['=1', '=1', '=1', '=1', '=1', '6']);
    expect(rowIds(html).at(-1)).toBe('5');
  });

  it('shows "—" for a missing value; the start table has one header row', () => {
    const c31 = analyzeRace(c31Race());
    const html = startTable(c31, null, { key: 'start', dir: 'asc' });
    expect(html).toContain('<th class="num rank" scope="col" title="Rank in the current sort, by Start place ↑"');
    expect(rowIds(html)).toEqual(['ITA 78', 'AUT 3165', 'FRA 901', 'GER42']);
    expect(rankCol(html)).toEqual(['1', '2', '3', '—']);
  });

  it('keeps a picked not-racing boat unranked and the racing ranks unchanged; selection still marks the row', () => {
    const m24 = analyzeRace(m24Race());
    const nc = m24.excluded[0].result.id;
    const sort = { key: 'race', dir: 'asc' } as const;
    const plain = legsTable(m24, null, sort);
    const picked = legsTable(m24, nc, sort);
    expect(rankCol(plain)).toEqual(m24.boats.map((_, i) => String(i + 1)));
    expect(rankCol(picked)).toEqual([...rankCol(plain), '—']);
    expect(picked).toMatch(new RegExp(`<tr data-id="${nc}" class="sel nc"[^>]*><td class="num rank">—</td>`));
    expect(legsTable(m24, '874', sort)).toContain('<tr data-id="874" class="sel" tabindex="0"><td class="num rank">2</td>');
  });

  it('ranks by an upwind summary like any column (partial sums included)', () => {
    const html = legsTable(a, null, { key: 'up.vmg', dir: 'desc' });
    const n = a.boats.filter((b) => b.upwind?.vmgKn != null).length;
    expect(rankCol(html).filter((r) => r !== '—')).toHaveLength(n);
  });

  it('is explained in one short ⓘ bullet per table', () => {
    for (const k of [legsTableKey(a), startTableKey(a)]) expect(k.bullets).toContain('Rank: place in the current sort; =3 tied; — no value.');
  });
});

describe('column-group dividers (Legs table)', () => {
  const m24 = analyzeRace(m24Race());
  const nc = m24.excluded[0].result.id;
  const grpOf = (k: string): string | null => /^(L\d+|up|dn)\./.exec(k)?.[1] ?? (['fin', 'boat', 'lstart'].includes(k) ? null : 'race');
  const cases: [string, string, number][] = [
    ['finish order', legsTable(m24, nc), 0],
    ['sorted (with Rank)', legsTable(m24, nc, { key: 'up.vmg', dir: 'desc' }), 1],
  ];
  for (const [name, html, off] of cases) {
    it(`${name}: every group's first column has the divider, in both header rows and every body row`, () => {
      const keys = [...html.matchAll(/data-sort="([^"]+)"/g)].map((m) => m[1]);
      const first = keys.map((k, i) => grpOf(k) != null && grpOf(keys[i - 1] ?? '') !== grpOf(k));
      const groups = keys.filter((_, i) => first[i]).map(grpOf);
      expect(groups).toEqual([...m24.legs.map((l) => `L${l.index}`), 'up', 'dn', 'race']);
      // Group headers (top row) and sub-headers.
      expect(html.match(/<th class="grp" /g)).toHaveLength(groups.length);
      keys.forEach((k, i) => {
        const cls = new RegExp(`<th class="([^"]*)"[^>]*><button type="button" class="sort" data-sort="${k.replace('.', '\\.')}"`).exec(html)![1];
        expect(cls.split(' ').includes('g0'), k).toBe(first[i]);
      });
      // Every body row, the not-racing row at the foot included.
      const rows = [...html.matchAll(/<tr data-id="[^"]+"[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td class="([^"]*)"/g)].map((c) => c[1]));
      expect(rows).toHaveLength(m24.boats.length + 1);
      for (const tds of rows) {
        expect(tds).toHaveLength(keys.length + off);
        keys.forEach((k, i) => expect(tds[i + off].split(' ').includes('g0'), k).toBe(first[i]));
      }
    });
  }

  it('keeps the Upwind and Downwind groups with all their columns', () => {
    const html = legsTable(m24, null);
    expect(html).toMatch(/title="Every beat added up \(reaches excluded\)">Upwind<\/th>/);
    expect(html).toMatch(/title="Every run added up \(reaches excluded\)">Downwind<\/th>/);
    const keys = [...html.matchAll(/data-sort="([^"]+)"/g)].map((m) => m[1]);
    const heel = m24.hasHeel ? ['heel'] : [];
    expect(keys.filter((k) => k.startsWith('up.'))).toEqual(['vmg', 'sog', 'twa', ...heel, 'dist', 'time', 'tacks', 'dq'].map((s) => `up.${s}`));
    expect(keys.filter((k) => k.startsWith('dn.'))).toEqual(['vmg', 'sog', 'twa', ...heel, 'dist', 'time', 'gybes', 'dq'].map((s) => `dn.${s}`));
  });
});
