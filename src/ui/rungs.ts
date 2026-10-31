/**
 * Ladder rungs on the track map's scrubber (Map B): on a beat or a run, a thin line square to the wind at the race
 * leader's rung, and one at the selected boat's, labelled with how far it is behind the leader up (or down) the
 * wind. Measured as analysis/coach/ladderNow.ts measures the ladder, which the map tooltip's places read too: the wind
 * at that moment (coach/liveWind.ts: the fleet's minute-by-minute series, the runs read from the gybes where the Coach
 * has them, smoothed over two minutes), the layline rung (ladder.ts rung), and the leader first by course progress
 * with estimated places skipped (as the tooltip skips them), so "Leader" is always the tooltip's first place.
 *
 * - A rung lies where its boat's rung puts it: `rung` along the wind from where its leg ends for it (the mark, or on
 *   the last leg the finish line extended to it, as ladderNow.ts endInto measures). The rung is measured from the
 *   bow (ladderNow.ts: the tracker plus the bow's distance ahead of it, along the way the hull points), so inside
 *   the laylines the line runs through the bow; past one, a
 *   little behind it, where its rung says it is. So before the last leg the leader's is never behind the selected
 *   boat's, and the two lines are the distance in the label apart, bow to bow; on the last leg, with the finish line
 *   not square to the wind, each still meets its own bow and the label still reads the rung difference.
 * - The map draws each hull from that same bow (ui/charts.ts dotsSvg; a hull stretched to its smallest size on
 *   screen reaches further aft, never forward), so the line meets the bow as drawn at any zoom. Where the map draws
 *   a boat from other fixes than the ladder reads (a full-rate track, a filled hole), toDrawnBows moves the line the
 *   difference along the wind, onto the bow on screen.
 * - The rungs turn with the wind as the replay runs; the wind is never missing (liveWind.ts falls back to the nearest
 *   reading), so a rung is never dropped for it.
 * - None before the gun, on a reach, once the boat has finished, or with no position for it then.
 * - Each line runs edge to edge across what is visible of the map (ui/mapExtent.ts: the view drawn, after pan, zoom
 *   or the follow camera, with the bands either side of it on a wide or tall screen and the card's padding), so it
 *   reads as a course-wide line at any zoom and ends on the card's edges.
 * - Labels lie along their own line, just off it (rotated with it, never upside down), slid along it clear of the
 *   boats and their labels, the marks and their labels, the wind arrow, the scale bar, the scale note ("Boats drawn
 *   about 3× actual size", while it is drawn) and the other rung's label.
 *
 * Nothing here allocates per frame once warm: the rungs, their axes, the draws and their labels are kept and filled
 * in place, the label text is only rebuilt when what it says changes, and paintRungs only sets what changed.
 */
import type { Vec } from '../analysis/geo';
import type { LadderNow } from '../analysis/coach/ladderNow';
import type { LegKind } from '../analysis/types';
import type { ClassDims } from '../data/classes';
import { textWidth } from './labels';
import type { Box } from './view';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The wind in map coordinates: `up` (unit) points into the wind, `across` (unit) along the rungs. */
export interface RungAxis {
  kind: Exclude<LegKind, 'reach'>;
  twdDeg: number;
  up: Vec;
  across: Vec;
}

/** Fill `out` with the axis of a leg of kind `kind` with wind `twdDeg`, on a map drawn with `mapTwdDeg` at the top (mapPieces.ts rotator); false on a reach or with no wind. */
export function axisInto(kind: LegKind, twdDeg: number, mapTwdDeg: number, out: RungAxis): boolean {
  if (kind === 'reach' || !Number.isFinite(twdDeg)) return false;
  const tw = (twdDeg * Math.PI) / 180;
  const th = (mapTwdDeg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const ux = Math.sin(tw);
  const uy = Math.cos(tw);
  out.kind = kind;
  out.twdDeg = twdDeg;
  out.up[0] = ux * c - uy * s;
  out.up[1] = -(ux * s + uy * c);
  out.across[0] = -out.up[1];
  out.across[1] = out.up[0];
  return true;
}

/** The axis as a new value (axisInto); null on a reach or with no wind. */
export function rungAxis(kind: LegKind, twdDeg: number, mapTwdDeg: number): RungAxis | null {
  const out: RungAxis = { kind: 'upwind', twdDeg, up: [0, 0], across: [0, 0] };
  return axisInto(kind, twdDeg, mapTwdDeg, out) ? out : null;
}

export interface Rung {
  role: 'leader' | 'sel';
  id: string;
  leg: number;
  /** Square to the wind at the moment (kept and filled in place). */
  axis: RungAxis;
  /** A point on the rung, map units (kept and filled in place). */
  at: [number, number];
  /** Its boat's bow as the ladder measures it (ladderNow.ts LadderRead bx, by), map units (kept and filled in place). */
  bow: [number, number];
  /** The boat's rung, m (ladderNow.ts LadderRead.rung). */
  rung: number;
  /** The selected boat's distance behind the leader along the wind, m (its rung less the leader's); null across legs or with no leader rung. */
  behindM: number | null;
}

/** What decides the rungs at one moment. */
export interface RungInput {
  /** The fleet up the ladder then, and the wind it was read on (`twdDeg`). */
  now: LadderNow;
  selected: string | null;
  /** The map's rotation (charts.ts: the gun's wind at the top). */
  mapTwdDeg: number;
}

const newRung = (role: Rung['role']): Rung => ({ role, id: '', leg: -1, axis: { kind: 'upwind', twdDeg: NaN, up: [0, 0], across: [0, 0] }, at: [0, 0], bow: [0, 0], rung: 0, behindM: null });
const rungSlots = { leader: newRung('leader'), sel: newRung('sel') };
const rungsOut: Rung[] = [];

/**
 * Fill `r` from read `i` of `o.now`: false (no rung) when it has finished, has no position, or is on a reach.
 * The point is where its leg ends for it (LadderRead ex, ey: the mark, or on the last leg the finish line extended to
 * it) less the rung along the wind then, in map units.
 */
function fillRung(o: RungInput, i: number, r: Rung): boolean {
  const { now } = o;
  const x = now.reads[i];
  if (!x || x.done || x.est || x.leg < 0 || !Number.isFinite(x.rung)) return false;
  if (!axisInto(now.course.kinds[x.leg], now.twdDeg, o.mapTwdDeg, r.axis)) return false;
  const tw = (now.twdDeg * Math.PI) / 180;
  const s = r.axis.kind === 'upwind' ? -x.rung : x.rung;
  const px = x.ex + s * Math.sin(tw);
  const py = x.ey + s * Math.cos(tw);
  const th = (o.mapTwdDeg * Math.PI) / 180;
  const c = Math.cos(th);
  const sn = Math.sin(th);
  r.id = x.id;
  r.leg = x.leg;
  r.at[0] = px * c - py * sn;
  r.at[1] = -(px * sn + py * c);
  r.bow[0] = x.bx * c - x.by * sn;
  r.bow[1] = -(x.bx * sn + x.by * c);
  r.rung = x.rung;
  r.behindM = null;
  return true;
}

/**
 * The rungs at a moment: the leader's, then the selected boat's (when it isn't the leader), each where its rung puts
 * it; the distance only when both are on the same leg. The array and the rungs are kept and refilled (read them
 * before the next call).
 */
export function rungsAt(o: RungInput): readonly Rung[] {
  rungsOut.length = 0;
  const { reads, leader } = o.now;
  const lead = leader >= 0 && fillRung(o, leader, rungSlots.leader) ? rungSlots.leader : null;
  if (lead) rungsOut.push(lead);
  if (o.selected == null || (leader >= 0 && reads[leader].id === o.selected)) return rungsOut;
  let si = -1;
  for (let i = 0; i < reads.length; i++) if (reads[i].id === o.selected) si = i;
  const sel = si >= 0 && fillRung(o, si, rungSlots.sel) ? rungSlots.sel : null;
  if (sel) {
    if (lead && lead.leg === sel.leg) sel.behindM = sel.rung - lead.rung;
    rungsOut.push(sel);
  }
  return rungsOut;
}

/**
 * Move each rung along the wind by however far the bow the map drew for its boat (`drawn`: its id → that bow, map
 * units, or null when not drawn) is from the bow the ladder measured, so the line meets the bow on screen. The two
 * are the same point but where the map draws a boat from other fixes (a full-rate track, a filled hole); the
 * distance in the label stays the measured one. In place.
 */
export function toDrawnBows(rungs: readonly Rung[], drawn: (id: string) => ArrayLike<number> | null): void {
  for (let i = 0; i < rungs.length; i++) {
    const r = rungs[i];
    const p = drawn(r.id);
    if (!p) continue;
    const up = r.axis.up;
    const d = (p[0] - r.bow[0]) * up[0] + (p[1] - r.bow[1]) * up[1];
    if (!Number.isFinite(d)) continue;
    r.at[0] += d * up[0];
    r.at[1] += d * up[1];
  }
}

/** Closer than this, m (or this share of a boat length), the selected boat reads as level with the leader. */
const LEVEL_M = 1;
const LEVEL_LENGTHS = 0.5;

/** "120 m behind", "6 lengths behind", "1 length ahead", "level"; in lengths when the class's length is known. */
export function ladderText(behindM: number, dims: Pick<ClassDims, 'loaM'> | null): string {
  const side = behindM >= 0 ? 'behind' : 'ahead';
  const m = Math.abs(behindM);
  if (dims && dims.loaM > 0) {
    const n = m / dims.loaM;
    if (n < LEVEL_LENGTHS) return 'level';
    const r = n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
    return `${r} ${r === 1 ? 'length' : 'lengths'} ${side}`;
  }
  if (m < LEVEL_M) return 'level';
  return `${Math.round(m).toLocaleString('en-US')} m ${side}`;
}

/** A rung's label: "Leader", or the selected boat's sail number and, when it compares, its distance ("USA 11 · 120 m behind"). */
export function rungLabel(r: Pick<Rung, 'role' | 'behindM'>, sail: string, dims: Pick<ClassDims, 'loaM'> | null): string {
  if (r.role === 'leader') return 'Leader';
  return r.behindM == null ? sail : `${sail} · ${ladderText(r.behindM, dims)}`;
}

// ---- what the labels keep clear of ------------------------------------------------

/** Boxes, map units, in typed arrays (grown, never shrunk): what a label keeps clear of. */
export class Rects {
  n = 0;
  private b = new Float64Array(4 * 64);
  clear(): void {
    this.n = 0;
  }
  add(x0: number, y0: number, x1: number, y1: number): void {
    if (4 * (this.n + 1) > this.b.length) {
      const g = new Float64Array(this.b.length * 2);
      g.set(this.b);
      this.b = g;
    }
    const i = 4 * this.n++;
    this.b[i] = x0;
    this.b[i + 1] = y0;
    this.b[i + 2] = x1;
    this.b[i + 3] = y1;
  }
  /** How many boxes overlap this one. */
  hits(x0: number, y0: number, x1: number, y1: number): number {
    let k = 0;
    const b = this.b;
    for (let i = 0; i < 4 * this.n; i += 4) if (x0 < b[i + 2] && b[i] < x1 && y0 < b[i + 3] && b[i + 1] < y1) k++;
    return k;
  }
}

/** Liang–Barsky: the part of p + s·d (s in [s0, s1]) inside `box`, as [s0, s1] into `out`; false when none, or for a zero direction. */
export function clipSpan(px: number, py: number, dx: number, dy: number, box: Box, s0: number, s1: number, out: { s0: number; s1: number }): boolean {
  if (!(Math.hypot(dx, dy) > 0)) return false;
  let lo = s0;
  let hi = s1;
  for (let k = 0; k < 4; k++) {
    const q = k === 0 ? -dx : k === 1 ? dx : k === 2 ? -dy : dy;
    const r = k === 0 ? px - box.x0 : k === 1 ? box.x1 - px : k === 2 ? py - box.y0 : box.y1 - py;
    if (q === 0) {
      if (r < 0) return false;
      continue;
    }
    const s = r / q;
    if (q < 0) lo = Math.max(lo, s);
    else hi = Math.min(hi, s);
  }
  if (!(lo <= hi) || !Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  out.s0 = lo;
  out.s1 = hi;
  return true;
}

// ---- drawing ------------------------------------------------------------------

/** A rung's label as drawn: its middle, map units, and its angle (°, within ±90: never upside down). */
export interface RungLabelDraw {
  x: number;
  y: number;
  deg: number;
  text: string;
  fs: number;
  sw: number;
  /** Its box (axis-aligned, around the rotated text), map units. */
  box: Box;
}

/** One rung as drawn, map units: its line across the view, and its label (null when there's no room for it). */
export interface RungDraw {
  role: Rung['role'];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  dash: string;
  label: RungLabelDraw | null;
}

/** Map scale (charts.ts mapScale): the view drawn, map units per screen unit and the stroke/font scale. */
export interface RungScale {
  box: Box;
  unit: number;
  k: number;
  /** What is visible of the map (ui/mapExtent.ts visibleExtent), around `box`; absent: `box`. */
  vis?: Box;
}

/** A label is kept this far inside what is visible, and this far off its line, screen units. */
const LABEL_INSET = 8;
const LABEL_GAP = 3;
/** Its font size and halo, screen units. */
const LABEL_FS = 10.5;
const LABEL_HALO = 3;

interface DrawSlot {
  d: RungDraw;
  lbl: RungLabelDraw;
  /** What the dash and the text were last built from. */
  dashK: number;
  textId: string;
  textKey: number;
}

const newDrawSlot = (role: Rung['role']): DrawSlot => ({
  d: { role, x1: 0, y1: 0, x2: 0, y2: 0, w: 0, dash: '', label: null },
  lbl: { x: 0, y: 0, deg: 0, text: '', fs: 0, sw: 0, box: { x0: 0, y0: 0, x1: 0, y1: 0 } },
  dashK: NaN,
  textId: '',
  textKey: NaN,
});
const drawSlots = { leader: newDrawSlot('leader'), sel: newDrawSlot('sel') };
const drawsOut: RungDraw[] = [];
const span = { s0: 0, s1: 0 };
const inner: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** What the labels say: the sail numbers and the class (lengths when its length is known). */
export interface RungText {
  sail: (id: string) => string;
  dims: Pick<ClassDims, 'loaM'> | null;
}

/** The label's text, rebuilt only when what it says changes (its boat, or its distance to a tenth of a metre). */
function labelText(s: DrawSlot, r: Rung, txt: RungText): string {
  const key = r.behindM == null ? NaN : Math.round(r.behindM * 10);
  if (s.textId === r.id && (key === s.textKey || (Number.isNaN(key) && Number.isNaN(s.textKey))) && s.lbl.text) return s.lbl.text;
  s.textId = r.id;
  s.textKey = key;
  return rungLabel(r, r.role === 'leader' ? '' : txt.sail(r.id), txt.dims);
}

/**
 * Place a `w` × `h` label along the line p + s·d (d unit, left to right), s in [s0, s1] (inside the view), just off
 * it on the side above it in its own frame: from `from` (the leader's near the right end, the selected boat's near
 * the left), slid along the line toward the other end until clear of `avoid`, then the same below the line; else
 * where it overlaps least. False when the line in view is too short for it.
 */
export function placeLabel(
  px: number,
  py: number,
  dx: number,
  dy: number,
  s0: number,
  s1: number,
  w: number,
  h: number,
  gap: number,
  from: 'start' | 'end',
  view: Box,
  avoid: Rects,
  out: RungLabelDraw,
): boolean {
  if (s1 - s0 < w) return false;
  // Above the text, in its own frame (the line left to right): up the screen for a level line.
  const nx = dy;
  const ny = -dx;
  const hx = (Math.abs(dx) * w) / 2 + (Math.abs(dy) * h) / 2;
  const hy = (Math.abs(dy) * w) / 2 + (Math.abs(dx) * h) / 2;
  const off = h / 2 + gap;
  const step = Math.max(w / 3, h);
  const a = s0 + w / 2;
  const b = s1 - w / 2;
  let best = Infinity;
  let bx = NaN;
  let by = NaN;
  for (let side = 1; side >= -1; side -= 2) {
    for (let k = 0; ; k++) {
      const s = from === 'end' ? b - k * step : a + k * step;
      if (s < a - 1e-9 || s > b + 1e-9) break;
      const cx = px + s * dx + side * off * nx;
      const cy = py + s * dy + side * off * ny;
      if (cx - hx < view.x0 || cx + hx > view.x1 || cy - hy < view.y0 || cy + hy > view.y1) continue;
      const n = avoid.hits(cx - hx, cy - hy, cx + hx, cy + hy);
      if (n === 0) {
        bx = cx;
        by = cy;
        best = 0;
        break;
      }
      if (n < best) {
        best = n;
        bx = cx;
        by = cy;
      }
    }
    if (best === 0) break;
  }
  if (!Number.isFinite(bx)) return false;
  out.x = bx;
  out.y = by;
  out.deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  out.box.x0 = bx - hx;
  out.box.y0 = by - hy;
  out.box.x1 = bx + hx;
  out.box.y1 = by + hy;
  return true;
}

/**
 * The rungs as drawn in view `sc.box`: each line edge to edge across what is visible (`sc.vis`, else the view); its
 * label along it (placeLabel) inside that, clear of `avoid` (the leader's label is added to it, so the selected boat's
 * keeps clear of it too). The array and the draws are kept and refilled.
 */
export function rungDraws(rungs: readonly Rung[], sc: RungScale, txt: RungText, avoid: Rects): readonly RungDraw[] {
  const { unit, k } = sc;
  const box = sc.vis ?? sc.box;
  drawsOut.length = 0;
  const inset = LABEL_INSET * unit;
  inner.x0 = box.x0 + inset;
  inner.y0 = box.y0 + inset;
  inner.x1 = box.x1 - inset;
  inner.y1 = box.y1 - inset;
  for (const r of rungs) {
    // Left to right on the map (straight up the screen when it is upright: read bottom to top).
    const flip = r.axis.across[0] < 0 || (r.axis.across[0] === 0 && r.axis.across[1] > 0) ? -1 : 1;
    const dx = flip * r.axis.across[0];
    const dy = flip * r.axis.across[1];
    const px = r.at[0];
    const py = r.at[1];
    if (!clipSpan(px, py, dx, dy, box, -Infinity, Infinity, span)) continue;
    const s = drawSlots[r.role];
    const d = s.d;
    d.x1 = px + span.s0 * dx;
    d.y1 = py + span.s0 * dy;
    d.x2 = px + span.s1 * dx;
    d.y2 = py + span.s1 * dy;
    d.w = Math.round(110 * k) / 100;
    if (r.role === 'leader' && s.dashK !== k) {
      s.dashK = k;
      d.dash = `${(5 * k).toFixed(2)} ${(3.5 * k).toFixed(2)}`;
    }
    const l = s.lbl;
    const text = labelText(s, r, txt);
    const fs = LABEL_FS * k;
    l.text = text;
    l.fs = Math.round(fs * 100) / 100;
    l.sw = Math.round(LABEL_HALO * k * 100) / 100;
    const placed =
      inner.x1 > inner.x0 &&
      inner.y1 > inner.y0 &&
      clipSpan(px, py, dx, dy, inner, -Infinity, Infinity, span) &&
      placeLabel(px, py, dx, dy, span.s0, span.s1, textWidth(text, fs), 1.2 * fs, LABEL_GAP * unit, r.role === 'leader' ? 'end' : 'start', inner, avoid, l);
    d.label = placed ? l : null;
    if (placed) avoid.add(l.box.x0, l.box.y0, l.box.x1, l.box.y1);
    drawsOut.push(d);
  }
  return drawsOut;
}

interface RungSlot {
  g: Element;
  line: Element;
  text: Element;
  /** What was last set, to a tenth of a map unit (NaN: not yet). */
  at: Float64Array;
  w: number;
  dash: string;
  lbl: Float64Array;
  labelShown: boolean;
  str: string;
  shown: boolean;
}

const layers = new WeakMap<Element, { leader?: RungSlot; sel?: RungSlot }>();

/** What paintRungs did to the DOM (tests: a steady frame creates nothing, sets nothing). */
export interface RungPaint {
  created: number;
  set: number;
}

const tenth = (v: number): number => Math.round(v * 10);
const f1 = (v: number): string => v.toFixed(1);
const done: RungPaint = { created: 0, set: 0 };

/**
 * Set `layer`'s rungs to `draws`, reusing one group (line and label) per role; a role not drawn is hidden, not removed.
 * Only what changed (to a tenth of a map unit) is set. The result is kept and refilled.
 */
export function paintRungs(layer: Element, draws: readonly RungDraw[]): RungPaint {
  let slots = layers.get(layer);
  if (!slots) layers.set(layer, (slots = {}));
  const doc = layer.ownerDocument;
  done.created = 0;
  done.set = 0;
  for (let ri = 0; ri < 2; ri++) {
    const role = ri === 0 ? 'leader' : 'sel';
    let d: RungDraw | null = null;
    for (let i = 0; i < draws.length; i++) if (draws[i].role === role) d = draws[i];
    let s = slots[role];
    if (!d) {
      if (s?.shown) {
        s.g.setAttribute('display', 'none');
        s.shown = false;
        done.set++;
      }
      continue;
    }
    if (!s) {
      const g = doc.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', `rung ${role}`);
      const line = doc.createElementNS(SVG_NS, 'line');
      const text = doc.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'rung-lbl');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dy', '0.35em');
      g.appendChild(line);
      g.appendChild(text);
      layer.appendChild(g);
      slots[role] = s = { g, line, text, at: new Float64Array(4).fill(NaN), w: NaN, dash: '', lbl: new Float64Array(5).fill(NaN), labelShown: true, str: '', shown: true };
      done.created++;
    }
    if (!s.shown) {
      s.g.removeAttribute('display');
      s.shown = true;
      done.set++;
    }
    const at = s.at;
    if (tenth(d.x1) !== at[0] || tenth(d.y1) !== at[1] || tenth(d.x2) !== at[2] || tenth(d.y2) !== at[3]) {
      at[0] = tenth(d.x1);
      at[1] = tenth(d.y1);
      at[2] = tenth(d.x2);
      at[3] = tenth(d.y2);
      s.line.setAttribute('x1', f1(d.x1));
      s.line.setAttribute('y1', f1(d.y1));
      s.line.setAttribute('x2', f1(d.x2));
      s.line.setAttribute('y2', f1(d.y2));
      done.set++;
    }
    if (d.w !== s.w) {
      s.w = d.w;
      s.line.setAttribute('stroke-width', String(d.w));
      done.set++;
    }
    if (d.dash !== s.dash) {
      s.dash = d.dash;
      if (d.dash) s.line.setAttribute('stroke-dasharray', d.dash);
      else s.line.removeAttribute('stroke-dasharray');
      done.set++;
    }
    const l = d.label;
    if (!l) {
      if (s.labelShown) {
        s.text.setAttribute('display', 'none');
        s.labelShown = false;
        done.set++;
      }
      continue;
    }
    if (!s.labelShown) {
      s.text.removeAttribute('display');
      s.labelShown = true;
      done.set++;
    }
    const lb = s.lbl;
    if (tenth(l.x) !== lb[0] || tenth(l.y) !== lb[1] || tenth(l.deg) !== lb[2]) {
      lb[0] = tenth(l.x);
      lb[1] = tenth(l.y);
      lb[2] = tenth(l.deg);
      s.text.setAttribute('x', f1(l.x));
      s.text.setAttribute('y', f1(l.y));
      s.text.setAttribute('transform', `rotate(${f1(l.deg)} ${f1(l.x)} ${f1(l.y)})`);
      done.set++;
    }
    if (l.fs !== lb[3] || l.sw !== lb[4]) {
      lb[3] = l.fs;
      lb[4] = l.sw;
      s.text.setAttribute('font-size', String(l.fs));
      s.text.setAttribute('stroke-width', String(l.sw));
      done.set++;
    }
    if (l.text !== s.str) {
      s.str = l.text;
      s.text.textContent = l.text;
      done.set++;
    }
  }
  return done;
}
