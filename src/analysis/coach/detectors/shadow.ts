/**
 * D8 · Dirty air (spec §3, shadow.py), the first D8_WINDOW_MS of each beat. A boat is in another's
 * shadow when it sits D8_DIST_LOA[0]–D8_DIST_LOA[1] lengths from it and within ±D8_HALF_DEG of its
 * plume: the line downwind of it, swung toward its stern (the air leaves along the apparent wind) by
 * half its angle to the wind, at most D8_ROT_MAX_DEG.
 *
 * - Positions come from a shared grid (every D8_STEP_MS from the gun): a boat's position is read only
 *   between fixes at most D8_SPAN_S apart (short gaps only; never across a hole), its course from
 *   positions D8_COG_MS either side.
 * - A grid moment counts only when D8_MIN_DENSITY of the boats racing then have a position (the
 *   shadow can't be judged from a few boats); the boat needs D8_MIN_EVAL of its moments counted, and
 *   the fleet median needs D8_MIN_FLEET boats measured that well, else D8 isn't evaluated.
 * - Fires when the boat's share in shadow is ≥ D8_FLEET_X × the fleet's median and ≥ D8_MIN_SHARE.
 *   Seconds: the change in gap to the leaders over the shadowed stretches. Ranked alone only from
 *   D8_ALONE_S; otherwise a chip on D3 (spec §5).
 */
import { median, vecBearing, wrap180, type Vec } from '../../geo';
import type { CoachModel } from '../index';
import { posAt } from '../tracks';
import { WIND_EST_S, coachCoverage, gapNoise, rangeOf, refCoverage, untrackedS, windOkShare, type AttachedChip, type Opportunity } from '../opportunity';
import type { CoachCtx } from './context';
import { typicalSep } from './early';

export const D8_WINDOW_MS = 6 * 60_000;
export const D8_STEP_MS = 5_000;
export const D8_DIST_LOA: [number, number] = [0.5, 7];
export const D8_HALF_DEG = 22;
export const D8_ROT_MAX_DEG = 20;
export const D8_SPAN_S = 6;
export const D8_COG_MS = 5_000;
/** Below this speed a boat's course is unknown: its plume is straight downwind, m/s. */
export const D8_MIN_SPEED_MS = 0.5;
export const D8_MIN_DENSITY = 0.6;
export const D8_MIN_EVAL = 0.5;
export const D8_MIN_FLEET = 3;
export const D8_FLEET_X = 2;
export const D8_MIN_SHARE = 0.15;
export const D8_ALONE_S = 15;
/** Shadowed moments this close are one stretch, ms. */
export const D8_JOIN_MS = 10_000;

/** One boat at one grid moment: position, course (null when slow or unknown). */
interface At {
  p: Vec;
  cog: number | null;
}

interface Grid {
  t0: number;
  n: number;
  ids: string[];
  /** at[i][j]: boat j at grid moment i. */
  at: (At | null)[][];
  /** live[i]: boats racing at moment i (tracked from before to after it). */
  live: number[];
}

const grids = new WeakMap<CoachModel, Grid>();
const shares = new WeakMap<CoachModel, Map<string, ShadowShare | null>>();

function gridOf(m: CoachModel): Grid {
  const hit = grids.get(m);
  if (hit) return hit;
  const ids = [...m.tracks.keys()];
  const trs = ids.map((id) => m.tracks.get(id)!);
  const n = Math.max(0, Math.floor((m.endMs - m.gunMs) / D8_STEP_MS) + 1);
  const at: (At | null)[][] = [];
  const live: number[] = [];
  const span = (tr: (typeof trs)[number], t: number): Vec | null => posAt(tr, t, D8_SPAN_S, D8_SPAN_S);
  for (let i = 0; i < n; i++) {
    const t = m.gunMs + i * D8_STEP_MS;
    let alive = 0;
    at.push(
      trs.map((tr) => {
        const k = tr.t.length;
        const finish = tr.bounds[tr.bounds.length - 1];
        if (!k || t < tr.t[0] || t > tr.t[k - 1] || (finish != null && t > finish)) return null;
        alive++;
        const p = span(tr, t);
        if (!p) return null;
        const a = span(tr, t - D8_COG_MS) ?? p;
        const b = span(tr, t + D8_COG_MS) ?? p;
        const v: Vec = [b[0] - a[0], b[1] - a[1]];
        const dt = a === p && b === p ? 0 : ((a === p ? 0 : D8_COG_MS) + (b === p ? 0 : D8_COG_MS)) / 1000;
        const speed = dt > 0 ? Math.hypot(v[0], v[1]) / dt : 0;
        return { p, cog: speed >= D8_MIN_SPEED_MS ? vecBearing(v) : null };
      }),
    );
    live.push(alive);
  }
  const g = { t0: m.gunMs, n, ids, at, live };
  grids.set(m, g);
  return g;
}

/** The plume's bearing behind a boat on course `cog` (null: straight downwind) in wind from `twd`, °. */
export function plumeBearing(twd: number, cog: number | null): number {
  const down = twd + 180;
  if (cog == null) return ((down % 360) + 360) % 360;
  const rot = Math.min(D8_ROT_MAX_DEG, Math.abs(wrap180(cog - twd)) / 2);
  const toStern = wrap180(cog + 180 - down);
  const b = down + Math.sign(toStern) * Math.min(rot, Math.abs(toStern));
  return ((b % 360) + 360) % 360;
}

/** `p` is in the shadow of a boat at `q` on course `cog`: D8_DIST_LOA lengths away and within ±D8_HALF_DEG of its plume. */
export function inShadow(p: Vec, q: Vec, cog: number | null, twd: number, loaM: number): boolean {
  const v: Vec = [p[0] - q[0], p[1] - q[1]];
  const d = Math.hypot(v[0], v[1]);
  if (d < D8_DIST_LOA[0] * loaM || d > D8_DIST_LOA[1] * loaM) return false;
  return Math.abs(wrap180(vecBearing(v) - plumeBearing(twd, cog))) <= D8_HALF_DEG;
}

export interface ShadowShare {
  /** Share of the counted moments in shadow, 0–1. */
  share: number;
  /** Share of the moments counted (density and the boat's own position), 0–1. */
  evaluated: number;
  /** The shadowed moments, ms. */
  hits: number[];
  /** Who shadowed it most. */
  by: string | null;
}

/** The first D8_WINDOW_MS of each beat for a boat: from its crossing (or the gun) on beat 1, its rounding after that. */
export function beatWindows(m: CoachModel, id: string): [number, number][] {
  const tr = m.tracks.get(id);
  if (!tr) return [];
  const out: [number, number][] = [];
  m.course.kinds.forEach((k, li) => {
    if (k !== 'upwind') return;
    const s = li === 0 ? (m.crossMs?.[id] ?? tr.bounds[0]) : tr.bounds[li];
    if (s == null) return;
    const e = tr.bounds[li + 1];
    out.push([s, Math.min(s + D8_WINDOW_MS, e ?? Infinity)]);
  });
  return out;
}

/** A boat's share in shadow over its beat windows; null when under D8_MIN_EVAL of its moments could be judged. */
export function shadowShare(m: CoachModel, id: string, loaM: number): ShadowShare | null {
  let cache = shares.get(m);
  if (!cache) shares.set(m, (cache = new Map()));
  if (cache.has(id)) return cache.get(id)!;
  const g = gridOf(m);
  const j = g.ids.indexOf(id);
  let total = 0;
  let counted = 0;
  const hits: number[] = [];
  const by = new Map<string, number>();
  for (const [a, b] of beatWindows(m, id)) {
    for (let i = Math.ceil((a - g.t0) / D8_STEP_MS); i < g.n && g.t0 + i * D8_STEP_MS <= b; i++) {
      if (i < 0) continue;
      total++;
      const row = g.at[i];
      const me = j >= 0 ? row[j] : null;
      const others = g.live[i] - (me ? 1 : 0);
      const seen = row.filter((x, k) => x && k !== j).length;
      if (!me || others <= 0 || seen / others < D8_MIN_DENSITY) continue;
      counted++;
      const t = g.t0 + i * D8_STEP_MS;
      const twd = m.wind.twdAt(t);
      let hit: string | null = null;
      for (let k = 0; k < row.length; k++) {
        const o = row[k];
        if (k === j || !o) continue;
        if (inShadow(me.p, o.p, o.cog, twd, loaM)) {
          hit = g.ids[k];
          break;
        }
      }
      if (hit) {
        hits.push(t);
        by.set(hit, (by.get(hit) ?? 0) + 1);
      }
    }
  }
  const r =
    total && counted / total >= D8_MIN_EVAL
      ? { share: hits.length / counted, evaluated: counted / total, hits, by: [...by.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? null }
      : null;
  cache.set(id, r);
  return r;
}

/** Shadowed moments joined into stretches (D8_JOIN_MS apart at most), each padded half a step. */
export function stretches(hits: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const t of hits) {
    const last = out[out.length - 1];
    if (last && t - last[1] <= D8_JOIN_MS) last[1] = t;
    else out.push([t, t]);
  }
  return out.map(([a, b]) => [a - D8_STEP_MS / 2, b + D8_STEP_MS / 2]);
}

export interface D8Result {
  /** A card of its own (Δgap over the stretches ≥ D8_ALONE_S). */
  opp: Opportunity | null;
  /** Otherwise a chip for D3. */
  chip: AttachedChip | null;
  /** Measured with enough data (the boat and the fleet). */
  evaluated: boolean;
  share: number | null;
  fleetShare: number | null;
}

/** The gap read nearest `t` (within D8_JOIN_MS), s. */
function gapNear(points: { tMs: number; behindS: number | null }[], t: number): number | null {
  let best: { d: number; g: number } | null = null;
  for (const p of points) {
    if (p.behindS == null) continue;
    const d = Math.abs(p.tMs - t);
    if (d <= D8_JOIN_MS && (!best || d < best.d)) best = { d, g: p.behindS };
  }
  return best?.g ?? null;
}

export function detectShadow(ctx: CoachCtx): D8Result {
  const none: D8Result = { opp: null, chip: null, evaluated: false, share: null, fleetShare: null };
  const mine = shadowShare(ctx.m, ctx.boat, ctx.loaM);
  if (!mine) return none;
  const fleet = ctx.a.boats
    .filter((b) => b.id !== ctx.boat)
    .map((b) => shadowShare(ctx.m, b.id, ctx.loaM))
    .filter((x): x is ShadowShare => !!x)
    .map((x) => x.share);
  if (fleet.length < D8_MIN_FLEET) return none;
  const fleetShare = median(fleet);
  const base: D8Result = { ...none, evaluated: true, share: mine.share, fleetShare };
  if (!(mine.share >= D8_MIN_SHARE && mine.share >= D8_FLEET_X * fleetShare)) return base;

  const spans = stretches(mine.hits);
  let dgap = 0;
  let read = 0;
  for (const [a, b] of spans) {
    const pts = ctx.leaders.length ? ctx.gaps(ctx.leaders, a - D8_JOIN_MS, b + D8_JOIN_MS) : [];
    const g0 = gapNear(pts, a);
    const g1 = gapNear(pts, b);
    if (g0 == null || g1 == null) continue;
    dgap += g1 - g0;
    read++;
  }
  const facts = {
    share: mine.share,
    fleetShare,
    by: mine.by,
    byName: mine.by ? ctx.nameOf(mine.by) : null,
    dgap: read ? dgap : null,
    stretches: spans.length,
    evaluated: mine.evaluated,
  };
  if (!read || dgap < D8_ALONE_S) return { ...base, chip: { kind: 'D8', facts } };

  const t0 = spans[0][0];
  const t1 = spans[spans.length - 1][1];
  const cov = coachCoverage(ctx.tr.t, t0, t1);
  const sep = typicalSep(ctx, ctx.leaders, t0, t1);
  const { noise, windS } = gapNoise(sep, ctx.m.vmg[0], untrackedS(ctx.tr.t, t0, t1));
  const refTracks = ctx.leaders.map((id) => ctx.m.tracks.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  // Several stretches carry their own noise each.
  const n = Math.sqrt(spans.length);
  return {
    ...base,
    opp: {
      kind: 'D8',
      variant: 'shadow',
      t0,
      t1,
      spans,
      seconds: dgap,
      ...rangeOf(dgap, noise * n),
      confidence: 'high',
      coverage: Math.min(cov, mine.evaluated),
      conf: { boatCov: Math.min(cov, mine.evaluated), refs: refCoverage(refTracks, t0, t1), windOk: windOkShare(ctx.m.wind, t0, t1) },
      facts,
      refBoats: ctx.leaders,
      windEst: windS >= WIND_EST_S,
    },
  };
}

