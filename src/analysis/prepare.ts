/** Projects a RaceData track into local metres and fills gaps (missing heading/SOG) from the positions. */
import type { RaceData, Track } from '../data/types';
import { MS_TO_KN, makeProjection, type Projection, vecBearing } from './geo';

/** The race's local metres: east/north of the start line's middle (every drawn x/y is in these). */
export const raceProjection = (data: Pick<RaceData, 'startLine'>): Projection =>
  makeProjection({ lat: (data.startLine.left.lat + data.startLine.right.lat) / 2, lon: (data.startLine.left.lon + data.startLine.right.lon) / 2 });

export interface XYTrack {
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  sog: Float64Array;
  heading: Float64Array;
  /** As `Track.roll` / `Track.pitch` (NaN = no reading); absent when the source has none. */
  roll?: Float64Array;
  pitch?: Float64Array;
}

export function projectTrack(track: Track, proj: Projection): XYTrack {
  // Sort + drop duplicate timestamps defensively; adapters should already have done it.
  const order = Array.from(track.t.keys()).sort((a, b) => track.t[a] - track.t[b]);
  const keep: number[] = [];
  for (const i of order) if (!keep.length || track.t[i] !== track.t[keep[keep.length - 1]]) keep.push(i);
  const n = keep.length;
  const out: XYTrack = {
    t: new Float64Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    sog: new Float64Array(n),
    heading: new Float64Array(n),
  };
  if (track.roll) out.roll = new Float64Array(n);
  if (track.pitch) out.pitch = new Float64Array(n);
  keep.forEach((i, k) => {
    const [x, y] = proj.toXY(track.lat[i], track.lon[i]);
    out.t[k] = track.t[i];
    out.x[k] = x;
    out.y[k] = y;
    out.sog[k] = track.sog[i];
    out.heading[k] = track.heading[i];
    if (out.roll) out.roll[k] = track.roll![i];
    if (out.pitch) out.pitch[k] = track.pitch![i];
  });
  for (let k = 0; k < n; k++) {
    if (Number.isFinite(out.heading[k]) && Number.isFinite(out.sog[k])) continue;
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 1, k + 1);
    const dt = (out.t[b] - out.t[a]) / 1000;
    const dx = out.x[b] - out.x[a];
    const dy = out.y[b] - out.y[a];
    if (!Number.isFinite(out.heading[k])) out.heading[k] = dt > 0 ? vecBearing([dx, dy]) : 0;
    if (!Number.isFinite(out.sog[k])) out.sog[k] = dt > 0 ? (Math.hypot(dx, dy) / dt) * MS_TO_KN : 0;
  }
  return out;
}

/** Index range [i0, i1) of samples with a <= t <= b. */
export function rangeIdx(t: Float64Array, a: number, b: number): [number, number] {
  let i0 = 0;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] < a) lo = m + 1;
    else hi = m;
  }
  i0 = lo;
  lo = i0;
  hi = t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] <= b) lo = m + 1;
    else hi = m;
  }
  return [i0, lo];
}
