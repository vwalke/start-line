/**
 * D15 · Fast but going nowhere: on a beat or run the boat's speed was at or above the fleet's, but its VMG was worse,
 * so it sailed extra distance for each metre it made toward (or away from) the wind: wide angles or a longer route.
 *
 * Like for like: every boat's path on the leg is read the same way, its positions every D15_STEP_MS (tracks.ts posAt,
 * never across a hole longer than COACH_MAX_SPAN_S), each step adding its distance and its progress along the fleet's
 * wind at the time, so a dense track and a sparse one are measured alike (a path summed fix by fix grows with the fix
 * rate). SOG = distance ÷ time read, VMG = progress ÷ time read, the path ratio = distance ÷ progress, over the boat's
 * own timed leg; the fleet is every other boat with the leg timed and D15_MIN_READ of it read, at least D15_MIN_REFS.
 *
 * - Fires when the boat's SOG is within D15_SOG_TOL of the fleet's median or above, its VMG D15_VMG_DROP or more below,
 *   and its path ratio D15_PATH_EXTRA or more above, with D15_MIN_READ of its own leg read. Seconds (rate-type, as D6) =
 *   (VMG_fleet − VMG_b) / VMG_fleet × its leg time. The matched-window angles (angles.ts legAngles) go on the card.
 * - ➕ Went well: as fast and D15_GOOD_GAIN or more better VMG, on no longer a path.
 * - `progressWorse`: the legs where the VMG and the path ratio say the boat went nowhere whatever its speed: D6 / D7's ✓
 *   leaves those legs out (a "pointing fine" that the distance sailed contradicts).
 */
import { MS_TO_KN, bearingVec, dot, median, sub } from '../../geo';
import type { LegKind } from '../../types';
import type { CoachModel } from '../index';
import { NOISE_BASE_S, RATE_REL_ERR, coachCoverage, windOkShare, type GoodNote, type Opportunity } from '../opportunity';
import { posAt, type CoachTrack } from '../tracks';
import { legAngles } from './angles';
import type { CoachCtx } from './context';

/** Positions read this often along the leg, ms. */
export const D15_STEP_MS = 10_000;
/** A boat's leg counts with this share of its time read (consecutive positions), the boat's own and the fleet's. */
export const D15_MIN_READ = 0.5;
/** At least this many fleet boats with the leg read. */
export const D15_MIN_REFS = 8;
/** "Fast": SOG at least the fleet's median less this share. */
export const D15_SOG_TOL = 0;
/** "Going nowhere": VMG this share or more below the fleet's median… */
export const D15_VMG_DROP = 0.05;
/** …and this share or more distance sailed per metre made good. */
export const D15_PATH_EXTRA = 0.05;
/** ➕: as fast, and VMG this share or more above the fleet's, on no longer a path. */
export const D15_GOOD_GAIN = 0.08;

/** One boat's path on one leg, read every D15_STEP_MS. */
export interface LegPath {
  distM: number;
  madeM: number;
  /** Time read, s, and its share of the leg. */
  readS: number;
  read: number;
}

/** The path of `tr` over [a, b] (see the header); + progress = toward the wind upwind, away from it downwind. */
export function legPath(tr: Pick<CoachTrack, 't' | 'x' | 'y'>, a: number, b: number, twdAt: (t: number) => number, kind: LegKind): LegPath {
  const sign = kind === 'downwind' ? -1 : 1;
  let distM = 0;
  let madeM = 0;
  let readS = 0;
  for (let t = a; t + D15_STEP_MS <= b; t += D15_STEP_MS) {
    const p = posAt(tr, t);
    const q = p ? posAt(tr, t + D15_STEP_MS) : null;
    if (!p || !q) continue;
    const d = sub(q, p);
    distM += Math.hypot(d[0], d[1]);
    madeM += sign * dot(d, bearingVec(twdAt(t + D15_STEP_MS / 2)));
    readS += D15_STEP_MS / 1000;
  }
  return { distM, madeM, readS, read: b > a ? readS / ((b - a) / 1000) : 0 };
}

interface Rates {
  sog: number;
  vmg: number;
  ratio: number;
}

const ratesOf = (p: LegPath): Rates | null => (p.readS > 0 && p.madeM > 0 ? { sog: p.distM / p.readS, vmg: p.madeM / p.readS, ratio: p.distM / p.madeM } : null);

/** The fleet's leg paths, once per model and leg: every boat with the leg timed. */
const pathMemo = new WeakMap<CoachModel, Map<number, Map<string, LegPath>>>();
function fleetPaths(ctx: CoachCtx, k: number, kind: LegKind): Map<string, LegPath> {
  let byLeg = pathMemo.get(ctx.m);
  if (!byLeg) pathMemo.set(ctx.m, (byLeg = new Map()));
  let out = byLeg.get(k);
  if (!out) {
    out = new Map();
    for (const b of ctx.a.boats) {
      const l = b.legs[k];
      const tr = ctx.m.tracks.get(b.id);
      if (l && tr) out.set(b.id, legPath(tr, l.startMs, l.endMs, ctx.m.wind.twdAt, kind));
    }
    byLeg.set(k, out);
  }
  return out;
}

/** The boat against the fleet on leg `k` (see the header); null when either side is too thin to read. */
export interface LegProgress {
  leg: number;
  kind: LegKind;
  boat: Rates;
  fleet: Rates;
  n: number;
  /** Fleet boats with ≥ 80 % / ≥ 50 % of the leg read. */
  good: number;
  fair: number;
  read: number;
  legS: number;
  t0: number;
  t1: number;
}

export function legProgress(ctx: CoachCtx, k: number): LegProgress | null {
  const kind = ctx.a.legs[k]?.kind;
  const l = ctx.me.legs[k];
  if ((kind !== 'upwind' && kind !== 'downwind') || !l) return null;
  const paths = fleetPaths(ctx, k, kind);
  const mine = paths.get(ctx.boat);
  const boat = mine && mine.read >= D15_MIN_READ ? ratesOf(mine) : null;
  if (!boat) return null;
  const refs = [...paths.entries()].filter(([id, p]) => id !== ctx.boat && p.read >= D15_MIN_READ).map(([, p]) => ({ p, r: ratesOf(p) })).filter((x): x is { p: LegPath; r: Rates } => !!x.r);
  if (refs.length < D15_MIN_REFS) return null;
  const fleet = { sog: median(refs.map((x) => x.r.sog)), vmg: median(refs.map((x) => x.r.vmg)), ratio: median(refs.map((x) => x.r.ratio)) };
  return { leg: k, kind, boat, fleet, n: refs.length, good: refs.filter((x) => x.p.read >= 0.8).length, fair: refs.length, read: mine!.read, legS: l.timeS, t0: l.startMs, t1: l.endMs };
}

/** Its VMG and path ratio say the boat went nowhere on the leg (whatever its speed). */
export const progressWorse = (p: LegProgress): boolean => p.boat.vmg <= p.fleet.vmg * (1 - D15_VMG_DROP) && p.boat.ratio >= p.fleet.ratio * (1 + D15_PATH_EXTRA);

export interface D15Result {
  opps: Opportunity[];
  good: GoodNote[];
  /** Legs whose progress contradicts a "fine" (progressWorse). */
  worse: number[];
  legs: LegProgress[];
}

export function detectNowhere(ctx: CoachCtx): D15Result {
  const out: D15Result = { opps: [], good: [], worse: [], legs: [] };
  ctx.a.legs.forEach((leg, k) => {
    const p = legProgress(ctx, k);
    if (!p) return;
    out.legs.push(p);
    if (progressWorse(p)) out.worse.push(k);
    const fast = p.boat.sog >= p.fleet.sog * (1 - D15_SOG_TOL);
    const ang = legAngles(ctx, k);
    const facts = {
      leg: leg.name,
      legKind: p.kind,
      sog: p.boat.sog * MS_TO_KN,
      fSog: p.fleet.sog * MS_TO_KN,
      vmg: p.boat.vmg * MS_TO_KN,
      fVmg: p.fleet.vmg * MS_TO_KN,
      extraPct: p.boat.ratio / p.fleet.ratio - 1,
      // Extra distance over the leg: its progress at the fleet's path ratio vs at its own, m.
      extraM: p.legS * p.boat.vmg * (p.boat.ratio - p.fleet.ratio),
      twa: ang ? ang.boat.twa : null,
      fTwa: ang ? ang.fleet.twa : null,
      n: p.n,
    };
    if (fast && progressWorse(p)) {
      const deficit = (p.fleet.vmg - p.boat.vmg) / p.fleet.vmg;
      const seconds = deficit * p.legS;
      const cov = coachCoverage(ctx.tr.t, p.t0, p.t1);
      const noise = NOISE_BASE_S + RATE_REL_ERR * seconds;
      out.opps.push({
        kind: 'D15',
        variant: p.kind,
        t0: p.t0,
        t1: p.t1,
        seconds,
        secondsLo: Math.max(0, seconds - noise),
        secondsHi: seconds + noise,
        confidence: 'high',
        coverage: cov,
        conf: { boatCov: cov, refs: { good: p.good, fair: p.fair, need: 3 }, windOk: windOkShare(ctx.m.wind, p.t0, p.t1) },
        facts: { ...facts, deficit },
        refBoats: [],
      });
    } else if (fast && p.boat.vmg >= p.fleet.vmg * (1 + D15_GOOD_GAIN) && p.boat.ratio <= p.fleet.ratio) {
      const seconds = (p.boat.vmg / p.fleet.vmg - 1) * p.legS;
      out.good.push({ kind: 'plus', detector: 'D15', variant: p.kind, facts: { ...facts, gainS: seconds }, t0: p.t0, t1: p.t1, seconds });
    }
  });
  return out;
}
