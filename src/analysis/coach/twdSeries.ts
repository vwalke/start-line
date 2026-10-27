/**
 * Fleet wind direction minute by minute (lib.py fleet_twd_series): every
 * minute, the courses over ground (from positions, never the device heading)
 * of every boat on a beat at > 3 kn within ±1 min are split into the port and
 * starboard tack clusters about the per-leg estimate (wind.ts, the seed); the
 * wind is the midpoint of their medians, the tack angle their spread. On the
 * runs (GYBE_WIND) the boats' courses are split the same way into the two gybes
 * either side of dead downwind, and the wind is opposite their midpoint; such a
 * reading is kept only far from the beat readings (GYBE_MIN_GAP_MS) or after the
 * last of them. A minute with too few samples is interpolated between its
 * neighbours and flagged.
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

/** Read the wind on the runs too, from the fleet's gybes (false: the beats only); index.ts gybesFor: asymmetric kites only. */
export const GYBE_WIND = true;
/** Runs only, and only faster than this (sailing, not drifting), kn. */
export const GYBE_MIN_SOG_KN = 3;
/**
 * A gybe is this far either side of dead downwind (the seed's), °: an asymmetric kite's ~30–45° and a symmetric
 * kite's 10–25°; straight down the course is left out (it is on neither gybe, and pulls both medians to the seed).
 */
export const GYBE_INNER_DEG = 8;
export const GYBE_OUTER_DEG = 60;
/** The runs' window, ms: wider than the beats' (fewer boats gybe than tack, and less often). */
export const GYBE_WINDOW_MS = 180_000;
/** A run minute counts when its window has this many samples… */
export const GYBE_MIN_SAMPLES = 50;
/** …this many on each gybe… */
export const GYBE_MIN_PER_GYBE = 5;
/** …this many boats on the run… */
export const GYBE_MIN_BOATS = 4;
/** …this many boats on each gybe… */
export const GYBE_MIN_BOATS_PER_GYBE = 2;
/** …and the smaller gybe at least this share of the larger (a lopsided split leans to its bigger side). */
export const GYBE_BALANCE = 0.15;
/** Light air: no run reading when the window's median speed is under this, kn (slow boats gybe at loose angles, and current weighs more). */
export const GYBE_MIN_RUN_SOG_KN = 5.5;
/**
 * A run reading is used only this far from every beat reading, ms, or where no beat reading follows (the race's last
 * run): nearer a beat, interpolating between beat readings is as good or better.
 */
export const GYBE_MIN_GAP_MS = 10 * 60_000;

/** The run thresholds as one value (what gybeTwd reads). */
export interface GybeParams {
  innerDeg: number;
  outerDeg: number;
  minSamples: number;
  minPerGybe: number;
  minBoats: number;
  minBoatsPerGybe: number;
  balance: number;
  minRunSogKn: number;
}
export const GYBE: GybeParams = {
  innerDeg: GYBE_INNER_DEG,
  outerDeg: GYBE_OUTER_DEG,
  minSamples: GYBE_MIN_SAMPLES,
  minPerGybe: GYBE_MIN_PER_GYBE,
  minBoats: GYBE_MIN_BOATS,
  minBoatsPerGybe: GYBE_MIN_BOATS_PER_GYBE,
  balance: GYBE_BALANCE,
  minRunSogKn: GYBE_MIN_RUN_SOG_KN,
};

/** A run sample: course over ground, °, speed over ground, kn, and which boat. */
export interface RunSample {
  cog: number;
  sogKn: number;
  boat: number;
}

/**
 * The wind from one window of run samples, °, or null: the courses either side of the downwind guess (`prior` + 180°)
 * are the two gybes, and the wind is opposite the midpoint of their medians. Null when the window is thin, a gybe has
 * too few samples or boats, one gybe dwarfs the other, or the boats are slow (light air). (Splitting again about the first answer read worse.)
 */
export function gybeTwd(s: readonly RunSample[], prior: number, p: GybeParams = GYBE): number | null {
  if (s.length < p.minSamples || new Set(s.map((x) => x.boat)).size < p.minBoats) return null;
  if (p.minRunSogKn > 0 && median(s.map((x) => x.sogKn)) < p.minRunSogKn) return null;
  const dd = prior + 180;
  const a: number[] = [];
  const b: number[] = [];
  const ba = new Set<number>();
  const bb = new Set<number>();
  for (const x of s) {
    const rel = wrap180(x.cog - dd);
    if (Math.abs(rel) < p.innerDeg || Math.abs(rel) > p.outerDeg) continue;
    if (rel < 0) {
      a.push(rel);
      ba.add(x.boat);
    } else {
      b.push(rel);
      bb.add(x.boat);
    }
  }
  const lo = Math.min(a.length, b.length);
  if (lo < p.minPerGybe || lo < p.balance * Math.max(a.length, b.length) || Math.min(ba.size, bb.size) < p.minBoatsPerGybe) return null;
  return norm360(prior + (median(a) + median(b)) / 2);
}

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
  /** Measured, not interpolated: enough samples on the beats (≥ TWD_MIN_SAMPLES, ≥ TWD_MIN_PER_TACK a tack) or on the runs (gybeTwd). */
  ok: boolean[];
  /** The tack angle measured (the beats); absent: as `ok`. A minute read from the gybes alone has none. */
  taOk?: boolean[];
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
  /** Read the runs too; default GYBE_WIND (windSeries passes index.ts gybesFor). */
  gybes?: boolean;
}

/** Measured points → a function, unwrapped so 355° → 5° interpolates through 0°. */
function seriesAt(ts: number[], vs: number[], angle: boolean, fallback: (t: number) => number): (t: number) => number {
  if (!ts.length) return fallback;
  const u: number[] = [];
  vs.forEach((v, i) => u.push(i && angle ? u[i - 1] + wrap180(v - vs[i - 1]) : v));
  return (t) => (angle ? norm360(interp(ts, u, t)) : interp(ts, u, t));
}

export function fleetTwdSeries(inp: TwdInput): TwdSeries {
  // Upwind COG samples, pooled and time-sorted; the run samples likewise.
  const pool: { t: number; cog: number }[] = [];
  const down: (RunSample & { t: number })[] = [];
  const gybes = inp.gybes ?? GYBE_WIND;
  inp.tracks.forEach((tr, boat) => {
    const c = cogPairs(tr);
    for (let i = 0; i < c.t.length; i++) {
      const leg = legAt(tr.bounds, c.t[i]);
      if (leg == null) continue;
      if (inp.legKinds[leg] === 'upwind') {
        if (c.sogKn[i] > TWD_MIN_SOG_KN) pool.push({ t: c.t[i], cog: c.cog[i] });
      } else if (gybes && inp.legKinds[leg] === 'downwind' && c.sogKn[i] > GYBE_MIN_SOG_KN) {
        down.push({ t: c.t[i], cog: c.cog[i], sogKn: c.sogKn[i], boat });
      }
    }
  });
  pool.sort((a, b) => a.t - b.t);
  down.sort((a, b) => a.t - b.t);
  const pt = pool.map((p) => p.t);
  const dt = down.map((p) => p.t);
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
      // No beat reading: the runs', if any (it measures no tack angle).
      const dlo = bisectRight(dt, c - GYBE_WINDOW_MS / 2 - 1e-6) + 1;
      const dhi = bisectRight(dt, c + GYBE_WINDOW_MS / 2);
      const g = dhi >= dlo ? gybeTwd(down.slice(dlo, dhi + 1), prior) : null;
      raw.push(g == null ? null : { twd: g, ta: NaN });
      continue;
    }
    const ms = median(st);
    const mp = median(po);
    raw.push({ twd: norm360(prior + (ms + mp) / 2), ta: mp - ms });
  }
  // A run reading only far from the beat readings, or with none after it.
  const tackT = t.filter((_, i) => raw[i] != null && !Number.isNaN(raw[i]!.ta));
  raw.forEach((r, i) => {
    if (r == null || !Number.isNaN(r.ta)) return;
    const near = tackT.reduce((m, x) => Math.min(m, Math.abs(x - t[i])), Infinity);
    if (tackT.some((x) => x > t[i]) && near < GYBE_MIN_GAP_MS) raw[i] = null;
  });
  const ok = raw.map((r) => r != null);
  return twdSeriesFrom(
    { t, twd: raw.map((r) => r?.twd ?? NaN), ta: raw.map((r) => r?.ta ?? NaN), n, ok, taOk: raw.map((r) => r != null && !Number.isNaN(r.ta)) },
    inp.prior,
    inp.priorTa,
  );
}

/** The series with its lookups: minutes that aren't `ok` are filled in from the measured ones (or the seed with none); the tack angle likewise from `taOk`. */
export function twdSeriesFrom(d: TwdSeriesData, prior: (t: number) => number, priorTa: number): TwdSeries {
  const taOk = d.taOk ?? d.ok;
  const okT = d.t.filter((_, i) => d.ok[i]);
  const twdAt = seriesAt(okT, d.twd.filter((_, i) => d.ok[i]), true, prior);
  const taAt = seriesAt(d.t.filter((_, i) => taOk[i]), d.ta.filter((_, i) => taOk[i]), false, () => priorTa);
  return {
    t: d.t,
    twd: d.t.map((c, i) => (d.ok[i] ? d.twd[i] : twdAt(c))),
    ta: d.t.map((c, i) => (taOk[i] ? d.ta[i] : taAt(c))),
    n: d.n,
    ok: d.ok,
    taOk,
    twdAt,
    taAt,
  };
}
