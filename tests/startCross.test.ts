import { describe, expect, it } from 'vitest';
import type { Vec } from '../src/analysis/geo';
import { startCross } from '../src/analysis/startCross';

/**
 * A 200 m line along x at y = 0, the course side +y; the gun at GUN. A boat's distance from the line is
 * piecewise linear through the given [s after the gun, y m] points, sampled every `stepS` at x = `x`.
 */
const GUN = 1_000_000;
const left: Vec = [-100, 0];
const right: Vec = [100, 0];
const up: Vec = [0, 1];

function track(pts: [number, number][], stepS = 1, x = 0, holes: [number, number][] = []) {
  const t: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let s = pts[0][0]; s <= pts[pts.length - 1][0] + 1e-9; s += stepS) {
    if (holes.some(([a, b]) => s > a && s < b)) continue;
    const k = pts.findIndex((p, i) => i > 0 && p[0] >= s);
    const [s0, y0] = pts[Math.max(0, k - 1)];
    const [s1, y1] = pts[Math.max(1, k)];
    t.push(GUN + s * 1000);
    xs.push(x);
    ys.push(y0 + ((y1 - y0) * (s - s0)) / (s1 - s0));
  }
  return { t: Float64Array.from(t), x: Float64Array.from(xs), y: Float64Array.from(ys) };
}
const s = (t: number | null) => (t == null ? null : (t - GUN) / 1000);
const at = (tr: ReturnType<typeof track>, o = {}) => {
  const r = startCross(tr, left, right, up, GUN, o);
  return { first: s(r.firstCrossMs), back: s(r.wentBackMs), cleared: s(r.clearedMs), early: r.early };
};

describe('startCross: first crossing, back below the line, cleared', () => {
  it('a clean start: one crossing after the gun is the first and the clearing', () => {
    const r = at(track([[-20, -40], [2, 0], [60, 116]]));
    expect(r.first).toBeCloseTo(2, 6);
    expect(r.cleared).toBeCloseTo(2, 6);
    expect(r).toMatchObject({ back: null, early: false });
  });

  it('early and returned: over at the gun, back at +5 s, cleared at the recross (+20 s)', () => {
    const r = at(track([[-20, -34], [-3, 0], [0, 6], [5, 0], [12, -10], [20, 0], [60, 80]]));
    expect(r.first).toBeCloseTo(-3, 6);
    expect(r.early).toBe(true);
    expect(r.back).toBeCloseTo(5, 6);
    expect(r.cleared).toBeCloseTo(20, 6);
  });

  it('early but back before the gun: not early; the start is the crossing after the gun', () => {
    const r = at(track([[-20, -34], [-6, 0], [-4, 4], [-2, 0], [-1, -2], [3, 0], [60, 114]]));
    expect(r.first).toBeCloseTo(-6, 6);
    expect(r).toMatchObject({ early: false, back: null });
    expect(r.cleared).toBeCloseTo(3, 6);
  });

  it('dipped back after the gun: crossed at +2 s, back at +6 s, cleared at +15 s', () => {
    const r = at(track([[-20, -44], [2, 0], [4, 4], [6, 0], [10, -6], [15, 0], [60, 90]]));
    expect(r.first).toBeCloseTo(2, 6);
    expect(r.early).toBe(false);
    expect(r.back).toBeCloseTo(6, 6);
    expect(r.cleared).toBeCloseTo(15, 6);
  });

  it('never cleared within the window: null (over and stayed; or back and never recrossed by +5 min)', () => {
    const stayed = at(track([[-20, -34], [-3, 0], [60, 120]]));
    expect(stayed).toMatchObject({ early: true, back: null, cleared: null });
    expect(stayed.first).toBeCloseTo(-3, 6);
    const neverBack = at(track([[-20, -34], [-3, 0], [0, 6], [5, 0], [400, -30]]));
    expect(neverBack.early).toBe(true);
    expect(neverBack.back).toBeCloseTo(5, 6);
    expect(neverBack.cleared).toBeNull();
    // A recross after the window (toMs) does not count.
    expect(at(track([[-20, -34], [-3, 0], [0, 6], [5, 0], [100, -40], [330, 0], [360, 10]])).cleared).toBeNull();
    // A dip back after the window must not wipe a clearing already inside it.
    const after = at(track([[-20, -34], [-3, 0], [0, 6], [5, 0], [12, -10], [20, 0], [60, 80], [299, 80], [301, -20]]));
    expect(after.early).toBe(true);
    expect(after.cleared).toBeCloseTo(20, 6);
    expect(after.back).toBeCloseTo(5, 6);
    // No crossing at all.
    expect(at(track([[-20, -40], [60, -10]]))).toEqual({ first: null, back: null, cleared: null, early: false });
  });

  it('the bow crosses bowM ÷ speed ahead of the antenna (onto the course side only)', () => {
    // 2 m/s across the line: a 4 m bow is 2 s ahead.
    const r = at(track([[-20, -34], [-3, 0], [0, 6], [5, 0], [12, -14], [20, 2], [60, 82]]), { bowM: 4 });
    expect(r.first).toBeCloseTo(-5, 6);
    expect(r.back).toBeCloseTo(5, 6);
    expect(r.cleared).toBeCloseTo(17, 1);
  });

  it('back round an end counts; a crossing outside the ends does not start it; a crossing in a hole has no time', () => {
    // Over at the gun at x = 120 (outside the right end + 10 m slack): no timed crossing, so nothing at all.
    expect(at(track([[-20, -34], [-3, 0], [0, 6], [5, 0], [12, -10], [20, 0], [60, 80]], 1, 120)).first).toBeNull();
    // Inside the ends, the recross falls in a 10 s hole: back is known, the clearing has no time.
    const hole = at(track([[-20, -34], [-3, 0], [0, 6], [5, 0], [12, -10], [20, 0], [60, 80]], 1, 0, [[15, 25]]));
    expect(hole.back).toBeCloseTo(5, 6);
    expect(hole.cleared).toBeNull();
  });
});
