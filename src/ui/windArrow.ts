/**
 * The track map's wind arrow (charts.ts windArrow, in `g.map-hud`) turned to the wind of the moment as the replay
 * runs: the wind the ladder rungs lie square to (coach/ladderNow.ts twdDeg, coach/liveWind.ts), so the arrow stays
 * square to the rungs through a shift. The map stays drawn with the gun's wind at the top; only the arrow's line and
 * head turn (about their middle), by the wind's difference from the gun's, clockwise for a veer. The label stays
 * upright and sits clear of the arrow at any angle (charts.ts WIND_LABEL_GAP).
 *
 * - Only a turn of MIN_TURN_DEG or more is drawn: the wind is already smoothed, and this keeps a steady arrow from
 *   being set every frame for a hundredth of a degree.
 * - Its label says where the wind is from, to the degree ("wind 272° (est.)"), set only when that changes. It has no
 *   native tooltip: nothing on the map does.
 * - Nothing allocates once warm: the arrow is found once per map, its elements once per arrow, and only what changed
 *   is set.
 */
import { norm360, wrap180 } from '../analysis/geo';

/** The arrow turns only by this much or more, °. */
export const MIN_TURN_DEG = 0.5;

/** Where the wind is from, to the whole degree (0–359). */
export const windFromDeg = (twdDeg: number): number => Math.round(norm360(twdDeg)) % 360;

/** The arrow's label for wind `twdDeg`: "wind 272° (est.)", or "wind (est.)" with no wind known. */
export const windLabel = (twdDeg: number): string => (Number.isFinite(twdDeg) ? `wind ${windFromDeg(twdDeg)}° (est.)` : 'wind (est.)');

/** The widest label (charts.ts keeps the ladder rungs' labels clear of it). */
export const WIND_LABEL_WIDEST = 'wind 000° (est.)';

/** How far the arrow turns for wind `twdDeg` on a map drawn with `mapTwdDeg` at the top, ° clockwise (within ±180; 0 with either missing). */
export function arrowTurnDeg(twdDeg: number, mapTwdDeg: number): number {
  const d = wrap180(twdDeg - mapTwdDeg);
  return Number.isFinite(d) ? d : 0;
}

const arrows = new WeakMap<Element, Element | null>();

/** The map `svg`'s wind arrow (`g.map-hud g.wind`), looked up once per map (a full redraw is a new SVG). */
export function windArrowOf(svg: Element): Element | null {
  let g = arrows.get(svg);
  if (g === undefined) arrows.set(svg, (g = svg.querySelector('g.map-hud g.wind')));
  return g;
}

interface ArrowSlot {
  dir: Element | null;
  label: Element | null;
  cx: string;
  cy: string;
  /** The turn drawn, °, and the degrees in the label. */
  deg: number;
  from: number;
}

const slots = new WeakMap<Element, ArrowSlot>();

/** What paintWindArrow set (tests: a steady arrow sets nothing). Kept and refilled. */
export interface ArrowPaint {
  set: number;
  deg: number;
}
const done: ArrowPaint = { set: 0, deg: 0 };

/**
 * Turn arrow `g` (the map's `g.wind`, drawn for `mapTwdDeg`) to wind `twdDeg`: its `g.wind-dir` rotated about its
 * middle (data-cx, data-cy) once the turn moves MIN_TURN_DEG or more from the one drawn, its label when the whole
 * degrees change. A new arrow (a full redraw) starts from the gun's wind it was drawn with.
 */
export function paintWindArrow(g: Element, twdDeg: number, mapTwdDeg: number): ArrowPaint {
  let s = slots.get(g);
  if (!s) {
    const dir = g.querySelector('.wind-dir');
    s = {
      dir,
      label: g.querySelector('text'),
      cx: dir?.getAttribute('data-cx') ?? '0',
      cy: dir?.getAttribute('data-cy') ?? '0',
      deg: 0,
      from: Number.isFinite(mapTwdDeg) ? windFromDeg(mapTwdDeg) : NaN,
    };
    slots.set(g, s);
  }
  done.set = 0;
  const deg = arrowTurnDeg(twdDeg, mapTwdDeg);
  if (s.dir && Math.abs(deg - s.deg) >= MIN_TURN_DEG) {
    s.deg = deg;
    s.dir.setAttribute('transform', `rotate(${deg.toFixed(1)} ${s.cx} ${s.cy})`);
    done.set++;
  }
  if (s.label && Number.isFinite(twdDeg)) {
    const from = windFromDeg(twdDeg);
    if (from !== s.from) {
      s.from = from;
      s.label.textContent = windLabel(twdDeg);
      done.set++;
    }
  }
  done.deg = s.deg;
  return done;
}
