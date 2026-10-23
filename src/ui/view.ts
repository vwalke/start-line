/**
 * Pan/zoom view over a chart's fit box, as pure math (no DOM). Coordinates
 * are the chart's own (rotated metres for the start chart); `k` is zoom
 * relative to the fit box (1 = Fit). Views keep the fit box's aspect.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface View {
  cx: number;
  cy: number;
  k: number;
}

/** What `getBoundingClientRect()` returns, as far as we need it. */
export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const K_MIN = 1;
export const K_MAX = 16;
const EPS = 1e-6;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function fitView(box: Box): View {
  return { cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, k: 1 };
}

/** The visible rectangle (SVG viewBox numbers) for `v`. */
export function viewBox(box: Box, v: View): { x0: number; y0: number; w: number; h: number } {
  const w = (box.x1 - box.x0) / v.k;
  const h = (box.y1 - box.y0) / v.k;
  return { x0: v.cx - w / 2, y0: v.cy - h / 2, w, h };
}

/** Clamp zoom to [kMin, kMax], then the centre so the view stays inside the box. */
export function clampView(box: Box, v: View, kMin = K_MIN, kMax = K_MAX): View {
  const k = clamp(v.k, kMin, kMax);
  const fit = fitView(box);
  if (k <= 1) return { ...fit, k };
  const hw = (box.x1 - box.x0) / k / 2;
  const hh = (box.y1 - box.y0) / k / 2;
  return { cx: clamp(v.cx, box.x0 + hw, box.x1 - hw), cy: clamp(v.cy, box.y0 + hh, box.y1 - hh), k };
}

/**
 * Zoom by `factor` keeping chart point (px, py) fixed on screen. The factor is
 * clamped so k stays in [kMin, kMax]; the anchor uses the clamped factor.
 * Centre clamping is left to `clampView`.
 */
export function zoomAbout(v: View, factor: number, px: number, py: number, kMin = K_MIN, kMax = K_MAX): View {
  const k = clamp(v.k * factor, kMin, kMax);
  const r = k / v.k;
  return { cx: px + (v.cx - px) / r, cy: py + (v.cy - py) / r, k };
}

/** Move the centre by (dx, dy) chart units. */
export function pan(v: View, dx: number, dy: number): View {
  return { cx: v.cx + dx, cy: v.cy + dy, k: v.k };
}

/** Client px → chart units, for an element showing `v` with preserveAspectRatio xMidYMid meet. */
export function clientToChart(box: Box, v: View, rect: ClientRect, clientX: number, clientY: number): [number, number] {
  const vb = viewBox(box, v);
  const s = Math.min(rect.width / vb.w, rect.height / vb.h) || 1;
  const ox = rect.left + (rect.width - vb.w * s) / 2;
  const oy = rect.top + (rect.height - vb.h * s) / 2;
  return [vb.x0 + (clientX - ox) / s, vb.y0 + (clientY - oy) / s];
}

/**
 * `v` (a view on `from`) carried onto another fit box `to` (into full screen and back):
 * Fit stays Fit; a zoom keeps its level and centre, clamped into `to`.
 */
export function carryView(from: Box | null, v: View, to: Box): View {
  return !from || presetActive(from, v, 1) ? fitView(to) : clampView(to, v);
}

/** Whether a preset button (1 = Fit, else a zoom level) matches `v` exactly. */
export function presetActive(box: Box, v: View, preset: number): boolean {
  if (preset === 1) {
    const f = fitView(box);
    return Math.abs(v.k - 1) < EPS && Math.abs(v.cx - f.cx) < EPS && Math.abs(v.cy - f.cy) < EPS;
  }
  return Math.abs(v.k - preset) < EPS;
}

type Pt = readonly [number, number];

/**
 * What the zoom presets and + / − centre on: the selected boat's position at the moment shown, else the middle
 * of the fleet's positions then (their bounding box's centre, whether or not it fits at the zoom asked for),
 * else null (nothing placed: the caller falls back to the map's centre).
 */
export function zoomTarget(me: Pt | null | undefined, fleet: readonly Pt[]): [number, number] | null {
  if (me && Number.isFinite(me[0]) && Number.isFinite(me[1])) return [me[0], me[1]];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of fleet) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return x0 <= x1 ? [(x0 + x1) / 2, (y0 + y1) / 2] : null;
}

/** zoomTarget over a list of boats: `me` (an id) among them, `at` a boat's position (null: not placed now). */
export function boatsZoomTarget<T extends { id: string }>(boats: readonly T[], me: string | null, at: (b: T) => Pt | null): [number, number] | null {
  const placed: Pt[] = [];
  let mine: Pt | null = null;
  for (const b of boats) {
    const p = at(b);
    if (!p) continue;
    placed.push(p);
    if (me != null && b.id === me) mine = p;
  }
  return zoomTarget(mine, placed);
}

/** Zoom `k` centred on `target` (null: the box's centre), clamped into the box; k ≤ 1 is Fit. */
export function zoomPreset(box: Box, k: number, target: Pt | null): View {
  if (k <= 1) return fitView(box);
  const [cx, cy] = target ?? [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
  return clampView(box, { cx, cy, k });
}

/**
 * A wheel step's zoom factor: a trackpad pinch (Ctrl + wheel, as browsers send it) by exp(−Δ/100), as fine as
 * the fingers; a mouse wheel by 2^(−Δ/500), about 1.15× a notch (100 px). Lines and pages are made px first;
 * one step is at most 2× either way.
 */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  if (!Number.isFinite(px)) return 1;
  const f = pinch ? Math.exp(-px * 0.01) : 2 ** (-px / 500);
  return clamp(f, 0.5, 2);
}
