/**
 * What every detector reads: the analysis, the coach model, the chosen boat
 * and its track, the boat length, the reference sets (Vann's defaults:
 * `leaders` = the finish top 3 for the start, the boats 1–2 places ahead for
 * the last leg, the fleet for the angles), and the gap to any set of boats: the chart's own series (timeGap.ts
 * groupGap: time at equal course progress, the same points), so a card never reads another gap than the chart.
 */
import { matchClass } from '../../../data/classes';
import type { BoatResult, RaceAnalysis } from '../../types';
import type { CoachModel } from '../index';
import { groupIds } from '../groups';
import type { GapPoint } from '../ladder';
import { GAP_STEP_MS, groupGap } from '../timeGap';
import type { CoachTrack } from '../tracks';

/** Boat length when the class is unknown, m. */
export const DEFAULT_LOA_M = 10;
/** The detectors' gap step, ms: the chart's (they read its points). */
export const DETECT_STEP_MS = GAP_STEP_MS;

export interface CoachCtx {
  a: RaceAnalysis;
  m: CoachModel;
  boat: string;
  me: BoatResult;
  tr: CoachTrack;
  gun: number;
  /** Hull length, m. */
  loaM: number;
  /** The finish top 3 (other than the boat), fixed for the race. */
  leaders: string[];
  /** Marks placed from the fleet's turns, not trackers (caps D10 at medium). */
  marksEstimated: boolean;
  /**
   * The boat's gap to `ids` from `from` to `to`: the chart's points (timeGap.ts groupGap, every DETECT_STEP_MS from the
   * gun), `behindS` the median of `ids` as the chart draws it for that group, `each` each boat's own (thin) line.
   */
  gaps: (ids: string[], from: number, to: number) => GapPoint[];
  /** Boat name by id ("Patriot"), the sail when unnamed. */
  nameOf: (id: string) => string;
}

export function coachCtx(a: RaceAnalysis, m: CoachModel, boat: string): CoachCtx | null {
  const me = a.boats.find((b) => b.id === boat);
  const tr = m.tracks.get(boat);
  if (!me || !tr) return null;
  const loaM = matchClass([a.meta.classLabel, a.meta.boatClass, a.meta.division])?.dims.loaM ?? DEFAULT_LOA_M;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  return {
    a,
    m,
    boat,
    me,
    tr,
    gun: a.meta.gunMs,
    loaM,
    leaders: groupIds(a.boats, boat, { kind: 'leaders' }),
    marksEstimated: a.legSource === 'fleet' || a.marks.some((k) => k.estimated),
    gaps: (ids, from, to) => groupGap(m, boat, ids, from, to),
    nameOf: (id) => {
      const b = byId.get(id);
      return b?.name && b.name !== `#${b.sail}` ? b.name : (b?.sail ?? id);
    },
  };
}
