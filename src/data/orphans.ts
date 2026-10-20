/**
 * Races the tracks show but RaceSense doesn't list ("orphans"), rebuilt from the feed.
 *
 * Every telemetry row carries the device's `race_number` and `race_stage` (pre_start, starting,
 * in_progress, finishing, finished). A race's gun is where its devices flip from starting to
 * in_progress: the earliest flips land 0.1–0.7 s before the RO's gun (Cascais races 2, 5, 7
 * against RaceSense; race 8 against the RO's .vkx timer), so the gun is the third-earliest
 * device flip rounded to the second, and stored a second later as RaceSense does (its
 * startTime is hh:mm:01 for an hh:mm:00 gun). The same race number starting again (Cascais
 * Wednesday: race 5 at ~14:34Z, abandoned, then ~16:2xZ) is a restart: the later start wins.
 *
 * Discovery is lazy, bounded and cheap: short windows (10 s, one request each, cached 30 days
 * for a finished event) and at most PROBE_BUDGET requests per division:
 *   - linked to official results: each official race with no RaceSense race at its gun gets
 *     one 60 s window at that gun (more only if the flip isn't in it);
 *   - unlinked: after the last listed race of each racing day that has fewer races than the
 *     event's busiest day, a probe every 30 min until the feed goes quiet, then a binary
 *     search of the last starting → in_progress bracket of each new race number.
 * A rebuilt race gets a RaceSense-shaped race (gun, start line from the start-line trackers at
 * the gun) and a stable number that can't collide with RaceSense's: the gun's UTC minute as
 * YYYYMMDDHHMM (e.g. 202609111355), so `race=202609111355` in a link always means that race.
 */
import type { Race, RegattaDoc, TelemetryPage } from './racesense/types';
import { parseTelemetry, snFromHex } from './racesense/adapter';

export const PROBE_BUDGET = 48;
export const PROBE_MS = 10_000;
export const REFINE_MS = 60_000;
export const STEP_MS = 30 * 60_000;
/** After-the-last-race scan: up to 4 h. */
export const MAX_STEPS = 8;
/** A found gun this close to a listed one is that race. */
export const SAME_RACE_MS = 5 * 60_000;
/** RaceSense's startTime is a second after the RO's gun. */
export const RS_GUN_LAG_MS = 1000;

const PRE = new Set(['pre_start', 'starting']);
const DONE = new Set(['finishing', 'finished']);

export interface ProbeRow {
  ts: number;
  sn: number;
  sail: string;
  role: string;
  lat: number;
  lon: number;
  sog: number;
  stage?: string | null;
  rn?: number | null;
}

/** Fetch rows for [after, before] (one request); `division` null = every division (for shared marks). */
export type FetchRows = (after: number, before: number, division: string | null) => Promise<ProbeRow[]>;

/** Rows from telemetry pages (as parseTelemetry). */
export const probeRows = (pages: TelemetryPage[]): ProbeRow[] => parseTelemetry(pages);

/** Competitor devices of race `rn` by stage (a device counts once per stage: fast reporters don't outvote slow ones). */
export function stageCounts(rows: readonly ProbeRow[]): Map<number, Map<string, number>> {
  const seen = new Set<string>();
  const out = new Map<number, Map<string, number>>();
  for (const r of rows) {
    if (r.role !== 'competitor' || r.rn == null || !r.stage) continue;
    const k = `${r.sn}|${r.rn}|${r.stage}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let m = out.get(r.rn);
    if (!m) out.set(r.rn, (m = new Map()));
    m.set(r.stage, (m.get(r.stage) ?? 0) + 1);
  }
  return out;
}

export type StageState = 'pre' | 'ip' | 'done' | null;

/** Race `rn`'s dominant state in a probe: before its gun (pre_start/starting), racing, finishing/finished, or absent. */
export function stateOf(counts: Map<number, Map<string, number>>, rn: number): StageState {
  const m = counts.get(rn);
  if (!m) return null;
  let pre = 0;
  let ip = 0;
  let done = 0;
  for (const [s, n] of m) {
    if (PRE.has(s)) pre += n;
    else if (s === 'in_progress') ip += n;
    else if (DONE.has(s)) done += n;
  }
  if (!pre && !ip && !done) return null;
  if (ip >= pre && ip >= done) return 'ip';
  return pre >= done ? 'pre' : 'done';
}

/** Has race `rn` started (in_progress outnumbers pre_start/starting, finishing rows ignored)? null with neither. */
export function started(counts: Map<number, Map<string, number>>, rn: number): boolean | null {
  const m = counts.get(rn);
  if (!m) return null;
  let pre = 0;
  let ip = 0;
  for (const [s, n] of m) {
    if (PRE.has(s)) pre += n;
    else if (s === 'in_progress') ip += n;
  }
  if (!pre && !ip) return null;
  return ip > pre;
}

/** The race number most competitor rows carry while in_progress in a probe, or null. */
export function racingNumber(counts: Map<number, Map<string, number>>): number | null {
  let best: number | null = null;
  let n = 0;
  for (const [rn, m] of counts) {
    const ip = m.get('in_progress') ?? 0;
    if (ip > n) [best, n] = [rn, ip];
  }
  return best;
}

/**
 * The gun of race `rn` from a window across it: devices seen before (pre_start/starting) and
 * after (in_progress/finishing) — the third-earliest flip, rounded to the second (the RO's gun).
 */
export function flipGun(rows: readonly ProbeRow[], rn: number): number | null {
  const sorted = [...rows].filter((r) => r.role === 'competitor' && r.rn === rn && r.stage).sort((a, b) => a.ts - b.ts);
  const sawPre = new Set<number>();
  const firstIp = new Map<number, number>();
  for (const r of sorted) {
    if (PRE.has(r.stage!)) {
      if (!firstIp.has(r.sn)) sawPre.add(r.sn);
    } else if ((r.stage === 'in_progress' || r.stage === 'finishing') && sawPre.has(r.sn) && !firstIp.has(r.sn)) firstIp.set(r.sn, r.ts);
  }
  const flips = [...firstIp.values()].sort((a, b) => a - b);
  if (!flips.length) return null;
  return Math.round(flips[Math.min(2, flips.length - 1)] / 1000) * 1000;
}

/** The stable race number of a rebuilt race: its gun's UTC minute, YYYYMMDDHHMM. */
export function orphanKey(trueGunMs: number): number {
  const d = new Date(Math.round(trueGunMs / 60_000) * 60_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return Number(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`);
}

/** A rebuilt race's number (orphanKey) vs a RaceSense one. */
export const isOrphanKey = (n: number): boolean => n >= 190001010000 && n <= 299912312359;

export interface OrphanFound {
  key: number;
  /** RaceSense-convention gun (RO's gun + 1 s), ms. */
  gunMs: number;
  /** The RO's gun as the feed shows it (or the official start), ms. */
  trueGunMs: number;
  feedRaceNumber: number | null;
  /** 'feed': the stage flip; 'official': the official start time (the feed has no flip, the boats are there). */
  gunFrom: 'feed' | 'official';
  officialNumber?: number;
  /** [lat, lon] of the start-line trackers at the gun; null if they sent nothing then. */
  startLine: { leftEnd: [number, number]; rightEnd: [number, number] } | null;
  how: 'official' | 'after-last';
}

export interface OrphanContext {
  division: string;
  /** Listed races of this division (RaceSense, practice included) with a gun; a day of practice only is never scanned. */
  listed: { raceNumber: number; gunMs: number; practice?: boolean }[];
  /** Linked: official races with no RaceSense race at their gun (UTC). */
  officialOnly?: { number: number; gunMs: number }[] | null;
  /** Venue offset (ms), for racing days. */
  tzOffsetMs: number;
  /** Start-line trackers (Firestore hex serials). */
  startDevices: { left: string; right: string } | null;
}

export interface OrphanResult {
  found: OrphanFound[];
  /** Requests made (cached ones count too: the budget bounds work, not just traffic). */
  used: number;
  /** The budget ran out before every probe planned was made. */
  exhausted: boolean;
}

const localDay = (ms: number, tz: number): number => Math.floor((ms + tz) / 86_400_000);

/** Days worth an after-the-last-race scan: racing days (not practice only) with fewer listed races than the busiest one; their last gun. */
export function scanDays(listed: readonly { gunMs: number; practice?: boolean }[], tz: number): number[] {
  const byDay = new Map<number, number[]>();
  for (const r of listed) {
    if (r.practice) continue;
    const d = localDay(r.gunMs, tz);
    const l = byDay.get(d);
    if (l) l.push(r.gunMs);
    else byDay.set(d, [r.gunMs]);
  }
  const max = Math.max(0, ...[...byDay.values()].map((l) => l.length));
  return [...byDay.entries()]
    .filter(([, l]) => l.length < max)
    .sort((a, b) => a[0] - b[0])
    .map(([, l]) => Math.max(...l));
}

class Budget {
  used = 0;
  exhausted = false;
  constructor(readonly max: number) {}
  take(): boolean {
    if (this.used >= this.max) {
      this.exhausted = true;
      return false;
    }
    this.used++;
    return true;
  }
}

/** Positions of the start-line trackers at the gun (median of fixes within ±5 s). */
function lineAt(rows: readonly ProbeRow[], dev: { left: string; right: string }, gunMs: number): OrphanFound['startLine'] {
  const pos = (hex: string): [number, number] | null => {
    const sn = snFromHex(hex);
    const near = rows.filter((r) => r.role === 'mark' && r.sn === sn && Math.abs(r.ts - gunMs) <= 5_000);
    if (!near.length) return null;
    const med = (xs: number[]): number => xs.sort((a, b) => a - b)[xs.length >> 1];
    return [med(near.map((r) => r.lat)), med(near.map((r) => r.lon))];
  };
  const l = pos(dev.left);
  const r = pos(dev.right);
  return l && r ? { leftEnd: l, rightEnd: r } : null;
}

/** Find the division's unlisted races (see the file comment). Never throws; a failed probe just ends that search. */
export async function discoverOrphans(
  ctx: OrphanContext,
  fetchRows: FetchRows,
  opts: { budget?: number; onProgress?: (used: number, max: number) => void } = {},
): Promise<OrphanResult> {
  const budget = new Budget(opts.budget ?? PROBE_BUDGET);
  const found: OrphanFound[] = [];
  const get = async (a: number, b: number, division: string | null = ctx.division): Promise<ProbeRow[] | null> => {
    if (!budget.take()) return null;
    opts.onProgress?.(budget.used, budget.max);
    try {
      return await fetchRows(Math.floor(a), Math.floor(b), division);
    } catch {
      return null;
    }
  };
  const known = (gun: number): boolean =>
    ctx.listed.some((r) => Math.abs(r.gunMs - gun) <= SAME_RACE_MS) || found.some((f) => Math.abs(f.gunMs - gun) <= SAME_RACE_MS);

  /** Binary search the flip of race `rn` in (lo, hi), then refine in a 60 s window. */
  const search = async (rn: number, lo: number, hi: number): Promise<{ gun: number; rows: ProbeRow[] } | null> => {
    // Each probe covers [mid, mid + PROBE_MS]: started there puts the flip before its end.
    while (hi - lo > 3 * PROBE_MS) {
      const mid = (lo + hi) / 2;
      const rows = await get(mid, mid + PROBE_MS);
      if (!rows) return null;
      if (started(stageCounts(rows), rn)) hi = mid + PROBE_MS;
      else lo = mid;
    }
    const a = (lo + hi) / 2 - REFINE_MS / 2;
    const rows = await get(a, a + REFINE_MS);
    if (!rows) return null;
    const gun = flipGun(rows, rn);
    return gun == null ? null : { gun, rows };
  };

  const add = async (gun: number, rows: ProbeRow[], rn: number | null, how: OrphanFound['how'], gunFrom: OrphanFound['gunFrom'], officialNumber?: number): Promise<void> => {
    const gunMs = gun + RS_GUN_LAG_MS;
    if (known(gunMs)) return;
    let line = ctx.startDevices ? lineAt(rows, ctx.startDevices, gun) : null;
    if (!line && ctx.startDevices) {
      // Marks shared across divisions may carry another division's tag.
      const extra = await get(gun - 5_000, gun + 5_000, null);
      if (extra) line = lineAt(extra, ctx.startDevices, gun);
    }
    found.push({ key: orphanKey(gun), gunMs, trueGunMs: gun, feedRaceNumber: rn, gunFrom, startLine: line, how, ...(officialNumber != null ? { officialNumber } : {}) });
  };

  if (ctx.officialOnly) {
    // Linked: probe at each official start that RaceSense doesn't list.
    for (const o of ctx.officialOnly) {
      if (known(o.gunMs)) continue;
      const rows = await get(o.gunMs - REFINE_MS / 2, o.gunMs + REFINE_MS / 2);
      if (!rows) break;
      const counts = stageCounts(rows);
      let hit: { gun: number; rows: ProbeRow[]; rn: number } | null = null;
      for (const rn of counts.keys()) {
        const g = flipGun(rows, rn);
        if (g != null && Math.abs(g - o.gunMs) <= SAME_RACE_MS) hit = { gun: g, rows, rn };
      }
      if (!hit) {
        // A flip a few minutes off the official time: bracket ±10 min on the race racing 10 min later.
        const after = await get(o.gunMs + 10 * 60_000, o.gunMs + 10 * 60_000 + PROBE_MS);
        const rn = after ? racingNumber(stageCounts(after)) : null;
        const before = rn != null ? await get(o.gunMs - 10 * 60_000, o.gunMs - 10 * 60_000 + PROBE_MS) : null;
        if (rn != null && before && started(stageCounts(before), rn) === false) {
          const s = await search(rn, o.gunMs - 10 * 60_000, o.gunMs + 10 * 60_000);
          if (s) hit = { ...s, rn };
        }
      }
      if (hit) {
        await add(hit.gun, hit.rows, hit.rn, 'official', 'feed', o.number);
        continue;
      }
      // No flip (the division's devices never left pre_start), but its boats are out there sailing: rebuild at the official start.
      const moving = new Set(rows.filter((r) => r.role === 'competitor' && r.ts >= o.gunMs && r.sog > 2).map((r) => r.sn));
      if (moving.size >= 3) await add(o.gunMs, rows, null, 'official', 'official', o.number);
    }
  } else {
    // Unlinked: scan after the last listed race of each short racing day.
    for (const last of scanDays(ctx.listed, ctx.tzOffsetMs)) {
      const p0 = await get(last + 3 * 60_000, last + 3 * 60_000 + PROBE_MS);
      if (!p0) break;
      const n0 = racingNumber(stageCounts(p0));
      if (n0 == null) continue;
      const probes: { t: number; counts: Map<number, Map<string, number>> }[] = [];
      for (let k = 1; k <= MAX_STEPS; k++) {
        const t = last + k * STEP_MS;
        const rows = await get(t, t + PROBE_MS);
        if (!rows) break;
        const competitors = rows.filter((r) => r.role === 'competitor').length;
        if (!competitors) break;
        probes.push({ t, counts: stageCounts(rows) });
      }
      // Each later race number: its last (pre → ip) bracket; a pre after ip is a restart.
      const later = new Set<number>();
      for (const p of probes) for (const rn of p.counts.keys()) if (rn > n0) later.add(rn);
      for (const rn of [...later].sort((a, b) => a - b)) {
        let bracket: [number, number] | null = null;
        let prev: { t: number; state: StageState } = { t: last, state: null };
        for (const p of probes) {
          const st = stateOf(p.counts, rn);
          if (st === 'ip' && prev.state !== 'ip') bracket = [prev.t, p.t];
          if (st != null) prev = { t: p.t, state: st };
          else prev = { t: p.t, state: prev.state === 'ip' ? 'ip' : prev.state };
        }
        if (!bracket) continue;
        const s = await search(rn, bracket[0], bracket[1] + PROBE_MS);
        if (s) await add(s.gun, s.rows, rn, 'after-last', 'feed');
      }
    }
  }
  return { found: found.sort((a, b) => a.gunMs - b.gunMs), used: budget.used, exhausted: budget.exhausted };
}

/** A RaceSense-shaped race for a rebuilt one, so the existing pipeline can analyse it (no Vakaros start fixes, no finishes). */
export function orphanRace(f: OrphanFound, timezoneOffset: number | undefined): Race {
  return {
    raceNumber: f.key,
    isPractice: false,
    endTime: null,
    ...(timezoneOffset != null ? { timezoneOffset } : {}),
    starts: [{ startNumber: 1, startTime: f.gunMs, startLine: f.startLine, startingStats: null, ocsParticipants: null, clearedOcs: null, stopReason: null }],
    finishes: [],
  };
}

/** A copy of the regatta document with the rebuilt races added to their divisions. */
export function withOrphans(doc: RegattaDoc, byDivision: ReadonlyMap<string, readonly OrphanFound[]>): RegattaDoc {
  if (!byDivision.size) return doc;
  return {
    ...doc,
    divisions: doc.divisions.map((d) => {
      const add = byDivision.get(d.name);
      if (!add?.length) return d;
      const tz = d.races.find((r) => r.timezoneOffset != null)?.timezoneOffset;
      const have = new Set(d.races.map((r) => r.raceNumber));
      // No start-line fix at the gun: the nearest listed race's line (committees rarely move it far within a day).
      const lined = d.races.map((r) => r.starts?.at(-1)).filter((s) => s?.startTime != null && s.startLine) as { startTime: number; startLine: NonNullable<Race['starts'][number]['startLine']> }[];
      const lineFor = (f: OrphanFound): OrphanFound['startLine'] =>
        f.startLine ?? ([...lined].sort((a, b) => Math.abs(a.startTime - f.gunMs) - Math.abs(b.startTime - f.gunMs))[0]?.startLine ?? null);
      return { ...d, races: [...d.races, ...add.filter((f) => !have.has(f.key)).map((f) => orphanRace({ ...f, startLine: lineFor(f) }, tz))] };
    }),
  };
}
