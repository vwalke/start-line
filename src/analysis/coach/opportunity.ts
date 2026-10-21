/**
 * Recall Coach, phase 2 (spec §2, §5): what every detector emits, and the
 * shared arithmetic — gap reads off the ladder, the noise model, coverage and
 * confidence. Detectors live in detectors/*.ts; rank.ts ranks and gates.
 */
import { coverage } from '../coverage';
import { median } from '../geo';
import type { GapPoint } from './ladder';
import { COACH_MAX_SPAN_S } from './tracks';

export type DetectorKind = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8' | 'D9' | 'D10' | 'D11' | 'D12';
export type Confidence = 'high' | 'medium' | 'low' | 'none';

/** A fact for the card: a number (formatted by the template) or a name. */
export type Fact = number | string | null;

/** Why a detector's confidence is what it is (spec §5): each input caps it. */
export interface ConfInputs {
  /** The boat's coverage of the window, 0–1 (coachCoverage). */
  boatCov: number;
  /** Reference boats with ≥ 80 % / ≥ 50 % of the window, and how many it needs (3, or fewer when the set is smaller). */
  refs?: { good: number; fair: number; need: number };
  /** Share of the window's wind minutes measured (not interpolated), 0–1; absent when the detector doesn't use the wind. */
  windOk?: number;
  /** Wind-read detectors (D4, D5): (secondsHi − secondsLo) ÷ seconds, the noise range's share of the estimate (WIND_RANGE_SHARE). */
  rangeShare?: number;
  /** The marks were placed from the fleet's turns, not trackers. */
  marksEstimated?: boolean;
  /** D9: the mark was placed from the fleet's turns: the rounding can't be timed against it (spec §5: suppressed). */
  marksSuppress?: boolean;
  /** A ceiling set by what the boat is compared with (D9 against its own other roundings: medium; against boats other than the leaders: low). */
  refCap?: Confidence;
  /** The boat's longest hole in the window (named in a low-confidence chip). */
  hole?: { fromMs: number; toMs: number } | null;
}

export interface Opportunity {
  kind: DetectorKind;
  /** Which template (spec §6). */
  variant: string;
  /** The window, ms. Detectors summed over several stretches (D7 over the runs) list them in `spans`. */
  t0: number;
  t1: number;
  spans?: [number, number][];
  /**
   * Seconds that sit in parts of the window (the merged start card: D1's to the crossing, D3's after it):
   * dedupe trims each part by its own overlap, so a finding over the first minutes doesn't take the start's.
   */
  parts?: { t0: number; t1: number; seconds: number }[];
  /** Seconds at stake (+ = lost), and its noise range. */
  seconds: number;
  secondsLo: number;
  secondsHi: number;
  /** Set by rank.ts from `conf`. */
  confidence: Confidence;
  /** The boat's coverage of the window, 0–1. */
  coverage: number;
  conf: ConfInputs;
  facts: Record<string, Fact>;
  /** The boats it was measured against. */
  refBoats: string[];
  /** Attached findings (D2 on D3), as chip facts. */
  chips?: AttachedChip[];
  /** The window's numbers lean on the wind across a big separation (⚠ wind est.). */
  windEst?: boolean;
}

/** A finding folded into another card (D2 → D3, spec §5; D11 → D6 / D7 on the same leg). */
export interface AttachedChip {
  kind: DetectorKind;
  facts: Record<string, Fact>;
}

/** A detector that measured the boat as fine, with good data (the ✓ row), or a stretch that went well (➕). */
export interface GoodNote {
  kind: 'ok' | 'plus';
  detector: DetectorKind | 'gap';
  variant: string;
  facts: Record<string, Fact>;
  t0: number;
  t1: number;
  /** What it gained, s (➕ Went well: the items are ranked by it). */
  seconds?: number;
}

// ---- the noise model (spec §2)

/** Every gap figure is good to about this much, s. */
export const NOISE_BASE_S = 5;
/** Wind direction uncertainty used for the lateral-separation term, °. */
export const NOISE_TWD_DEG = 3;
/** Share of the boat's untracked seconds in the window added to the range. */
export const NOISE_HOLE_SHARE = 0.2;
/** Rate-type detectors (angles, speed): relative uncertainty of the rate × time estimate. */
export const RATE_REL_ERR = 0.15;
/** A separation-term this big (s) makes the card say ⚠ wind est. */
export const WIND_EST_S = 10;

/** ± seconds for a gap figure: base, plus lateral separation × wind error ÷ VMG, plus a share of the untracked time. */
export function gapNoise(lateralM: number, vmgMs: number | null, untrackedS: number): { noise: number; windS: number } {
  const windS = vmgMs && vmgMs > 0 ? (lateralM * NOISE_TWD_DEG * Math.PI) / 180 / vmgMs : 0;
  return { noise: NOISE_BASE_S + windS + NOISE_HOLE_SHARE * untrackedS, windS };
}

/** Lo/hi around `s`: never below 0. */
export const rangeOf = (s: number, noise: number): { secondsLo: number; secondsHi: number } => ({
  secondsLo: Math.max(0, s - noise),
  secondsHi: Math.max(0, s + noise),
});

// ---- coverage

/**
 * The Coach's coverage of [a, b]: time between fixes at most COACH_MAX_SPAN_S apart — what the ladder
 * and the course-over-ground pairs can read (a stricter 5 s gap counts a 1.5 s tracker with brief
 * dropouts as mostly missing). 0–1.
 */
export const coachCoverage = (t: ArrayLike<number> & { length: number }, a: number, b: number): number =>
  b > a ? coverage(t, a, b, COACH_MAX_SPAN_S).coverage : 0;

/** Untracked seconds of [a, b] by coachCoverage. */
export const untrackedS = (t: ArrayLike<number> & { length: number }, a: number, b: number): number => (1 - coachCoverage(t, a, b)) * Math.max(0, (b - a) / 1000);

/** How many references have ≥ 80 % / ≥ 50 % of the window. `need`: 3, or all of a smaller set. */
export function refCoverage(tracks: { t: ArrayLike<number> & { length: number } }[], a: number, b: number): { good: number; fair: number; need: number } {
  const cov = tracks.map((tr) => coachCoverage(tr.t, a, b));
  return { good: cov.filter((c) => c >= 0.8).length, fair: cov.filter((c) => c >= 0.5).length, need: Math.min(3, tracks.length) };
}

/**
 * A minute's wind counts as measured when a measured minute (twdSeries `ok`) is this close (about a leg), ms.
 * The series is measured on the beats only, so a run always sits between or after measured minutes; only a
 * longer gap is a doubt.
 */
export const WIND_NEAR_MS = 15 * 60_000;

/** Share of the wind minutes in [a, b] within WIND_NEAR_MS of a measured minute, 0–1 (1 with no minute inside). */
export function windOkShare(w: { t: number[]; ok: boolean[] }, a: number, b: number): number {
  const measured = w.t.filter((_, i) => w.ok[i]);
  let n = 0;
  let ok = 0;
  for (const t of w.t) {
    if (t < a - 30_000 || t > b + 30_000) continue;
    n++;
    if (measured.some((m) => Math.abs(m - t) <= WIND_NEAR_MS)) ok++;
  }
  return n ? ok / n : 1;
}

// ---- confidence (spec §5)

const RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };
const lowest = (cs: Confidence[]): Confidence => cs.reduce((m, c) => (RANK[c] < RANK[m] ? c : m), 'high' as Confidence);

/** Boat coverage → level: ≥ 80 % high, 50–80 % medium, 25–50 % low, below that suppressed. */
export const covLevel = (c: number): Confidence => (c >= 0.8 ? 'high' : c >= 0.5 ? 'medium' : c >= 0.25 ? 'low' : 'none');

/** What limits the confidence, most limiting first: 'data' | 'refs' | 'wind' | 'marks'. */
export type ConfLimit = 'data' | 'refs' | 'wind' | 'marks';

/** The confidence: the lowest of the boat's coverage, the references', the wind's, and the marks cap; with what set it. */
export function confidenceOf(c: ConfInputs): { level: Confidence; limit: ConfLimit | null } {
  const parts: [Confidence, ConfLimit][] = [[covLevel(c.boatCov), 'data']];
  if (c.refs) {
    const r = c.refs;
    parts.push([r.need === 0 ? 'none' : r.good >= r.need ? 'high' : r.fair >= r.need ? 'medium' : 'low', 'refs']);
  }
  if (c.windOk != null) parts.push([c.windOk >= 0.8 ? 'high' : c.windOk >= 0.5 ? 'medium' : 'low', 'wind']);
  if (c.rangeShare != null) {
    const [hi, med] = WIND_RANGE_SHARE;
    parts.push([c.rangeShare <= hi ? 'high' : c.rangeShare <= med ? 'medium' : 'low', 'wind']);
  }
  if (c.marksEstimated) parts.push(['medium', 'marks']);
  if (c.marksSuppress) parts.push(['none', 'marks']);
  if (c.refCap) parts.push([c.refCap, 'refs']);
  const level = lowest(parts.map((p) => p[0]));
  const limit = level === 'high' ? null : parts.find((p) => p[0] === level)![1];
  return { level, limit };
}

/**
 * D4/D5 lean on the wind across a separation (spec §5): the noise range (hi − lo) as a share of the
 * estimate up to the first value keeps the wind input high, up to the second medium, else low.
 */
export const WIND_RANGE_SHARE: [number, number] = [0.6, 1.2];

/** Score weight per confidence. */
export const CONF_WEIGHT: Record<Confidence, number> = { high: 1, medium: 0.7, low: 0.4, none: 0 };
/** Fewest seconds a card may show per confidence. */
export const MIN_SECONDS: Record<Confidence, number> = { high: 10, medium: 20, low: 30, none: Infinity };
/**
 * D1 is gated by its own rules (start.ts: from 4–6 s behind the front row, or two lengths back at the gun), measured
 * off crossing times rather than modelled: at high confidence its card needs only this much, s (its smallest trigger).
 */
export const D1_MIN_S = 4;
/** Fewest seconds a card of `kind` may show at `level`. */
export const minSeconds = (kind: DetectorKind, level: Confidence): number => (kind === 'D1' && level === 'high' ? D1_MIN_S : MIN_SECONDS[level]);

// ---- gap reads

/** One gap reading taken this wide (a median of the points), so one noisy fix doesn't move it, ms. */
export const GAP_READ_MS = 60_000;

/** The median of the group gaps at points in [a, b]; null with none. */
export function gapRead(points: readonly GapPoint[], a: number, b: number, pick: (p: GapPoint) => number | null = (p) => p.behindS): number | null {
  const v = points.filter((p) => p.tMs >= a && p.tMs <= b).map(pick).filter((x): x is number => x != null);
  return v.length ? median(v) : null;
}

/**
 * Δgap over a window (spec §2): the gap read in the first GAP_READ_MS that has one, to the gap read in the
 * last; with when those reads were. Null when the window has fewer than two readable minutes.
 */
export function gapChange(
  points: readonly GapPoint[],
  a: number,
  b: number,
  pick: (p: GapPoint) => number | null = (p) => p.behindS,
): { g0: number; g1: number; t0: number; t1: number } | null {
  const ok = points.filter((p) => p.tMs >= a && p.tMs <= b && pick(p) != null);
  if (ok.length < 2) return null;
  const first = ok[0].tMs;
  const last = ok[ok.length - 1].tMs;
  if (last - first < GAP_READ_MS) return null;
  const g0 = gapRead(ok, first, first + GAP_READ_MS, pick)!;
  const g1 = gapRead(ok, last - GAP_READ_MS, last, pick)!;
  return { g0, g1, t0: first, t1: last };
}
