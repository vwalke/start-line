/**
 * The boat shape: the start chart's stylized hull (to scale, from the class's LOA and beam), shared with the
 * track map's boats while scrubbing and the Start tab's "Start Playback" view. Those two draw it centred on the
 * boat's position, pointing along its course over ground at that moment (or the last heading known while it is held
 * past its final fix, slow or has no course: boatMark), to scale or at least BOAT_SHAPE_PX long, filled while its data is
 * fresh and hollow once it is lost; the dot only with no heading ever known, no class dimensions, or so far zoomed
 * out a symbol would overstate the boat too much. Pure: outlines and SVG path data; the callers draw them.
 */
import { add, bearingVec, scale, type Vec } from '../analysis/geo';
import type { ClassDims } from '../data/classes';

/**
 * Stylized hull in hull coordinates: x across (±0.5 beam), y aft (bow 0,
 * transom 1). Pointed bow, fullest aft of midships, flat transom. Bow first.
 * Control points for a Catmull-Rom along each side; the transom stays straight.
 */
const HULL: Vec[] = [
  [0, 0],
  [0.12, 0.06],
  [0.24, 0.15],
  [0.36, 0.28],
  [0.45, 0.45],
  [0.5, 0.65],
  [0.49, 0.85],
  [0.46, 1],
  [-0.46, 1],
  [-0.49, 0.85],
  [-0.5, 0.65],
  [-0.45, 0.45],
  [-0.36, 0.28],
  [-0.24, 0.15],
  [-0.12, 0.06],
];

const fmt = (p: Vec): string => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;

/** Open Catmull-Rom as SVG cubics from pts[0] (already the current point) through pts[n-1]. */
function crCubics(pts: Vec[]): string {
  if (pts.length < 2) return '';
  let d = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += `C${fmt([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6])} ${fmt([
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
    ])} ${fmt(p2)}`;
  }
  return d;
}

/**
 * Smooth closed hull path: cubic spline along each side, straight transom.
 * `pts` is `hullOutline` order (bow, starboard, transom corners, port).
 */
export function hullPathD(pts: Vec[]): string {
  const t = pts.length >> 1;
  const stbd = pts.slice(0, t + 1);
  const port = [...pts.slice(t + 1), pts[0]];
  return `M${fmt(pts[0])}${crCubics(stbd)}L${fmt(pts[t + 1])}${crCubics(port)}Z`;
}

/** Hull outline in local metres (east/north): bow tip on `bow`, extending aft along `headingDeg`. */
export function hullOutline(bow: Vec, headingDeg: number, dims: ClassDims): Vec[] {
  const fwd = bearingVec(headingDeg);
  const stbd = bearingVec(headingDeg + 90);
  return HULL.map(([x, y]) => add(bow, add(scale(fwd, -y * dims.loaM), scale(stbd, x * dims.beamM))));
}

/**
 * The same hull in map coordinates (y down, as the SVG), centred on `at` and pointing along `dir` (a unit vector
 * in map coordinates): bow LOA/2 ahead of `at`, transom LOA/2 behind. Same order as `hullOutline`.
 */
export function hullOutlineAt(at: Vec, dir: Vec, dims: ClassDims): Vec[] {
  // Starboard is a quarter turn clockwise on screen (y down): up (0, −1) → right (1, 0).
  const stbd: Vec = [-dir[1], dir[0]];
  return HULL.map(([x, y]): Vec => {
    const aft = (y - 0.5) * dims.loaM;
    return [at[0] - dir[0] * aft + stbd[0] * x * dims.beamM, at[1] - dir[1] * aft + stbd[1] * x * dims.beamM];
  });
}

/** The shape's rotation on screen, degrees clockwise from up the page, [0, 360): for a map direction `dir` (y down). */
export function shapeRotationDeg(dir: Vec): number {
  const deg = (Math.atan2(dir[0], -dir[1]) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/**
 * A course over ground (degrees true) as a direction on a map rotated so the wind (from `twdDeg`) is at the top
 * (mapPieces.ts rotator), unit, y down; null when the course isn't a number.
 */
export function headingDir(cogDeg: number, twdDeg: number): Vec | null {
  if (!Number.isFinite(cogDeg)) return null;
  const a = ((cogDeg - (Number.isFinite(twdDeg) ? twdDeg : 0)) * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}

/**
 * The hull is drawn at least this long on screen, css px (the selected boat BOAT_SHAPE_ON_PX), so it reads as a
 * boat pointing somewhere: to scale once it is bigger, a fixed-size symbol below that (as the start chart's
 * markers are when its hulls would be too small).
 */
export const BOAT_SHAPE_PX = 12;
export const BOAT_SHAPE_ON_PX = 15;
/**
 * Zoomed out so far that the hull to scale would be shorter than this, css px, the symbol would overstate the boat
 * more than BOAT_SHAPE_PX / BOAT_SHAPE_MIN_PX = 8× and a close fleet would run together: the dot is drawn instead
 * (zoom in for shapes).
 */
export const BOAT_SHAPE_MIN_PX = 1.5;
/** Below this SOG, kn, the course over ground between fixes is mostly GPS noise: no heading, a dot. */
export const BOAT_SHAPE_MIN_KN = 1;

/** Why a boat is a dot rather than a shape: no course to point along, held past its final fix, too slow, no class dimensions, or too small on screen. */
export type DotWhy = 'no-heading' | 'hold' | 'slow' | 'no-class' | 'small';

export interface ShapeInput {
  /** Direction of travel in map coordinates (unit), null: unknown. */
  dir: Vec | null;
  /** Held at its final fix (its tracker stopped before it finished). */
  hold: boolean;
  /** SOG, kn (NaN: unknown, taken as moving when there's a direction). */
  sog: number;
  /** The class's hull dimensions (null: unknown class). */
  dims: ClassDims | null;
  /** Css px per metre where it is drawn. */
  pxPerM: number;
  /** The shortest it is drawn, css px (default BOAT_SHAPE_PX). */
  minPx?: number;
}

/**
 * Whether a boat is drawn as the hull (`shape`: its direction; `dims`: the size to draw it, metres: the class's, or
 * stretched to `minPx` on screen keeping its proportions) or the dot (`dot`: why not).
 */
export function boatShapeOr(o: ShapeInput): { shape: Vec; dims: ClassDims } | { dot: DotWhy } {
  if (o.hold) return { dot: 'hold' };
  if (!o.dir || !Number.isFinite(o.dir[0]) || !Number.isFinite(o.dir[1]) || (o.dir[0] === 0 && o.dir[1] === 0)) return { dot: 'no-heading' };
  if (Number.isFinite(o.sog) && o.sog < BOAT_SHAPE_MIN_KN) return { dot: 'slow' };
  if (!o.dims) return { dot: 'no-class' };
  if (!(o.dims.loaM * o.pxPerM >= BOAT_SHAPE_MIN_PX)) return { dot: 'small' };
  const f = Math.max(1, (o.minPx ?? BOAT_SHAPE_PX) / (o.dims.loaM * o.pxPerM));
  return { shape: o.dir, dims: f > 1 ? { loaM: o.dims.loaM * f, beamM: o.dims.beamM * f } : o.dims };
}

/** A boat held past its final fix (its tracker stopped before it finished) is drawn hollow once that fix is older than this, ms. */
export const BOAT_STALE_MS = 30_000;

/** Whether a boat at `t`, held (`hold`) at its final fix `lastFix`, is drawn hollow: that fix is more than BOAT_STALE_MS ago. */
export const boatStale = (hold: boolean, lastFix: number | undefined, t: number): boolean => hold && lastFix != null && t - lastFix > BOAT_STALE_MS;

export interface MarkInput extends ShapeInput {
  /** The last heading known before now (map coordinates, unit): drawn while held, slow or without a course; null: none ever. */
  lastDir?: Vec | null;
  /** Its data is lost (boatStale): hollow. */
  stale?: boolean;
}

/** A boat's mark: the hull along `shape` (sized `dims`) or the dot (`dot`: why), filled or `hollow` (its data lost). */
export type BoatMark = { shape: Vec; dims: ClassDims; hollow: boolean } | { dot: DotWhy; hollow: boolean };

const isDir = (d: Vec | null | undefined): d is Vec => !!d && Number.isFinite(d[0]) && Number.isFinite(d[1]) && (d[0] !== 0 || d[1] !== 0);

/**
 * The race map's and Start Playback's boat (one rule for both): the hull wherever a heading is known, along the
 * course now while moving with fresh data, else along the last heading known (held past its final fix, under
 * BOAT_SHAPE_MIN_KN, no course this step); the dot only when no heading was ever known, the class has no
 * dimensions, or the hull would be too small on screen (boatShapeOr's size rule). Either is hollow when `stale`.
 */
export function boatMark(o: MarkInput): BoatMark {
  const hollow = !!o.stale;
  const moving = !o.hold && isDir(o.dir) && !(Number.isFinite(o.sog) && o.sog < BOAT_SHAPE_MIN_KN);
  const heading = moving ? o.dir : isDir(o.lastDir) ? o.lastDir : null;
  if (!heading) return { dot: o.hold ? 'hold' : isDir(o.dir) ? 'slow' : 'no-heading', hollow };
  const s = boatShapeOr({ ...o, dir: heading, hold: false, sog: NaN });
  return 'shape' in s ? { ...s, hollow } : { dot: s.dot, hollow };
}

/** The hull's SVG path data in map coordinates, centred on `at`, pointing along `dir`. */
export const hullPathAt = (at: Vec, dir: Vec, dims: ClassDims): string => hullPathD(hullOutlineAt(at, dir, dims));

/** A sail-number label sits this far off its hull, css px, at any zoom. */
export const HULL_LABEL_GAP_PX = 3;

/** The sides a hull's label tries, in order: abeam on the side facing up the screen, abeam on the other, off the bow, off the stern. */
export type HullSide = 'abeam' | 'abeam-other' | 'bow' | 'stern';
export const HULL_LABEL_SIDES: readonly HullSide[] = ['abeam', 'abeam-other', 'bow', 'stern'];

/**
 * A `w` × `h` label box (map units) beside the hull centered on `at`, pointing along `dir`, drawn `dims` (meters =
 * map units): `gap` off the hull on `side`, its near edge or corner facing the hull. Abeam (perpendicular to the
 * heading, so clear of the boat's own track astern) is preferred; 'abeam' is the side facing up the screen (to
 * the right when exactly up or down). The box never overlaps the hull: it lies past the hull's extent along the
 * side's direction (a rectangle LOA × beam bounds the hull).
 */
export function hullLabelBox(at: Vec, dir: Vec, dims: ClassDims, w: number, h: number, gap: number, side: HullSide = 'abeam'): { x0: number; y0: number; x1: number; y1: number } {
  const stbd: Vec = [-dir[1], dir[0]];
  const up: Vec = stbd[1] < 0 || (stbd[1] === 0 && stbd[0] > 0) ? stbd : [-stbd[0], -stbd[1]];
  const n: Vec = side === 'abeam' ? up : side === 'abeam-other' ? [-up[0], -up[1]] : side === 'bow' ? dir : [-dir[0], -dir[1]];
  // The hull's reach along n (its LOA × beam rectangle's support), then the gap: the point P the label faces.
  const reach = Math.abs(n[0] * dir[0] + n[1] * dir[1]) * (dims.loaM / 2) + Math.abs(n[0] * stbd[0] + n[1] * stbd[1]) * (dims.beamM / 2);
  // The box's point facing the hull is on P: n mapped onto the box's edge (a side's middle when n is square to it,
  // a corner at 45°), pushed out along n by however far the box would still reach back past P.
  const m = Math.max(Math.abs(n[0]), Math.abs(n[1]));
  const t: Vec = [n[0] / m, n[1] / m];
  const back = (w / 2) * (Math.abs(n[0]) - n[0] * t[0]) + (h / 2) * (Math.abs(n[1]) - n[1] * t[1]);
  const d = reach + gap + back;
  const cx = at[0] + n[0] * d + (t[0] * w) / 2;
  const cy = at[1] + n[1] * d + (t[1] * h) / 2;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}
