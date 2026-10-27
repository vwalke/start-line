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
   * Heel from the device's IMU (RaceSense `roll`), degrees; negative = heeled
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
  /** Where `finishMs` came from, when the race's results were resolved (see RaceData.results). */
  finishSource?: FinishSource;
  /**
   * Display only, for a boat with no accepted finish (none, or one shown implausible): where its own track crossed
   * the finish line (data/finishes.ts trackerFinish), so its last leg is drawn to there and not on past it.
   */
  lineCrossMs?: number;
  /** Official place in class (null: coded or not in the official results); set only with official results. */
  officialPlace?: number | null;
  /** Official scoring code (DNF, DNS, DNC, OCS, DSQ, RET, …); null for an official finisher. */
  officialCode?: string | null;
  /** The official race score (points), coded or not; null when the results have none. */
  officialPoints?: number | null;
  /**
   * A boat that finished with a code (data/official/codes.ts finishedWithCode: DPI, SCP, …; DSQ / UFD / BFD with a
   * finish time): its place on the water among the official finishers, and the places the code cost. It keeps
   * its finish time (`finishMs`) like any finisher.
   */
  onWaterPlace?: number | null;
  penaltyPlaces?: number | null;
  /**
   * Set by the source when the tracks show this boat wasn't in the race (a race with no
   * RaceSense finishes: never near the start and no finish; data/finishes.ts awayFromStart):
   * analysis sets it aside as not racing, with this reason.
   */
  notRacing?: string;
  /** Set when the track comes (in part) from the boat's own uploaded log (data/vkx/merge.ts). */
  log?: BoatLog;
  /**
   * The uploaded log's own fixes at its full rate (10 Hz): positions, and the heel when the log has it
   * (`roll`, as Track.roll); `track` holds them thinned for the analysis. The Coach's mark roundings (D9)
   * read these (analysis/coach/index.ts zoneTracks), and its heel comparison (D11, heelTracks).
   */
  fullRate?: { t: Float64Array; lat: Float64Array; lon: Float64Array; roll?: Float32Array };
}

export type FinishSource = 'official' | 'racesense' | 'tracker';

/** How a race's places and finish times were decided (data/finishes.ts, racesense/adapter.ts). */
export interface RaceResults {
  /** Places: the official results, RaceSense's finish order, or the order of the tracks' finish-line crossings. */
  places: FinishSource;
  /** Times: as places, or 'mixed' (official places with RaceSense finishes where it has them and crossings elsewhere). */
  times: FinishSource | 'mixed';
  /** Why official times were set aside (placeholders, outside the race, too few to check). */
  timesNote?: string;
  /** Official race number, when linked. */
  officialNumber?: number;
  /** Boats whose finish is a tracker crossing. */
  trackerFinishes: number;
  /** Official results with no track in this race (RaceSense sail, or the official sail when unpaired). */
  officialNoTrack?: string[];
  /** Tracked boats the official results don't list. */
  trackNoOfficial?: string[];
}

/** An uploaded boat log merged into the boat's track: what the chips say about it. */
export interface BoatLog {
  kind: 'vkx';
  /** The log's own rate, Hz (10 for a Vakaros Atlas 2). */
  rateHz: number;
  /** The log's span in this race, ms, and its fixes there. */
  fromMs: number;
  toMs: number;
  samples: number;
  /** Rates the analysis uses: around the start, and elsewhere (merge.ts). */
  startHz: number;
  raceHz: number;
  /** The boat's RACE_START timer event minus the gun, s; null with none near the gun. */
  timerDeltaS: number | null;
  /** The boat's pinged line ends' distance from the race's start line ends, m; null when not pinged. */
  linePinM: number | null;
  lineBoatM: number | null;
  uploadedAt?: number;
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
   * The finish line isn't in the feed: it is placed off the committee boat from the tracks
   * (data/finishEstimate.ts). Left is the committee boat at the fleet's median finish, right the far end.
   */
  finishLineEstimated?: boolean;
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
  /** Where places and finish times came from; absent when nothing was resolved (as before official results). */
  results?: RaceResults;
}
