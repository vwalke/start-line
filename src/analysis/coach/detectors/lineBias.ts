/**
 * D16 · Line bias: where along a biased start line the boat started, against the fleet. With the line D16_MIN_DEG or
 * more off square to the wind at the gun (line.ts lineBias: at 6° the favoured end is about a tenth of the line further
 * upwind), the boat's distance along the line beyond the fleet's median start (StartResult.linePosPct), toward the
 * unfavoured end, × sin(bias) is the ground it gave away on the fleet (the share of the line × the favoured-by metres);
 * ÷ the fleet's VMG on the first leg is the seconds.
 *
 * - Fires when it started further toward the unfavoured end than the fleet's median and that ground is material
 *   (D16_MATERIAL_S or more at the fleet's Beat-1 VMG); a start card, its window the approach (gun − D16_PRE_MS to
 *   gun − D1_PRE_MS: the D1 card's own window is the line crossing).
 * - ➕ Went well: in the third of the line at the favoured end (D16_GOOD_SHARE) and at or toward the favoured end of the
 *   fleet's median, the seconds gained on the median.
 * - Anywhere else (beyond the median by less than D16_MATERIAL_S, or toward the favoured end of it outside the favoured
 *   third): nothing (no card, no ➕).
 * - Needs the boat's position at the gun read (no hole, or estimated across one: StartResult.estDtlM) and
 *   D16_MIN_BOATS such positions of boats not over early for the median (an OCS boat's spot, over the line at the gun,
 *   is not where the fleet started); no card for a boat over early (D1 says that). Confidence: the wind's at the gun
 *   (line.ts windSource), as the card's and its cap.
 */
import { median, MS_TO_KN } from '../../geo';
import { biasAngle, lineBias, windSource } from '../../line';
import type { RaceAnalysis, StartResult } from '../../types';
import { NOISE_BASE_S, rangeOf, type Confidence, type GoodNote, type Opportunity } from '../opportunity';
import type { CoachCtx } from './context';
import { D1_PRE_MS } from './start';

/** The line this far off square or more, °. */
export const D16_MIN_DEG = 6;
/**
 * The card only when the ground given away on the fleet's median start is worth this much at the fleet's Beat-1 VMG, s
 * (the seconds the card would show): "materially further toward the unfavoured end" is this, not a share of the line.
 */
export const D16_MATERIAL_S = 10;
/** ➕: started in this share of the line nearest the favoured end (and at or toward it from the median). */
export const D16_GOOD_SHARE = 1 / 3;
/** The fleet's median start needs this many boats' positions at the gun. */
export const D16_MIN_BOATS = 5;
/** The card's window opens this long before the gun (the approach), ms. */
export const D16_PRE_MS = 60_000;
/** The range: ± this share of the seconds (the wind at the gun is good to a few degrees). */
export const D16_REL_ERR = 0.3;

export interface D16Result {
  opp: Opportunity | null;
  good: GoodNote | null;
}

const clampPct = (p: number): number => Math.min(100, Math.max(0, p));

/** Its position along the line at the gun was read (no hole, or estimated across one), and it was at the line. */
const placed = (st: StartResult | null | undefined): st is StartResult =>
  !!st && !st.awayFromLine && Number.isFinite(st.linePosPct) && !(st.dtlGapS != null && st.estDtlM == null);

/** The fleet's median start along the line, % (0 pin … 100 RC), or null under D16_MIN_BOATS placed boats not over early. */
export function medianStartPct(a: Pick<RaceAnalysis, 'boats'>): number | null {
  const pos = a.boats
    .map((b) => b.start)
    .filter(placed)
    .filter((st) => !st.over)
    .map((st) => clampPct(st.linePosPct));
  return pos.length >= D16_MIN_BOATS ? median(pos) : null;
}

/**
 * Against the fleet's median start, as the detector reads it, with `share` and `medianShare` the boat's and the median's
 * shares of the line from the favoured end, `byM` the favoured-by metres and `vmg` m/s: 'card' when the boat started
 * beyond the median toward the unfavoured end by D16_MATERIAL_S or more ((`share` − `medianShare`) × `byM` ÷ `vmg`),
 * 'good' in the favoured third (D16_GOOD_SHARE) at or toward the favoured end of the median, else null.
 */
export function biasCall(share: number, medianShare: number, byM: number, vmg: number): 'card' | 'good' | null {
  if (((share - medianShare) * byM) / vmg >= D16_MATERIAL_S) return 'card';
  return share <= D16_GOOD_SHARE && share <= medianShare ? 'good' : null;
}

export function detectLineBias(ctx: CoachCtx): D16Result {
  const none: D16Result = { opp: null, good: null };
  const st = ctx.me.start;
  const line = ctx.a.line;
  const vmg = ctx.m.vmg[0];
  if (!placed(st) || st.over || line.favored === 'square' || !vmg || !(vmg > 0)) return none;
  const deg = biasAngle(lineBias(line, ctx.a.wind.twdAtGunDeg));
  if (deg < D16_MIN_DEG) return none;
  const medianPct = medianStartPct(ctx.a);
  if (medianPct == null) return none;
  // Shares of the line from the favoured end: the boat's and the fleet median's.
  const fromFav = (pct: number): number => (line.favored === 'left' ? pct : 100 - pct) / 100;
  const share = fromFav(clampPct(st.linePosPct));
  const medianShare = fromFav(medianPct);
  const extra = share - medianShare;
  const byM = line.favoredByM;
  const facts = {
    favoured: line.favored === 'left' ? 'pin' : 'boat',
    deg,
    byM,
    linePosPct: st.linePosPct,
    medianPct,
    share,
    medianShare,
    // Along the line from the fleet's median start, m (+ toward the unfavoured end), and upwind, m (+ given away).
    alongM: extra * line.lengthM,
    givenM: extra * byM,
    vmg: vmg * MS_TO_KN,
  };
  const call = biasCall(share, medianShare, byM, vmg);
  if (call === 'card') {
    const w = windSource(ctx.a.wind).confidence;
    const cap: Confidence | null = w === 'high' ? null : w;
    const seconds = (extra * byM) / vmg;
    return {
      opp: {
        kind: 'D16',
        variant: 'unfavoured',
        t0: ctx.gun - D16_PRE_MS,
        t1: ctx.gun - D1_PRE_MS,
        seconds,
        ...rangeOf(seconds, NOISE_BASE_S + D16_REL_ERR * seconds),
        confidence: w,
        coverage: 1,
        conf: { boatCov: 1, ...(cap ? { refCap: cap } : {}) },
        facts,
        refBoats: [],
      },
      good: null,
    };
  }
  if (call === 'good') {
    const seconds = (-extra * byM) / vmg;
    return { opp: null, good: { kind: 'plus', detector: 'D16', variant: 'favoured', facts: { ...facts, gainS: seconds }, t0: ctx.gun - D16_PRE_MS, t1: ctx.gun - D1_PRE_MS, seconds } };
  }
  return none;
}
