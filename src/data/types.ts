/**
 * The normalized race model. Everything in `analysis/` consumes only this,
 * so any source (the RaceSense public feed today, a .vkx upload later) just
 * needs an adapter that produces a `RaceData`.
 *
 * Units: times are unix epoch milliseconds (UTC); positions are WGS84
 * degrees; speeds are knots; headings are degrees true (0..360).
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** One boat's GPS track, sorted by time with duplicate timestamps removed. */
export interface Track {
  t: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  /** Speed over ground, knots. */
  sog: Float32Array;
  /** Heading (or course over ground if that is all the source has), degrees. */
  heading: Float32Array;
  /**
   * Heel from the device's IMU (RaceSense `roll`), degrees; positive = heeled
   * to port (see analysis/heel.ts). NaN where a fix has none; absent when the
   * source has no such column.
   */
  roll?: Float32Array;
  /** Trim (RaceSense `pitch`), degrees; NaN / absent as `roll`. */
  pitch?: Float32Array;
}

export interface Boat {
  /** Stable id within this race (sail number for RaceSense). */
  id: string;
  sail: string;
  /** Display name; may equal the sail number when the feed has none. */
  name: string;
  /** Distance from the GPS antenna forward to the bow, metres. */
  bowOffsetM: number;
  track: Track;
  /** Official finish time, if the boat finished. */
  finishMs: number | null;
  /** Flagged on-course-side at the start by race control. */
  ocs?: boolean;
  /** The boat's Vakaros device's own distance-to-line at the start (feed `dtlMm`, bow-corrected), metres; set only when `rc.status` is 'ok'. */
  rcDtlM?: number | null;
  /** Whether the Vakaros start fix can be used, and why not. */
  rc?: RcStart;
  /** The entry's bow number, if the source has one (used only as a name hint). */
  bowNumber?: string;
  /** Event-wide results, when the source has them (RaceSense: the regatta doc's finishes for every race). */
  entry?: EntryResults;
}

/**
 * How the entry did over the whole event. A finish is plausible when the
 * feed's own distance sailed and max speed look like the fleet's in that race
 * (spare trackers sitting on the committee boat "finish" after ~1 km).
 */
export interface EntryResults {
  /** The division's non-practice races that have any finishes (this one included). */
  racesWithResults: number;
  plausibleFinishes: number;
  /** This race's finish: plausible or not; null when the boat has none. */
  finishPlausible: boolean | null;
  /** Why this race's finish is implausible, if it is. */
  finishNote?: string;
}

/**
 * Validity of a boat's Vakaros start fix: 'ok' (usable), 'stale' (the row
 * belongs to another start), 'missing' (the device reported no distance) or
 * 'none' (no row for this boat).
 */
export type RcStatus = 'ok' | 'stale' | 'missing' | 'none';

export interface RcStart {
  status: RcStatus;
  /** Metres; null unless status is 'ok'. A genuine 0 is kept. */
  dtlM: number | null;
  /** For 'stale': the race the row was really recorded for, if known. */
  staleRace?: number | null;
  /** Plain-English reason when not 'ok'. */
  note?: string;
}

/** A start or finish line. "left"/"right" as seen looking up the course. */
export interface Line {
  left: LatLon;
  right: LatLon;
}

/** A waypoint to round or pass: a single mark or a gate (two marks). */
export interface CourseMark {
  /** Stable identity (e.g. the tracker serials), so a repeated mark is recognisably the same one. */
  id: string;
  name: string;
  kind: 'mark' | 'gate';
  /** Representative position of each buoy (one, or two for a gate). */
  positions: LatLon[];
  /**
   * Optional time series per buoy (parallel to `positions`): race committees
   * move marks mid-race, so analysis uses the position at the time.
   */
  tracks?: MarkTrack[];
}

export interface MarkTrack {
  t: number[];
  lat: number[];
  lon: number[];
}

export interface WindSample {
  t: number;
  /** Direction the wind blows FROM, degrees true. */
  dirDeg: number;
  speed: number;
}

export interface RaceData {
  source: {
    kind: 'racesense' | 'fixture' | 'vkx';
    /** Human-readable provenance, e.g. "RaceSense public feed". */
    label: string;
    eventId?: string;
  };
  eventName: string;
  division: string;
  boatClass: string;
  /** The event's class label from the landing list (e.g. "C31"), when known. */
  classLabel?: string;
  raceNumber: number;
  /** Starting signal. */
  gunMs: number;
  /**
   * Ms before the gun at which the DTL sample is taken. RaceSense device
   * stats are taken about 900 ms before startTime in the telemetry
   * timebase. Default 0.
   */
  dtlSampleOffsetMs?: number;
  /** Venue's UTC offset in ms, for local clock display (0 if unknown). */
  tzOffsetMs: number;
  startLine: Line;
  finishLine: Line | null;
  /**
   * Waypoints between the start and the finish in the order the race
   * committee set them (may repeat, e.g. M1, Gate, M1). Analysis may
   * re-order this if the tracks clearly disagree.
   */
  course: CourseMark[];
  /** Course marks the source listed but whose trackers sent no positions (so they are not in `course`). */
  courseUntracked?: string[];
  boats: Boat[];
  /** Modelled (not measured) wind near the course, if available. */
  windModel?: { label: string; samples: WindSample[] };
}
