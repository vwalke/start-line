/**
 * D1 · Start position (spec §3), gun − 10 s → the boat's line crossing.
 * DTL at the gun (StartResult), the bow's crossing time and the crossing
 * order (CoachModel.crossMs), the favoured end (LineInfo). The front row is the
 * FRONT_ROW_N earliest crossings not over early, counting those up to
 * FRONT_EARLY_MS before the gun; its median is never earlier than the gun.
 * Fires when the boat crossed D1_LATE_S or more after that median, or was
 * D1_BACK_LOA boatlengths or more back at the gun, or crossed in the last
 * quarter of the fleet (D1_TAIL_SHARE) D1_TAIL_LATE_S or more after it.
 * Seconds = its crossing − that median. A boat over early at the gun
 * (StartResult.over) always fires, the 'ocs' variant: its crossing is the
 * one that cleared it (startCrossings → startCross.ts); it is never front row
 * and never ✓. A D3 right after it merges into the same card (debrief.ts mergeStart).
 */
import { median } from '../../geo';
import { coachCoverage, rangeOf, untrackedS, NOISE_BASE_S, NOISE_HOLE_SHARE, type GoodNote, type Opportunity } from '../opportunity';
import { startDtlM } from '../../validity';
import type { CoachCtx } from './context';

export const D1_LATE_S = 6;
export const D1_BACK_LOA = 2;
/** Crossed in the last quarter of the fleet and at least this late: fires too, s. */
export const D1_TAIL_LATE_S = 4;
export const D1_TAIL_SHARE = 0.25;
export const FRONT_ROW_N = 5;
/** Clean crossings this close before the gun (not flagged over early) count for the front row, ms. */
export const FRONT_EARLY_MS = 3_000;
/** ✓ start: in the first third over the line, at most OK_LATE_S after the front row, at most OK_BACK_LOA back at the gun. */
export const OK_RANK_SHARE = 1 / 3;
export const OK_LATE_S = 3;
export const OK_BACK_LOA = 1;
/** The window opens this long before the gun, ms. */
export const D1_PRE_MS = 10_000;
/** ✓ start needs this much of the window tracked. */
export const OK_MIN_COVERAGE = 0.5;

export interface StartOrder {
  /** Every crossing found, earliest first (an OCS boat at its clearing crossing). */
  order: { id: string; tMs: number }[];
  /** The front row: the FRONT_ROW_N earliest clean crossings (from FRONT_EARLY_MS before the gun, not over). */
  front: { id: string; tMs: number }[];
  /** Their median crossing, never before the gun. */
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
  const front = order.filter((c) => c.tMs >= ctx.gun - FRONT_EARLY_MS && !over.has(c.id)).slice(0, FRONT_ROW_N);
  if (front.length < 3) return null;
  return { order, front, frontMedMs: Math.max(ctx.gun, median(front.map((c) => c.tMs))) };
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
  // The device's own distance where ours is across a hole (validity.ts startDtlM).
  const dtl = startDtlM(st);
  const back = dtl >= D1_BACK_LOA * ctx.loaM;
  const t0 = ctx.gun - D1_PRE_MS;
  const line = ctx.a.line;
  const favoured = line.favored === 'square' ? null : line.favored === 'left' ? 'pin' : 'boat';
  if (so && crossMs != null) {
    const lateS = (crossMs - so.frontMedMs) / 1000;
    const rank = so.order.findIndex((c) => c.id === ctx.boat) + 1;
    const t1 = Math.max(crossMs, ctx.gun + 1000);
    // The tracks start at the gun; at least D1_PRE_MS of them, or a boat crossing at the gun is judged on one second.
    const cov = coachCoverage(ctx.tr.t, ctx.gun, Math.max(t1, ctx.gun + D1_PRE_MS));
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
    const tail = rank > (1 - D1_TAIL_SHARE) * so.order.length && lateS >= D1_TAIL_LATE_S;
    // Over at the gun: crossMs is when it cleared (startCrossings), and that is the start, however soon.
    if (st.over || lateS >= D1_LATE_S || back || tail) {
      const seconds = Math.max(0, lateS);
      const noise = NOISE_BASE_S + NOISE_HOLE_SHARE * untrackedS(ctx.tr.t, ctx.gun, t1);
      return {
        opp: {
          kind: 'D1',
          variant: st.over ? 'ocs' : back ? 'second-row' : 'late',
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
    // ✓ only for a genuine front-row start: early over the line, on time and close to it at the gun.
    // A boat over early at the gun is not one: the front row itself leaves those out.
    const frontRow = !st.over && rank <= Math.ceil(OK_RANK_SHARE * so.order.length) && lateS <= OK_LATE_S && dtl <= OK_BACK_LOA * ctx.loaM;
    // Under OK_MIN_COVERAGE the ✓ is debrief.ts's thin note ("Not judged: the start"), never "front row".
    const ok: GoodNote | null = frontRow ? { kind: 'ok', detector: 'D1', variant: 'front-row', facts, t0, t1, coverage: cov, ...(cov < OK_MIN_COVERAGE ? { thin: true } : {}) } : null;
    return { opp: null, ok, crossMs, fired: false };
  }
  // No crossing (no raw fixes, or it crossed inside a hole): DTL alone, with Recall's seconds late. Not for a
  // boat over at the gun: without its clearing crossing there is nothing to time.
  if (!st.over && back && st.lateS != null && st.lateS > 0) {
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
