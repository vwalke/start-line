/**
 * Leg stories (Chris's per-leg fleet narrative, analysis.md §5 item 2): for
 * each leg of the race, the coached boat's places gained or lost in the whole
 * fleet (and its seconds against the reference group the Coach's picker set),
 * who in the group gained and lost places, which side of the course paid, how
 * the boats left the windward mark (gybe-set or bear-away, and what each
 * gained), and the fastest leg time. Pure numbers: the UI fills the chips.
 *
 * - Places (fleetPlaces) are in the whole fleet, out of a FIXED fleet: the boats
 *   that started (the official fleet when results are linked), the same at every
 *   mark. At each mark the order of the rounding times; a boat with no time
 *   there (a tracker hole, a dropped tracker) is placed from a time interpolated
 *   between its roundings either side (or its finish) by the fleet's median
 *   split, or carried on at its own pace from its last one; such places are
 *   marked estimated. The start: the start place (boats without one after,
 *   in their first mark's order); the finish: the official or recovered place;
 *   a finish lost in a hole (no place, no code) among the finishers by its
 *   estimated time; coded boats (DNF, …) after the last finisher. The fleet
 *   never shrinks.
 * - Against a group (Top 3, Near, custom), a place within a handful of boats
 *   says little: the leg's seconds against the group's median leg time instead.
 * - Side: each boat's mean across-wind position over the leg (every
 *   SIDE_STEP_MS, against the wind at the leg's middle, + = right looking
 *   upwind on every leg), relative to the set's median. The set sorted by it
 *   is cut in thirds; the right third's mean places gained minus the left
 *   third's is the effect. |effect| ≥ SIDE_MIN_EFFECT places with at least
 *   SIDE_MIN_BOATS boats: that side paid; else no side paid.
 * - Rounding (classifyRounding): the first tack or gybe from ROUND_LEAD_MS
 *   before the boat's windward-mark rounding to ROUND_WINDOW_MS after it; a
 *   gybe is a gybe-set, anything else (no manoeuvre, a tack) a bear-away.
 *   Needs ROUND_MIN_COVERAGE of that stretch tracked, else unknown.
 * - Each stat needs STORY_MIN_GROUP boats with data in the group (the side
 *   SIDE_MIN_BOATS, the rounding ROUND_MIN_BOATS); with fewer it is worked
 *   out on the whole fleet instead, and says so.
 */
import { bearingVec, dot, median, type Vec } from '../geo';
import { detectManoeuvres, type ManoeuvreTrack } from '../manoeuvres';
import { placeColumns, roundingMs } from '../places';
import type { BoatResult, LegKind, RaceAnalysis } from '../types';
import type { CoachModel } from './index';
import { groupIds, type Group } from './groups';
import { coachCoverage } from './opportunity';
import { posAt } from './tracks';
import { fleetOf } from './regatta';

/** A stat over the group needs this many boats with data; fewer → the fleet. */
export const STORY_MIN_GROUP = 4;
/** The rounding classifier: the first manoeuvre up to this long after the rounding… */
export const ROUND_WINDOW_MS = 30_000;
/** …from this long before it (the timed rounding is good to a few seconds), ms. */
export const ROUND_LEAD_MS = 5_000;
/** …with this share of [rounding − 30 s, rounding + ROUND_WINDOW_MS] tracked. */
export const ROUND_MIN_COVERAGE = 0.8;
/** The rounding stat needs this many classified boats. */
export const ROUND_MIN_BOATS = 3;
/** Side: positions read this often over the leg, ms. */
export const SIDE_STEP_MS = 30_000;
/** Side paid: the outer thirds' mean places gained differ by this much… */
export const SIDE_MIN_EFFECT = 1;
/** …over at least this many boats (two a third). */
export const SIDE_MIN_BOATS = 6;
/** Movers: this many gainers and losers. */
export const MOVERS_N = 2;
/** The coached boat's leg coverage under this gets a ⚠ chip. */
export const STORY_LOW_COVERAGE = 0.5;

export type RoundingKind = 'gybe-set' | 'bear-away';

/**
 * How a boat left the windward mark: the first manoeuvre from ROUND_LEAD_MS before `roundMs` to
 * ROUND_WINDOW_MS after it is a gybe → 'gybe-set', otherwise 'bear-away'; null when that stretch
 * (from 30 s before, to see the side held) is under ROUND_MIN_COVERAGE tracked.
 */
export function classifyRounding(tr: ManoeuvreTrack, twdAt: (t: number) => number, roundMs: number): RoundingKind | null {
  if (coachCoverage(tr.t as ArrayLike<number> & { length: number }, roundMs - 30_000, roundMs + ROUND_WINDOW_MS) < ROUND_MIN_COVERAGE) return null;
  const first = detectManoeuvres(tr, twdAt, roundMs - ROUND_LEAD_MS, roundMs + ROUND_WINDOW_MS)[0];
  return first?.kind === 'gybe' ? 'gybe-set' : 'bear-away';
}

/** Every racing boat's place at each column (start, each mark, finish), out of `of` (the fixed fleet). */
export interface FleetPlaces {
  of: number;
  /** Per boat: place and estimated flag per column, and the (known or estimated) elapsed time there, s after the gun. */
  byId: Map<string, { place: number[]; est: boolean[]; elapsedS: (number | null)[] }>;
}

/** The middle of the values, or null with none. */
const med = (xs: number[]): number | null => (xs.length ? median(xs) : null);

/** Fleet places with a fixed denominator (see the header): every boat has a place at every column. */
export function fleetPlaces(a: Pick<RaceAnalysis, 'legs' | 'boats' | 'meta'>): FleetPlaces {
  const gun = a.meta.gunMs;
  const cols = placeColumns(a.legs);
  const nc = cols.length;
  const boats = a.boats;
  // Elapsed time at each column (null: unknown): the gun, each rounding, the finish.
  const known = boats.map((b) =>
    cols.map((c): number | null => {
      if (c.kind === 'start') return 0;
      const t = c.kind === 'finish' ? b.finishMs : roundingMs(b, c.legIndex!);
      return t != null && t > gun ? (t - gun) / 1000 : null;
    }),
  );
  // The fleet's median elapsed time at each column: the shape a missing time is filled along.
  const medAt = cols.map((_, k) => med(known.map((r) => r[k]).filter((x): x is number => x != null)));
  const elapsed = known.map((row) =>
    row.map((v, k): { s: number; est: boolean } | null => {
      if (v != null) return { s: v, est: false };
      const m = medAt[k];
      if (m == null) return null;
      let p = k - 1;
      while (p > 0 && (row[p] == null || medAt[p] == null)) p--;
      let q = k + 1;
      while (q < nc && (row[q] == null || medAt[q] == null)) q++;
      const tp = row[p] ?? 0;
      const mp = medAt[p] ?? 0;
      if (q < nc) {
        const span = medAt[q]! - mp;
        return { s: tp + (span > 0 ? ((row[q]! - tp) * (m - mp)) / span : 0), est: true };
      }
      // Nothing known after: on at its own pace so far (the fleet's when it has none).
      const pace = p > 0 && mp > 0 ? tp / mp : 1;
      return { s: tp + (m - mp) * pace, est: true };
    }),
  );
  const place = boats.map(() => Array.from({ length: nc }, () => 0));
  const est = boats.map(() => Array.from({ length: nc }, () => false));
  /** Places from..: `ids` sorted by `keys` (compared in turn, smallest first; Infinity last). */
  const order = (k: number, keys: (i: number) => number[], isEst: (i: number) => boolean, from = 1, ids = boats.map((_, i) => i)): void => {
    const cmp = (i: number, j: number): number => {
      const p = keys(i);
      const q = keys(j);
      for (let x = 0; x < p.length; x++) if (p[x] !== q[x]) return p[x] < q[x] ? -1 : 1;
      return i - j;
    };
    [...ids].sort(cmp).forEach((i, r) => {
      place[i][k] = from + r;
      est[i][k] = isEst(i);
    });
  };
  // Marks first (the start's fallback order reads the first mark); a tie keeps the legs table's rank there, then the place before.
  for (let k = 1; k < nc - 1; k++) {
    const li = cols[k].legIndex!;
    order(
      k,
      (i) => [elapsed[i][k]?.s ?? Infinity, boats[i].legs[li]?.rankAtEnd ?? Infinity, k > 1 ? place[i][k - 1] : 0],
      (i) => elapsed[i][k]?.est ?? true,
    );
  }
  // The start: the start place, then the boats with none in their first mark's (else finish) order.
  const firstKey = (i: number): number[] => [nc > 2 ? place[i][1] : (boats[i].finishPos ?? Infinity)];
  const started = boats.map((_, i) => i).filter((i) => boats[i].start?.startPlace != null);
  const rest = boats.map((_, i) => i).filter((i) => boats[i].start?.startPlace == null);
  order(0, (i) => [boats[i].start!.startPlace!], () => false, 1, started);
  order(0, firstKey, () => true, started.length + 1, rest);
  // The finish: the official or recovered place; non-finishers after the last finisher, by how far on they were.
  const fin = nc - 1;
  const finished = boats.map((_, i) => i).filter((i) => boats[i].finishPos != null);
  for (const i of finished) {
    place[i][fin] = boats[i].finishPos!;
    est[i][fin] = false;
  }
  const last = Math.max(0, ...finished.map((i) => place[i][fin]));
  // No place and no code (a finish lost in a tracker hole): placed among the finishers by its estimated time
  // (the others keep their official places; it is marked estimated). A coded boat (DNF, …) or one with no
  // estimate goes after the last finisher, by how far on it was.
  const finS = (i: number): number | null => (boats[i].finishMs != null ? (boats[i].finishMs! - gun) / 1000 : null);
  const unknown = boats.map((_, i) => i).filter((i) => boats[i].finishPos == null && !boats[i].finishCode && elapsed[i][fin] != null);
  for (const i of unknown) {
    const s = elapsed[i][fin]!.s;
    place[i][fin] = 1 + finished.filter((j) => (finS(j) ?? Infinity) < s).length;
    est[i][fin] = true;
  }
  const dnf = boats.map((_, i) => i).filter((i) => boats[i].finishPos == null && !unknown.includes(i));
  order(fin, (i) => [elapsed[i][fin]?.s ?? Infinity, nc > 2 ? place[i][nc - 2] : 0], () => true, last + 1, dnf);
  const of = Math.max(fleetOf(a as RaceAnalysis), boats.length, ...place.map((r) => Math.max(0, ...r)));
  return { of, byId: new Map(boats.map((b, i) => [b.id, { place: place[i], est: est[i], elapsedS: elapsed[i].map((e) => e?.s ?? null) }])) };
}

export interface Mover {
  id: string;
  /** Places gained on the leg in the fleet (+ = gained). */
  gain: number;
  from: number;
  to: number;
  /** Either end's place estimated (a missing rounding filled in). */
  est?: boolean;
}

export type SideVerdict = 'left' | 'right' | 'none';

export interface SideStat {
  verdict: SideVerdict;
  /** Boats in each outer third. */
  n: number;
  /** Mean places gained by the left / right third. */
  left: number;
  right: number;
  /** right − left, places. */
  effect: number;
  /** The coached boat's side of the set's median, + = right, m; null without its positions. */
  mineM: number | null;
  /** Boats the stat is over. */
  of: number;
  fleet: boolean;
}

export interface RoundingStat {
  gybeSet: { n: number; gain: number | null };
  bearAway: { n: number; gain: number | null };
  /** The coached boat's, when known. */
  mine: RoundingKind | null;
  of: number;
  fleet: boolean;
}

export interface LegStory {
  leg: number;
  name: string;
  kind: LegKind;
  /** The boats the stats are over by default (the group and the coached boat), finish order. */
  set: string[];
  /** The biggest gainers and losers of fleet places among the set (the whole fleet when the group is). */
  gainers: Mover[];
  losers: Mover[];
  /** Always false now (every boat has a fleet place); kept for older callers. */
  moversFleet: boolean;
  /** The coached boat's fleet places at the leg's ends; null when it isn't in the race. */
  mine: Mover | null;
  /** The fixed fleet every place is out of. */
  placeOf: number;
  /** Against a group (not the whole fleet): the boat's leg time minus the group's median leg time, s (+ = lost); null without times. */
  vsGroup: { deltaS: number; n: number } | null;
  side: SideStat | null;
  /** Downwind legs after a windward mark only. */
  rounding: RoundingStat | null;
  fastest: { id: string; timeS: number } | null;
  /** The coached boat's leg time rank among the fleet's boats with a time. */
  myTime: { rank: number; of: number; timeS: number } | null;
  /** The coached boat's coverage of the leg, 0–1; falls back to its race coverage when it has no timed leg. */
  coverage: number | null;
  marksEstimated: boolean;
}

/** The ids with a value (`has`): the set's when `min` of them do, else the fleet's. */
function setOrFleet(set: string[], fleet: string[], has: (id: string) => boolean, min = STORY_MIN_GROUP): { ids: string[]; fleet: boolean } {
  const s = set.filter(has);
  if (s.length >= min) return { ids: s, fleet: false };
  return { ids: fleet.filter(has), fleet: true };
}

/** When the boat was on leg `li`: its timed leg, else from the rounding before to the one after; null when unknown. */
function legSpan(b: BoatResult, li: number, gun: number): [number, number] | null {
  const l = b.legs[li];
  if (l) return [l.startMs, l.endMs];
  const a = li === 0 ? gun : roundingMs(b, li - 1);
  const e = li === b.legs.length - 1 ? b.finishMs : roundingMs(b, li);
  return a != null && e != null && e > a ? [a, e] : null;
}

/** The boat's mean across-wind position over [a, b] (+ = right looking upwind, across `twdDeg`), m; null with under half the reads. */
function meanAcross(m: CoachModel, id: string, a: number, b: number, twdDeg: number): number | null {
  const tr = m.tracks.get(id);
  if (!tr) return null;
  const across = bearingVec(twdDeg + 90);
  let n = 0;
  const v: number[] = [];
  for (let t = a; t <= b; t += SIDE_STEP_MS) {
    n++;
    const p: Vec | null = posAt(tr, t);
    if (p) v.push(dot(p, across));
  }
  return v.length && v.length >= n / 2 ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** Which side paid, from each boat's across-wind position and places gained (both over the same boats). */
export function sidePaid(rows: { x: number; gain: number }[]): Pick<SideStat, 'verdict' | 'n' | 'left' | 'right' | 'effect'> | null {
  if (rows.length < SIDE_MIN_BOATS) return null;
  const s = [...rows].sort((p, q) => p.x - q.x);
  const n = Math.floor(s.length / 3);
  const mean = (r: typeof s): number => r.reduce((t, x) => t + x.gain, 0) / r.length;
  const left = mean(s.slice(0, n));
  const right = mean(s.slice(s.length - n));
  const effect = right - left;
  const verdict: SideVerdict = Math.abs(effect) < SIDE_MIN_EFFECT ? 'none' : effect > 0 ? 'right' : 'left';
  return { verdict, n, left, right, effect };
}

/** One story per leg of the race for `boat`, the stats over its group `g` (and itself). */
export function legStories(a: RaceAnalysis, m: CoachModel, boat: string, g: Group): LegStory[] {
  const fp = fleetPlaces(a);
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const group = groupIds(a.boats, boat, g);
  const set = [boat, ...group].filter((id) => byId.has(id));
  const fleet = a.boats.map((b) => b.id);
  const marksEstimated = a.legSource === 'fleet' || a.marks.some((k) => k.estimated);
  return a.legs.map((leg, li) => {
    // Fleet places at the leg's ends: column li (the start, or the mark before) and li + 1; every boat has both.
    const placeAt = (id: string, col: number): number | null => fp.byId.get(id)?.place[col] ?? null;
    const hasPlaces = (id: string): boolean => placeAt(id, li) != null && placeAt(id, li + 1) != null;
    const moverOf = (id: string): Mover => {
      const r = fp.byId.get(id)!;
      return { id, from: r.place[li], to: r.place[li + 1], gain: r.place[li] - r.place[li + 1], est: r.est[li] || r.est[li + 1] };
    };
    const movers: Mover[] = (g.kind === 'fleet' ? fleet : set).filter(hasPlaces).map(moverOf);
    const gainers = movers.filter((x) => x.gain > 0).sort((p, q) => q.gain - p.gain || p.to - q.to).slice(0, MOVERS_N);
    const losers = movers.filter((x) => x.gain < 0).sort((p, q) => p.gain - q.gain || p.to - q.to).slice(0, MOVERS_N);

    // Side: across-wind position over each boat's own time on the leg, the wind at the leg's middle for all.
    const spans = new Map(fleet.map((id) => [id, legSpan(byId.get(id)!, li, a.meta.gunMs)]));
    const mids = [...spans.values()].filter((s): s is [number, number] => !!s).map(([p, q]) => (p + q) / 2);
    const axis = mids.length ? m.wind.twdAt(median(mids)) : m.wind.twdAt(a.meta.gunMs);
    const xs = new Map<string, number>();
    for (const id of fleet) {
      const sp = spans.get(id);
      const x = sp ? meanAcross(m, id, sp[0], sp[1], axis) : null;
      if (x != null) xs.set(id, x);
    }
    let side: SideStat | null = null;
    {
      const has = (id: string): boolean => xs.has(id) && hasPlaces(id);
      const sv = setOrFleet(set, fleet, has, SIDE_MIN_BOATS);
      // Fleet places gained (the fixed fleet: a boat lost from the trackers doesn't move the others).
      const mid = sv.ids.length ? median(sv.ids.map((id) => xs.get(id)!)) : 0;
      const r = sidePaid(sv.ids.map((id) => ({ x: xs.get(id)! - mid, gain: placeAt(id, li)! - placeAt(id, li + 1)! })));
      if (r) side = { ...r, mineM: xs.has(boat) ? xs.get(boat)! - mid : null, of: sv.ids.length, fleet: sv.fleet };
    }

    // Rounding: downwind legs that start at a windward mark (after a beat).
    let rounding: RoundingStat | null = null;
    if (leg.kind === 'downwind' && li > 0 && a.legs[li - 1].kind === 'upwind') {
      const kinds = new Map<string, RoundingKind>();
      for (const id of fleet) {
        const r = roundingMs(byId.get(id)!, li - 1);
        const tr = m.tracks.get(id);
        const k = r != null && tr ? classifyRounding(tr, m.wind.twdAt, r) : null;
        if (k) kinds.set(id, k);
      }
      const rv = setOrFleet(set, fleet, (id) => kinds.has(id) && hasPlaces(id), ROUND_MIN_BOATS);
      if (rv.ids.length >= ROUND_MIN_BOATS) {
        const of = (k: RoundingKind) => {
          const gs = rv.ids.map((id) => (kinds.get(id) === k ? placeAt(id, li)! - placeAt(id, li + 1)! : null)).filter((x): x is number => x != null);
          return { n: gs.length, gain: gs.length ? gs.reduce((s, x) => s + x, 0) / gs.length : null };
        };
        rounding = { gybeSet: of('gybe-set'), bearAway: of('bear-away'), mine: kinds.get(boat) ?? null, of: rv.ids.length, fleet: rv.fleet };
      }
    }

    // Leg times: the fastest in the set (the fleet when the group is), the boat's rank in the fleet.
    const timeOf = (id: string): number | undefined => byId.get(id)!.legs[li]?.timeS;
    const timedIn = (ids: string[]) =>
      ids
        .map((id) => ({ id, timeS: timeOf(id) }))
        .filter((x): x is { id: string; timeS: number } => x.timeS != null)
        .sort((p, q) => p.timeS - q.timeS);
    const timed = timedIn(fleet);
    const setTimed = g.kind === 'fleet' ? timed : timedIn(set);
    const mineT = timed.findIndex((x) => x.id === boat);
    const me = byId.get(boat)!;
    // Against a group: seconds vs its median leg time (a place among four boats says little).
    const groupTimes = group.map(timeOf).filter((x): x is number => x != null);
    const myLeg = timeOf(boat);
    const vsGroup = g.kind !== 'fleet' && myLeg != null && groupTimes.length ? { deltaS: myLeg - median(groupTimes), n: groupTimes.length } : null;
    const sp = spans.get(boat);
    const tr = m.tracks.get(boat);
    return {
      leg: li,
      name: leg.name,
      kind: leg.kind,
      set,
      gainers,
      losers,
      moversFleet: false,
      mine: hasPlaces(boat) ? moverOf(boat) : null,
      placeOf: fp.of,
      vsGroup,
      side,
      rounding,
      fastest: setTimed[0] ?? null,
      myTime: mineT >= 0 ? { rank: mineT + 1, of: timed.length, timeS: timed[mineT].timeS } : null,
      coverage: me.legs[li]?.coverage ?? (sp && tr ? coachCoverage(tr.t, sp[0], sp[1]) : (me.coverage ?? null)),
      marksEstimated,
    };
  });
}
