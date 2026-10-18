/**
 * RaceSense source adapter: turns the public RaceSense responses (regatta
 * document + teleapi telemetry pages + optional model wind) into the
 * normalized `RaceData`. Pure functions only; fetching lives in api.ts so
 * the same code runs against the offline fixtures in tests.
 */
import type { Boat, CourseMark, EntryResults, LatLon, Line, MarkTrack, RaceData, RcStart, Track, WindSample } from '../types';
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

/** Every non-practice race with a gun, newest first. */
export function listRaces(doc: RegattaDoc): RaceListItem[] {
  const out: RaceListItem[] = [];
  for (const div of doc.divisions ?? []) {
    for (const race of div.races ?? []) {
      if (race.isPractice) continue;
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

/** Pre-start telemetry fetched for the start-chart trails: covers START_TRAIL_MS (analyze.ts) with margin. */
export const PRE_START_FETCH_MS = 90_000;

/** Telemetry time window worth fetching for a race: a short pre-start (for trails) to just past the last finish. */
export function telemetryWindow(doc: RegattaDoc, ref: RaceRef): { after: number; before: number } {
  const { race } = findRace(doc, ref);
  const st = raceStart(race);
  if (!st?.startTime) throw new Error('Race has no start time');
  const fins = finishMs(race);
  const endIso = race.endTime ? Date.parse(race.endTime) : NaN;
  const end = fins.length ? Math.max(...fins) + 30_000 : Number.isFinite(endIso) ? endIso : st.startTime + 90 * 60_000;
  return { after: st.startTime - PRE_START_FETCH_MS, before: end };
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

/** Why a finish looks wrong against its race's medians, or null when it looks like a real one. */
function implausibleFinish(f: Finish, medDist: number | null, medMax: number | null): string | null {
  const d = num(f.distanceTraveled);
  const v = num(f.maxSpeed);
  if (d != null && medDist != null && d < FINISH_MIN_DIST_FRAC * medDist) {
    return `the feed has it sailing ${(d / 1000).toFixed(1)} km against the fleet's ${(medDist / 1000).toFixed(1)} km`;
  }
  if (v != null && medMax != null && v > FINISH_MAX_SPEED_X * medMax) {
    return `the feed has a max speed of ${Math.round(v)} kt against the fleet's ${Math.round(medMax)} kt`;
  }
  return null;
}

/** Event-wide results per sail number: every non-practice race of the division that has finishes. */
export function entryResults(div: Division, race: Race): Map<string, EntryResults> {
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
      const why = implausibleFinish(f, medDist, medMax);
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
      });
    }
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

function toTrack(rows: Row[]): Track {
  const n = rows.length;
  const t = new Float64Array(n);
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const sog = new Float32Array(n);
  const heading = new Float32Array(n);
  rows.forEach((r, i) => {
    t[i] = r.ts;
    lat[i] = r.lat;
    lon[i] = r.lon;
    sog[i] = r.sog;
    heading[i] = r.heading;
  });
  return { t, lat, lon, sog, heading };
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
  const entries = entryResults(div, race);

  const boats: Boat[] = [];
  for (const p of div.participants ?? []) {
    const sail = p.sailNumber;
    let trackRows: Row[] | undefined;
    const devs = bySail.get(sail);
    if (devs?.size) trackRows = [...devs.values()].sort((a, b) => b.length - a.length)[0];
    if (!trackRows) {
      const serial = stats.get(sail)?.serialNumber || finishes.get(sail)?.serialNumber;
      if (serial) trackRows = bySn.get(snFromHex(serial));
    }
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
      track: toTrack(trackRows),
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
  if (untracked.length) data.courseUntracked = untracked;
  if (ws?.length) {
    data.windModel = { label: opts.wind?.modelLabel ?? opts.wind?.model ?? 'weather model', samples: ws };
  }
  return data;
}
