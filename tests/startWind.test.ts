import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import {
  START_WIND_MAX_TACK_DIFF_DEG,
  START_WIND_MIN_SAMPLES,
  START_WIND_MIN_TACK_N,
  START_WIND_MIN_TACK_SHARE,
  START_WIND_WINDOW_MS,
  estimateStartTwd,
  makeTwdAt,
  tackModes,
  windPoints,
} from '../src/analysis/wind';
import { j105Race } from './helpers';

/** `n` headings spread ±2° about `deg`. */
const tack = (deg: number, n: number): number[] => Array.from({ length: n }, (_, i) => deg + ((i % 5) - 2));
const ones = (n: number, w = 1_000): number[] => Array<number>(n).fill(w);

describe('the wind at the gun from the first minutes (wind.ts estimateStartTwd)', () => {
  it('two tacks, enough of each: their bisector, with the counts on each tack', () => {
    expect(START_WIND_WINDOW_MS).toBe(180_000);
    const hs = [...tack(280, 400), ...tack(350, 150)];
    const e = estimateStartTwd(hs, ones(hs.length), 72)!;
    expect(e.twdDeg).toBeCloseTo(315, 6);
    expect(e.tackAngleDeg).toBeCloseTo(70, 6);
    expect(e.samples).toBe(550);
    expect([...e.tackSamples].sort((a, b) => a - b)).toEqual([150, 400]);
  });

  it('null with too few headings, one tack, too few or too little time on a tack, or a tack angle off Beat 1’s', () => {
    const few = [...tack(280, START_WIND_MIN_SAMPLES - 101), ...tack(350, 100)];
    expect(estimateStartTwd(few, ones(few.length), 70)).toBeNull();
    const one = tack(280, 600);
    expect(estimateStartTwd(one, ones(one.length), 70)).toBeNull();
    const thinPort = [...tack(280, 600), ...tack(350, START_WIND_MIN_TACK_N - 1)];
    expect(estimateStartTwd(thinPort, ones(thinPort.length), 70)).toBeNull();
    // 100 port headings, but logged sparsely: 10% of the time against the 15% needed.
    const share = [...tack(280, 900), ...tack(350, 100)];
    expect(START_WIND_MIN_TACK_SHARE).toBe(0.15);
    expect(estimateStartTwd(share, [...ones(900, 1_000), ...ones(100, 1_000)], 70)).toBeNull();
    expect(estimateStartTwd(share, [...ones(900, 1_000), ...ones(100, 2_000)], 70)).not.toBeNull();
    const ok = [...tack(280, 400), ...tack(350, 150)];
    expect(estimateStartTwd(ok, ones(ok.length), 70 + START_WIND_MAX_TACK_DIFF_DEG)).not.toBeNull();
    expect(estimateStartTwd(ok, ones(ok.length), 70 + START_WIND_MAX_TACK_DIFF_DEG + 1)).toBeNull();
  });

  it('counts boat-seconds, not fixes: a densely logged stretch does not outvote the rest', () => {
    // Starboard 282° logged 10× as often as starboard 278°, for the same time: the time-weighted centre is 280°.
    const hs = [...Array<number>(500).fill(282), ...Array<number>(50).fill(278), ...tack(350, 200)];
    const ws = [...ones(500, 200), ...ones(50, 2_000), ...ones(200, 1_000)];
    expect(tackModes(hs, ws).centers.some((c) => Math.abs(c - 280) < 1e-6)).toBe(true);
    expect(estimateStartTwd(hs, ws, 70)!.twdDeg).toBeCloseTo(315, 6);
    // Unweighted, as estimateTwd reads a beat: the dense stretch wins.
    expect(tackModes(hs).centers.some((c) => Math.abs(c - 281.6) < 0.1)).toBe(true);
  });

  it('pinned at the gun: twdAt holds it before the gun and runs linearly to Beat 1’s estimate; none: exactly the beats', () => {
    const estimates = [
      { legIndex: 0, tMs: 1_000_000, twdDeg: 310, tackAngleDeg: 72, samples: 900 },
      { legIndex: 2, tMs: 4_000_000, twdDeg: 320, tackAngleDeg: 70, samples: 900 },
    ];
    const startWindow = { tMs: 0, twdDeg: 318, tackAngleDeg: 70, samples: 600, tackSamples: [400, 200] as [number, number] };
    const twdAt = makeTwdAt(windPoints({ estimates, startWindow }), 300);
    expect(twdAt(-60_000)).toBe(318);
    expect(twdAt(0)).toBe(318);
    expect(twdAt(500_000)).toBeCloseTo(314, 9);
    expect(twdAt(1_000_000)).toBeCloseTo(310, 9);
    expect(twdAt(2_500_000)).toBeCloseTo(315, 9);
    expect(windPoints({ estimates, startWindow: null })).toBe(estimates);
    const old = makeTwdAt(estimates, 300);
    const fallback = makeTwdAt(windPoints({ estimates, startWindow: null }), 300);
    for (const t of [-60_000, 0, 500_000, 2_500_000, 5_000_000]) expect(fallback(t)).toBe(old(t));
  });
});

describe('the fallback on a fixture: J/105 R3 (too few port-tack headings in the first 3 min)', () => {
  it('the wind at the gun is Beat 1’s whole-beat estimate, exactly as before', () => {
    const a = analyzeRace(j105Race(3));
    expect(a.wind.method).toBe('tacks');
    expect(a.wind.gunSource).toBe('beat');
    expect(a.wind.startWindow).toBeNull();
    expect(a.wind.estimates[0].legIndex).toBe(0);
    expect(a.wind.twdAtGunDeg).toBe(a.wind.estimates[0].twdDeg);
    expect(a.wind.twdAtGunDeg).toBeCloseTo(28.1, 1);
  });
});
