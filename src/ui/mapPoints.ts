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
import type { BoatDrawing, RaceAnalysis, TrackSegment } from '../analysis/types';
import { boatLabel, degLabel, duration, esc, f1, localTime } from './format';
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

/** Every drawn fix (the hover index) and gap of the legs shown, with the segment each fix came from. */
export interface MapPoints {
  ix: SogIndex;
  segs: TrackSegment[];
  /** Per segment: its boat's gap threshold, ms. */
  gapMs: number[];
  /** Per segment: the index of its first fix in `ix`. */
  starts: Int32Array;
  gaps: MapGap[];
}

/** Build the lookup for leg `leg` (or all); `xy` gives a segment's points in map coordinates. */
export function mapPoints(
  a: Pick<RaceAnalysis, 'drawings'>,
  leg: number | null,
  xy: (seg: TrackSegment) => { x: ArrayLike<number>; y: ArrayLike<number> },
): MapPoints {
  const tracks: IndexedTrack[] = [];
  const segs: TrackSegment[] = [];
  const gapMs: number[] = [];
  const starts: number[] = [];
  const gaps: MapGap[] = [];
  let n = 0;
  let span = 0;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const d of a.drawings) {
    const ms = drawingGapMs(d);
    for (const seg of d.segments) {
      if (leg != null && seg.leg !== leg) continue;
      const { x, y } = xy(seg);
      const m = Math.min(x.length, y.length, seg.t.length, seg.sog.length);
      tracks.push({ id: d.id, x, y, t: seg.t, sog: seg.sog, leg: seg.leg });
      segs.push(seg);
      gapMs.push(ms);
      starts.push(n);
      n += m;
      for (let i = 0; i < m; i++) {
        [x0, y0, x1, y1] = [Math.min(x0, x[i]), Math.min(y0, y[i]), Math.max(x1, x[i]), Math.max(y1, y[i])];
        if (i + 1 < m && seg.t[i + 1] - seg.t[i] > ms) {
          gaps.push({ id: d.id, leg: seg.leg, t0: seg.t[i], t1: seg.t[i + 1], x0: x[i], y0: y[i], x1: x[i + 1], y1: y[i + 1] });
        }
      }
    }
  }
  if (n) span = Math.max(x1 - x0, y1 - y0);
  return { ix: sogIndex(tracks, span / 120 || 1), segs, gapMs, starts: Int32Array.from(starts), gaps };
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

export type MapPick = { kind: 'fix'; i: number } | { kind: 'gap'; g: number };

/** The nearest fix within `r`, or a gap whose chord is nearer still; of boat `only`, or anyone. */
function pickWithin(p: MapPoints, x: number, y: number, r: number, only: string | null): MapPick | null {
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
  if (highlight != null && p.ix.ids.includes(highlight)) {
    const hit = pickWithin(p, x, y, selR, highlight);
    if (hit) return hit;
  }
  return pickWithin(p, x, y, anyR, null);
}

/** Where a pick sits on the map, for its dot: the fix, or the point of the gap's chord nearest (x, y) (its middle without one). */
export function pickAt(p: MapPoints, pick: MapPick, x?: number, y?: number): [number, number] {
  if (pick.kind === 'fix') return [p.ix.x[pick.i], p.ix.y[pick.i]];
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
 * time, SOG and COG, heel (only with a roll reading), leg, place (only when
 * `placeAt` has one), and any gap either side. A gap: its "no data" span and leg.
 */
export function mapTipLines(a: Pick<RaceAnalysis, 'boats' | 'legs' | 'meta'>, p: MapPoints, pick: MapPick, opts: TipOptions = {}): string[] {
  const leg = opts.legLine ?? ((l: number) => legName(a, l));
  const who = (id: string): string => boatLabel(a.boats.find((b) => b.id === id), id);
  if (pick.kind === 'gap') {
    const g = p.gaps[pick.g];
    return [who(g.id), noDataLine(a, g.t0, g.t1), leg(g.leg)];
  }
  const i = pick.i;
  const id = p.ix.ids[p.ix.boat[i]];
  const { s, j } = fixSegment(p, i);
  const seg = p.segs[s];
  const ms = p.gapMs[s];
  const t = seg.t[j];
  const cog = cogAt(seg.x, seg.y, seg.t, j, ms);
  const lines = [who(id), timeLine(a, t), `SOG ${f1(seg.sog[j])} kn${Number.isFinite(cog) ? ` · COG ${degLabel(cog)}` : ''}`];
  const heel = heelLabel(seg.roll?.[j]);
  if (heel) lines.push(heel);
  lines.push(leg(seg.leg));
  const place = opts.placeAt?.(id, t);
  if (place) lines.push(`Place ${place.place} of ${place.of}`);
  if (j > 0 && t - seg.t[j - 1] > ms) lines.push(noDataLine(a, seg.t[j - 1], t));
  if (j + 1 < seg.t.length && seg.t[j + 1] - t > ms) lines.push(noDataLine(a, t, seg.t[j + 1]));
  return lines;
}

/** The lines as the tooltip's HTML: the boat in bold, the rest one per line. */
export const mapTipHtml = (lines: string[]): string =>
  lines.map((l, k) => (k === 0 ? `<b>${esc(l)}</b>` : esc(l))).join('<br>');
