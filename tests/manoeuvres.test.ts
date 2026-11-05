import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { bearingVec, MS_TO_KN, wrap180 } from '../src/analysis/geo';
import {
  MAN_DWELL_MS,
  MAN_GAP_MS,
  MAN_GAP_SHORT_DWELL_MS,
  MAN_HEEL_DWELL_MS,
  MAN_HEEL_GAP_FIXES,
  MAN_HEEL_MERGE_MS,
  MAN_HEEL_ROLL_DEG,
  MAN_HEEL_TWA_MS,
  MAN_MIN_SOG_KN,
  MAN_ROUNDING_MS,
  MAN_TWA_MAX,
  MAN_TWA_MIN,
  MAN_UPWIND_DEG,
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

interface SailOpts {
  noiseDeg?: number;
  posNoiseM?: number;
  /** Fixes missing strictly inside each window, s. */
  drop?: [number, number] | [number, number][];
  /** Only one fix every `everyS` inside [from, to) (each alone between gaps: no course over ground), s. */
  sparse?: [number, number, number];
  /** Carry the device heading and SOG (with `hdgOffDeg` added: a compass off the course). */
  heading?: boolean;
  hdgOffDeg?: number;
  /** Carry roll: this much heel to leeward close-hauled (− = to port on starboard tack), through 0 head to wind / dead downwind. */
  rollDeg?: number;
  /** Inside [from, to) s the boat makes good this course over ground while the heading keeps the keyframes (a set, or a wind estimate off). */
  cog?: [number, number, number];
}

/** A 5 Hz track sailing the keyframes from (0, 0); wind from north (TWD 0), so TWA = −heading. */
function sail(keys: Key[], opts: SailOpts = {}) {
  const r = rng(7);
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const heading: number[] = [];
  const sog: number[] = [];
  const roll: number[] = [];
  const drops = opts.drop == null ? [] : typeof opts.drop[0] === 'number' ? [opts.drop as [number, number]] : (opts.drop as [number, number][]);
  let px = 0;
  let py = 0;
  const end = keys[keys.length - 1][0];
  for (let s = 0; s <= end + 1e-9; s += 0.2) {
    const k = Math.max(0, keys.findIndex((q, i) => i < keys.length - 1 && s >= q[0] && s <= keys[i + 1][0]));
    const [t0, h0, v0] = keys[k];
    const [t1, h1, v1] = keys[Math.min(k + 1, keys.length - 1)];
    const f = t1 > t0 ? (s - t0) / (t1 - t0) : 0;
    const hdg = h0 + wrap180(h1 - h0) * f + (opts.noiseDeg ?? 0) * r();
    const kn = v0 + (v1 - v0) * f;
    const v = kn / MS_TO_KN;
    const [dx, dy] = bearingVec(opts.cog && s >= opts.cog[0] && s < opts.cog[1] ? opts.cog[2] : hdg);
    px += dx * v * 0.2;
    py += dy * v * 0.2;
    if (drops.some(([a, b]) => s > a && s < b)) continue;
    const sp = opts.sparse;
    if (sp && s >= sp[0] && s < sp[1] && Math.abs(((s - sp[0] + 1e-6) % sp[2]) - 1e-6) > 0.1) continue;
    t.push(s * 1000);
    x.push(px + (opts.posNoiseM ?? 0) * r());
    y.push(py + (opts.posNoiseM ?? 0) * r());
    heading.push((((hdg + (opts.hdgOffDeg ?? 0)) % 360) + 360) % 360);
    sog.push(kn);
    // Heeled to leeward upwind and down: sign follows the side (TWA = −heading), fading through head to wind / dead downwind.
    const w = wrap180(hdg);
    roll.push((opts.rollDeg ?? 0) * Math.sign(w) * Math.min(1, Math.min(Math.abs(w), 180 - Math.abs(w)) / 20));
  }
  const f64 = (a: number[]) => Float64Array.from(a);
  return {
    t: f64(t),
    x: f64(x),
    y: f64(y),
    ...(opts.heading ? { heading: f64(heading), sog: f64(sog) } : {}),
    ...(opts.rollDeg != null ? { roll: f64(roll) } : {}),
  };
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
const run = (keys: Key[], opts?: SailOpts): Manoeuvre[] => {
  const tr = sail(keys, opts);
  return detectManoeuvres(tr, NORTH, 0, tr.t[tr.t.length - 1]);
};

describe('manoeuvre tunables', () => {
  it('are the documented values', () => {
    expect([MAN_TWA_MIN, MAN_TWA_MAX, MAN_DWELL_MS, MAN_MIN_SOG_KN, MAN_GAP_MS, MAN_ROUNDING_MS]).toEqual([20, 160, 10_000, 1.5, 5_000, 15_000]);
    expect([MAN_GAP_SHORT_DWELL_MS, MAN_HEEL_ROLL_DEG, MAN_HEEL_DWELL_MS, MAN_HEEL_MERGE_MS, MAN_HEEL_TWA_MS]).toEqual([3_000, 5, 3_000, 15_000, 10_000]);
    expect([MAN_UPWIND_DEG, MAN_HEEL_GAP_FIXES]).toEqual([90, 2]);
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

describe('detectManoeuvres across holes', () => {
  const kinds = (ms: Manoeuvre[]) => ms.map((m) => [m.kind, m.gap]);
  // Starboard, a tack onto port at 60–64 s, port held clear until the feed drops out at 70 s for 280 s; back on starboard after.
  const hole1513: Key[] = [[0, STBD, 6], [60, STBD, 6], [64, PORT, 4.2], [68, PORT, 6], [200, PORT, 6], [204, STBD, 4.2], [208, STBD, 6], [420, STBD, 6]];

  it('a side held MAN_GAP_SHORT_DWELL_MS up to a long hole counts: both tacks (#1513)', () => {
    // The tack into the short dwell is seen in clean data; the one out of it bridges the hole.
    expect(kinds(run(hole1513, { drop: [70, 350] }))).toEqual([['tack', false], ['tack', true]]);
    // The same with heading and roll on the track.
    expect(kinds(run(hole1513, { drop: [70, 350], heading: true, rollDeg: 15 }))).toEqual([['tack', false], ['tack', true]]);
  });

  it('a side held less than MAN_GAP_SHORT_DWELL_MS before the hole is still no side', () => {
    // Port clear for a second or so: no tack either way (and with no heel to tell, nothing recovers it).
    expect(run(hole1513, { drop: [64, 350] })).toEqual([]);
  });

  it('a finite course with no clear side through the tack: the device heading shows it (#1513, race 8)', () => {
    // The course makes good 358° (TWA +2) from just before the tack through the short port hold; the heading shows starboard → port.
    const opts: SailOpts = { drop: [70, 350], cog: [58, 70, 358] };
    expect(run(hole1513, opts)).toEqual([]);
    expect(kinds(run(hole1513, { ...opts, heading: true }))).toEqual([['tack', false], ['tack', true]]);
    // Not from a compass the caller knows is bad.
    const tr = sail(hole1513, { ...opts, heading: true });
    expect(detectManoeuvres(tr, NORTH, 0, tr.t[tr.t.length - 1], { headingSource: 'cog' })).toEqual([]);
  });

  // Starboard, then fixes 7 s apart (each alone: no course over ground) through a tack onto port and back, then dense on starboard.
  const sparse16: Key[] = [[0, STBD, 6], [120, STBD, 6], [124, PORT, 4.2], [128, PORT, 6], [220, PORT, 6], [224, STBD, 4.2], [228, STBD, 6], [360, STBD, 6]];
  const sparse = [60, 300, 7] as [number, number, number];

  it('sparse fixes with no course over ground: the device heading shows the tacks (#16)', () => {
    // Course only: starboard both ends, nothing in between.
    expect(run(sparse16, { sparse })).toEqual([]);
    const ms = run(sparse16, { sparse, heading: true });
    expect(kinds(ms)).toEqual([['tack', true], ['tack', true]]);
    expect(Math.abs(ms[0].tMs / 1000 - 122)).toBeLessThan(7);
    expect(Math.abs(ms[1].tMs / 1000 - 222)).toBeLessThan(7);
  });

  it('…but not from a compass headingCheck finds far off the course', () => {
    expect(run(sparse16, { sparse, heading: true, hdgOffDeg: 115 })).toEqual([]);
    // Nor when the caller already knows (analyze.ts: its heading is then the course).
    const tr = sail(sparse16, { sparse, heading: true });
    expect(detectManoeuvres(tr, NORTH, 0, 360_000, { headingSource: 'cog' })).toEqual([]);
    expect(detectManoeuvres(tr, NORTH, 0, 360_000, { headingSource: 'device' })).toHaveLength(2);
  });

  it('heading-only fixes slower than the speed floor (device SOG) never change side', () => {
    const slow: Key[] = sparse16.map(([t, h, v]) => [t, h, t >= 60 && t < 300 ? 1 : v]);
    expect(run(slow, { sparse, heading: true })).toEqual([]);
  });

  // Starboard, a tack at 100–104 s into a hole, then fixes 7 s apart on port to the end: the course never sees port.
  const heelOnly: Key[] = [[0, STBD, 6], [100, STBD, 6], [104, PORT, 4.2], [108, PORT, 6], [260, PORT, 6]];

  it('heel either side of a hole recovers a tack the course is blind to', () => {
    expect(run(heelOnly, { drop: [101, 170], sparse: [170, 270, 7] })).toEqual([]);
    const ms = run(heelOnly, { drop: [101, 170], sparse: [170, 270, 7], rollDeg: 15 });
    expect(kinds(ms)).toEqual([['tack', true]]);
    expect(ms[0].tMs / 1000).toBeGreaterThan(100);
    expect(ms[0].tMs / 1000).toBeLessThan(170);
  });

  it('heel never makes a gybe, nor a tack downwind', () => {
    const gybe: Key[] = [[0, RUN_STBD, 8], [100, RUN_STBD, 8], [104, RUN_PORT, 7], [108, RUN_PORT, 8], [260, RUN_PORT, 8]];
    expect(run(gybe, { drop: [101, 170], sparse: [170, 270, 7], rollDeg: 10 })).toEqual([]);
  });

  // Port close-hauled into a hole that starts while still upwind (TWA about −65); out of it on a starboard run, heeled the other way.
  const markHole = (runHdg: number): Key[] => [[0, PORT, 6], [100, PORT, 6], [104, 100, 7], [108, 180, 8], [112, runHdg, 8], [300, runHdg, 8]];

  it('upwind into a hole and out of it on a run is a gybe, never a tack (windward-mark bear-away, #326 / #380 / #16 race 8)', () => {
    // TWA +110 after: the shortest turn (−65 → +110) is through head to wind, but a beat → run across the hole is a bear-away.
    for (const opts of [{}, { heading: true }, { heading: true, rollDeg: 12 }] as SailOpts[]) {
      const ms = run(markHole(250), { drop: [102, 240], ...opts });
      expect(kinds(ms)).toEqual([['gybe', true]]);
      // The windward mark inside the hole: no tack on the beat, the gybe on the run.
      expect(manoeuvresByLeg(ms, [0, 170_000, 300_000], ['upwind', 'downwind'])).toEqual([
        { tacks: 0, gybes: 0, gap: false },
        { tacks: 0, gybes: 1, gap: true },
      ]);
    }
    // Sparse heading-only fixes on the run, the heel flipped: still the one gybe.
    expect(kinds(run(markHole(250), { drop: [102, 240], sparse: [240, 300, 7], heading: true, rollDeg: 12 }))).toEqual([['gybe', true]]);
  });

  it('a heel flip with the heading downwind on one side is no tack, even where the heading is too unclear to give a side', () => {
    // Out of the hole dead downwind (TWA +170: no side from the heading, no course on the sparse fixes), heeled to port.
    expect(run(markHole(190), { drop: [102, 240], sparse: [240, 300, 7], heading: true, rollDeg: 12 })).toEqual([]);
  });

  it('one heeled fix out of a hole is no heel side; MAN_HEEL_GAP_FIXES in a row are', () => {
    // Starboard, a tack onto port and back inside a long hole, which shows the port heel for one fix (or three) in the middle.
    const keys: Key[] = [[0, STBD, 6], [100, STBD, 6], [104, PORT, 4.2], [108, PORT, 6], [150, PORT, 6], [154, STBD, 4.2], [158, STBD, 6], [300, STBD, 6]];
    expect(run(keys, { drop: [[101, 139.9], [140.1, 200]], rollDeg: 15 })).toEqual([]);
    expect(kinds(run(keys, { drop: [[101, 139.9], [140.5, 200]], rollDeg: 15 }))).toEqual([['tack', true], ['tack', true]]);
  });

  it('a heading-only fix with an unclear TWA is no sample: it neither holds a side nor breaks one', () => {
    // #16's shape with every other port fix pinched to TWA −15 (heading 15°): no two clear port fixes in a row.
    const pinched: Key[] = [[0, STBD, 6], [120, STBD, 6], [124, PORT, 4.2], [128, PORT, 6]];
    for (let s = 130; s <= 214; s += 14) pinched.push([s - 1, PORT, 6], [s, 15, 6], [s + 1, PORT, 6]);
    pinched.push([220, PORT, 6], [224, STBD, 4.2], [228, STBD, 6], [360, STBD, 6]);
    expect(run(pinched, { sparse })).toEqual([]);
    expect(kinds(run(pinched, { sparse, heading: true }))).toEqual([['tack', true], ['tack', true]]);
  });

  it('heel and course on the same tack across a hole: one tack', () => {
    // Dense on port after the hole: the course counts the tack, the heel flip is that tack.
    const ms = run(heelOnly, { drop: [101, 170], rollDeg: 15 });
    expect(kinds(ms)).toEqual([['tack', true]]);
    expect(run(hole1513, { drop: [70, 350], rollDeg: 15, heading: true })).toHaveLength(2);
    // One fix inside the hole near head to wind (TWA −10: no course sample) still heeled to port: the course times the
    // tack across the whole hole, well before the heel flip, and it is still that one tack (#380, race 8).
    const pinch: Key[] = [[0, PORT, 6], [195, PORT, 6], [200, 10, 6], [230, STBD, 6], [360, STBD, 6]];
    expect(kinds(run(pinch, { drop: [[101, 199.9], [200.1, 250]], rollDeg: 15, heading: true }))).toEqual([['tack', true]]);
  });

  it('a clean zig-zag with roll and heading counts each tack once, none approximate', () => {
    const ms = run(beat(6), { rollDeg: 15, heading: true });
    expect(count(ms, 'tack')).toBe(6);
    expect(count(ms, 'gybe')).toBe(0);
    expect(ms.every((m) => !m.gap)).toBe(true);
    // Noisy, with luffs that flip the heel briefly.
    const keys = beat(5);
    keys.splice(1, 0, [20, STBD, 6], [22, 352, 4], [25, 352, 4], [27, STBD, 6], [40, STBD, 6], [42, 6, 3], [44, 6, 3], [46, STBD, 6]);
    expect(count(run(keys, { noiseDeg: 14, posNoiseM: 1, rollDeg: 15, heading: true }), 'tack')).toBe(5);
  });

  it('where the course sees both sides, heel adds nothing: a tack and straight back is the course’s call', () => {
    // Port for 5 s in clean data: under MAN_DWELL_MS, so no side, though the heel holds each side MAN_HEEL_DWELL_MS.
    const keys: Key[] = [[0, STBD, 6], [60, STBD, 6], [64, PORT, 4.2], [69, PORT, 5], [73, STBD, 4.2], [140, STBD, 6]];
    expect(run(keys, { rollDeg: 15, heading: true })).toEqual([]);
  });

  it('a gybe-set and a leeward-mark rounding with roll are no extra tack', () => {
    expect(run([[0, STBD, 6], [60, STBD, 6], [65, 200, 7], [70, RUN_PORT, 8], [130, RUN_PORT, 8]], { rollDeg: 15, heading: true }).map((m) => m.kind)).toEqual(['gybe']);
    expect(run([[0, 180, 7], [60, 180, 7], [66, PORT, 5], [130, PORT, 6]], { rollDeg: 8, heading: true })).toEqual([]);
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

  it('a turn across a gap goes to the leg that suits it if the gap reaches within MAN_ROUNDING_MS of the boundary', () => {
    // A tack placed 40 s into the run, but anywhere from 10 s before the mark to 60 s after it.
    const span = (a: number, b: number) => ({ kind: 'tack' as const, tMs: 340_000, gap: true, span: [a * 1000, b * 1000] as [number, number] });
    expect(manoeuvresByLeg([span(290, 360)], bounds, kinds)[0]).toEqual({ tacks: 1, gybes: 0, gap: true });
    // A gap that starts well after the mark: it stays (a tack on the run).
    expect(manoeuvresByLeg([span(320, 360)], bounds, kinds)[1]).toEqual({ tacks: 1, gybes: 0, gap: true });
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

  it('C31 r10: FRA 901 tacks twice on Beat 2 with clean data, twice more across its holes, and Beat 1 tacks across holes are flagged', () => {
    const a = analyzeRace(c31Race());
    const b = a.boats.find((x) => x.sail === 'FRA 901')!;
    // 4, was 2: after its two clean tacks, heading 272° → 4° → 340° → 243° (roll −11 → +8 → +11 → −12) across 64 s and 46 s holes.
    expect(b.legs[2]).toMatchObject({ tacks: 4, gybes: 0, manoeuvreGap: true });
    // 3, was 4: port (TWA −41) into an 809 s hole across the windward mark, out on a starboard run (TWA +138): a gybe on the run now.
    expect(b.legs[0]).toMatchObject({ tacks: 3, gybes: 0, manoeuvreGap: true });
    expect(b.legs[1]).toMatchObject({ tacks: 0, gybes: 1, manoeuvreGap: true });
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
