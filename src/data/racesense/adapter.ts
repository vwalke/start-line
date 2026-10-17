/**
 * RaceSense source adapter: turns the public RaceSense responses (regatta
 * document + teleapi telemetry pages + optional model wind) into the
 * normalized `RaceData`. Pure functions only; fetching lives in api.ts so
 * the same code runs against the offline fixture in tests and demo mode.
 */
import type { Boat, CourseMark, LatLon, Line, MarkTrack, RaceData, Track, WindSample } from '../types';
import type {
  Course,
  Division,
  Race,
  RegattaDoc,
  RegattaResponse,
  Start,
  TelemetryPage,
  WindResponse,
} from './types';

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

/** Telemetry time window worth fetching for a race: a short pre-start (for trails) to just past the last finish. */
export function telemetryWindow(doc: RegattaDoc, ref: RaceRef): { after: number; before: number } {
  const { race } = findRace(doc, ref);
  const st = raceStart(race);
  if (!st?.startTime) throw new Error('Race has no start time');
  const fins = finishMs(race);
  const endIso = race.endTime ? Date.parse(race.endTime) : NaN;
  const end = fins.length ? Math.max(...fins) + 30_000 : Number.isFinite(endIso) ? endIso : st.startTime + 90 * 60_000;
  return { after: st.startTime - 90_000, before: end };
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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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
    if (!devices.length) continue;
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
    const dtlMm = stats.get(sail)?.dtlMm;
    boats.push({
      id: sail,
      sail,
      name: p.boatName?.trim() || `#${sail}`,
      bowOffsetM: (p.bowOffsetCm ?? defaultBowCm) / 100,
      track: toTrack(trackRows),
      finishMs: Number.isFinite(fms) ? fms : null,
      ocs: ocs.has(sail),
      rcDtlM: dtlMm == null ? null : dtlMm / 1000,
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
      label: opts.kind === 'fixture' ? 'Bundled demo (RaceSense public feed snapshot)' : 'RaceSense public feed',
      eventId: opts.eventId,
    },
    eventName: doc.name,
    division: div.name,
    boatClass: div.boatClass ?? div.name,
    raceNumber: race.raceNumber,
    gunMs,
    tzOffsetMs: tzOffsetMs(race.timezoneOffset),
    startLine,
    finishLine,
    course: marks,
    boats,
  };
  if (ws?.length) {
    data.windModel = { label: opts.wind?.modelLabel ?? opts.wind?.model ?? 'weather model', samples: ws };
  }
  return data;
}
