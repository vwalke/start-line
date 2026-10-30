/**
 * RaceSense source adapter: turns the public RaceSense responses (regatta
 * document + teleapi telemetry pages + optional model wind) into the
 * normalized `RaceData`. Pure functions only; fetching lives in api.ts so
 * the same code runs against the offline fixtures in tests.
 */
import { bowFixes, committeeAt, EST_MIN_SHARE, estimateFinish, farEndBoats } from '../finishEstimate';
import {
  awayFromStart,
  bearingDeg,
  courseAxisDeg,
  crossings,
  destination,
  feedRaceNumber,
  fleetOnsetFloor,
  lastLegFrom,
  lineFrom,
  officialTimesPlausible,
  trackerFinish,
  PLAUSIBLE_SEARCH_MS,
  TELEPORT_KN,
  TELEPORT_MIN_M,
  type Fix,
  type MarkSeries,
  type Plausibility,
} from '../finishes';
import { holeFinish, lineFix, withLineFix } from '../holeFinish';
import { finishedWithCode } from '../official/codes';
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

/** Two finish-line ends this close (m) are the same: a record copied from another race carries that race's line exactly. */
export const COPIED_LINE_M = 2;
/**
 * …and a copy's line is at least this far (m, either end) from the line the race's own records carry: a committee
 * that re-lays its line between races moves it tens of metres, and a device may keep the old ends (J/88 NAs race 8).
 */
export const COPY_OFF_LINE_M = 100;

/** Metres between two [lon, lat] points (equirectangular: line ends, metres apart). */
function lonLatM(a: [number, number], b: [number, number]): number {
  const kx = 111_195 * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 111_195);
}

/**
 * The race's finish records, less any copied over from another race of the division (`races`). A record's
 * `raceNumber` is the device's own race count: often offset from the regatta's (every J/105 race 2 finish reads 3), 0
 * when unknown, and a late boat's device can count differently, so a number alone drops nothing. A record is a copy
 * when its number differs from the one most of the race's records carry, the same sail has a record in another race
 * with the same line (COPIED_LINE_M, both ends) or the same finish time, and its line is COPY_OFF_LINE_M or more from
 * the race's own (Star NAs race 4: 8318's record with race 3's number and race 3's line, ~2 km down the course).
 */
export function raceFinishes(race: Pick<Race, 'finishes'>, races: readonly Pick<Race, 'finishes'>[] = []): Finish[] {
  const fins = race.finishes ?? [];
  const counts = new Map<number, number>();
  for (const f of fins) if (f.raceNumber) counts.set(f.raceNumber, (counts.get(f.raceNumber) ?? 0) + 1);
  const known = [...counts.values()].reduce((a, b) => a + b, 0);
  const [rn, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  if (n <= known / 2) return fins;
  const own = recordsLine(fins.filter((f) => !f.raceNumber || f.raceNumber === rn));
  const ends = (f: Finish): [[number, number], [number, number]] | null =>
    f.lineLeftLocation?.coordinates && f.lineRightLocation?.coordinates ? [f.lineLeftLocation.coordinates, f.lineRightLocation.coordinates] : null;
  const copied = (f: Finish): boolean => {
    if (!f.raceNumber || f.raceNumber === rn) return false;
    const e = ends(f);
    if (!e || !own) return false;
    const offLine = Math.max(lonLatM(e[0], [own.left.lon, own.left.lat]), lonLatM(e[1], [own.right.lon, own.right.lat])) >= COPY_OFF_LINE_M;
    if (!offLine) return false;
    const t = Date.parse(f.finishingTime);
    return races.some(
      (r) =>
        r !== race &&
        (r.finishes ?? []).some((g) => {
          if (g.sailNumber !== f.sailNumber) return false;
          const ge = ends(g);
          const sameLine = !!ge && lonLatM(ge[0], e[0]) <= COPIED_LINE_M && lonLatM(ge[1], e[1]) <= COPIED_LINE_M;
          return sameLine || Date.parse(g.finishingTime) === t;
        }),
    );
  };
  return fins.filter((f) => !copied(f));
}

function finishMs(race: Race, races: readonly Race[]): number[] {
  return raceFinishes(race, races).map((f) => Date.parse(f.finishingTime)).filter(Number.isFinite);
}

/** Every non-practice race with a gun (with `practice`, practice races too), newest first. */
export function listRaces(doc: RegattaDoc, opts: { practice?: boolean } = {}): RaceListItem[] {
  const out: RaceListItem[] = [];
  for (const div of doc.divisions ?? []) {
    for (const race of div.races ?? []) {
      if (race.isPractice && !opts.practice) continue;
      const st = raceStart(race);
      if (!st || st.startTime == null) continue;
      const fins = finishMs(race, div.races ?? []);
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
  const { div, race } = findRace(doc, ref);
  const st = raceStart(race);
  if (!st?.startTime) throw new Error('Race has no start time');
  const fins = finishMs(race, div.races ?? []);
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
/** …and its max speed is at most this multiple of the race's median max (a media RIB logged 23 kt vs ~14; see FINISH_CROSS_MS). */
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

/**
 * The device's max speed is a summary that can carry one bad reading: C31 Gold Cup race 2, GER 80's
 * said 30.4 kt against the fleet's 14.2 kt while its own track topped out at 14.2 kt and crossed the
 * finish line ~8 m inside its end at the reported time. So in the race with telemetry a fast device
 * max is excused when the track itself (after dropFleetOutliers, dropSogSpikes…) tops out within
 * FINISH_MAX_SPEED_X of the fleet's tracks and crosses the finish line between its ends within this
 * of the reported finish (trackExplainsSpeed). A media RIB's track is as fast as its summary, and a
 * spare on a committee boat never sails the course (it also fails the distance test): both stay implausible.
 */
export const FINISH_CROSS_MS = 30_000;

/** What one boat's own track shows from the gun to its finish. */
export interface TrackEvidence {
  /** Path length, holes bridged by a straight line (a lower bound), m. */
  pathM: number;
  /** Time in holes over FINISH_HOLE_MS, including before the first and after the last fix, ms. */
  holeMs: number;
  /** Furthest distance from `from` (the start line's middle), m. */
  reachM: number;
  /** Highest reported SOG, kt; null with no reading. */
  topKn: number | null;
  /** Does the track cross the finish line within FINISH_CROSS_MS of the finish? (false with no line given) */
  crossesLine: boolean;
}

/** A track's path, holes, reach and top speed over [gunMs, finishMs] (and its crossing of `lineAt` near finishMs); null with no fix in that window. */
export function trackEvidence(
  rows: { ts: number; lat: number; lon: number; sog?: number }[],
  gunMs: number,
  finishMs: number,
  from: LatLon,
  lineAt?: ((t: number) => Line | null) | null,
): TrackEvidence | null {
  const w = rows.filter((r) => r.ts >= gunMs && r.ts <= finishMs);
  if (!w.length) return null;
  let pathM = 0;
  let reachM = 0;
  let holeMs = 0;
  let topKn: number | null = null;
  const hole = (ms: number): number => (ms > FINISH_HOLE_MS ? ms : 0);
  w.forEach((r, i) => {
    reachM = Math.max(reachM, metresBetween(from, r));
    if (r.sog != null && Number.isFinite(r.sog)) topKn = Math.max(topKn ?? 0, r.sog);
    if (i) {
      pathM += metresBetween(w[i - 1], r);
      holeMs += hole(r.ts - w[i - 1].ts);
    }
  });
  holeMs += hole(w[0].ts - gunMs) + hole(finishMs - w[w.length - 1].ts);
  const crossesLine = !!lineAt && crossings(rows, lineAt, finishMs - FINISH_CROSS_MS, finishMs + FINISH_CROSS_MS).length > 0;
  return { pathM, holeMs, reachM, topKn, crossesLine };
}

/**
 * Does the track excuse a device max speed over FINISH_MAX_SPEED_X × the fleet's (see FINISH_CROSS_MS)? It sailed
 * the course (FINISH_MIN_REACH_FRAC of the fleet's reach: a tracker parked on the line can jitter across it), its
 * top speed is within FINISH_MAX_SPEED_X of `medTopKn` (the finishers' median track top speed), and it crossed.
 */
export function trackExplainsSpeed(ev: Pick<TrackEvidence, 'topKn' | 'crossesLine' | 'reachM'>, medTopKn: number | null, medReach: number | null): boolean {
  if (!ev.crossesLine || ev.topKn == null || medTopKn == null || medReach == null) return false;
  return ev.reachM >= FINISH_MIN_REACH_FRAC * medReach && ev.topKn <= FINISH_MAX_SPEED_X * medTopKn;
}

/** Does the track excuse a device distance `deviceM` under FINISH_MIN_DIST_FRAC × `medDist` (see FINISH_MIN_REACH_FRAC)? */
export function trackExplainsDistance(ev: Pick<TrackEvidence, 'pathM' | 'holeMs' | 'reachM'>, deviceM: number, raceMs: number, medDist: number, medReach: number | null): boolean {
  if (medReach == null || !(raceMs > 0) || ev.reachM < FINISH_MIN_REACH_FRAC * medReach) return false;
  const holesM = (ev.holeMs * medDist) / raceMs;
  return Math.min(deviceM, ev.pathM) + holesM >= FINISH_MIN_DIST_FRAC * medDist;
}

/** Waivers from the race's own tracks: a short device distance, a fast device max speed. */
export interface FinishExcuse {
  distance?: (sail: string, deviceM: number, medDist: number) => boolean;
  speed?: (sail: string) => boolean;
}

/** Why a finish looks wrong against its race's medians, or null when it looks like a real one; `excuse` may waive either test. */
function implausibleFinish(f: Finish, medDist: number | null, medMax: number | null, excuse?: FinishExcuse): string | null {
  const d = num(f.distanceTraveled);
  const v = num(f.maxSpeed);
  if (d != null && medDist != null && d < FINISH_MIN_DIST_FRAC * medDist && !excuse?.distance?.(f.sailNumber, d, medDist)) {
    return `the feed has it sailing ${(d / 1000).toFixed(1)} km against the fleet's ${(medDist / 1000).toFixed(1)} km`;
  }
  if (v != null && medMax != null && v > FINISH_MAX_SPEED_X * medMax && !excuse?.speed?.(f.sailNumber)) {
    return `the feed has a max speed of ${Math.round(v)} kt against the fleet's ${Math.round(medMax)} kt`;
  }
  return null;
}

/**
 * Event-wide results per sail number: every non-practice race of the division
 * that has finishes. `excuse` may waive a short distance or a fast max speed in
 * this race (the only one with telemetry: see trackExplainsDistance, trackExplainsSpeed).
 */
export function entryResults(div: Division, race: Race, excuse?: FinishExcuse): Map<string, EntryResults> {
  const out = new Map<string, EntryResults>();
  const get = (sail: string): EntryResults => {
    let e = out.get(sail);
    if (!e) out.set(sail, (e = { racesWithResults: 0, plausibleFinishes: 0, finishPlausible: null }));
    return e;
  };
  const raced = (div.races ?? []).filter((r) => !r.isPractice && raceFinishes(r, div.races ?? []).length);
  for (const p of div.participants ?? []) get(p.sailNumber);
  for (const r of raced) {
    const fins = raceFinishes(r, div.races ?? []);
    const dists = fins.map((f) => num(f.distanceTraveled)).filter((x): x is number => x != null);
    const maxes = fins.map((f) => num(f.maxSpeed)).filter((x): x is number => x != null);
    const medDist = dists.length >= FINISH_MEDIAN_MIN ? median(dists) : null;
    const medMax = maxes.length >= FINISH_MEDIAN_MIN ? median(maxes) : null;
    const bySail = new Map(fins.map((f) => [f.sailNumber, f]));
    for (const [sail, e] of out) {
      e.racesWithResults++;
      const f = bySail.get(sail);
      if (!f) continue;
      const why = implausibleFinish(f, medDist, medMax, r === race ? excuse : undefined);
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

/**
 * A competitor fix further than this from the fleet's position at the time is
 * no position of that boat. C31 Gold Cup race 4: GER 8's tracker sent 132
 * fixes ~233 km east of the course, at 19–41 kn, from 129 s before the gun to
 * 82 s after it; they had it fastest at the gun (27.2 kn), 182 km from the
 * line, and stretched the start speed chart to 40 kn. A fleet spans a few km.
 */
export const FLEET_OUTLIER_M = 20_000;
/** The fleet's position is a median per bucket this long (each boat's own median in it first). */
export const FLEET_OUTLIER_BUCKET_MS = 30_000;
/** Fewer boats than this in a bucket and there is no fleet to measure against: nothing is dropped. */
export const FLEET_OUTLIER_MIN_BOATS = 5;

/**
 * Drop competitor fixes over FLEET_OUTLIER_M from the fleet: per FLEET_OUTLIER_BUCKET_MS bucket, the
 * component-wise median of each device's median position. A bucket counts only with FLEET_OUTLIER_MIN_BOATS
 * devices, most of them within FLEET_OUTLIER_M of that median (else it isn't the fleet's: a fleet split in
 * two, or mostly bad fixes). Other roles (marks, coach and committee boats) are kept as they are. Order is kept.
 */
export function dropFleetOutliers<R extends { ts: number; sn: number; role: string; lat: number; lon: number }>(rows: R[]): R[] {
  const bucketOf = (ts: number): number => Math.floor(ts / FLEET_OUTLIER_BUCKET_MS);
  const buckets = new Map<number, Map<number, { lat: number[]; lon: number[] }>>();
  for (const r of rows) {
    if (r.role !== 'competitor') continue;
    const k = bucketOf(r.ts);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = new Map()));
    let p = b.get(r.sn);
    if (!p) b.set(r.sn, (p = { lat: [], lon: [] }));
    p.lat.push(r.lat);
    p.lon.push(r.lon);
  }
  const fleet = new Map<number, LatLon>();
  for (const [k, b] of buckets) {
    if (b.size < FLEET_OUTLIER_MIN_BOATS) continue;
    const boats = [...b.values()].map((p) => ({ lat: median(p.lat), lon: median(p.lon) }));
    const c = { lat: median(boats.map((p) => p.lat)), lon: median(boats.map((p) => p.lon)) };
    const near = boats.filter((p) => metresBetween(p, c) <= FLEET_OUTLIER_M).length;
    if (2 * near > boats.length) fleet.set(k, c);
  }
  if (!fleet.size) return rows;
  const kept = rows.filter((r) => {
    const c = r.role === 'competitor' ? fleet.get(bucketOf(r.ts)) : undefined;
    return !c || metresBetween(r, c) <= FLEET_OUTLIER_M;
  });
  return kept.length === rows.length ? rows : kept;
}

/**
 * Some trackers re-send an old held fix among their live ones: the boat zig-zags between where it is and
 * where it was. A moving boat (reported SOG over this) is never at the exact coordinates it reported
 * before, so such a fix is a replay. Cascais J/70 Worlds race 3: ESP 1283 and BRA641 each replayed one
 * fix ~1.9 km off their track 145–173 times (563 and 746 km of path for a 22 km race); Dutch Grand Prix
 * Dragon race 4: GBR 818, 978 replays 1.4 km off; ILCA 6 Worlds Elimination Silver race 3: CHI 199268,
 * 699 replays ~1 km off. At or under it the boat may be sitting still and keeps its repeated fixes.
 * A fix equal to the tracker's last one kept is a hold, not a replay, and stays: the clean fixtures'
 * only repeats while moving are such holds (1–19 a race).
 */
export const REPLAY_MIN_SOG_KN = 1;

/**
 * Drop competitor fixes whose exact lat/lon the same tracker reported earlier while moving (SOG over
 * REPLAY_MIN_SOG_KN; no SOG reading counts as not moving), unless it is the tracker's last kept fix again.
 * The first report is kept. Rows sorted by time; other roles and order are kept as they are.
 */
export function dropReplayedFixes<R extends { sn: number; role: string; lat: number; lon: number; sog: number }>(rows: R[]): R[] {
  // Per tracker: latitude → the longitudes reported at it (numbers, not string keys: ~1M rows a race).
  const seen = new Map<number, Map<number, Set<number>>>();
  const last = new Map<number, R>();
  const replay = (r: R): boolean => {
    if (r.role !== 'competitor') return false;
    let s = seen.get(r.sn);
    if (!s) seen.set(r.sn, (s = new Map()));
    let lons = s.get(r.lat);
    if (!lons) s.set(r.lat, (lons = new Set()));
    if (!lons.has(r.lon)) lons.add(r.lon);
    else if (r.sog > REPLAY_MIN_SOG_KN) {
      const p = last.get(r.sn);
      if (!p || p.lat !== r.lat || p.lon !== r.lon) return true;
    }
    last.set(r.sn, r);
    return false;
  };
  const kept = rows.filter((r) => !replay(r));
  return kept.length === rows.length ? rows : kept;
}

const MS_PER_KN = 1852 / 3600;

/**
 * Impossible steps (data/finishes.ts TELEPORT_MIN_M at TELEPORT_KN). J/70 North Americans race 6: 898's tracker
 * sent 6 fixes over 6.3 s ~16.5 km off the course, entered at ~16,900 kn and left at ~8,700 kn, and the boat went
 * on from where it had been. Within FLEET_OUTLIER_M of the fleet, so they stayed, and the race's extent took them
 * in. Cascais J/70 Worlds (Open) races 6 and 9: POR 1685's and DEN 1185's tracks began with 1–4 stale fixes from
 * the previous race, 2.3–3.3 km off.
 */
export { TELEPORT_KN, TELEPORT_MIN_M };
/** A run of fixes cut off by impossible steps is dropped only if it lasts at most this long. */
export const TELEPORT_RUN_MS = 120_000;

function impossibleStep(a: { ts: number; lat: number; lon: number }, b: { ts: number; lat: number; lon: number }): boolean {
  const m = metresBetween(a, b);
  if (m <= TELEPORT_MIN_M) return false;
  const s = (b.ts - a.ts) / 1000;
  return s <= 0 || m / s / MS_PER_KN > TELEPORT_KN;
}

/** The runs [from, to) to drop from one tracker's fixes (sorted by time), or none. */
function teleportRuns(s: { ts: number; lat: number; lon: number }[]): [number, number][] {
  const jumps: number[] = [];
  for (let i = 1; i < s.length; i++) if (impossibleStep(s[i - 1], s[i])) jumps.push(i);
  if (!jumps.length) return [];
  const short = (from: number, to: number): boolean => s[to - 1].ts - s[from].ts <= TELEPORT_RUN_MS;
  const runs: [number, number][] = [];
  // Out and back: the fixes either side of the run are close, and going straight between them is possible.
  for (let j = 0; j + 1 < jumps.length; j++) {
    const [a, b] = [jumps[j], jumps[j + 1]];
    if (!short(a, b)) continue;
    const [before, after] = [s[a - 1], s[b]];
    const out = Math.min(metresBetween(before, s[a]), metresBetween(s[b - 1], after));
    if (metresBetween(before, after) < out / 2 && !impossibleStep(before, after)) {
      runs.push([a, b]);
      j++;
    }
  }
  if (runs.length) return runs;
  // At either end: a short run of one stale fix (possibly repeated), with fewer fixes than the rest.
  const stale = (from: number, to: number): boolean => s.slice(from, to).every((r) => r.lat === s[from].lat && r.lon === s[from].lon);
  const [first, last, n] = [jumps[0], jumps[jumps.length - 1], s.length];
  if (short(0, first) && first < n - first && stale(0, first)) runs.push([0, first]);
  if (short(last, n) && n - last < last && stale(last, n)) runs.push([last, n]);
  return runs;
}

/**
 * Drop a competitor tracker's fixes reached and left by impossible steps (TELEPORT_MIN_M at TELEPORT_KN):
 * a run of fixes lasting at most TELEPORT_RUN_MS that jumps out and back to about where it left, or one at
 * the start or end of the tracker's fixes, shorter than the rest and all at the exact same coordinates (one
 * stale fix, possibly repeated). Repeated until none is left, as dropping one run can show another. A single
 * jump to a moving run is kept, mid-track or at its end: a frozen tracker catching up with the boat (J/70
 * North Americans race 6: 151 held one position ~350 s, then moved 912 m in 1.3 s and went on from there;
 * C31 Gold Cup race 8: GER 21 held, jumped 1,258 m in 0.3 s and sailed on at 8–11 kn for its last 116 s).
 * Rows sorted by time; other roles and order are kept as they are.
 */
export function dropTeleports<R extends { ts: number; sn: number; role: string; lat: number; lon: number }>(rows: R[]): R[] {
  const bySn = new Map<number, R[]>();
  for (const r of rows) {
    if (r.role !== 'competitor') continue;
    let s = bySn.get(r.sn);
    if (!s) bySn.set(r.sn, (s = []));
    s.push(r);
  }
  const dropped = new Set<R>();
  for (let s of bySn.values()) {
    for (let runs = teleportRuns(s); runs.length; runs = teleportRuns(s)) {
      const cut = new Set<R>();
      for (const [from, to] of runs) for (let i = from; i < to; i++) cut.add(s[i]);
      for (const r of cut) dropped.add(r);
      s = s.filter((r) => !cut.has(r));
    }
  }
  return dropped.size ? rows.filter((r) => !dropped.has(r)) : rows;
}

/**
 * A reported SOG over this is checked against the fix's position-derived speed. Real readings go past it
 * (M32s racing at 25–29 kn; monohulls towed or motoring in at up to ~47 kn) and their positions agree.
 */
export const SOG_SPIKE_CEIL_KN = 25;
/**
 * …and is a spike when over SOG_SPIKE_X × that speed + SOG_SPIKE_MARGIN_KN. The speed is the faster of the
 * legs to the nearest fix before and after at another position (a held position is skipped), each within
 * SOG_SPIKE_REACH_MS. With neither in reach there is nothing to check against and the reading stays.
 */
export const SOG_SPIKE_X = 2;
export const SOG_SPIKE_MARGIN_KN = 10;
export const SOG_SPIKE_REACH_MS = 10_000;

/**
 * Null out (NaN: the analysis fills it from the positions, as for any missing SOG) a competitor's reported
 * SOG that is over SOG_SPIKE_CEIL_KN and SOG_SPIKE_X × its position-derived speed + SOG_SPIKE_MARGIN_KN.
 * M15 Gulf Coast race 1: boats 69 (6771 kn) and 409 (1496 kn) each sent one such reading at a good
 * position, sailing ~5–7 kn; C of C race 1 one of 11,948 kn. The fix itself is kept. Rows sorted by time.
 * Over 725 scanned races these three are the only readings nulled (after dropFleetOutliers); a spike at a
 * garbage position (0°, 166° E) passes, as its position moves as fast.
 */
export function dropSogSpikes(rows: { ts: number; sn: number; role: string; lat: number; lon: number; sog: number }[]): void {
  const hot = rows.some((r) => r.role === 'competitor' && r.sog > SOG_SPIKE_CEIL_KN);
  if (!hot) return;
  const bySn = new Map<number, typeof rows>();
  for (const r of rows) {
    if (r.role !== 'competitor') continue;
    let s = bySn.get(r.sn);
    if (!s) bySn.set(r.sn, (s = []));
    s.push(r);
  }
  for (const s of bySn.values()) {
    s.forEach((r, i) => {
      if (!(r.sog > SOG_SPIKE_CEIL_KN)) return;
      let kn = -1;
      for (const step of [-1, 1]) {
        let j = i + step;
        while (s[j] && s[j].lat === r.lat && s[j].lon === r.lon && Math.abs(s[j].ts - r.ts) <= SOG_SPIKE_REACH_MS) j += step;
        const q = s[j];
        const dt = q ? Math.abs(q.ts - r.ts) : 0;
        if (dt > 0 && dt <= SOG_SPIKE_REACH_MS) kn = Math.max(kn, metresBetween(q, r) / (dt / 1000) / MS_PER_KN);
      }
      if (kn >= 0 && r.sog > SOG_SPIKE_X * kn + SOG_SPIKE_MARGIN_KN) r.sog = NaN;
    });
  }
}

/**
 * A sail with two or more competitor trackers is drawn from the one covering the most ground: distinct
 * cells of this many degrees (~11 m). A stuck tracker can send the most rows: Melges 24 Nationals races
 * 1–3, USA 853's spare sent 5–19k rows at one position against the live one's ~2.8k; Star Worlds race 6,
 * USA 8520's flipped between 3 positions (24k rows, 2 cells) against 1.8k rows over 1,183 cells. Cells,
 * not exact positions: ILCA 6 Worlds Elimination Silver race 1, CZE 212985's idle tracker jittered over
 * 1,641 exact positions (the live one: 1,760) but 6 cells (616).
 */
export const TRACKER_CELL_DEG = 1e-4;

/** The tracker a sail is drawn from: most TRACKER_CELL_DEG cells, then most rows (the first on a tie). */
export function liveTracker<R extends { lat: number; lon: number }>(devs: R[][]): R[] | undefined {
  if (devs.length < 2) return devs[0];
  const cells = (rs: R[]): number => new Set(rs.map((r) => `${Math.round(r.lat / TRACKER_CELL_DEG)},${Math.round(r.lon / TRACKER_CELL_DEG)}`)).size;
  return devs
    .map((rs) => ({ rs, cells: cells(rs) }))
    .reduce((best, d) => (d.cells > best.cells || (d.cells === best.cells && d.rs.length > best.rs.length) ? d : best)).rs;
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

/** The drawn finish line is where its trackers were from this long before the first finish to this long after the last, ms. */
export const FINISH_LINE_PAD_MS = 60_000;

/** The finish line the race's finish records carry (lineLeftLocation / lineRightLocation), median over them; null with none. */
export function recordsLine(fins: readonly Finish[]): Line | null {
  const ends = fins.filter((f) => f.lineLeftLocation?.coordinates && f.lineRightLocation?.coordinates);
  if (!ends.length) return null;
  const at = (side: 'lineLeftLocation' | 'lineRightLocation'): LatLon => ({
    lat: median(ends.map((f) => f[side]!.coordinates[1])),
    lon: median(ends.map((f) => f[side]!.coordinates[0])),
  });
  return { left: at('lineLeftLocation'), right: at('lineRightLocation') };
}

/** A mark tracker's fixes from the rows. */
function markSeries(rows: Row[], hex: string): MarkSeries {
  const sn = snFromHex(hex);
  const s: MarkSeries = { t: [], lat: [], lon: [] };
  for (const r of rows) {
    if (r.role !== 'mark' || r.sn !== sn) continue;
    s.t.push(r.ts);
    s.lat.push(r.lat);
    s.lon.push(r.lon);
  }
  return s;
}

/** The finish line over time: its two trackers where they were (finishDevices), else the fixed `finishLine`; null with neither. */
function finishLineAt(course: Course | null, rows: Row[], finishLine: Line | null): ((t: number) => Line | null) | null {
  const dev = finishDevices(course);
  if (dev) {
    const l = markSeries(rows, dev.left);
    const r = markSeries(rows, dev.right);
    if (l.t.length && r.t.length) return lineFrom(l, r);
  }
  return finishLine ? () => finishLine : null;
}

/** The committee boat's tracker: the start line's right end. */
function committeeDevice(course: Course | null): string | null {
  const a = course?.achievements?.find((x) => x.type === 'startLine');
  return a?.deviceRoles.find((d) => /right/i.test(d.role))?.sn ?? null;
}

/**
 * Decide places and finish times (RaceData.results, Boat.finishSource / official*): official
 * places and codes when linked, with official times only if plausible (data/finishes.ts), else
 * RaceSense's finish or the tracker crossing; with no official results and no RaceSense
 * finishes, tracker crossings. A race with RaceSense finishes and no official results is left as it was.
 * With `estimate` (no finish line in the feed), when the start line standing in for it doesn't do (too few
 * finishers cross it, or the official times disagree with it), the crossings are of a line estimated off the
 * committee boat instead (data/finishEstimate.ts), returned as `estimated`.
 */
function resolveResults(
  boats: Boat[],
  rowsOf: (sail: string) => Row[] | undefined,
  rows: Row[],
  ctx: {
    gunMs: number;
    startMid: LatLon;
    startLine: Line;
    axisDeg: number;
    course: Course | null;
    finishLine: Line | null;
    estimate: boolean;
    rsFinishes: number;
    official: OfficialRaceInput | null;
    nextGunMs: number | null;
  },
): { results?: RaceResults; estimated?: Line } {
  const { gunMs, official } = ctx;
  if (!official && ctx.rsFinishes > 0) return {};
  const lastTs = rows.length ? rows[rows.length - 1].ts : gunMs;
  const endMs = Math.min(lastTs, ctx.nextGunMs != null ? ctx.nextGunMs - 30_000 : Infinity);
  const series = (hex: string): MarkSeries => markSeries(rows, hex);
  const lineAt = finishLineAt(ctx.course, rows, ctx.finishLine);
  // The line the finishes are found on: the feed's, else one estimated below.
  let finishAt = lineAt;
  const fixes = new Map<string, Row[]>();
  for (const b of boats) fixes.set(b.id, rowsOf(b.sail) ?? []);
  const feedRn = feedRaceNumber(fixes.values(), gunMs);
  const floor = fleetOnsetFloor(fixes.values(), gunMs, feedRn);
  const tracker = new Map<string, number>();
  if (lineAt) {
    for (const b of boats) {
      const t = trackerFinish(fixes.get(b.id)!, lineAt, gunMs, endMs, feedRn, floor, ctx.axisDeg);
      if (t != null) tracker.set(b.id, t);
    }
  }

  const byRs = new Map((official?.rows ?? []).filter((r) => r.rsSail).map((r) => [r.rsSail!, r]));
  const utc = (wall: number | null): number | null => (wall == null || !official ? null : wall - official.tzOffsetMs);
  // A boat that finished with a code (DPI, SCP, …; DSQ / UFD / BFD with a finish time) is a finisher here: its
  // time counts for the plausibility check and it keeps its finish (codes.ts finishedWithCode).
  const finished = (r: OfficialResultRow | undefined): boolean => !!r && (r.code == null || finishedWithCode(r.code, r.finishWallMs != null));
  const isFinisher = (r: OfficialResultRow | undefined): boolean => !!r && ((r.code == null && r.place != null) || (r.code != null && finished(r)));
  const fins = (official?.rows ?? []).filter(isFinisher);
  const allOfficial = fins.map((r) => utc(r.finishWallMs)).filter((t): t is number => t != null);
  const plausible = (la: ((t: number) => Line | null) | null, fx: (b: Boat) => readonly Fix[]): Plausibility => {
    const pairs = boats
      .map((b) => ({ b, o: byRs.get(b.sail) }))
      .filter((x) => finished(x.o) && utc(x.o!.finishWallMs) != null)
      .map(({ b, o }) => ({ officialMs: utc(o!.finishWallMs)!, crossings: la ? crossings(fx(b), la, gunMs, endMs + PLAUSIBLE_SEARCH_MS) : [] }));
    return allOfficial.length ? officialTimesPlausible(pairs, gunMs, ctx.nextGunMs, allOfficial) : { ok: false, n: 0, medianS: null, why: 'no official finish times' };
  };
  let plaus = official ? plausible(lineAt, (b) => fixes.get(b.id)!) : null;

  // No finish line in the feed: when the start line doesn't do for one, a line off the committee boat. The start
  // line does when most finishers cross it, and the official times agree with it (AYC finishes on it); a line
  // estimated anyway replaces it only if it does better: the official times agree with it, or (none) more cross it.
  let estimated: Line | undefined;
  if (ctx.estimate) {
    const finishers = official ? new Set(boats.filter((b) => isFinisher(byRs.get(b.sail))).map((b) => b.id)) : farEndBoats(fixes, ctx.startLine, ctx.axisDeg, gunMs, endMs);
    const crossedOf = (m: ReadonlyMap<string, number>): number => [...finishers].filter((id) => m.has(id)).length;
    const startDoes = crossedOf(tracker) >= EST_MIN_SHARE * finishers.size;
    if (finishers.size && !(startDoes && plaus?.ok)) {
      const bow = new Map(boats.map((b) => [b.id, bowFixes(fixes.get(b.id)!, b.bowOffsetM)]));
      const cbHex = committeeDevice(ctx.course);
      const cb = cbHex ? series(cbHex) : null;
      const boatAt = committeeAt(cb?.t.length ? cb : null, ctx.startLine.right);
      const est = estimateFinish({
        boats: boats.map((b) => ({ id: b.id, fixes: bow.get(b.id)!, officialMs: finished(byRs.get(b.sail)) ? utc(byRs.get(b.sail)!.finishWallMs) : null })),
        finishers,
        boatAt,
        baseDeg: bearingDeg(ctx.startLine.left, ctx.startLine.right),
        finishOf: (fx, la) => trackerFinish(fx, la, gunMs, endMs, feedRn, floor, ctx.axisDeg),
      });
      const estPlaus = est && official ? plausible(est.fit.lineAt, (b) => bow.get(b.id)!) : null;
      const better = !startDoes || (estPlaus ? estPlaus.ok : crossedOf(est?.finishes ?? new Map()) > crossedOf(tracker));
      if (est && better) {
        tracker.clear();
        for (const [id, t] of est.finishes) tracker.set(id, t);
        finishAt = est.fit.lineAt;
        if (estPlaus) plaus = estPlaus;
        // Drawn where the committee boat was at the fleet's median finish.
        const ts = [...est.finishes].filter(([id]) => finishers.has(id)).map(([, t]) => t);
        const c = boatAt(ts.length ? median(ts) : gunMs);
        estimated = { left: c, right: destination(c, est.fit.bearingDeg, est.fit.lengthM) };
      }
    }
  }
  const withLine = (results: RaceResults): { results: RaceResults; estimated?: Line } => (estimated ? { results, estimated } : { results });

  if (!official || !plaus) {
    for (const b of boats) {
      const t = tracker.get(b.id);
      b.finishMs = t ?? null;
      if (t != null) b.finishSource = 'tracker';
      // No RaceSense finishes confirm who raced: a tracker far from the start that never finishes was elsewhere.
      const away = awayFromStart(fixes.get(b.id)!, ctx.startMid, gunMs, t != null);
      if (away) b.notRacing = away;
    }
    return withLine({ places: 'tracker', times: 'tracker', trackerFinishes: tracker.size });
  }

  let trackerN = 0;
  let rsN = 0;
  for (const b of boats) {
    const o = byRs.get(b.sail);
    const rsFin = b.finishMs;
    b.officialPlace = o && o.code == null ? o.place : null;
    b.officialCode = o ? o.code : null;
    b.officialPoints = o?.points ?? null;
    b.onWaterPlace = o?.code != null ? (o.onWater ?? null) : null;
    b.penaltyPlaces = o?.code != null ? (o.penaltyPlaces ?? null) : null;
    if (o?.code === 'OCS') b.ocs = true;
    else if (o && o.code == null) b.ocs = false;
    if (!o || !finished(o)) {
      b.finishMs = null;
      delete b.finishSource;
      continue;
    }
    // Officially placed (or finished with a code): the result stands even with an implausible-looking RaceSense finish.
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
  // An officially placed boat (or one that finished with a code) whose tracker skips the line: timed between the
  // boats placed just ahead and behind that have a finish time (data/holeFinish.ts). Those times are all known
  // first, so one estimate never bounds another; places, codes and points stay the official ones.
  const estimates = new Map<Boat, number>();
  if (finishAt) {
    const rankOf = (o: OfficialResultRow): number | null => (o.code == null ? o.place : (o.onWater ?? null));
    const timed = boats.filter((b) => b.finishMs != null).map((b) => ({ rank: rankOf(byRs.get(b.sail)!), ms: b.finishMs! }));
    const nearest = (r: number, side: 1 | -1): number | null => {
      let best: { rank: number; ms: number } | null = null;
      for (const x of timed) if (x.rank != null && (x.rank - r) * side > 0 && (!best || (x.rank - best.rank) * side < 0)) best = { rank: x.rank, ms: x.ms };
      return best?.ms ?? null;
    };
    for (const b of boats) {
      const o = byRs.get(b.sail);
      if (b.finishMs != null || !o || !finished(o)) continue;
      const fx = fixes.get(b.id)!;
      const w = lastLegFrom(fx, finishAt, gunMs, endMs, feedRn, floor, ctx.axisDeg);
      const r = rankOf(o);
      const est = w && holeFinish({ fixes: fx, lineAt: finishAt, gunMs, endMs, from: w.from, ahead: r != null ? nearest(r, -1) : null, behind: r != null ? nearest(r, 1) : null });
      if (est) estimates.set(b, est.ms);
    }
    for (const [b, ms] of estimates) {
      b.finishMs = ms;
      b.finishSource = 'estimated';
    }
  }
  const tracked = new Set(boats.map((b) => b.sail));
  const out: RaceResults = {
    places: 'official',
    times: plaus.ok ? 'official' : trackerN && rsN ? 'mixed' : rsN ? 'racesense' : 'tracker',
    officialNumber: official.number,
    trackerFinishes: trackerN,
  };
  if (estimates.size) out.estimatedFinishes = estimates.size;
  if (!plaus.ok) out.timesNote = plaus.why ?? 'official times not plausible';
  const noTrack = official.rows.filter((r) => !r.rsSail || !tracked.has(r.rsSail)).map((r) => r.rsSail ?? [r.prefix, r.sail].filter(Boolean).join(' '));
  const noOfficial = boats.filter((b) => !byRs.has(b.sail)).map((b) => b.sail);
  if (noTrack.length) out.officialNoTrack = noTrack;
  if (noOfficial.length) out.trackNoOfficial = noOfficial;
  return withLine(out);
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
  // Before tracks, starts and finishes: replayed fixes go, a boat whose tracker is far off the fleet has no
  // data there, fixes a boat could not have reached (out and back, or stale at a track's ends) go, and a SOG
  // spike is no reading.
  const rows = dropTeleports(dropFleetOutliers(dropReplayedFixes(parseTelemetry(pages))));
  dropSogSpikes(rows);
  // Older feeds (and some fixtures) have no roll / pitch columns at all.
  const imu = pages.some((p) => !!p?.Fields && (p.Fields.includes('roll') || p.Fields.includes('pitch')));
  const fins = finishMs(race, div.races ?? []);
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
  /** A tracker's median position from `a` to `b` (ms), or null with no fix then. */
  const markPosIn = (hex: string, a: number, b: number): LatLon | null => {
    const m = markRows.get(snFromHex(hex));
    const lat: number[] = [];
    const lon: number[] = [];
    m?.t.forEach((t, i) => {
      if (t < a || t > b) return;
      lat.push(m.lat[i]);
      lon.push(m.lon[i]);
    });
    return lat.length ? { lat: median(lat), lon: median(lon) } : null;
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
  // The finish line is the one the race's finish records carry (RaceSense judged the finishes on it); else where the
  // finish trackers were at the finishes (often the committee boat and a pin that move up the course mid-race, to
  // finish at the windward mark); only with neither the trackers' race-long median. Over the cached races the
  // records' line is never further from where the finishers were than the trackers' (Viper NAs race 2: 4 m against
  // 138 m, its trackers left at the start while the fleet finished at the gate).
  const recLine = recordsLine(raceFinishes(race, div.races ?? []));
  for (const a of course?.achievements ?? []) {
    if (a.type === 'startLine') continue;
    if (a.type === 'finishLine') {
      const l = a.deviceRoles.find((d) => /left/i.test(d.role));
      const r = a.deviceRoles.find((d) => /right/i.test(d.role));
      const [f0, f1] = fins.length ? [Math.min(...fins) - FINISH_LINE_PAD_MS, Math.max(...fins) + FINISH_LINE_PAD_MS] : [NaN, NaN];
      const lp = l && (fins.length ? markPosIn(l.sn, f0, f1) : markPos(l.sn));
      const rp = r && (fins.length ? markPosIn(r.sn, f0, f1) : markPos(r.sn));
      if (recLine) finishLine = recLine;
      else if (lp && rp) finishLine = { left: lp, right: rp };
      else if (l && r && markPos(l.sn) && markPos(r.sn)) finishLine = { left: markPos(l.sn)!, right: markPos(r.sn)! };
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
  if (!finishLine && recLine) finishLine = recLine;

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
  const finishes = new Map(raceFinishes(race, div.races ?? []).map((f) => [f.sailNumber, f]));
  const ocs = new Set((st.ocsParticipants ?? []).filter((s) => !(st.clearedOcs ?? []).includes(s)));
  const defaultBowCm = div.offsetOverrideCm ?? 0;
  const live = new Map<string, Row[] | undefined>();
  const rowsOf = (sail: string): Row[] | undefined => {
    const devs = bySail.get(sail);
    if (devs?.size) {
      if (!live.has(sail)) live.set(sail, liveTracker([...devs.values()]));
      return live.get(sail);
    }
    const serial = stats.get(sail)?.serialNumber || finishes.get(sail)?.serialNumber;
    return serial ? bySn.get(snFromHex(serial)) : undefined;
  };
  // Each finisher's own track gun → finish, to excuse a device distance counter that skipped dropouts
  // or a device max speed its track doesn't show.
  const [sLat, sLon] = st.startLine.leftEnd;
  const [eLat, eLon] = st.startLine.rightEnd;
  const lineMid = { lat: (sLat + eLat) / 2, lon: (sLon + eLon) / 2 };
  const finishAt = finishLineAt(course, rows, finishLine);
  const evidence = new Map<string, TrackEvidence>();
  for (const [sail, f] of finishes) {
    const rows = rowsOf(sail);
    const fms = Date.parse(f.finishingTime);
    const ev = rows && Number.isFinite(fms) ? trackEvidence(rows, gunMs, fms, lineMid, finishAt) : null;
    if (ev) evidence.set(sail, ev);
  }
  const reaches = [...evidence.values()].map((e) => e.reachM);
  const medReach = reaches.length >= FINISH_MEDIAN_MIN ? median(reaches) : null;
  const tops = [...evidence.values()].map((e) => e.topKn).filter((x): x is number => x != null && x > 0);
  const medTop = tops.length >= FINISH_MEDIAN_MIN ? median(tops) : null;
  const entries = entryResults(div, race, {
    distance: (sail, deviceM, medDist) => {
      const ev = evidence.get(sail);
      return !!ev && trackExplainsDistance(ev, deviceM, Date.parse(finishes.get(sail)!.finishingTime) - gunMs, medDist, medReach);
    },
    speed: (sail) => {
      const ev = evidence.get(sail);
      return !!ev && trackExplainsSpeed(ev, medTop, medReach);
    },
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
  const axisDeg = courseAxisDeg(startLine, st.windDirection, boats.map((b) => rowsOf(b.sail) ?? []), gunMs);
  const { results, estimated } = resolveResults(boats, rowsOf, rows, {
    gunMs,
    startMid: mid,
    startLine,
    axisDeg,
    course,
    finishLine,
    // Only with no finish line anywhere in the feed and no mark trackers (they would place the course).
    estimate: !finishLine && !marks.length && !(course?.achievements ?? []).some((a) => a.type === 'finishLine'),
    rsFinishes: fins.length,
    official: opts.official ?? null,
    nextGunMs: opts.nextGunMs ?? null,
  });
  if (results) data.results = results;
  if (estimated) {
    data.finishLine = estimated;
    data.finishLineEstimated = true;
  }
  const lineAt = estimated ? () => estimated : finishLineAt(course, rows, finishLine);
  if (lineAt) {
    const all = boats.map((b) => rowsOf(b.sail) ?? []);
    const feedRn = feedRaceNumber(all, gunMs);
    const floor = fleetOnsetFloor(all, gunMs, feedRn);
    const lastTs = rows.length ? rows[rows.length - 1].ts : gunMs;
    const endMs = Math.min(lastTs, opts.nextGunMs != null ? opts.nextGunMs - 30_000 : Infinity);
    for (const b of boats) {
      const fx = rowsOf(b.sail) ?? [];
      if (b.finishMs != null && b.entry?.finishPlausible !== false) {
        // A finish time inside a hole in the boat's tracker, with no crossing: one fix on the line at that time, so
        // the track is drawn and replayed through the line like any finisher's (data/holeFinish.ts lineFix).
        const w = lastLegFrom(fx, lineAt, gunMs, endMs, feedRn, floor, axisDeg);
        const fix = w && lineFix(fx, lineAt, b.finishMs, w.from);
        if (fix) b.track = withLineFix(b.track, fix);
      } else {
        // Display only: a boat with no accepted finish is drawn to its own crossing of the finish line (Boat.lineCrossMs),
        // found as tracker finishes are (the stage onset, else its last visit to the far end), not its first pass of the line.
        const t = trackerFinish(fx, lineAt, gunMs, endMs, feedRn, floor, axisDeg);
        if (t != null) b.lineCrossMs = t;
      }
    }
  }
  if (ws?.length) {
    data.windModel = { label: opts.wind?.modelLabel ?? opts.wind?.model ?? 'weather model', samples: ws };
  }
  return data;
}
