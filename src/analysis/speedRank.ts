/**
 * Who sailed a leg (or the race) fastest: elapsed-time ranks for the map's
 * "Colour: Speed" mode. Pure; the colours live in ui/speed.ts.
 *
 * Ties share a rank (competition ranking: 1, 2, 2, 4). `t` is rank-based,
 * (rank - 1) / (worst rank - 1), so 0 = fastest and 1 = slowest: one very slow
 * outlier can't squash the rest of the fleet into one colour, as a time-based
 * scale would.
 */
import type { BoatResult } from './types';

export interface SpeedRank {
  rank: number;
  /** How many boats were ranked. */
  of: number;
  timeS: number;
  /** The time spans a telemetry gap (the table's `~`): the longest such gap, s; else null. */
  gapS: number | null;
  /** 0 = fastest … 1 = slowest. */
  t: number;
}

interface Entry {
  id: string;
  key: number;
  timeS: number;
  gapS: number | null;
}

const valid = (x: number | null | undefined): x is number => x != null && Number.isFinite(x) && x > 0;

function rankEntries(entries: Entry[]): Map<string, SpeedRank> {
  const sorted = [...entries].sort((p, q) => p.key - q.key || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const out = new Map<string, SpeedRank>();
  const ranks: number[] = [];
  sorted.forEach((e, i) => ranks.push(i > 0 && e.key === sorted[i - 1].key ? ranks[i - 1] : i + 1));
  const worst = ranks.length ? ranks[ranks.length - 1] : 1;
  sorted.forEach((e, i) => {
    out.set(e.id, { rank: ranks[i], of: sorted.length, timeS: e.timeS, gapS: e.gapS, t: worst > 1 ? (ranks[i] - 1) / (worst - 1) : 0 });
  });
  return out;
}

/** Boats that completed leg `leg`, ranked by their time on it. */
export function legRanks(boats: BoatResult[], leg: number): Map<string, SpeedRank> {
  const entries: Entry[] = [];
  for (const b of boats) {
    const l = b.legs[leg];
    if (l && valid(l.timeS)) entries.push({ id: b.id, key: l.timeS, timeS: l.timeS, gapS: l.distGapS });
  }
  return rankEntries(entries);
}

/** `legRanks` for every leg, by leg index. */
export function raceLegRanks(boats: BoatResult[], legCount: number): Map<string, SpeedRank>[] {
  return Array.from({ length: legCount }, (_, i) => legRanks(boats, i));
}

/**
 * Finishers ranked by elapsed race time. If any finisher lacks a race time,
 * the whole ranking falls back to finish position (one consistent order).
 * Non-finishers are unranked.
 */
export function overallRanks(boats: BoatResult[]): Map<string, SpeedRank> {
  const finishers = boats.filter((b) => b.finishPos != null || valid(b.raceTimeS));
  const byTime = finishers.every((b) => valid(b.raceTimeS));
  const gap = (b: BoatResult): number | null => {
    const gs = b.legs.map((l) => l?.distGapS).filter((g): g is number => g != null);
    return gs.length ? Math.max(...gs) : null;
  };
  const entries: Entry[] = [];
  for (const b of finishers) {
    const key = byTime ? b.raceTimeS : b.finishPos;
    if (key == null || !Number.isFinite(key)) continue;
    entries.push({ id: b.id, key, timeS: valid(b.raceTimeS) ? b.raceTimeS : NaN, gapS: gap(b) });
  }
  return rankEntries(entries);
}
