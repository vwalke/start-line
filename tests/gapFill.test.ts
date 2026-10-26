import { describe, expect, it } from 'vitest';
import { FILL_STEP_MS, fillGap, fillTrack, type FillInput, type FilledTrack } from '../src/ui/gapFill';

/**
 * Tracker gaps filled in for display (ui/gapFill.ts): every one, at any length; the curve between the two fixes (their
 * velocities from the neighboring steps and SOG, else Catmull-Rom, never swinging wide), and the filled track.
 */
const KN = 3600 / 1852;
/** `n` fixes 1 s apart from `t0` (ms), along `dir` (unit, x east / y north) at `v` m/s from `p0`, SOG to match. */
function line(n: number, t0: number, p0: [number, number], dir: [number, number], v: number): { t: number[]; x: number[]; y: number[]; sog: number[] } {
  const out = { t: [] as number[], x: [] as number[], y: [] as number[], sog: [] as number[] };
  for (let i = 0; i < n; i++) {
    out.t.push(t0 + i * 1000);
    out.x.push(p0[0] + dir[0] * v * i);
    out.y.push(p0[1] + dir[1] * v * i);
    out.sog.push(v * KN);
  }
  return out;
}
/** Two stretches joined: `a`'s fixes then `b`'s. */
const join = (a: ReturnType<typeof line>, b: ReturnType<typeof line>): ReturnType<typeof line> => ({
  t: [...a.t, ...b.t],
  x: [...a.x, ...b.x],
  y: [...a.y, ...b.y],
  sog: [...a.sog, ...b.sog],
});
const track = (tr: ReturnType<typeof line>): FilledTrack => ({
  t: Float64Array.from(tr.t),
  x: Float32Array.from(tr.x),
  y: Float32Array.from(tr.y),
  sog: Float32Array.from(tr.sog),
});
const angle = (a: [number, number], b: [number, number]): number => {
  const c = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};
/** Distance from p to the segment a–b. */
const off = (p: [number, number], a: [number, number], b: [number, number]): number => {
  const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
  const f = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(p[0] - a[0] - f * vx, p[1] - a[1] - f * vy);
};

describe('gapFill: every gap is filled, however long', () => {
  const gapMs = 2000;
  /** A 1 Hz track east at 3 m/s with one step of `gapS` seconds after its 5th fix, carrying on along the same line. */
  const withGap = (gapS: number): FillInput => {
    const a = line(5, 0, [0, 0], [1, 0], 3);
    const t1 = 4000 + gapS * 1000;
    const b = line(5, t1, [3 * (t1 / 1000), 0], [1, 0], 3);
    return join(a, b);
  };

  it('a hole of 10 s, 30 s, 31 s, 8 min or 2 h is filled; no length limit', () => {
    for (const s of [10, 30, 31, 480, 7200]) {
      const g = fillGap(withGap(s), 4, gapMs);
      expect(g, `${s} s`).not.toBeNull();
      // About one point a second, strictly inside the hole, along the straight line the boat sailed.
      expect(g!.t.length).toBe(Math.ceil(s) - 1);
      expect(g!.t.every((t) => t > 4000 && t < 4000 + s * 1000)).toBe(true);
      g!.x.forEach((x, k) => expect(x).toBeCloseTo((3 * g!.t[k]) / 1000, 3));
    }
  });

  it('no gap, no fill: a step within the gap threshold is left alone, and a clean track is returned as it is', () => {
    expect(fillGap(withGap(2), 4, gapMs)).toBeNull();
    const clean = track(line(30, 0, [0, 0], [1, 0], 3));
    expect(fillTrack(clean, gapMs)).toBe(clean);
    expect('est' in clean).toBe(false);
  });

  it('fills about every FILL_STEP_MS, keeps every real fix and its time, flags nothing', () => {
    const src = track(withGap(10) as ReturnType<typeof line>);
    const f = fillTrack(src, gapMs);
    expect(f).not.toBe(src);
    expect(FILL_STEP_MS).toBe(1000);
    expect([...src.t].every((t) => f.t.includes(t))).toBe(true);
    expect(f.t.length - src.t.length).toBe(9);
    for (let i = 1; i < f.t.length; i++) expect(f.t[i] - f.t[i - 1]).toBeLessThanOrEqual(FILL_STEP_MS + 1e-9);
    // Drawn as the rest of the track: no flag on the filled points.
    expect('est' in f).toBe(false);
    // SOG linear across it; the source untouched; worked out once.
    expect([...f.sog].every((v) => Math.abs(v - 3 * KN) < 1e-3)).toBe(true);
    expect(fillTrack(src, gapMs)).toBe(f);
    // An 8 min hole: filled too, one point a second.
    const long = fillTrack(track(withGap(480) as ReturnType<typeof line>), gapMs);
    expect(long.t.length).toBe(10 + 479);
  });
});

describe('gapFill: the curve between the two fixes', () => {
  const gapMs = 2000;

  it('a boat going straight on at a steady speed: the curve is the straight line, evenly spaced, ends on the fixes', () => {
    const a = line(5, 0, [0, 0], [0.6, 0.8], 3);
    const b = line(5, 16_000, [0.6 * 48, 0.8 * 48], [0.6, 0.8], 3);
    const g = fillGap(join(a, b), 4, gapMs)!;
    expect(g.t).toHaveLength(11);
    g.t.forEach((t, k) => {
      const s = t / 1000;
      expect(g.x[k]).toBeCloseTo(0.6 * 3 * s, 6);
      expect(g.y[k]).toBeCloseTo(0.8 * 3 * s, 6);
      expect(angle(g.dir[k]!, [0.6, 0.8])).toBeLessThan(0.01);
    });
  });

  it('with headings and SOG: the ends of the curve follow the course into and out of the gap, without swinging wide', () => {
    // East at 3 m/s into the gap, north at 3 m/s out of it, 12 s later and 20 m east, 20 m north.
    const a = line(5, 0, [0, 0], [1, 0], 3);
    const b = line(5, 16_000, [32, 20], [0, 1], 3);
    const tr = join(a, b);
    const g = fillGap(tr, 4, gapMs)!;
    const p0: [number, number] = [12, 0];
    const p1: [number, number] = [32, 20];
    expect(g.t[0]).toBeGreaterThan(4000);
    expect(g.t[g.t.length - 1]).toBeLessThan(16_000);
    // The first step out of p0 runs east, the last step into p1 north (within a few degrees).
    expect(angle([g.x[0] - p0[0], g.y[0] - p0[1]], [1, 0])).toBeLessThan(8);
    expect(angle([p1[0] - g.x.at(-1)!, p1[1] - g.y.at(-1)!], [0, 1])).toBeLessThan(8);
    // Smooth: no step much longer than the chord's share, every point close to the chord.
    const pts: [number, number][] = [p0, ...g.x.map((x, k): [number, number] => [x, g.y[k]]), p1];
    const chord = Math.hypot(20, 20);
    for (let k = 1; k < pts.length; k++) expect(Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])).toBeLessThan((2 * chord) / (pts.length - 1));
    for (const p of pts) expect(off(p, p0, p1)).toBeLessThan(0.6 * chord);
  });

  it('a wild tangent (a far too high SOG, or a heading back against the gap) is tamed: no overshoot', () => {
    const a = line(5, 0, [0, 0], [1, 0], 3);
    const b = line(5, 14_000, [42, 0], [1, 0], 3);
    const tr = join(a, b);
    const p0: [number, number] = [12, 0];
    const p1: [number, number] = [42, 0];
    const fast = { ...tr, sog: tr.sog.map(() => 80) };
    const back = { ...tr, x: tr.x.map((x, i) => (i === 3 ? 13 : x)) };
    for (const t of [fast, back]) {
      const g = fillGap(t, 4, gapMs)!;
      for (let k = 0; k < g.x.length; k++) {
        expect(g.x[k]).toBeGreaterThanOrEqual(p0[0] - 1e-6);
        expect(g.x[k]).toBeLessThanOrEqual(p1[0] + 1e-6);
        expect(off([g.x[k], g.y[k]], p0, p1)).toBeLessThan(1e-6);
      }
    }
  });

  it('without SOG: Catmull-Rom from the fixes either side, still ending on the fixes', () => {
    const a = line(5, 0, [0, 0], [1, 0], 3);
    const b = line(5, 14_000, [42, 12], [1, 0], 3);
    const tr = { ...join(a, b), sog: join(a, b).sog.map(() => NaN) };
    const g = fillGap(tr, 4, gapMs)!;
    // At p0 the tangent is (p1 − the fix before p0) / its time: toward (42, 12) from (9, 0).
    expect(angle([g.x[0] - 12, g.y[0]], [42 - 9, 12])).toBeLessThan(5);
    // The last point is just short of p1.
    expect(Math.hypot(42 - g.x.at(-1)!, 12 - g.y.at(-1)!)).toBeLessThan(5);
  });

  it('a boat that didn\'t move: every filled point at the fix', () => {
    const still = { t: [0, 1000, 11_000, 12_000], x: [5, 5, 5, 5], y: [7, 7, 7, 7], sog: [0, 0, 0, 0] };
    const g = fillGap(still, 1, gapMs)!;
    expect(g.x.every((x) => x === 5) && g.y.every((y) => y === 7)).toBe(true);
    expect(g.dir.every((d) => d === null)).toBe(true);
  });
});
