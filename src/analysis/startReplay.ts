/**
 * The facts of an over-early start for the track map's "Replay start" (Map C): when the boat first
 * crossed, how far over it got, when it went back, when it cleared, and what that cost against the
 * front row. Keyed on the boat's track and its flag, never on a Coach card: a boat qualifies when it is
 * flagged over at the gun (StartResult.over, what D1's 'ocs' variant reads) or its own track has it over
 * at the gun (startCross `early`, crossed before D1's clean-start tolerance, and went back: overByTrack).
 *
 * Worked out in the worker from the raw fixes, exactly as the Coach's start crossings are
 * (coach/index.ts startCrossings: the same projection, course side, bow offset and window, the same
 * startCross call), so "cleared" is the over-early card's crossing, and the seconds lost are D1's
 * (its crossing − the front-row median, coach/detectors/start.ts startOrder).
 *
 * Conventions, as startCross and StartResult: sides and the over stretch by the antenna's side of the
 * line, crossing times at the bow (`bowM ÷ speed` ahead); the distance over is the bow's (the antenna's
 * course-side distance plus the bow offset along the heading, as StartResult.dtlM places the bow), the
 * most it reached while over (to going back, else to the gun), interpolated between fixes.
 *
 * A flagged boat always gets its facts: already over when the window opens (no first crossing in it, or no
 * fixes before the gun), its over stretch starts there; its track on the pre-start side at the gun (the
 * flag and the track disagree), no over stretch, and the label says so. Never back: the stretch stops
 * OVER_HORIZON_MS after the gun, so the replay never paints the rest of the race.
 */
import type { RaceData } from '../data/types';
import { CROSS_FROM_MS, CROSS_TO_MS, startCrossings } from './coach';
import type { CoachCtx } from './coach/detectors/context';
import { FRONT_EARLY_MS, startOrder } from './coach/detectors/start';
import { projectCoachTrack } from './coach/tracks';
import { COVERAGE_GAP_S } from './coverage';
import { bearingVec, bisectRight, dot, interpAngle, len, sub, type Vec } from './geo';
import { raceProjection } from './prepare';
import { startCross, type StartCross } from './startCross';
import type { RaceAnalysis } from './types';
import { startDtlM } from './validity';

export interface StartReplay {
  boat: string;
  gunMs: number;
  /** Flagged over at the gun (StartResult.over: the feed's OCS or Recall's own). */
  flagged: boolean;
  /** Over at the gun by its own track (startCross `early`). */
  early: boolean;
  /** The first crossing onto the course side in the window (the bow; startCross's), ms; null with none. */
  firstCrossMs: number | null;
  /**
   * The stretch it was over the line by its own track (the antenna on the course side), ms: from its first
   * crossing (early), or when it last came onto the course side before the gun (else the window's opening:
   * it was already over then), to going back, else at most OVER_HORIZON_MS after the gun (or its clearing,
   * if sooner); null: its track has it on the pre-start side at the gun (flagged, the track disagrees).
   */
  over: [number, number] | null;
  /** Back on the pre-start side after the gun, ms; null: never in the window. */
  wentBackMs: number | null;
  /** The final crossing that cleared it (the bow), ms: the over-early card's crossing; null: never cleared in the window. */
  clearedMs: number | null;
  /**
   * The furthest the bow got over the line, m, and when: over `over` up to going back (never back: up to
   * the gun), read at its fixes and interpolated at the stretch's ends and the gun, and never less than
   * the start's DTL over; with no `over`, the bow's at the gun if over. Null when the bow was never over.
   */
  maxOverM: number | null;
  maxOverAtMs: number | null;
  /** Its clearing − the front-row median, s (D1's seconds, ≥ 0); null without a front row or a clearing. */
  lostS: number | null;
}

/** A boat that never went back is drawn over the line for at most this long after the gun, ms (never the whole race). */
export const OVER_HORIZON_MS = 60_000;

/** The course side of the start line: the unit normal toward the first mark (as startCrossings). */
function courseSide(a: RaceAnalysis): Vec | null {
  const first = a.legPts?.[1];
  if (!first) return null;
  const { left, right } = a.line;
  const along = sub(right, left);
  const L = len(along);
  if (!(L > 0)) return null;
  const n: Vec = [-along[1] / L, along[0] / L];
  return dot(sub(first, left), n) < 0 ? [-n[0], -n[1]] : n;
}

/**
 * Over at the gun by its own track, not flagged: startCross `early`, with its crossing earlier than D1 counts a
 * clean start (FRONT_EARLY_MS: a bow a second over at the gun is front row, inside the GPS's error), and back
 * after the gun to clear it (a boat that never went back was not recovering; the start chart shows it).
 */
const overByTrack = (sc: StartCross, gun: number): boolean =>
  sc.early && sc.firstCrossMs != null && sc.firstCrossMs < gun - FRONT_EARLY_MS && sc.wentBackMs != null;

/** D1's front-row median crossing for these crossings (startOrder reads only the crossings, the boats' flags and the gun); null with too few. */
function frontMedian(a: RaceAnalysis, crossMs: Record<string, number | null>): number | null {
  const ctx = { a, gun: a.meta.gunMs, m: { crossMs } } as unknown as CoachCtx;
  return startOrder(ctx)?.frontMedMs ?? null;
}

/**
 * Boat `boatId`'s replay facts from the race's raw fixes, or null when it doesn't qualify (not flagged
 * nor over at the gun by its track, or fewer than two fixes). `crossMs`: the Coach's start crossings (startCrossings),
 * worked out here when not given.
 */
export function startReplay(a: RaceAnalysis, data: RaceData, boatId: string, crossMs?: Record<string, number | null>): StartReplay | null {
  const r = a.boats.find((b) => b.id === boatId);
  const b = data.boats.find((x) => x.id === boatId);
  const side = courseSide(a);
  if (!r || !b || !side) return null;
  const gun = a.meta.gunMs;
  const { left, right } = a.line;
  const tr = projectCoachTrack(b.track, raceProjection(data));
  const sc = startCross(tr, left, right, side, gun, { bowM: b.bowOffsetM, fromMs: gun - CROSS_FROM_MS, toMs: gun + CROSS_TO_MS });
  const flagged = !!r.start?.over;
  if (!(flagged || overByTrack(sc, gun))) return null;
  const n = tr.t.length;
  if (n < 2) return null;
  const from = gun - CROSS_FROM_MS;
  const to = gun + CROSS_TO_MS;
  /** The antenna's course-side distance, m (> 0: over), at fix i. */
  const dAt = (i: number): number => dot(sub([tr.x[i], tr.y[i]], left), side);
  /** The fix before time t and the share of the way to the next; null outside the track. */
  const segAt = (t: number): { i: number; f: number } | null => {
    if (t < tr.t[0] || t > tr.t[n - 1]) return null;
    const i = Math.min(n - 2, Math.max(0, bisectRight(tr.t, t)));
    const dt = tr.t[i + 1] - tr.t[i];
    return { i, f: dt > 0 ? (t - tr.t[i]) / dt : 0 };
  };
  /** The antenna's course-side distance at time t, m: interpolated between the fixes either side. */
  const antennaAt = (t: number): number | null => {
    const s = segAt(t);
    return s && dAt(s.i) + s.f * (dAt(s.i + 1) - dAt(s.i));
  };
  /** The bow's course-side distance at time t, m. */
  const bowAt = (t: number): number | null => {
    const s = segAt(t);
    if (!s) return null;
    const { i } = s;
    const d = antennaAt(t)!;
    // The bow along the heading (as StartResult's DTL); no heading: along the way it is going.
    const h = interpAngle(tr.t, b.track.heading, t);
    let fwd: Vec | null = Number.isFinite(h) ? bearingVec(h) : null;
    if (!fwd) {
      const v = sub([tr.x[i + 1], tr.y[i + 1]], [tr.x[i], tr.y[i]]);
      const l = len(v);
      fwd = l > 0 ? [v[0] / l, v[1] / l] : null;
    }
    return d + (fwd ? b.bowOffsetM * dot(fwd, side) : 0);
  };
  // No fixes before the gun: its side at its first fix in the window.
  const overAtGun = sc.early || (antennaAt(gun) ?? (gun < tr.t[0] && tr.t[0] <= to ? dAt(0) : 0)) > 0;
  // Over at the gun by its track: from the first crossing (early), else from when it last came onto the course side
  // before the gun (round an end, in a hole) or the window's opening; back: the first timed return at or after the gun.
  let overFrom: number | null = null;
  let wentBackMs = sc.wentBackMs;
  if (sc.early) overFrom = sc.firstCrossMs;
  else if (overAtGun) {
    overFrom = Math.max(from, tr.t[0]);
    wentBackMs = null;
    for (let i = 1; i < n; i++) {
      if (tr.t[i] < from) continue;
      if (tr.t[i - 1] > to) break;
      const da = dAt(i - 1);
      const db = dAt(i);
      if ((da > 0) === (db > 0)) continue;
      const dt = tr.t[i] - tr.t[i - 1];
      const t = tr.t[i - 1] + (da === db ? 0 : -da / (db - da)) * dt;
      if (db > 0 && t <= gun) overFrom = Math.max(overFrom, t);
      else if (db <= 0 && t >= gun && dt <= COVERAGE_GAP_S * 1000) {
        wentBackMs = t;
        break;
      }
    }
  }
  const over: [number, number] | null =
    overFrom == null ? null : [overFrom, wentBackMs ?? Math.max(overFrom, Math.min(gun + OVER_HORIZON_MS, sc.clearedMs ?? Infinity))];
  // The furthest over: at the fixes inside the stretch (to going back, else to the gun), its ends and the gun; at least the start's DTL over.
  let maxOverM: number | null = null;
  let maxOverAtMs: number | null = null;
  const consider = (t: number, m: number | null): void => {
    if (m != null && m > 0 && (maxOverM == null || m > maxOverM)) {
      maxOverM = m;
      maxOverAtMs = t;
    }
  };
  const [m0, m1] = over ? [over[0], wentBackMs ?? Math.max(over[0], gun)] : [gun, gun];
  consider(m0, bowAt(m0));
  for (let i = 0; i < n && tr.t[i] < m1; i++) if (tr.t[i] > m0) consider(tr.t[i], bowAt(tr.t[i]));
  consider(m1, bowAt(m1));
  if (gun >= m0 && gun <= m1) consider(gun, bowAt(gun));
  const dtl = r.start ? startDtlM(r.start) : null;
  if (dtl != null && Number.isFinite(dtl)) consider(gun - (data.dtlSampleOffsetMs ?? 0), -dtl);
  const front = frontMedian(a, crossMs ?? startCrossings(a, data));
  const lostS = front != null && sc.clearedMs != null ? Math.max(0, (sc.clearedMs - front) / 1000) : null;
  return {
    boat: boatId,
    gunMs: gun,
    flagged,
    early: sc.early,
    firstCrossMs: sc.firstCrossMs,
    over,
    wentBackMs,
    clearedMs: sc.clearedMs,
    maxOverM,
    maxOverAtMs,
    lostS,
  };
}

/** Every racing boat's replay facts, for those that qualify (the worker's 'start-replay'). */
export function startReplays(a: RaceAnalysis, data: RaceData): StartReplay[] {
  const crossMs = startCrossings(a, data);
  return a.boats.map((b) => startReplay(a, data, b.id, crossMs)).filter((r): r is StartReplay => r != null);
}
