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
