/** Raw response shapes from the public RaceSense endpoints (only what we read). */

export interface LandingEvent {
  eventId: string;
  title: string;
  classLabel?: string;
  venue?: string;
  dateLabel?: string;
  fleetLabel?: string;
  division?: string;
  startMs: number;
  endMs: number;
  capturedRaceTime?: string | null;
}

export interface LandingResponse {
  events: LandingEvent[];
}

export interface DeviceRole {
  role: string;
  sn: string;
}

export interface Achievement {
  title: string;
  type: string;
  deviceRoles: DeviceRole[];
  roundingDirection?: string;
}

export interface Course {
  id?: string;
  name?: string;
  validFrom?: number;
  achievements: Achievement[];
}

export interface Participant {
  sailNumber: string;
  boatName?: string;
  bowNumber?: string;
  bowOffsetCm?: number;
  color?: number;
}

/** GeoJSON point: [lon, lat]. Absent values are [0, 0]. */
export interface FeedPoint {
  coordinates: [number, number];
}

export interface StartingStat {
  sailNumber: string;
  serialNumber?: string;
  dtlMm?: number | null;
  /** Which fields the device actually reported (bitfield; see `rcStartFix` in adapter.ts). */
  mask?: { value: number } | null;
  /** The race this row was recorded for; may be an earlier race's row carried over. */
  raceNumber?: number | null;
  /** Always null in the feeds seen so far. */
  startTime?: number | null;
  headingAtStartDeg?: number;
  positionAtStart?: FeedPoint;
  lineLeftLocation?: FeedPoint;
  lineRightLocation?: FeedPoint;
}

export interface Start {
  startNumber?: number;
  startTime: number | null;
  startLine?: { leftEnd: [number, number]; rightEnd: [number, number] } | null;
  startingStats?: StartingStat[] | null;
  ocsParticipants?: string[] | null;
  clearedOcs?: string[] | null;
  stopReason?: string | null;
}

export interface Finish {
  sailNumber: string;
  serialNumber?: string;
  finishingTime: string;
  lineLeftLocation?: { coordinates: [number, number] };
  lineRightLocation?: { coordinates: [number, number] };
}

export interface Race {
  raceNumber: number;
  isPractice?: boolean;
  endTime?: string | null;
  timezoneOffset?: number;
  starts: Start[];
  finishes: Finish[];
}

export interface Division {
  name: string;
  boatClass?: string;
  offsetOverrideCm?: number;
  courses: Course[];
  participants: Participant[];
  races: Race[];
}

export interface RegattaDoc {
  name: string;
  startDate?: number;
  endDate?: number;
  divisions: Division[];
}

export interface RegattaResponse {
  eventId: string;
  revisions: { validFrom?: number | null; doc: RegattaDoc }[];
}

/** teleapi /telemetry/event: positional rows; columns looked up by name. Both are null when the event publishes no telemetry. */
export interface TelemetryPage {
  Fields: string[] | null;
  Rows: (string | number | null)[][] | null;
}

export interface WindResponse {
  model?: string;
  modelLabel?: string;
  nodes: { lat: number; lon: number; time: string[]; speed: number[]; dir: number[] }[];
}
