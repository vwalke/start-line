/**
 * A finish line placed from the tracks, for a course whose feed has none: no finish-line trackers, no
 * RaceSense finish line and no mark trackers. At the 2026 Fall Brawl (Annapolis) the course has only the
 * start line's two trackers, and the boats finish off the committee boat on the side away from the pin, so
 * the old start line (the usual fallback, as at AYC) only catches boats sailing home across it.
 *
 * The line runs from the committee boat (the start line's right-end tracker, where it was at the time) on a
 * bearing within EST_SPAN_DEG of the start line's own pin → committee bearing. With official finish times
 * the bearing is the one that best matches them; without, the one the most boats cross (ties go to the
 * start line's bearing). Its length is the furthest crossing out plus EST_MARGIN_M. Crossings are timed at
 * the bow, as official times are: from the antenna they come 1–3 s late, and the fit would tilt the line
 * to make up for it (Fall Brawl: with the bow, the start line's bearing is within 1 s of the official times).
 */
import {
  alongDeg,
  axisReach,
  bearingDeg,
  closestToStart,
  crossings,
  destination,
  FAR_FRAC,
  FAR_MIN_M,
  NEAR_START_M,
  PLAUSIBLE_MEDIAN_MS,
  PLAUSIBLE_MIN_BOATS,
  PLAUSIBLE_SEARCH_MS,
  seriesAt,
  type Fix,
  type MarkSeries,
} from './finishes';
import type { LatLon, Line } from './types';

/** The bearing is fitted within this of the start line's (degrees), in 1° steps. */
export const EST_SPAN_DEG = 25;
/** The line's length while its bearing is fitted to crossings, m (the first guess). */
export const EST_START_M = 150;
/** …and while it is fitted to official times, m (the times say which crossing is the finish). */
export const EST_SEARCH_M = 300;
/** The fitted length: the furthest crossing out plus a margin, within these, m. */
export const EST_MARGIN_M = 20;
export const EST_MIN_M = 30;
export const EST_MAX_M = 300;
/**
 * Finishers that must cross a line for it to count: the start line's when it stands in for the finish
 * (else a line is estimated), and the estimated one's (else the race keeps the start line's).
 */
export const EST_MIN_SHARE = 0.6;
/** Fixes further apart than this give no course over ground for the bow, ms. */
const BOW_MAX_GAP_MS = 30_000;

export interface FinishEstimate {
  /** From the committee boat, degrees true. */
  bearingDeg: number;
  lengthM: number;
  /** What the bearing was fitted to. */
  by: 'official' | 'crossings';
  /** The line at time t: left the committee boat where it was then, right the estimated far end. */
  lineAt: (t: number) => Line;
}

/** The line at time t: from the committee boat where it was then, `lengthM` on bearing `deg` (destination(), its trig done once). */
export function rayLine(boatAt: (t: number) => LatLon, deg: number, lengthM: number): (t: number) => Line {
  const far = destination({ lat: 0, lon: 0 }, deg, lengthM);
  return (t) => {
    const c = boatAt(t);
    return { left: c, right: { lat: c.lat + far.lat, lon: c.lon + far.lon / Math.cos((c.lat * Math.PI) / 180) } };
  };
}

/** The committee boat at t: its tracker, else the start line's right end. */
export const committeeAt =
  (s: MarkSeries | null, fixed: LatLon) =>
  (t: number): LatLon =>
    seriesAt(s ?? undefined, t) ?? fixed;

/** The fixes moved forward `bowM` along the course over ground (from the fixes either side), as the bow sailed. */
export function bowFixes(fixes: readonly Fix[], bowM: number): Fix[] {
  if (!(bowM > 0)) return [...fixes];
  return fixes.map((f, i) => {
    const a = fixes[Math.max(0, i - 1)];
    const b = fixes[Math.min(fixes.length - 1, i + 1)];
    if (b.ts - a.ts > BOW_MAX_GAP_MS || Math.hypot(b.lat - a.lat, b.lon - a.lon) < 1e-6) return { ...f };
    return { ...f, ...destination(f, bearingDeg(a, b), bowM) };
  });
}

/** A track's position at t, linear between fixes; null outside them. */
function positionAt(fixes: readonly Fix[], t: number): LatLon | null {
  const n = fixes.length;
  if (!n || t < fixes[0].ts || t > fixes[n - 1].ts) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (fixes[m].ts <= t) lo = m;
    else hi = m;
  }
  const a = fixes[lo];
  const b = fixes[hi];
  const f = (t - a.ts) / Math.max(1, b.ts - a.ts);
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon) };
}

/** Bearing offsets to try, nearest the start line's first (so ties go to it). */
const OFFSETS = [0, ...Array.from({ length: EST_SPAN_DEG }, (_, i) => [i + 1, -(i + 1)]).flat()];

const clampLength = (alongs: number[]): number => Math.min(EST_MAX_M, Math.max(EST_MIN_M, Math.max(...alongs) + EST_MARGIN_M));

/** How far out along the line a boat crossed at t, m. */
const alongAt = (fixes: readonly Fix[], t: number, boatAt: (t: number) => LatLon, deg: number): number => {
  const p = positionAt(fixes, t);
  return p ? alongDeg(p, boatAt(t), deg) : 0;
};

/**
 * The bearing that best matches the official finish times: each finisher's crossing nearest its official
 * time costs the gap, at most PLAUSIBLE_MEDIAN_MS (no crossing near it costs that too). Null with fewer
 * than PLAUSIBLE_MIN_BOATS times or no crossing near any.
 */
export function fitToOfficial(boats: readonly { fixes: readonly Fix[]; officialMs: number }[], boatAt: (t: number) => LatLon, baseDeg: number): FinishEstimate | null {
  if (boats.length < PLAUSIBLE_MIN_BOATS) return null;
  let best: { deg: number; cost: number; alongs: number[] } | null = null;
  for (const d of OFFSETS) {
    const deg = (baseDeg + d + 360) % 360;
    const la = rayLine(boatAt, deg, EST_SEARCH_M);
    let cost = 0;
    const alongs: number[] = [];
    for (const b of boats) {
      const xs = crossings(b.fixes, la, b.officialMs - PLAUSIBLE_SEARCH_MS, b.officialMs + PLAUSIBLE_SEARCH_MS);
      const near = xs.length ? xs.reduce((x, y) => (Math.abs(y - b.officialMs) < Math.abs(x - b.officialMs) ? y : x)) : null;
      const gap = near == null ? Infinity : Math.abs(near - b.officialMs);
      cost += Math.min(gap, PLAUSIBLE_MEDIAN_MS);
      if (near != null && gap <= PLAUSIBLE_MEDIAN_MS) alongs.push(alongAt(b.fixes, near, boatAt, deg));
    }
    if (alongs.length && (!best || cost < best.cost)) best = { deg, cost, alongs };
  }
  if (!best) return null;
  const lengthM = clampLength(best.alongs);
  return { bearingDeg: best.deg, lengthM, by: 'official', lineAt: rayLine(boatAt, best.deg, lengthM) };
}

/** The bearing the most boats finish across (`finishOf`: a boat's finish on a line), ties to the start line's; null when none does. */
export function fitToCrossings(
  boats: readonly (readonly Fix[])[],
  boatAt: (t: number) => LatLon,
  baseDeg: number,
  finishOf: (fixes: readonly Fix[], lineAt: (t: number) => Line) => number | null,
): FinishEstimate | null {
  let best: { deg: number; alongs: number[] } | null = null;
  for (const d of OFFSETS) {
    const deg = (baseDeg + d + 360) % 360;
    const la = rayLine(boatAt, deg, EST_START_M);
    const alongs: number[] = [];
    for (const fx of boats) {
      const t = finishOf(fx, la);
      if (t != null) alongs.push(alongAt(fx, t, boatAt, deg));
    }
    if (alongs.length && (!best || alongs.length > best.alongs.length)) best = { deg, alongs };
  }
  if (!best) return null;
  const lengthM = clampLength(best.alongs);
  return { bearingDeg: best.deg, lengthM, by: 'crossings', lineAt: rayLine(boatAt, best.deg, lengthM) };
}

/**
 * Without official results, the finishers: boats that got to the far end, FAR_FRAC of the fleet's median
 * reach up the course axis (and FAR_MIN_M), leaving out trackers that were nowhere near the start.
 */
export function farEndBoats(fixes: ReadonlyMap<string, readonly Fix[]>, start: Line, axisDeg: number, gunMs: number, endMs: number): Set<string> {
  const mid = { lat: (start.left.lat + start.right.lat) / 2, lon: (start.left.lon + start.right.lon) / 2 };
  const reach = new Map<string, number>();
  for (const [id, fx] of fixes) {
    const near = closestToStart(fx, mid, gunMs);
    if (near != null && near > NEAR_START_M) continue;
    const race = fx.filter((f) => f.ts >= gunMs && f.ts <= endMs);
    if (race.length) reach.set(id, axisReach(race, start, axisDeg));
  }
  const rs = [...reach.values()].sort((a, b) => a - b);
  if (!rs.length) return new Set();
  const m = rs.length >> 1;
  const med = rs.length % 2 ? rs[m] : (rs[m - 1] + rs[m]) / 2;
  const min = Math.max(FAR_MIN_M, FAR_FRAC * med);
  return new Set([...reach].filter(([, r]) => r >= min).map(([id]) => id));
}

export interface EstimateInput {
  /** Every boat: its bow fixes (bowFixes) and its official UTC finish time, if it has one. */
  boats: readonly { id: string; fixes: readonly Fix[]; officialMs: number | null }[];
  /** Who finished: the official finishers, else farEndBoats(). */
  finishers: ReadonlySet<string>;
  boatAt: (t: number) => LatLon;
  /** The start line's pin → committee bearing. */
  baseDeg: number;
  /** A boat's finish on a line (data/finishes.ts trackerFinish). */
  finishOf: (fixes: readonly Fix[], lineAt: (t: number) => Line) => number | null;
}

/** The estimated line and every boat's finish on it, or null when fewer than EST_MIN_SHARE of the finishers cross it. */
export function estimateFinish(inp: EstimateInput): { fit: FinishEstimate; finishes: Map<string, number> } | null {
  if (!inp.finishers.size) return null;
  const fin = inp.boats.filter((b) => inp.finishers.has(b.id));
  const timed = fin.filter((b): b is typeof b & { officialMs: number } => b.officialMs != null);
  const fit =
    fitToOfficial(timed, inp.boatAt, inp.baseDeg) ??
    fitToCrossings(
      fin.map((b) => b.fixes),
      inp.boatAt,
      inp.baseDeg,
      inp.finishOf,
    );
  if (!fit) return null;
  const finishes = new Map<string, number>();
  for (const b of inp.boats) {
    const t = inp.finishOf(b.fixes, fit.lineAt);
    if (t != null) finishes.set(b.id, t);
  }
  const crossed = fin.filter((b) => finishes.has(b.id)).length;
  return crossed >= EST_MIN_SHARE * inp.finishers.size ? { fit, finishes } : null;
}
