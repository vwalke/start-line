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
 * between the two sides. A lossy feed often drops out just after a tack, so a
 * side held clear for MAN_GAP_SHORT_DWELL_MS right up to such a gap counts as
 * established too: the tack into it (seen in clean data) and the one out of it
 * after the gap (approximate) both count. Across a hole a turn with either end
 * at |TWA| ≥ MAN_UPWIND_DEG is a gybe whatever the shortest turn: a beat into
 * a hole at the windward mark and a run out of it is a bear-away, not a tack.
 *
 * Where the course over ground has no window (an isolated fix between gaps),
 * or gives no clear side (|TWA| outside [MIN, MAX] or SOG under the floor),
 * the device heading stands in for it where the heading's TWA is clear and
 * device SOG meets the floor, unless headingCheck finds the compass broken.
 * Where the track has roll, a flip of heel side upwind (MAN_HEEL_ROLL_DEG held
 * MAN_HEEL_DWELL_MS each side, or MAN_HEEL_GAP_FIXES fixes on the new side
 * straight after a gap) adds an approximate tack, never a gybe, unless the
 * course already counted a manoeuvre there (within MAN_HEEL_MERGE_MS), a clear
 * TWA next to it says otherwise, or the course or heading shows either side
 * downwind.
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
/** A side held clear this long right up to a telemetry gap counts as established (approximate), ms. */
export const MAN_GAP_SHORT_DWELL_MS = 3_000;
/** Heel vote: |roll| at least this much has a side (− = heeled to port ≈ starboard tack upwind), degrees. */
export const MAN_HEEL_ROLL_DEG = 5;
/** Upwind is |TWA| under this: a turn across a hole with either end at or above it is no tack, nor is a heel flip there, degrees. */
export const MAN_UPWIND_DEG = 90;
/** Heel vote: a heel side counts once held this long (or for MAN_HEEL_GAP_FIXES fixes straight after a telemetry gap), ms. */
export const MAN_HEEL_DWELL_MS = 3_000;
/** Heel vote: after a telemetry gap, this many fixes in a row heeled to the new side also hold it (one fix never does). */
export const MAN_HEEL_GAP_FIXES = 2;
/** Heel vote: a heel flip this close to a manoeuvre the course already counted is that manoeuvre, ms. */
export const MAN_HEEL_MERGE_MS = 15_000;
/** Heel vote: a clear TWA this close before / after a heel flip must agree with it (and be upwind), ms. */
export const MAN_HEEL_TWA_MS = 10_000;

export interface Manoeuvre {
  kind: 'tack' | 'gybe';
  /** When the TWA crossed head-to-wind (tack) or dead downwind (gybe), ms. */
  tMs: number;
  /** The side change bridges a telemetry gap (or rests on heel alone): counted, but approximate. */
  gap: boolean;
  /** When approximate: the times of the fixes either side of it, between which the turn happened, ms. */
  span?: [number, number];
}

export interface ManoeuvreTrack {
  t: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Device heading, °: detectManoeuvres' side where the course over ground has no window or no clear side and its own TWA is clear (unless the compass is bad). */
  heading?: ArrayLike<number>;
  /** Device SOG, kn: the speed floor at those heading-only fixes (none without it). */
  sog?: ArrayLike<number>;
  /** Roll, ° (− = heeled to port; NaN = no reading): detectManoeuvres' heel vote. */
  roll?: ArrayLike<number>;
}

export interface DetectOptions {
  /** The track's headingCheck source when already known (e.g. its heading was replaced by the course); else checked here. */
  headingSource?: HeadingCheck['source'];
}

/** Signed TWA (+ = starboard) and displacement SOG (kn) per fix, from the course over ground; NaN where no window fits. */
export function signedTwa(tr: ManoeuvreTrack, twdAt: (t: number) => number): { twa: Float64Array; sog: Float64Array } {
  const { cog, sog } = cogSeries(tr);
  const twa = new Float64Array(cog.length).fill(NaN);
  for (let i = 0; i < cog.length; i++) {
    if (Number.isNaN(cog[i])) continue;
    twa[i] = wrap180(twdAt(tr.t[i]) - cog[i]);
    if (twa[i] === -180) twa[i] = 180;
  }
  return { twa, sog };
}

/** Course over ground (°) and displacement SOG (kn) per fix over MAN_COG_WINDOW_MS, never across a gap; NaN where no window fits. */
export function cogSeries(tr: ManoeuvreTrack): { cog: Float64Array; sog: Float64Array } {
  const n = tr.t.length;
  const cog = new Float64Array(n).fill(NaN);
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
    cog[i] = vecBearing([dx, dy]);
  }
  return { cog, sog };
}

/**
 * A device heading this far off the course over ground (median |HDG − COG|
 * at speed) is a broken or unset compass, not leeway or current (a few
 * degrees: ≤ 16° median on 52 of the 54 J/105 tracks of one event, 85° and 115° on the broken compass).
 */
export const HDG_BAD_DEG = 30;
/** Only fixes at least this fast (displacement SOG) are compared: COG is noise when slow, kn. */
export const HDG_MIN_SOG_KN = 2;
/** Fewer compared fixes than this and the heading is kept. */
export const HDG_MIN_FIXES = 30;

export interface HeadingCheck {
  /** 'cog' when the device heading is replaced by the course over ground. */
  source: 'device' | 'cog';
  /** Median |HDG − COG| over the compared fixes, °; null with too few. */
  offDeg: number | null;
}

/** Does this track's device heading agree with its GPS course? */
export function headingCheck(tr: ManoeuvreTrack & { heading: ArrayLike<number> }): HeadingCheck {
  const { cog, sog } = cogSeries(tr);
  return checkHeading(tr.heading, cog, sog);
}

function checkHeading(heading: ArrayLike<number>, cog: Float64Array, sog: Float64Array): HeadingCheck {
  const d: number[] = [];
  for (let i = 0; i < cog.length; i++) {
    if (sog[i] >= HDG_MIN_SOG_KN && Number.isFinite(heading[i])) d.push(Math.abs(wrap180(heading[i] - cog[i])));
  }
  if (d.length < HDG_MIN_FIXES) return { source: 'device', offDeg: null };
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  const offDeg = d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
  return { source: offDeg > HDG_BAD_DEG ? 'cog' : 'device', offDeg };
}

/** The course over ground as a heading series: each fix with no window takes the nearest earlier one's (else the next one's). */
export function cogHeading(tr: ManoeuvreTrack): Float64Array {
  const { cog } = cogSeries(tr);
  const out = Float64Array.from(cog);
  let last = NaN;
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(out[i])) out[i] = last;
    else last = out[i];
  }
  for (let i = out.length - 2; i >= 0; i--) if (Number.isNaN(out[i])) out[i] = out[i + 1];
  return out;
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

/** |TWA| clear of head-to-wind and dead downwind (false for NaN). */
function isClearTwa(a: number): boolean {
  return Math.abs(a) >= MAN_TWA_MIN && Math.abs(a) <= MAN_TWA_MAX;
}

/** Linear time where `a` at `ta` → `b` at `tb` passes 0 (the midpoint if it doesn't). */
function zeroAt(ta: number, a: number, tb: number, b: number): number {
  return a !== b && Math.sign(a) !== Math.sign(b) ? ta + (a / (a - b)) * (tb - ta) : (ta + tb) / 2;
}

/** Linear time where TWA `a` at `ta` → `b` (other side) at `tb`, turning through dead downwind, passes ±180. */
function downAt(ta: number, a: number, tb: number, b: number): number {
  const c = Math.sign(a) * 180;
  return ta + ((c - a) / (b - Math.sign(b) * 360 - a)) * (tb - ta);
}

/**
 * Tacks and gybes between `fromMs` and `toMs` (crossing times), using the
 * track from MAN_LEAD_MS before `fromMs` (to know the side held at the start)
 * and up to MAN_DWELL_MS after `toMs` (to confirm a late manoeuvre).
 */
export function detectManoeuvres(tr: ManoeuvreTrack, twdAt: (t: number) => number, fromMs: number, toMs: number, opts: DetectOptions = {}): Manoeuvre[] {
  const n = tr.t.length;
  const { cog, sog } = cogSeries(tr);
  // The device heading stands in where the course has no window, unless the compass is far off the course.
  const heading = tr.heading && (opts.headingSource ?? checkHeading(tr.heading, cog, sog).source) === 'device' ? tr.heading : null;
  const twa = new Float64Array(n).fill(NaN);
  // TWA from the (usable) device heading at every fix, clear or not: downwind evidence for the heel vote.
  const hdgTwa = new Float64Array(n).fill(NaN);
  const spd = Float64Array.from(sog);
  const all: number[] = [];
  for (let i = 0; i < n; i++) {
    if (tr.t[i] < fromMs - MAN_LEAD_MS) continue;
    if (tr.t[i] > toMs + MAN_DWELL_MS) break;
    all.push(i);
    const twd = twdAt(tr.t[i]);
    let c = cog[i];
    // The heading stands in where the course gives no clear side (no window, luffing COG, a slow window), only where it gives one.
    if (heading && Number.isFinite(heading[i])) {
      hdgTwa[i] = wrap180(twd - heading[i]);
      const s = tr.sog ? tr.sog[i] : Infinity;
      if (!(isClearTwa(wrap180(twd - c)) && sog[i] >= MAN_MIN_SOG_KN) && isClearTwa(hdgTwa[i]) && s >= MAN_MIN_SOG_KN) {
        c = heading[i];
        spd[i] = s;
      }
    }
    if (Number.isNaN(c)) continue;
    twa[i] = wrap180(twd - c);
    if (twa[i] === -180) twa[i] = 180;
  }
  // Unwrap TWA over the usable fixes (across a gap, the shortest turn).
  const idx = all.filter((i) => Number.isFinite(twa[i]));
  const t = idx.map((i) => tr.t[i]);
  const u = new Float64Array(idx.length);
  idx.forEach((i, k) => (u[k] = k ? u[k - 1] + wrap180(twa[i] - twa[idx[k - 1]]) : twa[i]));
  const clear = (k: number): number => {
    const a = Math.abs(twa[idx[k]]);
    return spd[idx[k]] >= MAN_MIN_SOG_KN && a >= MAN_TWA_MIN && a <= MAN_TWA_MAX ? Math.sign(twa[idx[k]]) : 0;
  };

  // Every manoeuvre the course sees, also outside [fromMs, toMs] (a heel flip near one is that one).
  const seen: Manoeuvre[] = [];
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
    if (s === 0 || k === runStart) continue;
    // Held long enough, or held MAN_GAP_SHORT_DWELL_MS right up to a gap: established from runStart.
    const short = t[k] - t[runStart] >= MAN_GAP_SHORT_DWELL_MS && k + 1 < idx.length && t[k + 1] - t[k] > MAN_GAP_MS;
    if (t[k] - t[runStart] < MAN_DWELL_MS && !short) continue;
    if (side !== 0 && lastOn >= 0) {
      const tacks = crossings(t, u, lastOn, runStart, 0);
      const gybes = crossings(t, u, lastOn, runStart, 180);
      // The side changed, so one kind crossed an odd number of times: that's the manoeuvre.
      let kind: Manoeuvre['kind'] = tacks.length % 2 ? 'tack' : 'gybe';
      let tMs = (kind === 'tack' ? tacks : gybes).at(-1);
      let hole = false;
      for (let j = lastOn + 1; j <= runStart; j++) if (t[j] - t[j - 1] > MAN_GAP_MS) hole = true;
      // Across a hole the shortest turn is a guess: upwind to a run (a windward-mark bear-away) or back is a gybe, never a tack.
      const a = twa[idx[lastOn]];
      const b = twa[idx[runStart]];
      if (hole && kind === 'tack' && Math.max(Math.abs(a), Math.abs(b)) >= MAN_UPWIND_DEG) {
        kind = 'gybe';
        tMs = downAt(t[lastOn], a, t[runStart], b);
      }
      if (tMs != null) seen.push(hole ? { kind, tMs, gap: true, span: [t[lastOn], t[runStart]] } : { kind, tMs, gap: false });
    }
    side = s;
    lastOn = k;
  }

  const out = tr.roll ? [...seen, ...heelTacks(tr.t, tr.roll, all, seen, twaNear)] : seen;
  return out.filter((m) => m.tMs >= fromMs && m.tMs <= toMs).sort((a, b) => a.tMs - b.tMs);

  /**
   * The TWA between `from` and `to`: the clear sample's nearest `from` (null if none), whether any is known, and
   * whether all are upwind, by the course or by the heading (even where the heading's TWA is too unclear to use).
   */
  function twaNear(from: number, to: number): TwaNear {
    const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
    const near: TwaNear = { clear: null, seen: false, upwind: true };
    let bestD = Infinity;
    for (let k = 0; k < t.length; k++) {
      if (t[k] < lo || t[k] > hi) continue;
      near.seen = true;
      if (Math.abs(twa[idx[k]]) >= MAN_UPWIND_DEG) near.upwind = false;
      if (clear(k) && Math.abs(t[k] - from) < bestD) [near.clear, bestD] = [twa[idx[k]], Math.abs(t[k] - from)];
    }
    for (const i of all) if (tr.t[i] >= lo && tr.t[i] <= hi && Math.abs(hdgTwa[i]) >= MAN_UPWIND_DEG) near.upwind = false;
    return near;
  }
}

interface TwaNear {
  clear: number | null;
  seen: boolean;
  upwind: boolean;
}

/**
 * Heel-vote tacks: flips of heel side (|roll| ≥ MAN_HEEL_ROLL_DEG, held MAN_HEEL_DWELL_MS, or for
 * MAN_HEEL_GAP_FIXES fixes straight after a telemetry gap), upwind both sides, that the course missed.
 * `fixes` are the track indices in the window; `seen` the course's manoeuvres; `twaNear(from, to)` the
 * TWA from `from` towards `to`.
 */
function heelTacks(
  T: ArrayLike<number>,
  roll: ArrayLike<number>,
  fixes: number[],
  seen: Manoeuvre[],
  twaNear: (from: number, to: number) => TwaNear,
): Manoeuvre[] {
  const j = fixes.filter((i) => Number.isFinite(roll[i]));
  const hs = (q: number): number => (Math.abs(roll[j[q]]) >= MAN_HEEL_ROLL_DEG ? Math.sign(roll[j[q]]) : 0);
  const out: Manoeuvre[] = [];
  let side = 0;
  let lastOn = -1;
  let runSide = 0;
  let runStart = -1;
  for (let q = 0; q < j.length; q++) {
    const s = hs(q);
    if (s === 0 || s !== runSide) {
      runSide = s;
      runStart = s ? q : -1;
    }
    if (s !== 0 && s === side) {
      lastOn = q;
      continue;
    }
    if (s === 0) continue;
    let hole = false;
    for (let p = Math.max(lastOn, 0) + 1; lastOn >= 0 && p <= runStart; p++) if (T[j[p]] - T[j[p - 1]] > MAN_GAP_MS) hole = true;
    // Held MAN_HEEL_DWELL_MS, or after a gap MAN_HEEL_GAP_FIXES fixes: one heeled fix out of a hole is no side.
    if (T[j[q]] - T[j[runStart]] < MAN_HEEL_DWELL_MS && !(hole && q - runStart + 1 >= MAN_HEEL_GAP_FIXES)) continue;
    if (side !== 0 && lastOn >= 0) {
      const tA = T[j[lastOn]];
      const tB = T[j[runStart]];
      // Heeled to port (−) ≈ starboard tack (TWA +) upwind: the TWA both sides must be upwind, a clear one that side.
      const before = twaNear(tA, tA - MAN_HEEL_TWA_MS);
      const after = twaNear(tB, tB + MAN_HEEL_TWA_MS);
      const agrees = (a: TwaNear, h: number): boolean => a.upwind && (a.clear == null || Math.sign(a.clear) === -h);
      // A tack or gybe the course counted here is that turn: at it, or across a hole overlapping it (a fix
      // with too unclear a TWA for the course can still carry heel, so the course may time it well before).
      const counted = seen.some((m) => {
        const [lo, hi] = m.span ?? [m.tMs, m.tMs];
        return hi >= tA - MAN_HEEL_MERGE_MS && lo <= tB + MAN_HEEL_MERGE_MS;
      });
      // Only where the course is blind to it (across a gap, or no TWA at all one side), and sees it one side.
      const blind = hole || !before.seen || !after.seen;
      if (!counted && blind && (before.clear != null || after.clear != null) && agrees(before, side) && agrees(after, s)) {
        out.push({ kind: 'tack', tMs: zeroAt(tA, roll[j[lastOn]], tB, roll[j[runStart]]), gap: true, span: [tA, tB] });
      }
    }
    side = s;
    lastOn = q;
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
    // Crossing times are inclusive at `toMs` (often the last mark a DNF reached, or the finish).
    // Half-open intervals would drop those; put them on the last interval that actually exists.
    if (li < 0) {
      for (let i = kinds.length - 1; i >= 0; i--) {
        if (out[i] && m.tMs === bounds[i + 1]) {
          li = i;
          break;
        }
      }
    }
    if (li < 0 || !out[li]) continue;
    if (!suits(m, li)) {
      // Across a gap the turn may have been anywhere in it: measure from its ends.
      const [lo, hi] = m.span ?? [m.tMs, m.tMs];
      if (li > 0 && lo - bounds[li]! <= MAN_ROUNDING_MS && out[li - 1] && suits(m, li - 1)) li--;
      else if (li < kinds.length - 1 && bounds[li + 1]! - hi <= MAN_ROUNDING_MS && out[li + 1] && suits(m, li + 1)) li++;
    }
    const c = out[li]!;
    if (m.kind === 'tack') c.tacks++;
    else c.gybes++;
    if (m.gap) c.gap = true;
  }
  return out;
}
