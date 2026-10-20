/**
 * What every detector reads: the analysis, the coach model, the chosen boat
 * and its track, the boat length, the reference sets (Vann's defaults:
 * `leaders` = the finish top 3 for the start, the boats 1–2 places ahead for
 * the last leg, the fleet for the angles), and the gap ladder against any set.
 */
import { matchClass } from '../../../data/classes';
import type { BoatResult, RaceAnalysis } from '../../types';
import type { CoachModel } from '../index';
import { groupIds } from '../groups';
import { gapSeries, type GapPoint } from '../ladder';
import type { CoachTrack } from '../tracks';

/** Boat length when the class is unknown, m. */
export const DEFAULT_LOA_M = 10;
/** The detectors' ladder step, ms. */
export const DETECT_STEP_MS = 5_000;

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
  /** Gap ladder of the boat to `ids` from `from` to `to` (DETECT_STEP_MS). */
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
    gaps: (ids, from, to) =>
      gapSeries(
        m.course,
        m.wind,
        m.vmg,
        tr,
        ids.map((id) => m.tracks.get(id)).filter((x): x is CoachTrack => !!x),
        from,
        to,
        DETECT_STEP_MS,
      ),
    nameOf: (id) => {
      const b = byId.get(id);
      return b?.name && b.name !== `#${b.sail}` ? b.name : (b?.sail ?? id);
    },
  };
}
