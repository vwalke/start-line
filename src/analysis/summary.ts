/**
 * Upwind and downwind summaries: each boat's legs of one kind added up, so a
 * beat-and-run race reads as "how did I go upwind, how did I go downwind".
 * Reaches are in neither. Times, distances and manoeuvres add; SOG is total
 * distance ÷ total time; VMG, |TWA| and coverage are weighted by leg time
 * (VMG weighted so equals total distance made good ÷ total time). Heel pools
 * every fix it rests on (each leg weighted by its heel time), so it equals the
 * time-weighted mean over all the legs; trim and heel coverage are weighted by
 * leg time over the legs that have them.
 */
import { M_PER_NM } from './distance';
import { competitionRanks } from './speedRank';
import type { BoatResult, KindSummary, LegDef, LegResult } from './types';

export type SummaryKind = 'upwind' | 'downwind';

/** One boat's summary over the legs of `kind`; null if the race has none or the boat completed none. */
export function kindSummary(legs: (LegResult | null)[], defs: LegDef[], kind: SummaryKind): KindSummary | null {
  const idx = defs.filter((d) => d.kind === kind).map((d) => d.index);
  const done = idx.map((i) => legs[i]).filter((l): l is LegResult => l != null && l.timeS > 0);
  if (!done.length) return null;
  const timeS = done.reduce((s, l) => s + l.timeS, 0);
  const distM = done.reduce((s, l) => s + l.distM, 0);
  const wmean = (f: (l: LegResult) => number): number => done.reduce((s, l) => s + f(l) * l.timeS, 0) / timeS;
  /** Mean of `f` over the legs that have it, each weighted by `w`; null when none does. */
  const pooled = (f: (l: LegResult) => number | null, w: (l: LegResult) => number): number | null => {
    const has = done.filter((l) => f(l) != null && w(l) > 0);
    const W = has.reduce((s, l) => s + w(l), 0);
    return W > 0 ? has.reduce((s, l) => s + f(l)! * w(l), 0) / W : null;
  };
  return {
    legs: done.length,
    of: idx.length,
    complete: done.length === idx.length,
    timeS,
    distM,
    distApprox: done.some((l) => l.distGapS != null),
    timeApprox: done.some((l) => l.timeGapS != null),
    sogKn: distM / M_PER_NM / (timeS / 3600),
    vmgKn: wmean((l) => l.vmgKn),
    twaDeg: wmean((l) => l.twaDeg),
    tacks: done.reduce((s, l) => s + l.tacks, 0),
    gybes: done.reduce((s, l) => s + l.gybes, 0),
    manoeuvreApprox: done.some((l) => l.manoeuvreGap),
    coverage: wmean((l) => l.coverage),
    maxGapS: Math.max(...done.map((l) => l.maxGapS)),
    heelDeg: pooled((l) => l.heelDeg, (l) => l.heelS),
    trimDeg: pooled((l) => l.trimDeg, (l) => l.timeS),
    heelCoverage: pooled((l) => l.heelCoverage, (l) => l.timeS),
    place: null,
  };
}

/** Place each boat's complete `kind` summary by total time (competition ranking); incomplete ones stay unplaced. */
export function placeSummaries(boats: BoatResult[], kind: SummaryKind): void {
  const ranked = boats
    .map((b) => b[kind])
    .filter((s): s is KindSummary => s != null && s.complete)
    .sort((p, q) => p.timeS - q.timeS);
  const ranks = competitionRanks(ranked.map((s) => s.timeS));
  ranked.forEach((s, i) => (s.place = ranks[i]));
}
