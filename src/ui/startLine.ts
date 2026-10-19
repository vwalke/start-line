/** The start line's favoured end on the chart and in the caption: dashed extensions, the bias label, the wind it rests on. */
import type { Vec } from '../analysis/geo';
import { biasAngle, biasSensitivityM, lineBias, windSource } from '../analysis/line';
import type { RaceAnalysis } from '../analysis/types';
import type { ClassDims } from '../data/classes';
import { degLabel, esc, f0, f1 } from './format';
import type { Rect } from './labels';

/** Extensions reach this many line lengths past each end, or to the frame if that's nearer. */
export const LINE_EXT = 0.6;

/** Distance from `p` along unit `u` to the edge of `b` (0 if `p` is outside). */
function toEdge(p: Vec, u: Vec, b: Rect): number {
  let t = Infinity;
  if (u[0] > 0) t = Math.min(t, (b.x1 - p[0]) / u[0]);
  if (u[0] < 0) t = Math.min(t, (b.x0 - p[0]) / u[0]);
  if (u[1] > 0) t = Math.min(t, (b.y1 - p[1]) / u[1]);
  if (u[1] < 0) t = Math.min(t, (b.y0 - p[1]) / u[1]);
  return Math.max(0, t);
}

/** The line continued past the pin (`L`) and the RC (`R`) end: [pin side, RC side], each [end, tip]. */
export function lineExtensions(L: Vec, R: Vec, frame: Rect, frac = LINE_EXT): [Vec, Vec][] {
  const len = Math.hypot(R[0] - L[0], R[1] - L[1]);
  if (!(len > 0)) return [];
  const u: Vec = [(R[0] - L[0]) / len, (R[1] - L[1]) / len];
  const out = (p: Vec, d: Vec): [Vec, Vec] => {
    const t = Math.min(frac * len, toEdge(p, d, frame));
    return [p, [p[0] + d[0] * t, p[1] + d[1] * t]];
  };
  return [out(L, [-u[0], -u[1]]), out(R, u)];
}

/** The chart label at the favoured end: "Pin favoured 7° · 18 m (1.9 lengths)", or "Square line". */
export function favouredText(a: RaceAnalysis, dims: ClassDims | null): string {
  const b = lineBias(a.line, a.wind.twdAtGunDeg);
  if (b.favored === 'square') return 'Square line';
  const lengths = dims ? ` (${f1(b.byM / dims.loaM)} lengths)` : '';
  return `${b.favored === 'left' ? 'Pin' : 'RC'} favoured ${f0(biasAngle(b))}° · ${f0(b.byM)} m${lengths}`;
}

/** The wind the bias rests on, its confidence and the bias's sensitivity to it (the label's title; the caption's detail). */
export function biasBasis(a: RaceAnalysis): string {
  const src = windSource(a.wind);
  return `Wind ${degLabel(a.wind.twdAtGunDeg)} at the gun, ${src.text}${src.detail ? ` (${src.detail})` : ''}; ${src.confidence} confidence. ±5° of wind ≈ ±${f0(biasSensitivityM(a.line.lengthM))} m.`;
}

/** The caption's line clause: "pin end favoured by 7° ≈ 18 m (wind estimated from the fleet's tacks, high confidence; ±5° of wind ≈ ±9 m)". */
export function biasCaption(a: RaceAnalysis): string {
  const b = lineBias(a.line, a.wind.twdAtGunDeg);
  const src = windSource(a.wind);
  const basis = `${src.text}, ${src.confidence} confidence; ±5° of wind ≈ ±${f0(biasSensitivityM(a.line.lengthM))} m`;
  return b.favored === 'square'
    ? `about square to the wind (${basis})`
    : `${b.favored === 'left' ? 'pin' : 'RC'} end favoured by ${f0(biasAngle(b))}° ≈ ${f0(b.byM)} m (${basis})`;
}

/**
 * Dashed extensions (under the boats) and the favoured-end label, in chart
 * units; `unit` ≈ 1 css px, `fs` the label's font size. Returns the SVG and
 * the label's box so boat names keep clear of it.
 */
export function lineBiasSvg(a: RaceAnalysis, L: Vec, R: Vec, frame: Rect, unit: number, fs: number, dims: ClassDims | null): { ext: string; label: string; box: Rect } {
  const ext = lineExtensions(L, R, frame)
    .map(([p, q], i) => `<line class="line-ext" data-end="${i ? 'rc' : 'pin'}" x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" stroke-width="${unit.toFixed(2)}" stroke-dasharray="${(5 * unit).toFixed(2)} ${(4 * unit).toFixed(2)}"/>`)
    .join('');
  const b = lineBias(a.line, a.wind.twdAtGunDeg);
  const text = favouredText(a, dims);
  // Above the favoured end (or the middle of a square line), running in toward the line so it stays in frame.
  const at: Vec = b.favored === 'left' ? L : b.favored === 'right' ? R : [(L[0] + R[0]) / 2, (L[1] + R[1]) / 2];
  const other = b.favored === 'right' ? L : R;
  const anchor = b.favored === 'square' ? 'middle' : at[0] <= other[0] ? 'start' : 'end';
  const x = anchor === 'middle' ? at[0] : at[0] + (anchor === 'start' ? -4 : 4) * unit;
  const y = Math.min(at[1], other[1]) - 24 * unit;
  const w = text.length * 0.56 * fs;
  const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
  const label = `<text class="fav-lbl" x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs.toFixed(2)}" stroke-width="${(3 * unit).toFixed(2)}" text-anchor="${anchor}"><title>${esc(biasBasis(a))}</title>${text}</text>`;
  return { ext, label, box: { x0, y0: y - fs, x1: x0 + w, y1: y + 0.3 * fs } };
}
