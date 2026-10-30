/**
 * What of the track map is visible on screen, in map units: more than its viewBox. The SVG is drawn "meet" (the
 * viewBox scaled to fit, centred), so on a wide card at a capped height it sits between two empty bands, and in
 * full screen on a tall phone between two above and below; the SVG shows them (its viewport is the element, not the
 * viewBox). The map card's padding beside the SVG is opened to it too (style.css: `svg.chart.map` overflow, clipped
 * to the card by --map-bleed-l / --map-bleed-r), so a line drawn to the visible extent ends on the card's edges.
 *
 * The element's size is measured once per size (app.ts: on a new map or a resize, never per frame); the extent for
 * each view drawn (pan, zoom, the follow camera) is then plain arithmetic.
 */
import type { Box } from './view';

/** The map's SVG on screen, px: its size, and how far the visible area reaches past each side of it (≥ 0). */
export interface MapScreen {
  w: number;
  h: number;
  l: number;
  r: number;
  t: number;
  b: number;
}

/** The viewBox `vb` (map units) as drawn "meet" into `scr`: the visible extent, map units, into `out`; `vb` itself with no size on screen. */
export function visibleExtent(vb: Box, scr: MapScreen | null | undefined, out: Box): Box {
  const vw = vb.x1 - vb.x0;
  const vh = vb.y1 - vb.y0;
  const s = scr && scr.w > 0 && scr.h > 0 && vw > 0 && vh > 0 ? Math.min(scr.w / vw, scr.h / vh) : 0;
  if (!scr || !(s > 0)) {
    out.x0 = vb.x0;
    out.y0 = vb.y0;
    out.x1 = vb.x1;
    out.y1 = vb.y1;
    return out;
  }
  // The empty bands either side of the viewBox (one pair is 0), px, then the card's padding beyond.
  const ox = (scr.w - vw * s) / 2;
  const oy = (scr.h - vh * s) / 2;
  out.x0 = vb.x0 - (ox + scr.l) / s;
  out.x1 = vb.x1 + (ox + scr.r) / s;
  out.y0 = vb.y0 - (oy + scr.t) / s;
  out.y1 = vb.y1 + (oy + scr.b) / s;
  return out;
}

/** Rect-like, what measureMapScreen reads (DOMRect). */
interface Rectish {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * The map's SVG `svg` on screen, opened sideways to the inside of `frame` (the card's border; full screen, the body
 * it fills); not up or down, where the map's tools and the scrubber are. Null with no size (a hidden tab).
 */
export function mapScreenOf(svg: Rectish, frame: Rectish | null, frameBorder: { l: number; r: number } = { l: 0, r: 0 }): MapScreen | null {
  if (!(svg.width > 0 && svg.height > 0)) return null;
  const l = frame ? Math.max(0, svg.left - (frame.left + frameBorder.l)) : 0;
  const r = frame ? Math.max(0, frame.right - frameBorder.r - svg.right) : 0;
  return { w: svg.width, h: svg.height, l, r, t: 0, b: 0 };
}
