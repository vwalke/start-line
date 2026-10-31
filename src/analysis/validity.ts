/**
 * Validity of the start figures: gaps in the telemetry behind our check, and
 * the one ranking value per boat. A boat is over early only when race control
 * called it (assessStart). Pure functions so they're unit-testable.
 */
import { codeInfo } from '../data/official/codes';
import type { BoatResult, StartResult } from './types';

/** Our check is "gap-interpolated" when the nearest track point is further than this from the sample. */
export const GAP_MS = 2000;
/** Also interpolated when the bracketing hole is longer than this, even if a neighbour is within GAP_MS. */
export const SPAN_MS = 5000;

/**
 * Null when the sample sits on a real point, or a neighbour is within GAP_MS
 * *and* the bracketing hole is no longer than SPAN_MS. Otherwise the gap (s)
 * the value is interpolated (or extrapolated) across.
 */
export function sampleGap(t: ArrayLike<number>, ts: number): { gapS: number; note: string } | null {
  const n = t.length;
  if (!n) return null;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0 || lo === n) {
    const edge = lo === 0 ? t[0] : t[n - 1];
    const d = Math.abs(edge - ts);
    if (d <= GAP_MS) return null;
    const s = Math.round(d / 1000);
    return { gapS: d / 1000, note: lo === 0 ? `our track starts ${s} s after the start fix` : `our track ends ${s} s before the start fix` };
  }
  const prev = t[lo - 1];
  const next = t[lo];
  // An exact hit is a real fix, not an interpolation, even if the next hole is long.
  if (ts === prev || ts === next) return null;
  const nearest = Math.min(ts - prev, next - ts);
  const span = next - prev;
  if (nearest <= GAP_MS && span <= SPAN_MS) return null;
  const gapS = span / 1000;
  return { gapS, note: `interpolated across a ${Math.round(gapS)} s data gap` };
}

/**
 * The seconds late the start figures show: the ranked figure, else (our DTL interpolated across a hole) our
 * interpolated one, shown like any other (display only: lateS, what the analysis reads, stays null there).
 */
export const shownLateS = (s: Pick<StartResult, 'lateS' | 'secsLate' | 'dtlGapS'>): number | null => s.lateS ?? (s.dtlGapS != null ? s.secsLate : null);

/**
 * The boat's distance behind the line at the start for the start figures: the Vakaros device's own when ours is
 * interpolated across a hole and the device reported one; else ours.
 */
export const startDtlM = (s: Pick<StartResult, 'dtlM' | 'dtlGapS' | 'rcDtlM'>): number => (s.dtlGapS != null && s.rcDtlM != null ? s.rcDtlM : s.dtlM);

/** An unranked start (our DTL across a hole) is still placed at the gun, estimated, by dead reckoning from a fix this close to the sample… */
export const START_EST_NEAR_MS = 10_000;
/** …or, without one, by our interpolated DTL when fixes this close bracket the sample on both sides. Further out: unknown. */
export const START_EST_SIDE_MS = 30_000;

/**
 * Our DTL at sample `ts` estimated across a hole (StartResult.estDtlM): from the nearest fix within START_EST_NEAR_MS,
 * its DTL carried on at its speed toward the line (`dtlAt(i)`, `vToLine(i)` m/s); else the interpolated `dtlM` when
 * fixes within START_EST_SIDE_MS bracket the sample; else null.
 */
export function estimateDtl(t: ArrayLike<number>, ts: number, dtlM: number, dtlAt: (i: number) => number, vToLine: (i: number) => number): number | null {
  const n = t.length;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  const before = lo > 0 ? ts - t[lo - 1] : Infinity;
  const after = lo < n ? t[lo] - ts : Infinity;
  const i = before <= after ? lo - 1 : lo;
  if (Math.min(before, after) <= START_EST_NEAR_MS) return dtlAt(i) - (vToLine(i) * (ts - t[i])) / 1000;
  return before <= START_EST_SIDE_MS && after <= START_EST_SIDE_MS ? dtlM : null;
}

/** Vakaros when valid, else ours when not gap-interpolated, else unranked. */
export function rankingValue(rcM: number | null, oursM: number | null, oursGap: boolean): StartResult['rank'] {
  if (rcM != null) return { m: rcM, source: 'vakaros' };
  if (oursM != null && !oursGap) return { m: oursM, source: 'ours' };
  return null;
}

type Assessed = Pick<StartResult, 'lateS' | 'rank' | 'over'>;

/** Race control called the start: the RaceSense OCS flag, or an official scored start code (OCS / UFD / BFD). */
export const calledOver = (ocs: boolean, code: string | null | undefined): boolean => ocs || (!!code && !!codeInfo(code).start);

/**
 * The derived validity fields of one start (call after `secsLate` is final). `over` is race control's call only
 * (calledOver; `code` is the boat's official scoring code): no distance figure makes a boat over early.
 */
export function assessStart(s: Pick<StartResult, 'rcDtlM' | 'dtlM' | 'dtlGapS' | 'secsLate' | 'ocs'>, code?: string | null): Assessed {
  const gap = s.dtlGapS != null;
  return {
    lateS: gap ? null : s.secsLate,
    rank: rankingValue(s.rcDtlM, s.dtlM, gap),
    over: calledOver(s.ocs, code),
  };
}

/** Number clean starters 1..n by ranking value (closest to the line first). Boats called over or away from the line are unplaced. */
export function rankStarts(boats: BoatResult[]): void {
  const clean = boats.filter((b) => b.start && !b.start.over && !b.start.awayFromLine && b.start.rank).sort((x, y) => x.start!.rank!.m - y.start!.rank!.m);
  for (const b of boats) if (b.start) b.start.startPlace = null;
  clean.forEach((b, i) => (b.start!.startPlace = i + 1));
  // estPlace: the ranked boats in their order, with the gap-interpolated ones placed between them by their estimated DTL.
  const key = (s: StartResult): number | null => s.rank?.m ?? s.estDtlM ?? null;
  const line = boats.filter((b) => b.start && !b.start.over && !b.start.awayFromLine && key(b.start) != null).sort((x, y) => key(x.start!)! - key(y.start!)!);
  for (const b of boats) if (b.start) b.start.estPlace = null;
  line.forEach((b, i) => (b.start!.estPlace = i + 1));
}

/** Every caveat on a boat's start figures, in display order (our check across a hole is shown plainly: no caveat). */
export function startNotes(s: StartResult): string[] {
  const out: string[] = [];
  if (s.rcNote) out.push(s.rcNote);
  return out;
}
