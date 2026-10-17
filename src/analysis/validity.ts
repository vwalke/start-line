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
export const OCS_BLIND_NOTE = 'Vakaros OCS check had no data for this boat';

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

/** Number clean starters 1..n by ranking value (closest to the line first). */
export function rankStarts(boats: BoatResult[]): void {
  const clean = boats.filter((b) => b.start && !b.start.over && b.start.rank).sort((x, y) => x.start!.rank!.m - y.start!.rank!.m);
  for (const b of boats) if (b.start) b.start.startPlace = null;
  clean.forEach((b, i) => (b.start!.startPlace = i + 1));
}

/** Every caveat on a boat's start figures, in display order. */
export function startNotes(s: StartResult): string[] {
  const out: string[] = [];
  if (s.rcNote) out.push(s.rcNote);
  if (s.dtlNote) out.push(s.dtlNote.startsWith('our ') ? s.dtlNote : `our check ${s.dtlNote}`);
  if (s.warn) out.push(s.warn);
  if (s.ocsBlind) out.push(OCS_BLIND_NOTE);
  return out;
}
