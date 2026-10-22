import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import {
  START_WIND_BAND_DEG,
  START_WIND_FROM_MS,
  START_WIND_GRID_MS,
  START_WIND_GRID_TOL_MS,
  START_WIND_MAX_TACK_DIFF_DEG,
  START_WIND_MIN_SAMPLES,
  START_WIND_MIN_TACK_N,
  START_WIND_MIN_TACK_SHARE,
  START_WIND_TO_MS,
  STEADY_TAIL_MS,
  closeHauledTackAngle,
  estimateStartTwd,
  makeTwdAt,
  readStartTwd,
  startWindHeadings,
  tackModes,
  windPoints,
} from '../src/analysis/wind';
import { gateRace, j105Race } from './helpers';

/** `n` headings spread ±2° about `deg`. */
const tack = (deg: number, n: number): number[] => Array.from({ length: n }, (_, i) => deg + ((i % 5) - 2));

/** A boat sailing steadily from `t0` to `t1` (ms, after a gun at 0), a fix every `dt` ms; heading `hdg(t)`. */
function boat(t0: number, t1: number, dt: number, hdg: (t: number) => number = () => 280): { t: number[]; heading: number[]; sog: number[] } {
  const t: number[] = [];
  for (let x = t0; x <= t1; x += dt) t.push(x);
  return { t, heading: t.map(hdg), sog: t.map(() => 6) };
}

describe('the gun window (wind.ts startWindHeadings)', () => {
  it('reads each boat from gun + START_WIND_FROM_MS to gun + START_WIND_TO_MS, steadyIndices’ own trims allowed for', () => {
    expect([START_WIND_FROM_MS, START_WIND_TO_MS, START_WIND_GRID_MS]).toEqual([30_000, 210_000, 2_000]);
    // A fix every second from 60 s before the gun to 5 min after, its heading telling its time (0.01°/s: steady).
    const at = (h: number): number => (h - 200) * 100_000;
    const b = boat(-60_500, 300_500, 1_000, (t) => 200 + t / 100_000);
    const times = startWindHeadings(b, 0).map(at);
    expect(Math.min(...times)).toBeGreaterThan(START_WIND_FROM_MS);
    expect(Math.min(...times)).toBeLessThan(START_WIND_FROM_MS + START_WIND_GRID_MS);
    expect(Math.max(...times)).toBeLessThan(START_WIND_TO_MS);
    expect(Math.max(...times)).toBeGreaterThan(START_WIND_TO_MS - START_WIND_GRID_MS);
    // One a grid step: 30, 32 … 208 s (210 s's nearest fix, 210.5 s, is past the window).
    expect(times).toHaveLength((START_WIND_TO_MS - START_WIND_FROM_MS) / START_WIND_GRID_MS);
    // Clipped STEADY_TAIL_MS before its first rounding (the approach to the mark), as a beat's steady headings are.
    const round = 120_000;
    expect(Math.max(...startWindHeadings(b, 0, round).map(at))).toBeLessThan(round - STEADY_TAIL_MS);
  });

  it('a boat counts once a grid step whether it logs every 0.2 s or every 5 s; never across a hole', () => {
    const dense = startWindHeadings(boat(-29_900, 240_000, 200), 0);
    const sparse = startWindHeadings(boat(-29_900, 240_000, 5_000), 0);
    expect(dense.length).toBe(90);
    // The last two steps' nearest 5 s fix (210.1 s) is past the window.
    expect(sparse.length).toBe(89);
    // No fix from 100 s to 160 s: the steps more than START_WIND_GRID_TOL_MS from a fix (106 … 154 s) read nothing.
    expect(START_WIND_GRID_TOL_MS).toBe(5_000);
    const b = boat(-29_900, 240_000, 1_000);
    const keep = b.t.map((t) => t < 100_000 || t > 160_000);
    const holed = { t: b.t.filter((_, i) => keep[i]), heading: b.heading.filter((_, i) => keep[i]), sog: b.sog.filter((_, i) => keep[i]) };
    expect(startWindHeadings(holed, 0).length).toBe(startWindHeadings(b, 0).length - 25);
  });

  it('so a densely logged boat does not outvote the rest: the bisector of the boats’ tacks', () => {
    // Starboard: one boat at 282° logging every 0.2 s, one at 278° every 5 s; port: one at 350° every second.
    const hs = [
      ...startWindHeadings(boat(-29_900, 240_000, 200, () => 282), 0),
      ...startWindHeadings(boat(-29_900, 240_000, 5_000, () => 278), 0),
      ...startWindHeadings(boat(-29_900, 240_000, 1_000, () => 350), 0),
      ...startWindHeadings(boat(-29_900, 240_000, 1_000, () => 352), 0),
    ];
    expect(hs.filter((h) => h === 282).length - hs.filter((h) => h === 278).length).toBeLessThanOrEqual(2);
    // Starboard ≈ 280°, port 351°: 315.5°. Fix for fix, the 0.2 s boat's 282° would have pulled it to 316.4°.
    expect(Math.abs(estimateStartTwd(hs, 70)!.twdDeg - 315.5)).toBeLessThan(0.1);
  });
});

describe('the wind at the gun from the window’s close-hauled tacks (wind.ts readStartTwd)', () => {
  it('two tacks, enough of each: their bisector, with the close-hauled counts on each tack', () => {
    const hs = [...tack(280, 400), ...tack(350, 150)];
    const e = estimateStartTwd(hs, 72)!;
    expect(e.twdDeg).toBeCloseTo(315, 6);
    expect(e.tackAngleDeg).toBeCloseTo(70, 6);
    expect([e.samples, e.steady]).toEqual([550, 550]);
    expect([...e.tackSamples].sort((a, b) => a - b)).toEqual([150, 400]);
  });

  it('drops footing, reaching and luffing headings (beyond START_WIND_BAND_DEG of a tack’s mode) and reads the tacks again', () => {
    expect(START_WIND_BAND_DEG).toBe(10);
    // Port boats footing 15° low to clear transoms, starboard boats reaching off at 245° and luffing at 300°.
    const clean = [...tack(280, 400), ...tack(350, 200)];
    const noise = [...tack(5, 80), ...tack(245, 40), ...tack(300, 30)];
    const hs = [...clean, ...noise];
    const e = estimateStartTwd(hs, 70)!;
    expect(e.twdDeg).toBeCloseTo(315, 6);
    expect(e.tackAngleDeg).toBeCloseTo(70, 6);
    expect([e.samples, e.steady]).toEqual([clean.length, hs.length]);
    // Two plain means would have read the footing port tack and the reaching starboard tack into the bisector.
    const { centers } = tackModes(hs);
    expect(Math.abs((((centers[0] + centers[1]) / 2) % 360) - 315)).toBeGreaterThan(1);
    // Beat 1's tack angle, for the gate, is read the same way.
    expect(closeHauledTackAngle(hs)).toBeCloseTo(70, 6);
  });

  it('falls back with too few headings, too few or too small a share on a tack, or a tack angle off Beat 1’s', () => {
    expect([START_WIND_MIN_SAMPLES, START_WIND_MIN_TACK_N, START_WIND_MIN_TACK_SHARE, START_WIND_MAX_TACK_DIFF_DEG]).toEqual([150, 30, 0.2, 8]);
    const few = [...tack(280, START_WIND_MIN_SAMPLES - 41), ...tack(350, 40)];
    expect(readStartTwd(few, 70)).toEqual({ est: null, fail: 'samples' });
    expect(readStartTwd(tack(280, 600), 70).fail).not.toBeNull();
    const thin = [...tack(280, 300), ...tack(350, START_WIND_MIN_TACK_N - 1)];
    expect(readStartTwd(thin, 70)).toEqual({ est: null, fail: 'tack-samples' });
    // Port 19% of the close-hauled readings against the 20% needed; 21% passes.
    expect(readStartTwd([...tack(280, 810), ...tack(350, 190)], 70)).toEqual({ est: null, fail: 'tack-share' });
    expect(readStartTwd([...tack(280, 790), ...tack(350, 210)], 70).fail).toBeNull();
    const ok = [...tack(280, 400), ...tack(350, 150)];
    expect(readStartTwd(ok, 70 + START_WIND_MAX_TACK_DIFF_DEG).fail).toBeNull();
    expect(readStartTwd(ok, 70 - START_WIND_MAX_TACK_DIFF_DEG).fail).toBeNull();
    expect(readStartTwd(ok, 70 + START_WIND_MAX_TACK_DIFF_DEG + 0.5)).toEqual({ est: null, fail: 'tack-angle' });
  });

  it('pinned at the gun: twdAt holds it before the gun and runs linearly to Beat 1’s estimate; none: exactly the beats', () => {
    const estimates = [
      { legIndex: 0, tMs: 1_000_000, twdDeg: 310, tackAngleDeg: 72, samples: 900 },
      { legIndex: 2, tMs: 4_000_000, twdDeg: 320, tackAngleDeg: 70, samples: 900 },
    ];
    const startWindow = { tMs: 0, twdDeg: 318, tackAngleDeg: 70, samples: 600, steady: 800, tackSamples: [400, 200] as [number, number] };
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

describe('the fallback on the fixtures: Beat 1’s whole-beat estimate, exactly as before', () => {
  // J/105 R3: port 13% of the window's close-hauled readings; Melges 24 R5: 19%. J/24 R2: the window's tacks 62.5° apart
  // against Beat 1's 74.8° (the 0:30–3:30 bisector would have put the line square, Beat 1 the committee boat 6.7°).
  const cases = [
    ['J/105 R3', () => j105Race(3), 'tack-share', 28.1],
    ['Melges 24 R5', () => gateRace('m24r5'), 'tack-share', 81.6],
    ['J/24 R2', () => gateRace('j24r2'), 'tack-angle', 296.6],
  ] as const;
  for (const [name, race, fail, deg] of cases)
    it(`${name}: ${fail}`, () => {
      const a = analyzeRace(race());
      expect(a.wind.method).toBe('tacks');
      expect(a.wind.gunSource).toBe('beat');
      expect(a.wind.startWindow).toBeNull();
      expect(a.wind.startWindowFail).toBe(fail);
      expect(a.wind.estimates[0].legIndex).toBe(0);
      expect(a.wind.twdAtGunDeg).toBe(a.wind.estimates[0].twdDeg);
      expect(a.wind.twdAtGunDeg).toBeCloseTo(deg, 1);
    });
});
