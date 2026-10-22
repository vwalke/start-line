/**
 * D14 · Side of the course (the leg story's side, legStory.ts fleetSide, as a ranked card). On each beat and run the
 * whole fleet (the Coach's groups are too small for thirds) is cut in thirds by its mean position across the wind
 * (+ = right looking upwind); the right third's mean fleet places gained minus the left third's is the effect.
 *
 * - Fires when that side paid by D14_MIN_EFFECT places or more and D14_MIN_Z standard errors (the thirds' spread of places
 *   gained), over D14_MIN_THIRD boats a third or more, and the boat
 *   was in the other outer third, with its own position known at mid-leg (somewhere in the leg's middle third: a fix
 *   within SIDE_NEAR_S, holes up to SIDE_SPAN_S). Without its own position there is no card: the side is then only the leg story's fleet note.
 * - Seconds = the effect × the fleet's seconds per place at the leg's end around the boat's place there (the
 *   rounding times D14_SPP_PLACES places either side), as D9's sparse-data card reads places as time.
 * - Confidence: the boat's coverage of the leg, the wind's, medium with under D14_HIGH_THIRD boats a third.
 * - ➕ Went well: in the paying third, and it gained places on the leg: min(gain, effect) places as seconds.
 */
import type { LegKind } from '../../types';
import { fleetPlaces, fleetSideOf, SIDE_NEAR_S, SIDE_SPAN_S, type FleetPlaces } from '../legStory';
import { NOISE_BASE_S, coachCoverage, rangeOf, windOkShare, type GoodNote, type Opportunity } from '../opportunity';
import { posAt } from '../tracks';
import type { CoachCtx } from './context';

/** The paying third gained at least this many places more than the other… */
export const D14_MIN_EFFECT = 3;
/** …by at least this many standard errors of the thirds' places gained (a third's mean over a few boats is noisy)… */
export const D14_MIN_Z = 2;
/** …over at least this many boats a third… */
export const D14_MIN_THIRD = 5;
/** …and with fewer than this a third the card is medium at best. */
export const D14_HIGH_THIRD = 10;
/** Seconds per place: the rounding times this many places either side of the boat's place at the leg's end. */
export const D14_SPP_PLACES = 3;
/** ➕ needs this much of the leg tracked (low confidence's floor, opportunity.ts covLevel). */
export const D14_PLUS_COVERAGE = 0.25;
/** The range: ± this share of the seconds (the effect is a mean over a third of the fleet). */
export const D14_REL_ERR = 0.4;

export interface D14Result {
  opps: Opportunity[];
  good: GoodNote[];
}

/** The fleet's seconds per place at column `col` around place `place`: from the elapsed times D14_SPP_PLACES places either side; null with too few. */
export function secondsPerPlace(fp: FleetPlaces, col: number, place: number): number | null {
  const rows = [...fp.byId.values()]
    .filter((r) => r.place[col] != null && r.elapsedS[col] != null && !r.est[col])
    .map((r) => ({ p: r.place[col]!, s: r.elapsedS[col]! }))
    .sort((a, b) => a.p - b.p);
  const near = rows.filter((r) => Math.abs(r.p - place) <= D14_SPP_PLACES);
  if (near.length < 3) return null;
  const first = near[0];
  const last = near[near.length - 1];
  return last.p > first.p ? Math.max(0, (last.s - first.s) / (last.p - first.p)) : null;
}

/** When the boat sailed leg `k`: its timed leg, else its track's bounds; null when unknown. */
function spanOf(ctx: CoachCtx, k: number): [number, number] | null {
  const l = ctx.me.legs[k];
  if (l) return [l.startMs, l.endMs];
  const a = ctx.tr.bounds[k];
  const b = ctx.tr.bounds[k + 1];
  return a != null && b != null && b > a ? [a, b] : null;
}

/** The middle third of the leg is read every this often for the boat's own position, ms. */
export const D14_MID_STEP_MS = 10_000;

/** The boat's position is known somewhere in the middle third of [a, b] (holes up to SIDE_SPAN_S, a fix within SIDE_NEAR_S). */
function midLegKnown(ctx: CoachCtx, [a, b]: [number, number]): boolean {
  const third = (b - a) / 3;
  for (let t = a + third; t <= b - third; t += D14_MID_STEP_MS) if (posAt(ctx.tr, t, SIDE_SPAN_S, SIDE_NEAR_S)) return true;
  return false;
}

export function detectSide(ctx: CoachCtx): D14Result {
  const out: D14Result = { opps: [], good: [] };
  let fp: FleetPlaces | null = null;
  ctx.a.legs.forEach((leg, k) => {
    if (leg.kind !== 'upwind' && leg.kind !== 'downwind') return;
    const fs = fleetSideOf(ctx.a, ctx.m, k);
    if (!fs || fs.verdict === 'none' || Math.abs(fs.effect) < D14_MIN_EFFECT || fs.z < D14_MIN_Z || fs.n < D14_MIN_THIRD) return;
    const x = fs.x.get(ctx.boat);
    const span = spanOf(ctx, k);
    if (x == null || !span) return;
    // Its own position at mid-leg (somewhere in the leg's middle third): a side is not judged from the ends of a hole.
    if (!midLegKnown(ctx, span)) return;
    const paid = fs.verdict;
    const other = paid === 'right' ? 'left' : 'right';
    const losing = paid === 'right' ? x <= fs.leftCut : x >= fs.rightCut;
    const paying = paid === 'right' ? x >= fs.rightCut : x <= fs.leftCut;
    if (!losing && !paying) return;
    fp ??= fleetPlaces(ctx.a);
    const row = fp.byId.get(ctx.boat);
    const end = row?.place[k + 1] ?? null;
    if (!row || end == null) return;
    const gain = row.place[k] != null ? row.place[k]! - end : null;
    const cov = coachCoverage(ctx.tr.t, span[0], span[1]);
    const spp = secondsPerPlace(fp, k + 1, end);
    if (spp == null) return;
    const effect = Math.abs(fs.effect);
    const facts = {
      leg: leg.name,
      legKind: leg.kind as LegKind,
      paid,
      other,
      effect,
      n: fs.n,
      of: fs.of,
      mineM: Math.abs(x),
      mySide: x >= 0 ? 'right' : 'left',
      gain,
      spp,
    };
    if (losing) {
      const seconds = effect * spp;
      out.opps.push({
        kind: 'D14',
        variant: 'wrong-side',
        t0: span[0],
        t1: span[1],
        seconds,
        ...rangeOf(seconds, NOISE_BASE_S + D14_REL_ERR * seconds),
        confidence: 'high',
        coverage: cov,
        conf: { boatCov: cov, windOk: windOkShare(ctx.m.wind, span[0], span[1]), ...(fs.n < D14_HIGH_THIRD ? { refCap: 'medium' as const } : {}) },
        facts,
        refBoats: [],
      });
    } else if (gain != null && gain > 0 && cov >= D14_PLUS_COVERAGE) {
      const seconds = Math.min(gain, effect) * spp;
      out.good.push({ kind: 'plus', detector: 'D14', variant: 'paid', facts: { ...facts, gainS: seconds }, t0: span[0], t1: span[1], seconds });
    }
  });
  return out;
}
