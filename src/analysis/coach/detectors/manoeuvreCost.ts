/**
 * D17 · Manoeuvre cost: the ground each tack (on a beat) and gybe (on a run) cost against the boat's own steady sailing
 * just before it, set against the fleet's on the same leg; and how many it made against the fleet's count there.
 *
 * - The manoeuvres are manoeuvres.ts detectManoeuvres on the coach track (the race view's tack and gybe counts), each
 *   at its head-to-wind / dead-downwind crossing. Each is measured like for like: the steady window is the
 *   D17_PRE_MS ending D17_LEAD_MS before the crossing (the turn starts a few seconds before it); its VMG (progress
 *   along the wind at the crossing ÷ time: toward it upwind, away downwind) is the baseline. From the steady window's
 *   end through the turn to D17_TACK_RECOVER_MS (D17_GYBE_RECOVER_MS) after the crossing, the ground the boat would
 *   have made at that VMG less what it made is the metres lost; ÷ the baseline VMG the seconds.
 * - Measured only on dense fixes (no gap over D17_MAX_GAP_MS from the steady window's start to the recovery's end, a
 *   fix within D17_NEAR_FIX_MS of each window's end, never a turn across a telemetry gap: a hole there is skipped),
 *   with no other manoeuvre in that stretch (a tacking duel has no steady baseline), at a baseline VMG of D17_MIN_VMG
 *   or more, and with the whole stretch inside the leg, D17_ROUND_CLEAR_MS clear of its roundings. The wind is the
 *   fleet's at the crossing for both windows: a turn on a header onto a lift reads cheap, which the fleet's own
 *   turns share (the comparison is like for like).
 * - The gybe-set: on a run after a windward mark, a gybe up to legStory's set window (ROUND_LEAD_MS before the
 *   rounding to ROUND_WINDOW_MS after the boat first sails downwind, firstDownwindMs: about 90 s past an offset mark)
 *   is the rounding's (the leg story's gybe-set vs bear-away), not a gybe of the run: never counted or measured here,
 *   for the boat or the fleet, and no stretch measured starts before that window ends.
 * - Per boat and leg: the median metres of its measured manoeuvres and the count; the fleet's median is pooled over
 *   the other boats' measured manoeuvres on the leg (D17_MIN_REF_BOATS boats, D17_MIN_REF_MANS manoeuvres), its
 *   count the median over boats whose count is trusted (D17_COUNT_COVERAGE of the leg tracked, no manoeuvre
 *   across a gap). Extra metres = n × (median − fleet median) [handling] + (n − fleet count) × fleet median [count,
 *   only when both counts are trusted].
 * - One manoeuvre's metres swing with the puffs and shifts around it (tens of metres on the runs), so a median of a
 *   few is noisy: the difference of the medians is judged against its standard error, from the fleet's spread on the
 *   leg (the pooled metres' interquartile range ÷ 1.349) and both sample sizes (a median's error is 1.2533 σ ÷ √n).
 * - A card when the extra is D17_MIN_EXTRA_M or D17_MIN_EXTRA_S or more and either the median is costly
 *   (D17_COST_FACTOR × the fleet's, D17_MIN_DIFF_M more, and D17_MIN_Z standard errors more) or the count is well above
 *   the fleet's (D17_COUNT_EXTRA more and D17_COUNT_FACTOR × it), with D17_MIN_MEASURED measured. Seconds = extra
 *   metres ÷ the boat's median baseline VMG; the range ± NOISE_BASE_S + n standard errors at that VMG. The window is the manoeuvres' own stretches (`spans`), so a rate finding on the leg gives up only
 *   those. Confidence: the share of its manoeuvres measured and its leg coverage (the lower; covLevel), the fleet's
 *   boats with D17_MIN_MEASURED measured as the references, the wind's, medium under D17_HIGH_MEASURED measured.
 * - One card a race per kind of manoeuvre: the leg that cost the most, the others riding on it (side.ts withAlso).
 * - ➕ Went well: a median of D17_GOOD_FACTOR × the fleet's or better (D17_MIN_DIFF_M and D17_MIN_Z standard errors
 *   less), worth D17_GOOD_MIN_S or more over its manoeuvres on the leg; one a race, the others riding on it.
 */
import { MS_TO_KN, bearingVec, dot, median, sub } from '../../geo';
import { detectManoeuvres, MAN_GAP_MS, type Manoeuvre, type ManoeuvreTrack } from '../../manoeuvres';
import type { LegKind } from '../../types';
import type { CoachModel } from '../index';
import { firstDownwindMs, ROUND_LEAD_MS, ROUND_WINDOW_MS } from '../legStory';
import { NOISE_BASE_S, coachCoverage, rangeOf, windOkShare, type GoodNote, type Opportunity } from '../opportunity';
import { posAt, type CoachTrack } from '../tracks';
import type { CoachCtx } from './context';
import { withAlso } from './side';

/** The steady window before a manoeuvre, ms… */
export const D17_PRE_MS = 25_000;
/** …ending this long before the crossing (the turn starts a few seconds before head-to-wind / dead downwind), ms. */
export const D17_LEAD_MS = 8_000;
/** Through the tack and its recovery: to this long after the crossing, ms. */
export const D17_TACK_RECOVER_MS = 30_000;
/** Through the gybe and its recovery (kite and angle settle slower), ms. */
export const D17_GYBE_RECOVER_MS = 40_000;
/**
 * Fix density: no gap longer than this from the steady window's start to the recovery's end, ms: twice manoeuvres.ts'
 * telemetry gap (a turn across a gap is never measured: detectManoeuvres flags it), too short to hide another manoeuvre
 * (a side is held MAN_DWELL_MS before it counts).
 */
export const D17_MAX_GAP_MS = 2 * MAN_GAP_MS;
/** The three positions read (the windows' ends) need a fix this close, ms (manoeuvres.ts' telemetry gap). */
export const D17_NEAR_FIX_MS = MAN_GAP_MS;
/** The measured stretch stays this far inside the leg (clear of the roundings), ms. */
export const D17_ROUND_CLEAR_MS = 15_000;
/** A baseline VMG under this is no steady sailing (stopped, luffing), m/s. */
export const D17_MIN_VMG = 0.5;
/** The boat needs this many manoeuvres measured on the leg. */
export const D17_MIN_MEASURED = 3;
/** …and under this many its card is medium at best. */
export const D17_HIGH_MEASURED = 5;
/** The fleet's median needs this many other boats with a manoeuvre measured on the leg… */
export const D17_MIN_REF_BOATS = 5;
/** …and this many manoeuvres between them. */
export const D17_MIN_REF_MANS = 10;
/** A count is trusted with this share of the leg tracked (coachCoverage) and no manoeuvre across a gap. */
export const D17_COUNT_COVERAGE = 0.8;
/** Costly: the median at least this many times the fleet's… */
export const D17_COST_FACTOR = 1.3;
/** …and at least this much more per manoeuvre, m (a fleet median of a few metres makes any ratio big). */
export const D17_MIN_DIFF_M = 4;
/** Many: at least this many more than the fleet's median count… */
export const D17_COUNT_EXTRA = 2;
/** …and at least this many times it. */
export const D17_COUNT_FACTOR = 1.5;
/** Material: the extra over the leg at least this much, m… */
export const D17_MIN_EXTRA_M = 25;
/** …or this much, s. */
export const D17_MIN_EXTRA_S = 10;
/** ➕: the median at most this many times the fleet's (and D17_MIN_DIFF_M less)… */
export const D17_GOOD_FACTOR = 0.7;
/** …worth this much or more over its manoeuvres on the leg, s. */
export const D17_GOOD_MIN_S = 10;
/** Costly or smooth by at least this many standard errors of the difference of the medians (as D14_MIN_Z). */
export const D17_MIN_Z = 2;
/** A median's standard error is this × σ ÷ √n (normal samples). */
export const MEDIAN_SE = 1.2533;
/** σ from the interquartile range (normal samples). */
export const IQR_SIGMA = 1.349;

export type ManKind = Manoeuvre['kind'];

/** One manoeuvre's cost against the steady sailing before it. */
export interface ManoeuvreLoss {
  tMs: number;
  /** Metres lost (+) through the turn and its recovery, at the baseline VMG. */
  lossM: number;
  lossS: number;
  /** The baseline VMG, m/s. */
  vmg: number;
}

/** No gap over D17_MAX_GAP_MS in the fixes from `a` to `b` (a fix at or before `a` and at or after `b`). */
export function denseAround(t: ArrayLike<number>, a: number, b: number): boolean {
  const n = t.length;
  if (!n || t[0] > a || t[n - 1] < b) return false;
  let i = 0;
  while (i + 1 < n && t[i + 1] <= a) i++;
  for (; i + 1 < n && t[i] < b; i++) if (t[i + 1] - t[i] > D17_MAX_GAP_MS) return false;
  return true;
}

/**
 * The cost of the manoeuvre crossing at `tMs` (see the header), the wind at the crossing for both windows; null
 * across a gap or with no steady baseline.
 */
export function manoeuvreLoss(tr: Pick<CoachTrack, 't' | 'x' | 'y'>, tMs: number, kind: ManKind, legKind: LegKind, twdAt: (t: number) => number): ManoeuvreLoss | null {
  const a = tMs - D17_LEAD_MS - D17_PRE_MS;
  const b = tMs - D17_LEAD_MS;
  const c = tMs + (kind === 'tack' ? D17_TACK_RECOVER_MS : D17_GYBE_RECOVER_MS);
  if (!denseAround(tr.t, a, c)) return null;
  const span = D17_MAX_GAP_MS / 1000;
  const near = D17_NEAR_FIX_MS / 1000;
  const pa = posAt(tr, a, span, near);
  const pb = posAt(tr, b, span, near);
  const pc = posAt(tr, c, span, near);
  if (!pa || !pb || !pc) return null;
  const w = bearingVec(twdAt(tMs));
  const sign = legKind === 'downwind' ? -1 : 1;
  const vmg = (sign * dot(sub(pb, pa), w)) / (D17_PRE_MS / 1000);
  if (!(vmg >= D17_MIN_VMG)) return null;
  const made = sign * dot(sub(pc, pb), w);
  const lossM = (vmg * (c - b)) / 1000 - made;
  return { tMs, lossM, lossS: lossM / vmg, vmg };
}

/** The stretch a manoeuvre's cost is read over: the steady window's end to the recovery's end, ms. */
export const lossSpan = (tMs: number, kind: ManKind): [number, number] => [tMs - D17_LEAD_MS, tMs + (kind === 'tack' ? D17_TACK_RECOVER_MS : D17_GYBE_RECOVER_MS)];

/** One boat's manoeuvres of the leg's kind on one leg. */
export interface LegManoeuvres {
  leg: number;
  kind: ManKind;
  legKind: LegKind;
  /** Counted (the gybe-set left out), crossing times. */
  times: number[];
  /** The count is trusted (D17_COUNT_COVERAGE tracked, none across a gap). */
  trusted: boolean;
  measured: ManoeuvreLoss[];
  /** The boat's coverage of the leg (coachCoverage), 0–1. */
  cov: number;
  t0: number;
  t1: number;
}

/** When the gybe-set window after the windward-mark rounding at `roundMs` ends (legStory classifyRounding's window). */
export const setEndMs = (tr: ManoeuvreTrack, twdAt: (t: number) => number, roundMs: number): number => firstDownwindMs(tr, twdAt, roundMs) + ROUND_WINDOW_MS;

/** A boat's manoeuvres on each beat and run it has timed (see the header); null where not. */
export function boatManoeuvres(m: CoachModel, a: CoachCtx['a'], id: string): (LegManoeuvres | null)[] {
  const tr = m.tracks.get(id);
  const b = a.boats.find((x) => x.id === id);
  if (!tr || !b || tr.t.length < 2) return a.legs.map(() => null);
  const twdAt = m.wind.twdAt;
  const from = b.legs.find((l) => l)?.startMs ?? m.gunMs;
  const to = [...b.legs].reverse().find((l) => l)?.endMs ?? tr.t[tr.t.length - 1];
  const all = detectManoeuvres(tr, twdAt, from, to);
  return a.legs.map((leg, k) => {
    const l = b.legs[k];
    if (!l || (leg.kind !== 'upwind' && leg.kind !== 'downwind')) return null;
    const kind: ManKind = leg.kind === 'upwind' ? 'tack' : 'gybe';
    // The gybe-set belongs to the rounding (legStory's window), never to the run.
    const afterWindward = leg.kind === 'downwind' && k > 0 && a.legs[k - 1].kind === 'upwind';
    const setEnd = afterWindward ? setEndMs(tr, twdAt, l.startMs) : null;
    const onLeg = all.filter((x) => x.tMs >= l.startMs && x.tMs < l.endMs);
    const mine = onLeg.filter((x) => x.kind === kind && !(setEnd != null && x.tMs >= l.startMs - ROUND_LEAD_MS && x.tMs <= setEnd));
    const clearFrom = Math.max(l.startMs + D17_ROUND_CLEAR_MS, setEnd ?? -Infinity);
    const clearTo = l.endMs - D17_ROUND_CLEAR_MS;
    const measured: ManoeuvreLoss[] = [];
    for (const x of mine) {
      const pre = x.tMs - D17_LEAD_MS - D17_PRE_MS;
      const end = lossSpan(x.tMs, kind)[1];
      if (x.gap || pre < clearFrom || end > clearTo) continue;
      // Steady sailing: no other manoeuvre (of any kind) from the steady window's start to the recovery's end.
      if (all.some((y) => y !== x && y.tMs >= pre && y.tMs <= end)) continue;
      const loss = manoeuvreLoss(tr, x.tMs, kind, leg.kind, twdAt);
      if (loss) measured.push(loss);
    }
    const cov = coachCoverage(tr.t, l.startMs, l.endMs);
    return { leg: k, kind, legKind: leg.kind, times: mine.map((x) => x.tMs), trusted: cov >= D17_COUNT_COVERAGE && !onLeg.some((x) => x.gap), measured, cov, t0: l.startMs, t1: l.endMs };
  });
}

/** Every boat's legs, once per model (every boat's debrief reads the same fleet). */
const memo = new WeakMap<CoachModel, Map<string, (LegManoeuvres | null)[]>>();
export function fleetManoeuvres(ctx: Pick<CoachCtx, 'a' | 'm'>): Map<string, (LegManoeuvres | null)[]> {
  let out = memo.get(ctx.m);
  if (!out) {
    out = new Map(ctx.a.boats.map((b) => [b.id, boatManoeuvres(ctx.m, ctx.a, b.id)]));
    memo.set(ctx.m, out);
  }
  return out;
}

/** The boat against the fleet on one leg; null when either side is too thin to compare. */
export interface LegCost {
  mine: LegManoeuvres;
  /** Its median metres and seconds a manoeuvre, its median baseline VMG (m/s). */
  medM: number;
  medS: number;
  vmg: number;
  /** The fleet's median metres a manoeuvre (pooled), and over how many boats / manoeuvres. */
  fMedM: number;
  refBoats: number;
  refMans: number;
  /** Fleet boats with D17_MIN_MEASURED measured (the confidence's references). */
  refGood: number;
  /** The fleet's median count over trusted counts; null when too few. */
  fN: number | null;
  /** The difference of the medians' standard error, m (see the header). */
  seM: number;
  /** Extra metres: handling (n × the median's excess) and count ((n − fleet count) × the fleet's median, trusted counts only). */
  handlingM: number;
  countM: number;
  extraM: number;
  extraS: number;
}

export function legCost(ctx: Pick<CoachCtx, 'a' | 'm' | 'boat'>, k: number): LegCost | null {
  const fleet = fleetManoeuvres(ctx);
  const mine = fleet.get(ctx.boat)?.[k];
  if (!mine || mine.measured.length < D17_MIN_MEASURED) return null;
  const others = [...fleet.entries()].filter(([id]) => id !== ctx.boat).map(([, legs]) => legs[k]).filter((x): x is LegManoeuvres => !!x);
  const withMeasured = others.filter((x) => x.measured.length);
  const pooled = withMeasured.flatMap((x) => x.measured.map((y) => y.lossM));
  if (withMeasured.length < D17_MIN_REF_BOATS || pooled.length < D17_MIN_REF_MANS) return null;
  const counts = others.filter((x) => x.trusted).map((x) => x.times.length);
  const fN = counts.length >= D17_MIN_REF_BOATS ? median(counts) : null;
  const medM = median(mine.measured.map((x) => x.lossM));
  const vmg = median(mine.measured.map((x) => x.vmg));
  const fMedM = median(pooled);
  const sigma = (quantile(pooled, 0.75) - quantile(pooled, 0.25)) / IQR_SIGMA;
  const seM = MEDIAN_SE * sigma * Math.sqrt(1 / mine.measured.length + 1 / pooled.length);
  const n = mine.times.length;
  const handlingM = n * (medM - fMedM);
  const countM = mine.trusted && fN != null ? (n - fN) * fMedM : 0;
  const extraM = handlingM + countM;
  return {
    mine,
    medM,
    medS: medM / vmg,
    vmg,
    fMedM,
    refBoats: withMeasured.length,
    refMans: pooled.length,
    refGood: withMeasured.filter((x) => x.measured.length >= D17_MIN_MEASURED).length,
    fN,
    seM,
    handlingM,
    countM,
    extraM,
    extraS: extraM / vmg,
  };
}

/** The `p` quantile of `xs` (linear between the sorted values). */
export function quantile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}

/** Costly per manoeuvre (see the header). */
export const costly = (c: Pick<LegCost, 'medM' | 'fMedM' | 'seM'>): boolean =>
  c.medM - c.fMedM >= Math.max(D17_MIN_DIFF_M, (D17_COST_FACTOR - 1) * Math.abs(c.fMedM), D17_MIN_Z * c.seM);
/** Many more than the fleet (trusted counts only). */
export const tooMany = (n: number, fN: number | null, trusted: boolean): boolean => trusted && fN != null && n - fN >= D17_COUNT_EXTRA && n >= fN * D17_COUNT_FACTOR;
/** Material over the leg. */
export const material = (c: Pick<LegCost, 'extraM' | 'extraS'>): boolean => c.extraM >= D17_MIN_EXTRA_M || c.extraS >= D17_MIN_EXTRA_S;
/** Better than the fleet per manoeuvre (the ➕'s rule, before its seconds). */
export const smooth = (c: Pick<LegCost, 'medM' | 'fMedM' | 'seM'>): boolean =>
  c.fMedM - c.medM >= Math.max(D17_MIN_DIFF_M, (1 - D17_GOOD_FACTOR) * Math.abs(c.fMedM), D17_MIN_Z * c.seM);

export interface D17Result {
  /** At most one a kind of manoeuvre (tacks, gybes), the race's other such legs riding on it. */
  opps: Opportunity[];
  good: GoodNote | null;
  /** Every leg compared (for the tests and the ⓘ). */
  legs: LegCost[];
}

export function detectManoeuvreCost(ctx: CoachCtx): D17Result {
  const legs: LegCost[] = [];
  const cards: Opportunity[] = [];
  const good: GoodNote[] = [];
  ctx.a.legs.forEach((leg, k) => {
    const c = legCost(ctx, k);
    if (!c) return;
    legs.push(c);
    const mine = c.mine;
    const n = mine.times.length;
    const facts = {
      leg: leg.name,
      legKind: mine.legKind,
      man: mine.kind,
      n,
      measured: mine.measured.length,
      medM: c.medM,
      medS: c.medS,
      fMedM: c.fMedM,
      fMedS: c.fMedM / c.vmg,
      fN: c.fN,
      extraM: c.extraM,
      handlingM: c.handlingM,
      countM: c.countM,
      vmg: c.vmg * MS_TO_KN,
      refN: c.refBoats,
    };
    const many = tooMany(n, c.fN, mine.trusted);
    if (material(c) && (costly(c) || many) && c.extraS > 0) {
      const seconds = c.extraS;
      const share = n ? mine.measured.length / n : 0;
      const boatCov = Math.min(share, mine.cov);
      cards.push({
        kind: 'D17',
        variant: mine.kind,
        t0: mine.times.length ? lossSpan(mine.times[0], mine.kind)[0] : mine.t0,
        t1: mine.times.length ? lossSpan(mine.times[mine.times.length - 1], mine.kind)[1] : mine.t1,
        spans: mine.times.map((t) => lossSpan(t, mine.kind)),
        seconds,
        ...rangeOf(seconds, NOISE_BASE_S + (n * c.seM) / c.vmg),
        confidence: 'high',
        coverage: boatCov,
        conf: {
          boatCov,
          refs: { good: c.refGood, fair: c.refBoats, need: 3 },
          windOk: windOkShare(ctx.m.wind, mine.t0, mine.t1),
          ...(mine.measured.length < D17_HIGH_MEASURED ? { refCap: 'medium' as const } : {}),
        },
        facts: { ...facts, many: many ? 1 : 0 },
        refBoats: [],
      });
    } else if (smooth(c)) {
      const seconds = (n * (c.fMedM - c.medM)) / c.vmg;
      if (seconds >= D17_GOOD_MIN_S) good.push({ kind: 'plus', detector: 'D17', variant: mine.kind, facts: { ...facts, gainS: seconds }, t0: mine.t0, t1: mine.t1, seconds });
    }
  });
  const opps = (['tack', 'gybe'] as const).map((v) => withAlso(cards.filter((o) => o.variant === v))).filter((o): o is Opportunity => !!o);
  return { opps, good: withAlso(good), legs };
}
