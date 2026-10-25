import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { legRanks, overallRanks, raceLegRanks, type SpeedRank } from '../src/analysis/speedRank';
import type { BoatResult, LegResult } from '../src/analysis/types';
import { legColor, trackMap } from '../src/ui/charts';
import {
  casedByDay,
  colourControls,
  contrast,
  luminance,
  parseRankBy,
  parseSpeedTop,
  parseTrackColour,
  plasma,
  readPref,
  SELECTION_DIM,
  SPEED_BG,
  SPEED_RANGE,
  speedColor,
  speedEmphasis,
  speedKey,
  speedStyle,
  tieAtCut,
  TOP_KEY,
  topLimit,
  writePref,
  type Emphasis,
  type SpeedStyle,
} from '../src/ui/speed';
import { fixtureRace, m24Race } from './helpers';

const leg = (timeS: number, distGapS: number | null = null): LegResult => ({
  startMs: 0,
  endMs: timeS * 1000,
  timeS,
  sogKn: 6,
  vmgKn: 5,
  twaDeg: 40,
  rankAtEnd: null,
  timeGapS: null,
  distM: 1852,
  tacks: 0,
  gybes: 0,
  manoeuvreGap: false,
  coverage: 1,
  maxGapS: 1,
  heelDeg: null,
  heelS: 0,
  trimDeg: null,
  heelCoverage: null,
  progress: null,
  distGapS,
});

const boat = (id: string, legs: (LegResult | null)[], raceTimeS: number | null = null, finishPos: number | null = null): BoatResult => ({
  id,
  sail: id,
  name: `#${id}`,
  colorSlot: 0,
  finishPos,
  finishMs: null,
  raceTimeS,
  sogAvgKn: null,
  distM: null,
  distApprox: false,
  coverage: null,
  maxGapS: null,
  start: null,
  legs,
  upwind: null,
  downwind: null,
  headingSource: 'device',
  headingOffDeg: null,
});

describe('leg ranking', () => {
  const boats = [
    boat('a', [leg(400), leg(300)]),
    boat('b', [leg(380), null]),
    boat('c', [leg(420, 12), leg(310)]),
    boat('d', [leg(400), leg(NaN)]),
    boat('e', [null, leg(290)]),
  ];

  it('orders by leg time, fastest first, ties share a rank (1, 2, 2, 4)', () => {
    const r = legRanks(boats, 0);
    expect([...r.keys()]).toEqual(['b', 'a', 'd', 'c']);
    expect(['b', 'a', 'd', 'c'].map((id) => r.get(id)!.rank)).toEqual([1, 2, 2, 4]);
    expect(r.get('a')!.of).toBe(4);
    expect(r.get('a')!.timeS).toBe(400);
  });

  it('normalizes t by rank: 0 fastest, 1 slowest', () => {
    const r = legRanks(boats, 0);
    expect(r.get('b')!.t).toBe(0);
    expect(r.get('a')!.t).toBeCloseTo(1 / 3);
    expect(r.get('d')!.t).toBeCloseTo(1 / 3);
    expect(r.get('c')!.t).toBe(1);
  });

  it('leaves out boats that did not complete the leg (null or non-finite time)', () => {
    const r = legRanks(boats, 1);
    expect([...r.keys()]).toEqual(['e', 'a', 'c']);
    expect(r.has('b')).toBe(false);
    expect(r.has('d')).toBe(false);
    expect(legRanks(boats, 0).has('e')).toBe(false);
    expect(legRanks(boats, 7).size).toBe(0);
  });

  it('flags a leg time that spans a telemetry gap (> 5 s, as the table ~)', () => {
    const r = legRanks(boats, 0);
    expect(r.get('c')!.gapS).toBe(12);
    expect(r.get('a')!.gapS).toBeNull();
  });

  it('gives a lone boat t = 0', () => {
    const r = legRanks([boat('x', [leg(100)])], 0);
    expect(r.get('x')).toMatchObject({ rank: 1, of: 1, t: 0 });
  });

  it('ranks each leg separately for the whole race', () => {
    const per = raceLegRanks(boats, 2);
    expect(per).toHaveLength(2);
    expect(per[0].get('b')!.rank).toBe(1);
    expect(per[1].get('e')!.rank).toBe(1);
    expect(per[1].get('a')!.rank).toBe(2);
  });
});

describe('overall ranking', () => {
  it('ranks finishers by race time and leaves non-finishers out', () => {
    const r = overallRanks([
      boat('a', [leg(400, 8), leg(300)], 700, 2),
      boat('b', [leg(380), leg(310)], 690, 1),
      boat('c', [leg(420), null], null, null),
    ]);
    expect([...r.keys()]).toEqual(['b', 'a']);
    expect(r.get('b')).toMatchObject({ rank: 1, of: 2, t: 0, timeS: 690 });
    expect(r.get('a')).toMatchObject({ rank: 2, t: 1, gapS: 8 });
    expect(r.has('c')).toBe(false);
  });

  it('falls back to finish position when a finisher has no race time', () => {
    const r = overallRanks([boat('a', [], 700, 2), boat('b', [], null, 1), boat('c', [], null, null)]);
    expect([...r.keys()]).toEqual(['b', 'a']);
    expect(Number.isNaN(r.get('b')!.timeS)).toBe(true);
    expect(r.has('c')).toBe(false);
  });
});

describe('speed colour scale', () => {
  it('hits the plasma ends and clamps out-of-range input', () => {
    expect(plasma(0)).toBe('#0d0887');
    expect(plasma(1)).toBe('#f0f921');
    expect(plasma(0.5)).toBe('#cc4778');
    expect(plasma(-3)).toBe('#0d0887');
    expect(plasma(9)).toBe('#f0f921');
    expect(plasma(NaN)).toBe('#0d0887');
  });

  it('outputs #rrggbb', () => {
    for (let t = 0; t <= 1; t += 0.05) {
      expect(plasma(t)).toMatch(/^#[0-9a-f]{6}$/);
      expect(speedColor(t)).toMatch(/^#[0-9a-f]{6}$/);
      expect(speedColor(t, 'dark')).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('puts the fastest at the bright end of each scheme slice', () => {
    expect(speedColor(0, 'light')).toBe(plasma(SPEED_RANGE.light[1]));
    expect(speedColor(1, 'light')).toBe('#0d0887');
    expect(speedColor(0, 'dark')).toBe('#f0f921');
    expect(speedColor(1, 'dark')).toBe(plasma(SPEED_RANGE.dark[0]));
    expect(speedColor(-1)).toBe(speedColor(0));
    expect(speedColor(2)).toBe(speedColor(1));
    expect(speedColor(NaN)).toBe(speedColor(1));
  });

  it('gets monotonically darker (relative luminance) from fastest to slowest in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      let prev = Infinity;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const l = luminance(speedColor(t, scheme));
        expect(l).toBeLessThanOrEqual(prev + 1e-9);
        prev = l;
      }
    }
    // and the plasma table itself rises monotonically
    let prev = -1;
    for (let v = 0; v <= 1.0001; v += 0.01) {
      expect(luminance(plasma(v))).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = luminance(plasma(v));
    }
  });

  it('keeps both ends visible: night slowest ≥ 2.5:1 on #171d26, day slowest dark, pale day strokes cased', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21);
    expect(contrast(speedColor(1, 'dark'), SPEED_BG.dark)).toBeGreaterThanOrEqual(2.5);
    expect(contrast(speedColor(0, 'dark'), SPEED_BG.dark)).toBeGreaterThan(12);
    expect(contrast(speedColor(1, 'light'), SPEED_BG.light)).toBeGreaterThan(12);
    // the day fastest is a deeper yellow-orange than plasma's own end, but still pale, so cased
    expect(contrast(speedColor(0, 'light'), SPEED_BG.light)).toBeGreaterThan(contrast(plasma(1), SPEED_BG.light));
    expect(casedByDay(0)).toBe(true);
    expect(casedByDay(1)).toBe(false);
    for (let t = 0; t <= 1; t += 0.05) expect(casedByDay(t)).toBe(contrast(speedColor(t), '#ffffff') < 3);
  });
});

describe('speed emphasis', () => {
  const run = (n: number): Emphasis[] => Array.from({ length: n }, (_, i) => speedEmphasis(i + 1, n));

  it('gives the top 3 full opacity and the thickest stroke', () => {
    const e = run(52);
    const maxW = Math.max(...e.map((x) => x.width));
    for (const x of e.slice(0, 3)) expect(x).toEqual({ tier: 'top', opacity: 1, width: maxW });
    expect(e[3].width).toBeLessThan(maxW);
  });

  it('keeps the rest of the top quartile strong', () => {
    const e = run(52);
    for (const x of e.slice(3, 13)) {
      expect(x.tier).toBe('strong');
      expect(x.opacity).toBeGreaterThanOrEqual(0.85);
      expect(x.opacity).toBeLessThanOrEqual(0.9);
    }
    expect(e[13].tier).toBe('rest');
  });

  it('fades the slower half to 0.15–0.3 and thin', () => {
    const e = run(52);
    for (const x of e.slice(26)) {
      expect(x.opacity).toBeGreaterThanOrEqual(0.15 - 1e-9);
      expect(x.opacity).toBeLessThanOrEqual(0.3 + 1e-9);
      expect(x.width).toBeGreaterThanOrEqual(0.9 - 1e-9);
      expect(x.width).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(e[51].opacity).toBeCloseTo(0.15);
    // steep: past the quartile it drops fast
    expect(e[13].opacity).toBeLessThan(0.8);
    expect(e[19].opacity).toBeLessThan(0.5);
  });

  it('never increases with rank, for any fleet size', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 12, 16, 20, 33, 52, 120]) {
      const e = run(n);
      for (let i = 1; i < n; i++) {
        expect(e[i].opacity).toBeLessThanOrEqual(e[i - 1].opacity + 1e-9);
        expect(e[i].width).toBeLessThanOrEqual(e[i - 1].width + 1e-9);
      }
    }
  });

  it('treats small fleets sensibly: everyone visible, top 3 still emphasised', () => {
    expect(run(1).map((x) => x.tier)).toEqual(['top']);
    expect(run(3).every((x) => x.tier === 'top' && x.opacity === 1)).toBe(true);
    for (const n of [4, 6, 8]) {
      const e = run(n);
      expect(e.slice(0, 3).every((x) => x.tier === 'top')).toBe(true);
      expect(Math.min(...e.map((x) => x.opacity))).toBeGreaterThanOrEqual(0.3);
    }
    // out-of-range input clamps rather than exploding
    expect(speedEmphasis(0, 10)).toEqual(speedEmphasis(1, 10));
    expect(speedEmphasis(99, 10)).toEqual(speedEmphasis(10, 10));
    expect(speedEmphasis(NaN, 10)).toEqual(speedEmphasis(10, 10));
  });
});

describe('Highlight: Top N and selection', () => {
  const rank = (r: number, of: number): SpeedRank => ({ rank: r, of, timeS: 100 + r, gapS: null, t: of > 1 ? (r - 1) / (of - 1) : 0 });

  it('parses the stored value, defaulting to All', () => {
    expect(parseSpeedTop('3')).toBe(3);
    expect(parseSpeedTop('10')).toBe(10);
    for (const bad of [null, undefined, '', 'all', '5', 'top3', ' 3']) expect(parseSpeedTop(bad)).toBe('all');
    expect(TOP_KEY).toBe('recall.speedTop');
  });

  it('greys boats outside N and stretches the scale over ranks 1..N', () => {
    const s = (r: number): SpeedStyle => speedStyle(rank(r, 52), 10, 'none');
    expect(s(1).t).toBe(0);
    expect(s(10).t).toBe(1);
    expect(s(5).t).toBeCloseTo(4 / 9);
    expect(s(10).tier).toBe('strong');
    expect(s(11)).toMatchObject({ kind: 'out', t: null, tier: null });
    expect(s(11).opacity).toBeCloseTo(0.2);
    expect(s(11).width).toBeLessThan(1);
    expect(speedStyle(rank(3, 52), 3, 'none')).toMatchObject({ t: 1, tier: 'top', opacity: 1 });
  });

  it('behaves like All when N covers the fleet', () => {
    for (let r = 1; r <= 8; r++) expect(speedStyle(rank(r, 8), 10, 'none')).toEqual(speedStyle(rank(r, 8), 'all', 'none'));
    expect(topLimit(10, 10)).toBeNull();
    expect(topLimit(3, 10)).toBe(3);
    expect(topLimit('all', 3)).toBeNull();
    expect(speedStyle(rank(8, 8), 'all', 'none').t).toBe(1);
  });

  it('draws a selected slow boat at full opacity and thick, in its colour, and dims the rest', () => {
    const me = speedStyle(rank(50, 52), 'all', 'this');
    expect(me).toMatchObject({ kind: 'ranked', opacity: 1, selected: true });
    expect(me.t).toBeCloseTo(49 / 51);
    expect(me.width).toBeGreaterThanOrEqual(speedEmphasis(1, 52).width);
    // past N: full opacity and thick, but no rank colour (it would pass for #N)
    const outside = speedStyle(rank(30, 52), 3, 'this');
    expect(outside).toMatchObject({ kind: 'picked-out', opacity: 1, t: null, tier: null, selected: true });
    expect(outside.width).toBe(me.width);
    const other = speedStyle(rank(1, 52), 'all', 'other');
    expect(other.opacity).toBeCloseTo(1 * SELECTION_DIM);
    expect(other.width).toBe(speedEmphasis(1, 52).width);
    expect(speedStyle(undefined, 'all', 'none')).toMatchObject({ kind: 'unranked', t: null });
    expect(speedStyle(undefined, 'all', 'none').opacity).toBeCloseTo(0.25);
    expect(speedStyle(undefined, 'all', 'other').opacity).toBeCloseTo(0.25 * SELECTION_DIM);
    expect(speedStyle(undefined, 'all', 'this').opacity).toBe(1);
  });

  it('under Top 3 gives a picked boat a rank colour only at ranks ≤ 3', () => {
    const at = (r: number): SpeedStyle => speedStyle(rank(r, 49), 3, 'this');
    expect(at(2)).toMatchObject({ kind: 'ranked', t: 0.5, opacity: 1 });
    expect(at(3)).toMatchObject({ kind: 'ranked', t: 1, opacity: 1 });
    for (const r of [4, 43]) expect(at(r)).toMatchObject({ kind: 'picked-out', t: null, opacity: 1, width: 3.2 });
    // and Top N past the fleet is All: no picked-out
    expect(speedStyle(rank(43, 49), 'all', 'this').kind).toBe('ranked');
    // an unranked pick stays grey dashed at full opacity
    expect(speedStyle(undefined, 3, 'this')).toMatchObject({ kind: 'unranked', opacity: 1 });
  });

  it('finds a tie straddling the Top N cut (competition ranks)', () => {
    expect(tieAtCut([1, 2, 3, 3, 5], 3)).toEqual({ rank: 3, count: 2 });
    expect(tieAtCut([1, 2, 3, 4], 3)).toBeNull();
    expect(tieAtCut([1, 2, 2, 4], 3)).toBeNull(); // 3 in: the tie is inside N
    expect(tieAtCut([1, 1, 1, 1, 5], 3)).toEqual({ rank: 1, count: 4 });
    expect(tieAtCut([1, 2, 3, 3, 3, 6, 7, 8, 9, 10, 10, 12], 10)).toEqual({ rank: 10, count: 2 });
    expect(tieAtCut([], 3)).toBeNull();
  });
});

describe('colour preference', () => {
  it('parses stored values, defaulting to Leg / Each leg', () => {
    expect(parseTrackColour('rank')).toBe('rank');
    expect(parseTrackColour('sog')).toBe('sog');
    expect(parseTrackColour('leg')).toBe('leg');
    for (const bad of [null, undefined, '', 'Speed', 'SOG', 'rainbow', '{}']) expect(parseTrackColour(bad)).toBe('leg');
    expect(parseRankBy('overall')).toBe('overall');
    for (const bad of [null, undefined, '', 'OVERALL', 'x']) expect(parseRankBy(bad)).toBe('leg');
  });

  it('survives storage that throws', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(readPref('recall.trackColour')).toBeNull();
      expect(() => writePref('recall.trackColour', 'speed')).not.toThrow();
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('maps the legacy stored "speed" (rank colouring before Boat speed) to Rank', () => {
    expect(parseTrackColour('speed')).toBe('rank');
  });

  it('renders accessible toggle buttons; Rank by only for the whole race in Rank', () => {
    const leg = colourControls('leg', 'leg', null);
    expect(leg).toContain('data-colour="leg" aria-pressed="true"');
    expect(leg).toContain('data-colour="rank" aria-pressed="false"');
    expect(leg).toContain('data-colour="sog" aria-pressed="false"');
    expect(leg).toMatch(/>Leg<.*>Rank<.*>Boat speed</);
    expect(leg).not.toContain('data-rank');
    const sog = colourControls('sog', 'leg', null, 3);
    expect(sog).toContain('data-colour="sog" aria-pressed="true"');
    expect(sog).not.toContain('data-rank');
    expect(sog).not.toContain('data-top');
    expect(colourControls('rank', 'overall', null)).toContain('data-rank="overall" aria-pressed="true"');
    expect(colourControls('rank', 'leg', 1)).not.toContain('data-rank');
  });

  it('offers Highlight: Top 3 | Top 10 | All only in Rank, defaulting to All', () => {
    expect(colourControls('leg', 'leg', null, 3)).not.toContain('data-top');
    const def = colourControls('rank', 'leg', null);
    expect(def).toContain('aria-label="Highlight the fastest"');
    expect(def).toContain('data-top="all" aria-pressed="true"');
    expect(def).toContain('data-top="3" aria-pressed="false"');
    expect(colourControls('rank', 'leg', 1, 10)).toContain('data-top="10" aria-pressed="true"');
    expect(colourControls('rank', 'leg', 1, 10)).toMatch(/>Top 3<.*>Top 10<.*>All</);
  });
});

describe('track map in Rank', () => {
  const a = analyzeRace(fixtureRace());
  const polylines = (svg: string): string[] => [...svg.matchAll(/<polyline class="trk[^"]*"[^>]*>[\s\S]*?<\/polyline>/g)].map((m) => m[0]);
  const width = (p: string): number => Number(/ stroke-width="([\d.]+)"/.exec(p)![1]);
  const opacity = (p: string): number => Number(/ stroke-opacity="([\d.]+)"/.exec(p)![1]);

  it('leaves the Leg colouring as it was, with no native title tooltip', () => {
    const svg = trackMap(a, null, 1);
    expect(svg).toBe(trackMap(a, null, 1, { colour: 'leg' }));
    const ps = polylines(svg);
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every((p) => p.includes(`stroke="${legColor(1)}"`) && p.startsWith('<polyline class="trk"'))).toBe(true);
    expect(svg).not.toContain('spd');
    expect(svg).not.toContain('<title>');
  });

  it('colours one leg by rank with plasma, fastest on top, top 3 thicker', () => {
    const svg = trackMap(a, null, 1, { colour: 'rank' });
    const ps = polylines(svg).filter((p) => !p.includes('unranked'));
    expect(ps.length).toBeGreaterThan(3);
    expect(svg).not.toMatch(/stroke="var\(--s\d\)"/);
    expect(ps.every((p) => /stroke="#[0-9a-f]{6}" style="--cd:#[0-9a-f]{6}"/.test(p))).toBe(true);
    // Drawn slowest → fastest: the last one is #1, coloured as the fastest.
    const last = ps[ps.length - 1];
    const first = [...legRanks(a.boats, 1)].find(([, r]) => r.rank === 1)![0];
    expect(last).toContain(`data-id="${first}"`);
    expect(last).toContain(`stroke="${speedColor(0)}"`);
    expect(last).not.toContain('<title>');
    const top = ps.filter((p) => p.includes(' top'));
    const rest = ps.filter((p) => !p.includes(' top'));
    expect(top.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...top.map(width))).toBeGreaterThan(Math.max(...rest.map(width)));
    expect(svg).toMatch(/aria-label="Race Viewer on [^"]+, tracks colored by speed on the leg/);
  });

  it('draws boats that did not complete a leg grey, dashed and underneath', () => {
    const victim = a.boats[0].id;
    const cut = { ...a, boats: a.boats.map((b) => (b.id === victim ? { ...b, legs: b.legs.map((l, i) => (i === 1 ? null : l)) } : b)) };
    const svg = trackMap(cut, null, 1, { colour: 'rank' });
    const ps = polylines(svg);
    const un = ps.filter((p) => p.includes(`data-id="${victim}"`));
    expect(un.length).toBeGreaterThan(0);
    expect(un.every((p) => p.includes('unranked') && p.includes('stroke-dasharray'))).toBe(true);
    expect(ps[0]).toContain('unranked');
    expect(speedKey(cut, 1, 'leg')).toContain('<span class="spd-none" aria-hidden="true"></span> no leg time');  });

  it('ranks every segment on its own leg for the whole race', () => {
    const svg = trackMap(a, null, null, { colour: 'rank' });
    const ps = polylines(svg);
    for (const l of a.legs) {
      const first = [...legRanks(a.boats, l.index)].find(([, r]) => r.rank === 1)![0];
      expect(ps.some((p) => p.includes(`data-leg="${l.index}"`) && p.includes(`data-id="${first}"`) && p.includes(`stroke="${speedColor(0)}"`))).toBe(true);
    }
    expect(speedKey(a, null, 'leg')).toContain('on each leg');
  });

  it('colours the whole track by race time with Rank by: Overall', () => {
    const svg = trackMap(a, null, null, { colour: 'rank', rankBy: 'overall' });
    const winner = a.boats.reduce((p, q) => ((q.raceTimeS ?? Infinity) < (p.raceTimeS ?? Infinity) ? q : p));
    const mine = polylines(svg).filter((p) => p.includes(`data-id="${winner.id}"`));
    expect(mine.length).toBe(a.legs.length);
    expect(mine.every((p) => p.includes(`stroke="${speedColor(0)}"`))).toBe(true);
    expect(speedKey(a, null, 'overall')).toMatch(/race time.*\d+:\d\d → \d+:\d\d/);
  });

  it('puts a selected boat on top, full opacity with an outline, and dims the rest', () => {
    const plain = trackMap(a, null, 1, { colour: 'rank' });
    const slowest = [...legRanks(a.boats, 1).entries()].pop()![0];
    const svg = trackMap(a, slowest, 1, { colour: 'rank' });
    const ps = polylines(svg);
    const me = ps[ps.length - 1];
    expect(me).toContain(`data-id="${slowest}"`);
    expect(me).toContain(' on');
    expect(opacity(me)).toBe(1);
    expect(me).toContain(`stroke="${speedColor(1)}"`);
    expect(svg).toMatch(/<polyline class="spd-sel"[^>]*\/><polyline class="trk spd[^"]* on"/);
    // everyone else: their own emphasis × the selection dim
    const ranks = legRanks(a.boats, 1);
    expect(polylines(plain).length).toBe(ps.length);
    for (const p of ps.filter((q) => !q.includes(`data-id="${slowest}"`))) {
      const r = ranks.get(/data-id="([^"]+)"/.exec(p)![1])!;
      // written to 2 decimals
      expect(Math.abs(opacity(p) - speedEmphasis(r.rank, r.of).opacity * SELECTION_DIM)).toBeLessThanOrEqual(0.0051);
    }
  });

  it('sets stroke-opacity per stroke by rank, with no group opacity classes', () => {
    const svg = trackMap(a, null, 1, { colour: 'rank' });
    const ps = polylines(svg);
    expect(ps.every((p) => / stroke-opacity="[\d.]+"/.test(p))).toBe(true);
    const ranks = legRanks(a.boats, 1);
    for (const p of ps) {
      const id = /data-id="([^"]+)"/.exec(p)![1];
      const r = ranks.get(id)!;
      expect(opacity(p)).toBeCloseTo(speedEmphasis(r.rank, r.of).opacity, 2);
    }
    expect(new Set(ps.map(opacity)).size).toBeGreaterThan(1);
    expect(svg).not.toContain(' fade');
    // the pale-by-day casing fades with its stroke
    const cased = [...svg.matchAll(/<polyline class="spd-case"[^>]*stroke-opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(cased.length).toBeGreaterThan(0);
    expect(cased.every((o) => o > 0 && o <= 0.55)).toBe(true);
  });

  it('with Top 3, greys everyone else (solid, faint, thin) and spans the colours over 1..3', () => {
    const svg = trackMap(a, null, 1, { colour: 'rank', top: 3 });
    const ps = polylines(svg);
    const out = ps.filter((p) => /class="trk spd out"/.test(p));
    const ranks = legRanks(a.boats, 1);
    expect(out.length).toBe([...ranks.values()].filter((r) => r.rank > 3).length);
    for (const p of out) {
      expect(p).not.toContain('stroke-dasharray');
      expect(p).not.toMatch(/ stroke="#/);
      expect(opacity(p)).toBeCloseTo(0.2, 2);
      expect(ranks.get(/data-id="([^"]+)"/.exec(p)![1])!.rank).toBeGreaterThan(3);
    }
    const thirdId = [...ranks].find(([, r]) => r.rank === 3)![0];
    const third = ps.find((p) => p.includes(`data-id="${thirdId}"`))!;
    expect(third).toContain(`stroke="${speedColor(1)}"`);
    // out-of-N drawn under the coloured ones
    expect(ps.findIndex((p) => !p.includes(' out'))).toBeGreaterThanOrEqual(out.length);
    expect(speedKey(a, 1, 'leg', 3)).toMatch(/fastest → #3 on this leg.*\d+:\d\d → \d+:\d\d.*others gray/s);
  });

  it('treats Top N ≥ fleet as All', () => {
    expect(trackMap(a, null, 1, { colour: 'rank', top: 10 })).toBe(trackMap(a, null, 1, { colour: 'rank' }));
    expect(speedKey(a, 1, 'leg', 10)).toBe(speedKey(a, 1, 'leg'));
    expect(speedKey(a, 1, 'leg')).not.toContain('others gray');
  });

  it('applies Top N per leg in Each leg mode, by overall rank in Overall', () => {
    const svg = trackMap(a, null, null, { colour: 'rank', top: 3 });
    const ps = polylines(svg);
    const per = raceLegRanks(a.boats, a.legs.length);
    for (const l of a.legs) {
      for (const [id, r] of per[l.index]) {
        const p = ps.find((q) => q.includes(`data-leg="${l.index}"`) && q.includes(`data-id="${id}"`))!;
        expect(p.includes('class="trk spd out"')).toBe(r.rank > 3);
      }
    }
    expect(speedKey(a, null, 'leg', 3)).toContain('fastest → #3 on each leg');
    expect(speedKey(a, null, 'leg', 3)).toContain('#1 → #3');
    const o = overallRanks(a.boats);
    for (const p of polylines(trackMap(a, null, null, { colour: 'rank', rankBy: 'overall', top: 3 }))) {
      const r = o.get(/data-id="([^"]+)"/.exec(p)![1]);
      if (r) expect(p.includes('class="trk spd out"')).toBe(r.rank > 3);
    }
  });

  it('shows the time range for a single leg in the key', () => {
    const r = [...a.boats].map((b) => b.legs[1]?.timeS).filter((t): t is number => t != null);
    expect(r.length).toBeGreaterThan(0);
    expect(speedKey(a, 1, 'leg')).toMatch(/on this leg.*\d+:\d\d → \d+:\d\d/s);
  });
});

describe('a picked boat under Top N (M24 race 4)', () => {
  const a = analyzeRace(m24Race());
  const polylines = (svg: string): string[] => [...svg.matchAll(/<polyline class="trk[^"]*"[^>]*>[\s\S]*?<\/polyline>/g)].map((m) => m[0]);
  const idOf = (p: string): string => /data-id="([^"]+)"/.exec(p)![1];
  const coloured = (p: string): boolean => / stroke="#[0-9a-f]{6}"/.test(p);
  // A boat's track is split at telemetry gaps (several polylines per leg on this ~2.5 s feed): count boats.
  const boatsOf = (ps: string[]): number => new Set(ps.map(idOf)).size;
  const labels = (svg: string): string[] => [...svg.matchAll(/<text class="spd-pick-lbl"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const drawn = (id: string, l: number): boolean => a.drawings.some((d) => d.id === id && d.segments.some((s) => s.leg === l && s.x.length > 1));
  // A leg with a clean top 3 (no tie at the cut) and boats drawn well outside it.
  const leg = a.legs.findIndex((l) => {
    const rs = [...legRanks(a.boats, l.index).values()].map((r) => r.rank);
    return rs.length > 6 && tieAtCut(rs, 3) == null;
  });
  const ranks = legRanks(a.boats, leg);
  const [slow, slowRank] = [...ranks].filter(([id, r]) => r.rank > 3 && drawn(id, leg)).pop()!;
  const byRank = (k: number): string => [...ranks].find(([, r]) => r.rank === k)![0];
  const second = byRank(2);
  const label = (id: string): string => {
    const b = a.boats.find((x) => x.id === id)!;
    return `#${b.sail}${b.name !== `#${b.sail}` ? ` ${b.name}` : ''}`;
  };

  it('has a leg to test on', () => {
    expect(leg).toBeGreaterThanOrEqual(0);
    expect(slowRank.rank).toBeGreaterThan(3);
    expect([1, 2, 3].every((k) => drawn(byRank(k), leg))).toBe(true);
  });

  it('colours exactly the top 3 and draws a pick outside them in neutral ink with its rank', () => {
    const svg = trackMap(a, slow, leg, { colour: 'rank', top: 3 });
    const ps = polylines(svg);
    expect(boatsOf(ps.filter((p) => idOf(p) !== slow && coloured(p)))).toBe(3);
    const mine = ps.filter((p) => idOf(p) === slow);
    expect(mine.length).toBeGreaterThan(0);
    for (const p of mine) {
      // A stretch filled into a short gap (ui/gapFill.ts) is the same line, lighter (trk-est).
      expect(p).toMatch(/^<polyline class="trk spd picked on( trk-est)?"/);
      expect(coloured(p)).toBe(false);
      expect(p).not.toContain('--cd');
      expect(p).not.toContain('<title>');
    }
    // on a surface casing, not the selection's ink outline; drawn last
    expect(svg).toMatch(/<polyline class="spd-pick-case"[^>]*\/><polyline class="trk spd picked on"/);
    expect(svg).not.toContain('spd-sel');
    expect(idOf(ps[ps.length - 1])).toBe(slow);
    expect(labels(svg)).toEqual([`#${slowRank.rank}`]);
    expect(svg).toMatch(/<text class="spd-pick-lbl"[^>]* font-size="[\d.]+" stroke-width="[\d.]+"/);
  });

  it('keeps a picked top-3 boat in its rank colour, with no label', () => {
    const svg = trackMap(a, second, leg, { colour: 'rank', top: 3 });
    const ps = polylines(svg);
    expect(boatsOf(ps.filter(coloured))).toBe(3);
    expect(ps.filter((p) => idOf(p) === second).every((p) => coloured(p) && p.includes(' on'))).toBe(true);
    expect(svg).toContain('spd-sel');
    expect(svg).not.toContain('picked');
    expect(labels(svg)).toEqual([]);
  });

  it('leaves Highlight: All and Colour: Leg alone', () => {
    expect(trackMap(a, slow, leg, { colour: 'rank' })).not.toContain('picked');
    expect(trackMap(a, slow, leg)).not.toContain('spd-pick');
  });

  it('names the pick in the key only when it is outside the top N', () => {
    const key = speedKey(a, leg, 'leg', 3, slow);
    expect(key).toContain(`picked: ${label(slow)} #${slowRank.rank} on this leg`);
    expect(key).toContain('<span class="spd-pick" aria-hidden="true"></span>');
    // the span still comes from the top 3 only: the same key, plus the picked entry
    expect(key).toMatch(/fastest → #3 on this leg/);
    expect(key.replace(/ · <span class="spd-picked"><span class="spd-pick"[^>]*><\/span>[^<]*<\/span>/, '')).toBe(speedKey(a, leg, 'leg', 3));
    expect(speedKey(a, leg, 'leg', 3)).not.toContain('picked:');
    expect(speedKey(a, leg, 'leg', 3, second)).not.toContain('picked:');
    expect(speedKey(a, leg, 'leg', 'all', slow)).not.toContain('picked:');
  });

  it('says nothing about a picked non-competitor or an unranked pick', () => {
    expect(a.excluded.length).toBeGreaterThan(0);
    expect(speedKey(a, leg, 'leg', 3, a.excluded[0].result.id)).not.toContain('picked:');
    const cut = { ...a, boats: a.boats.map((b) => (b.id === slow ? { ...b, legs: b.legs.map((l, i) => (i === leg ? null : l)) } : b)) };
    expect(speedKey(cut, leg, 'leg', 3, slow)).not.toContain('picked:');
    expect(labels(trackMap(cut, slow, leg, { colour: 'rank', top: 3 }))).toEqual([]);
  });

  it('for the whole race on each leg, labels and lists every leg the pick is outside the top 3', () => {
    const per = raceLegRanks(a.boats, a.legs.length);
    const outLegs = a.legs.filter((l) => drawn(slow, l.index) && (per[l.index].get(slow)?.rank ?? 0) > 3);
    expect(outLegs.length).toBeGreaterThan(0);
    const svg = trackMap(a, slow, null, { colour: 'rank', top: 3 });
    expect(labels(svg)).toEqual(outLegs.map((l) => `#${per[l.index].get(slow)!.rank}`));
    const list = outLegs.map((l) => `#${per[l.index].get(slow)!.rank} ${l.name}`).join(' · ');
    expect(speedKey(a, null, 'leg', 3, slow)).toContain(`picked: ${label(slow)}, ${list}`);
    for (const l of a.legs) {
      const n = [...per[l.index]].filter(([id, r]) => r.rank <= 3 && drawn(id, l.index)).length;
      expect(boatsOf(polylines(svg).filter((p) => p.includes(`data-leg="${l.index}"`) && coloured(p)))).toBe(n);
    }
  });

  it('with Rank by: Overall, one label at the end of the track and its race-time rank', () => {
    const [id, r] = [...overallRanks(a.boats)].filter(([b, k]) => k.rank > 3 && drawn(b, a.legs.length - 1)).pop()!;
    const svg = trackMap(a, id, null, { colour: 'rank', rankBy: 'overall', top: 3 });
    expect(labels(svg)).toEqual([`#${r.rank}`]);
    const mine = polylines(svg).filter((p) => idOf(p) === id);
    expect(mine.length).toBeGreaterThan(1);
    expect(mine.every((p) => /^<polyline class="trk spd picked on( trk-est)?"/.test(p))).toBe(true);
    expect(speedKey(a, null, 'overall', 3, id)).toContain(`picked: ${label(id)} #${r.rank} race time`);
  });

  it('keeps a tie at the cut in (N + 1 coloured) and says so in the key', () => {
    const [third, fourth] = [byRank(3), byRank(4)];
    const t3 = a.boats.find((b) => b.id === third)!.legs[leg]!.timeS;
    const tied = { ...a, boats: a.boats.map((b) => (b.id === fourth ? { ...b, legs: b.legs.map((l, i) => (i === leg && l ? { ...l, timeS: t3 } : l)) } : b)) };
    expect(legRanks(tied.boats, leg).get(fourth)!.rank).toBe(3);
    expect(boatsOf(polylines(trackMap(tied, null, leg, { colour: 'rank', top: 3 })).filter(coloured))).toBe(drawn(fourth, leg) ? 4 : 3);
    expect(speedKey(tied, leg, 'leg', 3)).toMatch(/fastest → #3 on this leg.* · <span class="spd-tie">2 tied at #3<\/span>/s);
    expect(speedKey(a, leg, 'leg', 3)).not.toContain('tied');
    expect(speedKey(tied, leg, 'leg', 'all')).not.toContain('tied');
    expect(speedKey(tied, null, 'leg', 3)).toContain(`2 tied at #3 on ${a.legs[leg].name}`);
  });
});
