/**
 * How the track map shows a new view (ui/app.ts): a full redraw (`render`, the map's innerHTML) or only the SVG's
 * viewBox moved (`move`, with the scale bar and wind arrow shifted along). Line widths, font sizes and label offsets
 * follow the zoom level only (charts.ts mapScale), so a pan at the zoom drawn needs no redraw: the follow camera's
 * pans during play move the viewBox, and drawScrub moves the boats. A gesture (drag, wheel, pinch, a preset) redraws
 * on the next frame, or for a slow redraw (a big fleet) moves the viewBox and redraws once it rests.
 */
import type { View } from './view';

/** A redraw slower than this (a big fleet) moves only the viewBox during a gesture… */
export const MAP_SLOW_MS = 30;
/** …and redraws once the view has rested this long (also after follow pans while paused). */
export const MAP_SETTLE_MS = 150;

export interface MapPaintHost {
  /** The full redraw; it calls `rendered` with the view it drew. */
  render: () => void;
  /** Move the drawn SVG's viewBox to the view now; `drawn`: the view last drawn (its zoom the same: shift the scale bar and wind arrow by the pan). */
  move: (drawn: View | null) => void;
  /** The last full redraw's cost, ms. */
  drawMs: () => number;
  /** The view now. */
  view: () => View;
  raf?: (f: () => void) => number;
  setTimer?: (f: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export interface MapPaint {
  /** A full redraw drew view `v`. */
  rendered: (v: View) => void;
  /** A gesture or preset set the view: redraw on the next frame (slow: move the viewBox, redraw once it rests). */
  gesture: () => void;
  /** The follow camera panned (the zoom unchanged): move the viewBox now; while paused, redraw once it rests. */
  follow: (playing: boolean) => void;
  /** Play stopped: redraw if follow pans moved the viewBox since the last redraw (so the map is exact at rest). */
  settle: () => void;
}

export function mapPaint(host: MapPaintHost): MapPaint {
  const raf = host.raf ?? ((f: () => void) => requestAnimationFrame(f));
  const setTimer = host.setTimer ?? ((f: () => void, ms: number) => window.setTimeout(f, ms));
  const clearTimer = host.clearTimer ?? ((id: number) => clearTimeout(id));
  let drawn: View | null = null;
  let frame = 0;
  let rest = 0;
  /** Follow pans have moved the viewBox since the last redraw. */
  let stale = false;
  const wait = (): void => {
    clearTimer(rest);
    rest = setTimer(() => {
      rest = 0;
      host.render();
    }, MAP_SETTLE_MS);
  };
  const gesture = (): void => {
    if (frame) return;
    frame = raf(() => {
      frame = 0;
      if (host.drawMs() <= MAP_SLOW_MS) return host.render();
      host.move(drawn && drawn.k === host.view().k ? drawn : null);
      wait();
    });
  };
  return {
    rendered: (v) => {
      drawn = v;
      stale = false;
      clearTimer(rest);
      rest = 0;
    },
    gesture,
    follow: (playing) => {
      // A redraw already queued draws this view.
      if (frame) return;
      if (!drawn || drawn.k !== host.view().k) {
        // Zoomed since the last redraw (a slow gesture waiting to rest): keep its wait, else redraw as a gesture.
        if (!rest) return gesture();
        return host.move(null);
      }
      host.move(drawn);
      stale = true;
      if (!playing) wait();
    },
    settle: () => {
      if (stale && !frame) host.render();
    },
  };
}
