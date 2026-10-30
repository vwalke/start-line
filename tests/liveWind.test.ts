import { describe, expect, it } from 'vitest';
import { circMean, wrap180 } from '../src/analysis/geo';
import { LIVE_HALF_MS, LIVE_STEP_MS, circSmooth, liveWind, liveWindOf } from '../src/analysis/coach/liveWind';
import { ladderReader } from '../src/analysis/coach/ladderNow';
import type { CoachModel } from '../src/analysis/coach';
import { rungsAt } from '../src/ui/rungs';
import { coachRace, starRace } from './helpers';

/**
 * The wind of the moment (coach/liveWind.ts): the fleet's series smoothed by a centred two-minute circular mean,
 * sampled once per race, with no gaps (a hole takes the nearest reading; the ends are held).
 */

const off = (a: number, b: number): number => Math.abs(wrap180(a - b));

describe('circular smoothing', () => {
  it('averages across north: 355° and 5° make 0°, not 180°', () => {
    const s = circSmooth([355, 5], 1);
    for (const v of s) expect(off(v, 0)).toBeLessThan(1e-9);
    const t = circSmooth([350, 355, 0, 5, 10], 2);
    expect(off(t[2], 0)).toBeLessThan(1e-9);
    expect(t.every((v) => v >= 0 && v < 360)).toBe(true);
  });

  it('is the vector mean, not the mean of the numbers', () => {
    const s = circSmooth([10, 20, 30, 340, 350], 2);
    expect(s[2]).toBeCloseTo(circMean([10, 20, 30, 340, 350]), 9);
    // A few degrees east of north; the numbers' mean (150°) points the other way.
    expect(off(s[2], 6.05)).toBeLessThan(0.01);
  });

  it('leaves a hole out of the means, and fills windows with nothing straight between the readings either side', () => {
    const s = circSmooth([20, NaN, NaN, NaN, NaN, NaN, 40], 1);
    expect(s[0]).toBeCloseTo(20, 9);
    expect(s[1]).toBeCloseTo(20, 9);
    // Nothing in 2–4's windows: from 20° (at 1) to 40° (at 5), no step.
    expect([s[2], s[3], s[4]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([25, 30, 35]);
    expect(s[5]).toBeCloseTo(40, 9);
    // Across north the shorter way round; held at an end.
    const n = circSmooth([350, NaN, NaN, NaN, 10, NaN, NaN], 0);
    expect([n[1], n[2], n[3]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([355, 0, 5]);
    expect(n[6]).toBeCloseTo(10, 9);
    expect([...circSmooth([NaN, NaN], 1)].every(Number.isNaN)).toBe(true);
  });
});

describe('the wind of the moment', () => {
  // 350° veering to 10° through north over ten minutes, with a five-minute hole in the middle.
  const t0 = 1_000_000;
  const hole = (t: number): boolean => t > t0 + 200_000 && t < t0 + 500_000;
  const w = {
    twdAt: (t: number) => (hole(t) ? NaN : (350 + (20 * (t - t0)) / 600_000) % 360),
    taAt: (t: number) => (hole(t) ? NaN : 80),
  };
  const live = liveWindOf(w, t0, t0 + 600_000);

  it('turns through north without swinging the long way round', () => {
    let prev = live.twdAt(t0);
    for (let t = t0; t <= t0 + 600_000; t += 1000) {
      const v = live.twdAt(t);
      expect(off(v, prev)).toBeLessThan(1);
      prev = v;
    }
    expect(off(live.twdAt(t0 + 600_000), 10)).toBeLessThan(1.5);
  });

  it('has a value at every moment: across the hole, before the start and after the end', () => {
    for (let t = t0 - 120_000; t <= t0 + 720_000; t += 2500) {
      expect(Number.isFinite(live.twdAt(t))).toBe(true);
      expect(Number.isFinite(live.taAt(t))).toBe(true);
    }
    // Held at the ends.
    expect(live.twdAt(t0 - 60_000)).toBe(live.twdAt(t0));
    expect(live.twdAt(t0 + 900_000)).toBe(live.twdAt(t0 + 5_000_000));
    // Across the hole: straight between the readings either side, no jump past them.
    const before = live.twdAt(t0 + 200_000);
    const after = live.twdAt(t0 + 500_000);
    for (let t = t0 + 200_000; t <= t0 + 500_000; t += 5000) {
      const v = live.twdAt(t);
      expect(off(v, before) + off(v, after)).toBeLessThanOrEqual(off(before, after) + 1e-6);
    }
    expect(live.taAt(t0 + 350_000)).toBeCloseTo(80, 9);
  });

  it('a series with nothing at all gives the fallback, not a hole', () => {
    const none = liveWindOf({ twdAt: () => NaN, taAt: () => NaN }, 0, 60_000, 215);
    expect(none.twdAt(30_000)).toBeCloseTo(215, 9);
    expect(none.taAt(30_000)).toBe(90);
  });
});

describe('on a race (Star NA race 4)', () => {
  const { a, m } = coachRace(starRace());
  const live = liveWind(m);

  it('is the centred two-minute circular mean of the Coach’s wind series', () => {
    const half = LIVE_HALF_MS / LIVE_STEP_MS;
    for (let k = half; k < 300; k += 7) {
      const t = m.gunMs + k * LIVE_STEP_MS;
      const xs: number[] = [];
      for (let j = -half; j <= half; j++) xs.push(m.wind.twdAt(t + j * LIVE_STEP_MS));
      expect(off(live.twdAt(t), circMean(xs))).toBeLessThan(1e-6);
    }
  });

  it('is worked out once per wind series', () => {
    expect(liveWind(m)).toBe(live);
    expect(liveWind({ ...m })).toBe(live);
  });

  it('keeps the rungs through a hole in the wind estimate, at the leg’s start and at its end', () => {
    // The Coach's series with nothing from 2 to 6 minutes after the gun, in the middle of the first beat.
    const gun = m.gunMs;
    const m2: CoachModel = { ...m, wind: { ...m.wind, twdAt: (t) => (t > gun + 120_000 && t < gun + 360_000 ? NaN : m.wind.twdAt(t)) } };
    const read = ladderReader(a, m2);
    const firstRound = Math.min(...[...m.tracks.values()].map((tr) => tr.bounds[1] ?? Infinity));
    for (const t of [gun + 1000, gun + 30_000, gun + 180_000, gun + 240_000, gun + 300_000, firstRound - 5000]) {
      const now = read(t);
      expect(Number.isFinite(now.twdDeg)).toBe(true);
      expect(now.leader).toBeGreaterThanOrEqual(0);
      const rungs = rungsAt({ now, selected: null, mapTwdDeg: a.wind.twdAtGunDeg });
      expect(rungs.map((r) => r.role)).toEqual(['leader']);
      expect(rungs[0].axis.twdDeg).toBe(now.twdDeg);
    }
    // Across the hole the rungs turn smoothly from one side's wind to the other's: no jump from one moment to the next.
    let prev = read(gun + 100_000).twdDeg;
    for (let t = gun + 100_000; t <= gun + 380_000; t += 5000) {
      const v = read(t).twdDeg;
      expect(off(v, prev)).toBeLessThan(1);
      prev = v;
    }
    expect(off(read(gun + 240_000).twdDeg, read(gun + 120_000).twdDeg)).toBeGreaterThan(1);
  });
});
