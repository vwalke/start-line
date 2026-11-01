/**
 * Gain/loss on the fleet, for the Race Viewer's "Color: Gain/loss" (ui/gain.ts): how fast each boat is closing on, or
 * dropping behind, the fleet's median boat up the ladder of its leg, in m/min.
 *
 * - Read on the ladder the Leader line draws (ladderNow.ts, a reader of its own): every GAIN_STEP_MS from the gun to
 *   the model's end, each boat's distance still to go on its leg, `D`: its rung (bow-based, to its leg's end along the
 *   wind of the moment, past the layline the layline rule) on a beat or run; on a reach, its course progress negated
 *   (distance made good along the rhumb line). Finished, unplaced (`est`) or off any leg: no reading.
 * - The rate at sample j, over GAIN_WINDOW_MS centred on it (j ± h): for boat b on leg L at both ends,
 *   gain = (median over the boats on L at both ends of ΔD − ΔD_b) / Δt. Positive: b took more off its distance to go
 *   than the median boat on its leg did, i.e. it gained on it. The median of the changes, not the change of the median:
 *   a boat rounding into or out of the leg can't make the median jump.
 * - Fewer than GAIN_MIN_BOATS on the leg (a strung-out fleet's leader, a leg the fleet is rounding into): the same on
 *   course progress (ladderNow.ts prog), against every boat on one leg at both ends of the window,
 *   gain = (Δprog_b − median Δprog) / Δt. A boat that changed legs in the window is in neither pool and reads nothing
 *   (on course progress its change spans two legs' scales); with fewer than GAIN_MIN_BOATS in the pool, no reading.
 * - Smoothed by the mean over one sample either side (15 s); NaN where there is no reading.
 * - Worked out once per model (cached), read per fix by gainAt in O(1).
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

/** The gain rate (m/min, NaN: none) of every boat at every sample of `g`, sampled `stepMs` apart, over `windowMs` (above). */
export function gainRates(g: LadderGrid, stepMs = GAIN_STEP_MS, windowMs = GAIN_WINDOW_MS): Float32Array {
  const { boats, n, leg, dist, prog } = g;
  const h = Math.max(1, Math.round(windowMs / 2 / stepMs));
  const perMin = 60_000 / (2 * h * stepMs);
  const raw = new Float32Array(boats * n).fill(NaN);
  const dD = new Float64Array(boats);
  const dP = new Float64Array(boats);
  const onLeg = new Int16Array(boats);
  const pool = new Float64Array(boats);
  const legMed = new Map<number, number>();
  for (let j = h; j + h < n; j++) {
    legMed.clear();
    let fleet = 0;
    for (let b = 0; b < boats; b++) {
      const i0 = b * n + j - h;
      const i1 = b * n + j + h;
      const l0 = leg[i0];
      const l1 = leg[i1];
      onLeg[b] = l0 >= 0 && l0 === l1 && Number.isFinite(dist[i0]) && Number.isFinite(dist[i1]) ? l0 : -1;
      dD[b] = onLeg[b] >= 0 ? dist[i1] - dist[i0] : NaN;
      // Only a boat on one leg at both ends: one that rounded in the window adds the rest of its old leg and the start
      // of the next, which would move the fleet's median. It reads nothing itself either, as on the ladder above.
      dP[b] = l0 >= 0 && l0 === l1 ? prog[i1] - prog[i0] : NaN;
      if (Number.isFinite(dP[b])) pool[fleet++] = dP[b];
      if (onLeg[b] >= 0 && !legMed.has(onLeg[b])) legMed.set(onLeg[b], NaN);
    }
    const fleetMed = fleet >= GAIN_MIN_BOATS ? medianOf(pool, fleet) : NaN;
    for (const L of legMed.keys()) {
      let k = 0;
      for (let b = 0; b < boats; b++) if (onLeg[b] === L) pool[k++] = dD[b];
      legMed.set(L, k >= GAIN_MIN_BOATS ? medianOf(pool, k) : NaN);
    }
    for (let b = 0; b < boats; b++) {
      const med = onLeg[b] >= 0 ? legMed.get(onLeg[b])! : NaN;
      if (Number.isFinite(med)) raw[b * n + j] = (med - dD[b]) * perMin;
      else if (Number.isFinite(dP[b]) && Number.isFinite(fleetMed)) raw[b * n + j] = (dP[b] - fleetMed) * perMin;
    }
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

/** The gain rates for race `a`'s coach model (above), worked out once per model. */
export function gainSeries(a: Pick<RaceAnalysis, 'boats' | 'meta'>, m: CoachModel): GainSeries {
  const hit = cache.get(m);
  if (hit) return hit;
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
  }
  const s: GainSeries = { t0, stepMs: GAIN_STEP_MS, n, ids, index: new Map(ids.map((id, b) => [id, b])), rate: gainRates(g), leg: g.leg };
  cache.set(m, s);
  return s;
}

/** Boat `id`'s gain rate at `t`, m/min: between the samples either side (the one with a reading, where only one has). NaN: none. */
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
  return Number.isFinite(p) ? p : q;
}
