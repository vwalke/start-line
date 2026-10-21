/**
 * The track map's point details: telemetry gaps (drawn as breaks), course over
 * ground from neighbouring drawn fixes, heel, and the lookup the hover/tap
 * tooltip reads (every drawn fix and gap of the legs shown, in map coordinates).
 *
 * A gap is a step between consecutive drawn fixes longer than MAP_GAP_S, or
 * MAP_GAP_CADENCE times the boat's usual spacing when its tracker logs slower
 * than that: the drawn segments are thinned to ≥ 1 s, so a 1 Hz boat steps ~1 s
 * and a gap is anything over 2 s, but many feeds log every 2–10 s, and a
 * fixed 2 s rule would break nearly every step of theirs.
 */
import { median, vecBearing } from '../analysis/geo';
import { PRE_LEG, type BoatDrawing, type RaceAnalysis, type TrackSegment } from '../analysis/types';
import { boatLabel, degLabel, duration, esc, f1, localTime } from './format';
import type { BoatAt, MapPiece, SrcTrack } from './mapPieces';
import { nearestSample, sogIndex, type IndexedTrack, type SogIndex } from './sog';

/** Consecutive drawn fixes further apart than this (s) are a gap… */
export const MAP_GAP_S = 2;
/** …or than this many times the boat's median step, when that is longer. */
export const MAP_GAP_CADENCE = 2;
/** Fixes this close (m) give no course over ground. */
const COG_MIN_M = 0.5;

/** The gap threshold, ms, for a boat with these drawn segments. */
export function gapMsOf(segments: readonly TrackSegment[]): number {
  const steps: number[] = [];
  for (const s of segments) for (let i = 1; i < s.t.length; i++) steps.push(s.t[i] - s.t[i - 1]);
  const typical = steps.length ? median(steps) : 0;
  return Math.max(MAP_GAP_S * 1000, MAP_GAP_CADENCE * typical);
}

const gapCache = new WeakMap<BoatDrawing, number>();
/** `gapMsOf` a drawing's segments, worked out once per drawing. */
export function drawingGapMs(d: BoatDrawing): number {
  let ms = gapCache.get(d);
  if (ms == null) gapCache.set(d, (ms = gapMsOf(d.segments)));
  return ms;
}

/** [first, end) index ranges of `t` with no step over `gapMs`; a lone fix between two gaps is a run of one. */
export function gapRuns(t: ArrayLike<number>, gapMs: number): [number, number][] {
  const out: [number, number][] = [];
  if (!t.length) return out;
  let s = 0;
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] > gapMs) {
      out.push([s, i]);
      s = i;
    }
  }
  out.push([s, t.length]);
  return out;
}

/** Whether any segment of leg `leg` (or all) has a gap, by each boat's threshold. */
export function mapHasGaps(a: RaceAnalysis, leg: number | null): boolean {
  for (const d of a.drawings) {
    const ms = drawingGapMs(d);
    for (const s of d.segments) if ((leg == null || s.leg === leg) && gapRuns(s.t, ms).length > 1) return true;
  }
  return false;
}

/** The map key's note for its "no data" swatch. */
export const MAP_GAP_TITLE = `Telemetry gap: no fix for over ${MAP_GAP_S} s (or twice the boat's usual spacing)`;

/**
 * Course over ground at fix `i`, degrees true, from its neighbouring fixes
 * (x east, y north, metres): across i−1 → i+1, or one side at a run's end;
 * never across a gap. NaN with no neighbour or no movement.
 */
export function cogAt(x: ArrayLike<number>, y: ArrayLike<number>, t: ArrayLike<number>, i: number, gapMs: number): number {
  const n = Math.min(x.length, y.length, t.length);
  if (i < 0 || i >= n) return NaN;
  const lo = i > 0 && t[i] - t[i - 1] <= gapMs ? i - 1 : i;
  const hi = i + 1 < n && t[i + 1] - t[i] <= gapMs ? i + 1 : i;
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

/** A drawn gap: the fixes either side, in map coordinates. */
export interface MapGap {
  id: string;
  leg: number;
  t0: number;
  t1: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Every drawn fix (the hover index) and gap shown, with the piece of track each fix came from; and the scrubber's dots. */
export interface MapPoints {
  ix: SogIndex;
  /** Per piece: its source track (east/north metres, as analysed), … */
  segs: SrcTrack[];
  /** …the index there of the piece's first fix, … */
  offs: Int32Array;
  /** …its leg (PRE_LEG before the gun), … */
  legs: number[];
  /** …its boat's gap threshold, ms, … */
  gapMs: number[];
  /** …and the index of its first fix in `ix`. */
  starts: Int32Array;
  gaps: MapGap[];
  /** The boats at the scrubber's time (none in the full-race view). */
  dots: BoatAt[];
}

/** A piece of track for the lookup: [i0, i1) of `src`, whose map coordinates are `rx`, `ry`. */
export type PointPiece = Omit<MapPiece, 'rx' | 'ry' | 'end'> & { rx: Float64Array | Float32Array; ry: Float64Array | Float32Array };

/** Build the lookup for leg `leg` (or all) of the whole race; `xy` gives a segment's points in map coordinates. */
export function mapPoints(
  a: Pick<RaceAnalysis, 'drawings'>,
  leg: number | null,
  xy: (seg: TrackSegment) => { x: Float64Array | Float32Array; y: Float64Array | Float32Array },
): MapPoints {
  const pieces: PointPiece[] = [];
  const gapMs = new Map<string, number>();
  for (const d of a.drawings) {
    gapMs.set(d.id, drawingGapMs(d));
    for (const seg of d.segments) {
      if (leg != null && seg.leg !== leg) continue;
      const { x, y } = xy(seg);
      pieces.push({ id: d.id, leg: seg.leg, src: seg, rx: x, ry: y, i0: 0, i1: Math.min(x.length, y.length, seg.t.length, seg.sog.length) });
    }
  }
  return mapPointsOf(pieces, (id) => gapMs.get(id) ?? MAP_GAP_S * 1000);
}

/** The lookup over `pieces` (each boat's consecutive), with each boat's gap threshold, and the scrubber's dots. */
export function mapPointsOf(pieces: readonly PointPiece[], gapOf: (id: string) => number, dots: BoatAt[] = []): MapPoints {
  const tracks: IndexedTrack[] = [];
  const segs: SrcTrack[] = [];
  const offs: number[] = [];
  const legs: number[] = [];
  const gapMs: number[] = [];
  const starts: number[] = [];
  const gaps: MapGap[] = [];
  let n = 0;
  let span = 0;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const pc of pieces) {
    const ms = gapOf(pc.id);
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
    gapMs.push(ms);
    starts.push(n);
    n += m;
    for (let i = 0; i < m; i++) {
      [x0, y0, x1, y1] = [Math.min(x0, x[i]), Math.min(y0, y[i]), Math.max(x1, x[i]), Math.max(y1, y[i])];
      if (i + 1 < m && t[i + 1] - t[i] > ms) {
        gaps.push({ id: pc.id, leg: pc.leg, t0: t[i], t1: t[i + 1], x0: x[i], y0: y[i], x1: x[i + 1], y1: y[i + 1] });
      }
    }
  }
  for (const d of dots) [x0, y0, x1, y1] = [Math.min(x0, d.mx), Math.min(y0, d.my), Math.max(x1, d.mx), Math.max(y1, d.my)];
  if (n || dots.length) span = Math.max(x1 - x0, y1 - y0);
  return { ix: sogIndex(tracks, span / 120 || 1), segs, offs: Int32Array.from(offs), legs, gapMs, starts: Int32Array.from(starts), gaps, dots };
}

/** The segment fix `i` of the index came from, and its index there. */
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

/** The point of gap `g`'s chord nearest (x, y). */
function chordPoint(g: MapGap, x: number, y: number): [number, number] {
  const vx = g.x1 - g.x0;
  const vy = g.y1 - g.y0;
  const l2 = vx * vx + vy * vy;
  const f = l2 > 0 ? Math.min(1, Math.max(0, ((x - g.x0) * vx + (y - g.y0) * vy) / l2)) : 0;
  return [g.x0 + f * vx, g.y0 + f * vy];
}

/** Distance from (x, y) to the chord of gap `g`. */
function gapDist(g: MapGap, x: number, y: number): number {
  const [cx, cy] = chordPoint(g, x, y);
  return Math.hypot(x - cx, y - cy);
}

export type MapPick = { kind: 'fix'; i: number } | { kind: 'gap'; g: number } | { kind: 'dot'; d: number };

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

/** A boat's dot within `r` first (it is where the boat is); else the nearest fix within `r`, or a gap whose chord is nearer still; of boat `only`, or anyone. */
function pickWithin(p: MapPoints, x: number, y: number, r: number, only: string | null): MapPick | null {
  const dot = nearestDot(p, x, y, r, only);
  if (dot >= 0) return { kind: 'dot', d: dot };
  const i = nearestSample(p.ix, x, y, r, only);
  let best = i >= 0 ? Math.hypot(p.ix.x[i] - x, p.ix.y[i] - y) : r;
  let g = -1;
  p.gaps.forEach((gap, k) => {
    if (only != null && gap.id !== only) return;
    const d = gapDist(gap, x, y);
    if (d < best) [best, g] = [d, k];
  });
  if (g >= 0) return { kind: 'gap', g };
  return i >= 0 ? { kind: 'fix', i } : null;
}

/**
 * What the pointer at map point (x, y) is on: the selected boat's nearest fix
 * or gap within `selR`, else anyone's within `anyR` (map units). A gap is
 * picked only where its chord is nearer than any fix (so a fix at either end
 * of a gap still reads as the fix, which lists the gap too).
 */
export function pickMapPoint(p: MapPoints, x: number, y: number, selR: number, anyR: number, highlight: string | null): MapPick | null {
  if (highlight != null && (p.ix.ids.includes(highlight) || p.dots.some((d) => d.id === highlight))) {
    const hit = pickWithin(p, x, y, selR, highlight);
    if (hit) return hit;
  }
  return pickWithin(p, x, y, anyR, null);
}

/** Where a pick sits on the map, for its dot: the fix, or the point of the gap's chord nearest (x, y) (its middle without one). */
export function pickAt(p: MapPoints, pick: MapPick, x?: number, y?: number): [number, number] {
  if (pick.kind === 'fix') return [p.ix.x[pick.i], p.ix.y[pick.i]];
  if (pick.kind === 'dot') return [p.dots[pick.d].mx, p.dots[pick.d].my];
  const g = p.gaps[pick.g];
  return x == null || y == null ? [(g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2] : chordPoint(g, x, y);
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
}

const legName = (a: Pick<RaceAnalysis, 'legs'>, leg: number): string => a.legs[leg]?.name ?? `Leg ${leg + 1}`;

/** The leg line of track before the gun, in every colour mode. */
export const PRE_START = 'pre-start';

/** "no data 12:01:05–12:01:40" (local time at the race's offset). */
export const noDataLine = (a: Pick<RaceAnalysis, 'meta'>, t0: number, t1: number): string =>
  `no data ${localTime(t0, a.meta.tzOffsetMs)}–${localTime(t1, a.meta.tzOffsetMs)}`;

/** "12:03:04 (gun +5:12)". */
function timeLine(a: Pick<RaceAnalysis, 'meta'>, t: number): string {
  const s = (t - a.meta.gunMs) / 1000;
  return `${localTime(t, a.meta.tzOffsetMs)} (gun ${s < 0 ? '−' : '+'}${duration(Math.abs(s))})`;
}

/**
 * The tooltip for a pick, as lines of plain text (the first is the boat). A fix:
 * time, SOG and COG, heel (only with a roll reading), leg ("pre-start" before
 * the gun), place (only when `placeAt` has one), and any gap either side. A
 * boat's dot: the same for its interpolated state at the scrubber's time (and
 * "no data since …" while it holds in a gap). A gap: its "no data" span and leg.
 */
export function mapTipLines(a: Pick<RaceAnalysis, 'boats' | 'legs' | 'meta'>, p: MapPoints, pick: MapPick, opts: TipOptions = {}): string[] {
  const legLine = opts.legLine ?? ((l: number) => legName(a, l));
  const leg = (l: number): string => (l === PRE_LEG ? PRE_START : legLine(l));
  const who = (id: string): string => boatLabel(a.boats.find((b) => b.id === id), id);
  const motion = (sog: number, cog: number): string => `SOG ${f1(sog)} kn${Number.isFinite(cog) ? ` · COG ${degLabel(cog)}` : ''}`;
  if (pick.kind === 'gap') {
    const g = p.gaps[pick.g];
    return [who(g.id), noDataLine(a, g.t0, g.t1), leg(g.leg)];
  }
  if (pick.kind === 'dot') {
    const d = p.dots[pick.d];
    const lines = [who(d.id), timeLine(a, d.t), motion(d.sog, d.cog)];
    const heel = heelLabel(d.roll);
    if (heel) lines.push(heel);
    lines.push(leg(d.leg));
    const place = d.leg === PRE_LEG ? null : opts.placeAt?.(d.id, d.t);
    if (place) lines.push(`Place ${place.place} of ${place.of}`);
    if (d.hold && d.lastFix != null) lines.push(`no data since ${localTime(d.lastFix, a.meta.tzOffsetMs)}`);
    return lines;
  }
  const i = pick.i;
  const id = p.ix.ids[p.ix.boat[i]];
  const { s, j: k } = fixSegment(p, i);
  const seg = p.segs[s];
  // The fix's index in its source track (a scrubbed piece starts part-way along).
  const j = p.offs[s] + k;
  const ms = p.gapMs[s];
  const t = seg.t[j];
  const pieceLeg = p.legs[s];
  const lines = [who(id), timeLine(a, t), motion(seg.sog[j], cogAt(seg.x, seg.y, seg.t, j, ms))];
  const heel = heelLabel(seg.roll?.[j]);
  if (heel) lines.push(heel);
  lines.push(leg(pieceLeg));
  const place = pieceLeg === PRE_LEG ? null : opts.placeAt?.(id, t);
  if (place) lines.push(`Place ${place.place} of ${place.of}`);
  if (j > 0 && t - seg.t[j - 1] > ms) lines.push(noDataLine(a, seg.t[j - 1], t));
  if (j + 1 < seg.t.length && seg.t[j + 1] - t > ms) lines.push(noDataLine(a, t, seg.t[j + 1]));
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
