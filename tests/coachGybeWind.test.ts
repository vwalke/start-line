import { describe, expect, it } from 'vitest';
import type { CoachTrack } from '../src/analysis/coach/tracks';
import { gybesFor } from '../src/analysis/coach';
import type { RaceAnalysis } from '../src/analysis/types';
import { kiteOf } from '../src/data/classes';
import {
  GYBE,
  GYBE_MIN_BOATS,
  GYBE_MIN_GAP_MS,
  GYBE_MIN_RUN_SOG_KN,
  GYBE_WIND,
  fleetTwdSeries,
  gybeTwd,
  twdSeriesFrom,
  type RunSample,
} from '../src/analysis/coach/twdSeries';
import { MS_TO_KN, bearingVec, wrap180 } from '../src/analysis/geo';

/**
 * Synthetic runs for the gybe wind: boats sailing `off`° either side of dead downwind at 7 kn, gybing
 * every 90 s (staggered), the course jittered a few degrees, a fix a second; positions only.
 */
const MIN = 60_000;

/** A repeatable jitter in [-1, 1]. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

interface Leg {
  /** Minutes from the gun. */
  from: number;
  to: number;
  /** The course at second `s` (port: the first side). */
  cog: (s: number, port: boolean) => number;
  kn: number;
}

/** One boat over consecutive legs (bounds at their ends); `side(k, s)`: on the first side. */
function boat(k: number, legs: Leg[], side: (k: number, s: number) => boolean, jitter = 3): CoachTrack {
  const r = rng(k + 1);
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let px = k * 40;
  let py = 0;
  for (const leg of legs) {
    for (let s = leg.from * 60; s < leg.to * 60; s++) {
      t.push(s * 1000);
      x.push(px);
      y.push(py);
      const v = bearingVec(leg.cog(s, side(k, s)) + jitter * r());
      px += v[0] * (leg.kn / MS_TO_KN);
      py += v[1] * (leg.kn / MS_TO_KN);
    }
  }
  const bounds = [0, ...legs.map((l) => l.to * MIN)];
  return { id: `b${k}`, t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y), bounds };
}

const gybing = (k: number, s: number) => Math.floor((s + k * 37) / 90) % 2 === 0;
const tacking = (k: number, s: number) => Math.floor((s + k * 13) / 60) % 2 === 0;
const run = (twd: number, off: number, from: number, to: number, kn = 7): Leg => ({ from, to, kn, cog: (_, p) => twd + 180 + (p ? off : -off) });
const beat = (twd: number, from: number, to: number, ta = 90): Leg => ({ from, to, kn: 6, cog: (_, p) => twd + (p ? ta / 2 : -ta / 2) });

/** A fleet of `n` boats: a beat to `split` min then a run to `end` (the beat empty when split is 0). */
function fleet(n: number, legs: (k: number) => Leg[], side: (k: number, s: number) => boolean = gybing): CoachTrack[] {
  return Array.from({ length: n }, (_, k) => boat(k, legs(k), side));
}

const base = { gunMs: 0, priorTa: 80 };
const runOnly = (twd: number, off: number) => fleet(8, () => [run(twd, off, 0, 0.001), run(twd, off, 0.001, 20)]);

describe('fleetTwdSeries on the runs: the wind from the fleet’s gybes', () => {
  it('asymmetric kites, ±35° off dead downwind: the wind within a couple of degrees, the seed 8° off', () => {
    const s = fleetTwdSeries({ ...base, endMs: 20 * MIN, legKinds: ['upwind', 'downwind'], tracks: runOnly(200, 35), prior: () => 192, gybes: true });
    const ok = s.t.map((_, i) => i).filter((i) => s.ok[i]);
    expect(ok.length).toBeGreaterThan(15);
    for (const i of ok) expect(Math.abs(wrap180(s.twd[i] - 200))).toBeLessThan(2);
    // No tack angle from a run: the prior's all through.
    expect(s.taOk!.some(Boolean)).toBe(false);
    expect(s.ta.every((v) => v === 80)).toBe(true);
  });

  it('symmetric kites, ±15° off dead downwind, across north', () => {
    const s = fleetTwdSeries({ ...base, endMs: 20 * MIN, legKinds: ['upwind', 'downwind'], tracks: runOnly(1, 15), prior: () => 359, gybes: true });
    const ok = s.t.map((_, i) => i).filter((i) => s.ok[i]);
    expect(ok.length).toBeGreaterThan(15);
    for (const i of ok) expect(Math.abs(wrap180(s.twd[i] - 1))).toBeLessThan(2);
  });

  it('one gybe only, or too few boats: no reading', () => {
    const one = fleet(8, () => [run(200, 35, 0, 0.001), run(200, 35, 0.001, 20)], () => true);
    expect(fleetTwdSeries({ ...base, endMs: 20 * MIN, legKinds: ['upwind', 'downwind'], tracks: one, prior: () => 200, gybes: true }).ok.some(Boolean)).toBe(false);
    const few = fleet(GYBE_MIN_BOATS - 1, () => [run(200, 35, 0, 0.001), run(200, 35, 0.001, 20)]);
    expect(fleetTwdSeries({ ...base, endMs: 20 * MIN, legKinds: ['upwind', 'downwind'], tracks: few, prior: () => 200, gybes: true }).ok.some(Boolean)).toBe(false);
  });

  it('gybeTwd: a lopsided window is no reading; a balanced one is', () => {
    const win = (a: number, b: number): RunSample[] => [
      ...Array.from({ length: a }, (_, i) => ({ cog: 20 - 35 + (i % 3), sogKn: 7, boat: i % 6 })),
      ...Array.from({ length: b }, (_, i) => ({ cog: 20 + 35 - (i % 3), sogKn: 7, boat: 6 + (i % 3) })),
    ];
    expect(gybeTwd(win(60, 60), 200)).toBeCloseTo(200, 0);
    const few = Math.max(GYBE.minPerGybe, Math.floor(60 * GYBE.balance) - 2);
    expect(gybeTwd(win(60, few), 200)).toBeNull();
  });

  it(`light air: no run reading when the boats' median speed is under ${GYBE_MIN_RUN_SOG_KN} kn`, () => {
    const slow = GYBE_MIN_RUN_SOG_KN - 0.5;
    const tracks = fleet(8, () => [run(200, 35, 0, 0.001, slow), run(200, 35, 0.001, 20, slow)]);
    expect(fleetTwdSeries({ ...base, endMs: 20 * MIN, legKinds: ['upwind', 'downwind'], tracks, prior: () => 192, gybes: true }).ok.some(Boolean)).toBe(false);
  });

  it('a minute with a beat and a run: the beat’s reading', () => {
    // Half the fleet still beating (wind 10°), half already on the run, its gybes saying 20°.
    const tracks = [
      ...fleet(6, () => [beat(10, 0, 20)], tacking),
      ...fleet(8, () => [run(20, 35, 0, 0.001), run(20, 35, 0.001, 20)]),
    ];
    const s = fleetTwdSeries({ ...base, endMs: 20 * MIN, legKinds: ['upwind', 'downwind'], tracks, prior: () => 12, gybes: true });
    for (let i = 1; i < s.t.length; i++) {
      expect(s.ok[i]).toBe(true);
      expect(s.taOk![i]).toBe(true);
      expect(s.twd[i]).toBeCloseTo(10, 0);
    }
  });

  it('the tack angle comes from the beats only; the wind from both', () => {
    // A beat to 10 min (wind 10°, tack angle 90°), then a run to 20 min with the wind gone to 20°.
    const legs = () => [beat(10, 0, 10), run(20, 35, 10, 20)];
    const side = (k: number, s: number) => (s < 600 ? tacking(k, s) : gybing(k, s));
    const tracks = fleet(8, legs, side);
    const on = fleetTwdSeries({ ...base, endMs: 20 * MIN, legKinds: ['upwind', 'downwind'], tracks, prior: () => 15, gybes: true });
    const off = fleetTwdSeries({ ...base, endMs: 20 * MIN, legKinds: ['upwind', 'downwind'], tracks, prior: () => 15, gybes: false });
    expect(on.ta).toEqual(off.ta);
    expect(on.taAt(15 * MIN)).toBe(off.taAt(15 * MIN));
    // The run is read where the beat's last reading was held.
    expect(off.ok[15]).toBe(false);
    expect(off.twd[15]).toBeCloseTo(10, 0);
    expect(on.ok[15]).toBe(true);
    expect(on.taOk![15]).toBe(false);
    expect(Math.abs(wrap180(on.twd[15] - 20))).toBeLessThan(2);
  });

  it(`a run between two beats: read only ${GYBE_MIN_GAP_MS / MIN} min or more from every beat reading, blended in a straight line to the beats`, () => {
    // Beat (wind 10°) to 5 min, run (wind 20°) to 25 min, beat (10°) to 30 min.
    const legs = () => [beat(10, 0, 5), run(20, 35, 5, 25), beat(10, 25, 30)];
    const side = (k: number, s: number) => (s < 300 || s >= 1500 ? tacking(k, s) : gybing(k, s));
    const s = fleetTwdSeries({ ...base, endMs: 30 * MIN, legKinds: ['upwind', 'downwind', 'upwind'], tracks: fleet(8, legs, side), prior: () => 15, gybes: true });
    const tack = s.t.filter((_, i) => s.taOk![i]);
    const runRead = s.t.map((_, i) => i).filter((i) => s.ok[i] && !s.taOk![i]);
    expect(runRead.length).toBeGreaterThan(0);
    for (const i of runRead) {
      expect(Math.min(...tack.map((x) => Math.abs(x - s.t[i])))).toBeGreaterThanOrEqual(GYBE_MIN_GAP_MS);
      expect(Math.abs(wrap180(s.twd[i] - 20))).toBeLessThan(2);
    }
    // Between the beat's last reading and the first run reading: a straight line (the minutes in between aren't measured).
    const a = s.t.indexOf(Math.max(...tack.filter((x) => x < s.t[runRead[0]])));
    const b = runRead[0];
    for (let i = a + 1; i < b; i++) {
      expect(s.ok[i]).toBe(false);
      expect(s.twd[i]).toBeCloseTo(s.twd[a] + ((s.twd[b] - s.twd[a]) * (i - a)) / (b - a), 6);
    }
  });

  it('off: the runs change nothing (the series of the beats alone)', () => {
    const beaters = fleet(6, () => [beat(10, 0, 20)], tacking);
    const runners = fleet(8, () => [run(30, 35, 0, 0.001), run(30, 35, 0.001, 20)]);
    const inp = { ...base, endMs: 20 * MIN, legKinds: ['upwind' as const, 'downwind' as const], prior: () => 12, gybes: false };
    const both = fleetTwdSeries({ ...inp, tracks: [...beaters, ...runners] });
    const alone = fleetTwdSeries({ ...inp, tracks: beaters });
    for (const k of ['t', 'twd', 'ta', 'n', 'ok'] as const) expect(both[k]).toEqual(alone[k]);
    expect(both.taOk).toEqual(both.ok);
  });

  it('twdSeriesFrom: data without taOk (an older worker) reads the tack angle from `ok`', () => {
    const d = { t: [0, MIN, 2 * MIN], twd: [10, 14, 20], ta: [80, NaN, 90], n: [40, 3, 40], ok: [true, true, true], taOk: [true, false, true] };
    const s = twdSeriesFrom(d, () => 0, 85);
    expect(s.twd[1]).toBe(14);
    expect(s.ta[1]).toBeCloseTo(85, 6);
    expect(twdSeriesFrom({ ...d, taOk: undefined, ta: [80, 84, 90] }, () => 0, 85).ta[1]).toBe(84);
  });
});

describe('which classes read the runs: asymmetric kites only', () => {
  it('kiteOf: from the class, else the division, by their normalized names', () => {
    expect(kiteOf(['J/70'])).toBe('asym');
    expect(kiteOf(['C31'])).toBe('asym');
    expect(kiteOf(['M24'])).toBe('asym');
    expect(kiteOf([null, 'Melges 24'])).toBe('asym');
    expect(kiteOf(['Etchells'])).toBe('sym');
    expect(kiteOf(['J/24'])).toBe('sym');
    expect(kiteOf(['ILCA 7'])).toBe('none');
    expect(kiteOf(['Open', 'Gold'])).toBeNull();
    expect(kiteOf(['Open', 'J70'])).toBe('asym');
  });

  it('gybesFor: on for an asymmetric-kite class, off for the rest and for an unknown class', () => {
    const of = (boatClass: string, division = 'Open') => gybesFor({ meta: { boatClass, division } } as RaceAnalysis);
    expect(of('J/105')).toBe(GYBE_WIND);
    expect(of('Etchells')).toBe(false);
    expect(of('Star')).toBe(false);
    expect(of('Mystery 26')).toBe(false);
  });
});
