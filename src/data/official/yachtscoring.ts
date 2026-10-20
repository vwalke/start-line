/**
 * Yachtscoring's public API (api.yachtscoring.com/v1/public, through our /api/ys proxy): the raw
 * shapes Recall reads and their parsing into official classes, races and results.
 *
 * Times are local wall clock written with a `Z` (11:05 EDT is "…T11:05:00.000Z") and
 * `localGMTOffset` can be wrong (-5.0 in Annapolis in October), so parsing keeps them as
 * "wall" ms (local clock read as if it were UTC); match.ts infers the offset from RaceSense guns.
 * Owner and crew fields are stripped by the proxy and never read here.
 */
import { DAY, HOUR, MINUTE, cachedJson } from '../cache';

export const YS_BASE = '/api/ys';
export const YS_EVENT_URL = 'https://www.yachtscoring.com/emenu/';

export interface YsEventRow {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface YsEvent extends YsEventRow {
  hostClub?: { name?: string | null } | null;
}

export interface YsSplit {
  id: number;
  splitCircle?: string | null;
  splitDivision?: string | null;
  splitClassName?: string | null;
}

export interface YsRaceRow {
  id?: number;
  raceNumber: number;
  startTime: string | null;
  localGMTOffset?: string | null;
  splitId?: number | null;
  split?: YsSplit | null;
}

export interface YsResultBoat {
  sailPrefix?: string | null;
  sailNumber?: string | null;
  name?: string | null;
  finishStatus?: string | null;
  finishTime?: string | null;
  elapsedTime?: number | null;
  placeClass?: number | null;
}

export interface YsResultReport {
  data?: {
    circleName?: string | null;
    divisions?: { divisionName?: string | null; classes?: { className?: string | null; boats?: YsResultBoat[] | null }[] | null }[] | null;
  }[];
}

export interface YsPage<T> {
  count?: number;
  rows?: T[];
}

/** A scored class: one circle's class (raceNumber restarts per circle + class). */
export interface OfficialClass {
  /** `circle|class`, as `ysc=` takes it. */
  key: string;
  splitId: number | null;
  circle: string;
  className: string;
  races: OfficialRaceDef[];
}

export interface OfficialRaceDef {
  number: number;
  /** The start, local wall clock read as UTC (see the file comment). */
  wallMs: number;
  /** Yachtscoring's `localGMTOffset`, hours (not trusted: a last-resort fallback). */
  gmtOffsetH: number | null;
}

/** finishStatus "AOK" is a finish; anything else is the scoring code (DNF, DNS, DNC, OCS, DSQ, RET, …). */
export interface OfficialResult {
  prefix: string | null;
  sail: string;
  name: string;
  /** null for a finisher; the code otherwise. */
  code: string | null;
  /** Place in class for a finisher; null with a code (Yachtscoring ranks those fleet size + 1). */
  place: number | null;
  finishWallMs: number | null;
  elapsedS: number | null;
}

const wall = (s: string | null | undefined): number => (s ? Date.parse(s.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) : NaN);
const txt = (s: string | null | undefined): string => (s ?? '').trim();

export const classKey = (circle: string, className: string): string => `${circle}|${className}`;

/** The event's classes and their races, from `event/:id/races` rows. */
export function parseClasses(rows: readonly YsRaceRow[]): OfficialClass[] {
  const out = new Map<string, OfficialClass>();
  for (const r of rows) {
    const circle = txt(r.split?.splitCircle);
    const className = txt(r.split?.splitClassName);
    const ms = wall(r.startTime);
    if (!className || !Number.isFinite(ms) || !Number.isInteger(r.raceNumber)) continue;
    const key = classKey(circle, className);
    let c = out.get(key);
    if (!c) out.set(key, (c = { key, splitId: r.split?.id ?? r.splitId ?? null, circle, className, races: [] }));
    const off = Number(r.localGMTOffset);
    if (!c.races.some((x) => x.number === r.raceNumber)) c.races.push({ number: r.raceNumber, wallMs: ms, gmtOffsetH: r.localGMTOffset != null && Number.isFinite(off) ? off : null });
  }
  for (const c of out.values()) c.races.sort((a, b) => a.wallMs - b.wallMs);
  return [...out.values()];
}

/** One class's results from a `result-detail-report?raceNumber=N` (which lists every circle and class with a race N). */
export function parseResults(report: YsResultReport | null | undefined, cls: Pick<OfficialClass, 'circle' | 'className'>): OfficialResult[] | null {
  for (const c of report?.data ?? []) {
    if (txt(c.circleName) !== cls.circle) continue;
    for (const d of c.divisions ?? []) {
      for (const k of d.classes ?? []) {
        if (txt(k.className) !== cls.className) continue;
        return (k.boats ?? []).map((b) => {
          const status = txt(b.finishStatus).toUpperCase() || 'AOK';
          const fin = wall(b.finishTime);
          const ok = status === 'AOK';
          return {
            prefix: b.sailPrefix ?? null,
            sail: txt(b.sailNumber),
            name: txt(b.name),
            code: ok ? null : status,
            place: ok && b.placeClass != null && b.placeClass > 0 ? b.placeClass : null,
            finishWallMs: Number.isFinite(fin) ? fin : null,
            elapsedS: b.elapsedTime != null && Number.isFinite(b.elapsedTime) ? b.elapsedTime : null,
          };
        });
      }
    }
  }
  return null;
}

/** Every boat a report lists for each class (circle|class → boats), for the sail-overlap score. */
export function reportClasses(report: YsResultReport | null | undefined): Map<string, YsResultBoat[]> {
  const out = new Map<string, YsResultBoat[]>();
  for (const c of report?.data ?? []) {
    for (const d of c.divisions ?? []) {
      for (const k of d.classes ?? []) out.set(classKey(txt(c.circleName), txt(k.className)), k.boats ?? []);
    }
  }
  return out;
}

/** A Yachtscoring event id from a pasted link (yachtscoring.com/emenu/50575, …/event/50575/…) or a bare number; null otherwise. */
export function parseYsEventId(input: string): number | null {
  const s = input.trim();
  const m = /^(\d{1,7})$/.exec(s) ?? /yachtscoring\.com\/(?:emenu|event|events|results)\/(\d{1,7})(?:\D|$)/i.exec(s) ?? /[?&](?:eventid|event)=(\d{1,7})(?:\D|$)/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/** What the linker asks Yachtscoring for; tests pass a fixture-backed one. */
export interface YsSource {
  searchDates(gte: string, lte: string): Promise<YsEventRow[]>;
  searchName(q: string): Promise<YsEventRow[]>;
  event(id: number): Promise<YsEvent>;
  races(id: number): Promise<YsRaceRow[]>;
  results(id: number, raceNumber: number): Promise<YsResultReport>;
}

/** Latest date-like value in a body (as the proxy's TTL rule), ms. */
function latest(x: unknown, depth = 0): number {
  if (depth > 8 || x === null || typeof x !== 'object') return NaN;
  let best = NaN;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    let t = NaN;
    if (typeof v === 'string' && /^(startDate|endDate|startTime|finishTime|updatedAt|raceUpdatedAt|resultUpdatedAt)$/.test(k)) t = Date.parse(v);
    else if (v && typeof v === 'object') t = latest(v, depth + 1);
    if (Number.isFinite(t) && !(t <= best)) best = t;
  }
  return best;
}

/** Long once an event has been quiet for 2 days (as the proxy), short while it is current. */
const quietTtl = (body: unknown, fetchedAt: number): number => {
  const t = latest(body);
  return Number.isFinite(t) && fetchedAt - t > 2 * DAY ? 7 * DAY : 5 * MINUTE;
};

/** The live source, through /api/ys (cached like the regatta document). */
export function httpYsSource(signal?: AbortSignal): YsSource {
  const get = <T>(path: string, ttl: number | typeof quietTtl): Promise<T> => cachedJson<T>(`${YS_BASE}/${path}`, ttl, signal);
  return {
    searchDates: async (gte, lte) =>
      (await get<YsPage<YsEventRow>>(`event?startDate_gte=${gte}&startDate_lte=${lte}&sort=startDate.desc&size=100`, HOUR)).rows ?? [],
    searchName: async (q) => (await get<YsPage<YsEventRow>>(`event?name_contains=${encodeURIComponent(q)}&sort=startDate.desc&size=40`, HOUR)).rows ?? [],
    event: (id) => get<YsEvent>(`event/${id}`, quietTtl),
    races: async (id) => (await get<YsPage<YsRaceRow>>(`event/${id}/races?size=200`, quietTtl)).rows ?? [],
    results: (id, n) => get<YsResultReport>(`event/${id}/result-detail-report?raceNumber=${n}`, quietTtl),
  };
}
