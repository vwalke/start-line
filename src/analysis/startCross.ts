/**
 * A boat's start-line crossings around the gun, for an over-early (OCS) start and its recross
 * (recall-zoom-ocs.py's measure, on the app's own track and line): the first crossing onto the course
 * side, whether that was before the gun with the boat still over at the gun, when it went back to the
 * pre-start side after being over, and the final crossing that cleared it.
 *
 * Sides are the antenna's, by its signed distance from the (infinite) line along `courseSide`: a boat
 * coming back round an end is back on the pre-start side. A crossing onto the course side counts only
 * between the ends (± slack) and, as lineCrossing does, at the bow: `bowM ÷ speed` before the antenna.
 * A side change inside a hole (fixes over `maxSpanS` apart) has no time: it moves the side, never sets
 * a crossing.
 */
import { dot, len, sub, type Vec } from './geo';
import { COVERAGE_GAP_S } from './coverage';
import { BOW_MIN_SPEED_MS, type LineCrossOptions } from './coach/lineCross';

export interface StartCross {
  /** The first crossing onto the course side from `fromMs` (the bow), ms; null with none. */
  firstCrossMs: number | null;
  /** The first return to the pre-start side at or after the gun, having been over (early, or dipped back after starting), ms. */
  wentBackMs: number | null;
  /** The final crossing from the pre-start side onto the course side, at or after the gun (the bow), ms; null: never cleared in the window. */
  clearedMs: number | null;
  /** Crossed before the gun and still over at the gun. */
  early: boolean;
}

export interface StartCrossOptions extends LineCrossOptions {
  /** Look from (default the gun − 30 s) … */
  fromMs?: number;
  /** … to (default the gun + 5 min), ms. */
  toMs?: number;
}

export function startCross(
  tr: { t: ArrayLike<number>; x: ArrayLike<number>; y: ArrayLike<number> },
  left: Vec,
  right: Vec,
  /** Unit normal pointing to the course side. */
  courseSide: Vec,
  gunMs: number,
  opts: StartCrossOptions = {},
): StartCross {
  const { bowM = 0, slackM = 10, maxSpanS = COVERAGE_GAP_S, fromMs = gunMs - 30_000, toMs = gunMs + 5 * 60_000 } = opts;
  const none: StartCross = { firstCrossMs: null, wentBackMs: null, clearedMs: null, early: false };
  const along = sub(right, left);
  const L = len(along);
  if (!(L > 0)) return none;
  const dir: Vec = [along[0] / L, along[1] / L];
  // Side changes in the window: onto the course side (+1, the bow's time when timed and between the ends) or back (−1).
  const ev: { dir: 1 | -1; tMs: number | null }[] = [];
  for (let i = 1; i < tr.t.length; i++) {
    if (tr.t[i] < fromMs) continue;
    if (tr.t[i - 1] > toMs) break;
    const a: Vec = [tr.x[i - 1], tr.y[i - 1]];
    const b: Vec = [tr.x[i], tr.y[i]];
    const da = dot(sub(a, left), courseSide);
    const db = dot(sub(b, left), courseSide);
    const up = da <= 0 && db > 0;
    if (!up && !(da > 0 && db <= 0)) continue;
    const dt = tr.t[i] - tr.t[i - 1];
    const f = da === db ? 0 : -da / (db - da);
    const t = tr.t[i - 1] + f * dt;
    const timed = dt <= maxSpanS * 1000 && t >= fromMs && t <= toMs;
    if (!up) {
      ev.push({ dir: -1, tMs: timed ? t : null });
      continue;
    }
    const p: Vec = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
    const s = dot(sub(p, left), dir);
    const v = dt > 0 ? len(sub(b, a)) / (dt / 1000) : 0;
    const bow = t - (bowM / Math.max(BOW_MIN_SPEED_MS, v)) * 1000;
    ev.push({ dir: 1, tMs: timed && s >= -slackM && s <= L + slackM ? bow : null });
  }
  const firstCrossMs = ev.find((e) => e.dir === 1 && e.tMs != null)?.tMs ?? null;
  if (firstCrossMs == null) return none;
  const firstIdx = ev.findIndex((e) => e.tMs === firstCrossMs);
  const after = ev.slice(firstIdx + 1);
  // Over at the gun: no return between that crossing and the gun (a return in a hole counts by its fixes).
  const early = firstCrossMs < gunMs && !after.some((e) => e.dir === -1 && (e.tMs == null || e.tMs <= gunMs));
  const wentBackMs = after.find((e) => e.dir === -1 && e.tMs != null && e.tMs >= gunMs)?.tMs ?? null;
  // The final clearing: the first timed crossing onto the course side after the last return (none: from the start).
  let lastBack = -1;
  ev.forEach((e, i) => {
    if (e.dir === -1) lastBack = i;
  });
  const clear = ev.slice(lastBack + 1).find((e) => e.dir === 1 && e.tMs != null);
  const clearedMs = clear && clear.tMs! >= gunMs ? clear.tMs : null;
  return { firstCrossMs, wentBackMs, clearedMs, early };
}
