/**
 * D13 · Gate choice: at a leeward gate (two tracked buoys), which buoy the boat rounded, whether the other was
 * favoured, and what the choice cost it up the next beat. Choice, not handling: how the rounding itself was sailed
 * is D9's (its zone-time card stays separate).
 *
 * - Gating: both buoys tracked and neither placed from the fleet's turns (markAt: a gate); the boat's side read
 *   (gateSides.ts: the nearer buoy at its closest approach, nearer ÷ further ≤ GATE_SIDE_RATIO, fixes at most
 *   GATE_FIX_GAP_S apart within a minute of it), sides named LOOKING UPWIND, geometrically; the wind series
 *   (twdSeries) measured around the gate (windOkShare ≥ D13_WIND_OK over D13_SHIFT_MS around the fleet's median
 *   rounding); at least D13_MIN_SIDE boats with a passage on each side, and that many on the other side rounding
 *   within D13_CONTEMP_MS of the boat.
 * - Favoured buoy (geometric): the wind at the gate is the fleet's tack bisector on the beat after it (the courses
 *   over ground of the boats that rounded it, D13_TACK_FROM_MS to D13_TACK_TO_MS after each one's rounding, split
 *   into the two tacks about the wind series; the midpoint of their medians), else the wind series. The series is
 *   measured on the beats, and around the gate most of the fleet is still on the run, so its minutes there are thin
 *   or interpolated; the bisector reads exactly the boats that rounded this gate, on the beat it opens, which is
 *   also the direction the passage below is measured along (it reproduced the investigation's numbers). Δ = the
 *   buoys' offset along it; the further upwind buoy is favoured when Δ ≥ max(D13_MIN_DELTA_M, D13_MIN_DELTA_LOA
 *   lengths) and Δ ÷ the fleet's beat VMG + Δ ÷ its run VMG ≥ D13_MIN_COST_S (the beat part reported on its own:
 *   the run part, by the run's VMG, overstates it).
 * - Empirical: each boat's passage, from where it last crossed the contour D13_RUN_M above the gate on the run (the
 *   gate's middle projected on the wind) to where it first crossed D13_BEAT_M above it up the beat; the side
 *   difference is the median passage of the boats at the other buoy minus the favoured buoy's. Confirmed when it has
 *   the same sign and is at least D13_CONFIRM_SHARE of the geometric cost (beat + run).
 * - Fires (➖) when the boat rounded the unfavoured buoy of a favoured, confirmed gate and its own passage was
 *   D13_SLOW_S or more slower than the median of the other-side boats rounding within D13_CONTEMP_MS of it. Seconds:
 *   the confirmed side difference (at most the boat's own loss); range [geometric beat-only, the boat's own loss];
 *   places: the order change between the two contours. Confidence: high (≥ D13_HIGH_PER_SIDE a side, steady wind),
 *   medium (fewer: the side difference leans on few boats), low when the wind moved D13_SHIFT_DEG or more over
 *   D13_SHIFT_MS around the boat's rounding.
 * - No card: the favoured buoy was busy (D13_TRAFFIC_BOATS or more boats rounded it in the D13_TRAFFIC_MS before the
 *   boat, and they were no quicker through the passage than it: `busy`; the ✓ note, or ➕ when it gained places;
 *   the investigation's own example card, J/24 R2 USA 2607, had 4 boats round the favoured buoy just ahead that were
 *   still ~40 s quicker, so a busy buoy alone is not the excuse); a passage over D13_OUTLIER × the median (a stop or a tangle,
 *   not the choice); a penalty turn (D12) in the passage; the gate not favoured or not confirmed.
 * - Netting: when the boat then sailed the side of the next beat that paid (legStory.ts fleetSide), its gain from
 *   the upper contour to the next mark against the other-side boats rounding within D13_CONTEMP_MS ("net ±N s");
 *   more than its loss through the passage flips the card to ➕.
 * - ➕ mirror: rounded the favoured buoy of a confirmed gate and gained D13_PLUS_PLACES or more places between the
 *   contours; or rounded the clear buoy while the favoured one was busy, and gained.
 * - D9's low-resolution places card at the same gate rounding becomes a chip on the D13 card (debrief.ts
 *   attachGatePlaces: no double count).
 */
import { bisectRight, bearingVec, dot, len, median, norm360, sub, vecBearing, wrap180, type Vec } from '../../geo';
import type { CoachModel } from '../index';
import { fleetSide } from '../legStory';
import { coachCoverage, type Confidence, type GoodNote, type Opportunity, windOkShare } from '../opportunity';
import { gateGeoms, gateSideReads, type GateGeom, type GateSide, type GateSideRead } from '../gateSides';
import { COACH_MAX_SPAN_S, posAt, type CoachTrack } from '../tracks';
import type { RaceAnalysis } from '../../types';
import type { CoachCtx } from './context';
import { markLabel } from './rounding';

/** Favoured: the buoys at least this far apart along the wind, m… */
export const D13_MIN_DELTA_M = 10;
/** …and at least this many boat lengths… */
export const D13_MIN_DELTA_LOA = 1.5;
/** …and worth at least this much (beat + run), s. */
export const D13_MIN_COST_S = 6;
/** The passage's lower contour: this far above the gate on the run, m… */
export const D13_RUN_M = 150;
/** …and its upper one, up the beat, m. */
export const D13_BEAT_M = 300;
/** The run contour is looked for this long before the rounding, the beat contour this long after, ms. */
export const D13_RUN_SEARCH_MS = 10 * 60_000;
export const D13_BEAT_SEARCH_MS = 15 * 60_000;
/** Confirmed: the side difference at least this share of the geometric cost (beat + run). */
export const D13_CONFIRM_SHARE = 0.5;
/** Boats with a passage on each side, at least (and on the other side within D13_CONTEMP_MS of the boat). */
export const D13_MIN_SIDE = 3;
/** Contemporaries: boats rounding this close in time, ms. */
export const D13_CONTEMP_MS = 3 * 60_000;
/** High confidence needs this many boats a side. */
export const D13_HIGH_PER_SIDE = 5;
/** The wind moved this much… */
export const D13_SHIFT_DEG = 10;
/** …over this long around the rounding (centred): low confidence; also the window the wind must be measured over, ms. */
export const D13_SHIFT_MS = 10 * 60_000;
/** The wind series measured over at least this share of that window (windOkShare). */
export const D13_WIND_OK = 0.5;
/** Fires when the boat's passage was this much slower than the other side's contemporaries, s. */
export const D13_SLOW_S = 5;
/** Busy: this many boats rounded the favoured buoy… */
export const D13_TRAFFIC_BOATS = 3;
/** …in this long before the boat, ms. */
export const D13_TRAFFIC_MS = 20_000;
/** A passage over this many times the median is a stop, not the choice. */
export const D13_OUTLIER = 1.6;
/** ➕: places gained between the contours. */
export const D13_PLUS_PLACES = 2;
/** The tack bisector: each boat's courses this long after its rounding… */
export const D13_TACK_FROM_MS = 60_000;
export const D13_TACK_TO_MS = 300_000;
/** …over this long a step, ms… */
export const D13_TACK_STEP_MS = 10_000;
/** …within this of the axis, °, at least this many a tack. */
export const D13_TACK_MAX_DEG = 75;
export const D13_TACK_MIN = 5;

/** One boat at one gate. */
export interface GateBoat extends GateSideRead {
  /** The run contour (down) and the beat contour (up) crossings, ms; null when not tracked there. */
  tDn: number | null;
  tUp: number | null;
  /** tUp − tDn, s. */
  passS: number | null;
  /** Its place in the order of crossing each contour (boats with both), and the places gained between them. */
  placeDn: number | null;
  placeUp: number | null;
  gained: number | null;
  /** Its passage minus the median of the other-side boats rounding within D13_CONTEMP_MS (+ = slower), s; and how many. */
  dS: number | null;
  nOther: number;
  /** Boats that rounded the favoured buoy in the D13_TRAFFIC_MS before it (0 when it took that buoy or none is favoured). */
  traffic: number;
  /** Their median passage minus its own (− = they were quicker), s; null without one. */
  trafficS: number | null;
}

/** The fleet's read of one gate (the same for every boat). */
export interface GateRead {
  leg: number;
  geom: GateGeom;
  /** "Leeward gate", its number among the race's leeward roundings, and how many. */
  label: string;
  nth: number;
  of: number;
  /** The fleet's median rounding, ms. */
  tMs: number;
  /** The wind at the gate, °, and where it came from. */
  twd: number;
  twdFrom: 'tacks' | 'series';
  windOk: number;
  /** The buoy further upwind, and by how much, m. */
  upper: GateSide;
  deltaM: number;
  /** Geometric cost of the lower buoy: on the beat, on the run (Δ ÷ the run's VMG: crude), s. */
  beatS: number | null;
  runS: number | null;
  /** The favoured buoy (upper when Δ and the cost pass), else null. */
  fav: GateSide | null;
  /** Median passage of the lower buoy's boats minus the upper's (+ = the upper quicker), s; null without D13_MIN_SIDE a side. */
  empS: number | null;
  confirmed: boolean;
  n: Record<GateSide, number>;
  medianPassS: number | null;
  /** Passed the gating (wind, D13_MIN_SIDE a side): the boats' reads mean something. */
  evaluated: boolean;
  boats: Map<string, GateBoat>;
}

const other = (s: GateSide): GateSide => (s === 'left' ? 'right' : 'left');

/** The first crossing of `level` by s(t) (upward when `up`, else downward), searched forward from `from` to `to` (or backward when `back`), ms; null when none, or across a hole. */
function crossing(tr: Pick<CoachTrack, 't' | 'x' | 'y'>, u: Vec, level: number, up: boolean, from: number, to: number, back = false): number | null {
  const s = (i: number): number => tr.x[i] * u[0] + tr.y[i] * u[1];
  const n = tr.t.length;
  const hit = (i: number): number | null => {
    const a = s(i);
    const b = s(i + 1);
    const ok = up ? a <= level && b > level : a >= level && b < level;
    if (!ok || tr.t[i + 1] - tr.t[i] > COACH_MAX_SPAN_S * 1000) return null;
    return tr.t[i] + ((level - a) / (b - a)) * (tr.t[i + 1] - tr.t[i]);
  };
  if (back) {
    for (let i = Math.min(n - 2, bisectRight(tr.t, to) - 1); i >= 0 && tr.t[i] >= from; i--) {
      const t = hit(i);
      if (t != null) return t;
    }
    return null;
  }
  for (let i = Math.max(0, bisectRight(tr.t, from)); i < n - 1 && tr.t[i + 1] <= to; i++) {
    const t = hit(i);
    if (t != null) return t;
  }
  return null;
}

/** The fleet's tack bisector on the beat after the gate (see the header), about `axis`; null with too few courses a tack. */
function tackBisector(m: CoachModel, reads: Iterable<GateSideRead>, axis: number): number | null {
  const pos: number[] = [];
  const neg: number[] = [];
  for (const r of reads) {
    const tr = m.tracks.get(r.id);
    if (!tr) continue;
    for (let dt = D13_TACK_FROM_MS; dt <= D13_TACK_TO_MS; dt += D13_TACK_STEP_MS) {
      const p = posAt(tr, r.tMs + dt);
      const q = posAt(tr, r.tMs + dt + D13_TACK_STEP_MS);
      if (!p || !q) continue;
      const v = sub(q, p);
      if (len(v) < 10) continue;
      const rel = wrap180(vecBearing(v) - axis);
      if (Math.abs(rel) < D13_TACK_MAX_DEG) (rel > 0 ? pos : neg).push(rel);
    }
  }
  if (pos.length < D13_TACK_MIN || neg.length < D13_TACK_MIN) return null;
  return norm360(axis + (median(pos) + median(neg)) / 2);
}

/** The wind's range over [a, b] by the minute (unwrapped), °. */
export function windRange(twdAt: (t: number) => number, a: number, b: number): number {
  const w0 = twdAt(a);
  const rel: number[] = [];
  for (let t = a; t <= b; t += 60_000) rel.push(wrap180(twdAt(t) - w0));
  return Math.max(...rel) - Math.min(...rel);
}

/** The gate ending leg `k`, read over the fleet (see the header); null when it is not a two-buoy gate. */
export function readGate(a: RaceAnalysis, m: CoachModel, k: number, loaM: number): GateRead | null {
  const geom = gateGeoms(a).find((g) => g.leg === k);
  if (!geom) return null;
  const sides = gateSideReads(m.tracks.values(), geom);
  const kinds = m.course.kinds;
  const leeward = kinds.map((_, j) => (j < kinds.length - 1 && kinds[j] === 'downwind' ? j : -1)).filter((j) => j >= 0);
  const label = markLabel('leeward', true);
  const tMs = sides.size ? median([...sides.values()].map((s) => s.tMs)) : (m.tracks.values().next().value?.bounds[k + 1] ?? m.gunMs);
  const axis = m.wind.twdAt(tMs);
  const bis = tackBisector(m, sides.values(), axis);
  const twd = bis ?? axis;
  const windOk = windOkShare(m.wind, tMs - D13_SHIFT_MS / 2, tMs + D13_SHIFT_MS / 2);
  const u = bearingVec(twd);
  const off = dot(sub(geom.left, geom.right), u);
  const upper: GateSide = off >= 0 ? 'left' : 'right';
  const deltaM = Math.abs(off);
  const vUp = m.vmg[k + 1];
  const vDn = m.vmg[k];
  const beatS = vUp && vUp > 0 ? deltaM / vUp : null;
  const runS = vDn && vDn > 0 ? deltaM / vDn : null;
  const fav = deltaM >= Math.max(D13_MIN_DELTA_M, D13_MIN_DELTA_LOA * loaM) && (beatS ?? 0) + (runS ?? 0) >= D13_MIN_COST_S ? upper : null;

  // Passages between the contours.
  const G = dot(geom.centre, u);
  const boats = new Map<string, GateBoat>();
  for (const s of sides.values()) {
    const tr = m.tracks.get(s.id)!;
    const tDn = crossing(tr, u, G + D13_RUN_M, false, s.tMs - D13_RUN_SEARCH_MS, s.tMs, true);
    const tUp = crossing(tr, u, G + D13_BEAT_M, true, s.tMs, s.tMs + D13_BEAT_SEARCH_MS);
    boats.set(s.id, { ...s, tDn, tUp, passS: tDn != null && tUp != null ? (tUp - tDn) / 1000 : null, placeDn: null, placeUp: null, gained: null, dS: null, nOther: 0, traffic: 0, trafficS: null });
  }
  const passed = [...boats.values()].filter((b) => b.passS != null);
  [...passed].sort((p, q) => p.tDn! - q.tDn!).forEach((b, i) => (b.placeDn = i + 1));
  [...passed].sort((p, q) => p.tUp! - q.tUp!).forEach((b, i) => (b.placeUp = i + 1));
  for (const b of passed) {
    b.gained = b.placeDn! - b.placeUp!;
    const others = passed.filter((o) => o.side !== b.side && Math.abs(o.tMs - b.tMs) <= D13_CONTEMP_MS).map((o) => o.passS!);
    b.nOther = others.length;
    b.dS = others.length ? b.passS! - median(others) : null;
  }
  if (fav) {
    for (const b of boats.values()) {
      if (b.side === fav) continue;
      const pack = [...boats.values()].filter((o) => o.side === fav && o.tMs < b.tMs && o.tMs >= b.tMs - D13_TRAFFIC_MS);
      b.traffic = pack.length;
      const ps = pack.filter((o) => o.passS != null).map((o) => o.passS!);
      b.trafficS = ps.length && b.passS != null ? median(ps) - b.passS : null;
    }
  }
  const by = (side: GateSide): number[] => passed.filter((b) => b.side === side).map((b) => b.passS!);
  const n = { left: by('left').length, right: by('right').length };
  const empS = n.left >= D13_MIN_SIDE && n.right >= D13_MIN_SIDE ? median(by(other(upper))) - median(by(upper)) : null;
  const confirmed = fav != null && empS != null && empS > 0 && empS >= D13_CONFIRM_SHARE * ((beatS ?? 0) + (runS ?? 0));
  return {
    leg: k,
    geom,
    label,
    nth: leeward.indexOf(k) + 1,
    of: leeward.length,
    tMs,
    twd,
    twdFrom: bis != null ? 'tacks' : 'series',
    windOk,
    upper,
    deltaM,
    beatS,
    runS,
    fav,
    empS,
    confirmed,
    n,
    medianPassS: passed.length ? median(passed.map((b) => b.passS!)) : null,
    evaluated: windOk >= D13_WIND_OK && empS != null,
    boats,
  };
}

const memo = new WeakMap<CoachModel, Map<number, GateRead | null>>();

/** readGate, once per model and gate. */
export function gateRead(a: RaceAnalysis, m: CoachModel, k: number, loaM: number): GateRead | null {
  let g = memo.get(m);
  if (!g) memo.set(m, (g = new Map()));
  if (!g.has(k)) g.set(k, readGate(a, m, k, loaM));
  return g.get(k)!;
}

/** The gates of the race, read (two-buoy gates only). */
export const raceGates = (a: RaceAnalysis, m: CoachModel, loaM: number): GateRead[] =>
  gateGeoms(a)
    .map((g) => gateRead(a, m, g.leg, loaM))
    .filter((g): g is GateRead => !!g);

export interface D13Result {
  opps: Opportunity[];
  /** ➕ Went well. */
  good: GoodNote[];
  /** ✓ / info: the clear buoy while the favoured one was busy, no harm done. */
  notes: GoodNote[];
  /** At least one of the boat's gate roundings was judged (the Regatta view's denominator). */
  evaluated: boolean;
}

const fleetSideMemo = new WeakMap<CoachModel, Map<number, ReturnType<typeof fleetSide>>>();
function fleetSideOf(a: RaceAnalysis, m: CoachModel, li: number): ReturnType<typeof fleetSide> {
  let s = fleetSideMemo.get(m);
  if (!s) fleetSideMemo.set(m, (s = new Map()));
  if (!s.has(li)) s.set(li, fleetSide(a, m, li));
  return s.get(li)!;
}

/**
 * The boat's gain up the rest of the next beat when it sailed the side that paid (see the header): the median time of
 * the other-side contemporaries from the upper contour to the next mark minus its own, s; null when the side didn't pay
 * for it (or can't be read).
 */
function netGain(ctx: CoachCtx, g: GateRead, me: GateBoat): { gainS: number; side: GateSide } | null {
  const li = g.leg + 1;
  const fs = fleetSideOf(ctx.a, ctx.m, li);
  if (!fs || fs.verdict === 'none') return null;
  const x = fs.x.get(ctx.boat);
  if (x == null || (x > 0 ? 'right' : 'left') !== fs.verdict) return null;
  const next = (id: string): number | null => ctx.m.tracks.get(id)?.bounds[li + 1] ?? null;
  const mine = next(ctx.boat);
  if (mine == null || me.tUp == null) return null;
  const theirs = [...g.boats.values()]
    .filter((o) => o.side !== me.side && o.tUp != null && Math.abs(o.tMs - me.tMs) <= D13_CONTEMP_MS)
    .map((o) => {
      const t = next(o.id);
      return t != null ? (t - o.tUp!) / 1000 : null;
    })
    .filter((v): v is number => v != null);
  if (theirs.length < D13_MIN_SIDE) return null;
  return { gainS: median(theirs) - (mine - me.tUp) / 1000, side: fs.verdict };
}

/**
 * The traffic excuse: D13_TRAFFIC_BOATS or more boats rounded the favoured buoy in the D13_TRAFFIC_MS before the boat,
 * and they were not D13_SLOW_S or more quicker through the passage than it (the queue cost them what the clear buoy
 * saved it). A busy buoy whose queue still came out well ahead is no excuse (J/24 R2 USA 2607: 4 boats rounded the
 * right buoy just ahead of it and were still ~40 s quicker up the beat).
 */
export const busy = (b: Pick<GateBoat, 'traffic' | 'trafficS'>): boolean => b.traffic >= D13_TRAFFIC_BOATS && (b.trafficS == null || b.trafficS > -D13_SLOW_S);

/** What D13 says about one boat at one gate (judgeGate). */
export type GateVerdict =
  /** Not judged: the gate's or the boat's data falls short (no denominator either). */
  | { kind: 'skip' }
  /** Judged, nothing to say: why. */
  | { kind: 'none'; why: 'not-favoured' | 'outlier' | 'turn' | 'not-slower' | 'no-gain' }
  /** ➖: seconds (netted when the next beat's side paid), its range, the confidence; netS = gain up the beat − own loss. */
  | { kind: 'card'; seconds: number; lo: number; hi: number; level: Confidence; shift: boolean; netS: number | null; beatSide: GateSide | null }
  /** ➕ (the favoured buoy and places gained; the clear buoy in traffic and gained; the side up the beat paid more) or ✓ (the clear buoy in traffic). */
  | { kind: 'plus' | 'ok'; variant: 'fav' | 'traffic' | 'net'; seconds: number; shift: boolean; netS: number | null; beatSide: GateSide | null };

/** What judgeGate needs besides the read: the boat's penalty turns, the wind's range around its rounding, and its gain up the next beat (netGain) when asked. */
export interface GateJudgeInput {
  turns: readonly { t0: number; t1: number }[];
  windRangeDeg: number;
  net: () => { gainS: number; side: GateSide } | null;
}

/** One boat at one gate, by the rules in the header (pure: the tests build `g` and `me` by hand). */
export function judgeGate(
  g: Pick<GateRead, 'evaluated' | 'fav' | 'confirmed' | 'medianPassS' | 'empS' | 'beatS' | 'n'>,
  me: GateBoat,
  x: GateJudgeInput,
): GateVerdict {
  if (!g.evaluated || me.passS == null || me.dS == null || me.tDn == null || me.tUp == null || me.nOther < D13_MIN_SIDE) return { kind: 'skip' };
  if (!g.fav || !g.confirmed || g.empS == null) return { kind: 'none', why: 'not-favoured' };
  // A stop or a tangle (a passage far over the median), or a penalty turn in it: not the choice.
  if (g.medianPassS != null && me.passS > D13_OUTLIER * g.medianPassS) return { kind: 'none', why: 'outlier' };
  if (x.turns.some((t) => t.t0 < me.tUp! && t.t1 > me.tDn!)) return { kind: 'none', why: 'turn' };
  const shift = x.windRangeDeg >= D13_SHIFT_DEG;
  const none = { shift, netS: null, beatSide: null };
  if (me.side === g.fav) {
    if ((me.gained ?? 0) < D13_PLUS_PLACES) return { kind: 'none', why: 'no-gain' };
    return { kind: 'plus', variant: 'fav', seconds: me.dS < 0 ? -me.dS : (g.beatS ?? 0), ...none };
  }
  // The favoured buoy was busy, and the boats queued there were no quicker through the passage: the clear one was reasonable.
  if (busy(me)) {
    // Gained: places through the passage, and quicker than the other side's contemporaries (the ➕'s seconds).
    const gained = (me.gained ?? 0) > 0 && me.dS < 0;
    return { kind: gained ? 'plus' : 'ok', variant: 'traffic', seconds: Math.max(0, -me.dS), ...none };
  }
  if (me.dS < D13_SLOW_S) return { kind: 'none', why: 'not-slower' };
  const seconds = Math.min(g.empS, me.dS);
  // The side up the next beat paid: its gain there against what the passage cost it.
  const net = x.net();
  const paid = net && net.gainS > 0 ? net : null;
  const netS = paid ? paid.gainS - me.dS : null;
  if (paid && netS! > 0) return { kind: 'plus', variant: 'net', seconds: netS!, shift, netS, beatSide: paid.side };
  const netted = paid ? Math.max(0, seconds - paid.gainS) : seconds;
  const f = seconds > 0 ? netted / seconds : 1;
  const level: Confidence = shift ? 'low' : Math.min(g.n.left, g.n.right) >= D13_HIGH_PER_SIDE ? 'high' : 'medium';
  return {
    kind: 'card',
    seconds: netted,
    lo: Math.min(g.beatS ?? seconds, me.dS) * f,
    hi: Math.max(seconds, me.dS) * f,
    level,
    shift,
    netS,
    beatSide: paid?.side ?? null,
  };
}

export function detectGate(ctx: CoachCtx): D13Result {
  const out: D13Result = { opps: [], good: [], notes: [], evaluated: false };
  for (const geom of gateGeoms(ctx.a)) {
    const g = gateRead(ctx.a, ctx.m, geom.leg, ctx.loaM);
    const me = g?.boats.get(ctx.boat);
    if (!g || !me) continue;
    const v = judgeGate(g, me, {
      turns: ctx.m.turns?.get(ctx.boat) ?? [],
      windRangeDeg: windRange(ctx.m.wind.twdAt, me.tMs - D13_SHIFT_MS / 2, me.tMs + D13_SHIFT_MS / 2),
      net: () => netGain(ctx, g, me),
    });
    if (v.kind === 'skip') continue;
    out.evaluated = true;
    if (v.kind === 'none' || !g.fav) continue;
    const facts = {
      mark: g.label,
      nth: g.nth,
      of: g.of,
      leg: ctx.a.legs[g.leg]?.name ?? null,
      side: me.side,
      fav: g.fav,
      deltaM: g.deltaM,
      beatS: g.beatS,
      runS: g.runS,
      empS: g.empS,
      ownS: me.dS,
      gained: me.gained,
      traffic: me.traffic,
      trafficS: me.trafficS,
      nFav: g.n[g.fav],
      nOther: g.n[other(g.fav)],
      shift: v.shift ? 1 : 0,
      ...(v.netS != null ? { netS: v.netS, beatSide: v.beatSide } : {}),
    };
    if (v.kind !== 'card') {
      // The net ➕ runs to the next mark (the beat's side paid); the others are the passage.
      const t1 = v.variant === 'net' ? (ctx.tr.bounds[g.leg + 2] ?? me.tUp!) : me.tUp!;
      (v.kind === 'plus' ? out.good : out.notes).push({ kind: v.kind, detector: 'D13', variant: v.variant, facts: { ...facts, gainS: v.seconds }, t0: me.tDn!, t1, seconds: v.seconds });
      continue;
    }
    const coverage = coachCoverage(ctx.tr.t, me.tDn!, me.tUp!);
    out.opps.push({
      kind: 'D13',
      variant: 'unfavoured',
      t0: me.tDn!,
      t1: me.tUp!,
      seconds: v.seconds,
      secondsLo: v.lo,
      secondsHi: v.hi,
      confidence: v.level,
      coverage,
      // The series around a gate is often interpolated (the fleet is still on the run); D13's
      // wind is the tack bisector, and a 10°+ swing is already `refCap: 'low'`. Passing windOk
      // here would cap a 6-a-side card at medium and the ⚠ would say "few boats a side".
      conf: { boatCov: coverage, refCap: v.level },
      facts,
      // The seconds are the favoured-side contemporaries' passages; a side read without one is not a ref.
      refBoats: [...g.boats.values()]
        .filter((o) => o.side === g.fav && o.passS != null && Math.abs(o.tMs - me.tMs) <= D13_CONTEMP_MS)
        .map((o) => o.id),
    });
  }
  return out;
}
