import { describe, expect, it } from 'vitest';
import { rivalLadder } from '../src/analysis/coach';
import { groupIds } from '../src/analysis/coach/groups';
import { gapSeries, type Course, type GapPoint } from '../src/analysis/coach/ladder';
import { ROUNDING_SPAN_M, legProgress, progressAt, progressTrack, timeAtProgress, timeGapSeries } from '../src/analysis/coach/timeGap';
import type { CoachTrack } from '../src/analysis/coach/tracks';
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
    // Each boat's own line, too: no break and no step near the old spike's size.
    group.forEach((_, k) => expect(maxStep(l.points, from, to, (p) => p.each[k])).toBeLessThan(40));
    // Level with the group either side of the rounding (−9 s before, −7 s after), as the race went.
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

/** A track from (t s, x m, y m) triples. */
const track = (id: string, pts: [number, number, number][], bounds: (number | null)[]): CoachTrack => ({
  id,
  t: Float64Array.from(pts, (p) => p[0] * 1000),
  x: Float64Array.from(pts, (p) => p[1]),
  y: Float64Array.from(pts, (p) => p[2]),
  bounds,
});

describe('equal course progress on a synthetic beat → run', () => {
  // Wind from the north: a 1000 m beat from the start (0, 0) to the windward mark (0, 1000), then a run back.
  const course: Course = { pts: [[0, 0], [0, 1000], [0, 0]], kinds: ['upwind', 'downwind'] };
  /**
   * A boat starting `lag` s after the gun: tacking upwind (VMG 2 m/s, ±100 m), rounding at 500 s, sailing
   * `offsetS` s across to an offset mark 60 m west (no progress), then gybing downwind (VMG 3 m/s, ±80 m).
   */
  const sail = (id: string, lag: number, offsetS: number, holes: [number, number][] = []): CoachTrack => {
    const pts: [number, number, number][] = [];
    const zig = (s: number, w: number, period: number): number => w * Math.sin((2 * Math.PI * s) / period);
    const down = 1000 / 3;
    for (let s = 0; s <= 500 + offsetS + down; s++) {
      let p: [number, number];
      if (s <= 500) p = [zig(s, 100, 100), 2 * s];
      else if (s <= 500 + offsetS) p = [(-60 * (s - 500)) / offsetS, 1000];
      else p = [-60 * Math.max(0, 1 - (s - 500 - offsetS) / 30) + zig(s - 500 - offsetS, 80, 80), 1000 - 3 * (s - 500 - offsetS)];
      const t = s + lag;
      if (!holes.some(([h0, h1]) => t > h0 && t < h1)) pts.push([t, p[0], p[1]]);
    }
    return track(id, pts, [0, (500 + lag) * 1000, (500 + offsetS + down + lag) * 1000]);
  };

  it('progress: distance made good along each rhumb line, the same up and down, monotone and continuous through the rounding', () => {
    expect(legProgress(course, 0, [70, 400])).toBeCloseTo(400, 9);
    expect(legProgress(course, 1, [-30, 400])).toBeCloseTo(600, 9);
    const pt = progressTrack(course, sail('a', 0, 20));
    for (let i = 1; i < pt.p.length; i++) {
      expect(pt.p[i]).toBeGreaterThan(pt.p[i - 1]);
      expect(pt.t[i]).toBeGreaterThan(pt.t[i - 1]);
    }
    // The beat ends at 1000 m at the boat's last fix on it (the mark at 500 s); the run starts ROUNDING_SPAN_M on,
    // as it leaves the offset mark.
    expect(timeAtProgress(pt, 1000)).toBe(499_000);
    expect(timeAtProgress(pt, 1000 + ROUNDING_SPAN_M)).toBeGreaterThanOrEqual(519_000);
    expect(timeAtProgress(pt, 1000 + ROUNDING_SPAN_M)).toBeLessThanOrEqual(521_000);
    // Linear in time across the rounding, so no step anywhere.
    expect(progressAt(pt, 510_000)! - 1000).toBeGreaterThan(0.3 * ROUNDING_SPAN_M);
    expect(progressAt(pt, 510_000)! - 1000).toBeLessThan(0.7 * ROUNDING_SPAN_M);
    expect(progressAt(pt, 700_000)).toBeCloseTo(1000 + ROUNDING_SPAN_M + 3 * (700 - 520) - 1, -1);
  });

  it('a boat 20 s behind on the same course reads +20 s on the beat, through the rounding and down the run', () => {
    const me = sail('me', 20, 20);
    const ahead = sail('r', 0, 20);
    const s = timeGapSeries(course, me, [ahead], 20_000, 870_000, 5_000);
    const vals = s.map((p) => p.behindS).filter((x): x is number => x != null);
    expect(vals.length).toBeGreaterThan(s.length - 3);
    for (const v of vals) expect(Math.abs(v - 20)).toBeLessThan(0.5);
    // And the other way round, −20 s (ahead).
    const back = timeGapSeries(course, ahead, [me], 0, 850_000, 5_000).map((p) => p.behindS).filter((x): x is number => x != null);
    for (const v of back) expect(Math.abs(v + 20)).toBeLessThan(0.5);
  });

  it('a rival slower round the mark by 30 s: the gap grows only while rounding, steadily, never overshooting', () => {
    const me = sail('me', 0, 20);
    const slow = sail('r', -10, 50); // 10 s ahead to the mark, 20 s behind once round
    const s = timeGapSeries(course, me, [slow], 0, 850_000, 5_000).filter((p) => p.behindS != null);
    for (const p of s) {
      const v = p.behindS!;
      expect(v).toBeGreaterThanOrEqual(-20 - 0.5);
      expect(v).toBeLessThanOrEqual(10 + 0.5);
      if (p.tMs <= 495_000) expect(Math.abs(v - 10)).toBeLessThan(0.5);
      if (p.tMs >= 525_000) expect(Math.abs(v + 20)).toBeLessThan(0.5);
    }
    for (let i = 1; i < s.length; i++) expect(s[i].behindS!).toBeLessThanOrEqual(s[i - 1].behindS! + 0.5);
  });

  it('missing data is a gap in that line, not a spike, and the other boats still draw', () => {
    const me = sail('me', 30, 20);
    const a = sail('a', 0, 20);
    const b = sail('b', 10, 20, [[250, 330]]); // an 80 s hole in b's beat
    const c = sail('c', 20, 20);
    const s = timeGapSeries(course, me, [a, b, c], 0, 900_000, 5_000);
    // Where me is where b was during its hole: b has no value, the median of a and c still draws.
    const mid = s.filter((p) => p.tMs >= 300_000 && p.tMs <= 340_000);
    expect(mid.every((p) => p.each[1] == null && p.each[0] != null && p.each[2] != null && p.behindS != null)).toBe(true);
    for (const p of mid) expect(p.behindS).toBeCloseTo(20, 0);
    // Every value that is there is right: a +30, b +20, c +10.
    for (const p of s) {
      if (p.each[0] != null) expect(p.each[0]).toBeCloseTo(30, 0);
      if (p.each[1] != null) expect(p.each[1]).toBeCloseTo(20, 0);
      if (p.each[2] != null) expect(p.each[2]).toBeCloseTo(10, 0);
    }
    // Before the chosen boat's first fix, and past where a rival ever got (a's track cut short), no value.
    expect(s.filter((p) => p.tMs < 30_000).every((p) => p.behindS == null && p.leg == null)).toBe(true);
    const cut = { ...a, t: a.t.filter((t) => t <= 600_000), x: a.x.slice(0, 601), y: a.y.slice(0, 601) };
    const s2 = timeGapSeries(course, me, [cut], 0, 900_000, 5_000);
    expect(s2.filter((p) => p.tMs > 700_000).every((p) => p.each[0] == null)).toBe(true);
    // A hole in the chosen boat's own track: a break in the median, with no value either side out of line.
    const holed = sail('me', 30, 20, [[600, 660]]);
    const s3 = timeGapSeries(course, holed, [a, b, c], 0, 900_000, 5_000);
    expect(s3.filter((p) => p.tMs > 605_000 && p.tMs < 655_000).every((p) => p.behindS == null)).toBe(true);
    for (const p of s3) if (p.behindS != null) expect(Math.abs(p.behindS - 20)).toBeLessThan(10.5);
  });
});
