/**
 * Tacks and gybes from the GPS track, with no wind sensor and no heading
 * trust: course over ground from position differences over MAN_COG_WINDOW_MS
 * (never across a telemetry gap), against the estimated true wind at each
 * time, gives a signed TWA in (−180, 180] (+ = starboard tack).
 *
 * A side (port / starboard) is *established* only once the boat has held it
 * for MAN_DWELL_MS with |TWA| between MAN_TWA_MIN and MAN_TWA_MAX at SOG ≥
 * MAN_MIN_SOG_KN, so jitter, luffing head-to-wind and sailing by the lee
 * never count, and a drifting boat never changes side. A change of
 * established side is a tack if the (unwrapped) TWA crossed 0 on the way,
 * a gybe if it crossed ±180; it happens at the time of that crossing. A full
 * turn back to the same side (a penalty turn) is no change, so no manoeuvre.
 *
 * Mark roundings need no special case: bearing away from close-hauled to a
 * run on the same side, or rounding up from a run on the same side, is not a
 * side change. A gybe-set or a tack around the leeward mark is, and counts.
 * Within MAN_ROUNDING_MS of a leg boundary such a manoeuvre goes to the
 * adjacent leg it belongs to (a gybe to the run or reach, a tack to the beat)
 * if the leg holding the crossing is the other kind.
 *
 * A side change that bridges a telemetry gap (> MAN_GAP_MS between fixes) is
 * counted but marked approximate: the type comes from the shortest turn
 * between the two sides.
 */
import { MS_TO_KN, vecBearing, wrap180 } from './geo';
import type { LegKind } from './types';
import { SPAN_MS } from './validity';

/** Course over ground: displacement over this centred window, ms. */
export const MAN_COG_WINDOW_MS = 5_000;
/** A side counts only once held this long, ms. */
export const MAN_DWELL_MS = 10_000;
/** Clear of head-to-wind / dead downwind: |TWA| within [MIN, MAX] to hold a side, degrees. */
export const MAN_TWA_MIN = 20;
export const MAN_TWA_MAX = 160;
/** Slower than this (displacement SOG over the window) never holds a side: drifting, stopped, kn. */
export const MAN_MIN_SOG_KN = 1.5;
/** Fixes further apart than this are a telemetry gap (as the distance `~`), ms. */
export const MAN_GAP_MS = SPAN_MS;
/** Track used before the gun so the side held at the start is known, ms. */
export const MAN_LEAD_MS = 30_000;
/** Within this of a leg boundary, a manoeuvre may go to the adjacent leg it belongs to, ms. */
export const MAN_ROUNDING_MS = 15_000;

export interface Manoeuvre {
  kind: 'tack' | 'gybe';
  /** When the TWA crossed head-to-wind (tack) or dead downwind (gybe), ms. */
  tMs: number;
  /** The side change bridges a telemetry gap: counted, but approximate. */
  gap: boolean;
}

export interface ManoeuvreTrack {
  t: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

/** Signed TWA (+ = starboard), displacement SOG (kn) and course over ground per fix; NaN where no window fits. */
export function signedTwa(tr: ManoeuvreTrack, twdAt: (t: number) => number): { twa: Float64Array; sog: Float64Array } {
  const n = tr.t.length;
  const twa = new Float64Array(n).fill(NaN);
  const sog = new Float64Array(n).fill(NaN);
  const half = MAN_COG_WINDOW_MS / 2;
  let lo = 0;
  let hi = 0;
  let runStart = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && tr.t[i] - tr.t[i - 1] > MAN_GAP_MS) runStart = i;
    if (lo < runStart) lo = runStart;
    while (tr.t[i] - tr.t[lo] > half) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && tr.t[hi + 1] - tr.t[i] <= half && tr.t[hi + 1] - tr.t[hi] <= MAN_GAP_MS) hi++;
    // Sparse fixes: widen to the neighbours (still never across a gap).
    let a = lo;
    let b = hi;
    if (a === b) {
      if (a > runStart) a--;
      if (b + 1 < n && tr.t[b + 1] - tr.t[b] <= MAN_GAP_MS) b++;
    }
    const dt = (tr.t[b] - tr.t[a]) / 1000;
    if (!(dt > 0)) continue;
    const dx = tr.x[b] - tr.x[a];
    const dy = tr.y[b] - tr.y[a];
    sog[i] = (Math.hypot(dx, dy) / dt) * MS_TO_KN;
    twa[i] = wrap180(twdAt(tr.t[i]) - vecBearing([dx, dy]));
    if (twa[i] === -180) twa[i] = 180;
  }
  return { twa, sog };
}

/** Times (ms) in (t0, t1] where the unwrapped TWA path from u0 to u1 crosses `base` + k·360; linear between samples. */
function crossings(t: ArrayLike<number>, u: Float64Array, i0: number, i1: number, base: number): number[] {
  const out: number[] = [];
  for (let k = i0 + 1; k <= i1; k++) {
    const a = u[k - 1];
    const b = u[k];
    if (a === b) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    // Every base + m·360 in (lo, hi].
    for (let m = Math.ceil((lo - base) / 360); base + m * 360 <= hi; m++) {
      const c = base + m * 360;
      if (c <= lo) continue;
      out.push(t[k - 1] + ((c - a) / (b - a)) * (t[k] - t[k - 1]));
    }
  }
  return out;
}

/**
 * Tacks and gybes between `fromMs` and `toMs` (crossing times), using the
 * track from MAN_LEAD_MS before `fromMs` (to know the side held at the start)
 * and up to MAN_DWELL_MS after `toMs` (to confirm a late manoeuvre).
 */
export function detectManoeuvres(tr: ManoeuvreTrack, twdAt: (t: number) => number, fromMs: number, toMs: number): Manoeuvre[] {
  const n = tr.t.length;
  const { twa, sog } = signedTwa(tr, twdAt);
  // Unwrap TWA over the usable fixes (across a gap, the shortest turn).
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (tr.t[i] < fromMs - MAN_LEAD_MS) continue;
    if (tr.t[i] > toMs + MAN_DWELL_MS) break;
    if (Number.isFinite(twa[i])) idx.push(i);
  }
  const t = idx.map((i) => tr.t[i]);
  const u = new Float64Array(idx.length);
  idx.forEach((i, k) => (u[k] = k ? u[k - 1] + wrap180(twa[i] - twa[idx[k - 1]]) : twa[i]));
  const clear = (k: number): number => {
    const a = Math.abs(twa[idx[k]]);
    return sog[idx[k]] >= MAN_MIN_SOG_KN && a >= MAN_TWA_MIN && a <= MAN_TWA_MAX ? Math.sign(twa[idx[k]]) : 0;
  };

  const out: Manoeuvre[] = [];
  let side = 0; // established side
  let lastOn = -1; // last clear sample on the established side
  let runSide = 0;
  let runStart = -1;
  for (let k = 0; k < idx.length; k++) {
    const s = clear(k);
    // A run of one side carries on across a telemetry gap (same side both ends: the lossy feed
    // would otherwise never let a side settle); the side change into it is flagged below.
    if (s === 0 || s !== runSide) {
      runSide = s;
      runStart = s ? k : -1;
    }
    if (s !== 0 && s === side) {
      lastOn = k;
      continue;
    }
    if (s === 0 || k === runStart || t[k] - t[runStart] < MAN_DWELL_MS) continue;
    // A new side held long enough: established from runStart.
    if (side !== 0 && lastOn >= 0) {
      const tacks = crossings(t, u, lastOn, runStart, 0);
      const gybes = crossings(t, u, lastOn, runStart, 180);
      // The side changed, so one kind crossed an odd number of times: that's the manoeuvre.
      const kind = tacks.length % 2 ? 'tack' : 'gybe';
      const tMs = (kind === 'tack' ? tacks : gybes).at(-1);
      let gap = false;
      for (let j = lastOn + 1; j <= runStart; j++) if (t[j] - t[j - 1] > MAN_GAP_MS) gap = true;
      if (tMs != null && tMs >= fromMs && tMs <= toMs) out.push({ kind, tMs, gap });
    }
    side = s;
    lastOn = k;
  }
  return out;
}

export interface LegManoeuvres {
  tacks: number;
  gybes: number;
  /** Some manoeuvre on the leg bridges a telemetry gap. */
  gap: boolean;
}

/**
 * Count manoeuvres per leg. `bounds` are the leg boundary times (n legs →
 * n + 1 times; null = unknown). A manoeuvre within MAN_ROUNDING_MS of a
 * boundary goes to the adjacent leg whose kind suits it (gybe → downwind or
 * reach, tack → upwind) when the leg holding it doesn't.
 */
export function manoeuvresByLeg(ms: Manoeuvre[], bounds: (number | null)[], kinds: LegKind[]): (LegManoeuvres | null)[] {
  const out: (LegManoeuvres | null)[] = kinds.map((_, i) => (bounds[i] != null && bounds[i + 1] != null ? { tacks: 0, gybes: 0, gap: false } : null));
  const suits = (m: Manoeuvre, li: number): boolean => (m.kind === 'tack' ? kinds[li] === 'upwind' : kinds[li] !== 'upwind');
  for (const m of ms) {
    let li = kinds.findIndex((_, i) => bounds[i] != null && bounds[i + 1] != null && m.tMs >= bounds[i]! && m.tMs < bounds[i + 1]!);
    if (li < 0 && m.tMs === bounds[kinds.length]) li = kinds.length - 1;
    if (li < 0) continue;
    if (!suits(m, li)) {
      if (li > 0 && m.tMs - bounds[li]! <= MAN_ROUNDING_MS && out[li - 1] && suits(m, li - 1)) li--;
      else if (li < kinds.length - 1 && bounds[li + 1]! - m.tMs <= MAN_ROUNDING_MS && out[li + 1] && suits(m, li + 1)) li++;
    }
    const c = out[li]!;
    if (m.kind === 'tack') c.tacks++;
    else c.gybes++;
    if (m.gap) c.gap = true;
  }
  return out;
}
