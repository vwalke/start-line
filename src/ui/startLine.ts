/** The start line's favoured end on the chart and in the caption: dashed extensions, the bias label, the wind it rests on. */
import type { Vec } from '../analysis/geo';
import { biasAngle, biasSensitivityM, lineBias, windSource } from '../analysis/line';
import type { RaceAnalysis } from '../analysis/types';
import type { ClassDims } from '../data/classes';
import { degLabel, esc, f0, f1 } from './format';
import { textWidth, type Rect } from './labels';

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
  return favouredTexts(a, dims)[0];
}

/**
 * The label's wordings, longest first, for when the extension is short:
 * "Pin favoured 7° · 18 m (1.9 lengths)", "Pin favoured 7° · 18 m", "Pin fav. 7° · 18 m", "Pin 7°".
 */
export function favouredTexts(a: RaceAnalysis, dims: ClassDims | null): string[] {
  const b = lineBias(a.line, a.wind.twdAtGunDeg);
  if (b.favored === 'square') return ['Square line', 'Square'];
  const end = b.favored === 'left' ? 'Pin' : 'RC';
  const deg = `${f0(biasAngle(b))}°`;
  const m = `${f0(b.byM)} m`;
  const short = `${end} favoured ${deg} · ${m}`;
  return [...(dims ? [`${short} (${f1(b.byM / dims.loaM)} lengths)`] : []), short, `${end} fav. ${deg} · ${m}`, `${end} ${deg}`];
}

/** Where a label running along a line goes: anchor point, rotation, text-anchor, room along the line. */
export interface AlongLabel {
  x: number;
  y: number;
  /** Degrees, in (−90, 90]: the text is never upside down. */
  rotate: number;
  anchor: 'start' | 'end' | 'middle';
  /** Length available for the text along the line, chart units. */
  room: number;
  /** Unit vector of the text's "up" (screen-up after the upright flip). */
  up: Vec;
  /** Unit vector from `p0` to `p1`. */
  along: Vec;
}

/**
 * A label along the segment `p0` → `p1` (y down, as SVG): starting `gap` past
 * `p0` and running toward `p1` (or centred on the segment with `centre`), its
 * baseline `offset` off the line on the text's upper side. Rotation is kept in
 * (−90°, 90°]: when the segment runs leftward the text turns 180° and anchors
 * at its end instead, so it still reads outward from `p0` and upright.
 */
export function alongLineLabel(p0: Vec, p1: Vec, opts: { gap: number; offset: number; centre?: boolean }): AlongLabel {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  const along: Vec = [dx / len, dy / len];
  const theta = (Math.atan2(along[1], along[0]) * 180) / Math.PI;
  const flip = !(theta > -90 && theta <= 90);
  const rotate = flip ? (theta <= -90 ? theta + 180 : theta - 180) : theta;
  const r = (rotate * Math.PI) / 180;
  const up: Vec = [Math.sin(r), -Math.cos(r)];
  const s: Vec = opts.centre ? [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2] : [p0[0] + along[0] * opts.gap, p0[1] + along[1] * opts.gap];
  return {
    x: s[0] + up[0] * opts.offset,
    y: s[1] + up[1] * opts.offset,
    rotate,
    anchor: opts.centre ? 'middle' : flip ? 'end' : 'start',
    room: opts.centre ? len : Math.max(0, len - opts.gap),
    up,
    along,
  };
}

/** The axis-aligned box of an along-line label `w` wide at font size `fs` (for keeping boat names clear). */
export function alongLabelBox(l: AlongLabel, w: number, fs: number): Rect {
  const [x0, x1] = l.anchor === 'start' ? [0, w] : l.anchor === 'end' ? [-w, 0] : [-w / 2, w / 2];
  const r = (l.rotate * Math.PI) / 180;
  const ux: Vec = [Math.cos(r), Math.sin(r)];
  const corners = [x0, x1].flatMap((px) =>
    [-0.85 * fs, 0.25 * fs].map((py): Vec => [l.x + ux[0] * px - l.up[0] * py, l.y + ux[1] * px - l.up[1] * py]),
  );
  return {
    x0: Math.min(...corners.map((c) => c[0])),
    y0: Math.min(...corners.map((c) => c[1])),
    x1: Math.max(...corners.map((c) => c[0])),
    y1: Math.max(...corners.map((c) => c[1])),
  };
}

/** Clearance from a line-end mark (pin circle / RC square and its name) to the label, in css px (× unit). */
export const FAV_GAP_PX = 18;
/** The label's baseline sits this far off the line, css px (× unit). */
export const FAV_OFFSET_PX = 4;

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
 * units; `unit` ≈ 1 css px in this view, `fs` the label's font size (both
 * scale with the view, as the boat names do, so the label reads the same at
 * every zoom). The label runs along the favoured end's extension, FAV_GAP_PX
 * past the end mark and just above the line (screen-up after the upright flip,
 * which with the wind at the top is the course side, away from the boats); a
 * square line's label sits centred on the line. The longest wording that fits
 * is used: the extension stops at the chart frame, so when it is too short for
 * even "Pin favoured 7° · 18 m" (a long line at Fit) the label runs along the
 * line inward from that end instead, the same gap past the mark. Returns the
 * SVG and the label's box so boat names keep clear of it.
 */
export function lineBiasSvg(a: RaceAnalysis, L: Vec, R: Vec, frame: Rect, unit: number, fs: number, dims: ClassDims | null): { ext: string; label: string; box: Rect } {
  const exts = lineExtensions(L, R, frame);
  const ext = exts
    .map(([p, q], i) => `<line class="line-ext" data-end="${i ? 'rc' : 'pin'}" x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" stroke-width="${unit.toFixed(2)}" stroke-dasharray="${(5 * unit).toFixed(2)} ${(4 * unit).toFixed(2)}"/>`)
    .join('');
  const b = lineBias(a.line, a.wind.twdAtGunDeg);
  const texts = favouredTexts(a, dims);
  const fits = (t: string, room: number): boolean => textWidth(t, fs) <= room;
  const opts = { gap: FAV_GAP_PX * unit, offset: FAV_OFFSET_PX * unit };
  let at: AlongLabel;
  let text: string;
  if (b.favored === 'square') {
    // Centred on the line, clear of both end marks.
    at = alongLineLabel(L, R, { ...opts, centre: true });
    text = texts.find((t) => fits(t, at.room - 2 * opts.gap)) ?? texts[texts.length - 1];
  } else {
    const end = b.favored === 'left' ? L : R;
    const ext = exts[b.favored === 'left' ? 0 : 1];
    const onExt = ext ? alongLineLabel(ext[0], ext[1], opts) : null;
    // On the extension when at least "Pin favoured 7° · 18 m" fits there (zoomed in, or a short line);
    // otherwise along the line itself, inward from the favoured end, rather than cut to "Pin 7°".
    const extText = onExt ? texts.slice(0, -2).find((t) => fits(t, onExt.room)) : undefined;
    if (onExt && extText) {
      at = onExt;
      text = extText;
    } else {
      at = alongLineLabel(end, end === L ? R : L, opts);
      text = texts.find((t) => fits(t, at.room - opts.gap)) ?? texts[texts.length - 1];
    }
  }
  const r = (v: number): string => v.toFixed(1);
  const label = `<text class="fav-lbl" x="${r(at.x)}" y="${r(at.y)}" transform="rotate(${at.rotate.toFixed(1)} ${r(at.x)} ${r(at.y)})" font-size="${fs.toFixed(2)}" stroke-width="${(2.5 * unit).toFixed(2)}" text-anchor="${at.anchor}"><title>${esc(biasBasis(a))}</title>${esc(text)}</text>`;
  return { ext, label, box: alongLabelBox(at, textWidth(text, fs), fs) };
}
