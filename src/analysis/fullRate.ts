/**
 * Full-rate tracks for the zoomed-in track map. The drawings carry the race
 * thinned to ~1 Hz (segments) to keep every analysis small; zoomed in tight,
 * the map asks the worker for these instead (worker.ts 'full-rate'), built
 * from the race's raw fixes it already keeps: an uploaded log's own 10 Hz
 * fixes (Boat.fullRate) when the boat has one, else every fix of the feed.
 * Same coordinates (raceProjection) and smoothed SOG as the drawings.
 *
 * A boat whose feed is no faster than the drawings (≤ 1 Hz: thinning dropped
 * nothing) is left out; the map keeps its segments.
 */
import type { RaceData } from '../data/types';
import { interp } from './geo';
import { projectTrack, raceProjection, rangeIdx } from './prepare';
import { smoothSog } from './smooth';
import { MAP_PRE_MS, type BoatDrawing, type FullRateTrack, type RaceAnalysis } from './types';

/** A feed copy must add at least this share of fixes over what is drawn to be worth sending. */
const MIN_GAIN = 1.1;

/** What the worker needs of a drawing to cut its full-rate track (its own drawings' buffers went to the page). */
export interface FullRateWant {
  id: string;
  /** The last drawn fix, ms. */
  endMs: number;
  /** Fixes drawn (segments and pre-gun track). */
  drawn: number;
}

/** A drawing's FullRateWant (shared leg-boundary fixes counted once); null with no track. */
export function fullRateWant(d: BoatDrawing): FullRateWant | null {
  const s = d.segments.at(-1);
  const endMs = s?.t.length ? s.t[s.t.length - 1] : d.pre?.t.length ? d.pre.t[d.pre.t.length - 1] : null;
  if (endMs == null) return null;
  let n = d.pre ? Math.max(0, d.pre.t.length - 1) : 0;
  for (const g of d.segments) n += g.t.length;
  return { id: d.id, endMs, drawn: Math.max(0, n - Math.max(0, d.segments.length - 1)) };
}

/** Every drawn boat's (racing and set aside) FullRateWant. */
export const fullRateWants = (a: Pick<RaceAnalysis, 'drawings' | 'excluded'>): FullRateWant[] =>
  [...a.drawings, ...a.excluded.map((e) => e.drawing)].map(fullRateWant).filter((w): w is FullRateWant => w != null);

/** Each wanted boat's full-rate track from MAP_PRE_MS before the gun to its last drawn fix, where it adds detail. */
export function fullRateTracks(data: RaceData, wants: readonly FullRateWant[]): FullRateTrack[] {
  const proj = raceProjection(data);
  const t0 = data.gunMs - MAP_PRE_MS;
  const out: FullRateTrack[] = [];
  for (const w of wants) {
    const b = data.boats.find((q) => q.id === w.id);
    if (!b) continue;
    const end = w.endMs;
    const tr = projectTrack(b.track, proj);
    const sogSm = smoothSog(tr.t, tr.sog);
    const log = b.fullRate;
    if (log && log.t.length > 1) {
      const [i0, i1] = rangeIdx(log.t, t0, end);
      const n = i1 - i0;
      const x = new Float32Array(n);
      const y = new Float32Array(n);
      const sog = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const [px, py] = proj.toXY(log.lat[i0 + k], log.lon[i0 + k]);
        x[k] = px;
        y[k] = py;
        // The log has no SOG of its own here: the merged track's (smoothed, as the drawings').
        sog[k] = interp(tr.t, sogSm, log.t[i0 + k]);
      }
      out.push({ id: w.id, source: 'log', x, y, t: log.t.slice(i0, i1), sog, ...(log.roll ? { roll: log.roll.slice(i0, i1) } : {}) });
      continue;
    }
    const [i0, i1] = rangeIdx(tr.t, t0, end);
    if (i1 - i0 < MIN_GAIN * w.drawn) continue;
    out.push({
      id: w.id,
      source: 'feed',
      x: Float32Array.from(tr.x.subarray(i0, i1)),
      y: Float32Array.from(tr.y.subarray(i0, i1)),
      t: tr.t.slice(i0, i1),
      sog: sogSm.slice(i0, i1),
      ...(tr.roll ? { roll: Float32Array.from(tr.roll.subarray(i0, i1)) } : {}),
    });
  }
  return out;
}

/** The tracks' typed-array buffers, for posting them across without a copy. */
export function fullRateBuffers(tracks: readonly FullRateTrack[]): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const tk of tracks) for (const arr of [tk.x, tk.y, tk.t, tk.sog, tk.roll]) if (arr) out.add(arr.buffer as ArrayBuffer);
  return [...out];
}

/** Bytes the tracks hold (what a 'full-rate' reply moves). */
export const fullRateBytes = (tracks: readonly FullRateTrack[]): number =>
  tracks.reduce((s, tk) => s + tk.x.byteLength + tk.y.byteLength + tk.t.byteLength + tk.sog.byteLength + (tk.roll?.byteLength ?? 0), 0);
