/**
 * Gain/loss on the fleet, for the Race Viewer's "Color: Gain/loss" (ui/gain.ts): how fast each boat is closing on, or
 * dropping behind, the fleet's median boat up the ladder of its leg, in m/min.
 *
 * - Read on the ladder the Leader line draws (ladderNow.ts, a reader of its own): every GAIN_STEP_MS from the gun to
 *   the model's end, each boat's distance still to go on its leg, `D`: its rung (bow-based, to its leg's end along the
 *   wind of the moment, past the layline the layline rule) on a beat or run; on a reach, its course progress negated
 *   (distance made good along the rhumb line). Finished, unplaced (`est`) or off any leg: no reading.
 * - The rate at sample j of boat b on leg L, over GAIN_WINDOW_MS centred on it (j ± h), shortened on a side where b
 *   isn't on L throughout (the gun, its finish, a rounding: the window ends at b's last sample on L there), down to
 *   half (h samples, 15 s; any shorter, no reading): gain = (median over the boats on L at both ends of that window
 *   of ΔD − ΔD_b) / Δt. Positive: b took more off its distance to go than the median boat on its leg did, i.e. it
 *   gained on it. The median of the changes, not the change of the median: a boat rounding into or out of the leg
 *   can't make the median jump. So a boat reads from the gun, up to its finish and on through a rounding, each
 *   sample on its own window (no reading held from a sample 15 s on, then a jump).
 * - Fewer than GAIN_MIN_BOATS on the leg (a strung-out fleet's leader, a leg the fleet is rounding into): the same on
 *   course progress (ladderNow.ts prog), against every boat on one leg at both ends of the window,
 *   gain = (Δprog_b − median Δprog) / Δt. A boat that changed legs in that window is left out of the pool (on course
 *   progress its change spans two legs' scales); with fewer than GAIN_MIN_BOATS in it, no reading.
 * - Smoothed by the mean over one sample either side (15 s); NaN where there is no reading.
 * - Worked out once per model (cached), read per fix by gainAt in O(1). A whole fleet's race is tens of ms (more on a
 *   phone), so the page works it out in slices between frames (gainFill, ui/gain.ts gainSeriesSoon); gainSeries
 *   works it out at once (tests, node, or finishing a fill under way).
 */
import type { RaceAnalysis } from '../types';
import type { CoachModel } from './index';
import { newLadderReader } from './ladderNow';

/** Sampled this often, ms. */
export const GAIN_STEP_MS = 5_000;
/** The rate is the change over this long, centred, ms. */
export const GAIN_WINDOW_MS = 30_000;
/** Fewer boats than this on a leg: compared on course progress with the fleet instead. */
export const GAIN_MIN_BOATS = 3;

/** Each boat's ladder at every sample (boat b, sample j at b·n + j): its leg (−1: no reading), distance to go and course progress, m. */
export interface LadderGrid {
  boats: number;
  n: number;
  leg: Int16Array;
  dist: Float64Array;
  prog: Float64Array;
}

function medianOf(xs: Float64Array, k: number): number {
  const s = xs.subarray(0, k).sort();
  return k % 2 ? s[(k - 1) >> 1] : (s[k / 2 - 1] + s[k / 2]) / 2;
}

/** Runs `it` to its end: a sliced pass at once. */
function runOut<T>(it: Generator<void, T, void>): T {
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** The gain rate (m/min, NaN: none) of every boat at every sample of `g`, sampled `stepMs` apart, over `windowMs` (above). */
export const gainRates = (g: LadderGrid, stepMs = GAIN_STEP_MS, windowMs = GAIN_WINDOW_MS): Float32Array => runOut(gainRateSteps(g, stepMs, windowMs));

/** gainRates a slice at a time: pausing after each sample, and after each boat's smoothing. */
function* gainRateSteps(g: LadderGrid, stepMs: number, windowMs: number): Generator<void, Float32Array, void> {
  const { boats, n, leg, dist, prog } = g;
  const h = Math.max(1, Math.round(windowMs / 2 / stepMs));
  const raw = new Float32Array(boats * n).fill(NaN);
  // Each boat's window at the sample: its first and last sample (−1: none).
  const lo = new Int32Array(boats);
  const hi = new Int32Array(boats);
  const pool = new Float64Array(boats);
  // The medians worked out at this sample, by leg and window (NaN: too few boats), and the fleet's by window.
  const legMed = new Map<number, number>();
  const fleetMed = new Map<number, number>();
  const medOnLeg = (L: number, j0: number, j1: number): number => {
    const key = (L * n + j0) * n + j1;
    let v = legMed.get(key);
    if (v === undefined) {
      let k = 0;
      for (let c = 0; c < boats; c++) {
        const i0 = c * n + j0;
        const i1 = c * n + j1;
        if (leg[i0] === L && leg[i1] === L && Number.isFinite(dist[i0]) && Number.isFinite(dist[i1])) pool[k++] = dist[i1] - dist[i0];
      }
      legMed.set(key, (v = k >= GAIN_MIN_BOATS ? medianOf(pool, k) : NaN));
    }
    return v;
  };
  const medOfFleet = (j0: number, j1: number): number => {
    const key = j0 * n + j1;
    let v = fleetMed.get(key);
    if (v === undefined) {
      let k = 0;
      for (let c = 0; c < boats; c++) {
        const i0 = c * n + j0;
        const i1 = c * n + j1;
        // Only a boat on one leg at both ends: one that rounded in the window adds the rest of its old leg and the
        // start of the next, which would move the fleet's median.
        if (leg[i0] >= 0 && leg[i0] === leg[i1] && Number.isFinite(prog[i0]) && Number.isFinite(prog[i1])) pool[k++] = prog[i1] - prog[i0];
      }
      fleetMed.set(key, (v = k >= GAIN_MIN_BOATS ? medianOf(pool, k) : NaN));
    }
    return v;
  };
  for (let j = 0; j < n; j++) {
    legMed.clear();
    fleetMed.clear();
    for (let b = 0; b < boats; b++) {
      const i = b * n + j;
      const L = leg[i];
      lo[b] = -1;
      if (L < 0 || !Number.isFinite(dist[i])) continue;
      // Up to h samples either side, as far as the boat stays on its leg: the gun, its finish or a rounding shortens
      // the window on that side (the rate over what there is, not a reading held from a sample further on).
      let a = 0;
      while (a < h && j - a > 0 && leg[i - a - 1] === L && Number.isFinite(dist[i - a - 1])) a++;
      let c = 0;
      while (c < h && j + c + 1 < n && leg[i + c + 1] === L && Number.isFinite(dist[i + c + 1])) c++;
      if (a + c < h) continue;
      lo[b] = j - a;
      hi[b] = j + c;
    }
    for (let b = 0; b < boats; b++) {
      if (lo[b] < 0) continue;
      const i0 = b * n + lo[b];
      const i1 = b * n + hi[b];
      const perMin = 60_000 / ((hi[b] - lo[b]) * stepMs);
      const med = medOnLeg(leg[i0], lo[b], hi[b]);
      if (Number.isFinite(med)) raw[b * n + j] = (med - (dist[i1] - dist[i0])) * perMin;
      else {
        const fm = medOfFleet(lo[b], hi[b]);
        if (Number.isFinite(fm)) raw[b * n + j] = (prog[i1] - prog[i0] - fm) * perMin;
      }
    }
    yield;
  }
  const out = new Float32Array(boats * n).fill(NaN);
  for (let b = 0; b < boats; b++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      let k = 0;
      for (let q = Math.max(0, j - 1); q <= Math.min(n - 1, j + 1); q++) {
        const v = raw[b * n + q];
        if (Number.isFinite(v)) {
          s += v;
          k++;
        }
      }
      // A sample with no reading of its own stays without one (finished, off the leg).
      if (k && Number.isFinite(raw[b * n + j])) out[b * n + j] = s / k;
    }
    yield;
  }
  return out;
}

/** The fleet's gain rates over the race: boat `ids[b]`'s at t0 + j·stepMs at b·n + j, and its leg then (−1: none). */
export interface GainSeries {
  t0: number;
  stepMs: number;
  n: number;
  ids: string[];
  index: Map<string, number>;
  rate: Float32Array;
  leg: Int16Array;
}

const cache = new WeakMap<CoachModel, GainSeries>();

/** The gain rates for race `a`'s coach model (above), worked out once per model: at once, or finishing a fill under way. */
export function gainSeries(a: Pick<RaceAnalysis, 'boats' | 'meta'>, m: CoachModel): GainSeries {
  const hit = cache.get(m);
  if (hit) return hit;
  gainFill(a, m).step(Infinity);
  return cache.get(m)!;
}

/** The model's gain rates if they're worked out (gainSeries, gainFill), else null. */
export const gainSeriesReady = (m: CoachModel): GainSeries | null => cache.get(m) ?? null;

/** A main-thread slice of a fill (ui/gain.ts gainSeriesSoon), ms: well inside a frame. */
export const GAIN_SLICE_MS = 8;

/** gainSeries a slice at a time: `step` works until `deadline` (performance.now(), ms; at least one sample), true once the series is in. */
export interface GainFill {
  step(deadline: number): boolean;
}

const fills = new WeakMap<CoachModel, GainFill>();

/**
 * The model's fill (one per model, kept while under way: a fill left unstepped resumes where it stopped). Its values
 * are gainSeries's: the same reads in the same order, only paused between samples.
 */
export function gainFill(a: Pick<RaceAnalysis, 'boats' | 'meta'>, m: CoachModel): GainFill {
  const have = fills.get(m);
  if (have) return have;
  const it = seriesSteps(a, m);
  const f: GainFill = {
    step(deadline) {
      if (cache.has(m)) return true;
      do {
        const r = it.next();
        if (r.done) {
          cache.set(m, r.value);
          fills.delete(m);
          return true;
        }
      } while (performance.now() < deadline);
      return false;
    },
  };
  fills.set(m, f);
  return f;
}

/** The series (above), pausing after each sample of the ladder and each step of gainRates. */
function* seriesSteps(a: Pick<RaceAnalysis, 'boats' | 'meta'>, m: CoachModel): Generator<void, GainSeries, void> {
  const read = newLadderReader(a, m);
  const t0 = m.gunMs;
  const n = Math.max(1, Math.floor(Math.max(0, m.endMs - t0) / GAIN_STEP_MS) + 1);
  const ids = read(t0).reads.map((r) => r.id);
  const boats = ids.length;
  const g: LadderGrid = { boats, n, leg: new Int16Array(boats * n), dist: new Float64Array(boats * n), prog: new Float64Array(boats * n) };
  for (let j = 0; j < n; j++) {
    const now = read(t0 + j * GAIN_STEP_MS);
    for (let b = 0; b < boats; b++) {
      const r = now.reads[b];
      const i = b * n + j;
      const ok = !r.est && !r.done && r.leg >= 0 && Number.isFinite(r.prog);
      g.leg[i] = ok ? r.leg : -1;
      g.dist[i] = !ok ? NaN : Number.isFinite(r.rung) ? r.rung : -r.prog;
      g.prog[i] = ok ? r.prog : NaN;
    }
    yield;
  }
  const rate = yield* gainRateSteps(g, GAIN_STEP_MS, GAIN_WINDOW_MS);
  return { t0, stepMs: GAIN_STEP_MS, n, ids, index: new Map(ids.map((id, b) => [id, b])), rate, leg: g.leg };
}
/**
 * Boat `id`'s gain rate at `t`, m/min: between the samples either side; where only one has a reading, that reading up
 * to half a step from it (the middle between the two), so a reading never runs on toward a sample without one. NaN: none.
 */
export function gainAt(s: GainSeries, id: string, t: number): number {
  const b = s.index.get(id);
  if (b == null || !Number.isFinite(t)) return NaN;
  const x = (t - s.t0) / s.stepMs;
  if (x < 0 || x > s.n - 1) return NaN;
  const j = Math.min(s.n - 1, Math.floor(x));
  const f = x - j;
  const p = s.rate[b * s.n + j];
  const q = j + 1 < s.n ? s.rate[b * s.n + j + 1] : NaN;
  if (Number.isFinite(p) && Number.isFinite(q)) return p + (q - p) * f;
  return f <= 0.5 ? p : q;
}
