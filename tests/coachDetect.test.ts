import { describe, expect, it } from 'vitest';
import type { CoachModel } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { type CoachCtx } from '../src/analysis/coach/detectors/context';
import { detectAngles, legAngles } from '../src/analysis/coach/detectors/angles';
import { D3_GAP_S, detectEarly } from '../src/analysis/coach/detectors/early';
import { D10_AHEAD_S, detectLastLeg, meanSogKn } from '../src/analysis/coach/detectors/lastLeg';
import { detectRolled } from '../src/analysis/coach/detectors/rolled';
import { D1_LATE_S, detectStart, startOrder } from '../src/analysis/coach/detectors/start';
import { inferLegSpans, ladderAt, legEnd, type Course, type GapPoint } from '../src/analysis/coach/ladder';
import {
  MIN_SECONDS,
  NOISE_BASE_S,
  coachCoverage,
  confidenceOf,
  covLevel,
  gapChange,
  gapNoise,
  windOkShare,
  type Opportunity,
} from '../src/analysis/coach/opportunity';
import { TOP_N, overlapMs, rankOpportunities, type Card } from '../src/analysis/coach/rank';
import { trackLegAt, type CoachTrack } from '../src/analysis/coach/tracks';
import { MS_TO_KN, bearingVec, type Vec } from '../src/analysis/geo';
import type { BoatResult, LegKind, RaceAnalysis, StartResult } from '../src/analysis/types';
import { cardHtml, cardText, cardWarnings, coachCardsHtml, fewerLine, goodTexts, secondsChip, windowChip } from '../src/ui/coachCards';

/**
 * A synthetic race: wind from 0° (north) all race, a 2 km beat north from the line at y = 0 and a run
 * back; the gun at GUN. Boats sail fixed angles at fixed speeds, tacking (or gybing) every 60 s.
 */
const GUN = 1_000_000;
const BEAT_M = 2000;
const course: Course = { pts: [[0, 0], [0, BEAT_M], [0, 0]], kinds: ['upwind', 'downwind'] };
const wind = { twdAt: () => 0, taAt: () => 84, t: [GUN, GUN + 60_000], twd: [0, 0], ta: [84, 84], n: [99, 99], ok: [true, true] };

interface Sail {
  /** |TWA| on each leg, °. */
  twa: [number, number];
  /** SOG on each leg, kn. */
  kn: [number, number];
  /** Leg change (ms after the gun). */
  roundAt: number;
  end: number;
  stepMs?: number;
  x0?: number;
  /** Seconds after the gun of extra tacks / the start of each beat board. */
  boardS?: number;
  /** Holes: [from, to] ms after the gun with no fixes. */
  holes?: [number, number][];
  start?: number;
}

function sail(id: string, s: Sail): CoachTrack {
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let p: Vec = [s.x0 ?? 0, 0];
  const step = s.stepMs ?? 1000;
  const board = (s.boardS ?? 60) * 1000;
  for (let ms = s.start ?? 0; ms <= s.end; ms += step) {
    const leg = ms < s.roundAt ? 0 : 1;
    const side = Math.floor((leg ? ms - s.roundAt : ms) / board) % 2 ? 1 : -1;
    const heading = leg ? 180 - side * (180 - s.twa[1]) : side * s.twa[0];
    const v = s.kn[leg] / MS_TO_KN;
    if (!(s.holes ?? []).some(([a, b]) => ms > a && ms < b)) {
      t.push(GUN + ms);
      x.push(p[0]);
      y.push(p[1]);
    }
    const d = bearingVec(heading);
    p = [p[0] + (d[0] * v * step) / 1000, p[1] + (d[1] * v * step) / 1000];
  }
  return { id, t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y), bounds: [GUN, GUN + s.roundAt, GUN + s.end] };
}

const startOf = (o: Partial<StartResult>): StartResult =>
  ({ dtlM: 5, secsLate: 1, vToLineMs: 1, linePosPct: 50, speedKn: 6, headingDeg: 0, twaDeg: 40, bow: [0, 0], ocs: false, over: false, lateS: 1, dtlGapS: null, ...o }) as StartResult;

function boatOf(id: string, i: number, o: Partial<BoatResult> = {}): BoatResult {
  return {
    id,
    sail: id,
    name: `Boat ${id}`,
    colorSlot: i,
    finishPos: i + 1,
    finishMs: GUN + 3_000_000 + i * 10_000,
    raceTimeS: null,
    sogAvgKn: null,
    distM: null,
    distApprox: false,
    coverage: 1,
    maxGapS: 1,
    start: startOf({}),
    legs: [null, null],
    upwind: null,
    downwind: null,
    headingSource: 'device',
    headingOffDeg: null,
    ...o,
  };
}

interface World {
  boats: BoatResult[];
  tracks: CoachTrack[];
  crossMs?: Record<string, number | null> | null;
  kinds?: LegKind[];
  gaps?: CoachCtx['gaps'];
}

function world(w: World, boat = 'me'): { ctx: CoachCtx; a: RaceAnalysis; m: CoachModel } {
  const kinds = w.kinds ?? course.kinds;
  const a = {
    meta: { gunMs: GUN, tzOffsetMs: -4 * 3_600_000, raceNumber: 1, division: 'X', boatClass: 'J/105', eventName: 'T', sourceLabel: '', sourceKind: '' },
    line: { left: [-150, 0], right: [150, 0], lengthM: 300, bearingDeg: 90, favored: 'square', favoredByM: 0 },
    legs: kinds.map((kind, i) => ({ index: i, name: kind === 'upwind' ? 'Beat 1' : 'Run 1', kind, to: 'X' })),
    legSource: 'course',
    marks: [],
    boats: w.boats,
    wind: { method: 'tacks', estimates: [], twdAtGunDeg: 0, model: null },
  } as unknown as RaceAnalysis;
  const m = {
    gunMs: GUN,
    endMs: GUN + 4_000_000,
    course: { ...course, kinds },
    wind,
    vmg: [2.5, 3],
    tracks: new Map(w.tracks.map((t) => [t.id, t])),
    windExcluded: [],
    crossMs: w.crossMs ?? null,
  } as unknown as CoachModel;
  const me = w.boats.find((b) => b.id === boat)!;
  const ctx: CoachCtx = {
    a,
    m,
    boat,
    me,
    tr: m.tracks.get(boat)!,
    gun: GUN,
    loaM: 10,
    leaders: w.boats.filter((b) => b.id !== boat && b.finishPos != null).sort((p, q) => p.finishPos! - q.finishPos!).slice(0, 3).map((b) => b.id),
    marksEstimated: false,
    gaps: w.gaps ?? (() => []),
    nameOf: (id) => `Boat ${id}`,
  };
  return { ctx, a, m };
}

/** Gap points every 5 s from `a` to `b` with the group gap `f(t)` (s after `a`) and per-boat gaps `each`. */
const ramp = (a: number, b: number, f: (s: number) => number | null, each: ((s: number) => number | null)[] = []): GapPoint[] => {
  const out: GapPoint[] = [];
  for (let t = a; t <= b; t += 5000) out.push({ tMs: t, behindS: f((t - a) / 1000), n: 3, each: each.map((g) => g((t - a) / 1000)), leg: 0 });
  return out;
};

const opp = (o: Partial<Opportunity>): Opportunity => ({
  kind: 'D3',
  variant: 'lane',
  t0: 0,
  t1: 100_000,
  seconds: 30,
  secondsLo: 25,
  secondsHi: 35,
  confidence: 'high',
  coverage: 1,
  conf: { boatCov: 1 },
  facts: {},
  refBoats: [],
  ...o,
});

describe('gap reads (spec §2)', () => {
  it('gapChange: a one-minute median at each end of the readable stretch', () => {
    const pts = ramp(0, 300_000, (s) => s / 10);
    const g = gapChange(pts, 0, 300_000)!;
    expect(g.g0).toBeCloseTo(3, 6); // median of 0…6 s
    expect(g.g1).toBeCloseTo(27, 6);
    expect(g.t0).toBe(0);
    expect(g.t1).toBe(300_000);
  });
  it('a noisy fix at the start does not move it; holes are skipped; under a minute of data is null', () => {
    const pts = ramp(0, 300_000, (s) => (s === 0 ? -40 : s > 100 && s < 200 ? null : 10));
    expect(gapChange(pts, 0, 300_000)!.g0).toBe(10);
    expect(gapChange(ramp(0, 50_000, () => 1), 0, 50_000)).toBeNull();
    expect(gapChange(ramp(0, 300_000, () => null), 0, 300_000)).toBeNull();
  });
  it('the noise model: ±5 s, + separation × 3° ÷ VMG, + 20 % of the untracked time', () => {
    expect(gapNoise(0, 2, 0).noise).toBe(NOISE_BASE_S);
    // 1 km apart at 2 m/s: 1000 × 3° in rad / 2 ≈ 26 s.
    expect(gapNoise(1000, 2, 0).windS).toBeCloseTo((1000 * 3 * Math.PI) / 180 / 2, 6);
    expect(gapNoise(0, 2, 50).noise).toBe(NOISE_BASE_S + 10);
  });
});

describe('confidence and gating (spec §5)', () => {
  it('coverage levels: ≥ 80 % high, 50–80 medium, 25–50 low, below suppressed', () => {
    expect([0.9, 0.8, 0.79, 0.5, 0.49, 0.25, 0.24].map(covLevel)).toEqual(['high', 'high', 'medium', 'medium', 'low', 'low', 'none']);
  });
  it('the lowest input wins, and says what capped it', () => {
    expect(confidenceOf({ boatCov: 0.9 })).toEqual({ level: 'high', limit: null });
    expect(confidenceOf({ boatCov: 0.58 })).toEqual({ level: 'medium', limit: 'data' });
    expect(confidenceOf({ boatCov: 0.9, refs: { good: 2, fair: 3, need: 3 } })).toEqual({ level: 'medium', limit: 'refs' });
    expect(confidenceOf({ boatCov: 0.9, refs: { good: 1, fair: 1, need: 3 } }).level).toBe('low');
    expect(confidenceOf({ boatCov: 0.9, windOk: 0.3 })).toEqual({ level: 'low', limit: 'wind' });
    expect(confidenceOf({ boatCov: 0.9, marksEstimated: true })).toEqual({ level: 'medium', limit: 'marks' });
    expect(confidenceOf({ boatCov: 0.1, marksEstimated: true }).level).toBe('none');
  });
  it('coach coverage reads fixes up to 15 s apart; wind minutes count near a measured one', () => {
    const t = [0, 10_000, 20_000, 60_000, 70_000];
    expect(coachCoverage(t, 0, 70_000)).toBeCloseTo(30 / 70, 6);
    expect(windOkShare({ t: [0, 60_000, 30 * 60_000], ok: [true, false, false] }, 0, 30 * 60_000)).toBeCloseTo(2 / 3, 6);
  });
});

describe('rank, dedupe, top 3 (spec §5)', () => {
  it('score = seconds × 1 / 0.7 / 0.4; minimum 10 / 20 / 30 s', () => {
    const cards = rankOpportunities([
      opp({ seconds: 40, conf: { boatCov: 0.6 }, t0: 0, t1: 10 }), // medium: 28
      opp({ seconds: 30, t0: 20, t1: 30 }), // high: 30
      opp({ seconds: 60, conf: { boatCov: 0.3 }, t0: 40, t1: 50 }), // low: 24
      opp({ seconds: 9, t0: 60, t1: 70 }), // high but under 10 s
      opp({ seconds: 19, conf: { boatCov: 0.6 }, t0: 80, t1: 90 }), // medium under 20 s
      opp({ seconds: 29, conf: { boatCov: 0.3 }, t0: 100, t1: 110 }), // low under 30 s
      opp({ seconds: 500, conf: { boatCov: 0.1 }, t0: 120, t1: 130 }), // suppressed
    ]);
    expect(cards.map((c) => [c.seconds, c.confidence])).toEqual([
      [30, 'high'],
      [40, 'medium'],
      [60, 'low'],
    ]);
    expect(cards[1].score).toBeCloseTo(28, 6);
    expect(cards[1].limit).toBe('data');
    expect(MIN_SECONDS).toEqual({ high: 10, medium: 20, low: 30, none: Infinity });
  });
  it('each race-second is claimed once: the loser loses the overlapped share and is re-scored', () => {
    const big = opp({ kind: 'D7', seconds: 60, t0: 0, t1: 100 });
    const small = opp({ kind: 'D10', seconds: 40, t0: 50, t1: 150 });
    const cards = rankOpportunities([small, big]);
    expect(cards.map((c) => c.kind)).toEqual(['D7', 'D10']);
    expect(cards[1].seconds).toBeCloseTo(20, 6);
    expect(cards[1].secondsHi).toBeCloseTo(35 / 2, 6);
    // Overlap counts a stretch held twice once, and windows of several spans.
    expect(overlapMs(opp({ spans: [[0, 10], [20, 30]] }), [opp({ t0: 5, t1: 25 }), opp({ t0: 0, t1: 8 })])).toBe(15);
  });
  it('a loser trimmed below its minimum drops out; ties go to the earlier window; at most 3', () => {
    expect(rankOpportunities([opp({ seconds: 50, t0: 0, t1: 100 }), opp({ seconds: 25, t0: 10, t1: 100 })])).toHaveLength(1);
    const tie = rankOpportunities([opp({ seconds: 30, t0: 500, t1: 600 }), opp({ seconds: 30, t0: 100, t1: 200 })]);
    expect(tie.map((c) => c.t0)).toEqual([100, 500]);
    const many = rankOpportunities([1, 2, 3, 4, 5].map((k) => opp({ seconds: 20 + k, t0: k * 1000, t1: k * 1000 + 10 })));
    expect(many).toHaveLength(TOP_N);
    expect(many.map((c) => c.seconds)).toEqual([25, 24, 23]);
  });
});

describe('D1 start position', () => {
  const crossMs = { me: GUN + 45_000, a: GUN + 2000, b: GUN + 4000, c: GUN + 6000, d: GUN + 8000, e: GUN + 10_000, f: GUN + 30_000, x: GUN - 3000 };
  const ids = Object.keys(crossMs);
  const tracks = ids.map((id) => sail(id, { twa: [42, 145], kn: [6, 6], roundAt: 600_000, end: 900_000 }));

  it('crossed more than 15 s after the front row (median of the 5 earliest clean crossings): seconds = the difference', () => {
    const boats = ids.map((id, i) => boatOf(id, i, id === 'x' ? { start: startOf({ over: true }) } : id === 'me' ? { start: startOf({ dtlM: 64 }) } : {}));
    const { ctx } = world({ boats, tracks, crossMs });
    const so = startOrder(ctx)!;
    expect(so.front.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']); // the early starter 'x' is not front row
    const r = detectStart(ctx);
    expect(r.fired).toBe(true);
    expect(r.opp!.variant).toBe('second-row'); // 64 m > 3 boatlengths
    expect(r.opp!.seconds).toBeCloseTo(39, 6); // 45 − median(2, 4, 6, 8, 10)
    expect(r.opp!.facts).toMatchObject({ crossRank: 8, n: 8, frontLo: 2, frontHi: 6, dtl: 64 });
    expect(r.opp!.t0).toBe(GUN - 10_000);
    expect(r.opp!.t1).toBe(crossMs.me);
  });

  it('close to the line and on time: no card, a ✓ start; just late: the "late" variant', () => {
    const boats = ids.map((id, i) => boatOf(id, i));
    const early = world({ boats, tracks, crossMs: { ...crossMs, me: GUN + 7000 } });
    const r = detectStart(early.ctx);
    expect(r.opp).toBeNull();
    expect(r.ok).toMatchObject({ kind: 'ok', detector: 'D1' });
    const late = detectStart(world({ boats, tracks, crossMs: { ...crossMs, me: GUN + (6 + D1_LATE_S + 1) * 1000 } }).ctx);
    expect(late.opp!.variant).toBe('late');
    // Without crossings (no raw fixes) a far-back start still fires on its DTL, with Recall's seconds late.
    const back = boats.map((b) => (b.id === 'me' ? { ...b, start: startOf({ dtlM: 60, lateS: 40 }) } : b));
    expect(detectStart(world({ boats: back, tracks, crossMs: null }).ctx).opp).toMatchObject({ seconds: 40, variant: 'second-row' });
  });
});

describe('D2 rolled at the gun (a chip, never a card)', () => {
  // Both start at y = 0; the neighbour 20 m to the right (windward on starboard, the boat end) and faster.
  const me = sail('me', { twa: [42, 145], kn: [4.4, 6], roundAt: 600_000, end: 300_000 });
  const fast = sail('n', { twa: [42, 145], kn: [7.5, 6], roundAt: 600_000, end: 300_000, x0: 20 });
  const boats = [boatOf('me', 0, { start: startOf({ speedKn: 4.4, linePosPct: 50, dtlM: 5, twaDeg: 40 }) }), boatOf('n', 1, { start: startOf({ speedKn: 7.5, linePosPct: 50 + (20 / 300) * 100, dtlM: 4 }) })];

  it('bow-level, 0.5–3 lengths to windward, ≥ 1/0.75 faster, a length gained by +60 s: the neighbour and both speeds', () => {
    const chip = detectRolled(world({ boats, tracks: [me, fast] }).ctx)!;
    expect(chip.kind).toBe('D2');
    expect(chip.facts).toMatchObject({ nbr: 'n', sog: 4.4, nbrSog: 7.5 });
    expect(chip.facts.nbrM as number).toBeCloseTo(20, 6);
    expect(chip.facts.gainM as number).toBeGreaterThan(10);
  });
  it('not to leeward, not two lengths back, not when similar speed', () => {
    const lee = boats.map((b) => (b.id === 'n' ? { ...b, start: startOf({ ...b.start!, linePosPct: 50 - (20 / 300) * 100 }) } : b));
    expect(detectRolled(world({ boats: lee, tracks: [me, fast] }).ctx)).toBeNull();
    const back = boats.map((b) => (b.id === 'n' ? { ...b, start: startOf({ ...b.start!, dtlM: 25 }) } : b));
    expect(detectRolled(world({ boats: back, tracks: [me, fast] }).ctx)).toBeNull();
    const same = boats.map((b) => (b.id === 'n' ? { ...b, start: startOf({ ...b.start!, speedKn: 5 }) } : b));
    expect(detectRolled(world({ boats: same, tracks: [me, fast] }).ctx)).toBeNull();
  });
});

describe('D3 early lane / tacks', () => {
  const crossMs = { me: GUN + 5000, a: GUN + 2000, b: GUN + 2000, c: GUN + 2000 };
  const straight = (id: string) => sail(id, { twa: [42, 145], kn: [6, 6], roundAt: 900_000, end: 900_000, boardS: 600 });
  const boats = ['me', 'a', 'b', 'c'].map((id, i) => boatOf(id, i));

  it('fires on the gap to the leaders over crossing → +5 min; seconds = that change; the "lane" variant', () => {
    const gaps = (_: string[], from: number, to: number) => ramp(from, to, (s) => s / 10);
    const o = detectEarly(world({ boats, tracks: boats.map((b) => straight(b.id)), crossMs, gaps }).ctx, { crossMs: crossMs.me, d1Fired: false }, null)!;
    expect(o.kind).toBe('D3');
    expect(o.variant).toBe('lane');
    expect(o.t0).toBe(crossMs.me);
    expect(o.t1).toBe(crossMs.me + 300_000);
    expect(o.seconds).toBeCloseTo(24, 6); // 27 − 3 (one-minute reads)
    expect(o.refBoats).toEqual(['a', 'b', 'c']);
    // Under D3_GAP_S and no tacks: nothing.
    const flat = (_: string[], from: number, to: number) => ramp(from, to, (s) => (s / 300) * (D3_GAP_S - 2));
    expect(detectEarly(world({ boats, tracks: boats.map((b) => straight(b.id)), crossMs, gaps: flat }).ctx, { crossMs: crossMs.me, d1Fired: false }, null)).toBeNull();
  });

  it('2 tacks before +4 min while the fleet holds on: fires with the "tacks" variant, D2 turns it into "slow-start"', () => {
    const tacker = sail('me', { twa: [42, 145], kn: [6, 6], roundAt: 900_000, end: 900_000, boardS: 70 });
    const gaps = (_: string[], from: number, to: number) => ramp(from, to, () => 2);
    const w = world({ boats, tracks: [tacker, ...['a', 'b', 'c'].map(straight)], crossMs, gaps });
    const o = detectEarly(w.ctx, { crossMs: crossMs.me, d1Fired: false }, null)!;
    expect(o.variant).toBe('tacks');
    expect(o.facts.tacks).toBeGreaterThanOrEqual(2);
    expect(o.facts.fleetTacks).toBe(0);
    const rolled = { kind: 'D2' as const, facts: { sog: 4.4, nbrSog: 7.5, nbrName: 'Relentless', nbrM: 20 } };
    const s = detectEarly(w.ctx, { crossMs: crossMs.me, d1Fired: false }, rolled)!;
    expect(s.variant).toBe('slow-start');
    expect(s.chips).toEqual([rolled]);
    // After a bad start (D1 fired) it isn't a "great start".
    expect(detectEarly(w.ctx, { crossMs: crossMs.me, d1Fired: true }, rolled)!.variant).toBe('tacks');
  });
});

describe('D6 / D7 matched windows', () => {
  const fleetIds = ['a', 'b', 'c', 'd', 'e'];
  const fleet = (twaUp = 42, knUp = 6.5, twaDn = 145, knDn = 6) => fleetIds.map((id, k) => sail(id, { twa: [twaUp, twaDn], kn: [knUp, knDn], roundAt: 900_000, end: 1_800_000, x0: k * 50 }));
  const boats = ['me', ...fleetIds].map((id, i) => boatOf(id, i, { legs: [{ startMs: GUN, endMs: GUN + 900_000, timeS: 900 } as never, { startMs: GUN + 900_000, endMs: GUN + 1_800_000, timeS: 900 } as never] }));

  it('pinching upwind: 37° at 5.6 kn vs 42° at 6.5 → high & slow, seconds = VMG deficit × leg time', () => {
    const me = sail('me', { twa: [37, 145], kn: [5.6, 6], roundAt: 900_000, end: 1_800_000 });
    const { ctx } = world({ boats, tracks: [me, ...fleet()] });
    const l = legAngles(ctx, 0)!;
    expect(l.boat.twa).toBeCloseTo(37, 0);
    expect(l.fleet.twa).toBeCloseTo(42, 0);
    const want = (6.5 * Math.cos((42 * Math.PI) / 180) - 5.6 * Math.cos((37 * Math.PI) / 180)) / (6.5 * Math.cos((42 * Math.PI) / 180));
    expect(l.deficit).toBeCloseTo(want, 2);
    expect(l.share).toBe(1);
    const r = detectAngles(ctx, 'upwind');
    expect(r.opp!.variant).toBe('high-slow');
    expect(r.opp!.seconds).toBeCloseTo(want * 900, -1);
    expect(r.ok).toBeNull();
  });

  it('level with the fleet upwind: no card, a ✓ chip with the angles', () => {
    const me = sail('me', { twa: [41, 145], kn: [6.5, 6], roundAt: 900_000, end: 1_800_000 });
    const r = detectAngles(world({ boats, tracks: [me, ...fleet()] }).ctx, 'upwind');
    expect(r.opp).toBeNull();
    expect(r.ok).toMatchObject({ detector: 'D6' });
    expect(goodTexts(r.ok!)[0]).toBe('Upwind pointing 41° vs fleet 42°');
  });

  it('too deep downwind: 160° at 3.8 vs 145° at 5 kn; the top 3 alongside; light air', () => {
    const me = sail('me', { twa: [42, 160], kn: [6.5, 3.8], roundAt: 900_000, end: 1_800_000 });
    const r = detectAngles(world({ boats, tracks: [me, ...fleet(42, 6.5, 145, 5)] }).ctx, 'downwind');
    expect(r.opp!.kind).toBe('D7');
    expect(r.opp!.variant).toBe('deep');
    expect(r.opp!.facts).toMatchObject({ wind: 'light', legs: 'Run 1' });
    expect(r.opp!.facts.tTwa as number).toBeCloseTo(145, 0);
    expect(r.opp!.facts.twa as number).toBeCloseTo(160, 0);
    const t = cardText({ ...r.opp!, score: 1, limit: null });
    expect(t.title).toBe('Too deep on the light-air run');
    expect(t.chips[0]).toBe('160° vs top-3 145°');
  });
});

describe('D10 last leg', () => {
  const boats = ['a', 'b', 'me', 'c'].map((id, i) => boatOf(id, i));
  const tracks = boats.map((b) => sail(b.id, { twa: [42, 145], kn: [6, 6], roundAt: 600_000, end: 1_200_000 }));
  for (const tr of tracks) tr.bounds = [GUN, GUN + 600_000, boats.find((b) => b.id === tr.id)!.finishMs];

  it('the gap to the boats 1–2 places ahead over the last leg; median seconds, the range from the least to the most', () => {
    const gaps = (ids: string[], from: number, to: number) =>
      ramp(from, to, () => 0, ids.map((id) => (s: number) => (id === 'a' ? s / 20 : s / 50)));
    const o = detectLastLeg(world({ boats, tracks, gaps }).ctx)!;
    expect(o.refBoats).toEqual(['a', 'b']);
    // The finish (a minute after the last fix) is in a gap: the last 6 tracked minutes.
    expect(o.facts.inGap).toBe(1);
    expect(o.t0).toBe(GUN + 1_200_000 - 6 * 60_000);
    expect(o.t1).toBe(GUN + 1_200_000);
    expect(o.facts.a).toBe('Boat a');
    expect(o.secondsHi).toBeGreaterThan(o.seconds);
    expect(o.secondsLo).toBeLessThan(o.seconds);
    expect(cardText({ ...o, score: 1, limit: null }).sentence).toMatch(/^Boat a pulled \d+ s and Boat b \d+ s further ahead over the last \d+ tracked minutes\.$/);
  });

  it('with the finish tracked, the window is the whole last leg', () => {
    const fin = boats.map((b) => (b.id === 'me' ? { ...b, finishMs: GUN + 1_200_000 } : { ...b, finishMs: GUN + 1_200_000 - 30_000 + b.colorSlot * 1000 }));
    const gaps = (ids: string[], from: number, to: number) => ramp(from, to, () => 0, ids.map(() => (s: number) => s / 20));
    const o = detectLastLeg(world({ boats: fin, tracks, gaps }).ctx)!;
    expect(o.facts.inGap).toBe(0);
    expect(o.t0).toBe(GUN + 600_000);
  });

  it('quiet when the boats ahead finished a minute or more ahead, or nobody pulled away', () => {
    const far = boats.map((b) => (b.id === 'a' || b.id === 'b' ? { ...b, finishMs: b.finishMs! - D10_AHEAD_S * 1000 } : b));
    const gaps = (ids: string[], from: number, to: number) => ramp(from, to, () => 0, ids.map(() => (s: number) => s / 10));
    expect(detectLastLeg(world({ boats: far, tracks, gaps }).ctx)).toBeNull();
    const none = (ids: string[], from: number, to: number) => ramp(from, to, () => 0, ids.map(() => () => 3));
    expect(detectLastLeg(world({ boats, tracks, gaps: none }).ctx)).toBeNull();
  });

  it('mean SOG never across a hole', () => {
    const tr = sail('z', { twa: [42, 145], kn: [6, 6], roundAt: 600_000, end: 300_000, holes: [[100_000, 200_000]] });
    expect(meanSogKn(tr, GUN, GUN + 300_000)!).toBeCloseTo(6, 1);
  });
});

describe('legs across lost roundings; the finish as a line', () => {
  it('inferLegSpans: forward from the gun while closing on the mark, back from the finish while closing on it', () => {
    // A beat to (0, 2000) for 600 s, a run back; a 10 min hole across the rounding; the rounding unknown.
    const tr = sail('h', { twa: [42, 145], kn: [6, 6], roundAt: 600_000, end: 1_200_000, holes: [[400_000, 1_000_000]] });
    tr.bounds = [GUN, null, GUN + 1_200_000];
    const spans = inferLegSpans(course, wind, tr);
    expect(spans.map((s) => s.leg)).toEqual([0, 1]);
    expect(spans[0].toMs).toBeLessThanOrEqual(GUN + 400_000);
    expect(spans[1].fromMs).toBeGreaterThanOrEqual(GUN + 1_000_000);
    tr.spans = spans;
    expect(trackLegAt(tr, GUN + 100_000)).toBe(0);
    expect(trackLegAt(tr, GUN + 700_000)).toBeNull();
    expect(trackLegAt(tr, GUN + 1_100_000)).toBe(1);
    expect(ladderAt(course, wind, tr, GUN + 1_100_000)?.leg).toBe(1);
  });
  it('legEnd: the last leg ends on the nearest point of the finish line', () => {
    const c: Course = { ...course, finish: { left: [-100, 0], right: [100, 0] } };
    expect(legEnd(c, 1, [60, 500])).toEqual([60, 0]);
    expect(legEnd(c, 1, [400, 500])).toEqual([100, 0]);
    expect(legEnd(c, 0, [60, 500])).toEqual([0, BEAT_M]);
  });
});

describe('templates and cards (spec §6, mockup)', () => {
  const card = (o: Partial<Card>): Card => ({ ...opp(o), score: 30, limit: null, ...o }) as Card;
  const a = world({ boats: [boatOf('me', 0)], tracks: [sail('me', { twa: [42, 145], kn: [6, 6], roundAt: 600_000, end: 900_000 })] }).a;

  it('seconds chip: ≈ mid, or the range when hi/lo > 2', () => {
    expect(secondsChip({ seconds: 30, secondsLo: 25, secondsHi: 35 })).toBe('≈ 30 s');
    expect(secondsChip({ seconds: 22, secondsLo: 10, secondsHi: 35 })).toBe('10–35 s');
  });
  it('window chip in the venue clock; legs when summed over several', () => {
    expect(windowChip(card({ t0: GUN + 60_000, t1: GUN + 180_000 }), a)).toMatch(/^\d\d:\d\d–\d\d:\d\d$/);
    expect(windowChip(card({ spans: [[0, 1], [2, 3]], facts: { legs: 'Run 1 + Run 2' } }), a)).toBe('Run 1 + Run 2');
  });
  it('D1 second-row and D3 slow-start read as the spec templates', () => {
    const d1 = cardText(card({ kind: 'D1', variant: 'second-row', seconds: 47, facts: { dtl: 64.4, crossS: 55.6, crossRank: 17, n: 18, frontLo: 5.8, frontHi: 8.6 } }));
    expect(d1.title).toBe('Second-row start');
    expect(d1.sentence).toBe('You were 64 m back at the gun and 17th of 18 over the line; the front row crossed 6–9 s after the gun.');
    expect(d1.chips).toEqual(['64 m back at gun', '17th of 18 over line', 'crossed +56 s']);
    expect(d1.tip).toBe('Set up closer and time the final approach; 64 m back costs about 47 s.');
    const d3 = cardText(
      card({ kind: 'D3', variant: 'slow-start', facts: { dtl: 4.9, tacks: 2, lastTackS: 168, gapEnd: 28.7, dgap: 29 }, chips: [{ kind: 'D2', facts: { sog: 4.36, nbrSog: 7.54, nbrName: 'Relentless', nbrM: 20.3 } }] }),
    );
    expect(d3.title).toBe('Slow off a great start');
    expect(d3.sentence).toBe('Front row but 4.4 kn at the gun; Relentless, bow-level 20 m to windward, rolled you at 7.5 kn and 2 early tacks left you 29 s off the top 3.');
    expect(d3.chips).toEqual(['5 m off at gun', '4.4 vs 7.5 kn Relentless', '2 tacks by 2:48']);
    for (const t of [d1, d3]) {
      expect(t.chips.length).toBeLessThanOrEqual(3);
      expect(t.title.split(/[ -]/).length).toBeGreaterThanOrEqual(3);
      expect(t.title.split(' ').length).toBeLessThanOrEqual(6);
      expect(t.sentence.match(/\. /g)).toBeNull(); // one sentence
    }
  });
  it('⚠ chips: medium names what capped it, low says so with the hole, wind est.', () => {
    expect(cardWarnings(card({ confidence: 'medium', limit: 'data', coverage: 0.58 }), a)).toEqual(['data 58%']);
    expect(cardWarnings(card({ confidence: 'medium', limit: 'marks' }), a)).toEqual(['marks est.']);
    expect(cardWarnings(card({ confidence: 'low', limit: 'data', conf: { boatCov: 0.3, hole: { fromMs: GUN + 13 * 60_000, toMs: GUN + 17 * 60_000 } } }), a)).toEqual([
      'low confidence',
      'no data 13–17 min',
    ]);
    expect(cardWarnings(card({ windEst: true }), a)).toEqual(['wind est.']);
  });
  it('cards, the "only N" line, the ✓ row, the no-data line', () => {
    const c = card({ kind: 'D1', variant: 'second-row', seconds: 47, secondsLo: 42, secondsHi: 52, facts: { dtl: 64, crossS: 56, crossRank: 17, n: 18, frontLo: 6, frontHi: 9 } });
    const html = cardHtml(c, 0, a, true);
    expect(html).toContain('class="card coach-opp on"');
    expect(html).toContain('<li class="chip sec" title="Seconds at stake">≈ 47 s</li>');
    expect(html).toMatch(/<button type="button" class="chip opp-when" data-opp="0" aria-pressed="true"/);
    expect(fewerLine(1)).toBe('Only 1 clear gain with this data');
    expect(fewerLine(2)).toBe('Only 2 clear gains with this data');
    const d = { cards: [c], ok: [{ kind: 'ok' as const, detector: 'D6' as const, variant: 'upwind', facts: { twa: 39, fTwa: 43, vmg: 5, fVmg: 4.7 }, t0: 0, t1: 1 }], plus: [], totalS: 47, raceCov: 0.4, noData: false, found: [c] };
    const all = coachCardsHtml(a, d, null, 0.27);
    expect(all).toContain('Only 1 clear gain with this data');
    expect(all).toContain('<li class="ok-lbl">Not the problem</li><li class="chip good">✓ Upwind pointing 39° vs fleet 43°</li>');
    const none = coachCardsHtml(a, { ...d, cards: [], ok: [], noData: true }, null, 0.15);
    expect(none).toContain('Not enough tracker data for a debrief');
    expect(none).toContain('tracker 15%');
    expect(none).not.toContain('coach-opp');
  });
});

describe('the whole-race gate', () => {
  it('under 25 % of the race and no window half covered: no cards, no chips', () => {
    // Fixes only in the first 10 min of a 60 min race, 30 s apart (unreadable), and nobody to compare.
    const tr = sail('me', { twa: [42, 145], kn: [6, 6], roundAt: 1_800_000, end: 600_000, stepMs: 30_000 });
    const boats = [boatOf('me', 0, { finishMs: GUN + 3_600_000 })];
    const { a, m } = world({ boats, tracks: [tr] });
    const d = coachDebrief(a, m, 'me')!;
    expect(d.raceCov).toBeLessThan(0.25);
    expect(d.noData).toBe(true);
    expect(d.cards).toEqual([]);
    expect(d.ok).toEqual([]);
  });
});
