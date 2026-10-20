/**
 * RaceSense source adapter: turns the public RaceSense responses (regatta
 * document + teleapi telemetry pages + optional model wind) into the
 * normalized `RaceData`. Pure functions only; fetching lives in api.ts so
 * the same code runs against the offline fixtures in tests.
 */
import { awayFromStart, crossings, feedRaceNumber, fleetOnsetFloor, lineFrom, officialTimesPlausible, trackerFinish, PLAUSIBLE_SEARCH_MS, type MarkSeries } from '../finishes';
import type { OfficialResultRow } from '../official/link';
import type { Boat, CourseMark, EntryResults, LatLon, Line, MarkTrack, RaceData, RaceResults, RcStart, Track, WindSample } from '../types';
import type {
  Course,
  Division,
  FeedPoint,
  Finish,
  Race,
  RegattaDoc,
  RegattaResponse,
  Start,
  StartingStat,
  TelemetryPage,
  WindResponse,
} from './types';

/** Device DTL (`dtlMm`) matches the track ~900 ms before startTime in the telemetry timebase (median residual 0.12 m over 196 starts). */
export const RACESENSE_DTL_SAMPLE_OFFSET_MS = 900;

export interface RaceRef {
  division: string;
  raceNumber: number;
}

export interface RaceListItem extends RaceRef {
  gunMs: number;
  finishers: number;
  /** Has a gun, finishes and is no longer in progress. */
  finished: boolean;
  lastFinishMs: number | null;
}

/** The current revision (starts and finishes accrue on it). */
export function currentDoc(resp: RegattaResponse): RegattaDoc {
  const revs = resp.revisions;
  if (!Array.isArray(revs) || revs.length === 0) throw new Error('Regatta has no revisions');
  return revs[revs.length - 1].doc;
}

function raceStart(race: Race): Start | null {
  const starts = (race.starts ?? []).filter((s) => s.startTime != null);
  return starts.length ? starts[starts.length - 1] : null;
}

function finishMs(race: Race): number[] {
  return (race.finishes ?? []).map((f) => Date.parse(f.finishingTime)).filter(Number.isFinite);
}

/** Every non-practice race with a gun (with `practice`, practice races too), newest first. */
export function listRaces(doc: RegattaDoc, opts: { practice?: boolean } = {}): RaceListItem[] {
  const out: RaceListItem[] = [];
  for (const div of doc.divisions ?? []) {
    for (const race of div.races ?? []) {
      if (race.isPractice && !opts.practice) continue;
      const st = raceStart(race);
      if (!st || st.startTime == null) continue;
      const fins = finishMs(race);
      const finished = fins.length > 0 && (st.stopReason === 'finished' || !!race.endTime);
      out.push({
        division: div.name,
        raceNumber: race.raceNumber,
        gunMs: st.startTime,
        finishers: fins.length,
        finished,
        lastFinishMs: fins.length ? Math.max(...fins) : null,
      });
    }
  }
  return out.sort((a, b) => b.gunMs - a.gunMs);
}

/** The most recent finished race, or null. */
export function defaultRace(doc: RegattaDoc): RaceListItem | null {
  return listRaces(doc).find((r) => r.finished && !!raceStart(findRace(doc, r).race)?.startLine) ?? null;
}

export function findRace(doc: RegattaDoc, ref: RaceRef): { div: Division; race: Race } {
  const div = doc.divisions.find((d) => d.name === ref.division);
  if (!div) throw new Error(`Division ${ref.division} not found`);
  const race = div.races.find((r) => r.raceNumber === ref.raceNumber);
  if (!race) throw new Error(`Race ${ref.raceNumber} not found in ${ref.division}`);
  return { div, race };
}

/**
 * Pre-start telemetry fetched: covers the start-chart trails (START_TRAIL_MS) and the
 * speed-through-the-start chart's longest window (START_SOG_PRE_MS, 120 s) plus its
 * smoothing, as the test fixtures (which start 120 s before the gun) already do.
 */
export const PRE_START_FETCH_MS = 130_000;

/**
 * A race with no RaceSense finishes is fetched to the division's next gun (less a minute) or
 * this long after its own, whichever is first: its finishes come from the tracks or the official
 * results, and RaceSense's `endTime` for such races is unreliable (AYC: before the last finish;
 * Cascais: 8 h or a day later).
 */
export const NO_FINISH_WINDOW_MS = 2 * 3_600_000;

/** The division's next gun after this race's (any race with a gun, practice included), or null. */
export function nextGunMs(doc: RegattaDoc, ref: RaceRef): number | null {
  const { div, race } = findRace(doc, ref);
  const gun = raceStart(race)?.startTime;
  if (gun == null) return null;
  const later = (div.races ?? []).map((r) => raceStart(r)?.startTime ?? null).filter((t): t is number => t != null && t > gun + 60_000);
  return later.length ? Math.min(...later) : null;
}

/** Telemetry time window worth fetching for a race: a short pre-start (for trails) to just past the last finish. */
export function telemetryWindow(doc: RegattaDoc, ref: RaceRef): { after: number; before: number } {
  const { race } = findRace(doc, ref);
  const st = raceStart(race);
  if (!st?.startTime) throw new Error('Race has no start time');
  const fins = finishMs(race);
  if (fins.length) return { after: st.startTime - PRE_START_FETCH_MS, before: Math.max(...fins) + 30_000 };
  const next = nextGunMs(doc, ref);
  const end = Math.min(st.startTime + NO_FINISH_WINDOW_MS, next != null ? next - 60_000 : Infinity);
  return { after: st.startTime - PRE_START_FETCH_MS, before: Math.max(end, st.startTime + 20 * 60_000) };
}

/** Firestore carries a 10-hex-digit serial; telemetry's `sn` is its low 16 bits as a number. */
export function snFromHex(hex: string): number {
  return parseInt(hex.slice(-4), 16);
}

/** Feed colour (ARGB int) to CSS hex. */
export function argbToHex(argb: number | undefined): string | null {
  if (argb == null || !Number.isFinite(argb)) return null;
  return '#' + (argb & 0xffffff).toString(16).padStart(6, '0');
}

/** race.timezoneOffset is microseconds in the feed; tolerate ms just in case. */
export function tzOffsetMs(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 0;
  return Math.abs(raw) > 15 * 3_600_000 ? raw / 1000 : raw;
}

/**
 * Vakaros start-fix quality. Each `startingStats` row carries `mask.value`,
 * a bitfield of which fields the device actually reported. Undocumented;
 * inferred over 10,885 rows from 47 events:
 *
 * | bit | field                            | set & present | unset & absent | exceptions |
 * |-----|----------------------------------|---------------|----------------|------------|
 * | 1   | dtlMm (and headingAtStartDeg)    | 10,419        | 464            | 2 (unset, dtlMm≠0); 0 set with dtlMm exactly 0 |
 * | 2   | positionAtStart                  | 10,368        | 516            | 1          |
 * | 4   | lineLeftLocation                 | 10,373        | 511            | 1          |
 * | 8   | lineRightLocation                | 10,419        | 463            | 3          |
 *
 * Mask 15 in 9,701 rows; every other value 0–14 appears 43–166 times.
 * Hence: bit 1 unset ⇒ no distance; bit 1 set with dtlMm 0 ⇒ a genuine 0.
 * Without a mask, a null or 0 dtlMm can't be confirmed and counts as missing.
 * Absent points are [0, 0] and are never compared.
 *
 * Rows are also carried over from earlier starts unchanged (23 rows in races
 * 4–10 of one event had another race's `raceNumber` and line ends), so a row
 * is stale when its raceNumber, startTime (always null so far) or any present
 * line end disagrees with this start.
 */
export const MASK_DTL = 1;
export const MASK_POSITION = 2;
export const MASK_LINE_LEFT = 4;
export const MASK_LINE_RIGHT = 8;
/** A row's line end further than this from the start's line end means the row is from another start. */
export const LINE_MATCH_M = 10;
export const START_TIME_MATCH_MS = 1000;
export const RC_NO_DISTANCE = 'Vakaros reported no distance for this boat';

/** The device's own DTL in metres, or null when it reported none (a genuine 0 is kept). */
export function rcDistanceM(s: StartingStat): number | null {
  const mm = s.dtlMm;
  if (mm == null || !Number.isFinite(mm)) return null;
  const mask = s.mask?.value;
  if (mask == null || !Number.isFinite(mask)) return mm === 0 ? null : mm / 1000;
  return mask & MASK_DTL ? mm / 1000 : null;
}

/** A feed [lon, lat] point, or null when absent ([0, 0]). */
function feedPoint(p: FeedPoint | undefined): LatLon | null {
  const c = p?.coordinates;
  if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || (c[0] === 0 && c[1] === 0)) return null;
  return { lat: c[1], lon: c[0] };
}

/** Great-circle distance, metres. */
export function metresBetween(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Do the row's present line ends lie within LINE_MATCH_M of this line's? null when it has none. */
export function lineEndsMatch(s: StartingStat, line: NonNullable<Start['startLine']>): boolean | null {
  const ends: [LatLon | null, [number, number]][] = [
    [feedPoint(s.lineLeftLocation), line.leftEnd],
    [feedPoint(s.lineRightLocation), line.rightEnd],
  ];
  const present = ends.filter((e): e is [LatLon, [number, number]] => e[0] != null);
  if (!present.length) return null;
  return present.every(([p, [lat, lon]]) => metresBetween(p, { lat, lon }) <= LINE_MATCH_M);
}

/** Classify a boat's Vakaros start row for this start (see the mask notes above). */
export function rcStartFix(s: StartingStat | undefined, div: Division, race: Race, st: Start): RcStart {
  if (!s) return { status: 'none', dtlM: null };
  const stale = (n: number | null): RcStart => ({
    status: 'stale',
    dtlM: null,
    staleRace: n,
    note: n != null ? `Vakaros reported no start fix (stale race ${n} data)` : 'Vakaros reported no start fix (stale data from another start)',
  });
  if (s.raceNumber != null && s.raceNumber !== race.raceNumber) return stale(s.raceNumber);
  const timeOff = s.startTime != null && st.startTime != null && Math.abs(s.startTime - st.startTime) > START_TIME_MATCH_MS;
  if (timeOff || (st.startLine && lineEndsMatch(s, st.startLine) === false)) {
    // Name the start it came from: the nearest-in-time other race whose line (or start time) matches the row.
    const gun = st.startTime ?? 0;
    const from = (div.races ?? [])
      .filter((r) => r !== race)
      .map((r) => ({ r, rs: raceStart(r) }))
      .filter(({ rs }) => {
        if (!rs) return false;
        if (s.startTime != null && rs.startTime != null && Math.abs(s.startTime - rs.startTime) <= START_TIME_MATCH_MS) return true;
        return !!rs.startLine && lineEndsMatch(s, rs.startLine) === true;
      })
      .sort((a, b) => Math.abs((a.rs!.startTime ?? 0) - gun) - Math.abs((b.rs!.startTime ?? 0) - gun))[0];
    return stale(from ? from.r.raceNumber : null);
  }
  const dtlM = rcDistanceM(s);
  return dtlM == null ? { status: 'missing', dtlM: null, note: RC_NO_DISTANCE } : { status: 'ok', dtlM };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * A finish is plausible when the device sailed at least this share of the
 * race's median distance: the spare and judge trackers that "finish" from a
 * committee boat log 1–2 km against the fleet's 7–15 km.
 */
export const FINISH_MIN_DIST_FRAC = 0.5;
/** …and its max speed is at most this multiple of the race's median max (a media RIB logged 23 kt vs ~14). */
export const FINISH_MAX_SPEED_X = 1.6;
/** Fewer finishes than this with a figure and the race has no usable median for that test. */
const FINISH_MEDIAN_MIN = 3;

const num = (x: number | null | undefined): number | null => (x != null && Number.isFinite(x) && x > 0 ? x : null);

/**
 * The device's distance counter skips its own dropouts (a sparse tracker
 * "sailed 1.1 km" of a 13 km race), so a short distance is excused when the
 * boat's track explains it: it went at least FINISH_MIN_REACH_FRAC as far
 * from the start line as the fleet's median (a committee boat never leaves
 * it), and both the device's distance and the track's own path, plus the
 * track's holes at the fleet's pace, make up FINISH_MIN_DIST_FRAC of the
 * fleet's distance. A full track against a short counter stays implausible:
 * no hole explains it.
 */
export const FINISH_MIN_REACH_FRAC = 0.5;
/** Fixes further apart than this leave a hole (as analysis SPAN_MS), ms. */
export const FINISH_HOLE_MS = 5_000;

/** What one boat's own track shows from the gun to its finish. */
export interface TrackEvidence {
  /** Path length, holes bridged by a straight line (a lower bound), m. */
  pathM: number;
  /** Time in holes over FINISH_HOLE_MS, including before the first and after the last fix, ms. */
  holeMs: number;
  /** Furthest distance from `from` (the start line's middle), m. */
  reachM: number;
}

/** A track's path, holes and reach over [gunMs, finishMs]; null with no fix in that window. */
export function trackEvidence(rows: { ts: number; lat: number; lon: number }[], gunMs: number, finishMs: number, from: LatLon): TrackEvidence | null {
  const w = rows.filter((r) => r.ts >= gunMs && r.ts <= finishMs);
  if (!w.length) return null;
  let pathM = 0;
  let reachM = 0;
  let holeMs = 0;
  const hole = (ms: number): number => (ms > FINISH_HOLE_MS ? ms : 0);
  w.forEach((r, i) => {
    reachM = Math.max(reachM, metresBetween(from, r));
    if (i) {
      pathM += metresBetween(w[i - 1], r);
      holeMs += hole(r.ts - w[i - 1].ts);
    }
  });
  holeMs += hole(w[0].ts - gunMs) + hole(finishMs - w[w.length - 1].ts);
  return { pathM, holeMs, reachM };
}

/** Does the track excuse a device distance `deviceM` under FINISH_MIN_DIST_FRAC × `medDist` (see FINISH_MIN_REACH_FRAC)? */
export function trackExplainsDistance(ev: TrackEvidence, deviceM: number, raceMs: number, medDist: number, medReach: number | null): boolean {
  if (medReach == null || !(raceMs > 0) || ev.reachM < FINISH_MIN_REACH_FRAC * medReach) return false;
  const holesM = (ev.holeMs * medDist) / raceMs;
  return Math.min(deviceM, ev.pathM) + holesM >= FINISH_MIN_DIST_FRAC * medDist;
}

/** Why a finish looks wrong against its race's medians, or null when it looks like a real one; `excuse` may waive a short distance. */
function implausibleFinish(f: Finish, medDist: number | null, medMax: number | null, excuse?: (deviceM: number, medDist: number) => boolean): string | null {
  const d = num(f.distanceTraveled);
  const v = num(f.maxSpeed);
  if (d != null && medDist != null && d < FINISH_MIN_DIST_FRAC * medDist && !excuse?.(d, medDist)) {
    return `the feed has it sailing ${(d / 1000).toFixed(1)} km against the fleet's ${(medDist / 1000).toFixed(1)} km`;
  }
  if (v != null && medMax != null && v > FINISH_MAX_SPEED_X * medMax) {
    return `the feed has a max speed of ${Math.round(v)} kt against the fleet's ${Math.round(medMax)} kt`;
  }
  return null;
}

/**
 * Event-wide results per sail number: every non-practice race of the division
 * that has finishes. `excuse(sail, deviceM, medDist)` may waive a short distance in
 * this race (the only one with telemetry: see trackExplainsDistance).
 */
export function entryResults(
  div: Division,
  race: Race,
  excuse?: (sail: string, deviceM: number, medDist: number) => boolean,
): Map<string, EntryResults> {
  const out = new Map<string, EntryResults>();
  const get = (sail: string): EntryResults => {
    let e = out.get(sail);
    if (!e) out.set(sail, (e = { racesWithResults: 0, plausibleFinishes: 0, finishPlausible: null }));
    return e;
  };
  const raced = (div.races ?? []).filter((r) => !r.isPractice && r.finishes?.length);
  for (const p of div.participants ?? []) get(p.sailNumber);
  for (const r of raced) {
    const fins = r.finishes;
    const dists = fins.map((f) => num(f.distanceTraveled)).filter((x): x is number => x != null);
    const maxes = fins.map((f) => num(f.maxSpeed)).filter((x): x is number => x != null);
    const medDist = dists.length >= FINISH_MEDIAN_MIN ? median(dists) : null;
    const medMax = maxes.length >= FINISH_MEDIAN_MIN ? median(maxes) : null;
    const bySail = new Map(fins.map((f) => [f.sailNumber, f]));
    for (const [sail, e] of out) {
      e.racesWithResults++;
      const f = bySail.get(sail);
      if (!f) continue;
      const why = implausibleFinish(f, medDist, medMax, r === race && excuse ? (d, m) => excuse(sail, d, m) : undefined);
      if (!why) e.plausibleFinishes++;
      if (r === race) {
        e.finishPlausible = !why;
        if (why) e.finishNote = why;
      }
    }
  }
  return out;
}

function courseAt(div: Division, gunMs: number): Course | null {
  const cs = [...(div.courses ?? [])].sort((a, b) => (a.validFrom ?? 0) - (b.validFrom ?? 0));
  let found: Course | null = cs[0] ?? null;
  for (const c of cs) if ((c.validFrom ?? 0) <= gunMs) found = c;
  return found;
}

interface Row {
  ts: number;
  sn: number;
  sail: string;
  role: string;
  lat: number;
  lon: number;
  heading: number;
  sog: number;
  /** Heel / trim, degrees; null when the page has no such column or the value is missing or implausible. */
  roll: number | null;
  pitch: number | null;
  /** The feed's `race_stage` / `race_number` for the device, when the page has them (tracker finishes use the stage). */
  stage?: string | null;
  rn?: number | null;
}

/** |roll| or |pitch| at or beyond this is no reading: coach and spare trackers sit at a ±90 clamp, and a few glitches read 94–127. */
export const IMU_MAX_DEG = 90;

/** An IMU angle, or null when absent, non-numeric or ≥ IMU_MAX_DEG. */
export function imuAngle(v: unknown): number | null {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) && Math.abs(x) < IMU_MAX_DEG ? x : null;
}

/**
 * Exactly 0 roll and 0 pitch while moving (SOG > IMU_ZERO_MIN_SOG_KN) for at
 * least this long is a device sending no IMU, not a boat sailing level. In the
 * public feed 0/0 is rare and brief (≤ 6 s in a row over four events, mostly
 * mid-tack on boats that trim near 0°), so those readings are kept.
 */
export const IMU_ZERO_RUN_MS = 10_000;
export const IMU_ZERO_MIN_SOG_KN = 2;

/** Null out roll and pitch over runs of exact 0/0 while moving lasting ≥ IMU_ZERO_RUN_MS (rows sorted by time, one device). */
export function dropImuZeroRuns(rows: { ts: number; sog: number; roll: number | null; pitch: number | null }[]): void {
  let i = 0;
  while (i < rows.length) {
    const z = (r: (typeof rows)[number]): boolean => r.roll === 0 && r.pitch === 0 && r.sog > IMU_ZERO_MIN_SOG_KN;
    if (!z(rows[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < rows.length && z(rows[j + 1])) j++;
    if (rows[j].ts - rows[i].ts >= IMU_ZERO_RUN_MS) for (let k = i; k <= j; k++) rows[k].roll = rows[k].pitch = null;
    i = j + 1;
  }
}

/** Concatenate pages into typed rows, sorted by time, de-duplicated on (sn, role, ts). */
export function parseTelemetry(pages: TelemetryPage[]): Row[] {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const page of pages) {
    // Events that publish no telemetry return pages with null Fields/Rows.
    if (!page?.Fields || !page.Rows) continue;
    const f = Object.fromEntries(page.Fields.map((name, i) => [name, i]));
    const need = ['ts', 'sn', 'role', 'latitude', 'longitude'];
    for (const n of need) if (f[n] === undefined) throw new Error(`Telemetry is missing field ${n}`);
    for (const r of page.Rows) {
      const ts = Number(r[f.ts]);
      const sn = Number(r[f.sn]);
      const role = String(r[f.role] ?? '');
      const key = `${sn}|${role}|${ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lat = Number(r[f.latitude]);
      const lon = Number(r[f.longitude]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      rows.push({
        ts,
        sn,
        role,
        sail: f.sail_number === undefined ? '' : String(r[f.sail_number] ?? ''),
        lat,
        lon,
        heading: f.heading === undefined ? NaN : Number(r[f.heading]),
        sog: f.sog === undefined ? NaN : Number(r[f.sog]),
        roll: f.roll === undefined ? null : imuAngle(r[f.roll]),
        pitch: f.pitch === undefined ? null : imuAngle(r[f.pitch]),
        ...(f.race_stage === undefined ? {} : { stage: r[f.race_stage] == null ? null : String(r[f.race_stage]) }),
        ...(f.race_number === undefined || r[f.race_number] == null ? {} : { rn: Number(r[f.race_number]) }),
      });
    }
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

/** One device's rows as a Track; roll / pitch only when the feed carried them (`imu`), NaN where missing. */
function toTrack(rows: Row[], imu: boolean): Track {
  const n = rows.length;
  const t = new Float64Array(n);
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const sog = new Float32Array(n);
  const heading = new Float32Array(n);
  if (imu) dropImuZeroRuns(rows);
  const roll = imu ? new Float32Array(n) : null;
  const pitch = imu ? new Float32Array(n) : null;
  rows.forEach((r, i) => {
    t[i] = r.ts;
    lat[i] = r.lat;
    lon[i] = r.lon;
    sog[i] = r.sog;
    heading[i] = r.heading;
    if (roll) roll[i] = r.roll ?? NaN;
    if (pitch) pitch[i] = r.pitch ?? NaN;
  });
  return { t, lat, lon, sog, heading, ...(roll && pitch ? { roll, pitch } : {}) };
}

function windSamples(wind: WindResponse | undefined, at: LatLon): WindSample[] | null {
  if (!wind?.nodes?.length) return null;
  let best = wind.nodes[0];
  let bestD = Infinity;
  for (const n of wind.nodes) {
    const d = (n.lat - at.lat) ** 2 + ((n.lon - at.lon) * Math.cos((at.lat * Math.PI) / 180)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best.time
    .map((iso, i) => ({ t: Date.parse(iso.endsWith('Z') ? iso : iso + 'Z'), dirDeg: best.dir[i], speed: best.speed[i] }))
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.dirDeg));
}

export interface BuildOptions {
  eventId?: string;
  kind?: 'racesense' | 'fixture';
  wind?: WindResponse;
  /** The landing list's class label for the event (a fallback for the class dimensions). */
  classLabel?: string;
  /** This race's official results (Yachtscoring, linked by gun): places and codes win; times if plausible. */
  official?: OfficialRaceInput | null;
  /** The division's next gun (official finish times must fall before it; the tracker-finish window ends there). */
  nextGunMs?: number | null;
}

/** One race's official results as the worker receives them (plain JSON). */
export interface OfficialRaceInput {
  number: number;
  /** Local − UTC of the official wall-clock times, ms (link.ts infers it). */
  tzOffsetMs: number;
  rows: OfficialResultRow[];
}

/** The finish line's two trackers: the course's finish line, else its start line (AYC shares one line). */
function finishDevices(course: Course | null): { left: string; right: string } | null {
  const ach = course?.achievements ?? [];
  for (const type of ['finishLine', 'startLine']) {
    const a = ach.find((x) => x.type === type);
    const l = a?.deviceRoles.find((d) => /left/i.test(d.role));
    const r = a?.deviceRoles.find((d) => /right/i.test(d.role));
    if (l && r) return { left: l.sn, right: r.sn };
  }
  return null;
}

/**
 * Decide places and finish times (RaceData.results, Boat.finishSource / official*): official
 * places and codes when linked, with official times only if plausible (data/finishes.ts), else
 * RaceSense's finish or the tracker crossing; with no official results and no RaceSense
 * finishes, tracker crossings. A race with RaceSense finishes and no official results is left as it was.
 */
function resolveResults(
  boats: Boat[],
  rowsOf: (sail: string) => Row[] | undefined,
  rows: Row[],
  ctx: { gunMs: number; startMid: LatLon; course: Course | null; finishLine: Line | null; rsFinishes: number; official: OfficialRaceInput | null; nextGunMs: number | null },
): RaceResults | undefined {
  const { gunMs, official } = ctx;
  if (!official && ctx.rsFinishes > 0) return undefined;
  const lastTs = rows.length ? rows[rows.length - 1].ts : gunMs;
  const endMs = Math.min(lastTs, ctx.nextGunMs != null ? ctx.nextGunMs - 30_000 : Infinity);
  const dev = finishDevices(ctx.course);
  const series = (hex: string): MarkSeries => {
    const sn = snFromHex(hex);
    const s: MarkSeries = { t: [], lat: [], lon: [] };
    for (const r of rows) {
      if (r.role !== 'mark' || r.sn !== sn) continue;
      s.t.push(r.ts);
      s.lat.push(r.lat);
      s.lon.push(r.lon);
    }
    return s;
  };
  let lineAt: ((t: number) => Line | null) | null = null;
  if (dev) {
    const l = series(dev.left);
    const r = series(dev.right);
    if (l.t.length && r.t.length) lineAt = lineFrom(l, r);
  }
  if (!lineAt && ctx.finishLine) {
    const fl = ctx.finishLine;
    lineAt = () => fl;
  }
  const fixes = new Map<string, Row[]>();
  for (const b of boats) fixes.set(b.id, rowsOf(b.sail) ?? []);
  const feedRn = feedRaceNumber(fixes.values(), gunMs);
  const floor = fleetOnsetFloor(fixes.values(), gunMs, feedRn);
  const tracker = new Map<string, number>();
  if (lineAt) {
    for (const b of boats) {
      const t = trackerFinish(fixes.get(b.id)!, lineAt, gunMs, endMs, feedRn, floor);
      if (t != null) tracker.set(b.id, t);
    }
  }

  if (!official) {
    for (const b of boats) {
      const t = tracker.get(b.id);
      b.finishMs = t ?? null;
      if (t != null) b.finishSource = 'tracker';
      // No RaceSense finishes confirm who raced: a tracker far from the start that never finishes was elsewhere.
      const away = awayFromStart(fixes.get(b.id)!, ctx.startMid, gunMs, t != null);
      if (away) b.notRacing = away;
    }
    return { places: 'tracker', times: 'tracker', trackerFinishes: tracker.size };
  }

  const byRs = new Map(official.rows.filter((r) => r.rsSail).map((r) => [r.rsSail!, r]));
  const utc = (wall: number | null): number | null => (wall == null ? null : wall - official.tzOffsetMs);
  const fins = official.rows.filter((r) => r.code == null && r.place != null);
  const pairs = boats
    .map((b) => ({ b, o: byRs.get(b.sail) }))
    .filter((x) => x.o && x.o.code == null && utc(x.o.finishWallMs) != null)
    .map(({ b, o }) => ({ officialMs: utc(o!.finishWallMs)!, crossings: lineAt ? crossings(fixes.get(b.id)!, lineAt, gunMs, endMs + PLAUSIBLE_SEARCH_MS) : [] }));
  const allOfficial = fins.map((r) => utc(r.finishWallMs)).filter((t): t is number => t != null);
  const plaus = allOfficial.length ? officialTimesPlausible(pairs, gunMs, ctx.nextGunMs, allOfficial) : { ok: false, n: 0, medianS: null, why: 'no official finish times' };
  let trackerN = 0;
  let rsN = 0;
  for (const b of boats) {
    const o = byRs.get(b.sail);
    const rsFin = b.finishMs;
    b.officialPlace = o && o.code == null ? o.place : null;
    b.officialCode = o ? o.code : null;
    if (o?.code === 'OCS') b.ocs = true;
    else if (o && o.code == null) b.ocs = false;
    if (!o || o.code != null) {
      b.finishMs = null;
      delete b.finishSource;
      continue;
    }
    // Officially placed: the place stands even with an implausible-looking RaceSense finish.
    if (b.entry) b.entry = { ...b.entry, finishPlausible: true, finishNote: undefined };
    const ot = utc(o.finishWallMs);
    if (plaus.ok && ot != null) {
      b.finishMs = ot;
      b.finishSource = 'official';
    } else if (rsFin != null) {
      b.finishMs = rsFin;
      b.finishSource = 'racesense';
      rsN++;
    } else if (tracker.has(b.id)) {
      b.finishMs = tracker.get(b.id)!;
      b.finishSource = 'tracker';
      trackerN++;
    } else {
      b.finishMs = null;
    }
  }
  const tracked = new Set(boats.map((b) => b.sail));
  const out: RaceResults = {
    places: 'official',
    times: plaus.ok ? 'official' : trackerN && rsN ? 'mixed' : rsN ? 'racesense' : 'tracker',
    officialNumber: official.number,
    trackerFinishes: trackerN,
  };
  if (!plaus.ok) out.timesNote = plaus.why ?? 'official times not plausible';
  const noTrack = official.rows.filter((r) => !r.rsSail || !tracked.has(r.rsSail)).map((r) => r.rsSail ?? [r.prefix, r.sail].filter(Boolean).join(' '));
  const noOfficial = boats.filter((b) => !byRs.has(b.sail)).map((b) => b.sail);
  if (noTrack.length) out.officialNoTrack = noTrack;
  if (noOfficial.length) out.trackNoOfficial = noOfficial;
  return out;
}

export function buildRaceData(
  resp: RegattaResponse,
  ref: RaceRef,
  pages: TelemetryPage[],
  opts: BuildOptions = {},
): RaceData {
  const doc = currentDoc(resp);
  const { div, race } = findRace(doc, ref);
  const st = raceStart(race);
  if (!st?.startTime) throw new Error('Race has no start time');
  if (!st.startLine) throw new Error('Race has no recorded start line');
  const gunMs = st.startTime;
  const rows = parseTelemetry(pages);
  // Older feeds (and some fixtures) have no roll / pitch columns at all.
  const imu = pages.some((p) => !!p?.Fields && (p.Fields.includes('roll') || p.Fields.includes('pitch')));
  const fins = finishMs(race);
  const tEnd = fins.length ? Math.max(...fins) : gunMs + 90 * 60_000;

  // Mark positions: a median over the race, plus a 10 s median track because
  // committees re-lay marks mid-race (a shifted windward mark between laps).
  const markRows = new Map<number, { t: number[]; lat: number[]; lon: number[] }>();
  for (const r of rows) {
    if (r.role !== 'mark' || r.ts < gunMs - 60_000 || r.ts > tEnd) continue;
    let m = markRows.get(r.sn);
    if (!m) markRows.set(r.sn, (m = { t: [], lat: [], lon: [] }));
    m.t.push(r.ts);
    m.lat.push(r.lat);
    m.lon.push(r.lon);
  }
  const markPos = (hex: string): LatLon | null => {
    const m = markRows.get(snFromHex(hex));
    return m && m.lat.length ? { lat: median(m.lat), lon: median(m.lon) } : null;
  };
  const markTrack = (hex: string): MarkTrack => {
    const m = markRows.get(snFromHex(hex))!;
    const out: MarkTrack = { t: [], lat: [], lon: [] };
    const BUCKET = 10_000;
    for (let i = 0; i < m.t.length; ) {
      const b = Math.floor(m.t[i] / BUCKET);
      let j = i;
      while (j < m.t.length && Math.floor(m.t[j] / BUCKET) === b) j++;
      out.t.push((b + 0.5) * BUCKET);
      out.lat.push(median(m.lat.slice(i, j)));
      out.lon.push(median(m.lon.slice(i, j)));
      i = j;
    }
    return out;
  };

  const course = courseAt(div, gunMs);
  const marks: CourseMark[] = [];
  const untracked: string[] = [];
  let finishLine: Line | null = null;
  for (const a of course?.achievements ?? []) {
    if (a.type === 'startLine') continue;
    if (a.type === 'finishLine') {
      const l = a.deviceRoles.find((d) => /left/i.test(d.role));
      const r = a.deviceRoles.find((d) => /right/i.test(d.role));
      const lp = l && markPos(l.sn);
      const rp = r && markPos(r.sn);
      if (lp && rp) finishLine = { left: lp, right: rp };
      continue;
    }
    const devices = a.deviceRoles.filter((d) => markPos(d.sn) !== null);
    if (!devices.length) {
      untracked.push(a.title || a.type);
      continue;
    }
    marks.push({
      id: devices.map((d) => d.sn).sort().join('+'),
      name: a.title || a.type,
      kind: devices.length > 1 ? 'gate' : 'mark',
      positions: devices.map((d) => markPos(d.sn)!),
      tracks: devices.map((d) => markTrack(d.sn)),
    });
  }
  if (!finishLine && race.finishes?.[0]?.lineLeftLocation && race.finishes[0].lineRightLocation) {
    const [llon, llat] = race.finishes[0].lineLeftLocation.coordinates;
    const [rlon, rlat] = race.finishes[0].lineRightLocation.coordinates;
    finishLine = { left: { lat: llat, lon: llon }, right: { lat: rlat, lon: rlon } };
  }

  // Boats: telemetry competitor rows keyed by sail number, falling back to device serial.
  const bySail = new Map<string, Map<number, Row[]>>();
  const bySn = new Map<number, Row[]>();
  for (const r of rows) {
    if (r.role !== 'competitor') continue;
    let s = bySn.get(r.sn);
    if (!s) bySn.set(r.sn, (s = []));
    s.push(r);
    if (!r.sail) continue;
    let m = bySail.get(r.sail);
    if (!m) bySail.set(r.sail, (m = new Map()));
    let l = m.get(r.sn);
    if (!l) m.set(r.sn, (l = []));
    l.push(r);
  }
  const stats = new Map((st.startingStats ?? []).map((s) => [s.sailNumber, s]));
  const finishes = new Map((race.finishes ?? []).map((f) => [f.sailNumber, f]));
  const ocs = new Set((st.ocsParticipants ?? []).filter((s) => !(st.clearedOcs ?? []).includes(s)));
  const defaultBowCm = div.offsetOverrideCm ?? 0;
  const rowsOf = (sail: string): Row[] | undefined => {
    const devs = bySail.get(sail);
    if (devs?.size) return [...devs.values()].sort((a, b) => b.length - a.length)[0];
    const serial = stats.get(sail)?.serialNumber || finishes.get(sail)?.serialNumber;
    return serial ? bySn.get(snFromHex(serial)) : undefined;
  };
  // Each finisher's own track gun → finish, to excuse a device distance counter that skipped dropouts.
  const [sLat, sLon] = st.startLine.leftEnd;
  const [eLat, eLon] = st.startLine.rightEnd;
  const lineMid = { lat: (sLat + eLat) / 2, lon: (sLon + eLon) / 2 };
  const evidence = new Map<string, TrackEvidence>();
  for (const [sail, f] of finishes) {
    const rows = rowsOf(sail);
    const fms = Date.parse(f.finishingTime);
    const ev = rows && Number.isFinite(fms) ? trackEvidence(rows, gunMs, fms, lineMid) : null;
    if (ev) evidence.set(sail, ev);
  }
  const reaches = [...evidence.values()].map((e) => e.reachM);
  const medReach = reaches.length >= FINISH_MEDIAN_MIN ? median(reaches) : null;
  const entries = entryResults(div, race, (sail, deviceM, medDist) => {
    const ev = evidence.get(sail);
    return !!ev && trackExplainsDistance(ev, deviceM, Date.parse(finishes.get(sail)!.finishingTime) - gunMs, medDist, medReach);
  });

  const boats: Boat[] = [];
  for (const p of div.participants ?? []) {
    const sail = p.sailNumber;
    const trackRows = rowsOf(sail);
    if (!trackRows || trackRows.length < 10) continue;
    const fin = finishes.get(sail);
    const fms = fin ? Date.parse(fin.finishingTime) : NaN;
    const rc = rcStartFix(stats.get(sail), div, race, st);
    boats.push({
      id: sail,
      sail,
      name: p.boatName?.trim() || `#${sail}`,
      // RaceSense uses -1 (any negative) for "not set".
      bowOffsetM: (p.bowOffsetCm != null && p.bowOffsetCm >= 0 ? p.bowOffsetCm : defaultBowCm) / 100,
      track: toTrack(trackRows, imu),
      finishMs: Number.isFinite(fms) ? fms : null,
      ocs: ocs.has(sail),
      rcDtlM: rc.status === 'ok' ? rc.dtlM : null,
      rc,
      ...(p.bowNumber ? { bowNumber: p.bowNumber } : {}),
      ...(entries.has(sail) ? { entry: entries.get(sail)! } : {}),
    });
  }
  if (!boats.length) throw new Error('No boat tracks in the telemetry for this race');

  const [lLat, lLon] = st.startLine.leftEnd;
  const [rLat, rLon] = st.startLine.rightEnd;
  const startLine: Line = { left: { lat: lLat, lon: lLon }, right: { lat: rLat, lon: rLon } };
  const mid = { lat: (lLat + rLat) / 2, lon: (lLon + rLon) / 2 };
  const ws = windSamples(opts.wind, mid);

  const data: RaceData = {
    source: {
      kind: opts.kind ?? 'racesense',
      label: opts.kind === 'fixture' ? 'Offline fixture (RaceSense public feed snapshot)' : 'RaceSense public feed',
      eventId: opts.eventId,
    },
    eventName: doc.name,
    division: div.name,
    boatClass: div.boatClass ?? div.name,
    raceNumber: race.raceNumber,
    gunMs,
    dtlSampleOffsetMs: RACESENSE_DTL_SAMPLE_OFFSET_MS,
    tzOffsetMs: tzOffsetMs(race.timezoneOffset),
    startLine,
    finishLine,
    course: marks,
    boats,
  };
  if (opts.classLabel) data.classLabel = opts.classLabel;
  if (untracked.length) data.courseUntracked = untracked;
  const results = resolveResults(boats, rowsOf, rows, {
    gunMs,
    startMid: mid,
    course,
    finishLine,
    rsFinishes: fins.length,
    official: opts.official ?? null,
    nextGunMs: opts.nextGunMs ?? null,
  });
  if (results) data.results = results;
  if (ws?.length) {
    data.windModel = { label: opts.wind?.modelLabel ?? opts.wind?.model ?? 'weather model', samples: ws };
  }
  return data;
}
