/**
 * A finisher drawn through the line. The feed can drop the whole fleet's fixes for 13–44 s around the finish (J/70 North
 * Americans race 8: 22 of 53 finishers); a last leg drawn to the boat's last fix before its finish time stopped it 12–71 m
 * short of the line, held there and gone at its finish time. When a boat's finish falls in a step of its track longer
 * than FINISH_JOIN_MIN_MS (and no longer than CROSS_MAX_GAP_MS: a longer hole is data/holeFinish.ts's), its drawn last
 * leg runs on from that last fix to its point at its finish time (Boat.finishAt: the device's own, else one on the line
 * along its track) and then to its first fix after, so it sails through the line at its recorded time like any finisher.
 * The device's point is its tracker's when the bow crossed (a J/70's is ~2 m short of the line): the map's hull, drawn
 * with its bow that far ahead (ui/boatShape.ts hullCenterFromBow), is on the line then; its track crosses a moment later.
 *
 * DISPLAY ONLY: the point goes into the drawn segments (and the full-rate track cut to them, fullRate.ts), never into
 * the track measured for times, distance, speeds, legs or places.
 */
import { CROSS_MAX_GAP_MS } from '../data/finishes';

/** A finish in a step of the track at most this long is drawn as it is (the track already reaches the line), ms. */
export const FINISH_JOIN_MIN_MS = 3_000;

/** The finish point on the map (raceProjection metres) and its time. */
export interface FinishThrough {
  t: number;
  x: number;
  y: number;
}

/**
 * Fix times `t`, finish at `ms`: the fix before it and the one after (null: the track ends first) when the finish falls in
 * a step longer than FINISH_JOIN_MIN_MS and at most CROSS_MAX_GAP_MS; null when there's a fix at `ms` or no such step.
 */
export function finishStep(t: ArrayLike<number>, ms: number): { before: number; after: number | null } | null {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] < ms) lo = m + 1;
    else hi = m;
  }
  if ((lo < t.length && t[lo] === ms) || lo === 0) return null;
  const before = lo - 1;
  const after = lo < t.length ? lo : null;
  if ((after != null ? t[after] : ms) - t[before] > CROSS_MAX_GAP_MS) return null;
  return (after != null ? t[after] : ms) - t[before] > FINISH_JOIN_MIN_MS ? { before, after } : null;
}

type Arr = Float32Array | Float64Array;

/** Arrays `t`, `x`, `y`, `sog` (and `roll`) with the finish point `f` put in time order (its SOG `sog`, no roll). */
export function withFinishThrough<T extends { t: Float64Array; x: Arr; y: Arr; sog: Arr; roll?: Float32Array }>(tk: T, f: FinishThrough, sog: number): T {
  const n = tk.t.length;
  let i = 0;
  while (i < n && tk.t[i] < f.t) i++;
  if (i < n && tk.t[i] === f.t) return tk;
  const put = <A extends Arr>(a: A, v: number): A => {
    const out = new (a.constructor as { new (n: number): A })(n + 1);
    out.set(a.subarray(0, i));
    out[i] = v;
    out.set(a.subarray(i), i + 1);
    return out;
  };
  return { ...tk, t: put(tk.t, f.t), x: put(tk.x, f.x), y: put(tk.y, f.y), sog: put(tk.sog, sog), ...(tk.roll ? { roll: put(tk.roll, NaN) } : {}) };
}
