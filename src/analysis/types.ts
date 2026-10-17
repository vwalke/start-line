import type { RcStatus } from '../data/types';
import type { Vec } from './geo';

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
  /** Set when our `dtlM` is interpolated across a telemetry gap (> GAP_MS to the nearest point): the gap, s. */
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
  /** Stable colour slot (by sail order), independent of result. */
  colorSlot: number;
  finishPos: number | null;
  finishMs: number | null;
  raceTimeS: number | null;
  sogAvgKn: number | null;
  start: StartResult | null;
  legs: (LegResult | null)[];
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

export interface TrackSegment {
  leg: number;
  x: Float32Array;
  y: Float32Array;
}

export interface BoatDrawing {
  id: string;
  /** ~30 s of track up to the DTL sample, shifted so the last point is the bow. */
  trail: { x: Float32Array; y: Float32Array };
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
}

export interface RaceAnalysis {
  meta: {
    eventName: string;
    division: string;
    boatClass: string;
    raceNumber: number;
    gunMs: number;
    tzOffsetMs: number;
    sourceLabel: string;
    sourceKind: string;
    eventId?: string;
  };
  line: LineInfo;
  finishLine: { left: Vec; right: Vec } | null;
  marks: { name: string; xy: Vec[] }[];
  legs: LegDef[];
  legSource: 'course' | 'tracks' | 'none';
  wind: WindInfo;
  boats: BoatResult[];
  drawings: BoatDrawing[];
  findings: Finding[];
  warnings: string[];
}
