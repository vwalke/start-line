/**
 * Linking a RaceSense event to a Yachtscoring event and, per RaceSense division, to one
 * Yachtscoring class (circle + class). Pure scoring here; link.ts does the fetching.
 *
 * Event candidates come from a start-date window search and are scored on name tokens (with
 * acronyms: "CBC" = "Chesapeake Bay Championship"), date overlap and venue. The best few are
 * then checked on what can't be faked: gun times (after the timezone fix) and sail numbers.
 */
import { matchBoats, type BoatKey, type MatchTier } from './sail';
import type { OfficialClass, OfficialRaceDef } from './yachtscoring';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
/** A Yachtscoring start (whole minutes) within this of a RaceSense gun (hh:mm:01) is the same race. */
export const GUN_TOL_MS = 2 * MINUTE_MS;
/** Left-over races between two gun-matched ones pair in order only if this close (a postponement Yachtscoring kept at the scheduled time). */
export const ORDER_TOL_MS = 45 * MINUTE_MS;

// ---- names

const STOP = new Set(['the', 'of', 'and', 'a', 'at', 'for', 'in', 'on', 'annual', 'regatta', 'presented', 'by']);

/** Folded name words; "J/105" and "J 105" become "j105". */
export function nameTokens(name: string): string[] {
  const s = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\b([a-z])\s*[/\-.]?\s*(\d{2,3})\b/g, '$1$2')
    .replace(/[^a-z0-9]+/g, ' ');
  return s.split(' ').filter((w) => w && !STOP.has(w));
}

const initialsMatch = (tok: string, words: string[]): boolean => {
  if (!/^[a-z]{2,5}$/.test(tok)) return false;
  for (let i = 0; i + tok.length <= words.length; i++) {
    if (words.slice(i, i + tok.length).every((w, k) => w[0] === tok[k])) return true;
  }
  return false;
};

/** Share of the RaceSense name's words found in the Yachtscoring name (as a word or an acronym), 0–1. */
export function nameScore(rsName: string, ysName: string): number {
  const rs = [...new Set(nameTokens(rsName))];
  const ysWords = nameTokens(ysName);
  const ys = new Set(ysWords);
  if (!rs.length) return 0;
  const hit = rs.filter((t) => ys.has(t) || initialsMatch(t, ysWords) || (t.length >= 5 && ysWords.some((w) => w.length >= 5 && (w.startsWith(t) || t.startsWith(w)))));
  return hit.length / rs.length;
}

// ---- dates

const dayStart = (ms: number): number => Math.floor(ms / 86_400_000) * 86_400_000;

/** Share of the RaceSense event's days inside the Yachtscoring event's dates (calendar days), 0–1. */
export function dateOverlap(rsStart: number, rsEnd: number, ysStart: number, ysEnd: number): number {
  const a0 = dayStart(rsStart);
  const a1 = dayStart(Math.max(rsStart, rsEnd)) + 86_400_000;
  const b0 = dayStart(ysStart);
  const b1 = dayStart(Math.max(ysStart, ysEnd)) + 86_400_000;
  const ov = Math.min(a1, b1) - Math.max(a0, b0);
  return ov > 0 ? Math.min(1, ov / (a1 - a0)) : 0;
}

export interface EventMeta {
  name: string;
  startMs: number;
  endMs: number;
  venue?: string;
}

export interface CandidateRow {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  city?: string | null;
}

/** Name 0.6, dates 0.3, venue (the landing's venue names the Yachtscoring city) 0.1. */
export function metaScore(rs: EventMeta, c: CandidateRow): number {
  const ov = dateOverlap(rs.startMs, rs.endMs, Date.parse(c.startDate), Date.parse(c.endDate));
  if (!ov) return 0;
  const city = (c.city ?? '').trim().toLowerCase();
  const venue = city.length >= 3 && (rs.venue ?? '').toLowerCase().includes(city) ? 1 : 0;
  return 0.6 * nameScore(rs.name, c.name) + 0.3 * ov + 0.1 * venue;
}

// ---- time zone

/**
 * Yachtscoring writes local wall clock with a `Z`. The offset (local − UTC) is the whole or
 * half hour that lines the most Yachtscoring starts up with RaceSense guns (within GUN_TOL_MS);
 * ties go to the RaceSense race's own offset (`prior`), then Yachtscoring's `localGMTOffset`.
 */
export function inferOffset(wallMs: readonly number[], gunsMs: readonly number[], prior: number | null, fallback: number | null): { offsetMs: number; matched: number } {
  let best = { offsetMs: prior ?? fallback ?? 0, matched: 0 };
  const near = (o: number): number => Math.abs(o - (prior ?? fallback ?? 0));
  for (let h = -24; h <= 28; h++) {
    const o = h * 30 * MINUTE_MS;
    let matched = 0;
    for (const w of wallMs) if (gunsMs.some((g) => Math.abs(w - o - g) <= GUN_TOL_MS)) matched++;
    if (matched > best.matched || (matched === best.matched && matched > 0 && near(o) < near(best.offsetMs))) best = { offsetMs: o, matched };
  }
  return best;
}

// ---- races

export interface RaceAlign {
  rsRace: number;
  official: number;
  /** Yachtscoring start (UTC, after the offset) minus the RaceSense gun, ms. */
  deltaMs: number;
  by: 'gun' | 'order';
}

/** Pair RaceSense races with official ones by gun time (closest first, within GUN_TOL_MS), then left-overs in order between paired ones. */
export function alignRaces(rs: readonly { raceNumber: number; gunMs: number }[], off: readonly { number: number; gunMs: number }[]): RaceAlign[] {
  const cand: { i: number; j: number; d: number }[] = [];
  rs.forEach((r, i) => off.forEach((o, j) => {
    const d = Math.abs(o.gunMs - r.gunMs);
    if (d <= GUN_TOL_MS) cand.push({ i, j, d });
  }));
  cand.sort((a, b) => a.d - b.d);
  const usedR = new Set<number>();
  const usedO = new Set<number>();
  const out: RaceAlign[] = [];
  for (const c of cand) {
    if (usedR.has(c.i) || usedO.has(c.j)) continue;
    usedR.add(c.i);
    usedO.add(c.j);
    out.push({ rsRace: rs[c.i].raceNumber, official: off[c.j].number, deltaMs: off[c.j].gunMs - rs[c.i].gunMs, by: 'gun' });
  }
  // Order: between consecutive gun-paired races (by time), equal numbers of left-overs pair up in order.
  const rsIdx = rs.map((_, i) => i).sort((a, b) => rs[a].gunMs - rs[b].gunMs);
  const offIdx = off.map((_, j) => j).sort((a, b) => off[a].gunMs - off[b].gunMs);
  const anchors = [-Infinity, ...out.filter((a) => a.by === 'gun').map((a) => rs.find((r) => r.raceNumber === a.rsRace)!.gunMs).sort((a, b) => a - b), Infinity];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const lo = anchors[k];
    const hi = anchors[k + 1];
    const rl = rsIdx.filter((i) => !usedR.has(i) && rs[i].gunMs > lo && rs[i].gunMs < hi);
    const ol = offIdx.filter((j) => !usedO.has(j) && off[j].gunMs > lo - GUN_TOL_MS && off[j].gunMs < hi + GUN_TOL_MS);
    if (!rl.length || rl.length !== ol.length) continue;
    if (rl.some((i, n) => Math.abs(off[ol[n]].gunMs - rs[i].gunMs) > ORDER_TOL_MS)) continue;
    rl.forEach((i, n) => {
      usedR.add(i);
      usedO.add(ol[n]);
      out.push({ rsRace: rs[i].raceNumber, official: off[ol[n]].number, deltaMs: off[ol[n]].gunMs - rs[i].gunMs, by: 'order' });
    });
  }
  return out.sort((a, b) => a.official - b.official);
}

// ---- classes

export interface DivisionInput {
  name: string;
  boatClass?: string;
  boats: BoatKey[];
  /** Races that count (not hidden as bogus), with their guns. */
  races: { raceNumber: number; gunMs: number }[];
}

export interface ClassScore {
  cls: OfficialClass;
  /** Share of the division's races with an official start at the same time. */
  guns: number;
  /** Share of boats paired by sail (min of the two fleet sizes); null before the class's entries are known. */
  sails: number | null;
  /** The class name matches the division's class or name ("J/105" = "J105"). */
  name: boolean;
  total: number;
}

export const officialGuns = (cls: OfficialClass, offsetMs: number): { number: number; gunMs: number }[] =>
  cls.races.map((r: OfficialRaceDef) => ({ number: r.number, gunMs: r.wallMs - offsetMs }));

const squash = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Sail overlap: boats paired by sail (any sail tier, not by name) over the smaller fleet. */
export function sailOverlap(rs: readonly BoatKey[], ys: readonly BoatKey[]): number {
  if (!rs.length || !ys.length) return 0;
  const m = matchBoats(rs, ys, (x) => x, (x) => x);
  const bySail = m.pairs.filter((p) => p.tier !== 'name').length;
  return bySail / Math.min(rs.length, ys.length);
}

/** Guns 0.45, sails 0.45, class name 0.1 (guns alone count 0.9 while the entries are unknown). */
export function scoreClass(div: DivisionInput, cls: OfficialClass, offsetMs: number, ysBoats: readonly BoatKey[] | null): ClassScore {
  const al = alignRaces(div.races, officialGuns(cls, offsetMs)).filter((a) => a.by === 'gun');
  const guns = div.races.length ? Math.min(1, al.length / div.races.length) : 0;
  const sails = ysBoats ? sailOverlap(div.boats, ysBoats) : null;
  const name = !!squash(cls.className) && [div.boatClass, div.name].some((n) => squash(n) === squash(cls.className));
  const total = sails == null ? 0.9 * guns + 0.1 * (name ? 1 : 0) : 0.45 * guns + 0.45 * sails + 0.1 * (name ? 1 : 0);
  return { cls, guns, sails, name, total };
}

/** A class is linked only when it scores at least this… */
export const CLASS_MIN = 0.6;
/** …its sails overlap at least this… */
export const SAIL_MIN = 0.6;
/** …and it beats the division's next-best class by this much. */
export const CLASS_MARGIN = 0.15;
/** An auto-matched event must also beat the next candidate event by this much. */
export const EVENT_MARGIN = 0.15;

/** The division's class, or null when none is confidently better (manual links skip the margin and floors, keeping a minimum). */
export function pickClass(scores: readonly ClassScore[], manual = false): ClassScore | null {
  const s = [...scores].sort((a, b) => b.total - a.total);
  const best = s[0];
  if (!best) return null;
  if (manual) return best.total >= 0.3 ? best : null;
  if (best.total < CLASS_MIN || (best.sails != null && best.sails < SAIL_MIN)) return null;
  if (s[1] && best.total - s[1].total < CLASS_MARGIN) return null;
  return best;
}

export type { MatchTier };
