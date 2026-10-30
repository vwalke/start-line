/**
 * What of the track map is visible on screen, in map units: more than its viewBox. The SVG is drawn "meet" (the
 * viewBox scaled to fit, centred), so on a wide card at a capped height it sits between two empty bands, and in
 * full screen on a tall phone between two above and below; the SVG shows them (its viewport is the element, not the
 * viewBox). In the card the SVG fills its container (`#map-chart`), which spans the card's padding and clips
 * (style.css), so a line drawn to the visible extent ends on the card's edges and never paints past the SVG.
 *
 * The element's size is measured once per size (app.ts: on a new map or a resize, never per frame); the extent for
 * each view drawn (pan, zoom, the follow camera) is then plain arithmetic.
 */
import type { Box } from './view';

/** The map's SVG on screen, px. */
export interface MapScreen {
  w: number;
  h: number;
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
  // The empty bands either side of the viewBox (one pair is 0), px.
  const ox = (scr.w - vw * s) / 2;
  const oy = (scr.h - vh * s) / 2;
  out.x0 = vb.x0 - ox / s;
  out.x1 = vb.x1 + ox / s;
  out.y0 = vb.y0 - oy / s;
  out.y1 = vb.y1 + oy / s;
  return out;
}

/** The map's SVG on screen from its client rect (DOMRect); null with no size (a hidden tab). */
export function mapScreenOf(svg: { width: number; height: number }): MapScreen | null {
  return svg.width > 0 && svg.height > 0 ? { w: svg.width, h: svg.height } : null;
}
