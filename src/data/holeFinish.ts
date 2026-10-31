/**
 * A finish inside a hole in a boat's tracker. A boat placed in the official results (or finished with a code)
 * whose tracker has no fixes around its finish has no crossing of the line (data/finishes.ts never bridges a
 * step over CROSS_MAX_GAP_MS), and RaceSense leaves it out of its finishes too. J/70 North Americans race 6,
 * where the official times are set aside: 314 (21st) froze ~1,065 m from the line on its last leg and came
 * back 9 min later past the pin end; 151 (18th) held one position ~850 m out for 6 min, then caught up across
 * the line in one jump; 14 (26th) stopped 2.4 km out, 12 min before the boats placed either side finished.
 *
 * Such a boat is timed between the boats placed just ahead of and behind it that have a finish time (holeFinish):
 * from where it was last measured before the hole (the start of a run of fixes held at one position: a frozen
 * tracker repeats its last one), the distance to the line at its speed over the minute before (median SOG, else
 * its track's; at least HOLE_MIN_KN), kept between those two times and inside the hole. Without a speed, halfway
 * between the two (both needed). Only when it's believable (speedFits): the speed it takes to reach the line by
 * then is within HOLE_MAX_X of that speed either way and at most HOLE_MAX_KN, and so is (at most) the speed from
 * the line on to the first fix after the hole, if any.
 *
 * The track then gets one fix on the line at that time (lineFix, withLineFix: Track.finishFixMs), so it is drawn and
 * replayed through the line like any finisher's; the same goes for any finish time (official, RaceSense) that falls
 * in such a hole, when the boat could have sailed more or less straight there (speedFits again: a tracker that
 * stopped well before a mark the boat still had to round is left as it was). The point is where the boat's course
 * over the minute before the hole meets the line, kept HOLE_INSET_M inside its ends; else the line's point nearest.
 */
import { bearingDeg, CROSS_MAX_GAP_MS, destination, FINISH_MIN_AFTER_GUN_MS, metresFrom, type Fix } from './finishes';
import type { LatLon, Line, Track } from './types';

/** The boat's speed and course into the hole are taken over this long before it, ms. */
export const HOLE_SPEED_MS = 60_000;
/** The speed to the line is at least this, kn (a boat luffing or slowed by a tracker's last fixes still finishes). */
export const HOLE_MIN_KN = 2;
/** The speed it takes to reach the line by the time given is within this factor of that speed, either way… */
export const HOLE_MAX_X = 2;
/** …and never over this, kn. */
export const HOLE_MAX_KN = 30;
/** The fix on the line is at least this far inside its ends, m (at most a quarter of the line). */
export const HOLE_INSET_M = 5;
/** An estimate stays this far inside the hole, ms (it may tie the boat ahead or behind: they can finish a second apart). */
const BOUND_MS = 1_000;
const MS_PER_KN = 1852 / 3600;

export interface HoleFix extends Fix {
  /** SOG, kn, when the source has it. */
  sog?: number;
}

/** A fix placed on the finish line: its time, position, and the SOG (kn) and course (° true) that take the boat there. */
export interface LineFix {
  ms: number;
  at: LatLon;
  sogKn: number;
  headingDeg: number;
}

export interface HoleFinishInput {
  fixes: readonly HoleFix[];
  /** The finish line at time t. */
  lineAt: (t: number) => Line | null;
  gunMs: number;
  /** The end of the race window (the track's last fix or the next gun). */
  endMs: number;
  /** The boat's last leg starts here (data/finishes.ts lastLegFrom). */
  from: number;
  /** The finish times of the boats placed just ahead of and just behind it, if any. */
  ahead: number | null;
  behind: number | null;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dist = (a: LatLon, b: LatLon): number => Math.hypot(...metresFrom(b, a));
const samePlace = (a: LatLon, b: LatLon): boolean => a.lat === b.lat && a.lon === b.lon;

/** The first of the fixes up to `i` held at fix `i`'s exact position (a frozen tracker repeats its last one). */
function heldFrom(fixes: readonly HoleFix[], i: number): number {
  let j = i;
  while (j > 0 && samePlace(fixes[j - 1], fixes[i])) j--;
  return j;
}

/** The first fix of the window HOLE_SPEED_MS up to fix `k`. */
function windowStart(fixes: readonly HoleFix[], k: number): number {
  let j = k;
  while (j > 0 && fixes[j - 1].ts >= fixes[k].ts - HOLE_SPEED_MS) j--;
  return j;
}

/** The boat's speed over HOLE_SPEED_MS up to fix `k`, kn (median SOG, else its track's over at least 10 s), at least HOLE_MIN_KN; null with neither. */
export function recentKn(fixes: readonly HoleFix[], k: number): number | null {
  const j = windowStart(fixes, k);
  const sogs = fixes
    .slice(j, k + 1)
    .map((f) => f.sog)
    .filter((s): s is number => s != null && Number.isFinite(s) && s > 0);
  let kn: number | null = sogs.length >= 3 ? median(sogs) : null;
  const s = (fixes[k].ts - fixes[j].ts) / 1000;
  if (kn == null && s >= 10) {
    let m = 0;
    for (let i = j + 1; i <= k; i++) m += dist(fixes[i - 1], fixes[i]);
    kn = m / s / MS_PER_KN;
  }
  return kn == null ? null : Math.max(HOLE_MIN_KN, kn);
}

/** The boat's course over HOLE_SPEED_MS up to fix `k`, ° true; null when it moved under 10 m. */
function recentCourse(fixes: readonly HoleFix[], k: number): number | null {
  const a = fixes[windowStart(fixes, k)];
  return dist(a, fixes[k]) >= 10 ? bearingDeg(a, fixes[k]) : null;
}

/** Where a boat at `p` on course `deg` meets `line`, HOLE_INSET_M inside its ends; else (no course, parallel, or behind it) the line's point nearest `p`. */
export function lineMeet(p: LatLon, deg: number | null, line: Line): LatLon {
  const [bx, by] = metresFrom(line.right, line.left);
  const len = Math.hypot(bx, by);
  if (!(len > 0)) return line.left;
  const [ux, uy] = [bx / len, by / len];
  const [px, py] = metresFrom(p, line.left);
  let s = px * ux + py * uy;
  if (deg != null) {
    const [dx, dy] = [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)];
    // p + r·d = s·u: r ahead of the boat.
    const den = dx * uy - dy * ux;
    if (Math.abs(den) > 1e-6) {
      const r = -(px * uy - py * ux) / den;
      if (r > 0) s = -(px * dy - py * dx) / den;
    }
  }
  const inset = Math.min(HOLE_INSET_M, len / 4);
  return destination(line.left, bearingDeg(line.left, line.right), Math.min(len - inset, Math.max(inset, s)));
}

/** The speed that takes a boat `m` metres in `ms`, kn. */
const knOver = (m: number, ms: number): number => m / (ms / 1000) / MS_PER_KN;

/** A speed `kn` to the line is believable for a boat sailing at `ownKn` (null: unknown): within HOLE_MAX_X of it either way, and at most HOLE_MAX_KN. */
export const speedFits = (kn: number, ownKn: number | null): boolean =>
  kn <= HOLE_MAX_KN && (ownKn == null || (kn <= HOLE_MAX_X * ownKn && kn >= ownKn / HOLE_MAX_X));

/** Across the hole after fix `i`: where the boat was measured last (fix heldFrom(i)), and where its course meets `line`. */
function approach(fixes: readonly HoleFix[], i: number, line: Line): { p: HoleFix; at: LatLon } {
  const k = heldFrom(fixes, i);
  return { p: fixes[k], at: lineMeet(fixes[k], recentCourse(fixes, k), line) };
}

/** The fix at `at` on the line at `ms`, reached from `p`. */
const lineFixFrom = (p: HoleFix, at: LatLon, ms: number): LineFix => ({ ms, at, sogKn: knOver(dist(p, at), ms - p.ts), headingDeg: bearingDeg(p, at) });

/** The hole a finish at `ms` falls in: the index of the fix before it, when the step is over CROSS_MAX_GAP_MS (or the track ends before it); else null. */
function holeAt(fixes: readonly HoleFix[], ms: number): number | null {
  let lo = 0;
  let hi = fixes.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (fixes[m].ts < ms) lo = m + 1;
    else hi = m;
  }
  const i = lo - 1;
  if (i < 0) return null;
  const next = fixes[i + 1];
  if (next && next.ts === ms) return null;
  return !next || next.ts - fixes[i].ts > CROSS_MAX_GAP_MS ? i : null;
}

/**
 * The estimated finish of a boat whose tracker skips the line (see the file comment): the first hole on its last
 * leg the estimate falls in, or null when none does or it isn't believable.
 */
export function holeFinish(inp: HoleFinishInput): LineFix | null {
  const { fixes, ahead, behind } = inp;
  const first = Math.max(inp.from, inp.gunMs + FINISH_MIN_AFTER_GUN_MS);
  for (let i = 0; i < fixes.length; i++) {
    const a = fixes[i];
    const next = fixes[i + 1] ?? null;
    if (a.ts < first || (next ? next.ts - a.ts <= CROSS_MAX_GAP_MS : a.ts >= inp.endMs)) continue;
    const k = heldFrom(fixes, i);
    const line = inp.lineAt(fixes[k].ts);
    if (!line) return null;
    const lo = Math.max(ahead ?? -Infinity, a.ts + BOUND_MS);
    const hi = Math.min(behind ?? Infinity, (next ? next.ts : inp.endMs) - BOUND_MS);
    if (!(lo <= hi)) continue;
    const { p, at } = approach(fixes, i, line);
    const kn = recentKn(fixes, k);
    let ms: number;
    if (kn != null) ms = p.ts + (1000 * dist(p, at)) / (kn * MS_PER_KN);
    else if (ahead != null && behind != null) ms = (ahead + behind) / 2;
    else continue;
    const fix = lineFixFrom(p, at, Math.round(Math.min(hi, Math.max(lo, ms))));
    if (!(fix.ms > p.ts) || !speedFits(fix.sogKn, kn)) continue;
    // From the line on to where the tracker picks the boat up again (not a fix still held where it froze).
    let j = i + 1;
    while (j < fixes.length && samePlace(fixes[j], a)) j++;
    if (j < fixes.length && knOver(dist(at, fixes[j]), fixes[j].ts - fix.ms) > Math.min(HOLE_MAX_KN, kn != null ? HOLE_MAX_X * kn : Infinity)) continue;
    return fix;
  }
  return null;
}

/**
 * The fix on the line for a finish time `ms` the boat already has (official, RaceSense, estimated) when it falls in
 * a hole on its last leg (from `from` on) with no crossing: a step over CROSS_MAX_GAP_MS, or after its last fix. Null
 * when it doesn't, there's no line then, or the speed it takes to get there by then doesn't fit (speedFits).
 */
export function lineFix(fixes: readonly HoleFix[], lineAt: (t: number) => Line | null, ms: number, from: number): LineFix | null {
  const i = holeAt(fixes, ms);
  if (i == null || fixes[i].ts < from) return null;
  const line = lineAt(fixes[heldFrom(fixes, i)].ts);
  if (!line) return null;
  const { p, at } = approach(fixes, i, line);
  const fix = lineFixFrom(p, at, ms);
  return ms > p.ts && speedFits(fix.sogKn, recentKn(fixes, heldFrom(fixes, i))) ? fix : null;
}

/**
 * Display only (Boat.finishAt): where a boat with a finish at `ms` (official or estimated: no position of the device's)
 * crossed the line at `lineAt(ms)`: along its step across that time (the fix before to the fix after) where that meets
 * the line, else (no fix after, or one at the same place) along its course into it (approach); HOLE_INSET_M inside the
 * line's ends, its nearest point when the course misses it. Null with no fix before `ms` or no line then.
 */
export function finishPoint(fixes: readonly HoleFix[], lineAt: (t: number) => Line | null, ms: number): LatLon | null {
  let i = -1;
  while (i + 1 < fixes.length && fixes[i + 1].ts <= ms) i++;
  const line = lineAt(ms);
  if (i < 0 || !line) return null;
  const p = fixes[i];
  const q = fixes[i + 1];
  if (q && dist(p, q) >= 1) return lineMeet(p, bearingDeg(p, q), line);
  return approach(fixes, i, line).at;
}

/** `track` with `fix` inserted in time order and marked as placed (Track.finishFixMs); `track` itself when it has a fix at that time already. */
export function withLineFix(track: Track, fix: LineFix): Track {
  const n = track.t.length;
  let i = 0;
  while (i < n && track.t[i] < fix.ms) i++;
  if (i < n && track.t[i] === fix.ms) return track;
  const put = <A extends Float64Array | Float32Array>(arr: A, v: number): A => {
    const out = new (arr.constructor as { new (n: number): A })(n + 1);
    out.set(arr.subarray(0, i));
    out[i] = v;
    out.set(arr.subarray(i), i + 1);
    return out;
  };
  return {
    t: put(track.t, fix.ms),
    lat: put(track.lat, fix.at.lat),
    lon: put(track.lon, fix.at.lon),
    sog: put(track.sog, fix.sogKn),
    heading: put(track.heading, fix.headingDeg),
    ...(track.roll ? { roll: put(track.roll, NaN) } : {}),
    ...(track.pitch ? { pitch: put(track.pitch, NaN) } : {}),
    finishFixMs: fix.ms,
  };
}
