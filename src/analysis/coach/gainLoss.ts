/**
 * Places gained or lost on each leg, for the Race Viewer's "Color: Gain/loss" (ui/gain.ts): a boat's place entering
 * the leg less its place at the leg's end (+ = gained), one number for the whole leg.
 *
 * - Places at the start, each mark and the finish are the bump chart's (analysis/places.ts placeChanges): leg 1 is
 *   entered at the start table's place among the clean starters at the gun; every later leg at the boat's place in
 *   the order the fleet rounded the mark before it; the last leg ends at the finish order.
 * - Where the bump chart has no place for a boat there (no start place, no rounding time at the mark), its place on
 *   the ladder (coach/progress.ts progressAt, the tooltip's place): entering, at its first fix on the leg (from the
 *   gun on); at the end, at its last fix on the leg.
 * - The leg a boat is on at the map's time `now` (its rounding or finish still to come): its place on the ladder at
 *   `now`, the change so far; a boat that stopped short of the leg's end (retired) at its last fix on the leg.
 * - Before the gun, a leg not yet started at `now`, or no place at one end: null (ui/gain.ts draws it gray).
 *
 * Worked out once per model (legPlaces, cached); a leg's value (legGainAt) is a map lookup and a subtraction, the
 * ladder read at most once per `now` for the whole fleet.
 */
import { placeChanges, roundingMs } from '../places';
import { PRE_LEG, type RaceAnalysis } from '../types';
import type { CoachModel } from './index';
import { newLadderReader, type LadderReader } from './ladderNow';
import { progressAt, progressBase, type ProgressBase, type ProgressPlaces } from './progress';

/** One boat's legs: places entering and at the end (null: from the ladder, read when first asked), when each ends, its first and last fix on each. */
interface BoatLegs {
  entry: (number | null)[];
  exit: (number | null)[];
  /** The rounding (or the finish) ending each leg, ms; Infinity: none. */
  endMs: number[];
  /** The boat's first and last fix on each leg, ms; NaN: none. */
  firstMs: number[];
  lastMs: number[];
  /** The ladder's place at firstMs / lastMs, once read (undefined: not yet; null: none). */
  firstPlace: (number | null | undefined)[];
  lastPlace: (number | null | undefined)[];
}

/** Every racing boat's legs (above), and what reads the ladder where the bump chart has no place. */
export interface LegPlaces {
  byId: Map<string, BoatLegs>;
  /** The ladder's place of boat `id` at `t`, out of the fixed fleet; null: none (no position then). */
  placeAt: (id: string, t: number) => number | null;
}

const cache = new WeakMap<CoachModel, LegPlaces>();

/** Race `a`'s leg places for its coach model `m` (above), once per model. */
export function legPlaces(a: Pick<RaceAnalysis, 'legs' | 'boats' | 'meta' | 'drawings'>, m: CoachModel): LegPlaces {
  const hit = cache.get(m);
  if (hit) return hit;
  const n = a.legs.length;
  const pc = placeChanges(a);
  const byId = new Map<string, BoatLegs>();
  a.boats.forEach((b, i) => {
    const places = pc.boats[i].places;
    const firstMs = Array<number>(n).fill(NaN);
    const lastMs = Array<number>(n).fill(NaN);
    for (const s of a.drawings.find((d) => d.id === b.id)?.segments ?? []) {
      const k = s.leg;
      if (k < 0 || k >= n || !s.t.length) continue;
      const t0 = Math.max(a.meta.gunMs, s.t[0]);
      const t1 = s.t[s.t.length - 1];
      if (!(firstMs[k] <= t0)) firstMs[k] = t0;
      if (!(lastMs[k] >= t1)) lastMs[k] = t1;
    }
    byId.set(b.id, {
      // Column k of the bump chart is the start (k = 0) or the mark ending leg k − 1; column k + 1 ends leg k.
      entry: places.slice(0, n),
      exit: places.slice(1, n + 1),
      endMs: a.legs.map((_, k) => (k === n - 1 ? b.finishMs : roundingMs(b, k)) ?? Infinity),
      firstMs,
      lastMs,
      firstPlace: Array(n),
      lastPlace: Array(n),
    });
  });
  // A reader of its own: reading here mustn't move the moment the rungs' reader last read (ladderNow.ts newLadderReader).
  const read: LadderReader = newLadderReader(a, m);
  const base: ProgressBase = progressBase(a, m);
  let last: { t: number; at: ProgressPlaces } | null = null;
  const placeAt = (id: string, t: number): number | null => {
    if (last?.t !== t) last = { t, at: progressAt(a, m, base, t, read) };
    const r = last.at.byId.get(id);
    return r && !r.est ? r.place : null;
  };
  const lp: LegPlaces = { byId, placeAt };
  cache.set(m, lp);
  return lp;
}

/**
 * Places boat `id` gained (+) or lost (−) on leg `leg` as the map shows it at `now` (ms; Infinity: the whole race):
 * its place entering the leg less its place at the leg's end, or on the leg it is on at `now`, its place then. Null
 * before the gun, on a leg not started at `now`, or with no place at one end.
 */
export function legGainAt(lp: LegPlaces, id: string, leg: number, now: number): number | null {
  const row = lp.byId.get(id);
  if (!row || leg === PRE_LEG || leg < 0 || leg >= row.entry.length) return null;
  if (!(row.firstMs[leg] <= now)) return null;
  let entry = row.entry[leg];
  if (entry == null) {
    if (row.firstPlace[leg] === undefined) row.firstPlace[leg] = lp.placeAt(id, row.firstMs[leg]);
    entry = row.firstPlace[leg]!;
  }
  if (entry == null) return null;
  const exit = row.exit[leg];
  if (exit != null && row.endMs[leg] <= now) return entry - exit;
  // The leg under way at `now` (or ended with no place at its end): the ladder's place then, or at its last fix on the leg if earlier.
  const end = row.lastMs[leg];
  if (now < end) {
    const p = lp.placeAt(id, now);
    return p == null ? null : entry - p;
  }
  if (row.lastPlace[leg] === undefined) row.lastPlace[leg] = lp.placeAt(id, end);
  const p = row.lastPlace[leg];
  return p == null ? null : entry - p;
}
