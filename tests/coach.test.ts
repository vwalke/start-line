import { describe, expect, it } from 'vitest';
import { DEFAULT_GROUPS, LEADERS_N, NEAR_PLACES, defaultGroup, groupIds, placeOf, type Group } from '../src/analysis/coach/groups';
import { GROUP_MIN_SHARE, LAYLINE_MAX_DEG, LAYLINE_MIN_DEG, RUN_LAYLINE_DEG, distToGo, fleetVmg, gapAt, gapSeries, laylineDeg, rung, type Course } from '../src/analysis/coach/ladder';
import { lineCrossing } from '../src/analysis/coach/lineCross';
import { COACH_MAX_SPAN_S, COACH_NEAR_FIX_S, boundsOf, legAt, longestHole, posAt, projectCoachTrack, type CoachTrack } from '../src/analysis/coach/tracks';
import { TWD_MIN_PER_TACK, TWD_MIN_SAMPLES, cogPairs, fleetTwdSeries, twdSeriesFrom } from '../src/analysis/coach/twdSeries';
import { MS_TO_KN, bearingVec, makeProjection, type Vec } from '../src/analysis/geo';
import { projectTrack } from '../src/analysis/prepare';
import { j105Race } from './helpers';
import { GROUP_BRIDGE_S, GROUP_DRAW_HOLE_S } from '../src/analysis/coach/timeGap';
import { COACH_BULLETS, NO_DATA_MIN_MS, ladderBreaks, ladderChips } from '../src/ui/coach';
import type { RaceAnalysis } from '../src/analysis/types';
import type { BoatResult, LegResult } from '../src/analysis/types';
import { coachHighlight, coachLegendName, groupParam, ladderBoatColor, ladderLegSpans, mergeLadderLegLabels, nullSpans, gapWords, parseBoatParam, parseGroupParam } from '../src/ui/coach';

/** A track from (t s, x m, y m) triples. */
const track = (id: string, pts: [number, number, number][], bounds: (number | null)[] = [0, 1e9]): CoachTrack => ({
  id,
  t: Float64Array.from(pts, (p) => p[0] * 1000),
  x: Float64Array.from(pts, (p) => p[1]),
  y: Float64Array.from(pts, (p) => p[2]),
  bounds,
});

describe('legAt: the leg a boat is on', () => {
  it('between known roundings; past the finish none', () => {
    const b = [0, 100, 200, 300];
    expect(legAt(b, 0)).toBe(0);
    expect(legAt(b, 150)).toBe(1);
    expect(legAt(b, 300)).toBe(2);
    expect(legAt(b, 301)).toBeNull();
    expect(legAt(b, -1)).toBeNull();
  });

  it('unknown across a rounding a hole left in doubt; the last known leg when nothing later is known (finish in a hole)', () => {
    expect(legAt([0, 100, null, 300, 400], 150)).toBeNull();
    expect(legAt([0, 100, null, 300, 400], 350)).toBe(3);
    // Race 1 Good Trade: Run 2 started at a known rounding, no finish.
    expect(legAt([0, 100, 200, 300, null], 350)).toBe(3);
    expect(legAt([0, 100, null, null, null], 150)).toBe(1);
  });

  it('boundsOf: from the timed legs, the gun and the finish', () => {
    const leg = (a: number, e: number) => ({ startMs: a, endMs: e }) as LegResult;
    expect(boundsOf([leg(0, 100), null, leg(200, 300)], 0, 400)).toEqual([0, 100, 200, 400]);
    expect(boundsOf([leg(0, 100), null, null], 0, null)).toEqual([0, 100, null, null]);
  });
});

describe('posAt: positions only next to real fixes', () => {
  const tr = track('a', [
    [0, 0, 0],
    [4, 0, 40],
    [16, 0, 160],
    [42, 0, 420],
  ]);
  it('interpolates within a short span', () => {
    expect(posAt(tr, 2000)).toEqual([0, 20]);
    expect(posAt(tr, 4000)).toEqual([0, 40]);
  });
  it(`never across a hole over ${COACH_MAX_SPAN_S} s, and only within ${COACH_NEAR_FIX_S} s of a fix`, () => {
    expect(posAt(tr, 20_000)).toBeNull(); // 16 → 42 s: a 26 s hole
    expect(posAt(tr, 10_000)).toBeNull(); // 6 s from both ends of a 12 s span
    expect(posAt(tr, 9_000)).toEqual([0, 90]); // 5 s from a fix: still read
    expect(posAt(tr, -1)).toBeNull();
    expect(posAt(tr, 43_000)).toBeNull();
  });
  it('longestHole: the longest stretch with fixes over 5 s apart', () => {
    expect(longestHole(tr.t, 0, 42_000)).toEqual({ fromMs: 16_000, toMs: 42_000 });
    // Past the last fix counts too (a finish in a hole).
    expect(longestHole(tr.t, 0, 80_000)).toEqual({ fromMs: 42_000, toMs: 80_000 });
    expect(longestHole(Float64Array.of(0, 1000, 2000), 0, 2000)).toBeNull();
  });
});

describe('fleetTwdSeries: the wind minute by minute from the fleet’s tacks', () => {
  /**
   * `n` boats beating at 6 kn, tacking every 60 s (staggered), wind from `twd(t)` and a 90° tack angle,
   * a fix every `step` s for `mins` minutes; positions only (no heading anywhere).
   */
  const fleet = (n: number, twd: (tS: number) => number, mins = 20, step = 1, ta = 90): CoachTrack[] =>
    Array.from({ length: n }, (_, k) => {
      const pts: [number, number, number][] = [];
      let x = k * 50;
      let y = 0;
      for (let s = 0; s <= mins * 60; s += step) {
        pts.push([s, x, y]);
        const port = Math.floor((s + k * 13) / 60) % 2 === 0;
        const v = bearingVec(twd(s) + (port ? ta / 2 : -ta / 2));
        const d = (6 / MS_TO_KN) * step;
        x += v[0] * d;
        y += v[1] * d;
      }
      return track(`b${k}`, pts, [0, mins * 60_000 + 1]);
    });
  const base = { gunMs: 0, legKinds: ['upwind' as const], priorTa: 80 };

  it('cogPairs: course from fixes 3–12 s apart, from positions', () => {
    const c = cogPairs(track('a', [[0, 0, 0], [1, 0, 1], [4, 0, 4], [20, 0, 20], [30, 10, 20]]));
    expect(c.cog[0]).toBeCloseTo(0, 6); // 0 → 4 s
    expect(c.t[0]).toBe(2000);
    // 4 → 20 s is too far apart; 20 → 30 s heads east.
    expect(c.cog.at(-1)).toBeCloseTo(90, 6);
    expect(c.t.includes(12_000)).toBe(false);
  });

  it('finds a steady wind 10° off the seed, and the tack angle', () => {
    const s = fleetTwdSeries({ ...base, endMs: 20 * 60_000, tracks: fleet(6, () => 10), prior: () => 0 });
    expect(s.ok.every(Boolean)).toBe(true);
    for (let i = 0; i < s.t.length; i++) {
      expect(s.twd[i]).toBeCloseTo(10, 0);
      expect(s.ta[i]).toBeCloseTo(90, 0);
    }
  });

  it('follows a 20° shift, through north without a jump', () => {
    const s = fleetTwdSeries({ ...base, endMs: 20 * 60_000, tracks: fleet(6, (t) => (t < 600 ? 350 : 10)), prior: () => 0 });
    expect(s.twd[3]).toBeCloseTo(350, 0);
    expect(s.twd[16]).toBeCloseTo(10, 0);
    // Between two measured minutes: interpolated the short way round.
    const mid = s.twdAt(9.5 * 60_000);
    expect(Math.min(mid, 360 - mid)).toBeLessThan(11);
  });

  it(`interpolates and flags a minute with < ${TWD_MIN_SAMPLES} samples or < ${TWD_MIN_PER_TACK} on a tack`, () => {
    // One boat every 10 s: ~12 samples a window.
    const thin = fleetTwdSeries({ ...base, endMs: 10 * 60_000, tracks: fleet(1, () => 10, 10, 10), prior: () => 4 });
    expect(thin.ok.some(Boolean)).toBe(false);
    // Nothing measured: the seed.
    expect(thin.twdAt(60_000)).toBe(4);
    expect(thin.taAt(60_000)).toBe(80);
    const d = { t: [0, 60_000, 120_000], twd: [10, NaN, 20], ta: [80, NaN, 90], n: [40, 3, 40], ok: [true, false, true] };
    const s = twdSeriesFrom(d, () => 0, 85);
    expect(s.twd[1]).toBeCloseTo(15, 6);
    expect(s.ta[1]).toBeCloseTo(85, 6);
    expect(s.ok).toEqual([true, false, true]);
  });

  it('only beats count, and only above 3 kn', () => {
    const tracks = fleet(6, () => 10).map((tr) => ({ ...tr, bounds: [0, 1, 20 * 60_000 + 1] }));
    const run = fleetTwdSeries({ ...base, legKinds: ['upwind', 'downwind'], endMs: 20 * 60_000, tracks, prior: () => 0 });
    expect(run.ok.some(Boolean)).toBe(false);
  });
});

describe('the wind ladder', () => {
  const N: Vec = [0, 1000];
  it('rung: distance along the wind inside the laylines', () => {
    expect(rung([0, 0], N, 0, 'upwind', 90)).toBeCloseTo(1000, 6);
    // 300 m to the side, still inside a 45° layline: only the upwind part counts.
    expect(rung([300, 0], N, 0, 'upwind', 90)).toBeCloseTo(1000, 6);
  });

  it('rung: past the layline, hypot(u, c)·cos(a)', () => {
    const p: Vec = [1500, 0];
    expect(rung(p, N, 0, 'upwind', 90)).toBeCloseTo(Math.hypot(1000, 1500) * Math.cos(Math.PI / 4), 6);
    // Downwind: away from the wind, 30° either side.
    expect(rung([0, 1000], [0, 0], 0, 'downwind', 90)).toBeCloseTo(1000, 6);
    expect(rung([1000, 1000], [0, 0], 0, 'downwind', 90)).toBeCloseTo(Math.hypot(1000, 1000) * Math.cos(Math.PI / 6), 6);
    // Overstood (the mark is downwind on a beat): just the cross distance, cos(a) of it.
    expect(rung([0, 1200], N, 0, 'upwind', 90)).toBeCloseTo(0, 6);
  });

  it(`layline half-angle: half the tack angle clamped to ${LAYLINE_MIN_DEG}–${LAYLINE_MAX_DEG}°; ${RUN_LAYLINE_DEG}° downwind`, () => {
    expect(laylineDeg('upwind', 90)).toBe(45);
    expect(laylineDeg('upwind', 140)).toBe(65);
    expect(laylineDeg('upwind', 50)).toBe(35);
    expect(laylineDeg('downwind', 90)).toBe(30);
  });

  const course: Course = {
    pts: [
      [0, 0],
      [0, 1000],
      [0, 200],
    ],
    kinds: ['upwind', 'downwind'],
  };
  it('distance to go: the scaled rung plus the legs still to come', () => {
    expect(distToGo(course, 0, [0, 0], 0, 90)).toBeCloseTo(1800, 6);
    expect(distToGo(course, 0, [0, 500], 0, 90)).toBeCloseTo(1300, 6);
    expect(distToGo(course, 1, [0, 600], 0, 90)).toBeCloseTo(400, 6);
    // The wind 30° right of the course: the rung is scaled back up to the rhumb length.
    expect(distToGo(course, 0, [0, 0], 30, 90)).toBeCloseTo(1000 + 800, 6);
  });

  const wind = { twdAt: () => 0, taAt: () => 90 };
  const vmg = [2, 2];
  const along = (id: string, y0: number, holes: [number, number][] = []) =>
    track(
      id,
      Array.from({ length: 101 }, (_, s) => [s, 0, y0 + 2 * s] as [number, number, number]).filter(([s]) => !holes.some(([a, b]) => s > a && s < b)),
      [0, 300_000, 600_000],
    );

  it('gap: rung difference ÷ the fleet VMG, + = behind', () => {
    const me = along('me', 0);
    const r = along('r', 50);
    expect(gapAt(course, wind, vmg, me, r, 10_000)).toBeCloseTo(25, 6);
    expect(gapAt(course, wind, vmg, r, me, 10_000)).toBeCloseTo(-25, 6);
  });

  it('null across a hole, on different legs, or with no fleet VMG', () => {
    const me = along('me', 0, [[20, 60]]);
    const r = along('r', 50);
    expect(gapAt(course, wind, vmg, me, r, 40_000)).toBeNull();
    expect(gapAt(course, wind, vmg, me, r, 60_000)).not.toBeNull();
    expect(gapAt(course, wind, [null, 2], along('me', 0), r, 10_000)).toBeNull();
    const ahead = { ...r, bounds: [0, 5_000, 600_000] };
    expect(gapAt(course, wind, vmg, along('me', 0), ahead, 10_000)).toBeNull();
  });

  it(`gapSeries: the median of the group boats that compare (at least ${GROUP_MIN_SHARE * 100}% of them), with breaks`, () => {
    const me = along('me', 0, [[20, 60]]);
    const g = [along('a', 20), along('b', 50), along('c', -40)];
    const s = gapSeries(course, wind, vmg, me, g, 0, 100_000, 10_000);
    expect(s[1]).toMatchObject({ tMs: 10_000, behindS: 10, n: 3, leg: 0 });
    expect(s[1].each).toEqual([10, 25, -20]);
    expect(s[4]).toMatchObject({ tMs: 40_000, behindS: null, n: 0, leg: null });
    expect(s[1].each.every((x) => x != null)).toBe(true);
    // Under half the group comparing: no median (it would jump as boats drop in and out); the boats' own gaps stay.
    const late = [along('a', 20), { ...along('b', 50), bounds: [0, 30_000, 600_000] }, { ...along('c', -40), bounds: [0, 30_000, 600_000] }];
    const s2 = gapSeries(course, wind, vmg, along('me', 0), late, 0, 50_000, 10_000);
    expect(s2[2]).toMatchObject({ behindS: 10, n: 3 });
    expect(s2[4]).toMatchObject({ behindS: null, n: 1 });
    expect(s2[4].each).toEqual([10, null, null]);
  });

  it('fleetVmg: the median leg VMG, m/s', () => {
    const v = fleetVmg([{ legs: [{ vmgKn: 4 }, null] }, { legs: [{ vmgKn: 6 }, null] }, { legs: [{ vmgKn: 5 }, null] }], 2);
    expect(v[0]).toBeCloseTo(5 / MS_TO_KN, 9);
    expect(v[1]).toBeNull();
  });
});

describe('reference groups', () => {
  const b = (id: string, finishPos: number | null, rank: number | null = null) =>
    ({ id, finishPos, legs: [rank == null ? null : ({ rankAtEnd: rank } as LegResult)] }) as Pick<BoatResult, 'id' | 'finishPos' | 'legs'>;
  const boats = [b('A', 1), b('B', 2), b('C', 3), b('D', 4), b('E', 5), b('F', 6), b('G', 7), b('H', 8), b('X', null, 4), b('Y', null)];

  it(`leaders: the first ${LEADERS_N} finishers other than me, the same set on every leg`, () => {
    expect(groupIds(boats, 'E', { kind: 'leaders' })).toEqual(['A', 'B', 'C']);
    expect(groupIds(boats, 'B', { kind: 'leaders' })).toEqual(['A', 'C', 'D']);
    // Mid-race ranks do not re-pick the set (not "best on this leg").
    const mid = boats.map((x) => ({ ...x, legs: [{ rankAtEnd: 1 } as LegResult] }));
    expect(groupIds(mid, 'E', { kind: 'leaders' })).toEqual(['A', 'B', 'C']);
    expect(groupIds(mid, 'A', { kind: 'near' })).toEqual(groupIds(boats, 'A', { kind: 'near' }));
  });

  it(`near: finished within ±${NEAR_PLACES} places; no finish → the rank at its last mark; no place at all → none`, () => {
    expect(groupIds(boats, 'E', { kind: 'near' })).toEqual(['B', 'C', 'D', 'F', 'G', 'H']);
    expect(groupIds(boats, 'A', { kind: 'near' })).toEqual(['B', 'C', 'D']);
    expect(placeOf(boats[8])).toBe(4);
    expect(groupIds(boats, 'X', { kind: 'near' })).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(groupIds(boats, 'Y', { kind: 'near' })).toEqual([]);
  });

  it('fleet: everyone else racing; custom: the listed boats in this race (unknown ids dropped, never me)', () => {
    expect(groupIds(boats, 'A', { kind: 'fleet' })).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'X', 'Y']);
    expect(groupIds(boats, 'A', { kind: 'custom', ids: ['H', 'nope', 'A', 'C'] })).toEqual(['C', 'H']);
  });

  it('per-chart defaults: leaders for starts and shifts (and the rival ladder), boats near you for consolidation and the last leg', () => {
    expect(DEFAULT_GROUPS).toEqual({ rivalLadder: 'leaders', start: 'leaders', shift: 'leaders', consolidation: 'near', lastLeg: 'near' });
    expect(defaultGroup('lastLeg')).toEqual({ kind: 'near' });
  });
});

describe('the boat in the URL (boat=)', () => {
  it('parses a sail, and treats blank as missing', () => {
    expect(parseBoatParam('USA 96')).toBe('USA 96');
    expect(parseBoatParam('  USA 96  ')).toBe('USA 96');
    for (const bad of [null, undefined, '', '  ']) expect(parseBoatParam(bad)).toBeNull();
  });

  it('a shared boat= wins over a saved lastView boat; unknown ids fall through', () => {
    const known = ['USA 96', 'USA 242', 'USA 328'];
    expect(coachHighlight('USA 96', 'USA 242', known)).toBe('USA 96');
    expect(coachHighlight(null, 'USA 242', known)).toBe('USA 242');
    expect(coachHighlight('GHOST', 'USA 242', known)).toBe('USA 242');
    expect(coachHighlight('GHOST', 'ALSO', known)).toBeNull();
    expect(coachHighlight(null, null, known)).toBeNull();
  });
});

describe('projectCoachTrack: positions only, same XY as projectTrack', () => {
  it('matches projectTrack x/y on a fixture boat, without needing heading or SOG', () => {
    const data = j105Race(1);
    const b = data.boats.find((x) => x.id === 'USA 96')!;
    const proj = makeProjection(data.startLine.left);
    const slim = projectCoachTrack(b.track, proj);
    const full = projectTrack(b.track, proj);
    expect(slim.t.length).toBe(full.t.length);
    expect(slim.t[0]).toBe(full.t[0]);
    expect(slim.x[10]).toBeCloseTo(full.x[10], 9);
    expect(slim.y[10]).toBeCloseTo(full.y[10], 9);
  });
});

describe('the group in the URL (grp=)', () => {
  it('parses and serializes the presets', () => {
    expect(parseGroupParam('top3')).toEqual({ kind: 'leaders' });
    expect(parseGroupParam('near')).toEqual({ kind: 'near' });
    expect(parseGroupParam('fleet')).toEqual({ kind: 'fleet' });
    for (const g of [{ kind: 'leaders' }, { kind: 'near' }, { kind: 'fleet' }] as Group[]) expect(parseGroupParam(groupParam(g))).toEqual(g);
  });

  it('a custom list round-trips through the query string, sail numbers with spaces and all', () => {
    const g: Group = { kind: 'custom', ids: ['USA 242', 'USA 328'] };
    expect(groupParam(g)).toBe('c:USA 242,USA 328');
    const u = new URL('https://recall.example/?event=x');
    u.searchParams.set('grp', groupParam(g));
    expect(parseGroupParam(new URL(u.toString()).searchParams.get('grp'))).toEqual(g);
    expect(parseGroupParam(new URLSearchParams('grp=c:USA%20242,USA%20328').get('grp'))).toEqual(g);
  });

  it('tolerates junk: unknown values are null, empty and repeated ids drop out, unknown boats stay (they drop per race)', () => {
    for (const bad of [null, undefined, '', 'TOP3', 'leaders', 'x:USA 1']) expect(parseGroupParam(bad)).toBeNull();
    expect(parseGroupParam('c:')).toEqual({ kind: 'custom', ids: [] });
    expect(parseGroupParam('c:A,,A, B ')).toEqual({ kind: 'custom', ids: ['A', 'B'] });
    expect(groupIds([{ id: 'A', finishPos: 1, legs: [] }], 'Z', parseGroupParam('c:A,GHOST')!)).toEqual(['A']);
    // An id with a comma can't be listed.
    expect(groupParam({ kind: 'custom', ids: ['A,1', 'B'] })).toBe('c:B');
  });
});

describe('lineCrossing', () => {
  // Line along x from -50 to 50 at y = 0; course side north.
  const L: Vec = [-50, 0];
  const R: Vec = [50, 0];
  it('the first crossing to the course side between the ends, interpolated', () => {
    const tr = { t: [0, 1000, 2000, 3000], x: [0, 0, 0, 0], y: [-20, -10, 10, 30] };
    expect(lineCrossing(tr, L, R, [0, 1], 0)).toBeCloseTo(1500, 6);
    // The bow 5 m ahead crosses 0.25 s sooner.
    expect(lineCrossing(tr, L, R, [0, 1], 0, { bowM: 5 })).toBeCloseTo(1250, 6);
  });
  it('null past the ends, across a hole, or before `fromMs` only', () => {
    expect(lineCrossing({ t: [0, 1000], x: [200, 200], y: [-10, 10] }, L, R, [0, 1], 0)).toBeNull();
    expect(lineCrossing({ t: [0, 9000], x: [0, 0], y: [-10, 10] }, L, R, [0, 1], 0)).toBeNull();
    expect(lineCrossing({ t: [0, 1000, 2000, 3000, 4000], x: [0, 0, 0, 0, 0], y: [-10, 10, -10, -5, 5] }, L, R, [0, 1], 1500)).toBeCloseTo(3500, 6);
  });
});

describe('Coach UI helpers', () => {
  it('nullSpans: holes in the median longer than COACH_MAX_SPAN_S (the thin lines\' break), from the last value before', () => {
    const p = (s: number, v: number | null) => ({ tMs: s * 1000, behindS: v });
    expect(NO_DATA_MIN_MS).toBe(COACH_MAX_SPAN_S * 1000);
    expect(nullSpans([p(0, 1), p(10, null), p(20, 2)])).toEqual([[0, 20_000]]);
    expect(nullSpans([p(0, 1), p(5, null), p(15, 2)])).toEqual([]);
    expect(nullSpans([p(0, 1), p(10, null), p(20, null), p(30, 2), p(40, null), p(50, 3)])).toEqual([
      [0, 30_000],
      [30_000, 50_000],
    ]);
    expect(nullSpans([p(0, 1), p(5, null), p(10, 2)])).toEqual([]);
    expect(nullSpans([p(0, null), p(10, null), p(20, null), p(30, 1)])).toEqual([[0, 30_000]]);
  });

  it('the "no data" chip shows exactly when the chart breaks (a band, or a thin line that stops and starts again), and says the rules', () => {
    const pt = (s: number, v: number | null, each: (number | null)[]) => ({ tMs: s * 1000, behindS: v, n: 2, each, leg: 0 });
    const a = { boats: [{ id: 'me', sail: '1', name: '#1' }, { id: 'r', sail: '2', name: '#2' }, { id: 'q', sail: '3', name: '#3' }] } as unknown as RaceAnalysis;
    const lad = (points: ReturnType<typeof pt>[]) => ({ boat: 'me', group: ['r', 'q'], points, roundings: [], hole: null });
    const chip = (points: ReturnType<typeof pt>[], each = true) => ladderChips(a, lad(points), { kind: 'leaders' }, each).find((c) => c.text === 'no data');
    // Every line drawn throughout: no chip.
    const clean = [pt(0, 3, [2, 4]), pt(10, 3, [2, 4]), pt(20, 3, [2, 4])];
    expect(ladderBreaks(lad(clean), true)).toBe(false);
    expect(chip(clean)).toBeUndefined();
    // A thin line breaking (that boat's fixes over COACH_MAX_SPAN_S apart): the chip, with the lines on (v1 showed it
    // only for a gap in the bold line, and named only its 30 s rule).
    const thin = [pt(0, 3, [2, 4]), pt(10, 3, [null, 4]), pt(20, 3, [2, 4])];
    expect(chip(thin)!.title).toContain(`over ${COACH_MAX_SPAN_S} s apart`);
    expect(chip(thin)!.title).toContain(`over ${GROUP_DRAW_HOLE_S} s apart`);
    expect(chip(thin, false)).toBeUndefined();
    // The bold line breaking (a band): the chip either way.
    const bold = [pt(0, 3, [2, 4]), pt(10, null, [2, 4]), pt(20, 3, [2, 4])];
    expect(chip(bold, false)).toBeDefined();
  });

  it('the ⓘ says what is filled in: the group line bridges gaps of up to GROUP_BRIDGE_S in a straight line, the thin lines are not', () => {
    const text = COACH_BULLETS.join(' ');
    expect(GROUP_BRIDGE_S / 60).toBe(10);
    expect(text).toContain(`a gap of up to ${GROUP_BRIDGE_S / 60} min, the bold line bridges it in a straight line`);
    expect(text).toContain('its line is not filled in across gaps');
    expect(text).toContain(`over ${COACH_MAX_SPAN_S} s apart`);
    expect(text).not.toMatch(/short tracker hole|never joined/);
  });

  it('gapWords: the debrief’s wording', () => {
    expect(gapWords(29.4)).toBe('29 s behind');
    expect(gapWords(-67)).toBe('67 s ahead');
    expect(gapWords(0.2)).toBe('level');
  });

  it('ladderLegSpans: one label per course leg, first at the gun, last to the finish', () => {
    const legs = [{ name: 'Beat 1' }, { name: 'Run 1' }, { name: 'Beat 2' }, { name: 'Run 2' }];
    const gun = 1_000;
    const end = 5_000;
    const spans = ladderLegSpans(legs, gun, [{ tMs: 2_000, leg: 1 }, { tMs: 3_000, leg: 2 }, { tMs: 4_000, leg: 3 }], end);
    expect(spans).toHaveLength(4);
    expect(spans.map((s) => s.name)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(spans[0].fromMs).toBe(gun);
    expect(spans[0].toMs).toBe(2_000);
    expect(spans[3].fromMs).toBe(4_000);
    expect(spans[3].toMs).toBe(end);
    // A missing rounding still yields a raw span for every leg; the chart merges the overlap.
    expect(ladderLegSpans(legs, gun, [{ tMs: 2_000, leg: 1 }], end)).toHaveLength(4);
  });

  it('mergeLadderLegLabels: identical / overlapping spans become one label (Beat 1 – Run 2)', () => {
    const legs = [{ name: 'Beat 1' }, { name: 'Run 1' }, { name: 'Beat 2' }, { name: 'Run 2' }];
    const gun = 1_000;
    const end = 5_000;
    // No roundings: every leg is the full t0–t1 span (a 45-min hole, Good Trade R2).
    const none = ladderLegSpans(legs, gun, [], end);
    expect(new Set(none.map((s) => `${s.fromMs}:${s.toMs}`)).size).toBe(1);
    expect(mergeLadderLegLabels(none).map((s) => s.name)).toEqual(['Beat 1 – Run 2']);
    // One known rounding: Beat 1 is its own span; the rest share the remainder.
    const one = mergeLadderLegLabels(ladderLegSpans(legs, gun, [{ tMs: 2_000, leg: 1 }], end));
    expect(one.map((s) => s.name)).toEqual(['Beat 1', 'Run 1 – Run 2']);
    // All roundings known: one label per leg.
    const all = mergeLadderLegLabels(ladderLegSpans(legs, gun, [{ tMs: 2_000, leg: 1 }, { tMs: 3_000, leg: 2 }, { tMs: 4_000, leg: 3 }], end));
    expect(all.map((s) => s.name)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
  });

  it('each group boat keeps one colour; the legend uses the boat name', () => {
    const group = ['USA 328', 'USA 29', 'USA 159'];
    expect(ladderBoatColor('USA 328', group)).toBe('var(--s1)');
    expect(ladderBoatColor('USA 29', group)).toBe('var(--s2)');
    expect(ladderBoatColor('USA 159', group)).toBe('var(--s3)');
    expect(ladderBoatColor('USA 328', group)).toBe(ladderBoatColor('USA 328', group));
    expect(coachLegendName({ sail: 'USA 328', name: 'Mirage' })).toBe('USA 328 Mirage');
    expect(coachLegendName({ sail: '96', name: '#96' })).toBe('96');
  });
});
