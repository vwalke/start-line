import { describe, expect, it } from 'vitest';
import type { CoachModel } from '../src/analysis/coach';
import { d4Unless } from '../src/analysis/coach/debrief';
import type { CoachCtx } from '../src/analysis/coach/detectors/context';
import {
  D5_LOSS_S,
  d5Peers,
  detectConsolidate,
  gapReads,
  laylineTest,
  swings,
  windSwing,
} from '../src/analysis/coach/detectors/consolidate';
import { D4_SHIFT_DEG, detectShift, headedSamples, shareIn, twdMean, twdRange } from '../src/analysis/coach/detectors/shift';
import type { Course, GapPoint } from '../src/analysis/coach/ladder';
import { confidenceOf, type Opportunity } from '../src/analysis/coach/opportunity';
import { rankOpportunities } from '../src/analysis/coach/rank';
import type { CoachTrack } from '../src/analysis/coach/tracks';
import type { TwdSeries } from '../src/analysis/coach/twdSeries';
import { MS_TO_KN, bearingVec, type Vec } from '../src/analysis/geo';
import type { BoatResult, RaceAnalysis } from '../src/analysis/types';
import { cardText, goodTexts } from '../src/ui/coachCards';

/**
 * Synthetic beats for the wind detectors: a 2 km beat north from (0, 0) (the mark at (0, 2000)), the wind
 * a function of time, boats integrated from a course-over-ground function, and the gap ladder scripted
 * (ctx.gaps) so each test sets exactly the gaps the detector reads.
 */
const GUN = 10_000_000;
const MIN = 60_000;
const course: Course = { pts: [[0, 0], [0, 2000], [0, 0]], kinds: ['upwind', 'downwind'] };

function windOf(f: (t: number) => number, ta = 84): TwdSeries {
  const t: number[] = [];
  for (let x = GUN; x <= GUN + 40 * MIN; x += MIN) t.push(x);
  return { t, twd: t.map(f), ta: t.map(() => ta), n: t.map(() => 99), ok: t.map(() => true), twdAt: f, taAt: () => ta };
}

/** A track from `p0`, `cogAt(t)` at `kn`, a fix every second from the gun to `endMin`; one leg (the beat) to `endMin`. */
function track(id: string, p0: Vec, cogAt: (t: number) => number, kn = 6, endMin = 20): CoachTrack {
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let p = p0;
  const v = kn / MS_TO_KN;
  for (let ms = 0; ms <= endMin * MIN; ms += 1000) {
    t.push(GUN + ms);
    x.push(p[0]);
    y.push(p[1]);
    const d = bearingVec(cogAt(GUN + ms));
    p = [p[0] + d[0] * v, p[1] + d[1] * v];
  }
  return { id, t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y), bounds: [GUN, GUN + endMin * MIN, null] };
}

function boat(id: string, place: number): BoatResult {
  return {
    id,
    sail: id,
    name: id,
    colorSlot: place,
    finishPos: place,
    finishMs: GUN + 3_000_000 + place * 10_000,
    raceTimeS: null,
    sogAvgKn: null,
    distM: null,
    distApprox: false,
    coverage: 1,
    maxGapS: 1,
    start: null,
    legs: [null, null],
    upwind: null,
    downwind: null,
    headingSource: 'device',
    headingOffDeg: null,
  } as BoatResult;
}

/** Gap points every 5 s on leg 0 with per-boat gaps `each[id](min after the gun)`, the median as the group gap. */
function scripted(each: Record<string, (min: number) => number | null>): CoachCtx['gaps'] {
  return (ids, from, to) => {
    const out: GapPoint[] = [];
    for (let t = from; t <= to; t += 5000) {
      const e = ids.map((id) => each[id]?.((t - GUN) / MIN) ?? null);
      const ok = e.filter((x): x is number => x != null).sort((p, q) => p - q);
      const mid = ok.length ? (ok.length % 2 ? ok[ok.length >> 1] : (ok[ok.length / 2 - 1] + ok[ok.length / 2]) / 2) : null;
      out.push({ tMs: t, behindS: ok.length * 2 >= ids.length ? mid : null, n: ok.length, each: e, leg: 0 });
    }
    return out;
  };
}

function ctxOf(o: { tracks: CoachTrack[]; boats: BoatResult[]; wind: TwdSeries; gaps: CoachCtx['gaps']; marksEstimated?: boolean }, me = 'me'): CoachCtx {
  const a = {
    meta: { gunMs: GUN, tzOffsetMs: -4 * 3_600_000, raceNumber: 1, division: 'X', boatClass: 'J/105' },
    line: { left: [-150, 0], right: [150, 0], lengthM: 300, bearingDeg: 90, favored: 'square', favoredByM: 0 },
    legs: [
      { index: 0, name: 'Beat 1', kind: 'upwind', to: 'W' },
      { index: 1, name: 'Run 1', kind: 'downwind', to: 'L' },
    ],
    legSource: 'course',
    marks: [],
    boats: o.boats,
    wind: { method: 'tacks', estimates: [], twdAtGunDeg: 0, model: null },
  } as unknown as RaceAnalysis;
  const m = {
    gunMs: GUN,
    endMs: GUN + 40 * MIN,
    course,
    wind: o.wind,
    vmg: [2.5, 3],
    tracks: new Map(o.tracks.map((t) => [t.id, t])),
    windExcluded: [],
    crossMs: null,
  } as unknown as CoachModel;
  const b = o.boats.find((x) => x.id === me)!;
  return {
    a,
    m,
    boat: me,
    me: b,
    tr: m.tracks.get(me)!,
    gun: GUN,
    loaM: 10,
    leaders: o.boats.filter((x) => x.id !== me).sort((p, q) => p.finishPos! - q.finishPos!).slice(0, 3).map((x) => x.id),
    marksEstimated: o.marksEstimated ?? false,
    gaps: o.gaps,
    nameOf: (id) => `Boat ${id}`,
  };
}

// ---- D4

/** Wind 30° to 5 min, backing to 15° by 6 min, 15° after. */
const backing = (t: number): number => {
  const m = (t - GUN) / MIN;
  return m <= 5 ? 30 : m >= 6 ? 15 : 30 - 15 * (m - 5);
};
/** Starboard (+TWA): the course 45° left of the wind; port: right of it. */
const stbd = (w: (t: number) => number) => (t: number) => w(t) - 45;
const port = (w: (t: number) => number) => (t: number) => w(t) + 45;

/** Good Trade's race 2, made up: the boat right on starboard through a left shift, the leaders left on port, losing 6 s a minute to them. */
function shiftWorld(o: { meX?: number; meCog?: (t: number) => number; wind?: (t: number) => number; loss?: number } = {}) {
  const w = o.wind ?? backing;
  const tracks = [
    track('me', [o.meX ?? 2000, 0], o.meCog ?? stbd(w)),
    ...['L1', 'L2', 'L3'].map((id, i) => track(id, [-2000 - 100 * i, 0], port(w))),
  ];
  const boats = [boat('L1', 1), boat('L2', 2), boat('L3', 3), boat('me', 4)];
  const loss = o.loss ?? 6;
  const g = (k: number) => (min: number) => 10 + k + loss * min;
  return ctxOf({ tracks, boats, wind: windOf(w), gaps: scripted({ L1: g(0), L2: g(1), L3: g(2) }) });
}

describe('D4 helpers', () => {
  it('twdMean: the measured minutes within ±5 min; twdRange: max − min over the window', () => {
    const w = windOf(backing);
    // At 6 min: minutes 1–11, five of them (1–5) at 30°, six (6–11) at 15°.
    expect(twdMean(w, GUN + 6 * MIN)).toBeCloseTo((5 * 30 + 6 * 15) / 11, 6);
    expect(twdRange(backing, GUN, GUN + 10 * MIN)).toBeCloseTo(15, 6);
    expect(twdRange(() => 10, GUN, GUN + 10 * MIN)).toBe(0);
  });
  it('headed: starboard in a backing wind (below its 10-min mean by > 3°), port in a veer; never the lifted tack', () => {
    const w = windOf(backing);
    const me = headedSamples(track('me', [0, 0], stbd(backing)), 0, w);
    const them = headedSamples(track('them', [0, 0], port(backing)), 0, w);
    // Before the shift starboard is lifted (the mean ahead is lower); after, headed until the mean catches up (~8.5 min).
    expect(shareIn(me, GUN + 6 * MIN, GUN + 8 * MIN)!.share).toBe(1);
    expect(shareIn(me, GUN + 9 * MIN, GUN + 15 * MIN)!.share).toBe(0);
    expect(shareIn(me, GUN, GUN + 3 * MIN)!.share).toBe(0);
    // Port is lifted after the backing; before it, the mean (which already holds the backing) makes it look headed.
    expect(shareIn(them, GUN + 5.5 * MIN, GUN + 15 * MIN)!.share).toBe(0);
    expect(shareIn(them, GUN, GUN + 5 * MIN)!.share).toBeGreaterThan(0);
    expect(shareIn(me, GUN, GUN + 5_000)).toBeNull(); // too few samples
  });
});

describe('D4 shift, wrong side / headed tack', () => {
  it('fires on the losing side of a 15° left shift, headed vs leaders lifted; seconds = Δgap to them over the window', () => {
    const ctx = shiftWorld();
    const r = detectShift(ctx);
    const o = r.opp!;
    expect(o.kind).toBe('D4');
    expect(o.facts.dir).toBe('left');
    expect(o.facts.side).toBe('right');
    expect(o.facts.shift as number).toBeGreaterThanOrEqual(D4_SHIFT_DEG);
    expect(o.facts.headed as number).toBeGreaterThan(0.1);
    expect(o.facts.ldrHeaded as number).toBeLessThan(0.1);
    expect(o.refBoats.sort()).toEqual(['L1', 'L2', 'L3']);
    // The gap grows 6 s a minute: the window's Δgap (one-minute reads at its ends) is 6 × its read span.
    expect(o.seconds).toBeCloseTo(6 * ((o.t1 - o.t0) / MIN - 1), 0); // reads: one-minute medians at each end
    expect(o.t1 - o.t0).toBeLessThanOrEqual(10 * MIN);
    // One shift, not a swing: the window holds the backing.
    expect(o.t0).toBeLessThanOrEqual(GUN + 5 * MIN);
    expect(o.t1).toBeGreaterThanOrEqual(GUN + 6 * MIN);
    // 4 km apart: the ±3° wind term is wide, so the wind input caps the confidence, with ⚠ wind est.
    expect(o.conf.rangeShare!).toBeGreaterThan(1);
    expect(confidenceOf(o.conf).limit).toBe('wind');
    expect(confidenceOf(o.conf).level).not.toBe('high');
    expect(o.windEst).toBe(true);
    expect(r.ok).toBeNull();
    const t = cardText({ ...o, score: o.seconds, limit: null });
    expect(t.title).toBe('Wrong side of a 15° left shift');
    expect(t.sentence).toMatch(/^You went right while the leaders held left; the wind backed 15°/);
    expect(t.chips[0]).toBe('wind 30° → 15°');
  });
  it('the favoured side: no card, and ✓ Shifts: on the lifted side', () => {
    const r = detectShift(shiftWorld({ meX: -4000 }));
    expect(r.opp).toBeNull();
    expect(r.ok?.detector).toBe('D4');
    expect(goodTexts(r.ok!)).toEqual(['Shifts: on the lifted side']);
  });
  it('a 6° shift is not a shift (no card, no ✓)', () => {
    const small = (t: number) => (backing(t) - 30) * 0.4 + 30;
    const r = detectShift(shiftWorld({ wind: small }));
    expect(r.opp).toBeNull();
    expect(r.ok).toBeNull();
  });
  it('on the losing side but on the lifted tack (port) as much as the leaders: no card', () => {
    expect(detectShift(shiftWorld({ meCog: port(backing) })).opp).toBeNull();
  });
  it('on the losing side, headed, but gaining on the leaders: no card', () => {
    expect(detectShift(shiftWorld({ loss: -3 })).opp).toBeNull();
  });
});

// ---- D5

describe('D5 helpers', () => {
  const at = (pairs: [number, number][]) => pairs.map(([m, g]) => ({ t: GUN + m * MIN, g, seg: 0 }));
  it('swings: a gain ≥ 20 s to a peak, then a loss ≥ 30 s within 6 min; biggest loss first', () => {
    const s = swings(at([[0, 60], [2, 30], [4, -20], [6, 10], [8, 40], [12, 90]]));
    expect(s[0]).toMatchObject({ gFrom: 60, gPeak: -20, gTrough: 40, tPeak: GUN + 4 * MIN, tTrough: GUN + 8 * MIN });
    // 90 at 12 min is 8 min after the peak: outside D5_LOSS_MS.
    expect(swings(at([[0, 60], [4, -20], [11, 90]]))).toEqual([]);
    // Gains under 20 s, or losses under 30 s, are no swing.
    expect(swings(at([[0, 10], [4, -5], [6, 40]]))).toEqual([]);
    expect(swings(at([[0, 60], [4, 0], [6, D5_LOSS_S - 1]]))).toEqual([]);
  });
  it('a swing never spans two stretches of track', () => {
    const r = at([[0, 60], [4, -20], [6, 40]]);
    r[2].seg = 1;
    expect(swings(r)).toEqual([]);
  });
  it('gapReads: one-minute medians every 30 s on the leg; none where the track covers under half; a gap of reads splits', () => {
    const pts: GapPoint[] = [];
    for (let t = GUN; t <= GUN + 10 * MIN; t += 5000) pts.push({ tMs: t, behindS: (t - GUN) / 1000, n: 1, each: [], leg: 0 });
    const fixes: number[] = [];
    for (let t = GUN; t <= GUN + 10 * MIN; t += 1000) if (t < GUN + 4 * MIN || t > GUN + 6 * MIN) fixes.push(t);
    const r = gapReads(pts, 0, GUN + MIN, GUN + 9 * MIN, (p) => p.behindS, fixes);
    expect(r.find((x) => x.t === GUN + 2 * MIN)!.g).toBe(120);
    expect(r.some((x) => x.t === GUN + 5 * MIN)).toBe(false);
    expect(r[0].seg).toBe(0);
    expect(r[r.length - 1].seg).toBe(1);
    expect(gapReads(pts, 1, GUN, GUN + 9 * MIN, (p) => p.behindS)).toEqual([]);
  });
  it('windSwing: the largest move from the start of the window, signed', () => {
    expect(windSwing((t) => ((t - GUN) / MIN) * 2, GUN, GUN + 5 * MIN)).toBeCloseTo(10, 6);
    expect(windSwing(backing, GUN, GUN + 10 * MIN)).toBeCloseTo(-15, 6);
  });
});

/** Peers 2–7 finished ahead of the boat (8th); the scripted gap: 60 s behind → 20 s ahead at 6 min → `trough` at 9 min. */
function swingWorld(o: { meX?: number; wind?: (t: number) => number; trough?: number; meCog?: (t: number) => number; me0?: Vec; endMin?: number } = {}) {
  const w = o.wind ?? ((t: number) => (t - GUN <= 6 * MIN ? 0 : Math.min(12, (2 * (t - GUN - 6 * MIN)) / 30_000)));
  const ids = ['P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
  const tracks = [track('me', o.me0 ?? [o.meX ?? -1500, 0], o.meCog ?? stbd(w), 6, o.endMin), ...ids.map((id, i) => track(id, [100 * i, 0], () => 0))]; // the peers: a tight bunch up the middle
  tracks.push(track('W', [0, 0], port(w)));
  const boats = [boat('W', 1), ...ids.map((id, i) => boat(id, i + 2)), boat('me', 8)];
  const trough = o.trough ?? 40;
  const g = (min: number) => (min <= 6 ? 60 - (80 * min) / 6 : -20 + ((trough + 20) * Math.min(3, min - 6)) / 3);
  const each: Record<string, (m: number) => number | null> = { W: () => 200 };
  for (const id of ids) each[id] = g;
  return ctxOf({ tracks, boats, wind: windOf(w), gaps: scripted(each), marksEstimated: true });
}

describe('D5 consolidation / overstand', () => {
  it('peers: the boats that finished up to 6 places ahead', () => {
    expect(d5Peers(swingWorld())).toEqual({ ids: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7'], ahead: true });
  });
  it('banked: 20 s up on the peers, 1.5 km away, the wind swings 12°, 40 s down within 3 min → ≈ 60 s', () => {
    const r = detectConsolidate(swingWorld());
    expect(r.opps).toHaveLength(1);
    const o = r.opps[0];
    expect(o.variant).toBe('banked');
    // 60 s from the turn to the top; the one-minute read at the turn sits a little above it.
    expect(o.seconds).toBeGreaterThan(50);
    expect(o.seconds).toBeLessThanOrEqual(60);
    expect(o.facts.gPeak as number).toBeLessThan(-15);
    expect(o.facts.gTrough as number).toBeCloseTo(40, 0);
    expect(o.facts.shift as number).toBeGreaterThanOrEqual(8);
    expect(o.facts.side).toBe('left');
    // Marks estimated: medium at most (spec §5) — here the 1.5 km split's wide range takes it lower still.
    expect(o.conf.marksEstimated).toBe(true);
    expect(confidenceOf({ ...o.conf, rangeShare: 0.3 })).toEqual({ level: 'medium', limit: 'marks' });
    expect(confidenceOf(o.conf)).toEqual({ level: 'low', limit: 'wind' });
    expect(o.windEst).toBe(true);
    const t = cardText({ ...o, score: 0, limit: 'marks' });
    expect(t.title).toBe('Gave back a left gain');
    expect(t.sentence).toMatch(/^The left paid first, 1\d s up on the boats that finished 2nd–7th; then the wind swung back 12° and you were 40 s down\.$/);
  });
  it('no swing in the wind, or boats close together: no card (and no ✓, a gain was given back)', () => {
    const calm = detectConsolidate(swingWorld({ wind: () => 0 }));
    expect(calm.opps).toEqual([]);
    expect(calm.ok).toBeNull();
    expect(detectConsolidate(swingWorld({ meX: 150, meCog: () => 0 })).opps).toEqual([]);
  });
  it('a gain held: no card, ✓ Banked gains', () => {
    const r = detectConsolidate(swingWorld({ trough: -15 }));
    expect(r.opps).toEqual([]);
    expect(goodTexts(r.ok!)).toEqual(['Banked gains']);
  });
  it('overstand: on the layline 1.5 km out, then 65 s lost with no wind swing → fires on the layline alone', () => {
    // Port to a point 1500 m from the mark on the starboard layline (bearing 315°), tack, then starboard to the mark.
    const P: Vec = [1500 / Math.SQRT2, 2000 - 1500 / Math.SQRT2];
    const v = 6 / MS_TO_KN;
    const start: Vec = [P[0] - 120 * v * Math.SQRT1_2, P[1] - 120 * v * Math.SQRT1_2];
    const ctx = swingWorld({ wind: () => 0, trough: 45, me0: start, meCog: (t) => (t - GUN < 120_000 ? 45 : -45), endMin: 10 });
    const lay = laylineTest(ctx, 0, GUN, GUN + 6 * MIN, GUN + 8 * MIN)!;
    expect(lay.fromM!).toBeGreaterThan(1000);
    expect(lay.fromM!).toBeLessThan(1600);
    const o = detectConsolidate(ctx).opps[0];
    expect(o.variant).toBe('overstand');
    expect(o.seconds).toBeGreaterThanOrEqual(60);
    expect(cardText({ ...o, score: 0, limit: null }).title).toBe('Overstood the right corner');
    // No layline (tacked onto a course away from the mark): the same gaps don't fire.
    expect(laylineTest(swingWorld({ wind: () => 0 }), 0, GUN, GUN + 6 * MIN, GUN + 9 * MIN)).toBeNull();
  });
  it('caught-leader: level with a leader 400 m+ away, then 38 s down on a 5° swing', () => {
    const w = (t: number) => (t - GUN <= 6 * MIN ? 0 : Math.min(5, (t - GUN - 6 * MIN) / 30_000));
    const tracks = [track('me', [-500, 0], stbd(w)), track('L', [500, 0], port(w)), track('M', [0, -3000], port(w))];
    const boats = [boat('L', 1), boat('M', 2), boat('me', 3)];
    const ldr = (min: number) => (min <= 6 ? 25 - (23 * min) / 6 : 2 + (38 * Math.min(3, min - 6)) / 3);
    const ctx = ctxOf({ tracks, boats, wind: windOf(w), gaps: scripted({ L: ldr, M: () => 300 }) });
    const o = detectConsolidate(ctx).opps.find((x) => x.variant === 'caught-leader')!;
    expect(o.refBoats).toEqual(['L']);
    // One-minute reads: the peak read sits a little above the 2 s turn.
    expect(o.seconds).toBeGreaterThan(33);
    expect(o.seconds).toBeLessThanOrEqual(38);
    expect(o.facts.ldr).toBe('Boat L');
    expect(o.facts.dir).toBe('right');
    const t = cardText({ ...o, score: 0, limit: null }, -4 * 3_600_000);
    expect(t.title).toBe('Caught the leader, then let go');
    expect(t.sentence).toMatch(/^Even with Boat L at \d\d:\d\d; you stayed left and Boat L sailed into a right-hand lift, 40 s ahead by \d\d:\d\d\.$/);
    // Ahead of the leader by 25 s at the peak is not "caught".
    const ahead = ctxOf({ tracks, boats, wind: windOf(w), gaps: scripted({ L: (m) => ldr(m) - 27, M: () => 300 }) });
    expect(detectConsolidate(ahead).opps.some((x) => x.variant === 'caught-leader')).toBe(false);
  });
});

describe('D4 / D5 in the ranking with the phase-2 detectors', () => {
  const op = (o: Partial<Opportunity>): Opportunity => ({
    kind: 'D3',
    variant: 'lane',
    t0: 0,
    t1: 100,
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
  it('a wide noise range caps the wind input: share ≤ 0.6 high, ≤ 1.2 medium, else low', () => {
    expect(confidenceOf({ boatCov: 1, rangeShare: 0.5 }).level).toBe('high');
    expect(confidenceOf({ boatCov: 1, rangeShare: 1 })).toEqual({ level: 'medium', limit: 'wind' });
    expect(confidenceOf({ boatCov: 1, rangeShare: 2 }).level).toBe('low');
  });
  it('D4 over the early lane (D3): the D3 loses the overlapped share and drops under its minimum', () => {
    const cards = rankOpportunities([op({ kind: 'D3', seconds: 19, t0: 60, t1: 360 }), op({ kind: 'D4', variant: 'headed', seconds: 90, t0: 115, t1: 655 }), op({ kind: 'D1', seconds: 47, t0: -10, t1: 56 })]);
    expect(cards.map((c) => c.kind)).toEqual(['D4', 'D1']);
  });
  it('a medium D5 (marks estimated) ranks by seconds × 0.7 against a high D3', () => {
    const d5 = op({ kind: 'D5', variant: 'caught-leader', seconds: 45, t0: 500, t1: 700, conf: { boatCov: 1, marksEstimated: true } });
    const d3 = op({ kind: 'D3', seconds: 29.4, t0: 0, t1: 300 });
    expect(rankOpportunities([d3, d5]).map((c) => [c.kind, Math.round(c.score * 10) / 10])).toEqual([
      ['D5', 31.5],
      ['D3', 29.4],
    ]);
    expect(rankOpportunities([d3, { ...d5, seconds: 32 }]).map((c) => c.kind)).toEqual(['D3', 'D5']);
  });
  it('coachDebrief leaves a D4 to an overlapping D5 swing (the D5 story is the more specific)', () => {
    const d4 = op({ kind: 'D4', variant: 'headed', seconds: 120, t0: 100, t1: 400 });
    expect(d4Unless(d4, [op({ kind: 'D5', variant: 'overstand', seconds: 180, t0: 300, t1: 600 })])).toBeNull();
    expect(d4Unless(d4, [op({ kind: 'D5', seconds: 50, t0: 400, t1: 600 })])).toBe(d4);
    expect(d4Unless(null, [])).toBeNull();
  });
});
