/**
 * The analysis pipeline: RaceData in, RaceAnalysis out. Ported from the
 * Python prototype (analyze.py): local ENU projection, bow-corrected DTL,
 * secs late from velocity toward the line, legs split at mark approaches
 * (or, when the trackers are missing or out of order, where the fleet turned
 * at the top and bottom of the course: course.ts, with a triangle's reach
 * marks put back in each lap: insertBentMarks), TWD from steady upwind
 * tack headings, VMG from displacement along the wind.
 */
import type { Boat, RaceData } from '../data/types';
import { coverage } from './coverage';
import { M_PER_NM, pathDistance } from './distance';
import { buildFindings } from './findings';
import {
  MS_TO_KN,
  add,
  bearingVec,
  dot,
  gradientAt,
  interp,
  interpAngle,
  len,
  median,
  scale,
  sub,
  vecBearing,
  wrap180,
  type Vec,
} from './geo';
import { fleetTurns, insertBentMarks, isOffset, legCourse, legsAgree, snapTurns } from './course';
import { checkBounds, dropImpossibleLegs, inferRoundings, legMedians, splitLegs, targetsOf, type Targets, type Waypoint } from './legs';
import { SQUARE_LINE_M, awayFromLineThresholdM } from './line';
import { heelAt, heelSeries, heelStats } from './heel';
import { cogHeading, detectManoeuvres, headingCheck, manoeuvresByLeg, signedTwa, type HeadingCheck } from './manoeuvres';
import { classifyParticipation } from './participation';
import { projectTrack, raceProjection, rangeIdx, type XYTrack } from './prepare';
import { smoothSog } from './smooth';
import { kindSummary, placeSummaries } from './summary';
import {
  MAP_PRE_MS,
  PRE_LEG,
  START_SOG_POST_MS,
  START_SOG_PRE_MS,
  START_TRAIL_MS,
  type BoatDrawing,
  type BoatResult,
  type DrawnTrack,
  type LegDef,
  type LegKind,
  type LegResult,
  type LineInfo,
  type RaceAnalysis,
  type RaceNote,
  type StartResult,
  type StartWind,
  type StartWindFail,
  type TrackSegment,
  type WindEstimate,
  type WindInfo,
} from './types';
import { finishRank } from './result';
import { rawHoles } from './rawHoles';
import { assessStart, estimateDtl, rankStarts, sampleGap, startDtlM } from './validity';
import { classifyLeg, closeHauledTackAngle, estimateTwd, makeTwdAt, readStartTwd, startWindHeadings, steadyIndices, straddles, windPoints } from './wind';

const centroid = (ps: Vec[]): Vec => scale(ps.reduce((a, b) => add(a, b), [0, 0] as Vec), 1 / ps.length);

const KIND_NAME: Record<LegKind, string> = { upwind: 'Beat', downwind: 'Run', reach: 'Reach' };

const listOf = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Why the legs come from the fleet's turns rather than the mark trackers, in plain words. */
function fleetWarning(data: RaceData, courseWps: Waypoint[], turnMarks: (Waypoint | null)[], legs: LegDef[]): RaceNote {
  const silent = [...new Set(data.courseUntracked ?? [])];
  const tracked = [...new Set(courseWps.map((w) => w.name))];
  const why: string[] = [];
  if (silent.length) why.push(`${listOf(silent)} sent no tracker positions`);
  if (tracked.length) why.push(`the tracked marks (${listOf(tracked)}) don't give the order the fleet rounded them`);
  if (!silent.length && !tracked.length) why.push('the feed has no mark trackers for this course');
  const est = [...new Set(legs.filter((_, i) => i < turnMarks.length && !turnMarks[i]).map((l) => l.to.toLowerCase()))];
  const offset = courseWps.some(isOffset) || silent.some((n) => /offset/i.test(n));
  const text =
    `Legs are split where each boat turned at the top and bottom of the course, because ${why.join(' and ')}.` +
    (est.length ? ` The ${listOf(est)} ${est.length > 1 ? 'are' : 'is'} placed from the tracks (est.).` : '') +
    (offset ? ' The offset mark is counted as part of the following run.' : '');
  return { kind: 'legs-fleet', text, silent, tracked, est, offset };
}

export { START_TRAIL_MS };

/** Marks this close (m) share one label: unused M1/M2 sitting on a snapped windward, etc. */
export const MARK_NEAR_M = 40;

export const marksNear = (a: Vec[], b: Vec[], m = MARK_NEAR_M): boolean => a.some((p) => b.some((q) => len(sub(p, q)) < m));

/** A boat with no accepted finish is drawn to its own crossing of the finish line (Boat.lineCrossMs) plus this, not on to where it sailed after. */
export const FINISH_TAIL_MS = 15_000;

/**
 * Where the last leg (from `fromMs`) of a boat with no accepted finish is drawn to: FINISH_TAIL_MS past its own
 * crossing of the finish line when that falls in the leg, else its last fix.
 */
export function unfinishedDrawEnd(b: Pick<Boat, 'track' | 'lineCrossMs'>, fromMs: number): number {
  const n = b.track.t.length;
  const lastFix = n ? b.track.t[n - 1] : fromMs;
  const cross = b.lineCrossMs;
  return cross != null && cross > fromMs ? Math.min(lastFix, cross + FINISH_TAIL_MS) : lastFix;
}

/**
 * Add a mark unless one is already drawn there. A real tracker may replace an
 * estimate at the same place (`replaceEstimate`); unused course marks must not
 * (that was M1/M2 overlapping at the top and a stray M1 on the leeward).
 */
export function addDrawnMark(out: RaceAnalysis['marks'], m: RaceAnalysis['marks'][number], opts: { replaceEstimate?: boolean; nearM?: number } = {}): void {
  const nearM = opts.nearM ?? (m.estimated ? 100 : MARK_NEAR_M);
  const hit = out.find((x) => marksNear(x.xy, m.xy, nearM));
  if (!hit) {
    out.push(m);
    return;
  }
  if (opts.replaceEstimate && hit.estimated && !m.estimated) {
    hit.name = m.name;
    hit.xy = m.xy;
    if (m.title) hit.title = m.title;
    delete hit.estimated;
  }
}

/** A mark's role on the course, from the legs into and out of it. */
export type MarkRole = 'windward' | 'leeward' | 'reach';

/** What the legs into and out of a mark make it: null when they don't make it clear (a gybe mark between a reach and a run). */
export function markRole(into: LegKind, out: LegKind): MarkRole | null {
  if (into === 'upwind' && out !== 'upwind') return 'windward';
  if (into !== 'upwind' && out === 'upwind') return 'leeward';
  if (into === 'reach' && out === 'reach') return 'reach';
  return null;
}

/** The role a feed's mark title names, if any ("Windward", "Leeward port", "Wing"). */
export function titleRole(title: string): MarkRole | null {
  if (/windward|weather|\btop\b/i.test(title)) return 'windward';
  if (/leeward|bottom/i.test(title)) return 'leeward';
  if (/reach|wing|gybe|jibe/i.test(title)) return 'reach';
  return null;
}

const ROLE_NAME: Record<MarkRole, string> = { windward: 'Windward mark', leeward: 'Leeward mark', reach: 'Reach mark' };

/**
 * The name to show for a listed mark rounded with these roles (one per rounding): its role ("Reach mark") when every
 * rounding gives the same one and the feed's title names another role ("Leeward port" rounded between two reaches);
 * else the title: a code ("M2", "BG") says nothing the legs contradict.
 */
export function markLabel(title: string, roles: (MarkRole | null)[]): string {
  const role = roles.length && roles.every((r) => r === roles[0]) ? roles[0] : null;
  if (!role) return title;
  const named = titleRole(title);
  return named && named !== role ? ROLE_NAME[role] : title;
}

export interface AnalyzeOptions {
  /** Treat every boat as a competitor (`nc=all`): no participation filtering. */
  allCompetitors?: boolean;
  /** Leave a triangle's reach marks out (insertBentMarks): the analysis falls back to this when those legs don't hold together. */
  noBentMarks?: boolean;
}

const tagOf = (b: Boat): string => (b.name && b.name !== `#${b.sail}` ? `#${b.sail} (${b.name})` : `#${b.sail}`);

export function analyzeRace(input: RaceData, opts: AnalyzeOptions = {}): RaceAnalysis {
  const notes: RaceNote[] = [];
  // Who is racing: boats judged not racing are set aside before anything is
  // measured, so they can't move the legs, the wind, the fleet medians or a rank.
  const participation = classifyParticipation(input);
  const flagged = input.boats.filter((b) => participation.get(b.id)?.status === 'non-competitor');
  // Never set the whole fleet aside (nothing would be left to compare against).
  const setAside = opts.allCompetitors || flagged.length === input.boats.length ? [] : flagged;
  const asideIds = new Set(setAside.map((b) => b.id));
  // A finish the event results show to be implausible (the feed's own distance
  // or max speed is far off the fleet's) doesn't count for ranking; finishMs stays raw on the input.
  const competitors = input.boats
    .filter((b) => !asideIds.has(b.id))
    .map((b) => {
      if (b.finishMs == null || b.entry?.finishPlausible !== false) return b;
      const why = b.entry.finishNote ?? 'it looks implausible against the fleet';
      notes.push({ kind: 'finish-unranked', text: `Not ranking ${tagOf(b)}'s finish: ${why}.`, boat: tagOf(b), why });
      return { ...b, finishMs: null };
    });
  const data: RaceData = { ...input, boats: competitors };
  const gun = data.gunMs;
  const sl = data.startLine;
  const proj = raceProjection(data);
  const L = proj.toXY(sl.left.lat, sl.left.lon);
  const R = proj.toXY(sl.right.lat, sl.right.lon);
  const lineVec = sub(R, L);
  const lineLen = Math.max(len(lineVec), 1e-9);
  const ldir = scale(lineVec, 1 / lineLen);
  const lineMid = centroid([L, R]);

  // A compass far off the GPS course (manoeuvres.ts headingCheck) is replaced by the course
  // over ground for everything heading feeds: TWA, the start heading and bow, the hull.
  const headings = new Map<string, HeadingCheck>();
  const prepare = (b: Boat): XYTrack => {
    const tr = projectTrack(b.track, proj);
    const hc = headingCheck(tr);
    headings.set(b.id, hc);
    if (hc.source === 'cog') tr.heading = cogHeading(tr);
    return tr;
  };
  const tracks = new Map<string, XYTrack>(data.boats.map((b) => [b.id, prepare(b)]));
  // …but such a boat's course is no tack heading: it stays out of the wind estimate (unless every boat is one).
  const compass = data.boats.filter((b) => headings.get(b.id)!.source === 'device');
  const windBoats = new Set((compass.length ? compass : data.boats).map((b) => b.id));
  const finishLine = data.finishLine
    ? { left: proj.toXY(data.finishLine.left.lat, data.finishLine.left.lon), right: proj.toXY(data.finishLine.right.lat, data.finishLine.right.lon) }
    : null;

  // ---- waypoints & leg sequence
  const courseWps: Waypoint[] = data.course.map((m) => {
    const xy = m.positions.map((p) => proj.toXY(p.lat, p.lon));
    const wp: Waypoint = { name: m.name, key: m.id, xy };
    const tracks = m.tracks?.filter((tk) => tk.t.length > 1);
    if (tracks && tracks.length === m.positions.length) {
      const series = tracks.map((tk) => {
        const ps = tk.t.map((_, i) => proj.toXY(tk.lat[i], tk.lon[i]));
        return { t: tk.t, x: ps.map((p) => p[0]), y: ps.map((p) => p[1]) };
      });
      wp.at = (t) => series.map((s) => [interp(s.t, s.x, t), interp(s.t, s.y, t)] as Vec);
    }
    return wp;
  });
  const byKey = new Map(courseWps.map((w) => [w.key, w]));
  // Candidate legs from the mark trackers; their warnings only apply if they are used.
  const markWarnings: RaceNote[] = [];
  let wps = courseWps;
  let legSource: RaceAnalysis['legSource'] = courseWps.length ? 'course' : 'none';
  const finishers = data.boats.filter((b) => b.finishMs != null).sort((a, b) => a.finishMs! - b.finishMs!);
  if (courseWps.length) {
    const inferred = finishers
      .slice(0, 3)
      .map((b) => inferRoundings(tracks.get(b.id)!, gun, b.finishMs!, courseWps).join('|'));
    const courseSeq = courseWps.map((w) => w.key).join('|');
    if (inferred.length >= 2 && inferred.every((s) => s === inferred[0]) && inferred[0] && inferred[0] !== courseSeq) {
      wps = inferred[0].split('|').map((k) => byKey.get(k)!);
      legSource = 'tracks';
      markWarnings.push({ kind: 'leg-order', text: 'Leg order inferred from the leaders’ tracks (it differs from the course list in the feed).' });
    }
  }

  // Split once, then treat a course as shortened if most finishers never
  // completed it (keep the longest prefix that most of them did).
  let times = new Map<string, (number | null)[]>();
  for (const b of data.boats) times.set(b.id, splitLegs(tracks.get(b.id)!, gun, wps, b.finishMs));
  if (wps.length && finishers.length) {
    const nWp = wps.length;
    const completed = (tt: (number | null)[], k: number): boolean => {
      for (let i = 0; i <= k; i++) if (tt[i] == null) return false;
      return tt[tt.length - 1] != null;
    };
    const done = (k: number): number => finishers.filter((b) => completed(times.get(b.id)!, k)).length;
    const need = Math.ceil(0.6 * finishers.length);
    if (done(nWp) < need) {
      let k = nWp - 1;
      while (k > 0 && done(k) < need) k--;
      const dropped = wps.slice(k).map((w) => w.name);
      wps = wps.slice(0, k);
      for (const [id, tt] of times) times.set(id, k === nWp ? tt : [...tt.slice(0, k + 1), tt[tt.length - 1]]);
      markWarnings.push({
        kind: 'shortened',
        text: `The fleet didn't sail the full course in the feed; treating it as shortened (skipping ${dropped.join(', ')}).`,
        dropped,
      });
    }
  }

  // ---- the fleet's own turns at the top and bottom of the course. The mark
  // legs stand when they agree with them (or the geometry is unsure).
  const fleetBoats = data.boats.map((b) => ({ id: b.id, tr: tracks.get(b.id)!, finishMs: b.finishMs }));
  let fleet = fleetTurns(fleetBoats, gun);
  if (!fleet.confident) {
    // Wide one-tack beats can make the positions' principal axis run across the
    // course; retry along the wind from the first minutes' tacks.
    const hs: number[] = [];
    for (const b of data.boats) {
      const tr = tracks.get(b.id)!;
      if (windBoats.has(b.id)) for (const i of steadyIndices(tr, gun + 40_000, gun + 8 * 60_000)) hs.push(tr.heading[i]);
    }
    const early = estimateTwd(hs);
    const retry = early ? fleetTurns(fleetBoats, gun, bearingVec(early.twdDeg)) : null;
    if (retry?.confident) fleet = retry;
  }
  const marksAgree = wps.length > 0 && legsAgree(times, fleet.times, finishers.map((b) => b.id));
  /** Per consensus turn, the mark tracker it was snapped to; null when the mark legs are used. */
  let turnMarks: (Waypoint | null)[] | null = null;
  // A course with reaches (a triangle): the fleet's turns, every lap, with the listed marks its bent legs hide put back.
  const merged = !opts.noBentMarks && !fleet.confident && !marksAgree ? insertBentMarks(fleet, tracks, courseWps, finishers.map((b) => b.id)) : null;
  if (merged) {
    fleet = { ...fleet, turns: merged.turns, times: merged.times };
    turnMarks = merged.marks;
    times = merged.times;
    wps = [];
    legSource = 'course';
  } else if (fleet.confident && !marksAgree) {
    turnMarks = snapTurns(fleet, tracks, courseWps);
    times = fleet.times;
    wps = [];
    legSource = 'fleet';
  } else {
    notes.push(...markWarnings);
  }
  const nLegs = turnMarks ? turnMarks.length + 1 : wps.length + 1;
  const turnXY = (k: number): Vec => {
    const wp = turnMarks?.[k];
    if (!turnMarks) return centroid(wps[k].xy);
    return wp ? centroid(wp.at ? wp.at(fleet.turns[k].tMs) : wp.xy) : fleet.turns[k].xy;
  };

  // Roundings a telemetry hole leaves in doubt: approximate (~), or unknown so the
  // leg is left out (—) rather than timed to the next fix. Drawing keeps `times`.
  const medians = legMedians(times.values());
  const roundAt = Array.from({ length: nLegs - 1 }, (_, k): Targets => {
    const wp = turnMarks ? turnMarks[k] : wps[k];
    return wp ? targetsOf(wp) : [fleet.turns[k].xy];
  });
  const checked = new Map([...times].map(([id, tt]) => [id, checkBounds(tracks.get(id)!, tt, medians, roundAt)]));
  const legTimes = new Map([...checked].map(([id, c]) => [id, c.tt]));

  // Course side: toward the first mark, else where the fleet is a minute after the gun.
  let nrm: Vec = [-ldir[1], ldir[0]];
  const firstTarget = nLegs > 1 ? turnXY(0) : null;
  if (firstTarget) {
    if (dot(sub(firstTarget, lineMid), nrm) < 0) nrm = scale(nrm, -1);
  } else {
    const side = median(
      [...tracks.values()].map((tr) => dot(sub([interp(tr.t, tr.x, gun + 60_000), interp(tr.t, tr.y, gun + 60_000)], L), nrm)),
    );
    if (side < 0) nrm = scale(nrm, -1);
  }

  // Leg courses: the fleet's median displacement bearing over each leg, else
  // the bearing between the leg's ends (line, turns, finish).
  const finishPt = finishLine ? centroid([finishLine.left, finishLine.right]) : lineMid;
  const pts: Vec[] = [lineMid, ...Array.from({ length: nLegs - 1 }, (_, k) => turnXY(k)), finishPt];
  const legBearings = pts.slice(1).map((p, i) => vecBearing(sub(p, pts[i])));
  // Leg 1 alone: gun → each boat's first turn; with no turns, the first 8 min (at most half the race).
  const leg1 = new Map<string, (number | null)[]>();
  for (const b of data.boats) {
    const tt = legTimes.get(b.id)!;
    const end = nLegs > 1 ? tt[1] : Math.min(gun + 8 * 60_000, b.finishMs != null ? (gun + b.finishMs) / 2 : gun + 8 * 60_000);
    leg1.set(b.id, [gun, end]);
  }
  const courses = legBearings.map((fb, li) => (li === 0 && nLegs === 1 ? legCourse(tracks, leg1, 0) : legCourse(tracks, legTimes, li)) ?? fb);

  /** Steady headings over leg `li` (of `tm`) of every boat with a working compass, and the leg's mean mid-time over all. */
  const steady = (tm: Map<string, (number | null)[]>, li: number): { hs: number[]; mid: number | null } => {
    const hs: number[] = [];
    const mids: number[] = [];
    for (const b of data.boats) {
      const tt = tm.get(b.id)!;
      const a = tt[li];
      const e = tt[li + 1];
      if (a == null || e == null) continue;
      mids.push((a + e) / 2);
      if (!windBoats.has(b.id)) continue;
      const tr = tracks.get(b.id)!;
      for (const i of steadyIndices(tr, a, e)) hs.push(tr.heading[i]);
    }
    return { hs, mid: mids.length ? mids.reduce((x, y) => x + y, 0) / mids.length : null };
  };
  const legSteady = Array.from({ length: nLegs }, (_, li) => steady(legTimes, li));

  // Prior wind: the first leg is nearly always a beat, so its tacks (if they
  // straddle its course); else the model if it roughly agrees; else dead upwind.
  const modelAt = (t: number): number | null => {
    const s = data.windModel?.samples;
    if (!s?.length) return null;
    const ts = s.map((x) => x.t);
    if (t < ts[0] - 3 * 3_600_000 || t > ts[ts.length - 1] + 3 * 3_600_000) return null;
    return interpAngle(ts, s.map((x) => x.dirDeg), t);
  };
  const modelGun = modelAt(gun);
  const c1 = courses[0];
  const s1 = nLegs > 1 ? legSteady[0] : steady(leg1, 0);
  const est1 = estimateTwd(s1.hs);
  const tack1 = est1 && Math.abs(wrap180(est1.twdDeg - c1)) <= 60 ? est1 : null;
  const modelOk = modelGun != null && Math.abs(wrap180(modelGun - c1)) <= 45;
  const prior = tack1 ? tack1.twdDeg : modelOk ? modelGun! : c1;
  const kindAt = (li: number, twd: number): LegKind =>
    classifyLeg(courses[li], twd, straddles(legSteady[li].hs, twd), straddles(legSteady[li].hs, twd + 180));
  const priorKinds = courses.map((_, li) => kindAt(li, prior));

  // ---- wind from upwind tack headings, per beat
  const estimates: WindEstimate[] = [];
  for (let li = 0; li < nLegs; li++) {
    if (priorKinds[li] !== 'upwind') continue;
    const { hs, mid } = legSteady[li];
    const est = estimateTwd(hs);
    if (est && mid != null) estimates.push({ legIndex: li, tMs: mid, ...est, samples: hs.length });
  }
  // A one-leg race can still have a clean first beat.
  if (!estimates.length && tack1 && s1.mid != null) estimates.push({ legIndex: 0, tMs: s1.mid, ...tack1, samples: s1.hs.length });
  let method: WindInfo['method'] = 'tacks';
  if (!estimates.length) {
    if (modelOk) {
      method = 'model';
      notes.push({ kind: 'wind-model', text: 'Not enough steady upwind sailing to estimate the wind; using the weather model direction.' });
    } else {
      method = 'course';
      notes.push({
        kind: 'wind-assumed',
        text:
          modelGun != null
            ? `Not enough steady upwind sailing to estimate the wind, and the weather model (${Math.round(modelGun)}°) is far off the first leg's course; assuming the first leg is dead upwind.`
            : 'Not enough steady upwind sailing to estimate the wind; assuming the first leg is dead upwind.',
        modelDeg: modelGun != null ? Math.round(modelGun) : null,
      });
    }
  }
  // The wind at the gun: the fleet's close-hauled tacks from START_WIND_FROM_MS to START_WIND_TO_MS after it when Beat 1
  // is the first leg and they read as two plausible tacks (wind.ts readStartTwd); else Beat 1's estimate, held back.
  let startWindow: StartWind | null = null;
  let startWindowFail: StartWindFail | null = null;
  if (estimates[0]?.legIndex === 0) {
    const hs: number[] = [];
    const tm = nLegs > 1 ? legTimes : leg1;
    for (const b of data.boats) if (windBoats.has(b.id)) hs.push(...startWindHeadings(tracks.get(b.id)!, gun, tm.get(b.id)![1] ?? Infinity));
    const { est, fail } = readStartTwd(hs, closeHauledTackAngle((nLegs > 1 ? legSteady[0] : s1).hs));
    if (est && Math.abs(wrap180(est.twdDeg - c1)) <= 60) startWindow = { tMs: gun, ...est };
    else startWindowFail = fail ?? 'course';
  }
  const twdAt = makeTwdAt(windPoints({ estimates, startWindow }), prior);
  const twdGun = twdAt(gun);
  const kinds = courses.map((_, li) => kindAt(li, twdAt(legSteady[li].mid ?? gun)));
  // Unnamed turns: the top of the axis is windward when it points into the wind.
  const topIsWindward = dot(fleet.axis, bearingVec(twdGun)) >= 0;
  // A listed single mark is shown by its role when the legs into and out of every rounding of it make that clear
  // and the feed's title says otherwise (markLabel): a triangle's wing mark listed as "Leeward port" is the Reach mark.
  const roundedWps = Array.from({ length: nLegs - 1 }, (_, k) => (turnMarks ? turnMarks[k] : wps[k]));
  const roles = new Map<string, (MarkRole | null)[]>();
  roundedWps.forEach((wp, k) => {
    if (wp && wp.xy.length === 1 && !isOffset(wp)) roles.set(wp.key, [...(roles.get(wp.key) ?? []), markRole(kinds[k], kinds[k + 1])]);
  });
  const labelOf = (wp: Waypoint): string => (roles.has(wp.key) ? markLabel(wp.name, roles.get(wp.key)!) : wp.name);
  const turnName = (k: number): string => {
    const wp = roundedWps[k];
    if (wp) return labelOf(wp);
    return (fleet.turns[k].type === 'T') === topIsWindward ? 'Windward mark' : 'Leeward mark';
  };
  const counters: Record<LegKind, number> = { upwind: 0, downwind: 0, reach: 0 };
  const legs: LegDef[] = kinds.map((k, i) => ({
    index: i,
    kind: k,
    name: `${KIND_NAME[k]} ${++counters[k]}`,
    to: i < nLegs - 1 ? turnName(i) : 'Finish',
  }));
  // The reach marks put back must make a course: no mark (or estimated turn) twice running, no Beat after a Beat or
  // Run after a Run with no mark rounded between, and a reach on one side of each mark put back. Else main's legs.
  if (merged) {
    const key = (k: number): string => turnMarks![k]?.key ?? `est:${fleet.turns[k].type}`;
    const repeat = turnMarks!.some((_, k) => k > 0 && key(k) === key(k - 1));
    const same = kinds.some((k, i) => i > 0 && k !== 'reach' && k === kinds[i - 1]);
    const loose = merged.inserted.some((put, k) => put && kinds[k] !== 'reach' && kinds[k + 1] !== 'reach');
    if (repeat || same || loose) return analyzeRace(input, { ...opts, noBentMarks: true });
  }
  if (merged) {
    const est = [...new Set(legs.filter((_, i) => i < nLegs - 1 && !turnMarks![i]).map((l) => l.to.toLowerCase()))];
    if (est.length) {
      notes.push({
        kind: 'marks-est',
        text: `The ${listOf(est)} ${est.length > 1 ? "aren't" : "isn't"} in the feed's course: placed where the fleet turned (est.).`,
        est,
      });
    }
  } else if (turnMarks) notes.push(fleetWarning(data, courseWps, turnMarks, legs));
  if (data.finishLine && data.finishLineEstimated) {
    notes.push({ kind: 'finish-est', text: "The finish line isn't in the feed: it's placed off the committee boat from the tracks (est.)." });
  }

  // ---- line
  const w = bearingVec(twdGun);
  const uL = dot(L, w);
  const uR = dot(R, w);
  const favoredByM = Math.abs(uR - uL);
  const line: LineInfo = {
    left: L,
    right: R,
    lengthM: lineLen,
    bearingDeg: vecBearing(lineVec),
    favored: favoredByM < SQUARE_LINE_M ? 'square' : uL > uR ? 'left' : 'right',
    favoredByM,
  };

  // ---- per-boat metrics
  const sailOrder = [...data.boats].sort((a, b) => a.sail.localeCompare(b.sail, undefined, { numeric: true }));
  const finishOrder = finishers.map((b) => b.id);
  const results: BoatResult[] = [];
  const drawings: BoatDrawing[] = [];
  /**
   * One boat's figures and drawing. Unranked (a boat set aside): start figures only, no legs or finish place.
   * `tt` times the legs (checked: unknown roundings null), `drawTt` splits the drawn track, `gapS` marks approximate roundings.
   */
  const measure = (
    b: Boat,
    tr: XYTrack,
    tt: (number | null)[],
    ranked: boolean,
    drawTt = tt,
    gapS: (number | null)[] = [],
  ): { result: BoatResult; drawing: BoatDrawing } => {
    let start: StartResult | null = null;
    let trail: DrawnTrack = { x: new Float32Array(0), y: new Float32Array(0), t: new Float64Array(0), sog: new Float32Array(0) };
    // Smoothed at the full rate, before the drawn tracks are thinned to ~1 Hz.
    const sogSm = smoothSog(tr.t, tr.sog);
    let courseAtGun: number | null = null;
    let headingAtSample: number | null = null;
    // Tacks and gybes from the gun to the last leg end this boat reached (split by leg below).
    const ends = drawTt.filter((x): x is number => x != null);
    const lastEnd = ends.length > 1 ? ends[ends.length - 1] : null;
    const manoeuvres = ranked && lastEnd != null ? detectManoeuvres(tr, twdAt, gun, lastEnd) : [];
    // Leeward heel per fix (analysis/heel.ts), blanked around those manoeuvres; null when the feed has no roll.
    const heel = tr.roll ? heelSeries(tr.t, tr.roll, signedTwa(tr, twdAt).twa, manoeuvres, tr.pitch) : null;
    if (tr.t.length > 1 && tr.t[0] <= gun && tr.t[tr.t.length - 1] >= gun) {
      // DTL, line position and the bow are sampled where the source takes its
      // start fix (RaceSense: ~0.9 s before the gun), so ours checks against the
      // device's dtlMm. Bow offset is applied along heading, as the device does.
      const off = data.dtlSampleOffsetMs ?? 0;
      const ts = tr.t[0] <= gun - off ? gun - off : gun;
      const p: Vec = [interp(tr.t, tr.x, ts), interp(tr.t, tr.y, ts)];
      headingAtSample = interpAngle(tr.t, tr.heading, ts);
      const hdg = interpAngle(tr.t, tr.heading, gun);
      const bow = add(p, scale(bearingVec(headingAtSample), b.bowOffsetM));
      const dtl = -dot(sub(bow, L), nrm);
      // Velocity toward the course side at the gun (numpy.gradient, then interpolated).
      // xs in ms → gradient is m/ms; ×1000 gives m/s. Only the samples around the
      // gun are read — do not copy the whole ~5 Hz series.
      const i = Math.max(0, Math.min(tr.t.length - 2, rangeIdx(tr.t, gun, gun)[0] - 1));
      const v = (k: number): Vec => [gradientAt(tr.t, tr.x, k) * 1000, gradientAt(tr.t, tr.y, k) * 1000];
      const f = tr.t[i + 1] === tr.t[i] ? 0 : (gun - tr.t[i]) / (tr.t[i + 1] - tr.t[i]);
      const vel = add(scale(v(i), 1 - f), scale(v(i + 1), f));
      const vperp = dot(vel, nrm);
      courseAtGun = len(vel) > 0.15 ? vecBearing(vel) : hdg;
      // The public track is lossy near the gun: judge the sample by the nearest real point
      // and by the hole it sits in (a neighbour within 2 s still interpolates across > 5 s).
      const gap = sampleGap(tr.t, ts);
      // Across a hole: the DTL estimated from the nearest fix (its bow, carried on at its SOG along its heading), for estPlace.
      const dtlAtFix = (k: number): number => -dot(sub(add([tr.x[k], tr.y[k]], scale(bearingVec(tr.heading[k]), b.bowOffsetM)), L), nrm);
      const vAtFix = (k: number): number => (Number.isFinite(tr.sog[k]) && Number.isFinite(tr.heading[k]) ? (tr.sog[k] / MS_TO_KN) * dot(bearingVec(tr.heading[k]), nrm) : 0);
      const estDtlM = gap ? estimateDtl(tr.t, ts, dtl, dtlAtFix, vAtFix) : null;
      start = {
        estDtlM,
        estPlace: null,
        dtlM: dtl,
        secsLate: dtl / Math.max(vperp, 0.3),
        vToLineMs: vperp,
        linePosPct: (100 * dot(sub(bow, L), ldir)) / lineLen,
        speedKn: interp(tr.t, tr.sog, gun),
        headingDeg: hdg,
        twaDeg: wrap180(twdGun - hdg),
        heelAtGunDeg: heel ? heelAt(heel, gun) : null,
        bow,
        ocs: !!b.ocs,
        rcDtlM: b.rc ? b.rc.dtlM : (b.rcDtlM ?? null),
        rcStatus: b.rc?.status ?? (b.rcDtlM != null ? 'ok' : 'none'),
        rcNote: b.rc?.note ?? null,
        dtlGapS: gap?.gapS ?? null,
        dtlNote: gap?.note ?? null,
        // Filled in once the fleet's speed floor is known.
        lateS: null,
        rank: null,
        over: false,
        startPlace: null,
        warn: null,
        ocsBlind: false,
        awayFromLine: false,
      };
      // START_TRAIL_MS of the tracker up to the DTL sample, translated by that
      // sample's bow offset so the polyline ends exactly on the bow used for DTL.
      const [t0, t1] = rangeIdx(tr.t, gun - START_TRAIL_MS, ts);
      const dx = bow[0] - p[0];
      const dy = bow[1] - p[1];
      const needTip = t1 === t0 || tr.t[t1 - 1] < ts - 50;
      const n = t1 - t0 + (needTip ? 1 : 0);
      const xs = new Float32Array(n);
      const ys = new Float32Array(n);
      const tk = new Float64Array(n);
      const sk = new Float32Array(n);
      for (let k = 0; k < t1 - t0; k++) {
        xs[k] = tr.x[t0 + k] + dx;
        ys[k] = tr.y[t0 + k] + dy;
        tk[k] = tr.t[t0 + k];
        sk[k] = sogSm[t0 + k];
      }
      xs[n - 1] = bow[0];
      ys[n - 1] = bow[1];
      if (needTip) {
        tk[n - 1] = ts;
        sk[n - 1] = interp(tr.t, sogSm, ts);
      }
      trail = { x: xs, y: ys, t: tk, sog: sk };
    }

    const moves = ranked && lastEnd != null ? manoeuvresByLeg(manoeuvres, tt, legs.map((l) => l.kind)) : [];
    const legResults: (LegResult | null)[] = [];
    for (let li = 0; li < nLegs; li++) {
      const a = tt[li];
      const e = tt[li + 1];
      if (!ranked || a == null || e == null || e <= a) {
        legResults.push(null);
        continue;
      }
      const T = (e - a) / 1000;
      const twdl = twdAt((a + e) / 2);
      const disp: Vec = [interp(tr.t, tr.x, e) - interp(tr.t, tr.x, a), interp(tr.t, tr.y, e) - interp(tr.t, tr.y, a)];
      const vmg = (Math.abs(dot(disp, bearingVec(twdl))) / T) * MS_TO_KN;
      const [i0, i1] = rangeIdx(tr.t, a, e);
      let idx = T > 40 ? steadyIndices(tr, a, e) : [];
      if (!idx.length) idx = Array.from({ length: i1 - i0 }, (_, k) => i0 + k);
      const twa = median(idx.map((k) => Math.abs(wrap180(twdl - tr.heading[k]))));
      const dist = pathDistance(tr.t, tr.x, tr.y, a, e);
      const bGaps = [gapS[li], gapS[li + 1]].filter((g): g is number => g != null);
      const mv = moves[li];
      const cov = coverage(tr.t, a, e);
      const hs = heel ? heelStats(heel, a, e) : null;
      // SOG is Dist (the interpolated path) ÷ time, in knots.
      legResults.push({
        startMs: a,
        endMs: e,
        timeS: T,
        sogKn: dist.distM / M_PER_NM / (T / 3600),
        vmgKn: vmg,
        twaDeg: twa,
        rankAtEnd: null,
        timeGapS: bGaps.length ? Math.max(...bGaps) : null,
        ...dist,
        progress: dist.distM > 0 ? Math.hypot(disp[0], disp[1]) / dist.distM : null,
        tacks: mv?.tacks ?? 0,
        gybes: mv?.gybes ?? 0,
        manoeuvreGap: mv?.gap ?? false,
        coverage: cov.coverage,
        maxGapS: cov.maxGapS,
        heelDeg: hs?.heelDeg ?? null,
        heelS: hs?.heelS ?? 0,
        trimDeg: hs?.trimDeg ?? null,
        heelCoverage: hs ? hs.coverage : null,
      });
    }

    let raceTimeS: number | null = null;
    let sogAvgKn: number | null = null;
    let distM: number | null = null;
    let distApprox = false;
    if (ranked && b.finishMs != null && b.finishMs > gun) {
      raceTimeS = (b.finishMs - gun) / 1000;
      // Gun → finish in one pass; equals the sum of the legs when every leg was split.
      const d = pathDistance(tr.t, tr.x, tr.y, gun, b.finishMs);
      distM = d.distM;
      distApprox = d.distGapS != null;
      sogAvgKn = d.distM / M_PER_NM / (raceTimeS / 3600);
    }
    // Coverage over the race: gun → finish, else gun → the last leg end reached.
    const covEnd = ranked ? (b.finishMs != null && b.finishMs > gun ? b.finishMs : lastEnd) : null;
    const raceCov = covEnd != null && covEnd > gun ? coverage(tr.t, gun, covEnd) : null;
    const pos = ranked ? finishOrder.indexOf(b.id) : -1;
    // Official results: their place stands (the finish order by time can differ: penalties, a boat with no tracked finish).
    const official = data.results?.places === 'official';
    const result: BoatResult = {
      id: b.id,
      sail: b.sail,
      name: b.name,
      colorSlot: ranked ? sailOrder.indexOf(b) : -1,
      finishPos: official ? (ranked ? (b.officialPlace ?? null) : null) : pos >= 0 ? pos + 1 : null,
      ...(b.officialCode ? { finishCode: b.officialCode } : {}),
      ...(official && b.officialPoints != null ? { scoredPoints: b.officialPoints } : {}),
      ...(official && ranked && b.officialCode && b.onWaterPlace != null ? { onWaterPlace: b.onWaterPlace, ...(b.penaltyPlaces != null ? { penaltyPlaces: b.penaltyPlaces } : {}) } : {}),
      ...(b.finishSource ? { finishSource: b.finishSource } : {}),
      finishMs: b.finishMs,
      raceTimeS,
      sogAvgKn,
      distM,
      distApprox,
      coverage: raceCov?.coverage ?? null,
      maxGapS: raceCov?.maxGapS ?? null,
      start,
      legs: legResults,
      upwind: ranked ? kindSummary(legResults, legs, 'upwind') : null,
      downwind: ranked ? kindSummary(legResults, legs, 'downwind') : null,
      headingSource: headings.get(b.id)?.source ?? 'device',
      headingOffDeg: headings.get(b.id)?.offDeg ?? null,
      ...(b.bowOffsetM > 0 ? { bowOffsetM: b.bowOffsetM } : {}),
      ...(b.log ? { log: b.log } : {}),
    };

    const segments: TrackSegment[] = [];
    // With no finish, the last leg runs to the boat's own crossing of the finish line (plus a short tail), else to its last fix.
    const openEnd = (from: number): number => (ranked && b.finishMs == null ? unfinishedDrawEnd(b, from) : tr.t[tr.t.length - 1]);
    for (let li = 0; li < nLegs; li++) {
      const a = drawTt[li];
      const e = drawTt[li + 1] ?? (li === nLegs - 1 && a != null ? openEnd(a) : null);
      if (a == null || e == null) continue;
      const [i0, i1] = rangeIdx(tr.t, a, e);
      const xs: number[] = [];
      const ys: number[] = [];
      const ts: number[] = [];
      const ss: number[] = [];
      const rs: number[] = [];
      let last = -Infinity;
      for (let k = i0; k < i1; k++) {
        if (tr.t[k] - last < 1000 && k !== i1 - 1) continue;
        last = tr.t[k];
        xs.push(tr.x[k]);
        ys.push(tr.y[k]);
        ts.push(tr.t[k]);
        ss.push(sogSm[k]);
        if (tr.roll) rs.push(tr.roll[k]);
      }
      segments.push({
        leg: li,
        x: Float32Array.from(xs),
        y: Float32Array.from(ys),
        t: Float64Array.from(ts),
        sog: Float32Array.from(ss),
        ...(tr.roll ? { roll: Float32Array.from(rs) } : {}),
      });
    }
    // The map's scrubber opens before the gun: every fix from MAP_PRE_MS before it to where the segments take over.
    const [p0, p1] = rangeIdx(tr.t, gun - MAP_PRE_MS, segments[0]?.t[0] ?? gun);
    const pre: TrackSegment = {
      leg: PRE_LEG,
      x: Float32Array.from(tr.x.subarray(p0, p1)),
      y: Float32Array.from(tr.y.subarray(p0, p1)),
      t: tr.t.slice(p0, p1),
      sog: sogSm.slice(p0, p1),
      ...(tr.roll ? { roll: Float32Array.from(tr.roll.subarray(p0, p1)) } : {}),
    };
    // Speed through the start: every fix around the gun, smoothed SOG (the chart breaks lines at gaps).
    const [s0, s1] = rangeIdx(tr.t, gun - START_SOG_PRE_MS, gun + START_SOG_POST_MS);
    const drawing: BoatDrawing = {
      id: b.id,
      trail,
      startSog: { t: tr.t.slice(s0, s1), sog: sogSm.slice(s0, s1) },
      bow: start?.bow ?? null,
      headingAtGun: start?.headingDeg ?? null,
      headingAtSample,
      courseAtGun,
      segments,
      pre,
      // Display only: the feed's own holes, so the maps judge gaps on its fixes, not the thinned segments.
      holes: rawHoles(tr.t, tr.x, tr.y, sogSm, gun - MAP_PRE_MS),
    };
    return { result, drawing };
  };
  for (const b of data.boats) {
    const m = measure(b, tracks.get(b.id)!, legTimes.get(b.id)!, true, times.get(b.id)!, checked.get(b.id)!.gapS);
    results.push(m.result);
    drawings.push(m.drawing);
  }
  // Impossible splits (legs.ts legSplitOk: a glitch-timed rounding, a second device on the sail) are unknown everywhere.
  if (dropImpossibleLegs(results.map((r) => r.legs))) {
    for (const r of results) {
      r.upwind = kindSummary(r.legs, legs, 'upwind');
      r.downwind = kindSummary(r.legs, legs, 'downwind');
    }
  }

  // Boats set aside: drawn over the fleet's median leg times (their own turns
  // aren't legs), up to the last competitor's finish or the end of the track.
  const fleetTimes = Array.from({ length: nLegs + 1 }, (_, k) => {
    if (k === 0) return gun;
    const ts = data.boats.map((b) => times.get(b.id)![k]).filter((t): t is number => t != null);
    if (!ts.length) return null;
    return k === nLegs ? Math.max(...ts) : median(ts);
  });
  const excluded = setAside.map((b) => {
    const m = measure(b, prepare(b), fleetTimes, false);
    return { ...m, reasons: participation.get(b.id)!.reasons };
  });

  // A boat stalled or reaching along the line at the gun has ~0 speed toward it;
  // judge its lateness against half the fleet's typical approach speed instead.
  const approach = results.filter((r) => r.start && r.start.vToLineMs > 0).map((r) => r.start!.vToLineMs);
  const vFloor = Math.max(0.3, approach.length ? 0.5 * median(approach) : 0.3);
  // One boat kilometres out must not take the "furthest back" place or stretch the Fit.
  const absDtl = (r: BoatResult): number => Math.abs(startDtlM(r.start!));
  const withBow = results.filter((r) => r.start);
  const awayThresh = awayFromLineThresholdM(withBow.map(absDtl));
  if (withBow.filter((r) => absDtl(r) <= awayThresh).length >= 3) {
    for (const r of withBow) r.start!.awayFromLine = absDtl(r) > awayThresh;
  }
  for (const r of results) {
    if (!r.start) continue;
    r.start.secsLate = r.start.dtlM / Math.max(r.start.vToLineMs, vFloor);
    Object.assign(r.start, assessStart(r.start));
  }
  rankStarts(results);
  // Set-aside boats keep their figures for the chart label, but no place and no flags (a spare on the committee boat is "OCS").
  for (const { result: r } of excluded) {
    if (!r.start) continue;
    r.start.secsLate = r.start.dtlM / Math.max(r.start.vToLineMs, vFloor);
    Object.assign(r.start, assessStart(r.start), { ocs: false, over: false, ocsBlind: false, warn: null, startPlace: null, estPlace: null });
  }

  // Rank at each mark: among every boat with a known time there (its leg may be unknown when only its start was lost).
  for (let li = 0; li < nLegs; li++) {
    const at = (r: BoatResult): number | null => legTimes.get(r.id)![li + 1];
    const done = results.filter((r) => at(r) != null).sort((a, b) => at(a)! - at(b)!);
    done.forEach((r, k) => {
      if (r.legs[li]) r.legs[li]!.rankAtEnd = k + 1;
    });
  }
  placeSummaries(results, 'upwind');
  placeSummaries(results, 'downwind');
  // Finish order on the water: a boat that finished with a code (DPI, …) sits at its on-water place.
  results.sort((a, b) => (finishRank(a) ?? 1e9) - (finishRank(b) ?? 1e9) || (a.finishPos == null ? 1 : 0) - (b.finishPos == null ? 1 : 0) || a.colorSlot - b.colorSlot);

  const wind: WindInfo = {
    method,
    estimates,
    gunSource: method === 'tacks' ? (startWindow ? 'start-window' : 'beat') : null,
    startWindow,
    startWindowFail,
    twdAtGunDeg: twdGun,
    model: modelGun != null && data.windModel ? { label: data.windModel.label, dirAtGunDeg: modelGun } : null,
  };
  // Draw each rounding where the mark was when the fleet rounded it (it may have been moved since).
  const drawnMarks: RaceAnalysis['marks'] = [];
  const turnWps = turnMarks ?? wps;
  turnWps.forEach((wp, i) => {
    const ts = data.boats.map((b) => times.get(b.id)![i + 1]).filter((t): t is number => t != null);
    if (!wp) {
      // A turn with no tracker: drawn hollow where the fleet turned (one per name unless clearly apart).
      const xy = fleet.turns[i].xy;
      const name = legs[i].to;
      addDrawnMark(drawnMarks, { name, xy: [xy], estimated: true }, { replaceEstimate: true });
      return;
    }
    const xy = wp.at && ts.length ? wp.at(median(ts)) : wp.xy;
    const name = labelOf(wp);
    addDrawnMark(drawnMarks, { name, xy, ...(name !== wp.name ? { title: wp.name } : {}) }, { replaceEstimate: true });
  });
  // Trackers no leg ends at (an offset, or every mark when there is one leg).
  // Never pile a second name on a turn already drawn (M1/M2 overlapping at the top).
  if (turnMarks) {
    const used = new Set(turnMarks.map((w) => w?.key));
    for (const wp of courseWps) {
      if (used.has(wp.key)) continue;
      used.add(wp.key);
      addDrawnMark(drawnMarks, { name: wp.name, xy: wp.xy });
    }
  } else if (!wps.length) for (const wp of courseWps) addDrawnMark(drawnMarks, { name: wp.name, xy: wp.xy });
  const real = drawnMarks.filter((m) => !m.estimated);
  const moved = real.filter((m, i) => real.findIndex((o) => o.name === m.name && o.title === m.title) !== i).map((m) => m.name);
  if (moved.length) {
    const names = [...new Set(moved)];
    notes.push({ kind: 'marks-moved', text: `${names.join(', ')} moved during the race; legs use the mark's position at the time.`, names });
  }

  // The Vakaros DTL is the primary figure; ours is a check. Flag it when they clearly disagree.
  const rcDiff = results
    .filter((r) => r.start?.rcDtlM != null && r.start.dtlGapS == null)
    .map((r) => Math.abs(r.start!.rcDtlM! - r.start!.dtlM));
  if (rcDiff.length >= 3 && median(rcDiff) > 3) {
    const medianM = Math.round(median(rcDiff));
    notes.push({ kind: 'dtl-off', text: `Vakaros DTL differs from the GPS tracks by a median ${medianM} m for this start; treat the DTL columns with caution.`, medianM });
  }
  if (excluded.length) {
    const n = excluded.length;
    notes.push({
      kind: 'not-racing',
      text: `${n} boat${n > 1 ? 's' : ''} hidden as not racing (coach boats, spare or second trackers); ${n > 1 ? 'they are' : 'it is'} listed at the foot of the boat list.`,
      n,
    });
  }

  const analysis: RaceAnalysis = {
    meta: {
      eventName: data.eventName,
      division: data.division,
      boatClass: data.boatClass,
      ...(data.classLabel ? { classLabel: data.classLabel } : {}),
      raceNumber: data.raceNumber,
      gunMs: gun,
      tzOffsetMs: data.tzOffsetMs,
      sourceLabel: data.source.label,
      sourceKind: data.source.kind,
      eventId: data.source.eventId,
      ...(data.results ? { results: data.results } : {}),
    },
    line,
    finishLine,
    ...(finishLine && data.finishLineEstimated ? { finishLineEstimated: true } : {}),
    marks: drawnMarks,
    legs,
    legPts: pts,
    legSource,
    wind,
    boats: results,
    drawings,
    excluded,
    findings: [],
    notes,
    warnings: notes.map((n) => n.text),
    hasHeel: results.some((r) => r.start?.heelAtGunDeg != null || r.legs.some((l) => l?.heelDeg != null)),
  };
  if (opts.allCompetitors) analysis.allCompetitors = { flagged: flagged.length };
  analysis.findings = buildFindings(analysis);
  return analysis;
}
