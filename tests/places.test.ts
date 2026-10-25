import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { placeChanges, placeColumns, roundingMs } from '../src/analysis/places';
import type { BoatResult, LegDef, LegResult, RaceAnalysis } from '../src/analysis/types';
import {
  PLACE_TIP_MOUSE_REACH,
  PLACE_TIP_TOUCH_REACH,
  gainLabel,
  nearestPlaceDot,
  placeTip,
  placesChart,
  placesKey,
  shortName,
} from '../src/ui/places';
import { c31Race, fixtureRace, j88Race, m24Race } from './helpers';

const races = { j70: analyzeRace(fixtureRace()), c31: analyzeRace(c31Race()), m24: analyzeRace(m24Race()), j88: analyzeRace(j88Race()) };

/** Boat ids in order of their rounding time at the mark ending leg `li` (equal times: the legs table's place at the mark). */
const roundingOrder = (a: RaceAnalysis, li: number): string[] =>
  a.boats
    .filter((b) => roundingMs(b, li) != null)
    .sort((p, q) => roundingMs(p, li)! - roundingMs(q, li)! || (p.legs[li]?.rankAtEnd ?? 1e9) - (q.legs[li]?.rankAtEnd ?? 1e9))
    .map((b) => b.id);

describe('placeChanges on the fixtures', () => {
  for (const [name, a] of Object.entries(races)) {
    it(`${name}: Start = start place, each mark = rounding order, Finish = finish order`, () => {
      const pc = placeChanges(a);
      expect(pc.columns.length).toBe(a.legs.length + 1);
      expect(pc.columns[0].label).toBe('Start');
      expect(pc.columns.at(-1)!.label).toBe('Finish');
      const byId = new Map(pc.boats.map((b) => [b.id, b]));
      for (const b of a.boats) {
        expect(byId.get(b.id)!.places[0]).toBe(b.start?.startPlace ?? null);
        expect(byId.get(b.id)!.places.at(-1)).toBe(b.finishPos);
      }
      pc.columns.forEach((c, k) => {
        if (c.kind !== 'mark') return;
        const order = roundingOrder(a, c.legIndex!);
        expect(order.map((id) => byId.get(id)!.places[k])).toEqual(order.map((_, i) => i + 1));
        // Where the leg is complete, the place is the existing rank at the mark.
        for (const b of a.boats) if (b.legs[c.legIndex!]) expect(byId.get(b.id)!.places[k]).toBe(b.legs[c.legIndex!]!.rankAtEnd);
      });
    });
  }

  it('names the marks as the legs do, numbering repeats', () => {
    const labels = placeChanges(races.j70).columns.map((c) => c.label);
    expect(labels).toEqual(['Start', ...races.j70.legs.slice(0, -1).map((l, i, all) => {
      const n = all.slice(0, i + 1).filter((x) => x.to === l.to).length;
      return n > 1 ? `${l.to} (${n})` : l.to;
    }), 'Finish']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('J/88 (no mark trackers): the roundings come from where the fleet turned', () => {
    const a = races.j88;
    expect(a.legSource).toBe('fleet');
    const pc = placeChanges(a);
    expect(pc.columns.length).toBeGreaterThan(2);
    expect(pc.columns.slice(1, -1).every((c) => /mark/i.test(c.label))).toBe(true);
    expect(placesKey(a, pc).bullets).toContain('Marks: rounding order, placed from where the fleet turned.');
  });

  it('leaves Not racing boats out entirely (M24 coaches and the spare)', () => {
    const a = races.m24;
    expect(a.excluded.length).toBeGreaterThan(0);
    const ids = placeChanges(a).boats.map((b) => b.id);
    for (const e of a.excluded) expect(ids).not.toContain(e.result.id);
    const svg = placesChart(a, a.excluded[0].result.id);
    expect(svg).not.toContain(`data-id="${a.excluded[0].result.id}"`);
    // A selected boat that isn't drawn fades nobody.
    expect(svg).not.toContain('pc-boat dim');
  });

  it('gains: + = places gained since the last place shown', () => {
    for (const bp of placeChanges(races.j70).boats) {
      bp.places.forEach((p, k) => {
        if (bp.since[k] != null) expect(bp.gains[k]).toBe(bp.places[bp.since[k]!]! - p!);
      });
    }
  });
});

// Synthetic: four boats, Start → M1 → Gate → M1 → Finish.
const def = (index: number, to: string): LegDef => ({ index, kind: index % 2 ? 'downwind' : 'upwind', name: `L${index}`, to });
const leg = (startMs: number, endMs: number): LegResult => ({ startMs, endMs } as LegResult);
const boat = (id: string, startPlace: number | null, ends: (number | null)[], finishPos: number | null): BoatResult => {
  const t = [0, ...ends];
  return {
    id,
    sail: id,
    name: `#${id}`,
    colorSlot: id.charCodeAt(0) - 97,
    finishPos,
    start: startPlace == null ? null : ({ startPlace } as BoatResult['start']),
    legs: ends.map((_, i) => (t[i] != null && t[i + 1] != null ? leg(t[i]!, t[i + 1]!) : null)),
  } as BoatResult;
};
const legs = [def(0, 'M1'), def(1, 'Gate'), def(2, 'M1'), def(3, 'Finish')];
const synth = {
  legs,
  boats: [
    boat('a', 2, [100, 200, 300, 400], 1),
    boat('b', 1, [110, 190, 310, 410], 2),
    // A telemetry gap through the Gate: legs 1 and 2 are both broken, but M1 (2) still has a time.
    boat('c', 3, [120, null, 290, 420], 3),
    // DNF after the gate.
    boat('d', null, [130, 210, null, null], null),
  ],
};

describe('placeChanges (synthetic)', () => {
  const pc = placeChanges(synth);
  const of = (id: string) => pc.boats.find((b) => b.id === id)!;

  it('labels repeated marks', () => {
    expect(placeColumns(legs).map((c) => c.label)).toEqual(['Start', 'M1', 'Gate', 'M1 (2)', 'Finish']);
  });

  it('ranks each mark among the boats with a time there; a missing rounding is a gap, not a place', () => {
    expect(of('a').places).toEqual([2, 1, 2, 2, 1]);
    expect(of('b').places).toEqual([1, 2, 1, 3, 2]);
    expect(of('c').places).toEqual([3, 3, null, 1, 3]);
    expect(pc.missing).toEqual([0, 0, 1, 0, 0]);
    // c's gain at M1 (2) is measured from M1, the last place it had.
    expect(of('c').gains[3]).toBe(2);
    expect(of('c').since[3]).toBe(1);
  });

  it('keeps the missing rounding visible as a ⚠ chip with the dashed swatch; none when every time is there', () => {
    const a = { ...races.j70, legSource: 'course' } as RaceAnalysis;
    const k = placesKey(a, pc);
    expect(k.chips).toEqual([
      expect.objectContaining({ text: 'no time at Gate (1)', warn: true }),
      { text: 'no rounding time', swatch: 'gap' },
    ]);
    expect(k.bullets).toContain('Marks: rounding order, from the leg splits.');
    expect(k.bullets.length).toBeLessThanOrEqual(6);
    expect(placesKey(a, { ...pc, missing: pc.missing.map(() => 0) }).chips).toEqual([]);
  });

  it('names one or two missing marks; a longer list becomes a count so the chip stays short', () => {
    const a = { ...races.j70, legSource: 'course' } as RaceAnalysis;
    const two = { ...pc, missing: [0, 1, 2, 0, 0] };
    expect(placesKey(a, two).chips[0]).toEqual(
      expect.objectContaining({ text: 'no time at M1 (1), Gate (2)', warn: true, title: 'Boats with no rounding time at M1 (1), Gate (2); the others close up' }),
    );
    const many = { ...pc, missing: [0, 1, 2, 3, 0] };
    expect(placesKey(a, many).chips[0]).toEqual(
      expect.objectContaining({ text: 'no time at 3 marks', warn: true, title: 'Boats with no rounding time at M1 (1), Gate (2), M1 (2) (3); the others close up' }),
    );
    expect(placesKey(a, many).chips[0].text.split(/\s+/).length).toBeLessThanOrEqual(6);
  });

  it('a DNF ends at the last mark reached; no start place = no start point', () => {
    expect(of('d').places).toEqual([null, 4, 3, null, null]);
    expect(of('d')).toMatchObject({ dnf: true, lastCol: 2, net: 1 });
    expect(of('a')).toMatchObject({ dnf: false, lastCol: 4, net: 1 });
    expect(of('b').net).toBe(-1);
  });

  it('a one-leg race is Start → Finish only', () => {
    const one = placeChanges({ legs: [def(0, 'Finish')], boats: [boat('a', 2, [500], 1), boat('b', 1, [600], 2)] });
    expect(one.columns.map((c) => c.label)).toEqual(['Start', 'Finish']);
    expect(one.boats.map((b) => b.gains[1])).toEqual([1, -1]);
    const a = { ...races.j70, legs: [def(0, 'Finish')], legSource: 'none' } as RaceAnalysis;
    expect(placesKey(a).bullets).toContain('One leg: Start → Finish only.');
    expect(placesKey(a).bullets.join(' ')).not.toContain('Gray dashed');
  });

  it('tips: boat, mark, place and gain', () => {
    const b = synth.boats[2];
    expect(placeTip(pc, of('c'), b, 1)).toBe('#c · M1: 3rd (±0)');
    expect(placeTip(pc, of('c'), b, 3)).toBe('#c · M1 (2): 1st (+2 since M1)');
    expect(placeTip(pc, of('c'), b, 0)).toBe('#c · Start: 3rd');
    expect(placeTip(pc, of('d'), synth.boats[3], 2)).toBe('#d · Gate: 3rd (+1) · DNF');
    expect(gainLabel(-2)).toBe('−2');
  });
});

describe('placesChart SVG', () => {
  const a = races.j70;
  const paths = (svg: string): number => (svg.match(/<path class="pc-line"/g) ?? []).length;

  it('one line per racing boat, a dot per place, labels "place name" at the right', () => {
    const svg = placesChart(a, null);
    expect(paths(svg)).toBe(a.boats.length);
    const pc = placeChanges(a);
    const dots = pc.boats.reduce((s, b) => s + b.places.filter((p) => p != null).length, 0);
    expect((svg.match(/<circle class="pc-dot"/g) ?? []).length).toBe(dots);
    for (const b of a.boats) expect(svg).toContain(`>${b.finishPos} ${shortName(b, false)}</text>`);
    expect(svg).not.toMatch(/pc-boat (on|dim)/);
    expect(svg).toContain('<title>');
  });

  it('highlights the selected boat (drawn last) and fades the rest', () => {
    const id = a.boats[3].id;
    const svg = placesChart(a, id);
    expect((svg.match(/class="pc-boat on"/g) ?? []).length).toBe(1);
    expect((svg.match(/class="pc-boat dim"/g) ?? []).length).toBe(a.boats.length - 1);
    const groups = [...svg.matchAll(/<g class="pc-boat[^"]*" data-id="([^"]+)"/g)].map((m) => m[1]);
    expect(groups.at(-1)).toBe(id);
  });

  it('dashed grey across a missing rounding; a DNF labelled at its last point', () => {
    const syn = { ...a, legs, legSource: 'course', boats: synth.boats } as RaceAnalysis;
    const svg = placesChart(syn, null);
    expect(svg.match(/<path class="pc-gap"/g)).toHaveLength(1);
    expect(svg).toContain('class="pc-lbl dnf"');
    expect(svg).toContain('>DNF #d</text>');
  });

  it('a tap within finger reach of a dot hits it, even when it misses the circle', () => {
    const syn = { ...a, legs, boats: synth.boats } as RaceAnalysis;
    const svg = placesChart(syn, null, { widthPx: 390 });
    const dots = [...svg.matchAll(/<circle class="pc-dot" cx="([-\d.]+)" cy="([-\d.]+)"[^>]*data-tip="([^"]*)"/g)].map((m) => ({
      cx: Number(m[1]),
      cy: Number(m[2]),
      tip: m[3],
    }));
    expect(dots.length).toBeGreaterThan(3);
    const d = dots[1];
    // 20 px off the centre: on a phone that's still the same dot (circle r is 3.5); a mouse hover that tight does not count.
    expect(nearestPlaceDot(dots, d.cx + 20, d.cy + 4, PLACE_TIP_TOUCH_REACH)?.tip).toBe(d.tip);
    expect(nearestPlaceDot(dots, d.cx + 20, d.cy + 4, PLACE_TIP_MOUSE_REACH)).toBeNull();
    expect(nearestPlaceDot(dots, d.cx + 40, d.cy, PLACE_TIP_TOUCH_REACH)).toBeNull();
    expect(PLACE_TIP_TOUCH_REACH).toBeGreaterThan(PLACE_TIP_MOUSE_REACH);
  });

  it('narrow screens: sail numbers only, rotated mark names, labels inside the width', () => {
    const svg = placesChart(races.m24, null, { widthPx: 390 });
    expect(svg).toContain('class="chart places narrow"');
    expect(svg).toContain('viewBox="0 0 390 ');
    for (const b of races.m24.boats) if (b.finishPos != null) expect(svg).toContain(`>${b.finishPos} #${b.sail}</text>`);
    const xs = [...svg.matchAll(/class="pc-lbl" x="([\d.]+)"[^>]*font-size="(\d+)"[^>]*>(?:<title>[^<]*<\/title>)?([^<]+)<\/text>/g)].map(
      (m) => Number(m[1]) + m[3].length * 0.6 * Number(m[2]),
    );
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) expect(x).toBeLessThanOrEqual(390);
  });

  it('a 40-boat fleet stays readable: rows at least 14 px, colours cycled', () => {
    const base = a.boats[0];
    const boats = Array.from({ length: 40 }, (_, i) => ({ ...base, id: `x${i}`, sail: `${i + 1}`, name: `Boat ${i + 1}`, colorSlot: i, finishPos: i + 1, start: { ...base.start!, startPlace: 40 - i } }));
    const big = { ...a, boats } as RaceAnalysis;
    const svg = placesChart(big, null, { widthPx: 800 });
    const h = Number(/viewBox="0 0 800 (\d+)"/.exec(svg)![1]);
    expect(h).toBeGreaterThanOrEqual(40 * 14);
    expect(svg).toContain('stroke="var(--s1)"');
    expect(svg).toContain('stroke="var(--s8)"');
    expect(paths(svg)).toBe(40);
  });

  describe('full screen: fitted to the overlay height', () => {
    const base = a.boats[0];
    const fleet = (n: number): RaceAnalysis =>
      ({ ...a, boats: Array.from({ length: n }, (_, i) => ({ ...base, id: `x${i}`, sail: `${i + 1}`, name: `Boat ${i + 1}`, colorSlot: i, finishPos: i + 1, start: { ...base.start!, startPlace: n - i } })) }) as RaceAnalysis;
    const size = (svg: string): [number, number] => /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!.slice(1).map(Number) as [number, number];
    const labelFs = (svg: string): number[] => [...svg.matchAll(/class="pc-lbl" x="[\d.]+" y="[\d.]+" font-size="(\d+)"/g)].map((m) => Number(m[1]));

    it('fits a phone in landscape (844×~330) when the rows can be ≥ 12 px, names still ≥ 10 px', () => {
      const svg = placesChart(fleet(20), null, { widthPx: 828, heightPx: 330 });
      const [, h] = size(svg);
      expect(h).toBeLessThanOrEqual(330);
      expect(h).toBeGreaterThan(330 - 20);
      expect(Math.min(...labelFs(svg))).toBeGreaterThanOrEqual(10);
      // Right-hand names a row apart: no closer than their own size.
      const ys = [...svg.matchAll(/class="pc-lbl" x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1])).sort((p, q) => p - q);
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(Math.max(...labelFs(svg)) - 0.05);
    });

    it('grows a small fleet to fill a tall screen (rows up to 32 px)', () => {
      const h = size(placesChart(races.m24, null, { widthPx: 1400, heightPx: 900 }))[1];
      expect(h).toBeGreaterThan(size(placesChart(races.m24, null, { widthPx: 1400 }))[1]);
      expect(h).toBeLessThanOrEqual(900);
    });

    it('a big fleet that would need rows under 12 px keeps its usual rows (the overlay scrolls)', () => {
      const big = fleet(49);
      const fitted = placesChart(big, null, { widthPx: 828, heightPx: 330 });
      expect(fitted).toBe(placesChart(big, null, { widthPx: 828 }));
      expect(size(fitted)[1]).toBeGreaterThan(330);
      expect(size(fitted)[1]).toBeGreaterThanOrEqual(49 * 14);
    });
  });
});

describe('places card', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  it('sits after the track map, self-contained', () => {
    expect(html).toContain('<section id="places-card" class="card has-fs">');
    expect(html).toContain('<div id="places-chart"');
    expect(html.indexOf('id="map-chart"')).toBeLessThan(html.indexOf('id="places-card"'));
    expect(html.indexOf('id="places-card"')).toBeLessThan(html.indexOf('id="race-findings-card"'));
    expect(html).toMatch(/<h3 id="places-title">Rounding &amp; Finish Positions<\/h3>/);
  });
});
