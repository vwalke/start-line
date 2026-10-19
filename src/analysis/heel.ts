/**
 * Heel and trim from the tracker's IMU (RaceSense `roll` and `pitch`, integer
 * degrees). Sign of `roll`, from the data: negative = heeled to port. Upwind
 * on starboard tack (wind over the starboard side, signed TWA > 0) every
 * fixture fleet averages −10° to −21°, on port tack +10° to +21°.
 *
 * Leeward heel = −roll · sign(TWA): positive heeled to leeward (the normal
 * upwind heel), negative heeled to windward (roll-tacking, light-air windward
 * heel, a run heeled to weather). TWA is the manoeuvre detector's signed TWA
 * (course over ground vs the estimated wind); where its side is unclear
 * (|TWA| under MAN_TWA_MIN or over MAN_TWA_MAX: head to wind, dead downwind)
 * a sample has no leeward heel.
 *
 * Means are time-weighted: each fix holds until the next one, and intervals
 * longer than COVERAGE_GAP_S count for nothing (never across a telemetry gap).
 * Fixes within HEEL_MAN_EXCLUDE_MS of a tack or gybe are left out of the means
 * (heel swings through zero there) but still count as heel data for coverage.
 */
import { COVERAGE_GAP_S } from './coverage';
import { MAN_TWA_MAX, MAN_TWA_MIN, type Manoeuvre } from './manoeuvres';
import { rangeIdx } from './prepare';

/** Fixes this close to a tack or gybe are left out of heel and trim means, ms (heel flips from ~1 s before the crossing to ~4 s after). */
export const HEEL_MAN_EXCLUDE_MS = 5_000;
/** Heel at the gun: the nearest fix with a leeward heel at most this far from it, ms. */
export const HEEL_AT_GUN_MS = 2_000;

/** Leeward heel (° , + = to leeward) from roll (° , − = to port) and signed TWA (+ = starboard); NaN when either is missing or the side is unclear. */
export function leewardHeel(roll: number, twa: number): number {
  if (!Number.isFinite(roll) || !Number.isFinite(twa)) return NaN;
  const a = Math.abs(twa);
  if (a < MAN_TWA_MIN || a > MAN_TWA_MAX) return NaN;
  return roll === 0 ? 0 : -roll * Math.sign(twa);
}

/** One boat's heel series, parallel to its fix times. */
export interface HeelSeries {
  t: ArrayLike<number>;
  /** Raw roll, NaN = no reading (coverage counts these). */
  roll: ArrayLike<number>;
  /** Leeward heel, NaN when unknown or within HEEL_MAN_EXCLUDE_MS of a manoeuvre. */
  lee: Float64Array;
  /** Pitch, NaN = no reading or near a manoeuvre; absent when the source has none. */
  pitch?: Float64Array;
}

/** Leeward heel per fix, with the fixes around each manoeuvre blanked. */
export function heelSeries(
  t: ArrayLike<number>,
  roll: ArrayLike<number>,
  twa: ArrayLike<number>,
  manoeuvres: Pick<Manoeuvre, 'tMs'>[],
  pitch?: ArrayLike<number>,
): HeelSeries {
  const n = t.length;
  const lee = new Float64Array(n);
  const pt = pitch ? Float64Array.from(pitch) : undefined;
  const ms = manoeuvres.map((m) => m.tMs).sort((a, b) => a - b);
  let j = 0;
  for (let k = 0; k < n; k++) {
    while (j < ms.length && ms[j] < t[k] - HEEL_MAN_EXCLUDE_MS) j++;
    const near = j < ms.length && ms[j] <= t[k] + HEEL_MAN_EXCLUDE_MS;
    lee[k] = near ? NaN : leewardHeel(roll[k], twa[k]);
    if (pt && near) pt[k] = NaN;
  }
  return { t, roll, lee, ...(pt ? { pitch: pt } : {}) };
}

export interface HeelStats {
  /** Time-weighted mean leeward heel, °; null with no usable fix. */
  heelDeg: number | null;
  /** Time-weighted mean pitch, °; null with none. */
  trimDeg: number | null;
  /** Share of [a, b] with a roll reading on fixes ≤ COVERAGE_GAP_S apart (manoeuvres count as covered), 0–1. */
  coverage: number;
  /** Time the heel mean rests on, s. */
  heelS: number;
}

/** Heel and trim over [a, b] (ms, a < b). */
export function heelStats(s: HeelSeries, a: number, b: number, gapS = COVERAGE_GAP_S): HeelStats {
  const { t, roll, lee, pitch } = s;
  const n = t.length;
  const gapMs = gapS * 1000;
  let read = 0;
  let hSum = 0;
  let hW = 0;
  let pSum = 0;
  let pW = 0;
  if (n > 1 && b > a) {
    const [i0, i1] = rangeIdx(t instanceof Float64Array ? t : Float64Array.from(t), a, b);
    // Each fix holds until the next: from the one holding `a` to the last before `b`.
    for (let k = Math.max(0, i0 - 1); k < Math.min(n - 1, i1); k++) {
      if (t[k + 1] - t[k] > gapMs) continue;
      const w = Math.min(t[k + 1], b) - Math.max(t[k], a);
      if (w <= 0) continue;
      if (Number.isFinite(roll[k])) read += w;
      if (Number.isFinite(lee[k])) {
        hSum += lee[k] * w;
        hW += w;
      }
      if (pitch && Number.isFinite(pitch[k])) {
        pSum += pitch[k] * w;
        pW += w;
      }
    }
  }
  return {
    heelDeg: hW > 0 ? hSum / hW : null,
    trimDeg: pW > 0 ? pSum / pW : null,
    coverage: b > a ? Math.min(1, read / (b - a)) : 0,
    heelS: hW / 1000,
  };
}

/** Leeward heel of the fix nearest `ts` within `maxMs` that has one; null otherwise. */
export function heelAt(s: HeelSeries, ts: number, maxMs = HEEL_AT_GUN_MS): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  const tt = s.t instanceof Float64Array ? s.t : Float64Array.from(s.t);
  const [i0, i1] = rangeIdx(tt, ts - maxMs, ts + maxMs);
  for (let k = i0; k < i1; k++) {
    const d = Math.abs(tt[k] - ts);
    if (Number.isFinite(s.lee[k]) && d < bestD) {
      bestD = d;
      best = s.lee[k];
    }
  }
  return best;
}
