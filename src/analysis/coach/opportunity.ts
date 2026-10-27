/**
 * Recall Coach, phase 2 (spec §2, §5): what every detector emits, and the
 * shared arithmetic — gap reads off the chart's points (timeGap.ts groupGap: the
 * gap at equal course progress), the noise model, coverage and confidence.
 * Detectors live in detectors/*.ts; rank.ts ranks and gates.
 */
import { coverage } from '../coverage';
import type { GapPoint } from './ladder';
import { COACH_MAX_SPAN_S } from './tracks';

export type DetectorKind = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8' | 'D9' | 'D10' | 'D11' | 'D12' | 'D13' | 'D14' | 'D15' | 'D16' | 'D17';
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
  /** The chart's points its seconds were read from (a Δgap card): the same values the Coach chart shows for that group then. */
  gaps?: GapReading[];
}

/**
 * Two of the chart's points a card read (timeGap.ts groupGap, s, + = behind): the mean or median of `ids` (groupStat; the bold line with
 * that group: Custom, or Top 3 when they are the leaders), or `boat`'s own line (a thin line). A Δgap is g1 − g0.
 */
export interface GapReading {
  ids: string[];
  boat?: string;
  t0: number;
  g0: number;
  t1: number;
  g1: number;
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
  /** ✓: the boat's coverage of the stretch judged (coachCoverage), 0–1. */
  coverage?: number;
  /** ✓ on thin data (coverage under OK_THIN_COVERAGE): the row says "Not judged: …", never "fine". */
  thin?: boolean;
  /** ➕ read off the gap: the chart's points (Opportunity.gaps). */
  gaps?: GapReading[];
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
 * The Coach's coverage of [a, b]: time between fixes at most COACH_MAX_SPAN_S apart — what the gap
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
 * The series is measured on the beats, and on the runs only where the fleet's gybes give a reading (asymmetric kites),
 * so a run often sits between or after measured minutes; only a longer gap is a doubt.
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
 * A low-confidence card's seconds count toward its impact up to this much, s (twice its minimum): its estimate leans on
 * interpolation across holes, which grows with the hole, not with what was lost. The card still shows all its seconds.
 */
export const LOW_IMPACT_CAP_S = 2 * MIN_SECONDS.low;
/** The seconds that count toward the impact per confidence (rank.ts impactOf). */
export const IMPACT_CAP_S: Record<Confidence, number> = { high: Infinity, medium: Infinity, low: LOW_IMPACT_CAP_S, none: 0 };
/** A card's impact on the result, the score it is ranked by: its seconds lost (capped at low confidence) × its confidence's weight. */
export const impactOf = (seconds: number, level: Confidence): number => CONF_WEIGHT[level] * Math.min(seconds, IMPACT_CAP_S[level]);
/**
 * D1 is gated by its own rules (start.ts: from 4–6 s behind the front row, or two lengths back at the gun), measured
 * off crossing times rather than modelled: at high confidence its card needs only this much, s (its smallest trigger).
 */
export const D1_MIN_S = 4;
/**
 * D17 at medium needs only this much, s (the high minimum): its seconds are measured turn by turn on dense fixes, not
 * modelled across holes, its medium is the sample size's (detectors/manoeuvreCost.ts D17_HIGH_MEASURED), and its own
 * test (2 standard errors from the fleet) already stands for the noise the medium minimum guards against.
 */
export const D17_MEDIUM_MIN_S = MIN_SECONDS.high;
/** Fewest seconds a card of `kind` may show at `level`. */
export const minSeconds = (kind: DetectorKind, level: Confidence): number =>
  kind === 'D1' && level === 'high' ? D1_MIN_S : kind === 'D17' && level === 'medium' ? D17_MEDIUM_MIN_S : MIN_SECONDS[level];

// ---- gap reads

/**
 * A Δgap's two reads are at least this far apart, ms. Each is one of the chart's points (timeGap.ts groupGap), not a
 * median around it: the card's seconds are then exactly the chart's change between the two (the progress gap is
 * already a fixed group's mean or median, read across holes, so it doesn't need smoothing).
 */
export const GAP_READ_MS = 60_000;

/** The point nearest `t` within `reachMs` that has a value (`pick`), the earlier on a tie: its time and value; null with none. */
export function gapNear(
  points: readonly GapPoint[],
  t: number,
  reachMs: number,
  pick: (p: GapPoint) => number | null = (p) => p.behindS,
): { tMs: number; g: number } | null {
  let best: { tMs: number; g: number; d: number } | null = null;
  for (const p of points) {
    const d = Math.abs(p.tMs - t);
    if (d > reachMs || (best && d >= best.d)) continue;
    const g = pick(p);
    if (g != null) best = { tMs: p.tMs, g, d };
  }
  return best && { tMs: best.tMs, g: best.g };
}

/**
 * Δgap over a window (spec §2): the chart's value at the first point in [a, b] that has one (`pick`), to its value at
 * the last; with when those are. Null when they are under GAP_READ_MS apart.
 */
export function gapChange(
  points: readonly GapPoint[],
  a: number,
  b: number,
  pick: (p: GapPoint) => number | null = (p) => p.behindS,
): { g0: number; g1: number; t0: number; t1: number } | null {
  const ok = points.filter((p) => p.tMs >= a && p.tMs <= b && pick(p) != null);
  if (ok.length < 2) return null;
  const first = ok[0];
  const last = ok[ok.length - 1];
  if (last.tMs - first.tMs < GAP_READ_MS) return null;
  return { g0: pick(first)!, g1: pick(last)!, t0: first.tMs, t1: last.tMs };
}

/** A GapReading of a gapChange against `ids` (or `boat`'s own line). */
export const reading = (ids: readonly string[], g: { g0: number; g1: number; t0: number; t1: number }, boat?: string): GapReading => ({
  ids: [...ids],
  ...(boat != null ? { boat } : {}),
  t0: g.t0,
  g0: g.g0,
  t1: g.t1,
  g1: g.g1,
});
