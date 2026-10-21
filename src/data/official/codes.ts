/**
 * Yachtscoring's scoring codes (`finishStatus` other than AOK): what each means in plain words, and
 * whether the boat finished and kept an on-water place (a penalty added to a finish) or was scored as
 * not finishing. One table; the adapter, the analysis and the Coach read it.
 *
 * - 'penalty': finished, scored with points added (DPI, SCP, ZFP, ZPF; RDG adjusts the score). The boat keeps
 *   its finish, race time and legs, and gets an on-water place (onWaterPlace) next to the scored points.
 * - 'excluded': disqualified (DSQ, UFD, BFD). With a finish time the boat sailed the course: it keeps its finish
 *   and on-water place like a penalised finisher, but the race scores as lost. Without one, as 'not-finished'.
 * - 'not-finished': DNF, RET, OCS (never cleared, or scored so), TLE, NSC; scored entries + 1 or a set score.
 * - 'not-started': DNS, DNC, DNE (fleet.ts neverRaced).
 */

export type CodeKind = 'penalty' | 'excluded' | 'not-finished' | 'not-started';

export interface CodeInfo {
  kind: CodeKind;
  /** Plain words: "Discretionary penalty: the protest committee added points instead of disqualifying". */
  meaning: string;
  /** The race's result is lost (scored as a non-finisher), whatever the boat did on the water. */
  lost: boolean;
  /** A start penalty (over the line): its over-the-line figures ride on the penalty card. */
  start?: boolean;
}

export const CODES: Record<string, CodeInfo> = {
  DPI: { kind: 'penalty', meaning: 'Discretionary penalty: the protest committee added points instead of disqualifying', lost: false },
  SCP: { kind: 'penalty', meaning: 'Scoring penalty: points added for a rule broken, taken instead of turns', lost: false },
  ZFP: { kind: 'penalty', meaning: 'Z-flag penalty: 20% added for being in the start triangle in the last minute', lost: false },
  ZPF: { kind: 'penalty', meaning: 'Z-flag penalty: 20% added for being in the start triangle in the last minute', lost: false },
  RDG: { kind: 'penalty', meaning: 'Redress given: the protest committee adjusted the score', lost: false },
  DSQ: { kind: 'excluded', meaning: 'Disqualified', lost: true },
  UFD: { kind: 'excluded', meaning: 'U-flag disqualification: in the start triangle in the last minute', lost: true, start: true },
  BFD: { kind: 'excluded', meaning: 'Black-flag disqualification: in the start triangle in the last minute', lost: true, start: true },
  OCS: { kind: 'not-finished', meaning: 'On the course side at the start and did not return to start correctly', lost: true, start: true },
  DNF: { kind: 'not-finished', meaning: 'Did not finish', lost: true },
  RET: { kind: 'not-finished', meaning: 'Retired', lost: true },
  TLE: { kind: 'not-finished', meaning: 'Finished outside the time limit', lost: true },
  NSC: { kind: 'not-finished', meaning: 'Did not sail the course', lost: true },
  DNS: { kind: 'not-started', meaning: 'Did not start', lost: true },
  DNC: { kind: 'not-started', meaning: 'Did not come to the starting area', lost: true },
  DNE: { kind: 'not-started', meaning: 'Disqualification that cannot be discarded', lost: true },
};

/** A code's row; an unknown code is a lost result in its own name. */
export const codeInfo = (code: string): CodeInfo => CODES[code.toUpperCase()] ?? { kind: 'not-finished', meaning: `Scored ${code.toUpperCase()}`, lost: true };

/**
 * Whether a coded boat finished and keeps an on-water place: the penalty codes when the row has a finish time
 * (RDG without one is a set score), and DSQ / UFD / BFD when it has one. Everything else scores as not finishing.
 */
export function finishedWithCode(code: string, hasFinish: boolean): boolean {
  const k = codeInfo(code).kind;
  return hasFinish && (k === 'penalty' || k === 'excluded');
}

/** Places a penalty cost: scored points − on-water place, to 0.1 (SCP scores are fractional), never below 0. */
export function penaltyPlacesOf(points: number | null, onWater: number | null): number | null {
  if (points == null || onWater == null || !Number.isFinite(points) || !Number.isFinite(onWater)) return null;
  return Math.max(0, Math.round((points - onWater) * 10) / 10);
}

/** Points as Yachtscoring prints them: whole, or to one decimal (SCP 13.9). */
export const pointsText = (p: number): string => (Number.isInteger(p) ? String(p) : p.toFixed(1));
