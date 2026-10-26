/**
 * Validity of the start figures: gaps in the telemetry behind our check,
 * Vakaros-vs-ours disagreement, boats race control's OCS check couldn't see,
 * and the one ranking value per boat. Pure functions so they're unit-testable.
 */
import type { RcStatus } from '../data/types';
import type { BoatResult, StartResult } from './types';

/** Our check is "gap-interpolated" when the nearest track point is further than this from the sample. */
export const GAP_MS = 2000;
/** Also interpolated when the bracketing hole is longer than this, even if a neighbour is within GAP_MS. */
export const SPAN_MS = 5000;
/** Vakaros and ours "disagree" beyond this, m. */
export const DISAGREE_M = 3;
/** Our figure is "near the line" below this, m. */
export const NEAR_LINE_M = 1;
export const OCS_BLIND_NOTE = 'Vakaros had no OCS check for this boat';

const r1 = (x: number): string => x.toFixed(1);

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
 * Our figure is across a hole in the boat's own fixes around the start sample longer than this, s, with no Vakaros
 * distance to use instead (gapAtGun): the findings then hedge an over-the-line call (nothing on screen says why).
 */
export const GUN_GAP_FLAG_S = 10;

/** Our start figure rests on a hole over GUN_GAP_FLAG_S, and there is no device figure to use instead. */
export const gapAtGun = (s: Pick<StartResult, 'dtlGapS' | 'rcDtlM'>): boolean => s.dtlGapS != null && s.dtlGapS > GUN_GAP_FLAG_S && s.rcDtlM == null;

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

/** Explanation when both figures are valid and more than DISAGREE_M apart. */
export function disagreement(rcM: number | null, oursM: number | null): string | null {
  if (rcM == null || oursM == null) return null;
  const d = Math.abs(rcM - oursM);
  if (d <= DISAGREE_M) return null;
  return `Vakaros ${r1(rcM)} m vs ours ${r1(oursM)} m (${r1(d)} m apart) — one of them is off (feed, GPS or bow offset).`;
}

/** Vakaros had no usable fix, and our figure (valid or gap-interpolated) is near or over the line. */
export const isOcsBlind = (rcStatus: RcStatus, oursM: number | null): boolean =>
  (rcStatus === 'stale' || rcStatus === 'missing') && oursM != null && oursM < NEAR_LINE_M;

/** Vakaros when valid, else ours when not gap-interpolated, else unranked. */
export function rankingValue(rcM: number | null, oursM: number | null, oursGap: boolean): StartResult['rank'] {
  if (rcM != null) return { m: rcM, source: 'vakaros' };
  if (oursM != null && !oursGap) return { m: oursM, source: 'ours' };
  return null;
}

type Assessed = Pick<StartResult, 'lateS' | 'rank' | 'over' | 'warn' | 'ocsBlind'>;

/** The derived validity fields of one start (call after `secsLate` is final). */
export function assessStart(s: Pick<StartResult, 'rcDtlM' | 'rcStatus' | 'dtlM' | 'dtlGapS' | 'secsLate' | 'ocs'>): Assessed {
  const gap = s.dtlGapS != null;
  const rank = rankingValue(s.rcDtlM, s.dtlM, gap);
  return {
    lateS: gap ? null : s.secsLate,
    rank,
    over: s.ocs || (rank != null && rank.m < 0),
    warn: gap ? null : disagreement(s.rcDtlM, s.dtlM),
    ocsBlind: isOcsBlind(s.rcStatus, s.dtlM),
  };
}

/** Number clean starters 1..n by ranking value (closest to the line first). Boats away from the line are unplaced. */
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
  if (s.warn) out.push(s.warn);
  if (s.ocsBlind) out.push(OCS_BLIND_NOTE);
  return out;
}
