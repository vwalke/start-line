/**
 * Reference sets: who the chosen boat is measured against (Chris's
 * "Ivan group", Vann's "boats near me"). A gap to a set is the median of the
 * gaps to its boats, so one boat's own mistake doesn't swing it.
 */
import type { BoatResult } from '../types';

export type GroupKind = 'leaders' | 'near' | 'fleet' | 'custom';
export type Group = { kind: 'leaders' } | { kind: 'near' } | { kind: 'fleet' } | { kind: 'custom'; ids: string[] };

/** Leaders: the first this many finishers (other than the chosen boat). */
export const LEADERS_N = 3;
/** Near: boats that finished within this many places of the chosen boat. */
export const NEAR_PLACES = 3;

/**
 * Each chart's default group (Vann): leaders for the start and shifts, the boats
 * near you for consolidation and the last leg. Phase 1 draws only the rival
 * ladder, a start-and-shifts view, so it opens on the top 3.
 */
export const DEFAULT_GROUPS = {
  rivalLadder: 'leaders',
  start: 'leaders',
  shift: 'leaders',
  consolidation: 'near',
  lastLeg: 'near',
} as const satisfies Record<string, Exclude<GroupKind, 'custom'>>;

export type CoachChart = keyof typeof DEFAULT_GROUPS;

export const defaultGroup = (chart: CoachChart): Group => ({ kind: DEFAULT_GROUPS[chart] });

type Ranked = Pick<BoatResult, 'id' | 'finishPos' | 'legs'>;

/** The boat's place: its finish, else its rank at the last mark it was timed at; null with neither. */
export function placeOf(b: Ranked): number | null {
  if (b.finishPos != null) return b.finishPos;
  for (let k = b.legs.length - 1; k >= 0; k--) {
    const r = b.legs[k]?.rankAtEnd;
    if (r != null) return r;
  }
  return null;
}

/**
 * The group's boats for `me` (never `me` itself), in finish order; ids not racing
 * are dropped. The set is fixed for the whole race: Top 3 / Near use the tracked
 * finish (not who was ahead on each leg); mid-race ranks do not change it.
 */
export function groupIds(boats: readonly Ranked[], me: string, g: Group): string[] {
  const others = boats.filter((b) => b.id !== me);
  const byFinish = others.filter((b) => b.finishPos != null).sort((a, b) => a.finishPos! - b.finishPos!);
  switch (g.kind) {
    case 'leaders':
      return byFinish.slice(0, LEADERS_N).map((b) => b.id);
    case 'near': {
      const mine = boats.find((b) => b.id === me);
      const p = mine ? placeOf(mine) : null;
      return p == null ? [] : byFinish.filter((b) => Math.abs(b.finishPos! - p) <= NEAR_PLACES).map((b) => b.id);
    }
    case 'fleet':
      return [...byFinish, ...others.filter((b) => b.finishPos == null)].map((b) => b.id);
    case 'custom': {
      const want = new Set(g.ids);
      return [...byFinish, ...others.filter((b) => b.finishPos == null)].filter((b) => want.has(b.id)).map((b) => b.id);
    }
  }
}
