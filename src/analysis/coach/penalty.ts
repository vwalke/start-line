/**
 * The penalty card (pinned above the ranked cards, outside the seconds ranking): the boat's official code, what it
 * means, and what it cost in places — "Cost 3 places — 12th on the water, scored 15th" for a points penalty (DPI,
 * SCP, …), "the result is lost" for a code that scores as not finishing (DSQ, UFD, BFD, OCS, DNF, …). A points
 * penalty has no seconds: it never takes a ranked slot, nor counts in the seconds at stake.
 *
 * It carries what the track shows of the penalty: the over-the-line figures of a scored OCS / UFD / BFD (it replaces
 * D1's 'ocs' card, "Over early — cleared", for that boat: debrief.ts), and penalty turns (D12) the boat sailed. With
 * no code, penalty turns are a ranked card of their own (turnCard), by the seconds they cost.
 */
import { codeInfo, type CodeKind } from '../../data/official/codes';
import { coachCoverage, rangeOf, NOISE_BASE_S, type Opportunity } from './opportunity';
import { TURN_RECOVER_MS, type PenaltyTurn } from './detectors/penaltyTurn';
import type { CoachCtx } from './detectors/context';
import { fleetOf } from './fleet';

export interface PenaltyFinding {
  code: string;
  /** Plain words (codes.ts). */
  meaning: string;
  kind: CodeKind;
  /** The race scores as lost (DSQ, UFD, OCS, DNF, …), whatever the boat did on the water. */
  lost: boolean;
  /** The official score, points; null when the results have none. */
  points: number | null;
  /** A boat that finished with the code: its place on the water, and the places the code cost (≥ 0). */
  onWater: number | null;
  penaltyPlaces: number | null;
  /** The fleet it is scored in. */
  of: number;
  /** A scored OCS / UFD / BFD over at the gun: how far over (m), when it went back and when it recrossed (s after the gun); each null when the track doesn't show it. */
  over: { overM: number | null; backS: number | null; clearedS: number | null } | null;
  /** Penalty turns on the track (D12), on this card rather than ranked. */
  turns: PenaltyTurn[];
}

/** When a scored start code's boat went back and recrossed (index.ts overStarts). */
export interface OverStart {
  wentBackMs: number | null;
  clearedMs: number | null;
}

/** The boat's penalty card; null with no official code. `overStart`: its return figures, when the code is a start code. */
export function penaltyOf(ctx: CoachCtx, turns: readonly PenaltyTurn[], overStart: OverStart | null = null): PenaltyFinding | null {
  const me = ctx.me;
  const code = me.finishCode;
  if (!code) return null;
  const info = codeInfo(code);
  const st = me.start;
  const s = (t: number | null): number | null => (t == null ? null : (t - ctx.gun) / 1000);
  const overBy = st ? (st.rank?.m ?? st.dtlM) : null;
  const over =
    info.start && st
      ? { overM: overBy != null && overBy < 0 ? -overBy : null, backS: s(overStart?.wentBackMs ?? null), clearedS: s(overStart?.clearedMs ?? ctx.m.crossMs?.[ctx.boat] ?? null) }
      : null;
  return {
    code,
    meaning: info.meaning,
    kind: info.kind,
    lost: info.lost,
    points: me.scoredPoints ?? null,
    onWater: me.onWaterPlace ?? null,
    penaltyPlaces: me.penaltyPlaces ?? null,
    of: fleetOf(ctx.a),
    over: over && (over.overM != null || over.backS != null || (st?.over && over.clearedS != null)) ? over : null,
    turns: [...turns],
  };
}

/** Seconds the turns cost (those with a reading). */
export const turnSeconds = (turns: readonly PenaltyTurn[]): number => turns.reduce((s, t) => s + (t.lostS ?? 0), 0);

/**
 * Penalty turns with no official code: one ranked card (D12, '360' or '720' by the most turns in one go) over every
 * loop, seconds = what they cost (turnSeconds); medium confidence on the feed, high from an uploaded log.
 */
export function turnCard(ctx: CoachCtx, turns: readonly PenaltyTurn[]): Opportunity | null {
  const read = turns.filter((t) => t.lostS != null);
  if (!read.length) return null;
  const seconds = turnSeconds(read);
  const spans = read.map((t): [number, number] => [t.t0, t.t1 + TURN_RECOVER_MS]);
  const t0 = spans[0][0];
  const t1 = spans[spans.length - 1][1];
  const cov = Math.min(...spans.map(([a, b]) => coachCoverage(ctx.tr.t, a, b)));
  const full = read.every((t) => t.conf === 'high');
  const most = Math.max(...read.map((t) => t.turns));
  return {
    kind: 'D12',
    variant: most === 2 ? '720' : '360',
    t0,
    t1,
    ...(spans.length > 1 ? { spans } : {}),
    seconds,
    ...rangeOf(seconds, NOISE_BASE_S * read.length),
    confidence: full ? 'high' : 'medium',
    coverage: cov,
    // The loop was found on fixes at most TURN_MAX_GAP_S apart (its window is covered by construction); a heading
    // loop read off the feed's positions is capped at medium, an uploaded log's full rate isn't.
    conf: { boatCov: 1, ...(full ? {} : { refCap: 'medium' as const }) },
    facts: { loops: read.length, turns: read.reduce((s, t) => s + t.turns, 0), firstMs: read[0].t0, firstS: (read[0].t0 - ctx.gun) / 1000, lostS: seconds },
    refBoats: [],
  };
}
