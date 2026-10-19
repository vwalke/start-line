import type { RcStatus } from '../data/types';
import type { Vec } from './geo';

/** How much track before the start fix the start chart draws behind each boat. */
export const START_TRAIL_MS = 60_000;

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
  /** Distance sailed along the GPS track, m. */
  distM: number;
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
}

/**
 * One boat's legs of one kind (upwind or downwind; reaches are in neither)
 * added up: sums of time, distance and manoeuvres; SOG = distance ÷ time;
 * VMG, |TWA| and coverage time-weighted over the legs.
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
  sogKn: number;
  vmgKn: number;
  twaDeg: number;
  tacks: number;
  gybes: number;
  /** Some tack or gybe bridges a telemetry gap. */
  manoeuvreApprox: boolean;
  coverage: number;
  maxGapS: number;
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
  /** Flagged OCS, or the ranking value is negative. */
  over: boolean;
  /** Place among clean starters (1 = closest to the line); null when over or unranked. */
  startPlace: number | null;
  /** Vakaros and ours are both valid but clearly disagree. */
  warn: string | null;
  /** Vakaros had no usable fix, and our figure puts the boat near or over the line. */
  ocsBlind: boolean;
}

export interface BoatResult {
  id: string;
  sail: string;
  name: string;
  /** Stable colour slot (by sail order), independent of result; -1 when set aside as not racing. */
  colorSlot: number;
  finishPos: number | null;
  finishMs: number | null;
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
}

export interface WindEstimate {
  legIndex: number;
  /** Mid-time of the leg across the fleet. */
  tMs: number;
  twdDeg: number;
  tackAngleDeg: number;
  samples: number;
}

export interface WindInfo {
  method: 'tacks' | 'model' | 'course';
  estimates: WindEstimate[];
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
}

export interface Finding {
  kind: 'start' | 'line' | 'leg' | 'wind' | 'result';
  text: string;
  /** The boats this finding is about, if any. */
  boatIds?: string[];
}

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
  };
  line: LineInfo;
  finishLine: { left: Vec; right: Vec } | null;
  /** Marks as rounded; `estimated` ones are turns placed from the fleet's tracks where no tracker was. */
  marks: { name: string; xy: Vec[]; estimated?: boolean }[];
  legs: LegDef[];
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
  warnings: string[];
}

export interface ExcludedBoat {
  /** Start figures and the finish time only: `colorSlot` -1, no ranks, no leg results. */
  result: BoatResult;
  /** Track split at the fleet's median leg times (an approximation for drawing only). */
  drawing: BoatDrawing;
  reasons: string[];
}
