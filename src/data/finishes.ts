/**
 * Finishes from the tracks, and whether official finish times can be believed.
 *
 * A boat's tracker finish is a crossing of the finish line (its two trackers, where they were
 * at the time). Which crossing: the feed's `race_stage` turns `finishing` on each device as it
 * starts its last leg (15–20 min before it finishes at the J/70 Worlds), so it is the first
 * crossing from a minute before that onset, and not before the fleet's onset (fleetOnsetFloor)
 * (Cascais race 2: 98 of 100 RaceSense finishes reproduced, median 0.6 s off). Without stage rows it is the first crossing after the boat's
 * last visit to the far end of the course (the last time it was ≥ 70% of its furthest distance
 * from the line, measured along the course axis: the start's wind direction, else square to the
 * start line toward the fleet). Along the axis, not as the crow flies: a boat that sails home
 * cross-wind past the windward mark's distance is still on its way to finish (2026 Fall Brawl).
 * A track that never crosses gets no finish: none is ever invented.
 *
 * Official times (Yachtscoring) are used only when plausible: at least 3 matched finishers have
 * a crossing within 10 min of their official time and the median gap is ≤ 60 s, and every
 * official finish falls after the gun and before the next gun. One-design results often carry
 * placeholder times a few seconds apart (J/105 CBC: ~24 min off the tracks).
 */
import type { LatLon, Line } from './types';

export interface Fix {
  ts: number;
  lat: number;
  lon: number;
  stage?: string | null;
  rn?: number | null;
}

export interface MarkSeries {
  t: number[];
  lat: number[];
  lon: number[];
}

/** Gaps between fixes longer than this aren't bridged when looking for a crossing. */
export const CROSS_MAX_GAP_MS = 120_000;
/** Crossings in the first minutes after the gun are the start, not a finish. */
export const FINISH_MIN_AFTER_GUN_MS = 5 * 60_000;
/** The stage onset can precede the boat's own row by a fix or two. */
export const STAGE_SLACK_MS = 60_000;
/** Without stage rows: the finish follows the boat's last time this far out (share of its furthest distance up the course axis). */
export const FAR_FRAC = 0.7;
/** …and a boat that never got this far up the course axis (m) has no finish. */
export const FAR_MIN_M = 300;
/** Plausible official times: matched finishers with a crossing near their official time… */
export const PLAUSIBLE_MIN_BOATS = 3;
/** …within this (to find the crossing)… */
export const PLAUSIBLE_SEARCH_MS = 10 * 60_000;
/** …and a median gap no larger than this. */
export const PLAUSIBLE_MEDIAN_MS = 60_000;

const R = 6_371_000;
const rad = Math.PI / 180;

/** A device's position at `t` (linear between fixes, clamped at the ends); null with no fixes. */
export function seriesAt(s: MarkSeries | undefined, t: number): LatLon | null {
  if (!s || !s.t.length) return null;
  const n = s.t.length;
  if (t <= s.t[0]) return { lat: s.lat[0], lon: s.lon[0] };
  if (t >= s.t[n - 1]) return { lat: s.lat[n - 1], lon: s.lon[n - 1] };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (s.t[m] <= t) lo = m;
    else hi = m;
  }
  const f = (t - s.t[lo]) / Math.max(1, s.t[hi] - s.t[lo]);
  return { lat: s.lat[lo] + f * (s.lat[hi] - s.lat[lo]), lon: s.lon[lo] + f * (s.lon[hi] - s.lon[lo]) };
}

/** The line at time t from its two devices; null if either has no fixes. */
export const lineFrom = (left: MarkSeries | undefined, right: MarkSeries | undefined) =>
  (t: number): Line | null => {
    const l = seriesAt(left, t);
    const r = seriesAt(right, t);
    return l && r ? { left: l, right: r } : null;
  };

const xy = (p: LatLon, o: LatLon): [number, number] => [(p.lon - o.lon) * rad * R * Math.cos(o.lat * rad), (p.lat - o.lat) * rad * R];

/** Local east/north metres of `p` from `o`. */
export const metresFrom = xy;

/** Bearing from `a` to `b`, degrees true (0..360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const [x, y] = xy(b, a);
  return ((Math.atan2(x, y) / rad) % 360 + 360) % 360;
}

/** The point `m` metres from `p` on bearing `deg`. */
export function destination(p: LatLon, deg: number, m: number): LatLon {
  return { lat: p.lat + (m * Math.cos(deg * rad)) / (R * rad), lon: p.lon + (m * Math.sin(deg * rad)) / (R * rad * Math.cos(p.lat * rad)) };
}

/** How far `p` is from `o` along bearing `deg`, m (negative behind). */
export function alongDeg(p: LatLon, o: LatLon, deg: number): number {
  const [x, y] = xy(p, o);
  return x * Math.sin(deg * rad) + y * Math.cos(deg * rad);
}

const lineMid = (l: Line): LatLon => ({ lat: (l.left.lat + l.right.lat) / 2, lon: (l.left.lon + l.right.lon) / 2 });

/** Times (ms) where the track crosses the line segment (ends extended by 2%) within [t0, t1]. */
export function crossings(fixes: readonly Fix[], lineAt: (t: number) => Line | null, t0: number, t1: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1];
    const b = fixes[i];
    if (b.ts < t0 || a.ts > t1 || b.ts - a.ts > CROSS_MAX_GAP_MS || b.ts <= a.ts) continue;
    const line = lineAt((a.ts + b.ts) / 2);
    if (!line) continue;
    const o = line.left;
    const P = xy(a, o);
    const Q = xy(b, o);
    const B = xy(line.right, o);
    const d1 = [Q[0] - P[0], Q[1] - P[1]];
    const den = d1[0] * B[1] - d1[1] * B[0];
    if (Math.abs(den) < 1e-9) continue;
    const w = [-P[0], -P[1]];
    const u = (w[0] * B[1] - w[1] * B[0]) / den;
    const v = (w[0] * d1[1] - w[1] * d1[0]) / den;
    if (u < 0 || u > 1 || v < -0.02 || v > 1.02) continue;
    const t = a.ts + u * (b.ts - a.ts);
    if (t >= t0 && t <= t1) out.push(t);
  }
  return out;
}

/** The feed race number this race's boats carry: the commonest among `in_progress` rows in the 10 min after the gun. */
export function feedRaceNumber(boats: Iterable<readonly Fix[]>, gunMs: number): number | null {
  const c = new Map<number, number>();
  for (const fixes of boats) {
    for (const f of fixes) {
      if (f.ts < gunMs || f.ts > gunMs + 10 * 60_000 || f.stage !== 'in_progress' || f.rn == null) continue;
      c.set(f.rn, (c.get(f.rn) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let n = 0;
  for (const [k, v] of c) if (v > n) [best, n] = [k, v];
  return best;
}

/** A device's first finishing/finished row of this race after the gun, ms; null if none. */
export function stageOnset(fixes: readonly Fix[], gunMs: number, feedRn: number | null): number | null {
  const f = fixes.find((x) => x.ts >= gunMs && (x.stage === 'finishing' || x.stage === 'finished') && (feedRn == null || x.rn == null || x.rn === feedRn));
  return f ? f.ts : null;
}

/** Fewer boats than this with an onset and there is no fleet floor. */
export const FLEET_ONSET_MIN = 5;

/**
 * The fleet's finishing onset: its 20th-percentile device onset, less STAGE_SLACK_MS. The stage
 * mostly arrives fleet-wide within a minute; a few devices flip early (Cascais race 7: six at
 * 12:49–12:57Z against the fleet's 13:07Z), and their first crossing then is a lap, not the finish.
 */
export function fleetOnsetFloor(boats: Iterable<readonly Fix[]>, gunMs: number, feedRn: number | null): number | null {
  const on: number[] = [];
  for (const fx of boats) {
    const t = stageOnset(fx, gunMs, feedRn);
    if (t != null) on.push(t);
  }
  if (on.length < FLEET_ONSET_MIN) return null;
  on.sort((a, b) => a - b);
  return on[Math.floor(on.length * 0.2)] - STAGE_SLACK_MS;
}

/**
 * The course axis toward the far end, degrees true: the start's wind direction (the wind blows from up
 * the course) when set, else square to the start line on the side the fleet is a minute after the gun.
 */
export function courseAxisDeg(start: Line, windDeg: number | null | undefined, boats: Iterable<readonly Fix[]>, gunMs: number): number {
  if (windDeg != null && Number.isFinite(windDeg)) return ((windDeg % 360) + 360) % 360;
  const up = (bearingDeg(start.left, start.right) + 270) % 360;
  const mid = lineMid(start);
  const sides: number[] = [];
  for (const fx of boats) {
    const f = fx.find((x) => x.ts >= gunMs + 60_000);
    if (f) sides.push(alongDeg(f, mid, up));
  }
  return sides.length && median(sides) < 0 ? (up + 180) % 360 : up;
}

/** The boat's furthest distance up the axis from the line's middle over `race`, m. */
export function axisReach(race: readonly Fix[], line: Line, axisDeg: number): number {
  const mid = lineMid(line);
  let far = -Infinity;
  for (const f of race) far = Math.max(far, alongDeg(f, mid, axisDeg));
  return far;
}

/** One boat's tracker finish (see the file comment), or null when its track doesn't cross the line in the window; `floorMs` is fleetOnsetFloor(), `axisDeg` courseAxisDeg(). */
export function trackerFinish(
  fixes: readonly Fix[],
  lineAt: (t: number) => Line | null,
  gunMs: number,
  endMs: number,
  feedRn: number | null,
  floorMs: number | null = null,
  axisDeg: number | null = null,
): number | null {
  // Crossings are only looked for after the onset or the far end (the first one after it is the finish).
  const from = gunMs + FINISH_MIN_AFTER_GUN_MS;
  const onset = stageOnset(fixes, gunMs, feedRn);
  if (onset != null) {
    const after = Math.max(onset - STAGE_SLACK_MS, floorMs ?? -Infinity);
    return crossings(fixes, lineAt, Math.max(from, after), endMs)[0] ?? null;
  }
  // No stage: after the boat's last visit to the far end, up the course axis.
  const line0 = lineAt(gunMs);
  if (!line0) return null;
  const race = fixes.filter((f) => f.ts >= gunMs && f.ts <= endMs);
  if (!race.length) return null;
  const axis = axisDeg ?? courseAxisDeg(line0, null, [race], gunMs);
  const far = axisReach(race, line0, axis);
  if (far < FAR_MIN_M) return null;
  const mid = lineMid(line0);
  let lastFar = gunMs;
  for (const f of race) if (alongDeg(f, mid, axis) >= FAR_FRAC * far) lastFar = f.ts;
  return crossings(fixes, lineAt, Math.max(from, lastFar), endMs).find((t) => t > lastFar) ?? null;
}

/**
 * Not in the race: in a race whose entries RaceSense doesn't confirm with finishes (a rebuilt race,
 * a zero-finisher one), a tracker that stays further than this from the start line's middle from
 * 5 min before the gun to 10 min after and never finishes is elsewhere (Cascais official race 4:
 * three boats scored DNC, 4.9 km away at the gun).
 */
export const NEAR_START_M = 1000;
export const NEAR_START_BEFORE_MS = 5 * 60_000;
export const NEAR_START_AFTER_MS = 10 * 60_000;

/** The boat's closest approach to `mid` around the gun (m), or null with no fix then (unknown: never excluded). */
export function closestToStart(fixes: readonly Fix[], mid: LatLon, gunMs: number): number | null {
  let best: number | null = null;
  for (const f of fixes) {
    if (f.ts < gunMs - NEAR_START_BEFORE_MS || f.ts > gunMs + NEAR_START_AFTER_MS) continue;
    const d = Math.hypot(...xy(f, mid));
    if (best == null || d < best) best = d;
  }
  return best;
}

/** Why the boat wasn't in the race, or null (see NEAR_START_M); a boat with a finish is always in it. */
export function awayFromStart(fixes: readonly Fix[], mid: LatLon, gunMs: number, finished: boolean): string | null {
  if (finished) return null;
  const d = closestToStart(fixes, mid, gunMs);
  return d != null && d > NEAR_START_M ? `Not near the start (closest ${(d / 1000).toFixed(1)} km) and no finish` : null;
}

export interface Plausibility {
  ok: boolean;
  /** Boats compared (official finish and a crossing near it). */
  n: number;
  /** Median |official − crossing|, s (null with no pairs). */
  medianS: number | null;
  /** Why not, in a few words. */
  why?: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Official times against the tracks: `pairs` are each finisher's official UTC time and its
 * crossings (any, the nearest within PLAUSIBLE_SEARCH_MS counts).
 */
export function officialTimesPlausible(pairs: readonly { officialMs: number; crossings: readonly number[] }[], gunMs: number, nextGunMs: number | null, allOfficialMs: readonly number[]): Plausibility {
  const gaps: number[] = [];
  for (const p of pairs) {
    const near = p.crossings.filter((t) => Math.abs(t - p.officialMs) <= PLAUSIBLE_SEARCH_MS);
    if (!near.length) continue;
    gaps.push(Math.min(...near.map((t) => Math.abs(t - p.officialMs))));
  }
  const medianS = gaps.length ? Math.round(median(gaps) / 100) / 10 : null;
  const outside = allOfficialMs.filter((t) => !(t > gunMs) || (nextGunMs != null && t >= nextGunMs));
  if (outside.length) return { ok: false, n: gaps.length, medianS, why: `${outside.length} official finish${outside.length > 1 ? 'es' : ''} outside the gun-to-next-gun window` };
  if (gaps.length < PLAUSIBLE_MIN_BOATS) return { ok: false, n: gaps.length, medianS, why: 'too few tracked finishes to check them' };
  if (median(gaps) > PLAUSIBLE_MEDIAN_MS) return { ok: false, n: gaps.length, medianS, why: `a median ${Math.round(median(gaps) / 1000)} s off the tracks` };
  return { ok: true, n: gaps.length, medianS };
}
