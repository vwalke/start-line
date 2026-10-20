/**
 * From a parsed log to upload-ready payloads: which races it covers, which
 * boat it is (per race), and each race's compact payload. Pure apart from
 * the injected feed fetcher, so the browser worker and the tests share it.
 */
import type { TelemetryPage } from '../racesense/types';
import { encodePayload, type PayloadHeader } from './compact';
import {
  CHECK_WINDOWS,
  agreement,
  checkWindows,
  coverageOf,
  coveredRaces,
  decideBoat,
  feedFixes,
  type BoatAgreement,
  type CoveredRace,
  type FeedFix,
  type MatchVerdict,
  type RaceWindow,
} from './match';
import { logSummary, type VkxLog } from './parse';

/** Timer events and line pings kept from this long before the gun (the line is usually pinged 5–20 min out). */
export const EVENTS_PRE_GUN_MS = 60 * 60_000;

/** Fetch the division's feed for [after, before] (the app's /api proxy; a mock in tests). */
export type FeedFetcher = (after: number, before: number) => Promise<TelemetryPage[]>;

/** The log's sample index range [i0, i1) inside a race's payload window. */
export function sliceOf(log: VkxLog, c: CoveredRace): [number, number] {
  const t = log.pos.t;
  let i0 = 0;
  while (i0 < t.length && t[i0] < c.fromMs) i0++;
  let i1 = i0;
  while (i1 < t.length && t[i1] <= c.toMs) i1++;
  return [i0, i1];
}

export interface RaceMatch {
  covered: CoveredRace;
  verdict: MatchVerdict;
  /** Every device compared, best first. */
  stats: BoatAgreement[];
  /** The matched boat's feed fixes in the checked windows (the coverage estimate's input). */
  fixes: FeedFix[];
  windowsChecked: number;
}

/** Compare the log with the fleet's feed in the race's check windows (stopping early on a clear match). */
export async function matchRace(log: VkxLog, c: CoveredRace, fetchFeed: FeedFetcher): Promise<RaceMatch> {
  const [i0, i1] = sliceOf(log, c);
  const p = log.pos;
  const tr = { t: p.t.subarray(i0, i1), lat: p.lat.subarray(i0, i1), lon: p.lon.subarray(i0, i1) };
  const all: FeedFix[] = [];
  let verdict: MatchVerdict = { kind: 'none', reason: 'The public feed has no boat fixes at the times this log covers', best: null };
  let stats: BoatAgreement[] = [];
  let k = 0;
  if (i1 - i0 > 1) {
    for (const w of checkWindows(tr.t[0], tr.t[tr.t.length - 1]).slice(0, CHECK_WINDOWS)) {
      all.push(...feedFixes(await fetchFeed(w.after, w.before)));
      k++;
      stats = agreement(tr, all);
      verdict = decideBoat(stats);
      if (verdict.kind === 'match') break;
    }
  }
  const sn = verdict.kind === 'none' ? null : verdict.boat.sn;
  return { covered: c, verdict, stats, fixes: sn == null ? [] : all.filter((f) => f.sn === sn), windowsChecked: k };
}

/** Coverage of the race (gun → end) before and after: the feed's (exact when `knownBefore` is given, else estimated from the checked windows) and with the log. */
export function coverageGain(log: VkxLog, m: RaceMatch, knownBefore?: number | null): { before: number | null; beforeExact: boolean; after: number } {
  const r = m.covered.race;
  const after = coverageOf(log.pos.t, r.gunMs, r.endMs);
  if (knownBefore != null) return { before: knownBefore, beforeExact: true, after: Math.max(after, knownBefore) };
  const [i0, i1] = sliceOf(log, m.covered);
  const t = log.pos.t;
  const ws = i1 - i0 > 1 ? checkWindows(t[i0], t[i1 - 1]) : [];
  const ts = Float64Array.from(m.fixes.map((f) => f.ts).sort((a, b) => a - b));
  const covs = ws.slice(0, m.windowsChecked).map((w) => coverageOf(ts, w.after, w.before));
  return { before: covs.length ? covs.reduce((a, b) => a + b, 0) / covs.length : null, beforeExact: false, after };
}

export interface PayloadIds {
  event: string;
  div: string;
}

/** One race's gzipped payload. */
export async function payloadFor(
  log: VkxLog,
  c: CoveredRace,
  ids: PayloadIds,
  boat: { sn: number; sail: string; name?: string },
  src: { sha256: string; bytes: number },
): Promise<{ bytes: Uint8Array; header: Omit<PayloadHeader, 'cols' | 'n' | 't0' | 't1' | 'format' | 'v'>; n: number }> {
  const [i0, i1] = sliceOf(log, c);
  const p = log.pos;
  const from = c.race.gunMs - EVENTS_PRE_GUN_MS;
  const to = c.toMs;
  const decl = log.declination.filter((d) => d.t <= to).at(-1);
  const header = {
    event: ids.event,
    div: ids.div,
    race: c.race.id,
    gunMs: c.race.gunMs,
    sn: boat.sn,
    sail: boat.sail,
    ...(boat.name ? { name: boat.name } : {}),
    rateHz: logSummary(log).rateHz,
    timers: log.timers.filter((e) => e.t >= from && e.t <= to).map((e) => ({ t: e.t, type: e.type, value: e.value })),
    pings: log.pings.filter((e) => e.t >= from && e.t <= to).map((e) => ({ t: e.t, end: e.end, lat: e.lat, lon: e.lon })),
    declinationRad: decl ? decl.rad : null,
    srcSha256: src.sha256,
    srcBytes: src.bytes,
  };
  const orient = log.config?.bodyFixed !== false;
  const bytes = await encodePayload(header, {
    t: p.t.subarray(i0, i1),
    latE7: p.latE7.subarray(i0, i1),
    lonE7: p.lonE7.subarray(i0, i1),
    sog: p.sog.subarray(i0, i1),
    cog: p.cog.subarray(i0, i1),
    ...(orient ? { heading: p.heading.subarray(i0, i1), heel: p.heel.subarray(i0, i1), pitch: p.pitch.subarray(i0, i1) } : {}),
  });
  return { bytes, header, n: i1 - i0 };
}

export { coveredRaces, type RaceWindow };
