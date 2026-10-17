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
  /** Bow distance behind the line at the gun, m (negative = over). */
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
  rcDtlM: number | null;
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
  /** Last 30 s before the gun (+ a few after), full rate. */
  trail: { x: Float32Array; y: Float32Array };
  bow: Vec | null;
  /** Compass heading at the gun (TWA / bow-offset direction). */
  headingAtGun: number | null;
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
