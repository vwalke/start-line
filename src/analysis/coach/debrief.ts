/**
 * Recall Coach, phases 2–4: one boat's debrief for one race — every detector
 * (D1, D2 and D8 → D3, D3 → D1 when both fired, D4, D5, D6, D7, D8, D9, D10, D11 → D6 / D7 on a leg they share, D12,
 * D13 with D9's low-resolution places at the same gate as its chip, D14 side of the course (one card a race: sideCard), D15 fast but going nowhere,
 * D16 line bias, D17 manoeuvre cost: one card a race per kind of manoeuvre), ranked and gated (rank.ts), with the ✓ row (detectors that measured the boat as fine; on a stretch
 * the boat's tracker covered under OK_THIN_COVERAGE the note says "not enough data to judge …" instead, `thin`) and
 * ➕ Went well (wentWell: legs, roundings, the side that paid, the favoured end and the start where it gained, with
 * seconds; at most WENT_WELL_MAX). D6 / D7's ✓ leaves out a leg D15 found the boat going nowhere on.
 * An official code is the penalty card (penalty.ts), pinned outside the ranking: a scored OCS / UFD / BFD's over-the-line
 * figures move onto it from D1's 'ocs' card (which then isn't shown: D3 after it stays a card of its own), and so do
 * penalty turns (D12); with no code, penalty turns are a ranked card. Pure: the UI fills the templates.
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
import { detectHeel } from './detectors/heel';
import { detectGate } from './detectors/gate';
import { detectSide, withAlso } from './detectors/side';
import { detectNowhere } from './detectors/nowhere';
import { detectLineBias } from './detectors/lineBias';
import { detectManoeuvreCost } from './detectors/manoeuvreCost';
import { D3_GAP_S, D3_WINDOW_MS } from './detectors/early';
import { longestHole, longestHoleIn, trackLegAt } from './tracks';
import { coachCoverage, gapChange, rangeOf, type GoodNote, type Opportunity } from './opportunity';
import { median } from '../geo';
import { rankOpportunities, type Card } from './rank';
import { codeInfo } from '../../data/official/codes';
import { penaltyOf, turnCard, type PenaltyFinding } from './penalty';

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
/** A ✓ on a stretch the boat's tracker covered under this (coachCoverage) says "not enough data to judge …" (thinNote). */
export const OK_THIN_COVERAGE = 0.5;
/** Went well: at most this many, the most seconds first. */
export const WENT_WELL_MAX = 3;
/** A ➕ mostly inside a bigger one's window (over this share of its own) is the same gain: dropped. */
export const WENT_WELL_OVERLAP = 0.5;

export interface CoachDebrief {
  /** At most 3, best first. */
  cards: Card[];
  /** The official code's card (penalty.ts), pinned above `cards`: never ranked, never in `totalS`; null with no code. */
  penalty?: PenaltyFinding | null;
  /** ✓ Not the problem; `thin` ones: not enough data to judge (thinNote). */
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
  /** Which data-gated detectors had enough data (the Regatta view's denominators): D8, the kinds of mark D9 timed, the kinds of leg D11 compared heel on, a gate D13 judged. */
  quality: { D8: boolean; D9: MarkType[]; D11?: ('upwind' | 'downwind')[]; D13?: boolean };
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

/**
 * The start, as a ➕: crossed PLUS_START_S or more ahead of the leaders' median crossing (not when D1 fired:
 * a late or second-row start beside leaders who started worse is no gain); or gained PLUS_LANE_S on them in D3's window.
 */
export function startGains(ctx: CoachCtx, d1Fired = false): GoodNote[] {
  const out: GoodNote[] = [];
  const cross = ctx.m.crossMs;
  const mine = cross?.[ctx.boat] ?? null;
  const theirs = ctx.leaders.map((id) => cross?.[id] ?? null).filter((x): x is number => x != null);
  if (!d1Fired && mine != null && theirs.length >= Math.min(2, ctx.leaders.length) && theirs.length) {
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
 * their own: never; nor heel, D11, which says how a leg's gain was sailed); at most WENT_WELL_MAX.
 */
const MOMENTS = new Set<GoodNote['detector']>(['D1', 'D9', 'D11', 'D13', 'D16', 'D17']);

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

/**
 * A ✓ with the boat's coverage of what it judged (its own `coverage`, else the legs it names, else its window when it
 * has one, else the race): under OK_THIN_COVERAGE it is `thin` ("not enough data to judge …"). D13's gate notes are
 * moments with their own data gate (both buoys, fixes around the closest approach): left as they are.
 */
export function thinNote(ctx: CoachCtx, n: GoodNote, raceCov: number): GoodNote {
  if (n.detector === 'D13') return n;
  let cov = n.coverage;
  if (cov == null && typeof n.facts.legs === 'string' && n.facts.legs) {
    const names = n.facts.legs.split(' + ');
    let ms = 0;
    let got = 0;
    ctx.a.legs.forEach((l, k) => {
      const a = ctx.tr.bounds[k];
      const b = ctx.tr.bounds[k + 1];
      if (!names.includes(l.name) || a == null || b == null || !(b > a)) return;
      ms += b - a;
      got += coachCoverage(ctx.tr.t, a, b) * (b - a);
    });
    if (ms > 0) cov = got / ms;
  }
  if (cov == null) cov = n.t1 - n.t0 >= 60_000 ? coachCoverage(ctx.tr.t, n.t0, n.t1) : raceCov;
  return cov < OK_THIN_COVERAGE ? { ...n, coverage: cov, thin: true } : { ...n, coverage: cov };
}

/** D8 short of D8_ALONE_S rides on the early-lane card as a chip (spec §5); with no D3 card it has nowhere to show. */
export const attachShadow = (early: Opportunity | null, shadow: Pick<D8Result, 'chip'>): Opportunity | null =>
  early && shadow.chip ? { ...early, chips: [...(early.chips ?? []), shadow.chip] } : early;

/**
 * D1 and the D3 that follows it are one story (spec §5: the start card): one D1 card from gun − 10 s to D3's
 * end (crossing + 5 min), seconds = D1's (crossing − front row) + D3's (gap change from the crossing on: D3
 * never counts the time before it). D3's numbers ride in the facts (`d3*`, tacks, fleetTacks), its chips
 * (D2, D8) on the card; the noise ranges add in quadrature (independent reads); `parts` keeps each one's seconds
 * on its own stretch for the dedupe (rank.ts). Either alone stays as it is.
 */
export function mergeStart(d1: Opportunity | null, d3: Opportunity | null): { start: Opportunity | null; early: Opportunity | null } {
  if (!d1 || !d3) return { start: d1, early: d3 };
  const seconds = d1.seconds + d3.seconds;
  const noise = Math.hypot(Math.max(d1.secondsHi - d1.seconds, d1.seconds - d1.secondsLo), Math.max(d3.secondsHi - d3.seconds, d3.seconds - d3.secondsLo));
  const len1 = Math.max(0, d1.t1 - d1.t0);
  const len3 = Math.max(0, d3.t1 - d3.t0);
  const coverage = (d1.coverage * len1 + d3.coverage * len3) / Math.max(1, len1 + len3);
  const start: Opportunity = {
    ...d1,
    t1: Math.max(d1.t1, d3.t1),
    seconds,
    ...rangeOf(seconds, noise),
    coverage,
    // The lower of the two boat coverages; D3's references and wind (D1's front row is always enough when it fired on crossings).
    conf: { ...d3.conf, boatCov: Math.min(d1.conf.boatCov, d3.conf.boatCov) },
    facts: {
      ...d1.facts,
      d1S: d1.seconds,
      d3S: d3.seconds,
      d3Variant: d3.variant,
      tacks: d3.facts.tacks,
      lastTackS: d3.facts.lastTackS,
      fleetTacks: d3.facts.fleetTacks,
      gapEnd: d3.facts.gapEnd,
    },
    parts: [
      { t0: d1.t0, t1: d1.t1, seconds: d1.seconds },
      { t0: d3.t0, t1: d3.t1, seconds: d3.seconds },
    ],
    refBoats: [...new Set([...d1.refBoats, ...d3.refBoats])],
    chips: d3.chips,
    windEst: d3.windEst,
  };
  return { start, early: null };
}

const overlaps = (p: Opportunity, q: Opportunity): boolean => p.t0 < q.t1 && q.t0 < p.t1;

const spanOverlap = (p: Opportunity, q: Opportunity): boolean =>
  (p.spans ?? [[p.t0, p.t1]]).some(([a, b]) => (q.spans ?? [[q.t0, q.t1]]).some(([c, d]) => a < d && c < b));

/** D6 / D7 name the fired legs in `facts.legs` (`Beat 1 + Beat 2`); D11 names one in `facts.leg`. */
const sameAngleLeg = (angle: Opportunity, heel: Opportunity): boolean => {
  const name = heel.facts.leg;
  if (typeof name !== 'string' || !name) return false;
  const legs = angle.facts.legs ?? angle.facts.leg;
  return typeof legs === 'string' && legs.split(' + ').includes(name);
};

/**
 * D11 on a leg where D6 / D7 already fired (the same VMG loss, measured against the fleet): a chip on
 * that card (its facts, with the variant), not a card of its own; the rest stay D11 cards.
 * Match the timed spans, or the named leg when D6/D7 summed several and a window-align miss would
 * otherwise leave both cards (and count the same seconds twice).
 */
export function attachHeel(angles: readonly (Opportunity | null)[], heel: readonly Opportunity[]): { angles: (Opportunity | null)[]; heel: Opportunity[] } {
  const out = angles.map((o) => o);
  const rest: Opportunity[] = [];
  for (const h of heel) {
    const want = h.facts.legKind === 'upwind' ? 'D6' : 'D7';
    const i = out.findIndex((o) => o && o.kind === want && (spanOverlap(o, h) || sameAngleLeg(o, h)));
    if (i < 0) {
      rest.push(h);
      continue;
    }
    const o = out[i]!;
    out[i] = { ...o, chips: [...(o.chips ?? []), { kind: 'D11', facts: { ...h.facts, variant: h.variant, seconds: h.seconds } }] };
  }
  return { angles: out, heel: rest };
}

/**
 * D9's low-resolution places card at a gate rounding where D13 fired (the same places lost, read across the
 * rounding): a chip on the D13 card, not a card of its own (no double count). D9's zone-time card (handling, not
 * the choice) stays a card.
 */
export function attachGatePlaces(gate: readonly Opportunity[], round: readonly Opportunity[]): { gate: Opportunity[]; round: Opportunity[] } {
  const out = gate.map((o) => o);
  const rest: Opportunity[] = [];
  for (const r of round) {
    const i = r.facts.mode === 'places' ? out.findIndex((o) => o.facts.leg != null && o.facts.leg === r.facts.leg) : -1;
    if (i < 0) {
      rest.push(r);
      continue;
    }
    const o = out[i];
    out[i] = { ...o, chips: [...(o.chips ?? []), { kind: 'D9', facts: { ...r.facts, seconds: r.seconds } }] };
  }
  return { gate: out, round: rest };
}

/**
 * D14 is one card a race: of the legs on the side that didn't pay, the one that keeps the most seconds once the race's
 * other findings have claimed theirs (rank.ts, uncapped: a run D7 already holds keeps none), the others riding on it
 * (side.ts withAlso) with the seconds they keep there. No leg keeps any: the most seconds.
 */
export function sideCard(legs: readonly Opportunity[], others: readonly Opportunity[]): Opportunity | null {
  if (legs.length < 2) return legs[0] ?? null;
  const kept = new Map(rankOpportunities([...others, ...legs], Infinity).filter((c) => c.kind === 'D14').map((c) => [c.facts.leg, c.seconds]));
  const best = legs.reduce<Opportunity | undefined>((b, o) => ((kept.get(o.facts.leg) ?? 0) > (b ? (kept.get(b.facts.leg) ?? 0) : 0) ? o : b), undefined);
  return withAlso(legs, best, (o) => kept.get(o.facts.leg) ?? 0);
}

/** A gain given back (D5) explains its stretch better than "the wrong side" (D4) of the same swing: D4 only clear of every D5. */
export const d4Unless = (d4: Opportunity | null, d5: readonly Opportunity[]): Opportunity | null => (d4 && !d5.some((o) => overlaps(o, d4)) ? d4 : null);

export function coachDebrief(a: RaceAnalysis, m: CoachModel, boat: string): CoachDebrief | null {
  const ctx = coachCtx(a, m, boat);
  if (!ctx) return null;
  const start = detectStart(ctx);
  const rolled = detectRolled(ctx);
  const early = detectEarly(ctx, { crossMs: start.crossMs, d1Fired: start.fired }, rolled);
  const nowhere = detectNowhere(ctx);
  // A leg where the boat sailed extra distance for its progress (D15) is never "fine" on D6 / D7's ✓.
  const worse = new Set(nowhere.worse);
  const up = detectAngles(ctx, 'upwind', worse);
  const down = detectAngles(ctx, 'downwind', worse);
  const side = detectSide(ctx);
  const bias = detectLineBias(ctx);
  const moves = detectManoeuvreCost(ctx);
  const last = detectLastLeg(ctx);
  const cons = detectConsolidate(ctx);
  const shift = detectShift(ctx);
  const d4 = d4Unless(shift.opp, cons.opps);
  const shadow = detectShadow(ctx);
  const round = detectRounding(ctx);
  const gate = detectGate(ctx);
  const gated = attachGatePlaces(gate.opps, round.opps);
  const heel = detectHeel(ctx);
  // A scored start code (OCS / UFD / BFD) is the penalty card: D1's 'ocs' card ("Over early — cleared") moves onto it.
  const code = ctx.me.finishCode ?? null;
  const ocsToPenalty = !!code && !!codeInfo(code).start && start.opp?.variant === 'ocs';
  const turns = m.turns?.get(boat) ?? [];
  const penalty = penaltyOf(ctx, turns, m.overStart?.get(boat) ?? null);
  const merged = mergeStart(ocsToPenalty ? null : start.opp, attachShadow(early, shadow));
  const withHeel = attachHeel([up.opp, down.opp], heel.opps);
  const [d6, d7] = withHeel.angles;
  // Penalty turns: on the penalty card with a code, else a ranked card of their own.
  const turnOpp = penalty ? null : turnCard(ctx, turns);
  const present = (o: Opportunity | null): o is Opportunity => !!o;
  const head = [merged.start, merged.early, d4, ...cons.opps, d6, d7, shadow.opp, ...gated.round, ...gated.gate, ...withHeel.heel, last, turnOpp].filter(present);
  const tail = [...nowhere.opps, bias.opp, ...moves.opps].filter(present);
  const found = [...head, sideCard(side.legs, [...head, ...tail]), ...tail].filter(present);
  const clearAir: GoodNote | null =
    shadow.evaluated && !shadow.opp && !shadow.chip ? { kind: 'ok', detector: 'D8', variant: 'ok', facts: { share: shadow.share, fleetShare: shadow.fleetShare }, t0: ctx.gun, t1: m.endMs } : null;
  const end = ctx.me.finishMs ?? m.endMs;
  const raceCov = coachCoverage(ctx.tr.t, ctx.gun, end);
  const ok = [start.ok, shift.opp ? null : shift.ok, cons.opps.length ? null : cons.ok, up.ok, down.ok, clearAir, round.ok, heel.ok, ...gate.notes]
    .filter((o): o is GoodNote => !!o)
    .map((o) => thinNote(ctx, o, raceCov));
  const dense = found.some((o) => o.coverage >= OK_WINDOW) || ok.some((o) => !o.thin);
  const noData = raceCov < RACE_MIN_COVERAGE && !dense;
  // Each card's longest hole, for a low-confidence card's ⚠ chip (D17's within its measured stretches, not between them).
  const holeOf = (c: Opportunity): ReturnType<typeof longestHole> => (c.kind === 'D17' && c.spans ? longestHoleIn(ctx.tr.t, c.spans) : longestHole(ctx.tr.t, c.t0, c.t1));
  const cards = (noData ? [] : rankOpportunities(found)).map((c) => ({ ...c, conf: { ...c.conf, hole: holeOf(c) } }));
  return {
    cards,
    penalty,
    ok: noData ? [] : ok,
    plus: noData ? [] : wentWell([...legGains(ctx), ...round.good, ...gate.good, ...startGains(ctx, start.fired), ...heel.plus, ...(side.good ? [side.good] : []), ...nowhere.good, ...(bias.good ? [bias.good] : []), ...(moves.good ? [moves.good] : [])]),
    totalS: cards.reduce((s, c) => s + c.seconds, 0),
    raceCov,
    noData,
    found,
    dirtyAir: shadow,
    quality: { D8: shadow.evaluated, D9: round.evaluated, D11: heel.evaluated, D13: gate.evaluated },
  };
}
