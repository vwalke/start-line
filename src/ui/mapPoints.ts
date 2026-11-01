/**
 * The track map's point details: course over ground from neighbouring drawn
 * points, heel, and the lookup the hover/tap tooltip reads (every drawn point of
 * the legs shown, in map coordinates). The tracks are drawn with every hole filled
 * in (ui/gapFill.ts), and a point there reads like any other.
 */
import { vecBearing } from '../analysis/geo';
import { PRE_LEG, type RaceAnalysis } from '../analysis/types';
import { boatLabel, degLabel, duration, esc, f1, localTime } from './format';
import { filledRanges, type BoatAt, type MapPiece, type SrcTrack } from './mapPieces';
import { nearestSample, sogIndex, type IndexedTrack, type SogIndex } from './sog';

/** Fixes this close (m) give no course over ground. */
const COG_MIN_M = 0.5;

/**
 * Course over ground at point `i`, degrees true, from its neighbouring points
 * (x east, y north, metres): across i−1 → i+1, or one side at an end. NaN with
 * no neighbour or no movement.
 */
export function cogAt(x: ArrayLike<number>, y: ArrayLike<number>, i: number): number {
  const n = Math.min(x.length, y.length);
  if (i < 0 || i >= n) return NaN;
  const lo = i > 0 ? i - 1 : i;
  const hi = i + 1 < n ? i + 1 : i;
  const dx = x[hi] - x[lo];
  const dy = y[hi] - y[lo];
  if (lo === hi || !(Math.hypot(dx, dy) >= COG_MIN_M)) return NaN;
  return vecBearing([dx, dy]);
}

/** "12° heel to port" (roll − = to port), "0° heel"; null with no reading. */
export function heelLabel(roll: number | undefined): string | null {
  if (roll == null || !Number.isFinite(roll)) return null;
  const deg = Math.round(Math.abs(roll));
  return deg ? `${deg}° heel to ${roll < 0 ? 'port' : 'starboard'}` : '0° heel';
}

// ---- lookup -----------------------------------------------------------------

/** Every drawn point (the hover index) shown, with the piece of track each came from; and the scrubber's dots. */
export interface MapPoints {
  ix: SogIndex;
  /** Per piece: its source track (east/north metres, as analysed), … */
  segs: SrcTrack[];
  /** …the index there of the piece's first point, … */
  offs: Int32Array;
  /** …its leg (PRE_LEG before the gun), … */
  legs: number[];
  /** …and the index of its first point in `ix`. */
  starts: Int32Array;
  /** The boats at the scrubber's time (none in the full-race view). */
  dots: BoatAt[];
}

/** A piece of track for the lookup: [i0, i1) of `src`, whose map coordinates are `rx`, `ry`. */
export type PointPiece = Omit<MapPiece, 'rx' | 'ry' | 'end'> & { rx: Float64Array | Float32Array; ry: Float64Array | Float32Array };

/** Build the lookup for leg `leg` (or all) of the whole race, as drawn (holes filled in: mapPieces.ts filledRanges); `xy` gives a track's points in map coordinates. */
export function mapPoints(
  a: Pick<RaceAnalysis, 'drawings'>,
  leg: number | null,
  xy: (seg: SrcTrack) => { x: Float64Array | Float32Array; y: Float64Array | Float32Array },
): MapPoints {
  const pieces: PointPiece[] = [];
  for (const d of a.drawings) {
    for (const r of filledRanges(d, false)) {
      if (leg != null && r.leg !== leg) continue;
      const { x, y } = xy(r.src);
      pieces.push({ id: d.id, leg: r.leg, src: r.src, rx: x, ry: y, i0: r.lo, i1: Math.min(r.hi, x.length, y.length, r.src.sog.length) });
    }
  }
  return mapPointsOf(pieces);
}

/** The lookup over `pieces` (each boat's consecutive), and the scrubber's dots. */
export function mapPointsOf(pieces: readonly PointPiece[], dots: BoatAt[] = []): MapPoints {
  const tracks: IndexedTrack[] = [];
  const segs: SrcTrack[] = [];
  const offs: number[] = [];
  const legs: number[] = [];
  const starts: number[] = [];
  let n = 0;
  let span = 0;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const pc of pieces) {
    const { src, i0, i1 } = pc;
    const x = pc.rx.subarray(i0, i1);
    const y = pc.ry.subarray(i0, i1);
    const t = src.t.subarray(i0, i1);
    const sog = src.sog.subarray(i0, i1);
    const m = Math.min(x.length, y.length, t.length, sog.length);
    tracks.push({ id: pc.id, x, y, t, sog, leg: pc.leg });
    segs.push(src);
    offs.push(i0);
    legs.push(pc.leg);
    starts.push(n);
    n += m;
    for (let i = 0; i < m; i++) [x0, y0, x1, y1] = [Math.min(x0, x[i]), Math.min(y0, y[i]), Math.max(x1, x[i]), Math.max(y1, y[i])];
  }
  for (const d of dots) [x0, y0, x1, y1] = [Math.min(x0, d.mx), Math.min(y0, d.my), Math.max(x1, d.mx), Math.max(y1, d.my)];
  if (n || dots.length) span = Math.max(x1 - x0, y1 - y0);
  return { ix: sogIndex(tracks, span / 120 || 1), segs, offs: Int32Array.from(offs), legs, starts: Int32Array.from(starts), dots };
}

/** The segment point `i` of the index came from, and its index there. */
export function fixSegment(p: MapPoints, i: number): { s: number; j: number } {
  let lo = 0;
  let hi = p.starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (p.starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return { s: lo, j: i - p.starts[lo] };
}

export type MapPick = { kind: 'fix'; i: number } | { kind: 'dot'; d: number };

/** The nearest boat dot within `r`, of boat `only` or anyone; -1 for none. */
function nearestDot(p: MapPoints, x: number, y: number, r: number, only: string | null): number {
  let best = r;
  let hit = -1;
  p.dots.forEach((d, k) => {
    if (only != null && d.id !== only) return;
    const dist = Math.hypot(d.mx - x, d.my - y);
    if (dist <= best) [best, hit] = [dist, k];
  });
  return hit;
}

/** A boat's dot within `r` first (it is where the boat is); else the nearest point within `r`; of boat `only`, or anyone. */
function pickWithin(p: MapPoints, x: number, y: number, r: number, only: string | null): MapPick | null {
  const dot = nearestDot(p, x, y, r, only);
  if (dot >= 0) return { kind: 'dot', d: dot };
  const i = nearestSample(p.ix, x, y, r, only);
  return i >= 0 ? { kind: 'fix', i } : null;
}

/**
 * What the pointer at map point (x, y) is on: the selected boat's nearest point
 * within `selR`, else anyone's within `anyR` (map units).
 */
export function pickMapPoint(p: MapPoints, x: number, y: number, selR: number, anyR: number, highlight: string | null): MapPick | null {
  if (highlight != null && (p.ix.ids.includes(highlight) || p.dots.some((d) => d.id === highlight))) {
    const hit = pickWithin(p, x, y, selR, highlight);
    if (hit) return hit;
  }
  return pickWithin(p, x, y, anyR, null);
}

/** Where a pick sits on the map, for its dot. */
export function pickAt(p: MapPoints, pick: MapPick): [number, number] {
  if (pick.kind === 'fix') return [p.ix.x[pick.i], p.ix.y[pick.i]];
  return [p.dots[pick.d].mx, p.dots[pick.d].my];
}

// ---- tooltip text -------------------------------------------------------------

/** A boat's place at a moment: its rank in the fleet, out of `of`. */
export interface PlaceRead {
  place: number;
  of: number;
}

export interface TipOptions {
  /** The leg line (default: the leg's name). */
  legLine?: (leg: number) => string;
  /** The boat's place at time `t`, or null when there's no sound one. */
  placeAt?: (id: string, t: number) => PlaceRead | null;
  /** The map's coloring at the point, under SOG and COG ("VMG 5.2 kn"), or null for none. */
  valueLine?: (p: TipPoint) => string | null;
}

/** A point as the tooltip reads it: the boat, when, its leg, where (east/north m), its SOG and COG. */
export interface TipPoint {
  id: string;
  t: number;
  leg: number;
  x: number;
  y: number;
  sog: number;
  cog: number;
}

const legName = (a: Pick<RaceAnalysis, 'legs'>, leg: number): string => a.legs[leg]?.name ?? `Leg ${leg + 1}`;

/** The leg line of track before the gun, in every colour mode. */
export const PRE_START = 'pre-start';

/** "12:03:04 (gun +5:12)". */
function timeLine(a: Pick<RaceAnalysis, 'meta'>, t: number): string {
  const s = (t - a.meta.gunMs) / 1000;
  return `${localTime(t, a.meta.tzOffsetMs)} (gun ${s < 0 ? '−' : '+'}${duration(Math.abs(s))})`;
}

/**
 * The tooltip for a pick, as lines of plain text (the first is the boat). A point:
 * time, SOG and COG, heel (only with a roll reading), leg ("pre-start" before
 * the gun), and place (only when `placeAt` has one); under SOG and COG, the map's
 * coloring there when `valueLine` gives one. A boat's dot: the same for
 * its interpolated state at the scrubber's time (and "last fix …" while it is held
 * past its final fix).
 */
export function mapTipLines(a: Pick<RaceAnalysis, 'boats' | 'legs' | 'meta'>, p: MapPoints, pick: MapPick, opts: TipOptions = {}): string[] {
  const legLine = opts.legLine ?? ((l: number) => legName(a, l));
  const leg = (l: number): string => (l === PRE_LEG ? PRE_START : legLine(l));
  const who = (id: string): string => boatLabel(a.boats.find((b) => b.id === id), id);
  const motion = (sog: number, cog: number): string => `SOG ${f1(sog)} kn${Number.isFinite(cog) ? ` · COG ${degLabel(cog)}` : ''}`;
  if (pick.kind === 'dot') {
    const d = p.dots[pick.d];
    const lines = [who(d.id), timeLine(a, d.t), motion(d.sog, d.cog)];
    const value = opts.valueLine?.(d);
    if (value) lines.push(value);
    const heel = heelLabel(d.roll);
    if (heel) lines.push(heel);
    lines.push(leg(d.leg));
    const place = d.leg === PRE_LEG ? null : opts.placeAt?.(d.id, d.t);
    if (place) lines.push(`Place ${place.place} of ${place.of}`);
    if (d.hold && d.lastFix != null) lines.push(`last fix ${localTime(d.lastFix, a.meta.tzOffsetMs)}`);
    return lines;
  }
  const i = pick.i;
  const id = p.ix.ids[p.ix.boat[i]];
  const { s, j: k } = fixSegment(p, i);
  const seg = p.segs[s];
  // The point's index in its source track (a scrubbed piece starts part-way along).
  const j = p.offs[s] + k;
  const t = seg.t[j];
  const pieceLeg = p.legs[s];
  const cog = cogAt(seg.x, seg.y, j);
  const lines = [who(id), timeLine(a, t), motion(seg.sog[j], cog)];
  const value = opts.valueLine?.({ id, t, leg: pieceLeg, x: seg.x[j], y: seg.y[j], sog: seg.sog[j], cog });
  if (value) lines.push(value);
  const heel = heelLabel(seg.roll?.[j]);
  if (heel) lines.push(heel);
  lines.push(leg(pieceLeg));
  const place = pieceLeg === PRE_LEG ? null : opts.placeAt?.(id, t);
  if (place) lines.push(`Place ${place.place} of ${place.of}`);
  return lines;
}

/** The lines as the tooltip's HTML: the boat in bold, the rest one per line. */
export const mapTipHtml = (lines: string[]): string =>
  lines.map((l, k) => (k === 0 ? `<b>${esc(l)}</b>` : esc(l))).join('<br>');

/** A box in the map's wrapper, css px. */
export interface TipBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the map's tooltip goes (its top-left in the wrapper, css px): beside the pointer (`x`, `y`), above it;
 * flipped left near the right edge and below near the top, and kept inside the wrapper (`room`). When it would
 * cover `avoid` (the replay's label), the first of the other three corners that doesn't; if all would, as first placed.
 */
export function mapTipPos(x: number, y: number, size: { w: number; h: number }, room: { w: number; h: number }, avoid: TipBox | null = null): { left: number; top: number } {
  const { w, h } = size;
  const fit = (v: number, r: number): number => Math.max(0, Math.min(v, r));
  const right = x + 12;
  const leftOf = x - 12 - w;
  const above = y - h - 10;
  const below = y + 16;
  const xs = right + w > room.w ? [leftOf, right] : [right, leftOf];
  const ys = above < 0 ? [below, above] : [above, below];
  const at = (cx: number, cy: number): { left: number; top: number } => ({ left: fit(cx, room.w - w), top: fit(cy, room.h - h) });
  const tries = [at(xs[0], ys[0]), at(xs[1], ys[0]), at(xs[0], ys[1]), at(xs[1], ys[1])];
  if (!avoid) return tries[0];
  const clear = (p: { left: number; top: number }): boolean =>
    p.left + w <= avoid.left || p.left >= avoid.left + avoid.width || p.top + h <= avoid.top || p.top >= avoid.top + avoid.height;
  return tries.find(clear) ?? tries[0];
}
