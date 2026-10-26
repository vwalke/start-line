/**
 * Speed through the start: each racing boat's smoothed SOG (analysis/smooth.ts,
 * the same 4 s mean the speed-coloured tracks use) against seconds from the
 * gun, split into segments wherever consecutive fixes are more than
 * SOG_GAP_MS apart. Nothing is drawn across a gap: the chart joins the ends
 * with a dashed grey line, and a time inside a gap has no speed.
 *
 * The marker is where the boat crossed the line: the start table's seconds
 * late (our DTL ÷ speed toward the line), at the smoothed SOG then.
 */
import { SOG_GAP_MS } from './smooth';
import { START_SOG_POST_MS, START_SOG_PRE_MS, type RaceAnalysis } from './types';

/** The pre-gun windows on offer, s. */
export const START_SOG_WINDOWS = [30, 60, 120] as const;
export type StartSogWindow = (typeof START_SOG_WINDOWS)[number];
/** Post-gun span, s. */
export const START_SOG_POST_S = START_SOG_POST_MS / 1000;

/**
 * The axis tops out at the fastest speed in the window, leaving out boats far
 * over the fleet: one bad tracker (C31 race 4's GER 8, at 19–41 kn far off the
 * course) stretched it to 40 kn against the fleet's 8. A boat is left out when
 * its own START_SOG_HI_PCT speed is more than START_SOG_BOAT_OVER_KN above the
 * median boat's (with at least START_SOG_FLEET_MIN boats); its faster fixes are
 * drawn clipped at the top edge. Every other boat's speeds are on the axis.
 */
export const START_SOG_HI_PCT = 0.99;
export const START_SOG_BOAT_OVER_KN = 6;
export const START_SOG_FLEET_MIN = 3;

/** The `p` quantile (0–1) of `xs`, sorted ascending (nearest rank). */
const quantile = (xs: number[], p: number): number => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))];

/** The axis top: the fastest speed of the boats not far over the fleet (START_SOG_BOAT_OVER_KN). null with no speeds. */
export function startSogHi(perBoat: number[][]): number | null {
  const sorted = perBoat.filter((v) => v.length).map((v) => [...v].sort((a, b) => a - b));
  if (!sorted.length) return null;
  const tops = sorted.map((v) => quantile(v, START_SOG_HI_PCT));
  const med = [...tops].sort((a, b) => a - b)[tops.length >> 1];
  const setters = tops.length >= START_SOG_FLEET_MIN ? sorted.filter((_, i) => tops[i] <= med + START_SOG_BOAT_OVER_KN) : sorted;
  return Math.max(...setters.map((v) => v[v.length - 1]));
}

/** One unbroken run of fixes: seconds from the gun and SOG, kn. */
export interface SogRun {
  t: number[];
  sog: number[];
}

export interface StartSogBoat {
  id: string;
  /** Runs split at telemetry gaps; never one spanning a gap. */
  runs: SogRun[];
  /** Each gap between runs: [t, sog] at both ends (drawn dashed grey). */
  gaps: [[number, number], [number, number]][];
  /** Crossing the line: seconds from the gun (the start table's late) and the SOG then; null when unknown, in a gap or outside the window. */
  cross: { tS: number; sogKn: number } | null;
}

export interface StartSogSeries {
  /** The window drawn, s from the gun: from −pre (or later, when no boat's data goes back that far) to +post. */
  t0: number;
  t1: number;
  /** The window asked for started earlier than any boat's data. */
  clamped: boolean;
  boats: StartSogBoat[];
  /** SOG range of the drawn data, kn (null with none): the lowest speed, and the top (startSogHi): the fastest speed but for boats far over the fleet, whose faster fixes are clipped. */
  lo: number | null;
  hi: number | null;
}

/** Speed at `tS` (s from the gun) on one boat: the nearest fix of the run holding it; null inside a gap or off the data. */
export function sogAt(b: Pick<StartSogBoat, 'runs'>, tS: number): number | null {
  const slack = SOG_GAP_MS / 2000;
  for (const r of b.runs) {
    const n = r.t.length;
    // A lone fix (or a run's ends) holds for half a gap at most.
    if (tS < r.t[0] - (n > 1 ? 0.5 : slack) || tS > r.t[n - 1] + (n > 1 ? 0.5 : slack)) continue;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(r.t[i] - tS) < Math.abs(r.t[best] - tS)) best = i;
    return r.sog[best];
  }
  return null;
}

/** The racing boats' SOG from `preSec` before the gun to `postSec` after (both ≤ what the analysis keeps). */
export function startSogSeries(a: RaceAnalysis, preSec: number, postSec = START_SOG_POST_S): StartSogSeries {
  const pre = Math.min(preSec, START_SOG_PRE_MS / 1000);
  const post = Math.min(postSec, START_SOG_POST_MS / 1000);
  const gun = a.meta.gunMs;
  const gapS = SOG_GAP_MS / 1000;
  const late = new Map(a.boats.map((b) => [b.id, b.start?.lateS ?? null]));
  let first = Infinity;
  // The raw low: speeds can't go under 0, so a bad fix can't stretch the bottom far, and a boat stopped at the line is the chart's point.
  let lo = Infinity;
  const speeds: number[][] = [];
  const boats: StartSogBoat[] = [];
  // `drawings` are the racing boats only (Not racing ones are in `excluded`).
  for (const d of a.drawings) {
    const { t, sog } = d.startSog;
    const runs: SogRun[] = [];
    let cur: SogRun | null = null;
    let prevT = -Infinity;
    const mine: number[] = [];
    speeds.push(mine);
    for (let i = 0; i < t.length; i++) {
      const s = (t[i] - gun) / 1000;
      if (s < -pre || s > post || !Number.isFinite(sog[i])) continue;
      if (!cur || s - prevT > gapS) runs.push((cur = { t: [], sog: [] }));
      cur.t.push(s);
      cur.sog.push(sog[i]);
      prevT = s;
      first = Math.min(first, s);
      lo = Math.min(lo, sog[i]);
      mine.push(sog[i]);
    }
    const gaps = runs.slice(1).map((r, k): [[number, number], [number, number]] => {
      const p = runs[k];
      return [
        [p.t[p.t.length - 1], p.sog[p.sog.length - 1]],
        [r.t[0], r.sog[0]],
      ];
    });
    const lateS = late.get(d.id);
    const sAt = lateS != null && lateS >= -pre && lateS <= post ? sogAt({ runs }, lateS) : null;
    boats.push({ id: d.id, runs, gaps, cross: lateS != null && sAt != null ? { tS: lateS, sogKn: sAt } : null });
  }
  // Clamp the start to the earliest data when nobody's track goes back as far as asked (1 s slack for the first fix).
  const clamped = Number.isFinite(first) && first > -pre + 1;
  return {
    t0: clamped ? Math.floor(first) : -pre,
    t1: post,
    clamped,
    boats,
    lo: Number.isFinite(lo) ? lo : null,
    hi: startSogHi(speeds),
  };
}
