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
 * most it reached between the first crossing and going back.
 */
import type { RaceData } from '../data/types';
import { CROSS_FROM_MS, CROSS_TO_MS, startCrossings } from './coach';
import type { CoachCtx } from './coach/detectors/context';
import { FRONT_EARLY_MS, startOrder } from './coach/detectors/start';
import { projectCoachTrack } from './coach/tracks';
import { bearingVec, dot, len, sub, type Vec } from './geo';
import { raceProjection } from './prepare';
import { startCross, type StartCross } from './startCross';
import type { RaceAnalysis } from './types';

export interface StartReplay {
  boat: string;
  gunMs: number;
  /** Flagged over at the gun (StartResult.over: the feed's OCS or Recall's own). */
  flagged: boolean;
  /** Over at the gun by its own track (startCross `early`). */
  early: boolean;
  /** The first crossing onto the course side (the bow), ms. */
  firstCrossMs: number;
  /** Back on the pre-start side after the gun, ms; null: never in the window. */
  wentBackMs: number | null;
  /** The final crossing that cleared it (the bow), ms: the over-early card's crossing; null: never cleared in the window. */
  clearedMs: number | null;
  /** The furthest the bow got over the line between the first crossing and going back, m, and when; null with no fix in that stretch. */
  maxOverM: number | null;
  maxOverAtMs: number | null;
  /** Its clearing − the front-row median, s (D1's seconds, ≥ 0); null without a front row or a clearing. */
  lostS: number | null;
}

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
 * nor over at the gun, or no crossing found). `crossMs`: the Coach's start crossings (startCrossings),
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
  if (sc.firstCrossMs == null || !(flagged || overByTrack(sc, gun))) return null;
  const overTo = sc.wentBackMs;
  let maxOverM: number | null = null;
  let maxOverAtMs: number | null = null;
  if (overTo != null) {
    for (let i = 0; i < tr.t.length; i++) {
      const t = tr.t[i];
      if (t < sc.firstCrossMs) continue;
      if (t > overTo) break;
      const d = dot(sub([tr.x[i], tr.y[i]], left), side);
      // The bow along the heading (as StartResult's DTL); no heading: along the way it is going.
      const h = b.track.heading[i];
      let fwd: Vec | null = Number.isFinite(h) ? bearingVec(h) : null;
      if (!fwd && i + 1 < tr.t.length) {
        const v = sub([tr.x[i + 1], tr.y[i + 1]], [tr.x[i], tr.y[i]]);
        const l = len(v);
        fwd = l > 0 ? [v[0] / l, v[1] / l] : null;
      }
      const bow = d + (fwd ? b.bowOffsetM * dot(fwd, side) : 0);
      if (maxOverM == null || bow > maxOverM) {
        maxOverM = bow;
        maxOverAtMs = t;
      }
    }
  }
  const front = frontMedian(a, crossMs ?? startCrossings(a, data));
  const lostS = front != null && sc.clearedMs != null ? Math.max(0, (sc.clearedMs - front) / 1000) : null;
  return {
    boat: boatId,
    gunMs: gun,
    flagged,
    early: sc.early,
    firstCrossMs: sc.firstCrossMs,
    wentBackMs: sc.wentBackMs,
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
