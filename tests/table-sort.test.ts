import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { BoatResult } from '../src/analysis/types';
import { compareValues, legsTable, nextSort, sortBoats, toggleSort, type SortVal } from '../src/ui/table';
import { fixtureRace } from './helpers';

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

  it('groups each leg under a spanning header: VMG, SOG, TWA, Dist, Time, Tacks or Gybes, Data', () => {
    const html = legsTable(a, null);
    const [top, sub] = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => m[1]);
    expect(top).toContain('<th class="num sticky0" scope="col" rowspan="2"');
    expect(top).toContain('<th class="boat sticky1" scope="col" rowspan="2"');
    for (const l of a.legs) expect(top).toContain(`colspan="7" title="${l.name} to ${l.to}">${l.name}</th>`);
    expect(top).toContain('colspan="7" title="Every beat added up (reaches excluded)">Upwind</th>');
    expect(top).toContain('colspan="7" title="Every run added up (reaches excluded)">Downwind</th>');
    expect(top).toContain('colspan="6" title="Gun to finish">Race</th>');
    const keys = [...sub.matchAll(/data-sort="([^"]+)"/g)].map((m) => m[1]);
    // Beat 1 shows tacks, Run 1 gybes.
    expect(keys.slice(0, 7)).toEqual(['L0.vmg', 'L0.sog', 'L0.twa', 'L0.dist', 'L0.time', 'L0.tacks', 'L0.dq']);
    expect(keys.slice(7, 14)).toEqual(['L1.vmg', 'L1.sog', 'L1.twa', 'L1.dist', 'L1.time', 'L1.gybes', 'L1.dq']);
    expect(keys.filter((k) => k.startsWith('up.'))).toEqual(['up.vmg', 'up.sog', 'up.twa', 'up.dist', 'up.time', 'up.tacks', 'up.dq']);
    expect(keys.filter((k) => k.startsWith('dn.'))).toEqual(['dn.vmg', 'dn.sog', 'dn.twa', 'dn.dist', 'dn.time', 'dn.gybes', 'dn.dq']);
    expect(keys.slice(-6)).toEqual(['dist', 'race', 'sog', 'tacks', 'gybes', 'dq']);
    // Every column header is a button.
    const nCols = (/<tr data-id[^>]*>(.*?)<\/tr>/.exec(html)![1].match(/<td/g) ?? []).length;
    expect(html.match(/<button type="button" class="sort"/g)).toHaveLength(nCols);
    // Leg time keeps the place at the mark.
    const b = a.boats[0];
    expect(html).toMatch(new RegExp(`<tr data-id="${b.id}".*?<td class="num">\\d+:\\d\\d <small class="rk">\\d+(st|nd|rd|th)</small></td>`));
  });
});
