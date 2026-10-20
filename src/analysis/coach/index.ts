/**
 * Recall Coach, phase 1: the engine core on top of a RaceAnalysis — the
 * fleet's minute-by-minute wind (twdSeries.ts), the wind ladder and same-moment
 * gaps (ladder.ts), and the reference groups (groups.ts). Built lazily, when
 * the Coach tab first needs it: the wind from the raw fixes in the worker
 * (`coachWind`; the ~1 Hz drawn tracks blur the tack clusters), the ladder on
 * the main thread from the drawn tracks.
 */
import { dot, len, makeProjection, median, sub, type Vec } from '../geo';
import type { RaceAnalysis } from '../types';
import type { RaceData } from '../../data/types';
import { makeTwdAt } from '../wind';
import { groupIds, type Group } from './groups';
import { fleetVmg, gapSeries, inferLegSpans, type Course, type GapPoint } from './ladder';
import { lineCrossing } from './lineCross';
import { boundsOf, coachTracks, longestHole, projectCoachTrack, type CoachTrack } from './tracks';
import { fleetTwdSeries, type TwdSeries, type TwdSeriesData, twdSeriesFrom } from './twdSeries';

/** Which race an analysis is (event, division, race, `nc=all`): how the main thread asks the worker for that race's wind. */
export const coachRaceKey = (eventId: string, division: string, raceNumber: number, allCompetitors = false): string =>
  `${eventId}|${division}|${raceNumber}|${allCompetitors ? 'all' : ''}`;

/** The rival ladder's time step, ms. */
export const LADDER_STEP_MS = 10_000;

export interface CoachModel {
  gunMs: number;
  /** The last fix or finish of any boat, ms. */
  endMs: number;
  course: Course;
  wind: TwdSeries;
  /** Fleet median VMG per leg, m/s. */
  vmg: (number | null)[];
  tracks: Map<string, CoachTrack>;
  /** Boats left out of the wind series: their compass is replaced by the GPS course (headingSource 'cog'). */
  windExcluded: string[];
  /** When each boat's bow crossed the start line (startCrossings); null when not worked out (no raw fixes). */
  crossMs: Record<string, number | null> | null;
}

/** Start-line crossings are looked for from this long before the gun (start.py), ms… */
export const CROSS_FROM_MS = 30_000;
/** …to this long after it (later, a pass through the line is another lap, not the start), ms. */
export const CROSS_TO_MS = 5 * 60_000;

/** What the worker works out from the raw fixes for the Coach (the drawn ~1 Hz tracks start at the gun and blur the tacks). */
export interface CoachRaw {
  wind: TwdSeriesData | null;
  /** Bow crossing time per racing boat, ms; null: no crossing found (OCS and never back, or inside a hole). */
  crossMs: Record<string, number | null>;
}

const courseOf = (a: RaceAnalysis): Course | null =>
  a.legPts && a.legPts.length === a.legs.length + 1 ? { pts: a.legPts, kinds: a.legs.map((l) => l.kind), finish: a.finishLine } : null;

const endOf = (a: RaceAnalysis, tracks: CoachTrack[]): number =>
  Math.max(a.meta.gunMs + 60_000, ...a.boats.map((b) => b.finishMs ?? 0), ...tracks.map((tr) => (tr.t.length ? tr.t[tr.t.length - 1] : 0)));

/** The boats that vote in the wind: as analyze.ts does for the per-leg estimate, not those whose compass was replaced by their course (unless all were). */
export function windVoters(a: RaceAnalysis): Set<string> {
  const compass = a.boats.filter((b) => b.headingSource !== 'cog').map((b) => b.id);
  return new Set(compass.length ? compass : a.boats.map((b) => b.id));
}

/** The fleet wind series from these tracks (the voters' only), seeded by the analysis's per-leg estimates. */
export function windSeries(a: RaceAnalysis, tracks: CoachTrack[]): TwdSeries | null {
  const course = courseOf(a);
  if (!course) return null;
  const voters = windVoters(a);
  const ests = a.wind.estimates;
  return fleetTwdSeries({
    gunMs: a.meta.gunMs,
    endMs: endOf(a, tracks),
    tracks: tracks.filter((tr) => voters.has(tr.id)),
    legKinds: course.kinds,
    prior: makeTwdAt(ests, a.wind.twdAtGunDeg),
    priorTa: ests.length ? median(ests.map((e) => e.tackAngleDeg)) : 90,
  });
}

/** The worker's half: the wind series from every racing boat's raw fixes (the analysis's own projection: the start line's middle). */
export function coachWind(a: RaceAnalysis, data: RaceData): TwdSeriesData | null {
  const sl = data.startLine;
  const proj = makeProjection({ lat: (sl.left.lat + sl.right.lat) / 2, lon: (sl.left.lon + sl.right.lon) / 2 });
  const byId = new Map(data.boats.map((b) => [b.id, b]));
  const tracks: CoachTrack[] = [];
  for (const r of a.boats) {
    const b = byId.get(r.id);
    if (!b) continue;
    const tr = projectCoachTrack(b.track, proj);
    tracks.push({ id: r.id, t: tr.t, x: tr.x, y: tr.y, bounds: boundsOf(r.legs, a.meta.gunMs, r.finishMs) });
  }
  const s = windSeries(a, tracks);
  return s && { t: s.t, twd: s.twd, ta: s.ta, n: s.n, ok: s.ok };
}

/**
 * When each racing boat's bow first crossed the start line onto the course side, from CROSS_FROM_MS
 * before the gun to CROSS_TO_MS after it (the raw fixes; the bow offset as the feed gives it). Before the
 * gun is an early start; none in that time is null.
 */
export function startCrossings(a: RaceAnalysis, data: RaceData): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const first = a.legPts?.[1];
  if (!first) return out;
  const sl = data.startLine;
  const proj = makeProjection({ lat: (sl.left.lat + sl.right.lat) / 2, lon: (sl.left.lon + sl.right.lon) / 2 });
  const { left, right } = a.line;
  const along = sub(right, left);
  const L = len(along);
  if (!(L > 0)) return out;
  let side: Vec = [-along[1] / L, along[0] / L];
  if (dot(sub(first, left), side) < 0) side = [-side[0], -side[1]];
  const byId = new Map(data.boats.map((b) => [b.id, b]));
  for (const r of a.boats) {
    const b = byId.get(r.id);
    const t = b ? lineCrossing(projectCoachTrack(b.track, proj), left, right, side, a.meta.gunMs - CROSS_FROM_MS, { bowM: b.bowOffsetM }) : null;
    out[r.id] = t != null && t <= a.meta.gunMs + CROSS_TO_MS ? t : null;
  }
  return out;
}

/** The worker's half for the Coach: the wind and the start crossings, from the raw fixes. */
export const coachRaw = (a: RaceAnalysis, data: RaceData): CoachRaw => ({ wind: coachWind(a, data), crossMs: startCrossings(a, data) });

/**
 * The coach model of a race: the drawn tracks, and the wind series given (from the worker) or else
 * worked out from those tracks. Null when the analysis has no course points (one from before the Coach tab).
 */
export function buildCoach(a: RaceAnalysis, wind?: TwdSeriesData | null, crossMs: Record<string, number | null> | null = null): CoachModel | null {
  const course = courseOf(a);
  if (!course) return null;
  const tracks = coachTracks(a);
  const ests = a.wind.estimates;
  const w = wind
    ? twdSeriesFrom(wind, makeTwdAt(ests, a.wind.twdAtGunDeg), ests.length ? median(ests.map((e) => e.tackAngleDeg)) : 90)
    : windSeries(a, tracks)!;
  const voters = windVoters(a);
  // Legs across lost roundings, for the ladder (the wind series keeps to the timed legs).
  for (const tr of tracks) tr.spans = inferLegSpans(course, w, tr);
  return {
    gunMs: a.meta.gunMs,
    endMs: endOf(a, tracks),
    course,
    wind: w,
    vmg: fleetVmg(a.boats, a.legs.length),
    tracks: new Map(tracks.map((tr) => [tr.id, tr])),
    windExcluded: a.boats.filter((b) => !voters.has(b.id)).map((b) => b.id),
    crossMs,
  };
}

export interface RivalLadder {
  boat: string;
  /** The group's boats, finish order. */
  group: string[];
  points: GapPoint[];
  /** The chosen boat's roundings (known ones): time and the leg that starts there. */
  roundings: { tMs: number; leg: number }[];
  /** The chosen boat's longest hole between the gun and its finish (or last fix). */
  hole: { fromMs: number; toMs: number } | null;
}

/** The chosen boat's gap to `group` over the race, every LADDER_STEP_MS from the gun to its finish (or last fix). */
export function rivalLadder(m: CoachModel, a: RaceAnalysis, boat: string, g: Group, stepMs = LADDER_STEP_MS): RivalLadder | null {
  const tr = m.tracks.get(boat);
  if (!tr) return null;
  const ids = groupIds(a.boats, boat, g);
  const group = ids.map((id) => m.tracks.get(id)).filter((x): x is CoachTrack => !!x);
  const finish = a.boats.find((b) => b.id === boat)?.finishMs ?? null;
  const last = tr.t.length ? tr.t[tr.t.length - 1] : m.gunMs;
  const toMs = finish != null && finish > m.gunMs ? finish : last;
  const roundings = tr.bounds
    .map((t, k) => ({ tMs: t, leg: k }))
    .filter((r): r is { tMs: number; leg: number } => r.tMs != null && r.leg > 0 && r.leg < tr.bounds.length - 1);
  return {
    boat,
    group: group.map((x) => x.id),
    points: gapSeries(m.course, m.wind, m.vmg, tr, group, m.gunMs, toMs, stepMs),
    roundings,
    hole: longestHole(tr.t, m.gunMs, toMs),
  };
}
