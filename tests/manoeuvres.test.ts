import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { bearingVec, MS_TO_KN, wrap180 } from '../src/analysis/geo';
import {
  MAN_DWELL_MS,
  MAN_GAP_MS,
  MAN_MIN_SOG_KN,
  MAN_ROUNDING_MS,
  MAN_TWA_MAX,
  MAN_TWA_MIN,
  detectManoeuvres,
  manoeuvresByLeg,
  signedTwa,
  type Manoeuvre,
} from '../src/analysis/manoeuvres';
import type { LegKind } from '../src/analysis/types';
import { c31Race, fixtureRace, j88Race, m24Race } from './helpers';

/** Keyframes [time s, heading °, speed kn]; heading turns the short way between frames. */
type Key = [number, number, number];

/** Seeded PRNG so the noisy tracks are the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** A 5 Hz track sailing the keyframes from (0, 0); wind from north (TWD 0), so TWA = −heading. */
function sail(keys: Key[], opts: { noiseDeg?: number; posNoiseM?: number; drop?: [number, number] } = {}) {
  const r = rng(7);
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let px = 0;
  let py = 0;
  const end = keys[keys.length - 1][0];
  for (let s = 0; s <= end + 1e-9; s += 0.2) {
    const k = Math.max(0, keys.findIndex((q, i) => i < keys.length - 1 && s >= q[0] && s <= keys[i + 1][0]));
    const [t0, h0, v0] = keys[k];
    const [t1, h1, v1] = keys[Math.min(k + 1, keys.length - 1)];
    const f = t1 > t0 ? (s - t0) / (t1 - t0) : 0;
    const hdg = h0 + wrap180(h1 - h0) * f + (opts.noiseDeg ?? 0) * r();
    const v = (v0 + (v1 - v0) * f) / MS_TO_KN;
    const [dx, dy] = bearingVec(hdg);
    px += dx * v * 0.2;
    py += dy * v * 0.2;
    if (opts.drop && s > opts.drop[0] && s < opts.drop[1]) continue;
    t.push(s * 1000);
    x.push(px + (opts.posNoiseM ?? 0) * r());
    y.push(py + (opts.posNoiseM ?? 0) * r());
  }
  return { t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y) };
}

const NORTH = (): number => 0;
const STBD = 320; // close-hauled starboard: TWA +40
const PORT = 40; // close-hauled port: TWA −40
const RUN_STBD = 220; // TWA +140
const RUN_PORT = 140; // TWA −140

/** A beat: `n` tacks, 60 s legs between them, 4 s turns. */
function beat(n: number, kn = 6): Key[] {
  const keys: Key[] = [[0, STBD, kn]];
  let t = 0;
  let h = STBD;
  for (let i = 0; i < n; i++) {
    t += 60;
    keys.push([t, h, kn]);
    h = h === STBD ? PORT : STBD;
    t += 4;
    keys.push([t, h, kn * 0.7]);
  }
  keys.push([t + 60, h, kn]);
  return keys;
}
const count = (ms: Manoeuvre[], kind: Manoeuvre['kind']): number => ms.filter((m) => m.kind === kind).length;
const run = (keys: Key[], opts?: Parameters<typeof sail>[1]): Manoeuvre[] => {
  const tr = sail(keys, opts);
  return detectManoeuvres(tr, NORTH, 0, tr.t[tr.t.length - 1]);
};

describe('manoeuvre tunables', () => {
  it('are the documented values', () => {
    expect([MAN_TWA_MIN, MAN_TWA_MAX, MAN_DWELL_MS, MAN_MIN_SOG_KN, MAN_GAP_MS, MAN_ROUNDING_MS]).toEqual([20, 160, 10_000, 1.5, 5_000, 15_000]);
  });
});

describe('signedTwa', () => {
  it('is + on starboard, − on port, from the course over ground', () => {
    const { twa, sog } = signedTwa(sail([[0, STBD, 6], [30, STBD, 6]]), NORTH);
    expect(twa[50]).toBeCloseTo(40, 6);
    expect(sog[50]).toBeCloseTo(6, 6);
    expect(signedTwa(sail([[0, PORT, 6], [30, PORT, 6]]), NORTH).twa[50]).toBeCloseTo(-40, 6);
  });
});

describe('detectManoeuvres on synthetic tracks', () => {
  it('counts every tack of a clean zig-zag beat, at the head-to-wind crossing', () => {
    const ms = run(beat(6));
    expect(count(ms, 'tack')).toBe(6);
    expect(count(ms, 'gybe')).toBe(0);
    // Each turn is 4 s starting at 60, 124, …: through head-to-wind half-way.
    ms.forEach((m, i) => expect(Math.abs(m.tMs / 1000 - (60 + 64 * i + 2))).toBeLessThan(1.5));
    expect(ms.every((m) => !m.gap)).toBe(true);
  });

  it('still counts N with heading noise, GPS jitter and luffs near head-to-wind', () => {
    const keys = beat(5);
    // Luffs on the first starboard stretch: up to TWA +8 for 3 s, and briefly through to −6 for 2 s.
    keys.splice(1, 0, [20, STBD, 6], [22, 352, 4], [25, 352, 4], [27, STBD, 6], [40, STBD, 6], [42, 6, 3], [44, 6, 3], [46, STBD, 6]);
    const ms = run(keys, { noiseDeg: 14, posNoiseM: 1 });
    expect(count(ms, 'tack')).toBe(5);
    expect(count(ms, 'gybe')).toBe(0);
  });

  it('counts gybes on a run, and no tacks', () => {
    const keys: Key[] = [[0, RUN_STBD, 8], [50, RUN_STBD, 8], [55, RUN_PORT, 7], [105, RUN_PORT, 8], [110, RUN_STBD, 7], [160, RUN_STBD, 8], [165, RUN_PORT, 7], [215, RUN_PORT, 8]];
    const ms = run(keys, { noiseDeg: 10 });
    expect(count(ms, 'gybe')).toBe(3);
    expect(count(ms, 'tack')).toBe(0);
  });

  it('a windward-mark bear-away on the same side is no manoeuvre', () => {
    expect(run([[0, STBD, 6], [60, STBD, 6], [68, 210, 7], [130, 210, 8]])).toEqual([]);
    // Nor rounding up at the leeward mark on the same side.
    expect(run([[0, RUN_PORT, 8], [60, RUN_PORT, 8], [68, PORT, 6], [130, PORT, 6]])).toEqual([]);
  });

  it('a gybe-set at the windward mark is one gybe', () => {
    const ms = run([[0, STBD, 6], [60, STBD, 6], [65, 200, 7], [70, RUN_PORT, 8], [130, RUN_PORT, 8]]);
    expect(ms.map((m) => m.kind)).toEqual(['gybe']);
  });

  it('a penalty turn (a full circle back to the same side) is no manoeuvre', () => {
    const keys: Key[] = [[0, STBD, 6], [60, STBD, 6]];
    for (let k = 1; k <= 8; k++) keys.push([60 + k * 1.5, STBD + k * 45, 4]);
    keys.push([140, STBD, 6]);
    expect(run(keys)).toEqual([]);
  });

  it('a boat drifting below the speed floor never changes side', () => {
    const keys: Key[] = [[0, STBD, 1], [30, STBD, 1], [34, PORT, 1], [64, PORT, 1], [68, STBD, 1], [100, STBD, 1]];
    expect(run(keys)).toEqual([]);
  });

  it('counts a tack across a telemetry gap, flagged approximate', () => {
    // The tack turns 60–64 s; the track is missing from 57 to 70 s.
    const ms = run(beat(1), { drop: [57, 70] });
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'tack', gap: true });
  });

  it('uses the track before `from` to know the side, and only counts from `from` on', () => {
    const tr = sail(beat(2));
    // Window opening 10 s before the first tack: the side held before it is known from the lead-in.
    expect(detectManoeuvres(tr, NORTH, 52_000, tr.t[tr.t.length - 1]).map((m) => m.kind)).toEqual(['tack', 'tack']);
    // Window opening after the first tack: only the second.
    expect(detectManoeuvres(tr, NORTH, 70_000, tr.t[tr.t.length - 1])).toHaveLength(1);
  });

  it('uses the wind at each time', () => {
    // Steady heading 0 while the wind swings from 330° (TWA −30, port) to 30° (TWA +30, starboard): a change of side with no turn of the boat.
    const tr = sail([[0, 0, 6], [200, 0, 6]]);
    const swing = (t: number): number => (t < 100_000 ? 330 : 30);
    expect(detectManoeuvres(tr, swing, 0, 200_000).map((m) => m.kind)).toEqual(['tack']);
  });
});

describe('manoeuvresByLeg', () => {
  const kinds: LegKind[] = ['upwind', 'downwind', 'upwind'];
  const bounds = [0, 300_000, 600_000, 900_000];
  const m = (kind: Manoeuvre['kind'], s: number, gap = false): Manoeuvre => ({ kind, tMs: s * 1000, gap });

  it('counts each leg by the crossing time', () => {
    const out = manoeuvresByLeg([m('tack', 50), m('tack', 200), m('gybe', 400), m('tack', 700, true)], bounds, kinds);
    expect(out).toEqual([
      { tacks: 2, gybes: 0, gap: false },
      { tacks: 0, gybes: 1, gap: false },
      { tacks: 1, gybes: 0, gap: true },
    ]);
  });

  it('gives a gybe-set just before the windward mark boundary to the run, a tack just after it to the beat', () => {
    const out = manoeuvresByLeg([m('gybe', 295), m('tack', 305)], bounds, kinds);
    expect(out[0]).toEqual({ tacks: 1, gybes: 0, gap: false });
    expect(out[1]).toEqual({ tacks: 0, gybes: 1, gap: false });
  });

  it('keeps a manoeuvre in its own leg beyond the rounding window, or when it suits it', () => {
    const out = manoeuvresByLeg([m('gybe', 250), m('tack', 330), m('gybe', 310)], bounds, kinds);
    expect(out[0]).toEqual({ tacks: 0, gybes: 1, gap: false });
    expect(out[1]).toEqual({ tacks: 1, gybes: 1, gap: false });
  });

  it('skips legs with unknown ends and manoeuvres outside every leg', () => {
    const out = manoeuvresByLeg([m('tack', 50), m('tack', 1000)], [0, null, 600_000, 900_000], kinds);
    expect(out).toEqual([null, null, { tacks: 0, gybes: 0, gap: false }]);
  });

  it('counts a manoeuvre at the last reached bound (a DNF at the mark) and at the finish', () => {
    // DNF after the first rounding: the gybe-set sits on that bound, which used to be dropped.
    expect(manoeuvresByLeg([m('gybe', 300)], [0, 300_000, null, null], kinds)).toEqual([{ tacks: 0, gybes: 1, gap: false }, null, null]);
    expect(manoeuvresByLeg([m('tack', 900)], bounds, kinds)[2]).toEqual({ tacks: 1, gybes: 0, gap: false });
  });
});

describe('tacks and gybes on the fixtures', () => {
  const j70 = analyzeRace(fixtureRace());
  const byLeg = (a: ReturnType<typeof analyzeRace>, sail: string): string[] =>
    a.boats.find((b) => b.sail === sail)!.legs.map((l) => (l ? `${l.tacks}T ${l.gybes}G` : '—'));

  // Verified against signed-TWA timelines of the tracks (see the summary in the phase notes).
  it('Benelux J70 r8: #5 and #4 by leg', () => {
    expect(byLeg(j70, '5')).toEqual(['4T 0G', '0T 3G', '3T 0G', '0T 1G']);
    expect(byLeg(j70, '4')).toEqual(['2T 0G', '0T 2G', '2T 0G', '0T 2G']);
    // Full-rate track: nothing bridges a gap.
    expect(j70.boats.every((b) => b.legs.every((l) => l && !l.manoeuvreGap))).toBe(true);
  });

  it('C31 r10: FRA 901 tacks twice on Beat 2 with clean data, and Beat 1 tacks across holes are flagged', () => {
    const a = analyzeRace(c31Race());
    const b = a.boats.find((x) => x.sail === 'FRA 901')!;
    expect(b.legs[2]).toMatchObject({ tacks: 2, gybes: 0, manoeuvreGap: false });
    expect(b.legs[0]).toMatchObject({ tacks: 4, gybes: 0, manoeuvreGap: true });
  });

  it.each([
    ['Benelux J70', j70],
    ['C31', analyzeRace(c31Race())],
    ['Melges 24', analyzeRace(m24Race())],
    ['J/88', analyzeRace(j88Race())],
  ])('%s: tacks upwind, gybes downwind', (_n, a) => {
    for (const leg of a.legs) {
      const ls = a.boats.map((b) => b.legs[leg.index]).filter((l) => l != null);
      if (leg.kind === 'upwind') {
        expect(ls.filter((l) => l.tacks >= 1).length).toBeGreaterThanOrEqual(0.75 * ls.length);
        // A gybe on a beat is rare (bearing off onto port at the start): at most one a boat.
        expect(ls.every((l) => l.gybes <= 1)).toBe(true);
      } else if (leg.kind === 'downwind') {
        expect(ls.every((l) => l.tacks === 0)).toBe(true);
        // About a gybe a boat, where the track is there to see them (the C31 runs are mostly holes).
        const seen = ls.filter((l) => l.coverage >= 0.5);
        expect(seen.reduce((s, l) => s + l.gybes, 0)).toBeGreaterThanOrEqual(seen.length);
      }
    }
  });
});
