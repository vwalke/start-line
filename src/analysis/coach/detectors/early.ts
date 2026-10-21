/**
 * D3 · Early lane / tack cost (spec §3), line crossing → +5 min. Tacks
 * (detectManoeuvres) against the fleet's median in its own first minutes, and
 * the change in gap to the leaders (the finish top 3) over the window. Fires
 * on D3_MIN_TACKS+ tacks before +4 min while the fleet median is at most
 * D3_FLEET_MAX, or on a gap change of D3_GAP_S or more. Seconds = that gap
 * change. It starts at the crossing, where D1 ends, so nothing is claimed twice; when D1 fired too, the two
 * are one start card (debrief.ts mergeStart).
 * D2 rides on it as a chip and turns it into "Slow off a great start".
 */
import { bearingVec, dot, median, sub, type Vec } from '../../geo';
import { detectManoeuvres } from '../../manoeuvres';
import { posAt, type CoachTrack } from '../tracks';
import {
  WIND_EST_S,
  coachCoverage,
  gapChange,
  gapNoise,
  rangeOf,
  refCoverage,
  untrackedS,
  windOkShare,
  type AttachedChip,
  type Opportunity,
} from '../opportunity';
import type { CoachCtx } from './context';

export const D3_WINDOW_MS = 5 * 60_000;
export const D3_TACK_BY_MS = 4 * 60_000;
export const D3_MIN_TACKS = 2;
export const D3_FLEET_MAX = 1;
export const D3_GAP_S = 15;

/** Tacks within D3_TACK_BY_MS of `fromMs`, their times. */
export const earlyTacks = (tr: CoachTrack, twdAt: (t: number) => number, fromMs: number): number[] =>
  detectManoeuvres(tr, twdAt, fromMs, fromMs + D3_TACK_BY_MS)
    .filter((m) => m.kind === 'tack')
    .map((m) => m.tMs);

/** The boat's distance across the wind from the median position of `ids` at `t`, m; null with no positions. */
export function lateralSep(ctx: CoachCtx, ids: string[], t: number): number | null {
  const p = posAt(ctx.tr, t);
  if (!p) return null;
  const q = ids.map((id) => ctx.m.tracks.get(id)).map((tr) => (tr ? posAt(tr, t) : null)).filter((x): x is Vec => !!x);
  if (!q.length) return null;
  const across = bearingVec(ctx.m.wind.twdAt(t) + 90);
  return Math.abs(dot(sub(p, [median(q.map((v) => v[0])), median(q.map((v) => v[1]))]), across));
}

/**
 * Typical across-wind separation in a window: the median of the start, mid and
 * end reads. The end-of-window spread (boats on opposite sides of the beat)
 * must not inflate the ±3° wind-error term on a start / early-lane Δgap, where
 * the boats were still close.
 */
export function typicalSep(ctx: CoachCtx, ids: string[], t0: number, t1: number): number {
  const seps = [t0, (t0 + t1) / 2, t1].map((t) => lateralSep(ctx, ids, t)).filter((x): x is number => x != null);
  return seps.length ? median(seps) : 0;
}

export function detectEarly(ctx: CoachCtx, start: { crossMs: number | null; d1Fired: boolean }, rolled: AttachedChip | null): Opportunity | null {
  const t0 = start.crossMs ?? ctx.gun + Math.max(0, ctx.me.start?.lateS ?? 0) * 1000;
  const t1 = t0 + D3_WINDOW_MS;
  const refs = ctx.leaders;
  if (!refs.length) return null;
  const pts = ctx.gaps(refs, t0, t1);
  const dg = gapChange(pts, t0, t1);
  if (!dg) return null;
  const dgap = dg.g1 - dg.g0;
  const tacks = earlyTacks(ctx.tr, ctx.m.wind.twdAt, t0);
  const fleet: number[] = [];
  for (const b of ctx.a.boats) {
    if (b.id === ctx.boat) continue;
    const tr = ctx.m.tracks.get(b.id);
    if (!tr || coachCoverage(tr.t, ctx.gun, ctx.gun + D3_WINDOW_MS) < 0.5) continue;
    fleet.push(earlyTacks(tr, ctx.m.wind.twdAt, ctx.m.crossMs?.[b.id] ?? ctx.gun).length);
  }
  const fleetTacks = fleet.length ? median(fleet) : 0;
  const tackRule = tacks.length >= D3_MIN_TACKS && fleetTacks <= D3_FLEET_MAX;
  if (!tackRule && dgap < D3_GAP_S) return null;
  const cov = coachCoverage(ctx.tr.t, t0, t1);
  const sep = typicalSep(ctx, refs, dg.t0, dg.t1);
  const { noise, windS } = gapNoise(sep, ctx.m.vmg[0], untrackedS(ctx.tr.t, t0, t1));
  const seconds = Math.max(0, dgap);
  const variant = rolled && !start.d1Fired ? 'slow-start' : tacks.length >= D3_MIN_TACKS ? 'tacks' : 'lane';
  const refTracks = refs.map((id) => ctx.m.tracks.get(id)).filter((x): x is CoachTrack => !!x);
  return {
    kind: 'D3',
    variant,
    t0,
    t1,
    seconds,
    ...rangeOf(seconds, noise),
    confidence: 'high',
    coverage: cov,
    conf: { boatCov: cov, refs: refCoverage(refTracks, t0, t1), windOk: windOkShare(ctx.m.wind, t0, t1) },
    facts: {
      dgap,
      gapEnd: dg.g1,
      tacks: tacks.length,
      lastTackS: tacks.length ? (tacks[tacks.length - 1] - ctx.gun) / 1000 : null,
      fleetTacks,
      sog: ctx.me.start?.speedKn ?? null,
      dtl: ctx.me.start?.dtlM ?? null,
      sepM: sep,
    },
    refBoats: refs,
    chips: rolled ? [rolled] : undefined,
    windEst: windS >= WIND_EST_S,
  };
}
