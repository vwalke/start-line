/**
 * D9 · Mark rounding (spec §3), 100 m in → 100 m out of each mark. The time a boat spends inside
 * D9_ZONE_M of the mark it rounds (the last time it came inside on the way in to the first time it
 * was back out, both read where the track crosses the circle), and how wide it left: its distance
 * across the next leg's line through the mark once it is D9_EXIT_LOA lengths down that leg.
 *
 * - Coverage gate: fixes at most D9_FIX_GAP_S apart while within D9_INNER_M of the mark (wider when
 *   the boat never came that close), and at most D9_ZONE_GAP_S apart anywhere in the zone; else the
 *   rounding is not timed. The 0.25 Hz public feed mostly fails it; an uploaded 10 Hz log passes
 *   (the model's zone tracks read the log at full rate: index.ts zoneTracks).
 * - Reference: the leaders (the finish top 3) that pass the gate at the same mark, D9_MIN_LEADERS of
 *   them; else the boat's own other roundings of the same kind of mark (capped at medium); else any
 *   D9_MIN_LEADERS other boats with data there (capped at low). The card says which.
 * - Fires when the zone took D9_SLOW_S or more longer than the reference's median, or the exit was more
 *   than D9_WIDE_LOA lengths wider than the reference's. Seconds = Δ time in the zone.
 * - A mark placed from the fleet's turns (no tracker) can't time a 100 m circle: suppressed (spec §5).
 * - The mirror: a rounding D9_WELL_S or more quicker than the leaders is a ➕.
 *
 * Low-resolution fallback (placesThrough), wherever the zone path couldn't measure the rounding (the
 * coverage gate failed, no reference passed it, or the mark is placed from the fleet's turns): the boat's
 * place in the fleet by distance to go (progress.ts: the fixed fleet, sparse tracks interpolated) at its
 * own fix nearest D9_PLACES_AT_MS before the rounding (within D9_PLACES_REACH_MS, at least
 * D9_PLACES_MIN_MS from it) and the same after. Fires when it lost placesThreshold(fleet) places or more:
 * max(3, min(5, ceil(5 % of the fleet))) — 3 up to 60 boats, 4 to 80, 5 beyond. Seconds: the median change
 * in gap (distance to go ÷ the two legs' mean fleet VMG) to the boats that passed it. If the boats that came
 * in from the other side (across the wind, D9_SHIFT_WINDOW_MS either side of its rounding) gained
 * D9_SHIFT_GAIN places more on average than its own side and most of the boats that passed it came from
 * there, the card says the loss looks like a shift, the seconds are halved and the confidence is low.
 * Otherwise medium; low when over half the fleet's places at the reads are interpolated, and over
 * D9_PLACES_EST_LIMIT not judged at all (the places would be the interpolation's, not the boats').
 * The boat's own places must be measured (not a hole) and the 2-minute window at least half
 * tracked; only boats measured at both reads that also rounded within D9_SHIFT_WINDOW_MS count as
 * passers. A card needs that many and the place change, and must not contradict the fixed-fleet
 * places at the mark (the leg table): a gain or hold there is a dtg reshuffle, and a huge dtg
 * loss with almost no mark loss is the same (Cascais R2: 11th→63rd by dtg, gained 2 at the mark).
 * DNS/DNC and official extras are left out of the ranking; a DNF/RET is not carried past its last known mark.
 */
import { bearingVec, dot, len, median, sub, type Vec } from '../../geo';
import type { LegKind, RaceAnalysis } from '../../types';
import type { ZoneTrack } from '../index';
import { progressAt, progressBase, type ProgressBase, type ProgressPlaces } from '../progress';
import { posAt } from '../tracks';
import { NOISE_BASE_S, coachCoverage, rangeOf, type Confidence, type GoodNote, type Opportunity } from '../opportunity';
import type { CoachCtx } from './context';

export const D9_ZONE_M = 100;
export const D9_INNER_M = 60;
/** Within D9_INNER_M: at least one fix every this long (spec: ≥ 1 fix every 2 s), s… */
export const D9_FIX_GAP_S = 2;
/** …with this much slack for a log's clock jitter, ms. */
export const D9_FIX_SLACK_MS = 250;
/** When the boat never came within D9_INNER_M, the gate covers its closest approach plus this, m. */
export const D9_INNER_PAD_M = 20;
/** Anywhere in the zone (where the crossings are read), fixes at most this far apart, s. */
export const D9_ZONE_GAP_S = 5;
/** The rounding is looked for this long either side of the timed rounding (and never past the legs either side), ms. */
export const D9_SEARCH_MS = 4 * 60_000;
export const D9_SLOW_S = 8;
export const D9_WIDE_LOA = 2;
/**
 * The exit is read this many lengths down the next leg from the mark: just out of the turn, before the
 * new leg's sailing angle (close-hauled or gybing off the rhumb line) dominates the offset.
 */
export const D9_EXIT_LOA = 2;
/** Leaders (or other boats) with timed roundings a comparison needs. */
export const D9_MIN_LEADERS = 2;
/** A rounding this much quicker than the reference is ➕, s. */
export const D9_WELL_S = 5;
/** ± on a zone time difference, s (the crossings read to about a fix apart, both boats). */
export const D9_NOISE_S = 3;
/** A mark entry this close to the turn is the mark rounded there, m. */
export const D9_MARK_MATCH_M = 200;

// ---- the low-resolution fallback (places through the rounding)

/** Places are read about this long before and after the rounding… */
export const D9_PLACES_AT_MS = 60_000;
/** …at the boat's own fix nearest that, up to this far from the rounding… */
export const D9_PLACES_REACH_MS = 120_000;
/** …and at least this far from it (the rounding itself is the doubt). */
export const D9_PLACES_MIN_MS = 20_000;
/** Places lost that fire: max(D9_PLACES_MIN, min(D9_PLACES_CAP, ceil(D9_PLACES_SHARE × fleet))). */
export const D9_PLACES_MIN = 3;
export const D9_PLACES_CAP = 5;
export const D9_PLACES_SHARE = 0.05;
export const placesThreshold = (fleet: number): number => Math.max(D9_PLACES_MIN, Math.min(D9_PLACES_CAP, Math.ceil(D9_PLACES_SHARE * fleet)));
/** Over this share of the fleet's places interpolated (not from a position) at the reads: low confidence… */
export const D9_PLACES_EST_MAX = 0.5;
/** …over this, the places say nothing about the rounding: not judged (no card, not counted as data). */
export const D9_PLACES_EST_LIMIT = 0.75;
/** The shift check: boats rounding this close in time to the boat… */
export const D9_SHIFT_WINDOW_MS = 3 * 60_000;
/** …at least this many from the other side… */
export const D9_SHIFT_MIN_BOATS = 3;
/** …that gained this many places more on average than the boat's side… */
export const D9_SHIFT_GAIN = 2;
/** …with at least this share of the boats that passed it from there. */
export const D9_SHIFT_SHARE = 2 / 3;
/** A shift-looking loss keeps this share of its seconds. */
export const D9_SHIFT_SECONDS = 0.5;

/** The fallback's read of one rounding. */
export interface PlacesRead {
  tBefore: number;
  tAfter: number;
  before: number;
  after: number;
  /** after − before (+ = lost). */
  lost: number;
  of: number;
  threshold: number;
  passers: string[];
  /** The median gap change to the passers, s (before any shift discount). */
  gapS: number | null;
  /** Share of the fleet's places interpolated at the two reads (mean), 0–1. */
  estShare: number;
  /** The other side gained through the same rounding: looking upwind, 'left' or 'right'. */
  shift: { side: 'left' | 'right'; gain: number; n: number } | null;
}

export type MarkType = 'windward' | 'leeward' | 'offset' | 'reach';

/** What kind of mark ends leg `k`: by the legs into and out of it. */
export function markType(kinds: readonly LegKind[], k: number): MarkType {
  const into = kinds[k];
  const out = kinds[k + 1];
  if (into === 'upwind') return 'windward';
  if (into === 'downwind') return 'leeward';
  return out === 'downwind' ? 'offset' : 'reach';
}

/** One boat's pass through one mark's zone. */
export interface RoundingPass {
  /** The leg the mark ends. */
  leg: number;
  tIn: number;
  tOut: number;
  /** tOut − tIn, s. */
  zoneS: number;
  /** Closest approach to the mark, m. */
  dMinM: number;
  /** Distance across the next leg's line through the mark, D9_EXIT_LOA lengths down it, m; null when not reached in the zone. */
  exitM: number | null;
  /** Longest gap between fixes within the inner radius / anywhere in the zone, s. */
  innerGapS: number;
  zoneGapS: number;
  /** Passes the coverage gate. */
  covered: boolean;
}

/** The mark rounded at the end of leg `k`: its points (both ends of a gate), and whether it was placed from the fleet's turns. */
export function markAt(ctx: Pick<CoachCtx, 'a' | 'm'>, k: number): { pts: Vec[]; estimated: boolean; gate: boolean } | null {
  return markOf(ctx.a, ctx.m.course.pts, k);
}

/** markAt from the analysis alone: `pts` the course's turn points (RaceAnalysis.legPts, the Coach model's course.pts). */
export function markOf(a: Pick<RaceAnalysis, 'legs' | 'marks' | 'legSource'>, pts: readonly Vec[], k: number): { pts: Vec[]; estimated: boolean; gate: boolean } | null {
  const turn = pts[k + 1];
  if (!turn) return null;
  const name = a.legs[k]?.to;
  const near = a.marks.filter((m) => m.name === name && m.xy.some((p) => len(sub(p, turn)) <= D9_MARK_MATCH_M));
  const pick = near.length ? near.reduce((b, m) => (Math.min(...m.xy.map((p) => len(sub(p, turn)))) < Math.min(...b.xy.map((p) => len(sub(p, turn)))) ? m : b)) : null;
  if (pick) return { pts: pick.xy, estimated: !!pick.estimated || a.legSource === 'none', gate: pick.xy.length > 1 };
  return { pts: [turn], estimated: a.legSource === 'fleet' || a.legSource === 'none', gate: false };
}

const distTo = (pts: readonly Vec[], p: Vec): number => Math.min(...pts.map((q) => len(sub(p, q))));
const nearestOf = (pts: readonly Vec[], p: Vec): Vec => pts.reduce((b, q) => (len(sub(p, q)) < len(sub(p, b)) ? q : b));

/**
 * The boat's pass through the zone of the mark ending leg `k`, from track `z` (its zone fixes), looked for
 * around `roundMs` within [lo, hi]; null when it never came inside D9_ZONE_M, or the zone's entry or exit
 * isn't in the track.
 */
export function roundingPass(
  z: Pick<ZoneTrack, 't' | 'x' | 'y'>,
  mark: readonly Vec[],
  nextDir: Vec | null,
  k: number,
  lo: number,
  hi: number,
  loaM: number,
): RoundingPass | null {
  const idx: number[] = [];
  for (let i = 0; i < z.t.length; i++) if (z.t[i] >= lo && z.t[i] <= hi) idx.push(i);
  if (idx.length < 2) return null;
  const p = (i: number): Vec => [z.x[i], z.y[i]];
  const d = idx.map((i) => distTo(mark, p(i)));
  let c = 0;
  for (let j = 1; j < d.length; j++) if (d[j] < d[c]) c = j;
  if (d[c] > D9_ZONE_M) return null;
  // The zone's edges: the last fix outside before the closest approach, the first outside after.
  let a = c;
  while (a > 0 && d[a] < D9_ZONE_M) a--;
  let b = c;
  while (b < d.length - 1 && d[b] < D9_ZONE_M) b++;
  if (d[a] < D9_ZONE_M || d[b] < D9_ZONE_M) return null;
  const cross = (j0: number, j1: number): number => {
    const t0 = z.t[idx[j0]];
    const t1 = z.t[idx[j1]];
    const f = d[j0] === d[j1] ? 0.5 : (D9_ZONE_M - d[j0]) / (d[j1] - d[j0]);
    return t0 + Math.min(1, Math.max(0, f)) * (t1 - t0);
  };
  const tIn = cross(a, a + 1);
  const tOut = cross(b, b - 1);
  // The gate: the inner stretch (within D9_INNER_M, or the closest approach + pad), and the whole zone.
  const inner = Math.max(D9_INNER_M, d[c] + D9_INNER_PAD_M);
  let innerGap = 0;
  let zoneGap = 0;
  for (let j = a; j < b; j++) {
    const g = z.t[idx[j + 1]] - z.t[idx[j]];
    zoneGap = Math.max(zoneGap, g);
    if (d[j] <= inner || d[j + 1] <= inner) innerGap = Math.max(innerGap, g);
  }
  // The exit: D9_EXIT_LOA lengths down the next leg from the mark rounded, the distance across that line.
  let exitM: number | null = null;
  if (nextDir) {
    const m = nearestOf(mark, p(idx[c]));
    const want = D9_EXIT_LOA * loaM;
    for (let j = c; j < b; j++) {
      const r0 = sub(p(idx[j]), m);
      const r1 = sub(p(idx[j + 1]), m);
      const s0 = dot(r0, nextDir);
      const s1 = dot(r1, nextDir);
      if (s0 < want && s1 >= want) {
        const f = (want - s0) / (s1 - s0);
        const across = (r: Vec): number => r[0] * nextDir[1] - r[1] * nextDir[0];
        exitM = Math.abs(across(r0) + f * (across(r1) - across(r0)));
        break;
      }
    }
  }
  return {
    leg: k,
    tIn,
    tOut,
    zoneS: (tOut - tIn) / 1000,
    dMinM: d[c],
    exitM,
    innerGapS: innerGap / 1000,
    zoneGapS: zoneGap / 1000,
    covered: innerGap <= D9_FIX_GAP_S * 1000 + D9_FIX_SLACK_MS && zoneGap <= D9_ZONE_GAP_S * 1000,
  };
}

/** Which boats a rounding is compared with. */
export type D9Ref = 'leaders' | 'own' | 'fleet';

/** One of the boat's roundings, timed (covered) or not, and what it was compared with. */
export interface RoundingRead {
  leg: number;
  type: MarkType;
  /** "Leeward gate", "Windward mark". */
  label: string;
  /** Its number among the race's roundings of that kind, and how many there were. */
  nth: number;
  of: number;
  pass: RoundingPass | null;
  estimated: boolean;
  ref: D9Ref | null;
  refN: number;
  refZoneS: number | null;
  refExitM: number | null;
  /** zoneS − refZoneS, s (+ = slower). */
  dS: number | null;
  /** exitM − refExitM, in boat lengths (+ = wider). */
  wideLoa: number | null;
  /** The low-resolution fallback's read, when it ran. */
  places?: PlacesRead | null;
}

export interface D9Result {
  opps: Opportunity[];
  /** Roundings ≥ D9_WELL_S quicker than the leaders (➕). */
  good: GoodNote[];
  /** Every mark the boat rounded, as read. */
  reads: RoundingRead[];
  /** Mark kinds with at least one rounding timed and compared (the Regatta view's "races with good data"). */
  evaluated: MarkType[];
  /** ✓: two or more roundings compared, none slow or wide. */
  ok: GoodNote | null;
}

const LABEL: Record<MarkType, string> = { windward: 'Windward mark', leeward: 'Leeward mark', offset: 'Offset mark', reach: 'Reach mark' };

/** The mark's name on the card: "Leeward gate" when it is a gate. */
export const markLabel = (type: MarkType, gate: boolean): string => (type === 'leeward' && gate ? 'Leeward gate' : LABEL[type]);

/** The zone track of a boat: its raw fixes near the marks when the model has them, else its drawn track. */
const zoneOf = (ctx: CoachCtx, id: string): Pick<ZoneTrack, 't' | 'x' | 'y'> | null => (ctx.m.zones ? (ctx.m.zones.get(id) ?? null) : (ctx.m.tracks.get(id) ?? null));

/** The boat's own fix nearest `want` within [lo, hi], ms; null without one. */
function fixNear(t: ArrayLike<number> & { length: number }, want: number, lo: number, hi: number): number | null {
  let best: number | null = null;
  for (let i = 0; i < t.length; i++) if (t[i] >= lo && t[i] <= hi && (best == null || Math.abs(t[i] - want) < Math.abs(best - want))) best = t[i];
  return best;
}

/**
 * The fallback (see the header): places through the rounding ending leg `k`, from progress places; null when
 * the boat's rounding time or its fixes either side are missing.
 */
export function placesThrough(ctx: CoachCtx, k: number, at: (t: number) => ProgressPlaces): PlacesRead | null {
  const r = ctx.tr.bounds[k + 1];
  if (r == null) return null;
  const tBefore = fixNear(ctx.tr.t, r - D9_PLACES_AT_MS, r - D9_PLACES_REACH_MS, r - D9_PLACES_MIN_MS);
  const tAfter = fixNear(ctx.tr.t, r + D9_PLACES_AT_MS, r + D9_PLACES_MIN_MS, r + D9_PLACES_REACH_MS);
  if (tBefore == null || tAfter == null) return null;
  // Two isolated fixes either side of a hole are not a rounding.
  if (coachCoverage(ctx.tr.t, tBefore, tAfter) < 0.5) return null;
  const pb = at(tBefore);
  const pa = at(tAfter);
  const me0 = pb.byId.get(ctx.boat);
  const me1 = pa.byId.get(ctx.boat);
  // The boat's own places must be from a position: an interpolated hole at the read is not a rounding.
  if (!me0 || !me1 || me0.est || me1.est) return null;
  // Only boats measured at both reads that also rounded this mark near the same time.
  const passers = [...pb.byId.keys()].filter((id) => {
    if (id === ctx.boat) return false;
    const b = pb.byId.get(id)!;
    const aft = pa.byId.get(id);
    const their = ctx.m.tracks.get(id)?.bounds[k + 1];
    return (
      !!aft &&
      !b.est &&
      !aft.est &&
      b.place > me0.place &&
      aft.place < me1.place &&
      their != null &&
      Math.abs(their - r) <= D9_SHIFT_WINDOW_MS
    );
  });
  // The gap to each passer, the two legs' mean fleet VMG (one speed for both reads, so a steady gap stays steady).
  const vs = [ctx.m.vmg[k], ctx.m.vmg[k + 1]].filter((v): v is number => v != null && v > 0);
  const v = vs.length ? vs.reduce((x, y) => x + y, 0) / vs.length : null;
  const dg = passers
    .map((id) => {
      const b = pb.byId.get(id)!.dtg;
      const a = pa.byId.get(id)!.dtg;
      return Number.isFinite(a) && Number.isFinite(b) && v ? ((me1.dtg - a) - (me0.dtg - b)) / v : null;
    })
    .filter((x): x is number => x != null);
  const share = (p: ProgressPlaces): number => [...p.byId.values()].filter((x) => x.est).length / Math.max(1, p.byId.size);

  // The shift check: the boats rounding near the same time, by the side they came in from.
  const turn = ctx.m.course.pts[k + 1];
  const sideAt = (id: string, t: number): number | null => {
    const tr = ctx.m.tracks.get(id);
    const p = tr ? posAt(tr, t, 60, 30) : null;
    if (!p) return null;
    const x = dot(sub(p, turn), bearingVec(ctx.m.wind.twdAt(t) + 90));
    return x > 0 ? 1 : x < 0 ? -1 : null;
  };
  const mySide = sideAt(ctx.boat, tBefore);
  let shift: PlacesRead['shift'] = null;
  if (mySide != null) {
    const near = ctx.a.boats
      .map((b) => ({ id: b.id, r: ctx.m.tracks.get(b.id)?.bounds[k + 1] ?? null }))
      .filter((x): x is { id: string; r: number } => x.id !== ctx.boat && x.r != null && Math.abs(x.r - r) <= D9_SHIFT_WINDOW_MS)
      .map((x) => {
        const p0 = at(x.r - D9_PLACES_AT_MS).byId.get(x.id);
        const p1 = at(x.r + D9_PLACES_AT_MS).byId.get(x.id);
        return p0 && p1 ? { id: x.id, side: sideAt(x.id, x.r - D9_PLACES_AT_MS), gain: p0.place - p1.place } : null;
      })
      .filter((x): x is { id: string; side: number | null; gain: number } => x != null);
    const other = near.filter((x) => x.side === -mySide);
    const same = near.filter((x) => x.side === mySide);
    const mean = (xs: { gain: number }[]): number => (xs.length ? xs.reduce((t, x) => t + x.gain, 0) / xs.length : 0);
    const passSides = passers.map((id) => near.find((x) => x.id === id)?.side).filter((x): x is number => x != null);
    const fromOther = passSides.length ? passSides.filter((x) => x === -mySide).length / passSides.length : 0;
    if (other.length >= D9_SHIFT_MIN_BOATS && mean(other) - mean(same) >= D9_SHIFT_GAIN && fromOther >= D9_SHIFT_SHARE) {
      shift = { side: -mySide > 0 ? 'right' : 'left', gain: mean(other), n: other.length };
    }
  }
  return {
    tBefore,
    tAfter,
    before: me0.place,
    after: me1.place,
    lost: me1.place - me0.place,
    of: pb.of,
    threshold: placesThreshold(pb.of),
    passers,
    gapS: dg.length ? median(dg) : null,
    estShare: (share(pb) + share(pa)) / 2,
    shift,
  };
}

export function detectRounding(ctx: CoachCtx): D9Result {
  const kinds = ctx.m.course.kinds;
  const nMarks = kinds.length - 1;
  const out: D9Result = { opps: [], good: [], reads: [], evaluated: [], ok: null };
  if (nMarks < 1) return out;

  /** Boat `id`'s pass at the mark ending leg `k`. */
  const passOf = (id: string, k: number): RoundingPass | null => {
    const tr = ctx.m.tracks.get(id);
    const z = zoneOf(ctx, id);
    const mk = markAt(ctx, k);
    if (!tr || !z || !mk) return null;
    const b = tr.bounds;
    const known = (j: number): number | null => (j >= 0 && j < b.length ? b[j] : null);
    const at = known(k + 1);
    let lo = known(k) ?? (at != null ? at - D9_SEARCH_MS : null);
    let hi = known(k + 2) ?? (at != null ? at + D9_SEARCH_MS : null);
    if (lo == null || hi == null) return null;
    if (at != null) {
      lo = Math.max(lo, at - D9_SEARCH_MS);
      hi = Math.min(hi, at + D9_SEARCH_MS);
    }
    const next = ctx.m.course.pts[k + 2];
    const turn = ctx.m.course.pts[k + 1];
    const v = next ? sub(next, turn) : null;
    const L = v ? len(v) : 0;
    const dir: Vec | null = v && L > 0 ? [v[0] / L, v[1] / L] : null;
    return roundingPass(z, mk.pts, dir, k, lo, hi, ctx.loaM);
  };

  const types = Array.from({ length: nMarks }, (_, k) => markType(kinds, k));
  const mine = Array.from({ length: nMarks }, (_, k) => passOf(ctx.boat, k));
  const fleet = ctx.a.boats.map((b) => b.id).filter((id) => id !== ctx.boat && !ctx.leaders.includes(id));
  const evaluated = new Set<MarkType>();
  let compared = 0;
  let fired = 0;
  // The fallback's places, worked out once per race and per moment.
  let base: ProgressBase | null = null;
  const memo = new Map<number, ProgressPlaces>();
  const at = (t: number): ProgressPlaces => {
    base ??= progressBase(ctx.a, ctx.m);
    let p = memo.get(t);
    if (!p) memo.set(t, (p = progressAt(ctx.a, ctx.m, base, t)));
    return p;
  };
  /** The zone path couldn't measure the rounding: places through it instead. */
  const fallback = (read: RoundingRead, mk: { estimated: boolean }): void => {
    const pl = placesThrough(ctx, read.leg, at);
    read.places = pl;
    if (!pl || pl.estShare > D9_PLACES_EST_LIMIT) return;
    evaluated.add(read.type);
    const fp = (base ??= progressBase(ctx.a, ctx.m)).fp.byId.get(ctx.boat);
    const markLost = fp ? fp.place[read.leg + 1] - fp.place[read.leg] : pl.lost;
    // dtg around a mark can reshuffle a 90-boat fleet; skip when the mark-to-mark table disagrees.
    if (pl.lost < pl.threshold || pl.passers.length < pl.threshold) return;
    if (markLost <= 0) return;
    if (pl.lost >= 2 * pl.threshold && markLost * 2 < pl.threshold) return;
    const seconds = Math.max(0, pl.gapS ?? 0) * (pl.shift ? D9_SHIFT_SECONDS : 1);
    const level: Confidence = pl.shift || pl.estShare > D9_PLACES_EST_MAX ? 'low' : 'medium';
    out.opps.push({
      kind: 'D9',
      variant: read.type,
      t0: pl.tBefore,
      t1: pl.tAfter,
      seconds,
      ...rangeOf(seconds, NOISE_BASE_S + 0.5 * seconds),
      confidence: 'high',
      coverage: 1,
      conf: { boatCov: 1, refCap: level, marksEstimated: mk.estimated },
      facts: {
        mode: 'places',
        mark: read.label,
        type: read.type,
        nth: read.nth,
        of: read.of,
        leg: ctx.a.legs[read.leg]?.name ?? null,
        before: pl.before,
        after: pl.after,
        lost: pl.lost,
        fleet: pl.of,
        passers: pl.passers.length,
        gapS: pl.gapS,
        shiftSide: pl.shift?.side ?? null,
        shiftGain: pl.shift?.gain ?? null,
        shiftN: pl.shift?.n ?? null,
      },
      refBoats: pl.passers,
    });
  };

  for (let k = 0; k < nMarks; k++) {
    const type = types[k];
    const mk = markAt(ctx, k)!;
    const sameType = types.map((t, j) => (t === type ? j : -1)).filter((j) => j >= 0);
    const read: RoundingRead = {
      leg: k,
      type,
      label: markLabel(type, mk.gate),
      nth: sameType.indexOf(k) + 1,
      of: sameType.length,
      pass: mine[k],
      estimated: mk.estimated,
      ref: null,
      refN: 0,
      refZoneS: null,
      refExitM: null,
      dS: null,
      wideLoa: null,
    };
    out.reads.push(read);
    const p = mine[k];
    if (!p?.covered) {
      fallback(read, mk);
      continue;
    }
    const leaders = ctx.leaders.map((id) => passOf(id, k)).filter((x): x is RoundingPass => !!x?.covered);
    const own = sameType.filter((j) => j !== k && mine[j]?.covered).map((j) => mine[j]!);
    let refs: RoundingPass[] = [];
    let ref: D9Ref | null = null;
    if (leaders.length >= D9_MIN_LEADERS) [refs, ref] = [leaders, 'leaders'];
    else if (own.length) [refs, ref] = [own, 'own'];
    else {
      const others = fleet.map((id) => passOf(id, k)).filter((x): x is RoundingPass => !!x?.covered);
      if (others.length >= D9_MIN_LEADERS) [refs, ref] = [others, 'fleet'];
    }
    if (!ref) {
      fallback(read, mk);
      continue;
    }
    const refZoneS = median(refs.map((r) => r.zoneS));
    const exits = refs.map((r) => r.exitM).filter((x): x is number => x != null);
    const refExitM = exits.length ? median(exits) : null;
    const dS = p.zoneS - refZoneS;
    const wideLoa = p.exitM != null && refExitM != null ? (p.exitM - refExitM) / ctx.loaM : null;
    Object.assign(read, { ref, refN: refs.length, refZoneS, refExitM, dS, wideLoa });
    if (mk.estimated) {
      fallback(read, mk);
      continue;
    }
    evaluated.add(type);
    compared++;
    const wide = wideLoa != null && wideLoa > D9_WIDE_LOA;
    if (dS >= D9_SLOW_S || wide) {
      fired++;
      const seconds = Math.max(0, dS);
      out.opps.push({
        kind: 'D9',
        variant: type,
        t0: p.tIn,
        t1: p.tOut,
        seconds,
        ...rangeOf(seconds, D9_NOISE_S),
        confidence: 'high',
        coverage: 1,
        conf: {
          boatCov: 1,
          ...(ref === 'leaders' ? { refs: { good: refs.length, fair: refs.length, need: D9_MIN_LEADERS } } : {}),
          ...(ref === 'own' ? { refCap: 'medium' as const } : ref === 'fleet' ? { refCap: 'low' as const } : {}),
          marksSuppress: mk.estimated,
        },
        facts: {
          mode: 'zone',
          mark: read.label,
          type,
          nth: read.nth,
          of: read.of,
          leg: ctx.a.legs[k]?.name ?? null,
          zoneS: p.zoneS,
          refZoneS,
          dS,
          exitM: p.exitM,
          refExitM,
          wideLoa,
          wide: wide ? 1 : 0,
          dMinM: p.dMinM,
          ref,
          refN: refs.length,
        },
        refBoats: ref === 'leaders' ? ctx.leaders : [],
      });
    } else if (-dS >= D9_WELL_S && ref === 'leaders') {
      out.good.push({
        kind: 'plus',
        detector: 'D9',
        variant: type,
        facts: { mark: read.label, nth: read.nth, of: read.of, gainS: -dS, ref },
        t0: p.tIn,
        t1: p.tOut,
        seconds: -dS,
      });
    }
  }
  out.evaluated = [...evaluated];
  if (compared >= 2 && !fired) out.ok = { kind: 'ok', detector: 'D9', variant: 'ok', facts: { n: compared }, t0: ctx.gun, t1: ctx.m.endMs };
  return out;
}
