/**
 * Which races a boat log covers, and which fleet boat it is.
 *
 * Races: a log covers a race when its fixes cover at least COVER_MIN of the
 * race's gun → end window (one file often covers a whole day: several races).
 *
 * Boat: the log is compared with every boat's public feed track in a few
 * short windows (`checkWindows`, the same windows the server re-checks): at
 * each feed fix the log is interpolated (only between fixes ≤ BRACKET_MS
 * apart) and the distance taken. The feed is a subset of the device's own
 * fixes, so the right boat agrees to a metre or two (median 0.0 m for USA
 * 833) and every other boat is tens of metres or more away. Accepted when
 * the best boat's median is under MATCH_MEDIAN_M on at least MATCH_MIN_POINTS
 * fixes with a clear margin to the next best; with fewer fixes (a sparse
 * tracker) it needs SPARSE_MIN_POINTS agreeing fixes and the user's
 * confirmation; otherwise it is rejected. Shared by the browser and the
 * Pages Function (pure; no fetching here).
 */
import { coverage } from '../../analysis/coverage';
import { raceFinishes } from '../racesense/adapter';
import type { RegattaDoc, TelemetryPage } from '../racesense/types';

export const COVER_MIN = 0.5;
/** A race's payload: from this long before the gun… */
export const PRE_GUN_MS = 5 * 60_000;
/** …to this long after its end. */
export const POST_END_MS = 2 * 60_000;
/** With no finishes, a race is taken to end this long after its gun at most… */
export const MAX_RACE_MS = 2 * 3_600_000;
/** …and this long before the next race's gun. */
export const NEXT_GUN_GAP_MS = 5 * 60_000;

export const MATCH_MEDIAN_M = 5;
export const MATCH_MIN_POINTS = 30;
export const SPARSE_MIN_POINTS = 5;
/** The runner-up must be at least this far off (median), m, and MARGIN_X × the best. */
export const MARGIN_M = 25;
export const MARGIN_X = 5;
/** Interpolate the log only between fixes this close, ms. */
export const BRACKET_MS = 2_000;
/** Feed windows checked: this many, each this long, spread evenly over the payload. */
// 8 × 50 s: enough for a sparse tracker (USA 833, bottom 5% of the fleet by feed fixes, gets 24 in 6 × 40 s of R7).
export const CHECK_WINDOWS = 8;
export const CHECK_WINDOW_MS = 50_000;

export interface RaceWindow {
  /** Race id as the app and the storage keys use it ("7"; recovered races may differ). */
  id: string;
  label: string;
  gunMs: number;
  endMs: number;
  /** The end is a finish time (else an estimate). */
  endKnown: boolean;
}

/** Every race of the division with a gun (finishers or not: a race the app hides today still gets its upload), oldest first. */
export function raceWindowsFromDoc(doc: RegattaDoc, division: string, extra: RaceWindow[] = []): RaceWindow[] {
  const div = doc.divisions?.find((d) => d.name === division);
  const out: RaceWindow[] = [];
  for (const race of div?.races ?? []) {
    if (race.isPractice) continue;
    const st = [...(race.starts ?? [])].reverse().find((s) => s.startTime != null);
    if (!st?.startTime) continue;
    const fins = raceFinishes(race, div?.races ?? []).map((f) => Date.parse(f.finishingTime)).filter(Number.isFinite);
    const endIso = race.endTime ? Date.parse(race.endTime) : NaN;
    const known = fins.length > 0;
    const end = known ? Math.max(...fins) : Math.min(Number.isFinite(endIso) && endIso > st.startTime ? endIso : Infinity, st.startTime + MAX_RACE_MS);
    out.push({ id: String(race.raceNumber), label: `R${race.raceNumber}`, gunMs: st.startTime, endMs: end, endKnown: known });
  }
  const all = [...out, ...extra.filter((e) => !out.some((o) => o.id === e.id))].sort((a, b) => a.gunMs - b.gunMs);
  // An estimated end stops short of the next gun.
  return trimEnds(all);
}

/** The fields raceWindowsFromListed reads (ListedRace is structurally this). */
export interface ListedRaceWindow {
  division: string;
  raceNumber: number;
  gunMs: number;
  lastFinishMs: number | null;
  finished: boolean;
  practice?: boolean;
  number?: number | null;
  officialNumber?: number | null;
  rsNumber?: number | null;
}

/** Shown number for a listed race: official or ordinal when the list has one, else the RaceSense / rebuilt key. */
const listedLabel = (r: ListedRaceWindow): string => {
  const n = r.number ?? r.officialNumber ?? r.rsNumber ?? r.raceNumber;
  return `R${n}`;
};

/**
 * Race windows from Recall's race list, including races rebuilt by recovery
 * (orphans keyed YYYYMMDDHHMM). Practice is skipped. Same end-cap rule as
 * raceWindowsFromDoc.
 */
export function raceWindowsFromListed(races: readonly ListedRaceWindow[], division: string): RaceWindow[] {
  const mine = races.filter((r) => r.division === division && !r.practice).sort((a, b) => a.gunMs - b.gunMs);
  const out: RaceWindow[] = mine.map((r) => {
    const known = r.finished && r.lastFinishMs != null;
    return {
      id: String(r.raceNumber),
      label: listedLabel(r),
      gunMs: r.gunMs,
      endMs: known ? r.lastFinishMs! : r.gunMs + MAX_RACE_MS,
      endKnown: known,
    };
  });
  return trimEnds(out);
}

function trimEnds(all: RaceWindow[]): RaceWindow[] {
  return all.map((w, i) => {
    const next = all[i + 1];
    return !w.endKnown && next && w.endMs > next.gunMs - NEXT_GUN_GAP_MS ? { ...w, endMs: Math.max(w.gunMs + 60_000, next.gunMs - NEXT_GUN_GAP_MS) } : w;
  });
}

/** Fraction of [a, b] the log's fixes cover (5 s gaps, as the app's coverage). */
export const coverageOf = (t: Float64Array, a: number, b: number): number => coverage(t, a, b).coverage;

export interface CoveredRace {
  race: RaceWindow;
  /** Share of gun → end the log covers. */
  frac: number;
  /** The payload window: gun − PRE_GUN_MS … end + POST_END_MS, cut to the log. */
  fromMs: number;
  toMs: number;
}

/** Races the log covers by at least COVER_MIN, oldest first. */
export function coveredRaces(t: Float64Array, races: RaceWindow[], min = COVER_MIN): CoveredRace[] {
  if (!t.length) return [];
  const out: CoveredRace[] = [];
  for (const race of races) {
    if (race.endMs <= race.gunMs) continue;
    const frac = coverageOf(t, race.gunMs, race.endMs);
    if (frac < min) continue;
    out.push({ race, frac, fromMs: Math.max(t[0], race.gunMs - PRE_GUN_MS), toMs: Math.min(t[t.length - 1], race.endMs + POST_END_MS) });
  }
  return out;
}

/** The feed windows both sides check, spread evenly over [from, to]. */
export function checkWindows(fromMs: number, toMs: number, count = CHECK_WINDOWS, lenMs = CHECK_WINDOW_MS): { after: number; before: number }[] {
  const span = toMs - fromMs;
  if (!(span > 0)) return [];
  if (span <= count * lenMs) return [{ after: Math.floor(fromMs), before: Math.ceil(toMs) }];
  return Array.from({ length: count }, (_, k) => {
    const mid = fromMs + ((k + 0.5) * span) / count;
    return { after: Math.floor(mid - lenMs / 2), before: Math.floor(mid + lenMs / 2) };
  });
}

/** One feed fix. */
export interface FeedFix {
  ts: number;
  sn: number;
  sail: string;
  lat: number;
  lon: number;
}

/** Competitor fixes from teleapi pages (columns by name; marks and committee boats left out). */
export function feedFixes(pages: TelemetryPage[]): FeedFix[] {
  const out: FeedFix[] = [];
  for (const p of pages) {
    if (!p?.Fields || !p.Rows) continue;
    const f = (n: string): number => p.Fields!.indexOf(n);
    const [ts, sn, sail, role, lat, lon] = [f('ts'), f('sn'), f('sail_number'), f('role'), f('latitude'), f('longitude')];
    if (ts < 0 || sn < 0 || lat < 0 || lon < 0) continue;
    for (const r of p.Rows) {
      if (role >= 0 && r[role] !== 'competitor') continue;
      const la = Number(r[lat]);
      const lo = Number(r[lon]);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) continue;
      out.push({ ts: Number(r[ts]), sn: Number(r[sn]), sail: sail >= 0 ? String(r[sail] ?? '') : '', lat: la, lon: lo });
    }
  }
  return out;
}

export interface LogTrack {
  t: ArrayLike<number>;
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
}

const metres = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * 6_371_000;
};

/** The log's position at `ts`, or null outside it or across a gap over BRACKET_MS. */
export function logAt(tr: LogTrack, ts: number): { lat: number; lon: number } | null {
  const t = tr.t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] < ts) lo = m + 1;
    else hi = m;
  }
  if (lo < t.length && t[lo] === ts) return { lat: tr.lat[lo], lon: tr.lon[lo] };
  if (lo === 0 || lo >= t.length) return null;
  const a = lo - 1;
  if (t[lo] - t[a] > BRACKET_MS) return null;
  const f = (ts - t[a]) / (t[lo] - t[a]);
  return { lat: tr.lat[a] + f * (tr.lat[lo] - tr.lat[a]), lon: tr.lon[a] + f * (tr.lon[lo] - tr.lon[a]) };
}

export interface BoatAgreement {
  sn: number;
  sail: string;
  /** Feed fixes compared (the log has a position at their time). */
  n: number;
  medianM: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Per device: how far its feed fixes are from the log at the same moments. Sorted best first. */
export function agreement(tr: LogTrack, fixes: FeedFix[]): BoatAgreement[] {
  const by = new Map<number, { sail: string; d: number[]; seen: Set<number> }>();
  for (const f of fixes) {
    const p = logAt(tr, f.ts);
    if (!p) continue;
    let e = by.get(f.sn);
    if (!e) by.set(f.sn, (e = { sail: f.sail, d: [], seen: new Set() }));
    if (e.seen.has(f.ts)) continue; // overlapping windows / pages
    e.seen.add(f.ts);
    if (!e.sail && f.sail) e.sail = f.sail;
    e.d.push(metres(p.lat, p.lon, f.lat, f.lon));
  }
  return [...by]
    .map(([sn, e]) => ({ sn, sail: e.sail, n: e.d.length, medianM: median(e.d) }))
    .sort((a, b) => a.medianM - b.medianM || b.n - a.n);
}

export type MatchVerdict =
  | { kind: 'match'; boat: BoatAgreement; runnerUp: BoatAgreement | null }
  /** Agrees, but on too few fixes to be sure: the user confirms the boat (`candidates` all agree). */
  | { kind: 'sparse'; boat: BoatAgreement; candidates: BoatAgreement[] }
  | { kind: 'none'; reason: string; best: BoatAgreement | null };

/** Decide which boat the log is (see the module notes). */
export function decideBoat(stats: BoatAgreement[]): MatchVerdict {
  const agreeing = stats.filter((s) => s.medianM < MATCH_MEDIAN_M && s.n >= SPARSE_MIN_POINTS);
  const best = agreeing.sort((a, b) => b.n - a.n || a.medianM - b.medianM)[0];
  if (!best) {
    const near = stats.find((s) => s.n >= SPARSE_MIN_POINTS) ?? stats[0] ?? null;
    return {
      kind: 'none',
      best: near,
      reason: near
        ? `No boat's public track follows this log (closest: ${near.sail || near.sn}, median ${Math.round(near.medianM)} m off)`
        : 'The public feed has no boat fixes at the times this log covers',
    };
  }
  const others = stats.filter((s) => s.sn !== best.sn && s.n >= SPARSE_MIN_POINTS);
  const runnerUp = others.sort((a, b) => a.medianM - b.medianM)[0] ?? null;
  const clear = !runnerUp || runnerUp.medianM >= Math.max(MARGIN_M, MARGIN_X * best.medianM);
  if (best.n >= MATCH_MIN_POINTS && clear) return { kind: 'match', boat: best, runnerUp };
  // Too few fixes, or another boat nearly as close (rafted up, a second tracker): the user confirms from the agreeing boats.
  return { kind: 'sparse', boat: best, candidates: agreeing };
}

/** Same sail, ignoring spaces and case ("USA 833" = "usa833"). */
export const sameSail = (a: string, b: string): boolean => a.replace(/\s+/g, '').toUpperCase() === b.replace(/\s+/g, '').toUpperCase();

export type FeedCheck =
  | { ok: true; n: number; medianM: number }
  | { ok: false; reason: 'mismatch' | 'too-few'; n: number; medianM: number | null };

/** Does device `sn`'s feed agree with the log? (the server's check; also run by the client before uploading). */
export function checkDevice(tr: LogTrack, fixes: FeedFix[], sn: number): FeedCheck {
  const a = agreement(
    tr,
    fixes.filter((f) => f.sn === sn),
  )[0];
  if (!a || a.n < SPARSE_MIN_POINTS) return { ok: false, reason: 'too-few', n: a?.n ?? 0, medianM: a ? a.medianM : null };
  if (a.medianM >= MATCH_MEDIAN_M) return { ok: false, reason: 'mismatch', n: a.n, medianM: a.medianM };
  return { ok: true, n: a.n, medianM: a.medianM };
}
