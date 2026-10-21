/**
 * Recall Coach, phases 2–4: one boat's debrief for one race — every detector
 * (D1, D2 and D8 → D3, D3, D4, D5, D6, D7, D8, D9, D10), ranked and gated (rank.ts), with the ✓ row
 * (detectors that measured the boat as fine with good data) and ➕ Went well (wentWell: legs,
 * roundings and the start where it gained on the leaders, with seconds; at most WENT_WELL_MAX).
 * Pure: the UI fills the templates.
 */
import type { RaceAnalysis } from '../types';
import type { CoachModel } from './index';
import { coachCtx, type CoachCtx } from './detectors/context';
import { detectAngles } from './detectors/angles';
import { detectConsolidate } from './detectors/consolidate';
import { detectShift } from './detectors/shift';
import { detectEarly } from './detectors/early';
import { detectLastLeg } from './detectors/lastLeg';
import { detectRolled } from './detectors/rolled';
import { detectStart } from './detectors/start';
import { detectRounding, type MarkType } from './detectors/rounding';
import { detectShadow, type D8Result } from './detectors/shadow';
import { D3_GAP_S, D3_WINDOW_MS } from './detectors/early';
import { longestHole, trackLegAt } from './tracks';
import { coachCoverage, gapChange, type GoodNote, type Opportunity } from './opportunity';
import { median } from '../geo';
import { rankOpportunities, type Card } from './rank';

/** Below this race coverage (and with no window at OK_WINDOW) there is no debrief. */
export const RACE_MIN_COVERAGE = 0.25;
/** A detector window this well covered still supports cards when the race as a whole is not. */
export const OK_WINDOW = 0.5;
/** A leg where the gap to the leaders improved this much is ➕, s. */
export const PLUS_GAIN_S = 30;
/** …read over at least this share of the boat's time on the leg. */
export const PLUS_MIN_READ = 0.5;
/** A start where the boat crossed this much ahead of the leaders' median crossing is ➕, s. */
export const PLUS_START_S = 5;
/** The first minutes after the crossing (D3's window) where the gap to the leaders shrank this much are ➕ (D3's mirror), s. */
export const PLUS_LANE_S = D3_GAP_S;
/** Went well: at most this many, the most seconds first. */
export const WENT_WELL_MAX = 3;
/** A ➕ mostly inside a bigger one's window (over this share of its own) is the same gain: dropped. */
export const WENT_WELL_OVERLAP = 0.5;

export interface CoachDebrief {
  /** At most 3, best first. */
  cards: Card[];
  /** ✓ Not the problem. */
  ok: GoodNote[];
  /** ➕ Went well (wentWell), the most seconds first. */
  plus: GoodNote[];
  /** Seconds at stake over the cards. */
  totalS: number;
  /** The boat's coverage of the race (Coach coverage), 0–1. */
  raceCov: number;
  /** Too little tracker data for any debrief: no cards, no chips. */
  noData: boolean;
  /** Everything the detectors found before ranking (for the tests and the ⓘ). */
  found: Opportunity[];
  /** D8, also when it only rides on D3 (or on nothing: no D3 card to carry it). */
  dirtyAir: D8Result;
  /** Which data-gated detectors had enough data (the Regatta view's denominators): D8, and the kinds of mark D9 timed. */
  quality: { D8: boolean; D9: MarkType[] };
}

/**
 * Legs where the boat gained PLUS_GAIN_S or more on the leaders: the gap to them read off the ladder over
 * most of the leg; where the ladder can't read it (a sparse track), the leg's time against the leaders'
 * median time for it, when the leg is timed cleanly (no rounding in a hole).
 */
export function legGains(ctx: CoachCtx): GoodNote[] {
  const out: GoodNote[] = [];
  const tr = ctx.tr;
  if (!ctx.leaders.length) return out;
  ctx.a.legs.forEach((leg, k) => {
    const ts = tr.t.filter((t) => trackLegAt(tr, t) === k);
    const mine = ctx.me.legs[k];
    if (ts.length >= 2) {
      const a = ts[0];
      const b = ts[ts.length - 1];
      const g = gapChange(ctx.gaps(ctx.leaders, a, b), a, b);
      const legMs = mine ? mine.timeS * 1000 : b - a;
      if (g && (g.t1 - g.t0) / Math.max(1, legMs) >= PLUS_MIN_READ) {
        const gain = g.g0 - g.g1;
        if (gain >= PLUS_GAIN_S) out.push({ kind: 'plus', detector: 'gap', variant: 'leg', facts: { leg: leg.name, gainS: gain, how: 'gap' }, t0: g.t0, t1: g.t1, seconds: gain });
        return;
      }
    }
    if (!mine || mine.timeGapS != null) return;
    const times = ctx.leaders.map((id) => ctx.a.boats.find((b) => b.id === id)?.legs[k]).filter((l) => l && l.timeGapS == null).map((l) => l!.timeS);
    if (!times.length) return;
    const gain = median(times) - mine.timeS;
    if (gain >= PLUS_GAIN_S) out.push({ kind: 'plus', detector: 'gap', variant: 'leg', facts: { leg: leg.name, gainS: gain, how: 'time' }, t0: mine.startMs, t1: mine.endMs, seconds: gain });
  });
  return out;
}

/** The start, as a ➕: crossed PLUS_START_S or more ahead of the leaders' median crossing; or gained PLUS_LANE_S on them in D3's window. */
export function startGains(ctx: CoachCtx): GoodNote[] {
  const out: GoodNote[] = [];
  const cross = ctx.m.crossMs;
  const mine = cross?.[ctx.boat] ?? null;
  const theirs = ctx.leaders.map((id) => cross?.[id] ?? null).filter((x): x is number => x != null);
  if (mine != null && theirs.length >= Math.min(2, ctx.leaders.length) && theirs.length) {
    const ahead = (median(theirs) - mine) / 1000;
    if (ahead >= PLUS_START_S) out.push({ kind: 'plus', detector: 'D1', variant: 'cross', facts: { aheadS: ahead, crossS: (mine - ctx.gun) / 1000 }, t0: ctx.gun, t1: mine, seconds: ahead });
  }
  const t0 = mine ?? ctx.gun;
  const t1 = t0 + D3_WINDOW_MS;
  if (ctx.leaders.length) {
    const g = gapChange(ctx.gaps(ctx.leaders, t0, t1), t0, t1);
    if (g && g.g0 - g.g1 >= PLUS_LANE_S) out.push({ kind: 'plus', detector: 'D3', variant: 'lane', facts: { gainS: g.g0 - g.g1 }, t0: g.t0, t1: g.t1, seconds: g.g0 - g.g1 });
  }
  return out;
}

/**
 * Went well (spec §3 ➕): legs, roundings and the start where the boat gained on the leaders, by seconds;
 * one mostly inside a bigger one's window is the same gain (a rounding's zone and the line crossing are moments of
 * their own: never); at most WENT_WELL_MAX.
 */
const MOMENTS = new Set<GoodNote['detector']>(['D1', 'D9']);

export function wentWell(notes: readonly GoodNote[], max = WENT_WELL_MAX): GoodNote[] {
  const sorted = [...notes].sort((p, q) => (q.seconds ?? 0) - (p.seconds ?? 0) || p.t0 - q.t0);
  const kept: GoodNote[] = [];
  for (const n of sorted) {
    const len = Math.max(1, n.t1 - n.t0);
    const inside = !MOMENTS.has(n.detector) && kept.some((k) => !MOMENTS.has(k.detector) && (Math.min(n.t1, k.t1) - Math.max(n.t0, k.t0)) / len > WENT_WELL_OVERLAP);
    if (!inside) kept.push(n);
    if (kept.length >= max) break;
  }
  return kept;
}

/** D8 short of D8_ALONE_S rides on the early-lane card as a chip (spec §5); with no D3 card it has nowhere to show. */
export const attachShadow = (early: Opportunity | null, shadow: Pick<D8Result, 'chip'>): Opportunity | null =>
  early && shadow.chip ? { ...early, chips: [...(early.chips ?? []), shadow.chip] } : early;

const overlaps = (p: Opportunity, q: Opportunity): boolean => p.t0 < q.t1 && q.t0 < p.t1;

/** A gain given back (D5) explains its stretch better than "the wrong side" (D4) of the same swing: D4 only clear of every D5. */
export const d4Unless = (d4: Opportunity | null, d5: readonly Opportunity[]): Opportunity | null => (d4 && !d5.some((o) => overlaps(o, d4)) ? d4 : null);

export function coachDebrief(a: RaceAnalysis, m: CoachModel, boat: string): CoachDebrief | null {
  const ctx = coachCtx(a, m, boat);
  if (!ctx) return null;
  const start = detectStart(ctx);
  const rolled = detectRolled(ctx);
  const early = detectEarly(ctx, { crossMs: start.crossMs, d1Fired: start.fired }, rolled);
  const up = detectAngles(ctx, 'upwind');
  const down = detectAngles(ctx, 'downwind');
  const last = detectLastLeg(ctx);
  const cons = detectConsolidate(ctx);
  const shift = detectShift(ctx);
  const d4 = d4Unless(shift.opp, cons.opps);
  const shadow = detectShadow(ctx);
  const round = detectRounding(ctx);
  const d3 = attachShadow(early, shadow);
  const found = [start.opp, d3, d4, ...cons.opps, up.opp, down.opp, shadow.opp, ...round.opps, last].filter((o): o is Opportunity => !!o);
  const clearAir: GoodNote | null =
    shadow.evaluated && !shadow.opp && !shadow.chip ? { kind: 'ok', detector: 'D8', variant: 'ok', facts: { share: shadow.share, fleetShare: shadow.fleetShare }, t0: ctx.gun, t1: m.endMs } : null;
  const ok = [start.ok, shift.opp ? null : shift.ok, cons.opps.length ? null : cons.ok, up.ok, down.ok, clearAir, round.ok].filter((o): o is GoodNote => !!o);
  const end = ctx.me.finishMs ?? m.endMs;
  const raceCov = coachCoverage(ctx.tr.t, ctx.gun, end);
  const dense = found.some((o) => o.coverage >= OK_WINDOW) || ok.length > 0;
  const noData = raceCov < RACE_MIN_COVERAGE && !dense;
  // Each card's longest hole, for a low-confidence card's ⚠ chip.
  const cards = (noData ? [] : rankOpportunities(found)).map((c) => ({ ...c, conf: { ...c.conf, hole: longestHole(ctx.tr.t, c.t0, c.t1) } }));
  return {
    cards,
    ok: noData ? [] : ok,
    plus: noData ? [] : wentWell([...legGains(ctx), ...round.good, ...startGains(ctx)]),
    totalS: cards.reduce((s, c) => s + c.seconds, 0),
    raceCov,
    noData,
    found,
    dirtyAir: shadow,
    quality: { D8: shadow.evaluated, D9: round.evaluated },
  };
}
