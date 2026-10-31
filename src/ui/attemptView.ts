/**
 * The Start tab's earlier-attempt card (data/attempts.ts): a race started more than once shows its earlier start's line
 * at that gun, on request, apart from everything else. Its words say only what the feed shows (a start that was
 * started again); nothing in it says any boat was over early: that start didn't count.
 */
import type { EarlierAttempt } from '../data/attempts';
import { attemptTitle } from '../data/attempts';
import { esc, localTime } from './format';

/** "Start 5 · attempt 1 of 2 (restarted)". */
export { attemptTitle };

/**
 * The card's note: for each attempt in `ats` (the one open, else every one listed), its number, when it was and when
 * the race was started again; then that it's only a picture.
 */
export function attemptNote(ats: readonly EarlierAttempt[], tzOffsetMs: number): string {
  const said = ats.map(
    (at) => `Race control stopped attempt ${at.attempt} of ${at.of} (gun ${localTime(at.gunMs, tzOffsetMs)}) and started the race again at ${localTime(at.nextGunMs, tzOffsetMs)}.`,
  );
  return [...said, "It's here to look at only: results, times, places and the Coach all use the start the race was sailed from."].join(' ');
}

/** The buttons, one per earlier attempt: "Show attempt 1" (pressed: "Hide attempt 1"). */
export function attemptButtonsHtml(list: readonly EarlierAttempt[], open: number | null, busy: boolean): string {
  return list
    .map((at) => {
      const on = open === at.attempt;
      const label = on ? (busy ? `Loading attempt ${at.attempt}…` : `Hide attempt ${at.attempt}`) : `Show attempt ${at.attempt}`;
      return `<button type="button" class="act act-chip" data-attempt="${at.attempt}" aria-pressed="${on}" aria-controls="attempt-chart"${on && busy ? ' disabled' : ''}>${esc(label)}</button>`;
    })
    .join(' ');
}
