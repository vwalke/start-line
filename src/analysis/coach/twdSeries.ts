/**
 * Fleet wind direction minute by minute (lib.py fleet_twd_series): every
 * minute, the courses over ground (from positions, never the device heading)
 * of every boat on a beat at > 3 kn within ±1 min are split into the port and
 * starboard tack clusters about the per-leg estimate (wind.ts, the seed); the
 * wind is the midpoint of their medians, the tack angle their spread. A minute
 * with too few samples is interpolated between its neighbours and flagged.
 */
import { MS_TO_KN, bisectRight, interp, median, norm360, vecBearing, wrap180 } from '../geo';
import type { LegKind } from '../types';
import { legAt, type CoachTrack } from './tracks';

export const TWD_STEP_MS = 60_000;
export const TWD_WINDOW_MS = 120_000;
/** Beats only, and only faster than this (tacking, not drifting), kn. */
export const TWD_MIN_SOG_KN = 3;
/** A minute counts when its window has this many samples… */
export const TWD_MIN_SAMPLES = 30;
/** …and this many on each tack. */
export const TWD_MIN_PER_TACK = 8;
/** COG from fix pairs this far apart (lib.py cogsog), s. */
export const COG_MIN_S = 3;
export const COG_MAX_S = 12;

/** Course over ground from pairs of fixes COG_MIN_S…COG_MAX_S apart, at the pair's mid-time. */
export function cogPairs(tr: Pick<CoachTrack, 't' | 'x' | 'y'>): { t: number[]; cog: number[]; sogKn: number[] } {
  const out = { t: [] as number[], cog: [] as number[], sogKn: [] as number[] };
  const n = tr.t.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (j < i) j = i;
    while (j < n && tr.t[j] - tr.t[i] < COG_MIN_S * 1000) j++;
    if (j >= n) break;
    const dt = (tr.t[j] - tr.t[i]) / 1000;
    if (dt > COG_MAX_S) continue;
    const dx = tr.x[j] - tr.x[i];
    const dy = tr.y[j] - tr.y[i];
    out.t.push((tr.t[i] + tr.t[j]) / 2);
    out.cog.push(vecBearing([dx, dy]));
    out.sogKn.push((Math.hypot(dx, dy) / dt) * MS_TO_KN);
  }
  return out;
}

/** The series as plain arrays (what the worker posts back). */
export interface TwdSeriesData {
  /** Minute times, ms (gun, gun + 1 min, …). */
  t: number[];
  /** TWD per minute, ° (interpolated where `ok` is false). */
  twd: number[];
  /** Tack angle per minute, °. */
  ta: number[];
  /** Samples in the minute's window. */
  n: number[];
  /** Enough samples (≥ TWD_MIN_SAMPLES, ≥ TWD_MIN_PER_TACK a tack): measured, not interpolated. */
  ok: boolean[];
}

export interface TwdSeries extends TwdSeriesData {
  /** TWD at any time: linear (unwrapped) between measured minutes, held at the ends; the seed with none. */
  twdAt: (t: number) => number;
  /** Tack angle at any time, likewise. */
  taAt: (t: number) => number;
}

export interface TwdInput {
  gunMs: number;
  endMs: number;
  /** Boats whose positions vote (leave out any the analysis flags; COG is taken from positions regardless). */
  tracks: CoachTrack[];
  legKinds: LegKind[];
  /** The seed: Recall's per-leg estimate (wind.ts makeTwdAt). */
  prior: (t: number) => number;
  /** Tack angle with no measured minute at all, °. */
  priorTa: number;
}

/** Measured points → a function, unwrapped so 355° → 5° interpolates through 0°. */
function seriesAt(ts: number[], vs: number[], angle: boolean, fallback: (t: number) => number): (t: number) => number {
  if (!ts.length) return fallback;
  const u: number[] = [];
  vs.forEach((v, i) => u.push(i && angle ? u[i - 1] + wrap180(v - vs[i - 1]) : v));
  return (t) => (angle ? norm360(interp(ts, u, t)) : interp(ts, u, t));
}

export function fleetTwdSeries(inp: TwdInput): TwdSeries {
  // Upwind COG samples, pooled and time-sorted.
  const pool: { t: number; cog: number }[] = [];
  for (const tr of inp.tracks) {
    const c = cogPairs(tr);
    for (let i = 0; i < c.t.length; i++) {
      if (!(c.sogKn[i] > TWD_MIN_SOG_KN)) continue;
      const leg = legAt(tr.bounds, c.t[i]);
      if (leg == null || inp.legKinds[leg] !== 'upwind') continue;
      pool.push({ t: c.t[i], cog: c.cog[i] });
    }
  }
  pool.sort((a, b) => a.t - b.t);
  const pt = pool.map((p) => p.t);
  const t: number[] = [];
  const raw: (null | { twd: number; ta: number })[] = [];
  const n: number[] = [];
  for (let c = inp.gunMs; c < inp.endMs; c += TWD_STEP_MS) {
    const lo = bisectRight(pt, c - TWD_WINDOW_MS / 2 - 1e-6) + 1;
    const hi = bisectRight(pt, c + TWD_WINDOW_MS / 2);
    const prior = inp.prior(c);
    const st: number[] = [];
    const po: number[] = [];
    for (let i = lo; i <= hi; i++) {
      const rel = wrap180(pool[i].cog - prior);
      if (rel < -15 && rel > -75) st.push(rel);
      else if (rel > 15 && rel < 75) po.push(rel);
    }
    t.push(c);
    n.push(hi - lo + 1);
    if (hi - lo + 1 < TWD_MIN_SAMPLES || st.length < TWD_MIN_PER_TACK || po.length < TWD_MIN_PER_TACK) {
      raw.push(null);
      continue;
    }
    const ms = median(st);
    const mp = median(po);
    raw.push({ twd: norm360(prior + (ms + mp) / 2), ta: mp - ms });
  }
  return twdSeriesFrom({ t, twd: raw.map((r) => r?.twd ?? NaN), ta: raw.map((r) => r?.ta ?? NaN), n, ok: raw.map((r) => r != null) }, inp.prior, inp.priorTa);
}

/** The series with its lookups: minutes that aren't `ok` are filled in from the measured ones (or the seed with none). */
export function twdSeriesFrom(d: TwdSeriesData, prior: (t: number) => number, priorTa: number): TwdSeries {
  const okT = d.t.filter((_, i) => d.ok[i]);
  const twdAt = seriesAt(okT, d.twd.filter((_, i) => d.ok[i]), true, prior);
  const taAt = seriesAt(okT, d.ta.filter((_, i) => d.ok[i]), false, () => priorTa);
  return {
    t: d.t,
    twd: d.t.map((c, i) => (d.ok[i] ? d.twd[i] : twdAt(c))),
    ta: d.t.map((c, i) => (d.ok[i] ? d.ta[i] : taAt(c))),
    n: d.n,
    ok: d.ok,
    twdAt,
    taAt,
  };
}
