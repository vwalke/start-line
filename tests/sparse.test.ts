import { describe, expect, it } from 'vitest';
import { MS_TO_KN } from '../src/analysis/geo';
import { EDGE_GAP_MS, HIDE_FRAC, HIDE_SLOW_X, checkBounds, legMedians } from '../src/analysis/legs';
import { HDG_BAD_DEG, HDG_MIN_FIXES, cogHeading, cogSeries, headingCheck } from '../src/analysis/manoeuvres';
import { FINISH_MIN_DIST_FRAC, FINISH_MIN_REACH_FRAC, trackEvidence, trackExplainsDistance } from '../src/data/racesense/adapter';

/** Sparse trackers: the pure helpers behind the finish, leg and heading fixes. */

/** A boat sailing north at `v` m/s with a fix every second of [0, endS] except inside the `holes` (open intervals, s). */
function north(endS: number, holes: [number, number][] = [], v = 3) {
  const ts: number[] = [];
  for (let s = 0; s <= endS; s++) if (!holes.some(([a, b]) => s > a && s < b)) ts.push(s * 1000);
  return {
    t: Float64Array.from(ts),
    x: Float64Array.from(ts, () => 0),
    y: Float64Array.from(ts, (t) => (v * t) / 1000),
    sog: Float64Array.from(ts, () => v * MS_TO_KN),
  };
}

describe('checkBounds: leg boundaries a telemetry hole leaves in doubt', () => {
  const meds = [600_000, 600_000, 600_000, 600_000];
  const tt = [0, 600_000, 1_200_000, 1_800_000, 2_400_000];

  it('leaves a clean track alone', () => {
    expect(checkBounds(north(2400), tt, meds)).toEqual({ tt, gapS: [null, null, null, null, null] });
  });

  it('keeps a rounding interpolated inside a hole, approximate (~ the hole)', () => {
    const c = checkBounds(north(2400, [[500, 620]]), [0, 560_000, 1_200_000, 1_800_000, 2_400_000], meds);
    expect(c.tt[1]).toBe(560_000);
    expect(c.gapS[1]).toBe(120);
  });

  it('keeps one at the fix next to a short hole (≤ EDGE_GAP_MS), approximate', () => {
    const c = checkBounds(north(2400, [[600, 630]]), tt, meds);
    expect(EDGE_GAP_MS).toBe(60_000);
    expect(c.tt).toEqual(tt);
    expect(c.gapS[1]).toBe(30);
  });

  it('keeps one at the fix beside a longer hole when that fix is within a minute’s sail of the mark', () => {
    // The fix at 600 s is at y = 1800 m; at 3 m/s a minute's sail is 180 m.
    const near = checkBounds(north(2400, [[600, 900]]), tt, meds, [[[0, 1850]]]);
    expect(near.tt).toEqual(tt);
    expect(near.gapS[1]).toBe(300);
  });

  it(`re-times one further off across a hole too short to hide a leg (≤ ${HIDE_FRAC}× the quickest median), by distance to the mark in and out`, () => {
    // Fixes at 600 s (y 1800) and 900 s (y 2700); the mark at y 2300: 500 m in, 400 m out → 600 + 300 × 5/9 s.
    const c = checkBounds(north(2400, [[600, 900]]), tt, meds, [[[0, 2300]]]);
    expect(c.tt[1]).toBeCloseTo(600_000 + (300_000 * 500) / 900, 6);
    expect(c.tt.slice(2)).toEqual(tt.slice(2));
    expect(c.gapS[1]).toBe(300);
    // No mark known: unknown.
    expect(checkBounds(north(2400, [[600, 900]]), tt, meds).tt[1]).toBeNull();
  });

  it('leaves one beside a hole long enough to hide a leg unknown', () => {
    // 500 s > 0.75 × 600 s.
    const c = checkBounds(north(2400, [[600, 1100]]), tt, meds, [[[0, 2300]]]);
    expect(c.tt).toEqual([0, null, 1_200_000, 1_800_000, 2_400_000]);
  });

  it(`a leg over ${HIDE_SLOW_X}× the median with a hole that could hide a leg (${HIDE_FRAC}× the quickest) loses its end and every rounding after; the finish stays`, () => {
    const tr = north(4200, [[700, 2900]]);
    const c = checkBounds(tr, [0, 600_000, 3_000_000, 3_600_000, 4_200_000], meds);
    expect(c.tt).toEqual([0, 600_000, null, null, 4_200_000]);
  });

  it('a slow leg with only short holes, or a normal one with a long hole, is kept', () => {
    expect(checkBounds(north(3000, [[700, 800]]), [0, 600_000, 1_900_000, 2_500_000, 3_000_000], meds).tt[2]).toBe(1_900_000);
    expect(checkBounds(north(2400, [[650, 1150]]), tt, meds).tt).toEqual(tt);
  });
});

describe('legMedians', () => {
  it('is the median time per leg over the boats that sailed it', () => {
    expect(legMedians([[0, 10, 30], [0, 20, null], [0, 30, 70]])).toEqual([20, 30]);
    expect(legMedians([[0, null, null]])).toEqual([NaN, NaN]);
  });
});

describe('headingCheck: a compass far off the GPS course', () => {
  /** North at 6 kn (or `kn`), one fix a second, the device heading `hdg`. */
  const sailing = (n: number, hdg: number, kn = 6) => {
    const tr = north(n - 1, [], kn / MS_TO_KN);
    return { ...tr, heading: Float64Array.from(tr.t, () => hdg) };
  };

  it('keeps a good compass, leeway and all', () => {
    expect(headingCheck(sailing(120, 0))).toEqual({ source: 'device', offDeg: 0 });
    expect(headingCheck(sailing(120, 355))).toMatchObject({ source: 'device', offDeg: 5 });
    expect(headingCheck(sailing(120, HDG_BAD_DEG))).toMatchObject({ source: 'device' });
  });

  it('switches to the course over ground when the median disagreement is over HDG_BAD_DEG', () => {
    expect(headingCheck(sailing(120, 115))).toEqual({ source: 'cog', offDeg: 115 });
    expect(headingCheck(sailing(120, 360 - HDG_BAD_DEG - 1))).toMatchObject({ source: 'cog', offDeg: HDG_BAD_DEG + 1 });
  });

  it('needs HDG_MIN_FIXES fixes at speed to judge', () => {
    expect(headingCheck(sailing(HDG_MIN_FIXES - 5, 115))).toEqual({ source: 'device', offDeg: null });
    expect(headingCheck(sailing(120, 115, 1))).toEqual({ source: 'device', offDeg: null });
  });

  it('cogHeading is the course over ground, a fix with no window taking its neighbour’s', () => {
    // One isolated fix after a long gap has no COG window of its own.
    const tr = { t: Float64Array.of(0, 1000, 2000, 60_000), x: Float64Array.of(0, 1, 2, 2), y: Float64Array.of(0, 0, 0, 50) };
    expect(Number.isNaN(cogSeries(tr).cog[3])).toBe(true);
    expect(Array.from(cogHeading(tr))).toEqual([90, 90, 90, 90]);
  });
});

describe('trackEvidence / trackExplainsDistance: a device distance counter that skipped dropouts', () => {
  const from = { lat: 38.9, lon: -76.4 };
  /** A fix a second heading north ~1.1 m apart, from the gun at 0 to `endS`, minus the holes. */
  const rows = (endS: number, holes: [number, number][] = []) =>
    Array.from(north(endS, holes).t, (t) => ({ ts: t, lat: from.lat + (t / 1000) * 1e-5, lon: from.lon }));

  it('measures the path (holes bridged straight), the time in holes and the reach from the line', () => {
    const ev = trackEvidence(rows(1000, [[100, 700]]), 0, 1_100_000, from)!;
    expect(ev.holeMs).toBe(600_000 + 100_000);
    expect(ev.pathM).toBeCloseTo(1000 * 1.112, 0);
    expect(ev.reachM).toBeCloseTo(ev.pathM, 0);
    expect(trackEvidence([], 0, 1000, from)).toBeNull();
  });

  const medDist = 13_000;
  const raceMs = 4_000_000;
  it('excuses a short count when the holes make it up and the boat went as far as the fleet', () => {
    // Good Trade, race 2: 1.1 km counted, a 45 min hole of a 68 min race, 2.3 km up the course.
    const gt = { pathM: 4_000, holeMs: 2_900_000, reachM: 2_300 };
    expect(trackExplainsDistance(gt, 1_091, raceMs, medDist, 2_500)).toBe(true);
  });

  it(`but not a committee boat (under ${FINISH_MIN_REACH_FRAC} of the fleet's reach), nor a full track (no holes)`, () => {
    expect(trackExplainsDistance({ pathM: 1_500, holeMs: 2_900_000, reachM: 300 }, 1_091, raceMs, medDist, 2_500)).toBe(false);
    expect(trackExplainsDistance({ pathM: 13_000, holeMs: 0, reachM: 2_500 }, 1_200, raceMs, medDist, 2_500)).toBe(false);
    // Holes that can't make up FINISH_MIN_DIST_FRAC of the fleet's distance.
    const short = FINISH_MIN_DIST_FRAC * medDist - 1_091 - 1;
    expect(trackExplainsDistance({ pathM: 4_000, holeMs: (short * raceMs) / medDist, reachM: 2_300 }, 1_091, raceMs, medDist, 2_500)).toBe(false);
    expect(trackExplainsDistance({ pathM: 4_000, holeMs: 2_900_000, reachM: 2_300 }, 1_091, raceMs, medDist, null)).toBe(false);
  });
});
