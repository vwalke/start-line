/**
 * D1 · Start position (spec §3), gun − 10 s → the boat's line crossing.
 * DTL at the gun (StartResult), the bow's crossing time and the crossing
 * order (CoachModel.crossMs), the favoured end (LineInfo). Fires when the boat
 * crossed more than D1_LATE_S after the front row (the median of the
 * FRONT_ROW_N earliest clean crossings), or was more than D1_BACK_LOA
 * boatlengths back at the gun. Seconds = its crossing − that median.
 */
import { median } from '../../geo';
import { coachCoverage, rangeOf, untrackedS, NOISE_BASE_S, NOISE_HOLE_SHARE, type GoodNote, type Opportunity } from '../opportunity';
import type { CoachCtx } from './context';

export const D1_LATE_S = 15;
export const D1_BACK_LOA = 3;
export const FRONT_ROW_N = 5;
/** The window opens this long before the gun, ms. */
export const D1_PRE_MS = 10_000;
/** ✓ start needs this much of the window tracked. */
export const OK_MIN_COVERAGE = 0.5;

export interface StartOrder {
  /** Every crossing found, earliest first (early starters included). */
  order: { id: string; tMs: number }[];
  /** The front row: the FRONT_ROW_N earliest clean crossings (at or after the gun, not over). */
  front: { id: string; tMs: number }[];
  frontMedMs: number;
}

/** The crossing order and front row; null without crossings or with too few clean ones. */
export function startOrder(ctx: CoachCtx): StartOrder | null {
  const x = ctx.m.crossMs;
  if (!x) return null;
  const over = new Set(ctx.a.boats.filter((b) => b.start?.over).map((b) => b.id));
  const order = Object.entries(x)
    .filter((e): e is [string, number] => e[1] != null)
    .map(([id, tMs]) => ({ id, tMs }))
    .sort((p, q) => p.tMs - q.tMs);
  const front = order.filter((c) => c.tMs >= ctx.gun && !over.has(c.id)).slice(0, FRONT_ROW_N);
  if (front.length < 3) return null;
  return { order, front, frontMedMs: median(front.map((c) => c.tMs)) };
}

export interface StartResultD1 {
  opp: Opportunity | null;
  ok: GoodNote | null;
  /** The boat's crossing time (else null), and whether D1 fired (D3 starts where D1 ends). */
  crossMs: number | null;
  fired: boolean;
}

export function detectStart(ctx: CoachCtx): StartResultD1 {
  const st = ctx.me.start;
  const so = startOrder(ctx);
  const crossMs = ctx.m.crossMs?.[ctx.boat] ?? null;
  const none: StartResultD1 = { opp: null, ok: null, crossMs, fired: false };
  if (!st) return none;
  const dtl = st.dtlM;
  const back = dtl > D1_BACK_LOA * ctx.loaM;
  const t0 = ctx.gun - D1_PRE_MS;
  const line = ctx.a.line;
  const favoured = line.favored === 'square' ? null : line.favored === 'left' ? 'pin' : 'boat';
  if (so && crossMs != null) {
    const lateS = (crossMs - so.frontMedMs) / 1000;
    const rank = so.order.findIndex((c) => c.id === ctx.boat) + 1;
    const t1 = Math.max(crossMs, ctx.gun + 1000);
    const cov = coachCoverage(ctx.tr.t, ctx.gun, t1);
    const facts = {
      dtl,
      crossS: (crossMs - ctx.gun) / 1000,
      crossRank: rank,
      n: so.order.length,
      frontLo: (so.front[0].tMs - ctx.gun) / 1000,
      frontHi: (so.frontMedMs - ctx.gun) / 1000,
      favoured,
      favouredByM: line.favoredByM,
      linePosPct: st.linePosPct,
    };
    if (lateS > D1_LATE_S || back) {
      const seconds = Math.max(0, lateS);
      const noise = NOISE_BASE_S + NOISE_HOLE_SHARE * untrackedS(ctx.tr.t, ctx.gun, t1);
      return {
        opp: {
          kind: 'D1',
          variant: back ? 'second-row' : 'late',
          t0,
          t1,
          seconds,
          ...rangeOf(seconds, noise),
          confidence: 'high',
          coverage: cov,
          conf: { boatCov: cov, refs: { good: so.front.length, fair: so.front.length, need: 3 } },
          facts,
          refBoats: so.front.map((c) => c.id),
        },
        ok: null,
        crossMs,
        fired: true,
      };
    }
    const ok: GoodNote | null = cov >= OK_MIN_COVERAGE ? { kind: 'ok', detector: 'D1', variant: 'front-row', facts, t0, t1 } : null;
    return { opp: null, ok, crossMs, fired: false };
  }
  // No crossing (no raw fixes, or it crossed inside a hole): DTL alone, with Recall's seconds late.
  if (back && st.lateS != null && st.lateS > 0) {
    // lateS is set only when the DTL at the gun is read between close fixes: the window counts as covered.
    const cov = 1;
    return {
      opp: {
        kind: 'D1',
        variant: 'second-row',
        t0,
        t1: ctx.gun + st.lateS * 1000,
        seconds: st.lateS,
        ...rangeOf(st.lateS, NOISE_BASE_S),
        confidence: 'high',
        coverage: cov,
        conf: { boatCov: cov },
        facts: { dtl, crossS: null, crossRank: null, n: null, frontLo: null, frontHi: null, favoured, favouredByM: line.favoredByM, linePosPct: st.linePosPct },
        refBoats: [],
      },
      ok: null,
      crossMs,
      fired: true,
    };
  }
  return none;
}
