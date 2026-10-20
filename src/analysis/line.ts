/** Start line bias against the wind: which end is favoured, by how many degrees and metres, and how sure we are of the wind. */
import { wrap180 } from './geo';
import type { LineInfo, WindInfo } from './types';

/** Ends closer than this (m upwind of each other) count as a square line. */
export const SQUARE_LINE_M = 2;
/**
 * A boat this far *from the line* at the gun (absolute DTL) is away from the
 * start: at least this many metres, or this many times the fleet's 80th-
 * percentile |DTL|. One late boat kilometres out must not take "furthest back"
 * or stretch the Fit (Cascais official race 10). Line length is not used: a
 * long line still has boats within a hundred metres of it.
 */
export const AWAY_LINE_MIN_M = 300;
export const AWAY_LINE_FLEET_X = 4;

/** Fit / ranking threshold (m) of |DTL|: far boats stay listed, they just don't set the scale. */
export function awayFromLineThresholdM(fleetAbsDtlM: readonly number[]): number {
  if (!fleetAbsDtlM.length) return AWAY_LINE_MIN_M;
  const s = [...fleetAbsDtlM].sort((a, b) => a - b);
  const p80 = s[Math.min(s.length - 1, Math.round(0.8 * (s.length - 1)))];
  return Math.max(AWAY_LINE_MIN_M, p80 * AWAY_LINE_FLEET_X);
}

export interface LineBias {
  /** Signed angle of the line off square, degrees: + = pin (left) end favoured. */
  biasDeg: number;
  favored: LineInfo['favored'];
  /** How much further upwind the favoured end is, m. */
  byM: number;
}

const RAD = Math.PI / 180;

/**
 * Looking upwind with the pin on the left, a square line runs pin → RC on
 * TWD + 90. The bias is the pin → RC bearing's wrapped angle off that.
 */
export function lineBias(line: Pick<LineInfo, 'bearingDeg' | 'lengthM'>, twdDeg: number): LineBias {
  const biasDeg = wrap180(line.bearingDeg - (twdDeg + 90));
  const byM = line.lengthM * Math.abs(Math.sin(biasDeg * RAD));
  return { biasDeg, favored: byM < SQUARE_LINE_M ? 'square' : biasDeg > 0 ? 'left' : 'right', byM };
}

/** The bias as an angle a sailor reads: degrees the line is off square (0–90). */
export const biasAngle = (b: LineBias): number => Math.min(Math.abs(b.biasDeg), 180 - Math.abs(b.biasDeg));

/** Metres the favoured-by figure moves for a `deg` error in the wind (small-angle: length · sin deg). */
export const biasSensitivityM = (lengthM: number, deg = 5): number => lengthM * Math.abs(Math.sin(deg * RAD));

/** Tack-based wind with at least this many steady upwind headings (and the model, if any, within MODEL_AGREE_DEG) is high confidence. */
export const PLENTY_SAMPLES = 300;
export const MODEL_AGREE_DEG = 10;

export interface WindSource {
  method: WindInfo['method'];
  /** e.g. "wind estimated from the fleet's tacks". */
  text: string;
  /** Samples / tack angle / model cross-check, when there are any. */
  detail: string;
  confidence: 'high' | 'medium' | 'low';
}

/** Where the wind at the gun came from, and how far to trust it. */
export function windSource(w: WindInfo): WindSource {
  if (w.method === 'course') return { method: w.method, text: 'assumed: first leg dead upwind', detail: '', confidence: 'low' };
  if (w.method === 'model') return { method: w.method, text: 'weather-model wind', detail: w.model ? w.model.label : '', confidence: 'medium' };
  // makeTwdAt holds the earliest estimate until its time, so that one sets the wind at the gun.
  const est = [...w.estimates].sort((a, b) => a.tMs - b.tMs)[0];
  const off = w.model ? Math.abs(wrap180(w.model.dirAtGunDeg - w.twdAtGunDeg)) : null;
  const parts: string[] = [];
  if (est) parts.push(`${est.samples.toLocaleString('en')} steady upwind headings on leg ${est.legIndex + 1}, tack angle ${Math.round(est.tackAngleDeg)}°`);
  if (off != null) parts.push(`weather model ${Math.round(off)}° off`);
  const high = !!est && est.samples >= PLENTY_SAMPLES && (off == null || off <= MODEL_AGREE_DEG);
  return { method: w.method, text: "wind estimated from the fleet's tacks", detail: parts.join('; '), confidence: high ? 'high' : 'medium' };
}
