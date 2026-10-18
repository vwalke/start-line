/**
 * Who is actually racing. Feeds list coach RIBs, spare trackers, judges and
 * media boats as ordinary participants (same role, start rows and all), so
 * this judges each boat by what it did, relative to the fleet in this race:
 *
 *   S1 low results    hardly any plausible finishes over the event
 *   S2 motorboat      sustained speeds no boat in the class can sail
 *   S3 stationary     barely moved after the gun
 *   S4 duplicate      a second tracker riding on another boat
 *   S5 name hint      "Coach", "Spare", "RC"… or a placeholder sail (corroborates only)
 *
 * A name alone never excludes: a boat called "Coach" that finishes and sails
 * like the fleet is a competitor. Pure functions over RaceData.
 */
import type { Boat, RaceData, Track } from '../data/types';
import { EARTH_R, MS_TO_KN, median } from './geo';

export type ParticipationStatus = 'competitor' | 'non-competitor';

export interface Participation {
  status: ParticipationStatus;
  /** Short plain-English reasons (only the signals that fired). */
  reasons: string[];
}

/** S1: needs results from at least this many races (day 1 of a live event has too few to judge). */
export const MIN_RACES_WITH_RESULTS = 2;
/** S1: at most this share of the event's races with a plausible finish (real boats with few results still race like the fleet, so S1 never acts alone). */
export const LOW_RESULTS_FRAC = 0.25;
/**
 * S2: a 30 s median speed above both of these is a motorboat. Real boats'
 * best 30 s stay within 1.2× the fleet's median p95 (all 50 M24s in a 13 kt
 * race 4, and the J70, C31 and J/88 fixtures); coaches run 1.4–2.3× (a coach
 * idling with the fleet in that race: 18 kt vs 12.8). The +4 kt floor keeps a
 * planing gust in light air (fleet p95 6 kt) from counting.
 */
export const MOTOR_X = 1.35;
export const MOTOR_PLUS_KN = 4;
/** S2: the rolling median window; long enough that a surf or a GPS spike can't trip it. */
export const SUSTAINED_MS = 30_000;
/** S3: p95 speed under this share of the fleet's median p95 (spares parked on a committee boat: < 1 kt vs 6–13). */
export const STATIONARY_FRAC = 0.35;
/** S3: or distance sailed after the gun under this share of the fleet median. */
export const SHORT_DIST_FRAC = 0.25;
/** S4: two tracks matched within this time of each other… */
export const DUP_MATCH_MS = 1000;
/** …at least this many times… */
export const DUP_MIN_MATCHES = 60;
/** …a median this close and a 90th percentile this close are one boat (two trackers on 619 were 1.2 m / 2.5 m apart; distinct boats are hundreds of metres apart over a race). */
export const DUP_MEDIAN_M = 10;
export const DUP_P90_M = 30;
/** Distance is summed over fixes this far apart, so GPS jitter on a parked tracker doesn't add up to kilometres. */
const DIST_STEP_MS = 10_000;
/** Without finishes, the race is judged up to this long after the gun. */
const DEFAULT_RACE_MS = 90 * 60_000;

/** S5: words that name a support role, matched as whole words. */
export const SUPPORT_WORDS = /\b(coach|spare|rc|committee|mark|media|press|photo|umpire|judge|jury|safety|support|signal|chip)\b/i;

/** A placeholder sail number: its digits all one repeated digit (0000, 1111, 222), or all zeros. */
export function placeholderSail(sail: string): boolean {
  const d = sail.replace(/\D/g, '');
  return /^0+$/.test(d) || (d.length >= 3 && /^(\d)\1+$/.test(d));
}

/** S5: the boat's name, sail or bow number hints at a support boat. */
export function nameHint(b: Pick<Boat, 'name' | 'sail' | 'bowNumber'>): string | null {
  if ([b.name, b.sail, b.bowNumber ?? ''].some((s) => SUPPORT_WORDS.test(s))) return 'Name suggests a support boat';
  if (placeholderSail(b.sail)) return 'Placeholder sail number';
  return null;
}

const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

const metres = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.hypot(x, y) * EARTH_R;
};

/** One fix per second within [a, b], with speed from the feed or, failing that, from the positions. */
interface Thin {
  t: number[];
  lat: number[];
  lon: number[];
  sog: number[];
}

function thin(tr: Track, a: number, b: number): Thin {
  const out: Thin = { t: [], lat: [], lon: [], sog: [] };
  let last = -Infinity;
  for (let i = 0; i < tr.t.length; i++) {
    const t = tr.t[i];
    if (t < a || t > b || t - last < 1000) continue;
    last = t;
    let v = tr.sog[i];
    if (!Number.isFinite(v)) {
      const j = Math.max(0, i - 1);
      const k = Math.min(tr.t.length - 1, i + 1);
      const dt = (tr.t[k] - tr.t[j]) / 1000;
      v = dt > 0 ? (metres(tr.lat[j], tr.lon[j], tr.lat[k], tr.lon[k]) / dt) * MS_TO_KN : 0;
    }
    out.t.push(t);
    out.lat.push(tr.lat[i]);
    out.lon.push(tr.lon[i]);
    out.sog.push(v);
  }
  return out;
}

/** Highest SUSTAINED_MS rolling median of speed. */
function maxSustained(th: Thin): number {
  let best = 0;
  let lo = 0;
  let hi = 0;
  const half = SUSTAINED_MS / 2;
  for (let i = 0; i < th.t.length; i++) {
    while (th.t[lo] < th.t[i] - half) lo++;
    while (hi < th.t.length && th.t[hi] <= th.t[i] + half) hi++;
    // Only windows with several fixes: a lone fix across a gap isn't "sustained".
    if (hi - lo < 5) continue;
    best = Math.max(best, median(th.sog.slice(lo, hi)));
  }
  return best;
}

function pathMetres(th: Thin): number {
  let d = 0;
  let k = 0;
  for (let i = 1; i < th.t.length; i++) {
    if (th.t[i] - th.t[k] < DIST_STEP_MS && i !== th.t.length - 1) continue;
    d += metres(th.lat[k], th.lon[k], th.lat[i], th.lon[i]);
    k = i;
  }
  return d;
}

/** Separation of two tracks where both have a fix within DUP_MATCH_MS; null when they match too rarely. */
function separation(a: Thin, b: Thin): { median: number; p90: number; n: number } | null {
  const ds: number[] = [];
  let j = 0;
  for (let i = 0; i < a.t.length; i++) {
    while (j < b.t.length - 1 && Math.abs(b.t[j + 1] - a.t[i]) <= Math.abs(b.t[j] - a.t[i])) j++;
    if (j >= b.t.length || Math.abs(b.t[j] - a.t[i]) > DUP_MATCH_MS) continue;
    ds.push(metres(a.lat[i], a.lon[i], b.lat[j], b.lon[j]));
  }
  if (ds.length < DUP_MIN_MATCHES) return null;
  return { median: median(ds), p90: quantile(ds, 0.9), n: ds.length };
}

const label = (b: Boat): string => (b.name && b.name !== `#${b.sail}` ? `${b.sail} ${b.name}` : b.sail);

/** A finish that counts in this race: present, and not shown implausible by the event results. */
export const hasPlausibleFinish = (b: Boat): boolean => b.finishMs != null && b.entry?.finishPlausible !== false;

/** Per boat id: competitor or not, and why. */
export function classifyParticipation(data: RaceData): Map<string, Participation> {
  const gun = data.gunMs;
  const fins = data.boats.filter(hasPlausibleFinish).map((b) => b.finishMs!);
  const end = fins.length ? Math.max(...fins) : gun + DEFAULT_RACE_MS;
  const stats = data.boats.map((b) => {
    const th = thin(b.track, gun, end);
    return { b, th, p95: th.t.length ? quantile(th.sog, 0.95) : 0, maxSus: maxSustained(th), dist: pathMetres(th) };
  });
  const out = new Map<string, Participation>();
  if (!stats.length) return out;
  const fleetP95 = median(stats.map((s) => s.p95));
  const fleetDist = median(stats.map((s) => s.dist));

  // S4: pairs of tracks that are the same boat. Cheap pre-check first: a few common
  // moments more than 200 m apart rule a pair out without the full match.
  const dupOf = new Map<string, Boat>();
  const plaus = (b: Boat): number => b.entry?.plausibleFinishes ?? 0;
  for (let i = 0; i < stats.length; i++) {
    for (let j = i + 1; j < stats.length; j++) {
      const A = stats[i];
      const B = stats[j];
      if (A.th.t.length < DUP_MIN_MATCHES || B.th.t.length < DUP_MIN_MATCHES) continue;
      const probe = (k: number): number => {
        const ia = Math.floor((k * (A.th.t.length - 1)) / 8);
        const t = A.th.t[ia];
        let jb = 0;
        let bd = Infinity;
        // Binary search the nearest fix of B.
        let lo = 0;
        let hi = B.th.t.length - 1;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (B.th.t[m] < t) lo = m + 1;
          else hi = m;
        }
        for (const c of [lo - 1, lo]) {
          if (c >= 0 && c < B.th.t.length && Math.abs(B.th.t[c] - t) < bd) {
            bd = Math.abs(B.th.t[c] - t);
            jb = c;
          }
        }
        return metres(A.th.lat[ia], A.th.lon[ia], B.th.lat[jb], B.th.lon[jb]);
      };
      const probes = Array.from({ length: 9 }, (_, k) => probe(k));
      if (median(probes) > 200) continue;
      const sep = separation(A.th, B.th);
      if (!sep || sep.median > DUP_MEDIAN_M || sep.p90 > DUP_P90_M) continue;
      const aDup = plaus(A.b) < plaus(B.b) || (plaus(A.b) === plaus(B.b) && A.b.track.t.length < B.b.track.t.length);
      const [dup, host] = aDup ? [A.b, B.b] : [B.b, A.b];
      if (!dupOf.has(dup.id)) dupOf.set(dup.id, host);
    }
  }

  for (const s of stats) {
    const b = s.b;
    const host = dupOf.get(b.id);
    // A boat both trackers agree is the "host" is never also the duplicate of a third.
    if (host && !dupOf.has(host.id)) {
      out.set(b.id, { status: 'non-competitor', reasons: [`Second tracker on ${label(host)}`] });
      continue;
    }
    const e = b.entry;
    const s1Known = !!e && e.racesWithResults >= MIN_RACES_WITH_RESULTS;
    const s1 = s1Known && e!.plausibleFinishes <= LOW_RESULTS_FRAC * e!.racesWithResults;
    const s2 = s.maxSus > MOTOR_X * fleetP95 && s.maxSus > fleetP95 + MOTOR_PLUS_KN;
    const still = s.p95 < STATIONARY_FRAC * fleetP95;
    const short = s.dist < SHORT_DIST_FRAC * fleetDist;
    const s3 = still || short;
    const hint = nameHint(b);
    const finished = hasPlausibleFinish(b);
    const exclude = !finished && (s1Known ? s1 && (s2 || s3 || !!hint) : (s2 || s3) && !!hint);
    if (!exclude) {
      out.set(b.id, { status: 'competitor', reasons: [] });
      continue;
    }
    const reasons: string[] = [];
    if (s1) {
      const p = e!.plausibleFinishes;
      reasons.push(p === 0 ? `No finish in ${e!.racesWithResults} races` : `Only ${p} real finish${p > 1 ? 'es' : ''} in ${e!.racesWithResults} races`);
    }
    if (s2) reasons.push(`Motorboat speeds (max ${Math.round(s.maxSus)} kt)`);
    if (still) reasons.push('Stationary most of the race');
    else if (short) reasons.push(`Covered ${(s.dist / 1000).toFixed(1)} km vs the fleet's ${(fleetDist / 1000).toFixed(1)} km`);
    if (hint) reasons.push(hint);
    out.set(b.id, { status: 'non-competitor', reasons });
  }
  return out;
}
