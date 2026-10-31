/**
 * Recall Coach, phase 1: the engine core on top of a RaceAnalysis — the
 * fleet's minute-by-minute wind (twdSeries.ts), the wind ladder (ladder.ts: the
 * course progress is measured up it, the places by distance to go along it), the
 * gaps at equal course progress (timeGap.ts groupGap) the rival ladder chart and
 * the cards both read, and the reference groups (groups.ts). Built lazily, when
 * the Coach tab first needs it: the wind from the raw fixes in the worker
 * (`coachWind`; the ~1 Hz drawn tracks blur the tack clusters), and the fixes
 * near the marks (`zoneTracks`, an uploaded log at its full rate), the ladder
 * on the main thread from the drawn tracks.
 */
import { dot, len, makeProjection, median, sub, type Vec } from '../geo';
import type { RaceAnalysis } from '../types';
import type { RaceData } from '../../data/types';
import { makeTwdAt, windPoints } from '../wind';
import { groupIds, type Group } from './groups';
import { fleetVmg, inferLegSpans, type Course, type GapPoint } from './ladder';
import { GAP_STEP_MS, gapCourse, groupGap, timeGapSeries } from './timeGap';
import { lineCrossing } from './lineCross';
import { startCross } from '../startCross';
import { boundsOf, coachTracks, longestHole, projectCoachTrack, type CoachTrack } from './tracks';
import { GYBE_WIND, fleetTwdSeries, type TwdSeries, type TwdSeriesData, twdSeriesFrom } from './twdSeries';
import { heelTracks, type HeelTrack } from './detectors/heel';
import { findTurns, type PenaltyTurn } from './detectors/penaltyTurn';
import type { OverStart } from './penalty';
import { codeInfo } from '../../data/official/codes';
import { kiteOf } from '../../data/classes';

/** Which race an analysis is (event, division, race, `nc=all`): how the main thread asks the worker for that race's wind. */
export const coachRaceKey = (eventId: string, division: string, raceNumber: number, allCompetitors = false): string =>
  `${eventId}|${division}|${raceNumber}|${allCompetitors ? 'all' : ''}`;

/** The rival ladder's time step, ms: the cards read the same points (timeGap.ts groupGap). */
export const LADDER_STEP_MS = GAP_STEP_MS;

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
  /** Each boat's raw fixes near the marks (zoneTracks; an uploaded log's at its full rate); null without raw fixes (D9 reads the drawn tracks). */
  zones: Map<string, ZoneTrack> | null;
  /** Each boat's heel (detectors/heel.ts heelTracks; an uploaded log's at its full rate); null without raw fixes, absent from boats with no roll (D11 not evaluated). */
  heel?: Map<string, HeelTrack> | null;
  /** Each boat's penalty turns (detectors/penaltyTurn.ts, from the raw fixes: turnTracks); null without raw fixes (D12 not evaluated). */
  turns?: Map<string, PenaltyTurn[]> | null;
  /** A boat over at the gun or scored with a start code (OCS / UFD / BFD): when it went back and recrossed (overStarts); null without raw fixes. */
  overStart?: Map<string, OverStart> | null;
}

/** Start-line crossings are looked for from this long before the gun (start.py), ms… */
export const CROSS_FROM_MS = 30_000;
/** …to this long after it (later, a pass through the line is another lap, not the start), ms. */
export const CROSS_TO_MS = 5 * 60_000;

/** What the worker works out from the raw fixes for the Coach (the drawn ~1 Hz tracks start at the gun and blur the tacks). */
export interface CoachRaw {
  wind: TwdSeriesData | null;
  /** Bow crossing time per racing boat (an OCS boat's: when it cleared), ms; null: no crossing found (OCS and never back, or inside a hole). */
  crossMs: Record<string, number | null>;
  /** Each racing boat's raw fixes near the marks (zoneTracks), for the mark roundings (D9). */
  zones?: Record<string, ZoneTrack>;
  /** Each racing boat's heel from the raw fixes (heelTracks), for D11; boats without roll left out. */
  heel?: Record<string, HeelTrack>;
  /** Each racing boat's penalty turns (turnTracks), for D12; boats with none left out. */
  turns?: Record<string, PenaltyTurn[]>;
  /** The over-the-line boats' return figures (overStarts), for the penalty card of a scored OCS / UFD / BFD. */
  overStart?: Record<string, OverStart>;
}

/** A boat's fixes near the marks, projected (the analysis's frame), time-sorted. */
export interface ZoneTrack {
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
}

/** Fixes this close to a mark are kept for the roundings: the 100 m zone plus room for a mark placed a little off, m. */
export const ZONE_KEEP_M = 130;
/** Feed fixes are kept at most this often (an uploaded log keeps every fix: its full rate), ms. */
export const ZONE_STEP_MS = 400;

/** The marks the boats round: the turns between legs and every mark's points (both ends of a gate). */
export function markPoints(a: Pick<RaceAnalysis, 'legPts' | 'marks'>): Vec[] {
  const turns = a.legPts ? a.legPts.slice(1, -1) : [];
  return [...turns, ...a.marks.flatMap((m) => m.xy)];
}

/**
 * Every racing boat's raw fixes within ZONE_KEEP_M of a mark, from the gun to a minute after its finish
 * (or its last fix): what D9 times the roundings from. A boat with an uploaded log (Boat.fullRate) is read
 * from the log at its full rate (the analysis's track has it thinned to 1 Hz); the others from the feed,
 * at most every ZONE_STEP_MS.
 */
export function zoneTracks(a: RaceAnalysis, data: RaceData): Record<string, ZoneTrack> {
  const out: Record<string, ZoneTrack> = {};
  const marks = markPoints(a);
  if (!marks.length) return out;
  const sl = data.startLine;
  const proj = makeProjection({ lat: (sl.left.lat + sl.right.lat) / 2, lon: (sl.left.lon + sl.right.lon) / 2 });
  const byId = new Map(data.boats.map((b) => [b.id, b]));
  const r2 = ZONE_KEEP_M * ZONE_KEEP_M;
  for (const r of a.boats) {
    const b = byId.get(r.id);
    if (!b) continue;
    const src = b.fullRate ?? b.track;
    const step = b.fullRate ? 0 : ZONE_STEP_MS;
    const n = src.t.length;
    const end = (r.finishMs ?? (n ? src.t[n - 1] : a.meta.gunMs)) + 60_000;
    const t: number[] = [];
    const x: number[] = [];
    const y: number[] = [];
    let last = -Infinity;
    for (let i = 0; i < n; i++) {
      const ts = src.t[i];
      if (ts < a.meta.gunMs || ts > end || ts - last < step) continue;
      const p = proj.toXY(src.lat[i], src.lon[i]);
      if (!marks.some((m) => (m[0] - p[0]) ** 2 + (m[1] - p[1]) ** 2 <= r2)) continue;
      t.push(ts);
      x.push(p[0]);
      y.push(p[1]);
      last = ts;
    }
    out[r.id] = { t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y) };
  }
  return out;
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

/** Whether the runs are read for the wind (twdSeries.ts gybeTwd): only for asymmetric-kite classes, where the gybes beat interpolation. */
export const gybesFor = (a: RaceAnalysis): boolean => GYBE_WIND && kiteOf([a.meta.boatClass, a.meta.division, a.meta.classLabel]) === 'asym';

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
    prior: makeTwdAt(windPoints(a.wind), a.wind.twdAtGunDeg),
    priorTa: ests.length ? median(ests.map((e) => e.tackAngleDeg)) : 90,
    gybes: gybesFor(a),
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
  return s && { t: s.t, twd: s.twd, ta: s.ta, n: s.n, ok: s.ok, taOk: s.taOk };
}

/**
 * When each racing boat's bow first crossed the start line onto the course side, from CROSS_FROM_MS
 * before the gun to CROSS_TO_MS after it (the raw fixes; Boat.bowOffsetM). None in that time is null. Only race
 * control says a boat was over early: a crossing before the gun by a boat it didn't call counts at the gun. A boat
 * race control called over (StartResult.over: the RaceSense OCS flag or an official OCS / UFD / BFD) starts
 * when it cleared: its final crossing after the gun from the pre-start
 * side (startCross); null if it never came back in that time.
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
    if (!b) {
      out[r.id] = null;
      continue;
    }
    const tr = projectCoachTrack(b.track, proj);
    const gun = a.meta.gunMs;
    const first = r.start?.over ? null : lineCrossing(tr, left, right, side, gun - CROSS_FROM_MS, { bowM: b.bowOffsetM });
    const t = r.start?.over
      ? startCross(tr, left, right, side, gun, { bowM: b.bowOffsetM, fromMs: gun - CROSS_FROM_MS, toMs: gun + CROSS_TO_MS }).clearedMs
      : first != null
        ? Math.max(first, gun)
        : null;
    out[r.id] = t != null && t <= a.meta.gunMs + CROSS_TO_MS ? t : null;
  }
  return out;
}

/**
 * Every racing boat's penalty turns (detectors/penaltyTurn.ts findTurns) from its raw fixes (an uploaded log at its
 * full rate), in the analysis's frame: from its start (the line crossing, else the gun; never before the gun) to its
 * finish (else its last timed rounding, else its last fix), away from the marks (markPoints).
 */
export function turnTracks(a: RaceAnalysis, data: RaceData, crossMs: Record<string, number | null>): Record<string, PenaltyTurn[]> {
  const out: Record<string, PenaltyTurn[]> = {};
  const marks = markPoints(a);
  const sl = data.startLine;
  const proj = makeProjection({ lat: (sl.left.lat + sl.right.lat) / 2, lon: (sl.left.lon + sl.right.lon) / 2 });
  const byId = new Map(data.boats.map((b) => [b.id, b]));
  const gun = a.meta.gunMs;
  for (const r of a.boats) {
    const b = byId.get(r.id);
    if (!b) continue;
    const src = b.fullRate ?? b.track;
    const n = src.t.length;
    if (n < 2) continue;
    const tr = projectCoachTrack({ ...b.track, t: src.t, lat: src.lat, lon: src.lon }, proj);
    const lastLeg = [...r.legs].reverse().find((l) => l != null)?.endMs ?? null;
    const toMs = r.finishMs ?? lastLeg ?? src.t[n - 1];
    const turns = findTurns(tr, { fromMs: Math.max(gun, crossMs[r.id] ?? gun), toMs, marks, fullRate: !!b.fullRate });
    if (turns.length) out[r.id] = turns;
  }
  return out;
}

/**
 * When each boat over at the gun, or scored with a start code (OCS / UFD / BFD: codes.ts `start`), went back to the
 * pre-start side and recrossed (startCross), for the penalty card's over-the-line chips.
 */
export function overStarts(a: RaceAnalysis, data: RaceData): Record<string, OverStart> {
  const out: Record<string, OverStart> = {};
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
  const gun = a.meta.gunMs;
  for (const r of a.boats) {
    const b = byId.get(r.id);
    if (!b || !(r.start?.over || (r.finishCode && codeInfo(r.finishCode).start))) continue;
    const c = startCross(projectCoachTrack(b.track, proj), left, right, side, gun, { bowM: b.bowOffsetM, fromMs: gun - CROSS_FROM_MS, toMs: gun + CROSS_TO_MS });
    out[r.id] = { wentBackMs: c.wentBackMs, clearedMs: c.clearedMs };
  }
  return out;
}

/** The worker's half for the Coach: the wind, the start crossings, the fixes near the marks, the heel, the penalty turns and the over-the-line returns, from the raw fixes. */
export function coachRaw(a: RaceAnalysis, data: RaceData): CoachRaw {
  const crossMs = startCrossings(a, data);
  return {
    wind: coachWind(a, data),
    crossMs,
    zones: zoneTracks(a, data),
    heel: heelTracks(a, data),
    turns: turnTracks(a, data, crossMs),
    overStart: overStarts(a, data),
  };
}

/**
 * The coach model of a race: the drawn tracks, and the wind series given (from the worker) or else
 * worked out from those tracks. Null when the analysis has no course points (one from before the Coach tab).
 */
export function buildCoach(
  a: RaceAnalysis,
  wind?: TwdSeriesData | null,
  crossMs: Record<string, number | null> | null = null,
  zones: Record<string, ZoneTrack> | null = null,
  heel: Record<string, HeelTrack> | null = null,
  turns: Record<string, PenaltyTurn[]> | null = null,
  overStart: Record<string, OverStart> | null = null,
): CoachModel | null {
  const course = courseOf(a);
  if (!course) return null;
  const tracks = coachTracks(a);
  const ests = a.wind.estimates;
  const w = wind
    ? twdSeriesFrom(wind, makeTwdAt(windPoints(a.wind), a.wind.twdAtGunDeg), ests.length ? median(ests.map((e) => e.tackAngleDeg)) : 90)
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
    zones: zones ? new Map(Object.entries(zones)) : null,
    heel: heel ? new Map(Object.entries(heel)) : null,
    turns: turns ? new Map(Object.entries(turns)) : null,
    overStart: overStart ? new Map(Object.entries(overStart)) : null,
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

/**
 * The chosen boat's gap to `group` over the race at equal course progress (timeGap.ts), every LADDER_STEP_MS from the gun to
 * its finish (or last fix): timeGap.ts groupGap, the series the cards read (another `stepMs` works it out on its own).
 */
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
  const { course, lw } = gapCourse(m);
  return {
    boat,
    group: group.map((x) => x.id),
    points: stepMs === GAP_STEP_MS ? groupGap(m, boat, ids, m.gunMs, toMs) : timeGapSeries(course, lw, tr, group, m.gunMs, toMs, stepMs),
    roundings,
    hole: longestHole(tr.t, m.gunMs, toMs),
  };
}
