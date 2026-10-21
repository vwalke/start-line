/**
 * Which buoy of a leeward gate each boat rounded (D13's side read, also the legs table's and the leg stories'
 * "Gate L/R" chip). Pure, from the analysis alone: the gate's two tracked buoys (markOf: both tracked, neither
 * placed from the fleet's turns), each boat's track and its timed rounding there.
 *
 * - Gates: a leg that ends at a two-buoy gate, from a run (downwind) into a beat (upwind).
 * - Sides are named LOOKING UPWIND and derived geometrically, never from the feed's gateLeft / gateRight roles (in
 *   every cached race gateLeft is the left buoy looking downwind): left / right of the line from the gate's middle up
 *   the beat that follows (to the next turn). A gate is laid square to the wind, so any axis within a few tens of
 *   degrees of it names the buoys the same way, and this one needs no wind estimate.
 * - The side: the buoy nearer the boat at its closest approach to either, within GATE_SEARCH_MS of its timed rounding
 *   and within GATE_NEAR_M; only when the nearer is clearly nearer (dNear ÷ dFar ≤ GATE_SIDE_RATIO) and the boat's
 *   fixes are at most GATE_FIX_GAP_S apart within GATE_FIX_WINDOW_MS of the closest approach. Otherwise unknown.
 */
import { dot, len, sub, type Vec } from '../geo';
import type { RaceAnalysis } from '../types';
import { markOf } from './detectors/rounding';
import { coachTracks, type CoachTrack } from './tracks';

/** The boat's fixes at most this far apart… */
export const GATE_FIX_GAP_S = 6;
/** …within this long either side of its closest approach, ms. */
export const GATE_FIX_WINDOW_MS = 60_000;
/** The nearer buoy names the side only when nearer ÷ further is at most this. */
export const GATE_SIDE_RATIO = 0.6;
/** The closest approach to the nearer buoy at most this far, m. */
export const GATE_NEAR_M = 120;
/** The closest approach is looked for this long either side of the timed rounding, ms. */
export const GATE_SEARCH_MS = 2 * 60_000;

export type GateSide = 'left' | 'right';

/** A two-buoy gate ending leg `leg`: its buoys by side (looking upwind), its middle, and the unit vector up the beat after it. */
export interface GateGeom {
  leg: number;
  left: Vec;
  right: Vec;
  centre: Vec;
  /** Up the next beat (the gate's middle → the next turn), unit. */
  up: Vec;
}

/** One boat's rounding of a gate. */
export interface GateSideRead {
  id: string;
  side: GateSide;
  /** The closest approach, ms. */
  tMs: number;
  /** Distance to the nearer and the further buoy there, m. */
  dNear: number;
  dFar: number;
}

/** The two-buoy gates of the race (see the header): one per leg that ends at one. */
export function gateGeoms(a: Pick<RaceAnalysis, 'legs' | 'marks' | 'legSource' | 'legPts'>): GateGeom[] {
  const pts = a.legPts;
  if (!pts || pts.length !== a.legs.length + 1) return [];
  const out: GateGeom[] = [];
  for (let k = 0; k + 1 < a.legs.length; k++) {
    if (a.legs[k].kind !== 'downwind' || a.legs[k + 1].kind !== 'upwind') continue;
    const mk = markOf(a, pts, k);
    if (!mk || !mk.gate || mk.estimated || mk.pts.length !== 2) continue;
    const centre: Vec = [(mk.pts[0][0] + mk.pts[1][0]) / 2, (mk.pts[0][1] + mk.pts[1][1]) / 2];
    const v = sub(pts[k + 2], centre);
    const L = len(v);
    if (!(L > 0)) continue;
    const up: Vec = [v[0] / L, v[1] / L];
    // Right looking up the beat: the up vector turned 90° clockwise (x east, y north).
    const right: Vec = [up[1], -up[0]];
    const [p, q] = dot(sub(mk.pts[0], centre), right) > 0 ? [mk.pts[1], mk.pts[0]] : [mk.pts[0], mk.pts[1]];
    out.push({ leg: k, left: p, right: q, centre, up });
  }
  return out;
}

/** Track `tr`'s longest gap between fixes over [a, b] (the ends count: no fix near them is a gap), s. */
function maxGapS(t: ArrayLike<number>, a: number, b: number): number {
  let last = a;
  let gap = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < a) continue;
    if (t[i] > b) break;
    gap = Math.max(gap, t[i] - last);
    last = t[i];
  }
  return Math.max(gap, b - last) / 1000;
}

/** Boat `tr`'s side at gate `g` (see the header); null when unknown. `roundMs`: its timed rounding there. */
export function sideRead(tr: Pick<CoachTrack, 'id' | 't' | 'x' | 'y'>, g: GateGeom, roundMs: number): GateSideRead | null {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < tr.t.length; i++) {
    if (tr.t[i] < roundMs - GATE_SEARCH_MS) continue;
    if (tr.t[i] > roundMs + GATE_SEARCH_MS) break;
    const p: Vec = [tr.x[i], tr.y[i]];
    const d = Math.min(len(sub(p, g.left)), len(sub(p, g.right)));
    if (d < bestD) [best, bestD] = [i, d];
  }
  if (best < 0 || bestD > GATE_NEAR_M) return null;
  const tMs = tr.t[best];
  if (maxGapS(tr.t, tMs - GATE_FIX_WINDOW_MS, tMs + GATE_FIX_WINDOW_MS) > GATE_FIX_GAP_S) return null;
  const p: Vec = [tr.x[best], tr.y[best]];
  const dl = len(sub(p, g.left));
  const dr = len(sub(p, g.right));
  const [dNear, dFar] = dl <= dr ? [dl, dr] : [dr, dl];
  if (!(dFar > 0) || dNear / dFar > GATE_SIDE_RATIO) return null;
  return { id: tr.id, side: dl <= dr ? 'left' : 'right', tMs, dNear, dFar };
}

/** Every boat's side at gate `g` whose side is known, from `tracks` (bounds: the timed roundings). */
export function gateSideReads(tracks: Iterable<Pick<CoachTrack, 'id' | 't' | 'x' | 'y' | 'bounds'>>, g: GateGeom): Map<string, GateSideRead> {
  const out = new Map<string, GateSideRead>();
  for (const tr of tracks) {
    const r = tr.bounds[g.leg + 1];
    if (r == null) continue;
    const s = sideRead(tr, g, r);
    if (s) out.set(tr.id, s);
  }
  return out;
}

const memo = new WeakMap<object, Map<number, Map<string, GateSide>>>();

/** Per gate leg, each boat's side (the analysis's drawn tracks); worked out once per analysis. Empty with no tracked gate. */
export function gateSides(a: RaceAnalysis): Map<number, Map<string, GateSide>> {
  let m = memo.get(a);
  if (m) return m;
  m = new Map();
  const gs = gateGeoms(a);
  if (gs.length && a.drawings) {
    const tracks = coachTracks(a);
    for (const g of gs) m.set(g.leg, new Map([...gateSideReads(tracks, g)].map(([id, s]) => [id, s.side])));
  }
  memo.set(a, m);
  return m;
}
