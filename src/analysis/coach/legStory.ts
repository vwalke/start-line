/**
 * Leg stories (Chris's per-leg fleet narrative, analysis.md §5 item 2): for
 * each leg of the race, within the reference group the Coach's picker set
 * (plus the coached boat), who gained and lost places, which side of the
 * course paid, how the boats left the windward mark (gybe-set or bear-away,
 * and what each gained), and the fastest leg time. Pure numbers: the UI fills
 * one templated sentence and the chips.
 *
 * - Places at the leg's ends are places.ts's columns (the start place, the
 *   order of the rounding times, the finish), re-ranked among the set.
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
import { placeChanges, roundingMs } from '../places';
import type { BoatResult, LegKind, RaceAnalysis } from '../types';
import type { CoachModel } from './index';
import { groupIds, type Group } from './groups';
import { coachCoverage } from './opportunity';
import { posAt } from './tracks';

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

/** Rank `vals` (null = no place) 1 = smallest among those with a value. */
function rankAmong(vals: (number | null)[]): (number | null)[] {
  const idx = vals.map((v, i) => [v, i] as const).filter((x): x is readonly [number, number] => x[0] != null);
  idx.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out: (number | null)[] = vals.map(() => null);
  idx.forEach(([, i], k) => (out[i] = k + 1));
  return out;
}

export interface Mover {
  id: string;
  /** Places gained on the leg within the set (+ = gained). */
  gain: number;
  from: number;
  to: number;
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
  /** Movers within the set (or the fleet, `moversFleet`): the biggest gainers and losers. */
  gainers: Mover[];
  losers: Mover[];
  moversFleet: boolean;
  /** The coached boat's places on the leg within the movers' set; null without both. */
  mine: Mover | null;
  side: SideStat | null;
  /** Downwind legs after a windward mark only. */
  rounding: RoundingStat | null;
  fastest: { id: string; timeS: number } | null;
  /** The coached boat's leg time rank among the boats with a time (the movers' set). */
  myTime: { rank: number; of: number; timeS: number } | null;
  /** The coached boat's coverage of the leg, 0–1; null when it has no time on it. */
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
  const pc = placeChanges(a);
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const pcById = new Map(pc.boats.map((b) => [b.id, b]));
  const group = groupIds(a.boats, boat, g);
  const set = [boat, ...group].filter((id) => byId.has(id));
  const fleet = a.boats.map((b) => b.id);
  const marksEstimated = a.legSource === 'fleet' || a.marks.some((k) => k.estimated);
  return a.legs.map((leg, li) => {
    // Places at the leg's ends: column li (the start, or the mark before) and li + 1.
    const placeAt = (id: string, col: number): number | null => pcById.get(id)?.places[col] ?? null;
    const hasPlaces = (id: string): boolean => placeAt(id, li) != null && placeAt(id, li + 1) != null;
    const mv = setOrFleet(set, fleet, hasPlaces);
    const from = rankAmong(mv.ids.map((id) => placeAt(id, li)));
    const to = rankAmong(mv.ids.map((id) => placeAt(id, li + 1)));
    const movers: Mover[] = mv.ids.map((id, k) => ({ id, from: from[k]!, to: to[k]!, gain: from[k]! - to[k]! }));
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
      // Gains re-ranked among the boats this stat is over.
      const f = rankAmong(sv.ids.map((id) => placeAt(id, li)));
      const t = rankAmong(sv.ids.map((id) => placeAt(id, li + 1)));
      const mid = sv.ids.length ? median(sv.ids.map((id) => xs.get(id)!)) : 0;
      const r = sidePaid(sv.ids.map((id, k) => ({ x: xs.get(id)! - mid, gain: f[k]! - t[k]! })));
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
        const f = rankAmong(rv.ids.map((id) => placeAt(id, li)));
        const t = rankAmong(rv.ids.map((id) => placeAt(id, li + 1)));
        const of = (k: RoundingKind) => {
          const gs = rv.ids.map((id, i) => (kinds.get(id) === k ? f[i]! - t[i]! : null)).filter((x): x is number => x != null);
          return { n: gs.length, gain: gs.length ? gs.reduce((s, x) => s + x, 0) / gs.length : null };
        };
        rounding = { gybeSet: of('gybe-set'), bearAway: of('bear-away'), mine: kinds.get(boat) ?? null, of: rv.ids.length, fleet: rv.fleet };
      }
    }

    // Leg times among the movers' set.
    const timed = mv.ids.map((id) => ({ id, timeS: byId.get(id)!.legs[li]?.timeS })).filter((x): x is { id: string; timeS: number } => x.timeS != null);
    timed.sort((p, q) => p.timeS - q.timeS);
    const mineT = timed.findIndex((x) => x.id === boat);
    const me = byId.get(boat)!;
    const sp = spans.get(boat);
    const tr = m.tracks.get(boat);
    return {
      leg: li,
      name: leg.name,
      kind: leg.kind,
      set,
      gainers,
      losers,
      moversFleet: mv.fleet,
      mine: movers.find((x) => x.id === boat) ?? null,
      side,
      rounding,
      fastest: timed[0] ?? null,
      myTime: mineT >= 0 ? { rank: mineT + 1, of: timed.length, timeS: timed[mineT].timeS } : null,
      coverage: me.legs[li]?.coverage ?? (sp && tr ? coachCoverage(tr.t, sp[0], sp[1]) : null),
      marksEstimated,
    };
  });
}
