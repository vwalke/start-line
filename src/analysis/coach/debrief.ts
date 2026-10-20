/**
 * Recall Coach, phases 2–3: one boat's debrief for one race — every detector
 * (D1, D2 → D3, D3, D4, D5, D6, D7, D10), ranked and gated (rank.ts), with the ✓ row
 * (detectors that measured the boat as fine with good data) and ➕ (legs where
 * it gained on the leaders). Pure: the UI fills the templates.
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
import { longestHole, trackLegAt } from './tracks';
import { coachCoverage, gapChange, type GoodNote, type Opportunity } from './opportunity';
import { rankOpportunities, type Card } from './rank';

/** Below this race coverage (and with no window at OK_WINDOW) there is no debrief. */
export const RACE_MIN_COVERAGE = 0.25;
/** A detector window this well covered still supports cards when the race as a whole is not. */
export const OK_WINDOW = 0.5;
/** A leg where the gap to the leaders improved this much is ➕, s. */
export const PLUS_GAIN_S = 30;
/** …read over at least this share of the boat's time on the leg. */
export const PLUS_MIN_READ = 0.5;

export interface CoachDebrief {
  /** At most 3, best first. */
  cards: Card[];
  /** ✓ Not the problem. */
  ok: GoodNote[];
  /** ➕ Went well. */
  plus: GoodNote[];
  /** Seconds at stake over the cards. */
  totalS: number;
  /** The boat's coverage of the race (Coach coverage), 0–1. */
  raceCov: number;
  /** Too little tracker data for any debrief: no cards, no chips. */
  noData: boolean;
  /** Everything the detectors found before ranking (for the tests and the ⓘ). */
  found: Opportunity[];
}

/** Legs where the gap to the leaders shrank by PLUS_GAIN_S or more (read over most of the leg). */
function legGains(ctx: CoachCtx): GoodNote[] {
  const out: GoodNote[] = [];
  const tr = ctx.tr;
  ctx.a.legs.forEach((leg, k) => {
    const ts = tr.t.filter((t) => trackLegAt(tr, t) === k);
    if (ts.length < 2 || !ctx.leaders.length) return;
    const a = ts[0];
    const b = ts[ts.length - 1];
    const g = gapChange(ctx.gaps(ctx.leaders, a, b), a, b);
    const legMs = ctx.me.legs[k] ? ctx.me.legs[k]!.timeS * 1000 : b - a;
    if (!g || (g.t1 - g.t0) / Math.max(1, legMs) < PLUS_MIN_READ) return;
    if (g.g0 - g.g1 >= PLUS_GAIN_S) out.push({ kind: 'plus', detector: 'gap', variant: 'leg', facts: { leg: leg.name, gainS: g.g0 - g.g1 }, t0: g.t0, t1: g.t1 });
  });
  return out;
}

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
  const found = [start.opp, early, d4, ...cons.opps, up.opp, down.opp, last].filter((o): o is Opportunity => !!o);
  const ok = [start.ok, shift.opp ? null : shift.ok, cons.opps.length ? null : cons.ok, up.ok, down.ok].filter((o): o is GoodNote => !!o);
  const end = ctx.me.finishMs ?? m.endMs;
  const raceCov = coachCoverage(ctx.tr.t, ctx.gun, end);
  const dense = found.some((o) => o.coverage >= OK_WINDOW) || ok.length > 0;
  const noData = raceCov < RACE_MIN_COVERAGE && !dense;
  // Each card's longest hole, for a low-confidence card's ⚠ chip.
  const cards = (noData ? [] : rankOpportunities(found)).map((c) => ({ ...c, conf: { ...c.conf, hole: longestHole(ctx.tr.t, c.t0, c.t1) } }));
  return {
    cards,
    ok: noData ? [] : ok,
    plus: noData ? [] : legGains(ctx),
    totalS: cards.reduce((s, c) => s + c.seconds, 0),
    raceCov,
    noData,
    found,
  };
}
