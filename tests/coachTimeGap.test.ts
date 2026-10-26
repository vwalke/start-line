import { describe, expect, it } from 'vitest';
import { rivalLadder } from '../src/analysis/coach';
import { groupIds } from '../src/analysis/coach/groups';
import { gapSeries, GROUP_MIN_SHARE, type Course, type GapPoint } from '../src/analysis/coach/ladder';
import {
  FINISH_IN_M,
  GROUP_BRIDGE_S,
  GROUP_DRAW_HOLE_S,
  ROUNDING_IN_M,
  ROUNDING_OUT_M,
  finishLine,
  legAlong,
  legOfProgress,
  legProgress,
  legWinds,
  progressAt,
  progressTrack,
  timeAtProgress,
  timeGapSeries,
  type LegWind,
} from '../src/analysis/coach/timeGap';
import { COACH_NEAR_FIX_S, posAt, type CoachTrack } from '../src/analysis/coach/tracks';
import { boatsCount, ladderTipHtml } from '../src/ui/coach';
import { median } from '../src/analysis/geo';
import { cascaisRace, coachRace, j105Race } from './helpers';

/** The largest change between neighbouring drawn points of `pick` in [from, to], s. */
function maxStep(points: GapPoint[], from: number, to: number, pick: (p: GapPoint) => number | null = (p) => p.behindS): number {
  const w = points.filter((p) => p.tMs >= from && p.tMs <= to);
  let m = 0;
  for (let i = 1; i < w.length; i++) {
    const a = pick(w[i - 1]);
    const b = pick(w[i]);
    if (a != null && b != null) m = Math.max(m, Math.abs(b - a));
  }
  return m;
}

/**
 * The most the bold line may move between 10 s points, s. A gap grows at most 1 s per second (if you stop
 * dead: 10 s per point); it shrinks faster only while the boats in the middle of the group were slow at
 * that point of the course (a tack, a slow rounding: J/105 race 2 Beat 2, three rivals each lost ~30 s
 * over the same 20 s of the beat, 11 s per point on the median). 15 s is that with a margin, and a
 * fraction of what it guards against: a median switching boats in a split group (60–150 s), the v1
 * Run 1 steps (up to ~140 s).
 */
const MAX_STEP_S = 15;

const edt = (hhmmss: string): number => Date.parse(`2026-10-18T${hhmmss}-04:00`);

describe('rival ladder at a rounding (regression: the spike)', () => {
  // J/105 CBC 2026 race 2 (tests/fixtures/j105_r2.json, EDT): USA 517 vs Boats near me, rounding the leeward gate
  // (Run 1 → Beat 2) at 13:01:44. The boats near it rounded up to ~2 min apart either side.
  const { a, m } = coachRace(j105Race(2));
  const ME = 'USA 517';
  const tr = m.tracks.get(ME)!;
  const ids = groupIds(a.boats, ME, { kind: 'near' });
  const group = ids.map((id) => m.tracks.get(id)!);
  const r = tr.bounds[2]!;
  const from = r - 120_000;
  const to = r + 120_000;

  it('the rounding is the one named, with the whole group tracked', () => {
    expect(new Date(r).toISOString().slice(0, 19)).toBe('2026-10-18T17:01:44');
    expect(a.legs[1].name).toBe('Run 1');
    expect(a.legs[2].name).toBe('Beat 2');
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });

  it('before: the same-moment wind ladder jumps by over 100 s across it (−75 s → +82 s), each line breaking', () => {
    const old = gapSeries(m.course, m.wind, m.vmg, tr, group, a.meta.gunMs, tr.bounds[4]!, 10_000);
    expect(maxStep(old, from, to)).toBeGreaterThan(100);
    // Each group boat's own line breaks at the rounding (only boats on the same leg compare).
    const at = old.filter((p) => p.tMs >= from && p.tMs <= to);
    group.forEach((_, k) => expect(at.some((p) => p.each[k] == null)).toBe(true));
  });

  it('after: at equal progress the gap moves at most 10 s per point through it, every line unbroken', () => {
    const l = rivalLadder(m, a, ME, { kind: 'near' })!;
    expect(maxStep(l.points, from, to)).toBeLessThanOrEqual(10);
    const at = l.points.filter((p) => p.tMs >= from && p.tMs <= to);
    expect(at.every((p) => p.behindS != null && p.n === ids.length)).toBe(true);
    // Each boat's own line, too: no step near the old spike's size.
    group.forEach((_, k) => expect(maxStep(l.points, from, to, (p) => p.each[k])).toBeLessThan(40));
    // Level with the group either side of the rounding, as the race went.
    const before = at.find((p) => p.tMs >= r - 20_000)!.behindS!;
    const after = at.find((p) => p.tMs >= r + 20_000)!.behindS!;
    expect(Math.abs(after - before)).toBeLessThan(15);
  });

  it('Cascais race 3, USA 833 vs Boats near me at the second windward rounding (16:14:42 venue): no break, no jump', () => {
    const c = coachRace(cascaisRace('r3'));
    const id = c.a.boats.find((b) => b.sail === 'USA 833')!.id;
    const t3 = c.m.tracks.get(id)!;
    const k = t3.bounds[3]!;
    const near = groupIds(c.a.boats, id, { kind: 'near' }).map((x) => c.m.tracks.get(x)!);
    // Before: the boat rounds ahead of its group, so the same-leg ladder has nothing either side of the mark.
    const old = gapSeries(c.m.course, c.m.wind, c.m.vmg, t3, near, c.a.meta.gunMs, t3.bounds[4]!, 10_000);
    expect(old.filter((p) => p.tMs >= k && p.tMs <= k + 50_000).every((p) => p.behindS == null)).toBe(true);
    const l = rivalLadder(c.m, c.a, id, { kind: 'near' })!;
    const at = l.points.filter((p) => p.tMs >= k - 30_000 && p.tMs <= k + 60_000);
    expect(at.every((p) => p.behindS != null)).toBe(true);
    expect(maxStep(l.points, k - 30_000, k + 60_000)).toBeLessThanOrEqual(10);
  });
});

describe('the bold group line does not step when boats round or drop out of the data (review of v1)', () => {
  // J/105 CBC race 2, USA 517 vs Boats near me (EDT): a split group, three boats ~100 s ahead and three ~90 s behind,
  // so the median of five instead of six is a boat from one cluster or the other. In the fixture (the dev app's data
  // too) a boat is out of the tracker for minutes at a time: USA 313 for 7 min down Run 1 (12:50:29–12:57:32).
  const { a, m } = coachRace(j105Race(2));
  const ME = 'USA 517';
  const l = rivalLadder(m, a, ME, { kind: 'near' })!;
  const ids = groupIds(a.boats, ME, { kind: 'near' });
  const need = Math.ceil(GROUP_MIN_SHARE * ids.length);
  /** v1's group line: the median of whichever boats have a value at that point (here: as positions are read). */
  const v1 = (p: GapPoint): number | null => {
    const ok = p.each.filter((x): x is number => x != null);
    return ok.length >= need ? median(ok) : null;
  };
  const windows: [string, string, string][] = [
    ['Run 1 start', '12:50:00', '12:54:30'],
    ['Run 1, USA 313 back (~12:57)', '12:54:30', '12:59:30'],
    ['Beat 2, 13:13–13:18', '13:13:00', '13:18:00'],
    ['Run 2', '13:24:00', '13:30:00'],
  ];

  it.each(windows)('%s: no step over MAX_STEP_S per point, the same boats throughout, drawn', (_, f, t) => {
    const from = edt(f);
    const to = edt(t);
    expect(maxStep(l.points, from, to)).toBeLessThanOrEqual(MAX_STEP_S);
    const at = l.points.filter((p) => p.tMs >= from && p.tMs <= to);
    expect(new Set(at.map((p) => p.n))).toEqual(new Set([ids.length]));
    expect(at.filter((p) => p.behindS != null).length).toBeGreaterThanOrEqual(0.8 * at.length);
  });

  it('before: a median over whichever boats have a value jumps by over 100 s on Run 1 (−69 s → +74 s at 12:52:21 in v1)', () => {
    expect(maxStep(l.points, edt('12:50:00'), edt('12:59:30'), v1)).toBeGreaterThan(100);
    // The bold line, meanwhile: within 20 s of level all down Run 1, from when the fleet's tracking comes back after the
    // windward mark (v1: −76 s, +74 s, −5 s, +67 s, −5 s).
    const run1 = l.points.filter((p) => p.tMs >= edt('12:51:00') && p.tMs <= edt('12:59:30'));
    expect(run1.every((p) => p.behindS != null && Math.abs(p.behindS) < 20)).toBe(true);
  });

  it('USA 313 keeps its place in the median across its 7 min hole; its own thin line has no values there (the chart draws straight across)', () => {
    const k = l.group.indexOf('USA 313');
    const hole = l.points.filter((p) => p.tMs >= edt('12:52:00') && p.tMs <= edt('12:55:30'));
    expect(hole.every((p) => p.each[k] == null && p.n === ids.length)).toBe(true);
    expect(7 * 60).toBeLessThan(GROUP_BRIDGE_S);
    // Counted as estimated inside (GapPoint.est), but the readout just says the statistic and the boats.
    expect(hole.every((p) => (p.est ?? 0) >= 1)).toBe(true);
    const i = l.points.indexOf(hole.find((p) => p.behindS != null)!);
    expect(ladderTipHtml(a, m, l, { kind: 'near' }, i)).toContain('(median of 6 boats)');
    expect(ladderTipHtml(a, m, l, { kind: 'near' }, i)).not.toContain('estimated');
  });

  it('Cascais R2, USA 833 vs Boats near me at the Run 1 start (13:37:34 venue): level, no climb to +70 s', () => {
    const c = coachRace(cascaisRace('r2'));
    const id = c.a.boats.find((b) => b.sail === 'USA 833')!.id;
    const tr = c.m.tracks.get(id)!;
    const r = tr.bounds[1]!;
    const lc = rivalLadder(c.m, c.a, id, { kind: 'near' })!;
    const from = r - 40_000;
    const to = r + 120_000;
    const at = lc.points.filter((p) => p.tMs >= from && p.tMs <= to);
    expect(at.every((p) => p.behindS != null && p.n === lc.group.length)).toBe(true);
    expect(maxStep(lc.points, from, to)).toBeLessThanOrEqual(MAX_STEP_S);
    // About 25–30 s ahead from the windward mark into the run (v1: 18 s → 73 s ahead in two minutes).
    const vals = at.map((p) => p.behindS!);
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThan(15);
    expect(vals.every((v) => v < -15 && v > -40)).toBe(true);
    // The cause: the run is ~20° off the wind there (rhumb 143°, wind from ~304–310°). Along the rhumb line, USA 833's
    // gybe pointed down it and the group's didn't, so the same VMG made ~40 % more rhumb distance: a climb, not a lead.
    const rhumb = timeGapSeries(c.m.course, [], tr, lc.group.map((x) => c.m.tracks.get(x)!), c.m.gunMs, to, 10_000);
    const rv = rhumb.filter((p) => p.tMs >= from && p.tMs <= to && p.behindS != null).map((p) => p.behindS!);
    expect(Math.max(...rv) - Math.min(...rv)).toBeGreaterThan(20);
  });

  it('legWinds: one direction per leg, the fleet mean over its time on the leg', () => {
    const lw = legWinds(m.course, m.wind, m.tracks.values(), m.gunMs, m.endMs);
    expect(lw.length).toBe(a.legs.length);
    for (const x of lw) {
      expect(x.twdDeg).toBeGreaterThan(10);
      expect(x.twdDeg).toBeLessThan(30);
    }
  });
});

/** A track from (t s, x m, y m) triples. */
const track = (id: string, pts: [number, number, number][], bounds: (number | null)[]): CoachTrack => ({
  id,
  t: Float64Array.from(pts, (p) => p[0] * 1000),
  x: Float64Array.from(pts, (p) => p[1]),
  y: Float64Array.from(pts, (p) => p[2]),
  bounds,
});

/** Wind from the north on every leg (tack angle 90°: laylines 45° upwind). */
const NORTH: LegWind[] = [
  { twdDeg: 0, taDeg: 90 },
  { twdDeg: 0, taDeg: 90 },
  { twdDeg: 0, taDeg: 90 },
];

describe('equal course progress on a synthetic beat → run', () => {
  // Wind from the north: a 1000 m beat from the start (0, 0) to the windward mark (0, 1000), then a run back.
  const course: Course = { pts: [[0, 0], [0, 1000], [0, 0]], kinds: ['upwind', 'downwind'] };
  /**
   * A boat starting `lag` s after the gun: tacking upwind (VMG 2 m/s, up to ±100 m, inside the laylines), rounding at
   * 500 s, sailing `offsetS` s across to an offset mark 60 m west (no progress), then gybing downwind (VMG 3 m/s, up to
   * ±80 m, inside the laylines). `holes`: [from, to] s with no fixes.
   */
  const sail = (id: string, lag: number, offsetS: number, holes: [number, number][] = []): CoachTrack => {
    const pts: [number, number, number][] = [];
    const zig = (s: number, w: number, period: number): number => w * Math.sin((2 * Math.PI * s) / period);
    const down = 1000 / 3;
    for (let s = 0; s <= 500 + offsetS + down; s++) {
      let p: [number, number];
      if (s <= 500) p = [zig(s, 100 * Math.min(1, (1000 - 2 * s) / 200), 100), 2 * s];
      else if (s <= 500 + offsetS) p = [(-60 * (s - 500)) / offsetS, 1000];
      else {
        const y = 1000 - 3 * (s - 500 - offsetS);
        p = [-60 * Math.max(0, 1 - (s - 500 - offsetS) / 30) + zig(s - 500 - offsetS, 80 * Math.min(1, y / 300), 80), y];
      }
      const t = s + lag;
      if (!holes.some(([h0, h1]) => t > h0 && t < h1)) pts.push([t, p[0], p[1]]);
    }
    return track(id, pts, [0, (500 + lag) * 1000, (500 + offsetS + down + lag) * 1000]);
  };

  it('progress: up the wind ladder, the same up and down, monotone and continuous through the rounding zone', () => {
    // Inside the laylines, with the wind down the rhumb line, the ladder is the distance made good.
    expect(legAlong(course, NORTH, 0, [70, 400])).toBeCloseTo(400, 9);
    expect(legAlong(course, NORTH, 1, [-30, 400])).toBeCloseTo(600, 9);
    expect(legProgress(course, 1, [-30, 400])).toBeCloseTo(600, 9);
    const pt = progressTrack(course, NORTH, sail('a', 0, 20));
    for (let i = 1; i < pt.p.length; i++) {
      expect(pt.p[i]).toBeGreaterThan(pt.p[i - 1]);
      expect(pt.t[i]).toBeGreaterThan(pt.t[i - 1]);
    }
    // The zone: from ROUNDING_IN_M short of the mark (y = 970 at 485 s) to ROUNDING_OUT_M down the run, after the
    // offset mark (30 m at 3 m/s from 520 s: 530 s), linear in time between.
    expect(timeAtProgress(pt, 1000 - ROUNDING_IN_M)).toBe(485_000);
    expect(timeAtProgress(pt, 1000 + ROUNDING_OUT_M)).toBeCloseTo(530_000, -3);
    const mid = progressAt(pt, 510_000)!;
    expect(mid).toBeCloseTo(970 + (60 * 25) / 45, 0);
    expect(progressAt(pt, 700_000)).toBeCloseTo(1000 + 3 * (700 - 520), -1);
  });

  it('a boat 20 s behind on the same course reads +20 s on the beat, through the rounding and down the run', () => {
    const me = sail('me', 20, 20);
    const ahead = sail('r', 0, 20);
    const s = timeGapSeries(course, NORTH, me, [ahead], 20_000, 870_000, 5_000);
    const vals = s.map((p) => p.behindS).filter((x): x is number => x != null);
    expect(vals.length).toBeGreaterThan(s.length - 3);
    for (const v of vals) expect(Math.abs(v - 20)).toBeLessThan(0.5);
    // And the other way round, −20 s (ahead).
    const back = timeGapSeries(course, NORTH, ahead, [me], 0, 850_000, 5_000).map((p) => p.behindS).filter((x): x is number => x != null);
    for (const v of back) expect(Math.abs(v + 20)).toBeLessThan(0.5);
  });

  it('a rival slower round the mark by 30 s: the gap grows only while rounding, steadily, never overshooting', () => {
    const me = sail('me', 0, 20);
    const slow = sail('r', -10, 50); // 10 s ahead to the mark, 20 s behind once round
    const s = timeGapSeries(course, NORTH, me, [slow], 0, 850_000, 5_000).filter((p) => p.behindS != null);
    for (const p of s) {
      const v = p.behindS!;
      expect(v).toBeGreaterThanOrEqual(-20 - 0.5);
      expect(v).toBeLessThanOrEqual(10 + 0.5);
      if (p.tMs <= 480_000) expect(Math.abs(v - 10)).toBeLessThan(0.5);
      if (p.tMs >= 535_000) expect(Math.abs(v + 20)).toBeLessThan(0.5);
    }
    for (let i = 1; i < s.length; i++) expect(s[i].behindS!).toBeLessThanOrEqual(s[i - 1].behindS! + 0.5);
  });

  it('missing data: a gap in that boat\'s thin line, while the bold line carries on over the same boats', () => {
    const me = sail('me', 30, 20);
    const a = sail('a', 0, 20);
    const b = sail('b', 10, 20, [[250, 330]]); // an 80 s hole in b's beat
    const c = sail('c', 20, 20);
    const s = timeGapSeries(course, NORTH, me, [a, b, c], 0, 900_000, 5_000);
    // Where me is where b was during its hole: b's thin line has no value; the median keeps b (read across its hole).
    const mid = s.filter((p) => p.tMs >= 300_000 && p.tMs <= 340_000);
    expect(mid.every((p) => p.each[1] == null && p.each[0] != null && p.each[2] != null && p.n === 3)).toBe(true);
    for (const p of mid) expect(p.behindS).toBeCloseTo(20, 0);
    // Every value that is there is right: a +30, b +20, c +10.
    for (const p of s) {
      if (p.each[0] != null) expect(p.each[0]).toBeCloseTo(30, 0);
      if (p.each[1] != null) expect(p.each[1]).toBeCloseTo(20, 0);
      if (p.each[2] != null) expect(p.each[2]).toBeCloseTo(10, 0);
      if (p.behindS != null) expect(p.behindS).toBeCloseTo(20, 0);
    }
    // Before the chosen boat's first fix, and past where a rival ever got (a's track cut short), no value.
    expect(s.filter((p) => p.tMs < 30_000).every((p) => p.behindS == null && p.leg == null)).toBe(true);
    const cut = { ...a, t: a.t.filter((t) => t <= 600_000), x: a.x.slice(0, 601), y: a.y.slice(0, 601) };
    const s2 = timeGapSeries(course, NORTH, me, [cut], 0, 900_000, 5_000);
    expect(s2.filter((p) => p.tMs > 700_000).every((p) => p.each[0] == null && p.behindS == null)).toBe(true);
    // A hole in the chosen boat's own track over GROUP_DRAW_HOLE_S: a break in the bold line, nothing out of line either side.
    const holed = sail('me', 30, 20, [[600, 660]]);
    const s3 = timeGapSeries(course, NORTH, holed, [a, b, c], 0, 900_000, 5_000);
    expect(s3.filter((p) => p.tMs > 605_000 && p.tMs < 655_000).every((p) => p.behindS == null)).toBe(true);
    for (const p of s3) if (p.behindS != null) expect(Math.abs(p.behindS - 20)).toBeLessThan(0.6);
    // A shorter one (20 s): read across, no break.
    const short = sail('me', 30, 20, [[600, 620]]);
    const s4 = timeGapSeries(course, NORTH, short, [a, b, c], 0, 900_000, 5_000);
    expect(s4.filter((p) => p.tMs >= 580_000 && p.tMs <= 640_000).every((p) => p.behindS != null && Math.abs(p.behindS - 20) < 0.6)).toBe(true);
  });

  it('a split group: a boat in a long hole keeps the bold line level; a median over whoever has a value would step', () => {
    // Three boats 60–70 s ahead of me, three 60–70 s behind: the median of all six is ~0.
    const me = sail('me', 100, 20);
    const lags = [30, 35, 40, 160, 165, 170];
    // The boat 60 s ahead (lag 40) is out of the tracker for 5 min of its beat.
    const group = lags.map((lag, k) => sail(`r${k}`, lag, 20, k === 2 ? [[150, 450]] : []));
    const s = timeGapSeries(course, NORTH, me, group, 0, 1000_000, 10_000);
    const on = s.filter((p) => p.tMs >= 150_000 && p.tMs <= 800_000);
    expect(on.every((p) => p.behindS != null && Math.abs(p.behindS) <= 0.6 && p.n === 6)).toBe(true);
    const v1 = (p: GapPoint): number | null => {
      const ok = p.each.filter((x): x is number => x != null);
      return ok.length >= 3 ? median(ok) : null;
    };
    expect(maxStep(s, 150_000, 800_000, v1)).toBeGreaterThan(50);
    expect(maxStep(s, 150_000, 800_000)).toBeLessThan(1);
  });

  it('where the set of boats must change (a track ends), the bold line breaks for a point rather than step', () => {
    const me = sail('me', 100, 20);
    const lags = [30, 40, 160, 170];
    const group = lags.map((lag, k) => sail(`r${k}`, lag, 20));
    // r3 (70 s behind) stops being tracked after 400 s of its race: it never gets as far as me after ~330 s.
    const r3 = group[3];
    const n = r3.t.findIndex((t) => t > 400_000 + 170_000);
    group[3] = { ...r3, t: r3.t.slice(0, n), x: r3.x.slice(0, n), y: r3.y.slice(0, n) };
    const s = timeGapSeries(course, NORTH, me, group, 100_000, 900_000, 10_000);
    const firstOut = s.findIndex((p) => p.n === 3);
    expect(firstOut).toBeGreaterThan(0);
    expect(s[firstOut - 1].n).toBe(4);
    expect(s[firstOut - 1].behindS).not.toBeNull();
    expect(s[firstOut].behindS).toBeNull();
    expect(s[firstOut + 1].behindS).not.toBeNull();
  });
});

describe('review fixes (v1 timeGap.ts)', () => {
  const course: Course = { pts: [[0, 0], [0, 1000], [0, 0]], kinds: ['upwind', 'downwind'] };
  /** Straight up the rhumb line at 2 m/s from `y0` (fixes every `dt` s), round at the top, straight down at 3 m/s. */
  const straight = (id: string, opts: { y0?: number; dt?: number; top?: number; holes?: [number, number][] } = {}): CoachTrack => {
    const { y0 = 0, dt = 1, top = 1000, holes = [] } = opts;
    const pts: [number, number, number][] = [];
    const up = (top - y0) / 2;
    for (let s = 0; s <= up + 300; s += dt) {
      if (holes.some(([h0, h1]) => s > h0 && s < h1)) continue;
      pts.push([s, 0, s <= up ? y0 + 2 * s : top - 3 * (s - up)]);
    }
    return track(id, pts, [0, up * 1000, null]);
  };

  it('1. one progress scale for every boat on a leg: no stretching to the mark, no fallback to the full range', () => {
    // A boat that turns 20 m short of the mark (in v1 its beat was stretched to the full 1000 m, or, under half the
    // rhumb line, snapped to the full range): its progress is where it is, the same as any other boat there.
    const short = progressTrack(course, NORTH, straight('s', { top: 980 }));
    const full = progressTrack(course, NORTH, straight('f'));
    for (const y of [100, 400, 900, 950]) expect(timeAtProgress(short, y)).toBe(timeAtProgress(full, y));
    // A boat with a hole across its rounding, and one whose beat starts halfway up (its fixes cover under half the
    // rhumb line): the same progress at the same place as the boat with every fix.
    const holed = progressTrack(course, NORTH, straight('h', { holes: [[480, 520]] }));
    const half = progressTrack(course, NORTH, straight('half', { y0: 600 }));
    expect(timeAtProgress(holed, 1100)).toBe(timeAtProgress(full, 1100));
    expect(timeAtProgress(holed, 1500)).toBe(timeAtProgress(full, 1500));
    expect(progressAt(half, 50_000)).toBe(700);
    expect(progressAt(full, 350_000)).toBe(700);
  });

  it('2. the near-fix rule: as positions are read, only within COACH_NEAR_FIX_S of a fix; the group line reads further, by name', () => {
    const pt = progressTrack(course, NORTH, straight('d', { dt: 14 }));
    // Fixes 14 s apart (under COACH_MAX_SPAN_S): 7 s from either is past COACH_NEAR_FIX_S.
    expect(14 / 2).toBeGreaterThan(COACH_NEAR_FIX_S);
    expect(progressAt(pt, 7_000)).toBeNull();
    expect(progressAt(pt, 4_000)).toBeCloseTo(8, 9);
    expect(progressAt(pt, 7_000, GROUP_DRAW_HOLE_S)).toBeCloseTo(14, 9);
    expect(timeAtProgress(pt, 14)).toBeNull();
    expect(timeAtProgress(pt, 14, GROUP_DRAW_HOLE_S)).toBeCloseTo(7_000, 6);
    // Across a 40 s hole: not as positions, not for drawing the group line; for keeping its boats, yes.
    const holed = progressTrack(course, NORTH, straight('h', { holes: [[100, 140]] }));
    expect(progressAt(holed, 120_000)).toBeNull();
    expect(progressAt(holed, 120_000, GROUP_DRAW_HOLE_S)).toBeNull();
    expect(progressAt(holed, 120_000, GROUP_BRIDGE_S)).toBeCloseTo(240, 6);
  });

  it('3. a leg of no length (two marks in one place) gives no NaN and no records, and the gap reads through it', () => {
    const c3: Course = { pts: [[0, 0], [0, 1000], [0, 1000], [0, 0]], kinds: ['upwind', 'reach', 'downwind'] };
    expect(legAlong(c3, NORTH, 1, [5, 1000])).toBe(0);
    expect(legProgress(c3, 1, [5, 1000])).toBe(0);
    const boat = (id: string, lag: number): CoachTrack => {
      const pts: [number, number, number][] = [];
      for (let s = 0; s <= 840; s++) pts.push([s + lag, 0, s <= 500 ? 2 * s : s <= 505 ? 1000 : 1000 - 3 * (s - 505)]);
      return track(id, pts, [0, (500 + lag) * 1000, (505 + lag) * 1000, (838 + lag) * 1000]);
    };
    const pt = progressTrack(c3, NORTH, boat('a', 0));
    expect(pt.p.every(Number.isFinite) && pt.t.every(Number.isFinite)).toBe(true);
    const s = timeGapSeries(c3, NORTH, boat('me', 20), [boat('a', 0)], 0, 860_000, 5_000);
    const vals = s.map((p) => p.behindS).filter((x): x is number => x != null);
    expect(vals.length).toBeGreaterThan(150);
    for (const v of vals) expect(Math.abs(v - 20)).toBeLessThan(0.5);
  });

  it('4. before the start line there is no progress (no negative values): it starts where the boat crosses it', () => {
    // 50 m behind the line at the gun, crossing at 25 s.
    const pt = progressTrack(course, NORTH, straight('pre', { y0: -50 }));
    expect(Math.min(...pt.p)).toBe(0);
    expect(pt.t[0]).toBe(25_000);
    expect(progressAt(pt, 10_000)).toBeNull();
    expect(progressAt(pt, 30_000)).toBeCloseTo(10, 9);
    // A boat on the line at the gun, compared: nothing before this one crossed, then +25 s.
    const s = timeGapSeries(course, NORTH, straight('pre', { y0: -50 }), [straight('ok')], 0, 200_000, 5_000);
    expect(s.filter((p) => p.tMs < 25_000).every((p) => p.behindS == null && p.leg == null)).toBe(true);
    for (const p of s) if (p.behindS != null) expect(p.behindS).toBeCloseTo(25, 6);
  });

  it('5. a point inside the rounding zone is labelled the leg it ends, after the timed rounding too', () => {
    expect(legOfProgress(course, 1000 - ROUNDING_IN_M + 1)).toBe(0);
    expect(legOfProgress(course, 1000 + ROUNDING_OUT_M - 1)).toBe(0);
    expect(legOfProgress(course, 1000 + ROUNDING_OUT_M)).toBe(1);
    // Rounding (the leg bounds) at 500 s; 30 m down the run at 510 s.
    const me = straight('me');
    const s = timeGapSeries(course, NORTH, me, [straight('a')], 0, 800_000, 1_000);
    const at = (sec: number): GapPoint => s.find((p) => p.tMs === sec * 1000)!;
    expect(at(495).leg).toBe(0);
    expect(at(505).leg).toBe(0);
    expect(at(512).leg).toBe(1);
  });
});

describe('review fixes (#52: thin lines at the zone edges, holes, estimated boats)', () => {
  const course: Course = { pts: [[0, 0], [0, 1000], [0, 0]], kinds: ['upwind', 'downwind'] };
  /** Straight up the rhumb line at 2 m/s from `y0`, round at 1000 m, straight down at 3 m/s; a fix every `dt` s from `t0`. */
  const sparse = (id: string, o: { y0?: number; dt: number; t0?: number }): CoachTrack => {
    const { y0 = 0, dt, t0 = 0 } = o;
    const up = (1000 - y0) / 2;
    const pts: [number, number, number][] = [];
    for (let s = t0; s <= up + 300; s += dt) pts.push([s, 0, s <= up ? y0 + 2 * s : 1000 - 3 * (s - up)]);
    return track(id, pts, [0, up * 1000, null]);
  };

  it('4. a ~10 s track (a fix every 11 s) keeps every thin-line point through the rounding zone and at its edges', () => {
    const me = sparse('me', { dt: 11, t0: 0.5 });
    const r = sparse('r', { y0: 40, dt: 11, t0: 3 }); // 20 s ahead
    const s = timeGapSeries(course, NORTH, me, [r], 0, 700_000, 5_000);
    const pm = progressTrack(course, NORTH, me);
    const pr = progressTrack(course, NORTH, r);
    // Our points from the approach to the zone (one fix short of its edge) to one fix past the way out of it.
    const zone = s.filter((p) => {
      const q = progressAt(pm, p.tMs, GROUP_DRAW_HOLE_S)!;
      return q >= 1000 - ROUNDING_IN_M - 22 && q <= 1000 + ROUNDING_OUT_M + 33;
    });
    expect(zone.length).toBeGreaterThanOrEqual(8);
    for (const p of zone) expect(p.each[0]).toBeCloseTo(20, 0);
    // Read as positions are (tracks.ts posAt: within COACH_NEAR_FIX_S of a fix), some of those points have no position,
    // ours or the rival's where it got that far: v1 dropped them. The stretches there are linear in time by construction.
    const posOld = zone.filter((p) => {
      const t = timeAtProgress(pr, progressAt(pm, p.tMs, GROUP_DRAW_HOLE_S)!, GROUP_DRAW_HOLE_S)!;
      return !posAt(me, p.tMs) || !posAt(r, t);
    });
    expect(posOld.length).toBeGreaterThan(0);
    // Away from the zone, between two fixes, the position rule still holds: a point 5.5 s from both fixes has none.
    const mid = s.find((p) => p.tMs === 105_000)!; // me's fixes at 99.5 and 110.5 s
    expect(posAt(me, mid.tMs)).toBeNull();
    expect(mid.each[0]).toBeNull();
  });

  it('5. a gap between fixes that made no progress (a tack back) is not a hole in the records', () => {
    // Up at 2 m/s to 400 m (200 s), back down for 10 s, then a 20 s gap (both ends short of 400 m), then up again.
    const pts: [number, number, number][] = [];
    for (let s = 0; s <= 200; s += 2) pts.push([s, 0, 2 * s]);
    for (let s = 202; s <= 210; s += 2) pts.push([s, 0, 400 - 2 * (s - 200)]);
    for (let s = 230; s <= 300; s += 2) pts.push([s, 0, 380 + 2 * (s - 230)]);
    const pt = progressTrack(course, NORTH, track('tack', pts, [0, null, null]));
    // The record after the dip (404 m at 242 s): the longest gap that counts is 2 s, not the 20 s at the tack back.
    const k = pt.p.findIndex((p) => p > 400);
    expect(pt.t[k]).toBe(242_000);
    expect(pt.p[k]).toBeCloseTo(404, 6);
    expect(pt.holeS[k]).toBe(2);
    // So the dense stretch either side reads as positions are (v1: none from 200 s to 242 s).
    expect(progressAt(pt, 206_000)).not.toBeNull();
    expect(progressAt(pt, 240_000)).not.toBeNull();
    // Inside the 20 s gap itself, the near-fix rule still has no position.
    expect(progressAt(pt, 220_000)).toBeNull();
  });

  it('5. an overstand past the zone, then a gap: the zone edge is crossed at the fix before it, the gap after it is not before it', () => {
    // A reach to (0, 1000), 40 m past the mark at 520 s (a fix every 2 s), a 20 s gap, then 60 m down the next reach.
    const reach: Course = { pts: [[0, 0], [0, 1000], [1000, 1000]], kinds: ['reach', 'reach'] };
    const pts: [number, number, number][] = [];
    for (let s = 0; s <= 520; s += 2) pts.push([s, 0, 2 * s]);
    for (let s = 540; s <= 700; s += 2) pts.push([s, 60 + 2 * (s - 540), 1000]);
    const pt = progressTrack(reach, NORTH, track('over', pts, [0, 540_000, null]));
    const k = pt.p.findIndex((p) => Math.abs(p - (1000 + ROUNDING_OUT_M)) < 1e-6);
    expect(pt.t[k]).toBe(520_000);
    expect(pt.holeS[k]).toBe(2);
    // The zone, crossed from 485 s (970 m) to 520 s on fixes 2 s apart, reads; the 20 s gap after it doesn't.
    expect(progressAt(pt, 500_000)).not.toBeNull();
    expect(progressAt(pt, 530_000)).toBeNull();
    expect(progressAt(pt, 530_000, GROUP_DRAW_HOLE_S)).not.toBeNull();
  });

  it('2. the bold line counts the boats read across a hole as estimated inside (the readout: just "median of 6 boats")', () => {
    const me = sparse('me', { dt: 1 });
    const lags = [30, 35, 40, -30, -35, -40];
    const group = lags.map((lag, k) => {
      const pts: [number, number, number][] = [];
      for (let s = 0; s <= 800; s++) if (k !== 2 || s < 150 || s > 450) pts.push([s + lag, 0, s <= 500 ? 2 * s : 1000 - 3 * (s - 500)]);
      return track(`r${k}`, pts, [lag * 1000, (500 + lag) * 1000, null]);
    });
    const s = timeGapSeries(course, NORTH, me, group, 0, 700_000, 10_000);
    // r2 (40 s behind) is out of the tracker from 190 s to 490 s: me got where it was then from 150 s to 450 s.
    const inHole = s.filter((p) => p.tMs >= 160_000 && p.tMs <= 440_000);
    expect(inHole.every((p) => p.n === 6 && p.est === 1 && p.each[2] == null && p.behindS != null)).toBe(true);
    expect(boatsCount(inHole[0])).toBe('median of 6 boats');
    const clear = s.filter((p) => p.tMs >= 600_000 && p.tMs <= 650_000);
    expect(clear.every((p) => p.est === 0)).toBe(true);
    expect(boatsCount(clear[0])).toBe('median of 6 boats');
    expect(boatsCount({ n: 1 })).toBe('mean of 1 boat');
  });
});

describe('the finish: anchored to the finish times, measured to the line the finishers crossed', () => {
  // A 1000 m beat north from (0, 0), a run back. The feed's finish line is 100–200 m east of the run's rhumb line at
  // y = 0; the boats finish 60 m further down, at y = −60, each in its own lane (x = −40 … 40). Up at 2 m/s, down at
  // 3 m/s; `me` 20 s behind at the top and slower (2 m/s) over its last 90 m. The trackers stop 3 s before the finish.
  const course: Course = { pts: [[0, 0], [0, 1000], [150, 0]], kinds: ['upwind', 'downwind'], finish: { left: [100, 0], right: [200, 0] } };
  const L = Math.hypot(150, 1000);
  const total = 1000 + L;
  const boat = (id: string, x: number, lag: number, slowLast = false): { tr: CoachTrack; fin: number } => {
    const pts: [number, number, number][] = [];
    const down = (s: number): number => (slowLast && s > 970 / 3 ? 1000 - 970 - 2 * (s - 970 / 3) : 1000 - 3 * s);
    const runS = slowLast ? 970 / 3 + 90 / 2 : 1060 / 3;
    for (let s = 0; s <= 500 + runS - 3; s++) pts.push([s + lag, x, s <= 500 ? 2 * s : down(s - 500)]);
    const fin = (lag + 500 + runS) * 1000;
    return { tr: track(id, pts, [lag * 1000, (500 + lag) * 1000, fin]), fin };
  };
  const me = boat('me', 0, 20, true);
  const rivals = [boat('a', -40, 0), boat('b', -20, 5), boat('c', 20, 10), boat('d', 40, 30)];
  const all = [me, ...rivals];

  it('finishLine: through where the finishers were at their finish times, not the feed\'s line', () => {
    const f = finishLine(course, all.map((b) => b.tr))!;
    for (const p of [f.left, f.right]) expect(p[1]).toBeCloseTo(-60, 6);
    expect(Math.abs(f.right[0] - f.left[0])).toBeCloseTo(80, 6);
    // Under FINISH_FIT_MIN finishers: the feed's.
    expect(finishLine(course, all.slice(0, 4).map((b) => b.tr))).toBe(course.finish);
  });

  it('at the chosen boat\'s finish, its gap to each finisher is the difference of their finish times', () => {
    const c = { ...course, finish: finishLine(course, all.map((b) => b.tr)) };
    const [p] = timeGapSeries(c, NORTH, me.tr, rivals.map((r) => r.tr), me.fin, me.fin);
    rivals.forEach((r, k) => expect(p.each[k]).toBeCloseTo((me.fin - r.fin) / 1000, 6));
    // The last FINISH_IN_M are crossed linearly in time, from FINISH_IN_M short of the line the boats crossed to the
    // finish (the run's 1060 m down the wind scaled to its rhumb length L: 30 m of progress is 30 · 1060 / L m of water).
    const pt = progressTrack(c, NORTH, rivals[0].tr);
    expect(pt.p.at(-1)).toBe(total);
    expect(pt.t.at(-1)).toBe(rivals[0].fin);
    expect(timeAtProgress(pt, total - FINISH_IN_M)! / 1000).toBeCloseTo(500 + (1060 - (FINISH_IN_M * 1060) / L) / 3, 6);
  });

  it('the last leg is measured to the finish line extended: a boat level with it is there', () => {
    // Level with the feed's line, 100 m past its west end: the leg's end (to the nearest end, on the run's layline,
    // 87 m short of it).
    expect(legAlong(course, NORTH, 1, [0, 0])).toBeCloseTo(L, 6);
  });

  it('a fix past the line before the finish time does not end the course early', () => {
    // The finish time 2 s after the boat crossed (the official time late, or the line a little further on).
    const c: Course = { ...course, finish: { left: [-50, -60], right: [50, -60] } };
    const pts: [number, number, number][] = [];
    for (let s = 0; s <= 500 + 1066 / 3; s++) pts.push([s, 0, s <= 500 ? 2 * s : 1000 - 3 * (s - 500)]);
    const fin = (500 + 1060 / 3 + 2) * 1000;
    const pt = progressTrack(c, NORTH, track('late', pts, [0, 500_000, fin]));
    expect(pt.p.filter((p) => p >= total)).toHaveLength(1);
    expect(pt.t.at(-1)).toBe(fin);
    expect(pt.p.at(-2)).toBe(total - FINISH_IN_M);
  });
});
