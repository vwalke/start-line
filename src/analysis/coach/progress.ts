/**
 * Fleet places at any moment (D9's low-resolution fallback): every racing boat ranked by its distance to
 * go along the course (ladder.ts distToGo: the wind ladder to its leg's mark plus the legs after), out of
 * the same FIXED fleet the leg table uses (legStory.ts fleetPlaces). Sparse tracks are interpolated:
 *
 * - a boat with fixes at most PROG_SPAN_S apart around the moment, one within PROG_NEAR_S, and a known
 *   leg: its position (measured);
 * - otherwise its distance to go between its rounding times (known, or fleetPlaces' estimates: the fleet's
 *   median splits, or carried on at its own pace), linearly in time (estimated);
 * - a finished boat is ahead of every boat still racing, the earlier finisher first.
 * - DNS/DNC/DNE and tracked boats official results don't list are left out; a DNF/RET is not
 *   carried past its last known mark (so a retired boat cannot pass anyone still racing).
 */
import type { RaceAnalysis } from '../types';
import type { CoachModel } from './index';
import { extraTracked, neverRaced } from './fleet';
import { distToGo, legLengths } from './ladder';
import { fleetPlaces, type FleetPlaces } from './legStory';
import { posAt, trackLegAt } from './tracks';

/** Positions are read across gaps up to this long (the feed's 0.25 Hz with short holes)… */
export const PROG_SPAN_S = 60;
/** …with a real fix this close. */
export const PROG_NEAR_S = 30;

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

/** One boat's distance to go at `t`, and whether it is from a position (false) or the interpolated roundings (true); null with neither. */
export function dtgAt(a: Pick<RaceAnalysis, 'boats' | 'meta'>, m: CoachModel, base: ProgressBase, id: string, t: number): { dtg: number; est: boolean } | null {
  const b = a.boats.find((x) => x.id === id);
  if (!b || neverRaced(b.finishCode)) return null;
  if (b.finishMs != null && t >= b.finishMs) return { dtg: -(t - b.finishMs) / 1000, est: false };
  const tr = m.tracks.get(id);
  if (tr) {
    const p = posAt(tr, t, PROG_SPAN_S, PROG_NEAR_S);
    const leg = trackLegAt(tr, t);
    if (p && leg != null) return { dtg: distToGo(m.course, leg, p, m.wind.twdAt(t), m.wind.taAt(t)), est: false };
  }
  const row = base.fp.byId.get(id);
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

/** Every racing boat's place at `t` by distance to go, out of the fixed fleet. DNS/DNC and official extras are left out. */
export function progressAt(a: Pick<RaceAnalysis, 'boats' | 'meta'>, m: CoachModel, base: ProgressBase, t: number): ProgressPlaces {
  const extra = extraTracked(a);
  const reads = a.boats
    .filter((b) => !extra.has(b.sail) && !extra.has(b.id) && !neverRaced(b.finishCode))
    .map((b, i) => ({ id: b.id, i, r: dtgAt(a, m, base, b.id, t) }))
    .filter((x): x is { id: string; i: number; r: { dtg: number; est: boolean } } => x.r != null);
  reads.sort((p, q) => (p.r.dtg < q.r.dtg ? -1 : p.r.dtg > q.r.dtg ? 1 : p.i - q.i));
  const byId = new Map<string, ProgressRead>();
  reads.forEach((x, k) => byId.set(x.id, { place: k + 1, dtg: x.r.dtg, est: x.r.est }));
  return { of: base.fp.of, byId };
}
