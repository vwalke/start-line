/**
 * Earlier start attempts: a race RaceSense lists with more than one start (J/70 NAs race 5: a start at 16:36Z that race
 * control stopped, `stopReason` "abandonment" with 31 boats flagged, then the start the race was sailed from at
 * 16:53Z). The race is the last start, as ever (adapter.ts raceStart): its scores, finish times, places, legs and the
 * Coach all come from it, and nothing here changes that. An earlier attempt is only a picture to look at on the Start
 * tab: its own short analysis (the line and the boats at that gun), run apart from the race's.
 *
 * The feed can't tell a general recall from a start stopped for another reason (both read "abandonment"), so the
 * label says what is known: an earlier start of the race, which was started again. Race control's over-early calls
 * for that start are left out of its analysis: a start that didn't count has nobody over early.
 */
import type { RegattaResponse, Race, Start } from './racesense/types';
import type { RaceRef } from './racesense/adapter';
import { PRE_START_FETCH_MS } from './racesense/adapter';

/** An attempt's telemetry runs this long past its gun: the start chart, Start Playback and the wind's first minutes. */
export const ATTEMPT_POST_MS = 5 * 60_000;
/** An attempt's telemetry always runs at least this long past its gun, even when the race was started again sooner. */
export const ATTEMPT_MIN_POST_MS = 60_000;
export const ATTEMPT_PARAM = 'attempt';

export interface EarlierAttempt {
  /** Its index in the race's starts. */
  index: number;
  /** 1-based, in gun order, of `of` attempts (the race's own start the last). */
  attempt: number;
  of: number;
  gunMs: number;
  /** The gun of the start after it (the next attempt, or the race's own). */
  nextGunMs: number;
}

/** The race's starts with a gun, in gun order, keeping their index. */
const gunned = (race: Pick<Race, 'starts'>): { s: Start; index: number; gun: number }[] =>
  (race.starts ?? [])
    .map((s, index) => ({ s, index, gun: s.startTime ?? NaN }))
    .filter((x) => Number.isFinite(x.gun))
    .sort((p, q) => p.gun - q.gun);

/**
 * The race's earlier attempts worth drawing: every start with a gun but the last (the race's own), that has a start
 * line and came the same day as the next (one stopped, postponed to another day with no line, is not a start to see).
 */
export function earlierAttempts(race: Pick<Race, 'starts'>): EarlierAttempt[] {
  const all = gunned(race);
  const out: EarlierAttempt[] = [];
  all.forEach((x, k) => {
    if (k === all.length - 1 || !x.s.startLine) return;
    const next = all[k + 1].gun;
    if (next - x.gun > 12 * 3_600_000) return;
    out.push({ index: x.index, attempt: k + 1, of: all.length, gunMs: x.gun, nextGunMs: next });
  });
  return out;
}

/** `attempt=<n>` (1-based, as labelled); null when absent or malformed. */
export function parseAttemptParam(v: string | null): number | null {
  return v && /^\d{1,2}$/.test(v) && Number(v) >= 1 ? Number(v) : null;
}

/** The attempt numbered `n` among `list` (earlierAttempts), or null. */
export const attemptNumbered = (list: readonly EarlierAttempt[], n: number | null): EarlierAttempt | null => (n == null ? null : (list.find((x) => x.attempt === n) ?? null));

/** "Start 5 · attempt 1 of 2 (restarted)". */
export const attemptTitle = (raceLabel: string, at: Pick<EarlierAttempt, 'attempt' | 'of'>): string => `${raceLabel.replace(/^Race\b/, 'Start')} · attempt ${at.attempt} of ${at.of} (restarted)`;

/**
 * A copy of the regatta with race `ref` as its attempt at start index `index` alone: that start, with race control's
 * over-early calls taken off it (OCS, cleared OCS), and no finishes. The rest of the document is shared, untouched.
 */
export function attemptRegatta(resp: RegattaResponse, ref: RaceRef, index: number): RegattaResponse {
  const revs = resp.revisions;
  const last = revs[revs.length - 1];
  const doc = last.doc;
  const divisions = doc.divisions.map((d) =>
    d.name !== ref.division
      ? d
      : {
          ...d,
          races: d.races.map((r): Race => {
            if (r.raceNumber !== ref.raceNumber) return r;
            const s = r.starts[index];
            if (!s) throw new Error(`Race ${ref.raceNumber} has no start ${index + 1}`);
            return { ...r, endTime: null, finishes: [], starts: [{ ...s, ocsParticipants: null, clearedOcs: null }] };
          }),
        },
  );
  return { ...resp, revisions: [...revs.slice(0, -1), { ...last, doc: { ...doc, divisions } }] };
}

/**
 * The telemetry an attempt needs: the usual pre-start, ATTEMPT_POST_MS after its gun, stopping short of the next
 * start's pre-start when that comes sooner; but always ATTEMPT_MIN_POST_MS past its gun, however soon the race was
 * started again (its start chart needs the boats crossing).
 */
export function attemptWindow(at: Pick<EarlierAttempt, 'gunMs' | 'nextGunMs'>): { after: number; before: number } {
  const beforeNext = Math.min(at.gunMs + ATTEMPT_POST_MS, at.nextGunMs - PRE_START_FETCH_MS);
  return { after: at.gunMs - PRE_START_FETCH_MS, before: Math.max(beforeNext, at.gunMs + ATTEMPT_MIN_POST_MS) };
}
