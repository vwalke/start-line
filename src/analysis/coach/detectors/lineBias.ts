/**
 * D16 · Line bias: where along a biased start line the boat started. With the line D16_MIN_DEG or more off square to
 * the wind at the gun (line.ts lineBias: at 6° the favoured end is about a tenth of the line further upwind), the
 * boat's distance from the favoured end, as a share of the line (StartResult.linePosPct), times the favoured-by metres
 * is the ground it gave away; ÷ the fleet's VMG on the first leg is the seconds.
 *
 * - Fires when it gave away D16_CARD_SHARE or more of the bias (the unfavoured third); a start card, its window the
 *   approach (gun − D16_PRE_MS to gun − D1_PRE_MS: the D1 card's own window is the line crossing).
 * - ➕ Went well: in the favoured third (D16_GOOD_SHARE), the seconds against the line's middle.
 * - Needs the boat's position at the gun read (no hole, or estimated across one: StartResult.estDtlM); not for a boat
 *   over early (D1 says that). Confidence: the wind's at the gun (line.ts windSource).
 */
import { MS_TO_KN } from '../../geo';
import { biasAngle, lineBias, windSource } from '../../line';
import { NOISE_BASE_S, rangeOf, type Confidence, type GoodNote, type Opportunity } from '../opportunity';
import type { CoachCtx } from './context';
import { D1_PRE_MS } from './start';

/** The line this far off square or more, °. */
export const D16_MIN_DEG = 6;
/** The card: gave away this share of the bias or more (started in the third of the line at the unfavoured end)… */
export const D16_CARD_SHARE = 2 / 3;
/** …➕: started in this share of the line nearest the favoured end. */
export const D16_GOOD_SHARE = 1 / 3;
/** The card's window opens this long before the gun (the approach), ms. */
export const D16_PRE_MS = 60_000;
/** The range: ± this share of the seconds (the wind at the gun is good to a few degrees). */
export const D16_REL_ERR = 0.3;

export interface D16Result {
  opp: Opportunity | null;
  good: GoodNote | null;
}

export function detectLineBias(ctx: CoachCtx): D16Result {
  const none: D16Result = { opp: null, good: null };
  const st = ctx.me.start;
  const line = ctx.a.line;
  const vmg = ctx.m.vmg[0];
  if (!st || st.over || st.awayFromLine || !Number.isFinite(st.linePosPct) || line.favored === 'square' || !vmg || !(vmg > 0)) return none;
  // Its position at the gun: read, or estimated across a short hole.
  if (st.dtlGapS != null && st.estDtlM == null) return none;
  const deg = biasAngle(lineBias(line, ctx.a.wind.twdAtGunDeg));
  if (deg < D16_MIN_DEG) return none;
  const along = Math.min(1, Math.max(0, st.linePosPct / 100));
  const share = line.favored === 'left' ? along : 1 - along;
  const byM = line.favoredByM;
  const facts = {
    favoured: line.favored === 'left' ? 'pin' : 'boat',
    deg,
    byM,
    linePosPct: st.linePosPct,
    share,
    givenM: share * byM,
    vmg: vmg * MS_TO_KN,
  };
  const w = windSource(ctx.a.wind).confidence;
  const cap: Confidence | null = w === 'high' ? null : w;
  if (share >= D16_CARD_SHARE) {
    const seconds = (share * byM) / vmg;
    return {
      opp: {
        kind: 'D16',
        variant: 'unfavoured',
        t0: ctx.gun - D16_PRE_MS,
        t1: ctx.gun - D1_PRE_MS,
        seconds,
        ...rangeOf(seconds, NOISE_BASE_S + D16_REL_ERR * seconds),
        confidence: 'high',
        coverage: 1,
        conf: { boatCov: 1, ...(cap ? { refCap: cap } : {}) },
        facts,
        refBoats: [],
      },
      good: null,
    };
  }
  if (share <= D16_GOOD_SHARE) {
    const seconds = ((0.5 - share) * byM) / vmg;
    return { opp: null, good: { kind: 'plus', detector: 'D16', variant: 'favoured', facts: { ...facts, gainS: seconds }, t0: ctx.gun - D16_PRE_MS, t1: ctx.gun - D1_PRE_MS, seconds } };
  }
  return none;
}
