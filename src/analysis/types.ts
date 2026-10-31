import type { BoatLog, RaceResults, RcStatus, TimeSource } from '../data/types';
import type { FinishThrough } from './finishThrough';
import type { Vec } from './geo';

/** How much track before the start fix the start chart draws behind each boat. */
export const START_TRAIL_MS = 60_000;
/** Speed through the start: full-rate smoothed SOG kept from this long before the gun… */
export const START_SOG_PRE_MS = 120_000;
/** …to this long after it. */
export const START_SOG_POST_MS = 20_000;
/** The track map's race-time window opens this long before the gun (BoatDrawing.pre covers it). */
export const MAP_PRE_MS = 120_000;
/** The `leg` of track before the gun (BoatDrawing.pre): no leg, "pre-start". */
export const PRE_LEG = -1;

export type LegKind = 'upwind' | 'downwind' | 'reach';

export interface LegDef {
  index: number;
  /** e.g. "Beat 1", "Run 2", "Reach 1". */
  name: string;
  kind: LegKind;
  /** Name of the waypoint this leg ends at ("Finish" for the last). */
  to: string;
}

export interface LegResult {
  startMs: number;
  endMs: number;
  timeS: number;
  /** Path length / time. */
  sogKn: number;
  /** Displacement along the (estimated) wind axis / time. */
  vmgKn: number;
  /** Median |TWA| while sailing steadily, vs estimated wind. */
  twaDeg: number;
  /** Rank at the end of this leg among boats that completed it. */
  rankAtEnd: number | null;
  /** A rounding at either end is timed inside (or at the fix next to) a telemetry hole over SPAN_MS: that hole, s; null = clear (legs.ts checkBounds). */
  timeGapS: number | null;
  /** Distance sailed along the GPS track, m. */
  distM: number;
  /**
   * Progress ratio (Chris's Progress ÷ Dist): the straight line from where the boat started the leg to where it
   * ended it (its rounding, or its finish) ÷ the distance it sailed; 0–1, null when it sailed no distance.
   */
  progress: number | null;
  /** Longest telemetry hole (> SPAN_MS) the distance bridges with a straight line, s; null = none. */
  distGapS: number | null;
  /** Tacks and gybes on the leg (analysis/manoeuvres.ts). */
  tacks: number;
  gybes: number;
  /** Some tack or gybe on the leg bridges a telemetry gap: the counts are approximate. */
  manoeuvreGap: boolean;
  /** Fraction of the leg's time covered by fixes ≤ COVERAGE_GAP_S apart (analysis/coverage.ts), 0–1. */
  coverage: number;
  /** Longest interval between fixes on the leg, s. */
  maxGapS: number;
  /** Time-weighted mean leeward heel (analysis/heel.ts), ° (+ = to leeward), manoeuvres left out; null with no usable heel. */
  heelDeg: number | null;
  /** Time the heel mean rests on, s. */
  heelS: number;
  /** Time-weighted mean trim (feed `pitch`), °; null with none. */
  trimDeg: number | null;
  /** Share of the leg with heel readings, 0–1; null when the track has no heel at all. */
  heelCoverage: number | null;
}

/**
 * One boat's legs of one kind (upwind or downwind; reaches are in neither)
 * added up: sums of time, distance and manoeuvres; SOG = distance ÷ time;
 * VMG, |TWA|, coverage and trim time-weighted over the legs; heel over every
 * fix it rests on (each leg weighted by its heel time).
 */
export interface KindSummary {
  /** Legs of this kind the boat completed, of `of` in the race. */
  legs: number;
  of: number;
  /** Every leg of the kind completed; otherwise a partial sum with no place. */
  complete: boolean;
  timeS: number;
  distM: number;
  /** Some leg's distance bridges a telemetry gap. */
  distApprox: boolean;
  /** Some leg's rounding is timed across a telemetry gap. */
  timeApprox: boolean;
  sogKn: number;
  vmgKn: number;
  twaDeg: number;
  tacks: number;
  gybes: number;
  /** Some tack or gybe bridges a telemetry gap. */
  manoeuvreApprox: boolean;
  coverage: number;
  maxGapS: number;
  /** Leeward heel, °; null when no leg has any. */
  heelDeg: number | null;
  trimDeg: number | null;
  /** Share of the legs' time with heel readings (leg-time weighted); null when the track has no heel. */
  heelCoverage: number | null;
  /** Place by total time among boats with every leg of the kind (competition ranking); null when incomplete. */
  place: number | null;
}

export interface StartResult {
  /** Our bow distance behind the line at the start (sampled at `RaceData.dtlSampleOffsetMs` before the gun), m (negative = over). */
  dtlM: number;
  /** DTL / speed toward the line at the gun (speed floored at half the fleet median). */
  secsLate: number;
  /** Velocity toward the course side at the gun, m/s. */
  vToLineMs: number;
  /** 0 = left (pin) end, 100 = right (RC) end. */
  linePosPct: number;
  speedKn: number;
  headingDeg: number;
  /** Signed TWA vs estimated wind: + = starboard tack, - = port. */
  twaDeg: number;
  /** Leeward heel at the gun (nearest fix within HEEL_AT_GUN_MS, analysis/heel.ts), °; null without one. */
  heelAtGunDeg: number | null;
  bow: Vec;
  ocs: boolean;
  /** The boat's Vakaros device's own DTL (feed `dtlMm`), m; null unless `rcStatus` is 'ok'. */
  rcDtlM: number | null;
  rcStatus: RcStatus;
  /** Why the Vakaros figure is unavailable, if it is. */
  rcNote: string | null;
  /** Set when our `dtlM` is interpolated across a telemetry gap (nearest point > GAP_MS, or bracketing hole > SPAN_MS): the gap, s. */
  dtlGapS: number | null;
  /** Why our `dtlM` is unreliable, if it is. */
  dtlNote: string | null;
  /** Seconds late shown to users: `secsLate`, or null when our DTL is gap-interpolated. */
  lateS: number | null;
  /** The one value starts are ranked by: Vakaros when valid, else ours when valid; null = unranked. */
  rank: { m: number; source: 'vakaros' | 'ours' } | null;
  /** Race control called it over early: the RaceSense OCS flag (`ocs`) or an official OCS / UFD / BFD (validity.ts calledOver). */
  over: boolean;
  /** Place among clean starters (1 = closest to the line); null when over, unranked or away from the line. */
  startPlace: number | null;
  /** Our DTL at the sample estimated across the hole it sits in (validity.ts estimateDtl), m; null when not interpolated or the hole is too long. */
  estDtlM?: number | null;
  /**
   * Place at the gun among every boat on the line (validity.ts rankStarts): the ranked ones in `startPlace` order, the
   * gap-interpolated ones placed between them by `estDtlM`; null when over, away or unknown. An estimate: never shown as the start place.
   */
  estPlace?: number | null;
  /** Bow is far from the line at the gun: listed as away, left out of Fit and start places. */
  awayFromLine: boolean;
}

export interface BoatResult {
  id: string;
  sail: string;
  name: string;
  /** Stable colour slot (by sail order), independent of result; -1 when set aside as not racing. */
  colorSlot: number;
  /**
   * The result's place: the official place when linked (null with a code), else the tracked finish order. A boat
   * that finished with a code has none here: its place in the finish order is `onWaterPlace` (result.ts finishRank).
   */
  finishPos: number | null;
  finishMs: number | null;
  /** Official scoring code (DSQ, DNF, …) when official results are linked; finishPos is then null. */
  finishCode?: string;
  /** The official race score (points), coded or not, when linked. */
  scoredPoints?: number;
  /**
   * A boat that finished with a code (DPI, SCP, …; DSQ / UFD / BFD with a finish time): its place on the water
   * among the official finishers (where it would be without the code), and the places the code cost (scored
   * points − that, ≥ 0, to 0.1). It keeps its finish, race time and legs.
   */
  onWaterPlace?: number;
  penaltyPlaces?: number;
  /** Where finishMs came from, when the race's results were resolved ('tracker': a finish-line crossing, shown as ~). */
  finishSource?: TimeSource;
  raceTimeS: number | null;
  sogAvgKn: number | null;
  /** Distance sailed gun → finish, m (the sum of the legs); null without a finish. */
  distM: number | null;
  /** Some leg's distance bridges a telemetry gap (see `LegResult.distGapS`). */
  distApprox: boolean;
  /** Fraction of the race (gun → finish, else gun → the last leg completed) covered by fixes; null with no legs. */
  coverage: number | null;
  /** Longest interval between fixes over that span, s; null with no legs. */
  maxGapS: number | null;
  start: StartResult | null;
  legs: (LegResult | null)[];
  /** The upwind and downwind legs added up; null when the race has none of that kind or the boat completed none. */
  upwind: KindSummary | null;
  downwind: KindSummary | null;
  /** How far the bow is ahead of the tracker, m (Boat.bowOffsetM, resolved by classes.ts bowAheadM); absent when 0. */
  bowOffsetM?: number;
  /** Where heading-based figures (TWA, start heading, bow) come from: the device, or the GPS course when the compass is far off it (manoeuvres.ts headingCheck). */
  headingSource: 'device' | 'cog';
  /** Median |device heading − course over ground| at speed, °; null with too few fixes. */
  headingOffDeg: number | null;
  /** The track comes (in part) from the boat's own uploaded log. */
  log?: BoatLog;
}

export interface WindEstimate {
  legIndex: number;
  /** Mid-time of the leg across the fleet. */
  tMs: number;
  twdDeg: number;
  tackAngleDeg: number;
  samples: number;
}

/** The wind at the gun from the fleet's tacks in the minutes after it (wind.ts readStartTwd). */
export interface StartWind {
  /** The gun. */
  tMs: number;
  twdDeg: number;
  tackAngleDeg: number;
  /** Close-hauled headings (each a boat's reading, START_WIND_GRID_MS apart)… */
  samples: number;
  /** …of this many steady ones. */
  steady: number;
  /** Close-hauled headings on each tack. */
  tackSamples: [number, number];
}

/** Why the gun window gave no wind (wind.ts readStartTwd; 'course': more than 60° off Beat 1's course). */
export type StartWindFail = 'samples' | 'tack-samples' | 'tack-share' | 'tack-angle' | 'course';

export interface WindInfo {
  method: 'tacks' | 'model' | 'course';
  /** Per beat, each pinned at the beat's mid-time. */
  estimates: WindEstimate[];
  /**
   * Where the wind at the gun came from (method 'tacks' only, else null): the fleet's tacks in the first minutes
   * after the gun ('start-window', `startWindow` pinned at the gun), or the first beat's estimate held back to it.
   */
  gunSource: 'start-window' | 'beat' | null;
  /** Set when `gunSource` is 'start-window'. */
  startWindow: StartWind | null;
  /** Why the gun window gave none, when `gunSource` is 'beat' and Beat 1 is the first leg. */
  startWindowFail: StartWindFail | null;
  twdAtGunDeg: number;
  model: { label: string; dirAtGunDeg: number } | null;
}

export interface LineInfo {
  left: Vec;
  right: Vec;
  lengthM: number;
  bearingDeg: number;
  favored: 'left' | 'right' | 'square';
  /** How much further upwind the favoured end is, m. */
  favoredByM: number;
}

/** A drawn run of track: positions with, per point, the fix time and SOG for Colour: Boat speed. */
export interface DrawnTrack {
  x: Float32Array;
  y: Float32Array;
  /** Fix time, ms since epoch. */
  t: Float64Array;
  /** SOG, kn, smoothed over SOG_SMOOTH_MS (analysis/smooth.ts) on the full-rate track. */
  sog: Float32Array;
}

export interface TrackSegment extends DrawnTrack {
  leg: number;
  /** Roll per point, degrees (− = heeled to port; NaN = no reading); absent when the source has none. */
  roll?: Float32Array;
}

/**
 * The feed's own holes, for the maps only (analysis/rawHoles.ts): its usual step, the hole threshold, and the fixes
 * around every hole (the drawn segments are thinned and can't tell a hole from a skipped fix).
 */
export interface RawHoles {
  stepMs: number;
  holeMs: number;
  /** The time of the fix before each hole (the next fix in `edges` ends it). */
  at: Float64Array;
  edges: DrawnTrack;
}

export interface BoatDrawing {
  id: string;
  /** START_TRAIL_MS (60 s) of track up to the DTL sample, shifted so the last point is the bow. */
  trail: DrawnTrack;
  bow: Vec | null;
  /** Compass heading at the gun (TWA). */
  headingAtGun: number | null;
  /** Heading at the DTL sample, used to project `bow` — the to-scale hull points this way. */
  headingAtSample: number | null;
  /** Course over ground at the gun — used for the start arrow. */
  courseAtGun: number | null;
  /** Gun → finish, ~1 Hz, split by leg. */
  segments: TrackSegment[];
  /**
   * MAP_PRE_MS before the gun up to the first segment's first fix (shared with it), every fix at the
   * feed's own rate, leg PRE_LEG: the track map's race-time scrubber draws it. Absent in older analyses.
   */
  pre?: TrackSegment;
  /** The feed's holes from the pre-gun track on (display only: the maps' gap fill). Absent in older analyses. */
  holes?: RawHoles;
  /**
   * Display only: the point on the finish line its last segment was drawn through at its finish time, when that fell
   * between fixes far apart (finishThrough.ts); the full-rate track gets it too (fullRate.ts).
   */
  finish?: FinishThrough;
  /** Every fix from START_SOG_PRE_MS before the gun to START_SOG_POST_MS after: time and smoothed SOG (gaps left as they are). */
  startSog: { t: Float64Array; sog: Float32Array };
}

/**
 * One boat's track at full rate for the zoomed-in map (analysis/fullRate.ts): MAP_PRE_MS before the
 * gun to its last drawn fix, in the drawings' coordinates, from the boat's uploaded log (Boat.fullRate,
 * 10 Hz) when it has one, else every fix of the feed. Asked of the worker only when the map zooms in.
 */
export interface FullRateTrack extends DrawnTrack {
  id: string;
  /** 'log': Boat.fullRate; 'feed': the feed's own fixes, before the drawings' ~1 Hz thinning. */
  source: 'log' | 'feed';
  roll?: Float32Array;
}

export interface Finding {
  kind: 'start' | 'line' | 'leg' | 'wind' | 'result';
  text: string;
  /** The boats this finding is about, if any. */
  boatIds?: string[];
  /** The best and worst start side by side (a 'start' finding); `text` is its plain-text form. */
  compare?: StartCompare;
}

/** One boat's column in a start comparison: its tag (its sail number and name apart, for the button) and one value per row. */
export interface StartCompareSide {
  id: string;
  tag: string;
  sail: string;
  name: string | null;
  values: string[];
}

/** The best and worst clean starts (by start place) under the same row labels; no worst with one clean starter. */
export interface StartCompare {
  rows: string[];
  best: StartCompareSide;
  worst: StartCompareSide | null;
  /** Who was left out (over early, away from the line), if anyone. */
  note: string | null;
}

/** A data caveat about the race: its full sentence (`text`) and what a short chip and bullet need. */
export type RaceNote =
  | { kind: 'legs-fleet'; text: string; silent: string[]; tracked: string[]; est: string[]; offset: boolean }
  | { kind: 'leg-order'; text: string }
  | { kind: 'shortened'; text: string; dropped: string[] }
  | { kind: 'wind-model'; text: string }
  | { kind: 'wind-assumed'; text: string; modelDeg: number | null }
  | { kind: 'marks-moved'; text: string; names: string[] }
  | { kind: 'not-racing'; text: string; n: number }
  | { kind: 'finish-est'; text: string }
  | { kind: 'marks-est'; text: string; est: string[] }
  | { kind: 'finish-unranked'; text: string; boat: string; why: string };

export interface RaceAnalysis {
  meta: {
    eventName: string;
    division: string;
    boatClass: string;
    /** The event's class label (landing list), when known. */
    classLabel?: string;
    raceNumber: number;
    gunMs: number;
    tzOffsetMs: number;
    sourceLabel: string;
    sourceKind: string;
    eventId?: string;
    /** Where places and finish times came from (official results, tracker crossings), when resolved. */
    results?: RaceResults;
    /**
     * The race is still being sailed (analysis: AnalyzeOptions.inProgress; the app sets it again from its live rule,
     * data/live.ts raceLive): a boat with no finish and no code is racing, not a DNF.
     */
    inProgress?: boolean;
  };
  line: LineInfo;
  finishLine: { left: Vec; right: Vec } | null;
  /** The finish line is placed from the tracks (RaceData.finishLineEstimated): left the committee boat. */
  finishLineEstimated?: boolean;
  /**
   * Marks as rounded; `estimated` ones are turns placed from the fleet's tracks where no tracker was. `title` is the
   * feed's own name for a mark whose `name` is its role from the legs ("Reach mark" for a feed's "Leeward port").
   */
  marks: { name: string; xy: Vec[]; estimated?: boolean; title?: string }[];
  legs: LegDef[];
  /**
   * Where each leg starts and ends, in order: the start line's middle, each turn (as the legs
   * were timed), the finish line's middle (else the start line's). n legs → n + 1 points.
   * Optional: analyses from before the Coach tab have none.
   */
  legPts?: Vec[];
  /**
   * How legs were split: 'course' (mark trackers in the feed's order),
   * 'tracks' (mark trackers, order inferred from the leaders), 'fleet'
   * (where the boats turned at the top and bottom of the course, snapped to
   * trackers where present) or 'none' (one leg).
   */
  legSource: 'course' | 'tracks' | 'fleet' | 'none';
  wind: WindInfo;
  /** The competitors, ranked. Boats judged not racing are never in here (see `excluded`). */
  boats: BoatResult[];
  drawings: BoatDrawing[];
  /**
   * Boats judged not racing (coach boats, spare or second trackers; see
   * participation.ts). They affect nothing above; the UI draws one, unranked,
   * only when it is picked.
   */
  excluded: ExcludedBoat[];
  /** Set when everyone was kept as a competitor on request (`nc=all`): how many would otherwise be excluded. */
  allCompetitors?: { flagged: number };
  findings: Finding[];
  /** The data caveats, typed (the UI's chips and ⓘ bullets come from these). */
  notes: RaceNote[];
  /** The same caveats as full sentences (`notes[i].text`). */
  warnings: string[];
  /** Some competitor has heel figures (the feed carries roll); false for older feeds, and the heel columns are hidden. */
  hasHeel: boolean;
}

export interface ExcludedBoat {
  /** Start figures and the finish time only: `colorSlot` -1, no ranks, no leg results. */
  result: BoatResult;
  /** Track split at the fleet's median leg times (an approximation for drawing only). */
  drawing: BoatDrawing;
  reasons: string[];
}
