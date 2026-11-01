/**
 * Fleet places at any moment (D9's low-resolution fallback, and the map tooltip's place): every racing boat ranked by
 * its distance to go along the course, out of the same FIXED fleet the leg table uses (legStory.ts fleetPlaces).
 * Sparse tracks are interpolated:
 *
 * - a boat with a position then (fixes at most PROG_SPAN_S apart around the moment, one within PROG_NEAR_S) and a
 *   known leg: the course's length less its course progress up the ladder at that moment (ladderNow.ts, on the wind
 *   then: the very reads the replay's ladder rungs draw, so the rungs' leader is the first measured place here);
 * - otherwise its distance to go between its rounding times (known, or fleetPlaces' estimates: the fleet's
 *   median splits, or carried on at its own pace), linearly in time (estimated);
 * - a finished boat is ahead of every boat still racing, the earlier finisher first.
 * - DNS/DNC/DNE and tracked boats official results don't list are left out; a DNF/RET is not
 *   carried past its last known mark (so a retired boat cannot pass anyone still racing).
 */
import type { RaceAnalysis } from '../types';
import type { CoachModel } from './index';
import { legLengths } from './ladder';
import { ladderReader, type LadderNow, type LadderRead, type LadderReader } from './ladderNow';
import { fleetPlaces, type FleetPlaces } from './legStory';

export { PROG_NEAR_S, PROG_SPAN_S } from './ladderNow';

export interface ProgressRead {
  place: number;
  /** Distance to go, m (negative after the finish: −seconds since finishing, so earlier finishers rank first). */
  dtg: number;
  /** From the interpolated roundings, not a position. */
  est: boolean;
}

export interface ProgressPlaces {
  /** The fixed fleet the places are out of. */
  of: number;
  byId: Map<string, ProgressRead>;
}

/** What progressAt needs once per race: the fixed-fleet places (their elapsed times) and the course's remaining lengths. */
export interface ProgressBase {
  fp: FleetPlaces;
  /** Distance to go at each place column (start, each mark, finish), m. */
  colDtg: number[];
}

export function progressBase(a: Pick<RaceAnalysis, 'legs' | 'boats' | 'meta'>, m: Pick<CoachModel, 'course'>): ProgressBase {
  const lens = legLengths(m.course);
  const colDtg = lens.map((_, c) => lens.slice(c).reduce((s, x) => s + x, 0)).concat(0);
  return { fp: fleetPlaces(a), colDtg };
}

/** A read's distance to go at `now.t` (above), and whether it is from the interpolated roundings; null with neither. */
function readDtg(a: Pick<RaceAnalysis, 'meta'>, base: ProgressBase, now: LadderNow, r: LadderRead): { dtg: number; est: boolean } | null {
  const t = now.t;
  if (r.done) return { dtg: -(t - r.finishMs!) / 1000, est: false };
  if (!r.est) return { dtg: now.total - r.prog, est: false };
  const row = base.fp.byId.get(r.id);
  if (!row) return null;
  // Only as far as the last *known* column: a DNF/RET carried on at its own pace would otherwise
  // keep sailing the course and pass boats that are still racing.
  let lastKnown = -1;
  for (let c = 0; c < row.elapsedS.length; c++) if (row.elapsedS[c] != null && !row.est[c]) lastKnown = c;
  if (lastKnown < 0) return null;
  const s = (t - a.meta.gunMs) / 1000;
  const pts: { e: number; d: number }[] = [];
  for (let c = 0; c <= lastKnown; c++) {
    const e = row.elapsedS[c];
    if (e != null) pts.push({ e, d: base.colDtg[c] });
  }
  if (!pts.length) return null;
  if (s <= pts[0].e) return { dtg: pts[0].d, est: true };
  for (let i = 1; i < pts.length; i++) {
    if (s <= pts[i].e) {
      const f = pts[i].e > pts[i - 1].e ? (s - pts[i - 1].e) / (pts[i].e - pts[i - 1].e) : 1;
      return { dtg: pts[i - 1].d + f * (pts[i].d - pts[i - 1].d), est: true };
    }
  }
  return null;
}

/** One racing boat's distance to go at `t` (above), and whether it is from the interpolated roundings; null with neither, or for a boat left out. */
export function dtgAt(a: Pick<RaceAnalysis, 'boats' | 'meta'>, m: CoachModel, base: ProgressBase, id: string, t: number): { dtg: number; est: boolean } | null {
  const now = ladderReader(a, m)(t);
  const r = now.reads.find((x) => x.id === id);
  return r ? readDtg(a, base, now, r) : null;
}

/**
 * Every racing boat's place at `t` by distance to go, out of the fixed fleet. DNS/DNC and official extras are left out.
 * `read`: the ladder read from (default the model's own; gainLoss.ts passes one of its own, ladderNow.ts newLadderReader).
 */
export function progressAt(a: Pick<RaceAnalysis, 'boats' | 'meta'>, m: CoachModel, base: ProgressBase, t: number, read: LadderReader = ladderReader(a, m)): ProgressPlaces {
  const now = read(t);
  const rows: { id: string; i: number; done: boolean; r: { dtg: number; est: boolean } }[] = [];
  now.reads.forEach((x, i) => {
    const r = readDtg(a, base, now, x);
    if (r) rows.push({ id: x.id, i, done: x.done, r });
  });
  // Finished first (the earliest finisher: the most negative), then by distance to go; a tie keeps the fleet's order (ladderNow.ts leaderOf).
  rows.sort((p, q) => (p.done !== q.done ? (p.done ? -1 : 1) : p.r.dtg < q.r.dtg ? -1 : p.r.dtg > q.r.dtg ? 1 : p.i - q.i));
  const byId = new Map<string, ProgressRead>();
  rows.forEach((x, k) => byId.set(x.id, { place: k + 1, dtg: x.r.dtg, est: x.r.est }));
  return { of: base.fp.of, byId };
}
