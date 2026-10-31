/**
 * One boat's start, small: what the Coach's Regatta view draws as a thumbnail of the line at the gun (every boat's
 * bow and heading, the line's ends, the wind) with the boat's distance behind the line, where along the line it was and
 * the favored end; and the gun readout the Start findings show for the selected boat in the terms a Vakaros display
 * uses (SOG, VMG, HDG, TWA, distance to the line). Pure: the worker builds the digest, the UI draws it.
 *
 * The distance is the one the Start view shows (the ranked figure, Vakaros when valid, else ours from the bow), and
 * never says over: a boat is over early only when race control called it (`called`).
 */
import type { ClassDims } from '../data/classes';
import { raceClass } from '../data/classes';
import { primaryDtlM } from './findings';
import type { Vec } from './geo';
import { biasAngle, lineBias } from './line';
import type { BoatResult, RaceAnalysis, StartResult } from './types';

/** Where along the line, from the pin (0 %) to the RC (100 %): the outer thirds are its ends. */
export type LinePart = 'pin' | 'middle' | 'rc';
/** Up to this share of the line from an end is that end. */
export const LINE_END_SHARE = 1 / 3;

export const linePart = (pct: number): LinePart => (pct <= 100 * LINE_END_SHARE ? 'pin' : pct >= 100 * (1 - LINE_END_SHARE) ? 'rc' : 'middle');

/** One boat in a start thumbnail: its bow in local metres (east, north) from the line's middle, and the way its hull points (° true). */
export interface ThumbBoat {
  sail: string;
  bow: Vec;
  hdg: number;
}

/** The favored end at the gun, as the Start view's label says it: "Pin favored 7°". */
export interface FavoredEnd {
  end: 'pin' | 'rc' | 'square';
  /** Degrees off square (0–90). */
  deg: number;
  /** How much further upwind the favored end is, m. */
  byM: number;
}

export interface StartDigest {
  /** The wind at the gun the picture is turned to (wind at the top), ° true. */
  twdDeg: number;
  /** The line's pin and RC ends, local metres from its middle. */
  pin: Vec;
  rc: Vec;
  boats: ThumbBoat[];
  /** The class's hull (null: no dimensions, the boats are arrows). */
  dims: ClassDims | null;
  fav: FavoredEnd;
  /** The boat's own start: null when it has no start figures. */
  me: {
    /** Behind the line at the gun, m (as the Start view shows it); null when unknown. */
    dtlM: number | null;
    /** 0 = pin end, 100 = RC end. */
    linePct: number;
    /** Race control called it over early (RaceSense OCS, official OCS / UFD / BFD). */
    called: boolean;
  } | null;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

/** The favored end of the line at the gun. */
export function favoredEnd(a: Pick<RaceAnalysis, 'line' | 'wind'>): FavoredEnd {
  const b = lineBias(a.line, a.wind.twdAtGunDeg);
  return { end: b.favored === 'left' ? 'pin' : b.favored === 'right' ? 'rc' : 'square', deg: Math.round(biasAngle(b)), byM: Math.round(b.byM) };
}

/** The Start view's distance for a start: the ranked figure, else ours. */
export const shownDtlM = (st: StartResult): number => primaryDtlM(st) ?? st.dtlM;

/**
 * Boat `id`'s start as a thumbnail and its three facts: the Start view's boats (its bows within reach of the line, the
 * ones away from it left out as its Fit leaves them), rounded to 0.1 m to keep the digest small.
 */
export function startDigest(a: RaceAnalysis, id: string): StartDigest | null {
  const mid: Vec = [(a.line.left[0] + a.line.right[0]) / 2, (a.line.left[1] + a.line.right[1]) / 2];
  const rel = (p: Vec): Vec => [r1(p[0] - mid[0]), r1(p[1] - mid[1])];
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const boats: ThumbBoat[] = [];
  for (const d of a.drawings) {
    const b = byId.get(d.id);
    const hdg = d.headingAtSample ?? d.courseAtGun;
    if (!b?.start || !d.bow || hdg == null || b.start.awayFromLine) continue;
    boats.push({ sail: b.sail, bow: rel(d.bow), hdg: Math.round(hdg) });
  }
  if (!boats.length) return null;
  const me = a.boats.find((b) => b.id === id);
  const st = me?.start;
  return {
    twdDeg: Math.round(a.wind.twdAtGunDeg),
    pin: rel(a.line.left),
    rc: rel(a.line.right),
    boats,
    dims: raceClass(a.meta)?.dims ?? null,
    fav: favoredEnd(a),
    me: st ? { dtlM: Number.isFinite(shownDtlM(st)) ? r1(shownDtlM(st)) : null, linePct: Math.round(st.linePosPct), called: st.over } : null,
  };
}

/** The gun readout (Vakaros terms): SOG and VMG (kn), heading (°), TWA (° and tack), distance to the line (m). */
export interface GunReadout {
  sogKn: number;
  /** Speed made good toward the wind, kn: SOG × cos TWA (the start display's VMG). */
  vmgKn: number;
  hdgDeg: number;
  /** TWA, unsigned (0–180), and its tack: + starboard. */
  twaDeg: number;
  tack: 'starboard' | 'port';
  /** As the Start view shows it; null when unknown. */
  dtlM: number | null;
}

/**
 * Boat `b`'s readout at the gun; null without start figures. TWA and VMG rest on the wind at the gun, which is always
 * worked out (the fleet's tacks, a weather model or the course), never measured: the UI marks them "(est.)" as the
 * wind arrow does.
 */
export function gunReadout(b: Pick<BoatResult, 'start'>): GunReadout | null {
  const st = b.start;
  if (!st || !Number.isFinite(st.speedKn) || !Number.isFinite(st.twaDeg) || !Number.isFinite(st.headingDeg)) return null;
  const twa = Math.abs(st.twaDeg);
  const dtl = shownDtlM(st);
  return {
    sogKn: st.speedKn,
    vmgKn: st.speedKn * Math.cos((twa * Math.PI) / 180),
    hdgDeg: ((Math.round(st.headingDeg) % 360) + 360) % 360,
    twaDeg: twa,
    tack: st.twaDeg >= 0 ? 'starboard' : 'port',
    dtlM: Number.isFinite(dtl) ? dtl : null,
  };
}
