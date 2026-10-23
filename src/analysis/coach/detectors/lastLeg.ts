/**
 * D10 · Last-leg pressure (spec §3). On the last leg from when the boat left the last rounding's zone (timeGap.ts
 * zoneExitMs: the rounding is D9's, and inside the zone the chart is linear in time by construction) — or, when the
 * finish falls in a hole, the last D10_TRACKED_MS of track on it — the change in gap
 * to the boats that finished 1–2 places ahead, and the boat's speed against
 * the leaders'. Fires when some of them pulled D10_GAP_S or more further ahead
 * and finished under D10_AHEAD_S ahead. Seconds: the median over those boats,
 * the range from the least to the most. Each boat's change is its own (thin) line on the chart (ctx.gaps `each`).
 */
import { MS_TO_KN, median } from '../../geo';
import { finishRank } from '../../result';
import { COVERAGE_GAP_S } from '../../coverage';
import { COACH_MAX_SPAN_S, trackLegAt, type CoachTrack } from '../tracks';
import { zoneExitMs } from '../timeGap';
import { NOISE_BASE_S, coachCoverage, gapChange, reading, refCoverage, windOkShare, type GapReading, type Opportunity } from '../opportunity';
import type { CoachCtx } from './context';

export const D10_TRACKED_MS = 6 * 60_000;
export const D10_PLACES = 2;
export const D10_GAP_S = 10;
export const D10_AHEAD_S = 60;

/** Mean SOG over [a, b] from the track (fix to fix, never across a hole), kn; null with too little. */
export function meanSogKn(tr: Pick<CoachTrack, 't' | 'x' | 'y'>, a: number, b: number): number | null {
  let d = 0;
  let s = 0;
  for (let i = 1; i < tr.t.length; i++) {
    if (tr.t[i - 1] < a || tr.t[i] > b) continue;
    const dt = tr.t[i] - tr.t[i - 1];
    if (dt > COACH_MAX_SPAN_S * 1000 || dt <= 0) continue;
    d += Math.hypot(tr.x[i] - tr.x[i - 1], tr.y[i] - tr.y[i - 1]);
    s += dt / 1000;
  }
  return s >= 30 ? (d / s) * MS_TO_KN : null;
}

/** When the boat is first known to be on leg `leg`, ms; null if never. */
function legStart(tr: CoachTrack, leg: number): number | null {
  if (tr.bounds[leg] != null) return tr.bounds[leg];
  const s = tr.spans?.filter((x) => x.leg === leg).map((x) => x.fromMs) ?? [];
  return s.length ? Math.min(...s) : null;
}

export function detectLastLeg(ctx: CoachCtx): Opportunity | null {
  const n = ctx.a.legs.length;
  const last = n - 1;
  // The finish on the water (a boat that finished with a code, DPI …, at its on-water place).
  const p = finishRank(ctx.me);
  const fin = ctx.me.finishMs;
  const tr = ctx.tr;
  if (p == null || fin == null || n < 1 || !tr.t.length) return null;
  const legFrom = legStart(tr, last);
  if (legFrom == null) return null;
  // Past the rounding zone: the leg, not the rounding (its record ROUNDING_OUT_M down the leg on the chart).
  const out = zoneExitMs(ctx.m, ctx.boat, last);
  const from = out != null && out > legFrom ? out : legFrom;
  const lastFix = tr.t[tr.t.length - 1];
  const inGap = fin - Math.min(lastFix, fin) > COVERAGE_GAP_S * 1000;
  const end = Math.min(lastFix, fin);
  const t0 = inGap ? Math.max(from, end - D10_TRACKED_MS) : from;
  const t1 = end;
  if (!(t1 > t0) || trackLegAt(tr, t1) !== last) return null;
  const refs = ctx.a.boats
    // Tracked only: the gap series lists those (its `each`, in this order).
    .filter((b) => b.id !== ctx.boat && b.finishMs != null && finishRank(b) != null && finishRank(b)! < p && finishRank(b)! >= p - D10_PLACES && ctx.m.tracks.has(b.id))
    .sort((x, y) => finishRank(x)! - finishRank(y)!);
  if (!refs.length) return null;
  const ids = refs.map((r) => r.id);
  const pts = ctx.gaps(ids, t0, t1);
  const gaps: GapReading[] = [];
  const each = refs.map((r, k) => {
    const g = gapChange(pts, t0, t1, (q) => q.each[k]);
    if (g) gaps.push(reading(ids, g, r.id));
    return { id: r.id, d: g ? g.g1 - g.g0 : null, behindAtStart: g != null && g.g0 < 0, aheadS: (fin - r.finishMs!) / 1000, place: finishRank(r)! };
  });
  const read = each.filter((e): e is typeof e & { d: number } => e.d != null);
  if (!read.length) return null;
  if (!read.some((e) => e.d >= D10_GAP_S && e.aheadS < D10_AHEAD_S)) return null;
  const ds = read.map((e) => e.d);
  const seconds = Math.max(0, median(ds));
  const lo = Math.max(0, Math.min(...ds));
  const hi = Math.max(...ds);
  const byLoss = [...read].sort((x, y) => y.d - x.d);
  const leaders = ctx.leaders.map((id) => ctx.m.tracks.get(id)).filter((x): x is CoachTrack => !!x);
  const ldrSogs = leaders.map((l) => meanSogKn(l, t0, t1)).filter((x): x is number => x != null);
  const cov = coachCoverage(tr.t, t0, t1);
  const refTracks = refs.map((r) => ctx.m.tracks.get(r.id)).filter((x): x is CoachTrack => !!x);
  return {
    kind: 'D10',
    variant: ctx.a.legs[last].kind === 'upwind' ? 'beat' : 'run',
    t0,
    t1,
    seconds,
    secondsLo: read.length > 1 ? lo : Math.max(0, seconds - NOISE_BASE_S),
    secondsHi: read.length > 1 ? hi : seconds + NOISE_BASE_S,
    confidence: 'high',
    coverage: cov,
    conf: { boatCov: cov, refs: refCoverage(refTracks, t0, t1), windOk: windOkShare(ctx.m.wind, t0, t1), marksEstimated: ctx.marksEstimated },
    facts: {
      a: ctx.nameOf(byLoss[0].id),
      da: byLoss[0].d,
      b: byLoss[1] ? ctx.nameOf(byLoss[1].id) : null,
      db: byLoss[1]?.d ?? null,
      // Each of those two: behind the boat when the window starts (it caught up and passed: not "further ahead"), 1 / 0.
      aFromBehind: byLoss[0].behindAtStart ? 1 : 0,
      bFromBehind: byLoss[1] ? (byLoss[1].behindAtStart ? 1 : 0) : null,
      mins: (t1 - t0) / 60_000,
      sog: meanSogKn(tr, t0, t1),
      ldrSog: ldrSogs.length ? median(ldrSogs) : null,
      aheadLo: Math.min(...read.map((e) => e.aheadS)),
      aheadHi: Math.max(...read.map((e) => e.aheadS)),
      placeLo: Math.min(...read.map((e) => e.place)),
      placeHi: Math.max(...read.map((e) => e.place)),
      inGap: inGap ? 1 : 0,
    },
    refBoats: ids,
    gaps,
  };
}
