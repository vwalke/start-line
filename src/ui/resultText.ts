/**
 * A boat's result as the race view shows it (the header chip, the table's Fin, the boat list): the official place,
 * or the code — with its points and the on-water place when the boat finished with one (DPI, SCP, …; DSQ / UFD / BFD
 * with a finish time). The order on the water is analysis/result.ts finishRank.
 */
import { codeInfo, pointsText } from '../data/official/codes';
import type { RaceFinish } from '../analysis/coach/regatta';
import type { BoatResult, RaceAnalysis } from '../analysis/types';
import { esc, ordinal } from './format';

/**
 * A place from the trackers' finish-line crossings, shown `~` and called unofficial: the race's places come from the
 * tracker (`results.places`). Not the time source (`finishSource`): official places can have tracker times.
 */
export const isTracker = (a: Pick<RaceAnalysis, 'meta'>, b: Pick<BoatResult, 'finishPos' | 'finishSource'>): boolean =>
  b.finishPos != null && b.finishSource === 'tracker' && a.meta.results?.places === 'tracker';
/** The same for a Regatta race's finish (its `source` is the race's places, analysis/coach/regatta.ts analysedFinishes). */
export const isTrackerFinish = (f: Pick<RaceFinish, 'place' | 'source'> | null | undefined): boolean => f?.place != null && f.source === 'tracker';

/** Such a place in words: "finished 3, unofficial"; its tooltip. */
export const UNOFFICIAL_PLACE = 'unofficial';
export const UNOFFICIAL_PLACE_TIP = 'Unofficial place';
/** The note under places when any shown is `~`, and what it means. */
export const UNOFFICIAL_ORDER = 'Unofficial finish order';
export const UNOFFICIAL_ORDER_TIP = "These places come from when each boat's tracker crossed the finish line, not from official results.";

/** `<p class="unofficial-note">~ Unofficial finish order</p>`, the meaning as its tooltip; '' when no place shown is `~`. */
export const unofficialNoteHtml = (show: boolean): string =>
  show ? `<p class="unofficial-note" title="${esc(UNOFFICIAL_ORDER_TIP)}">~ ${UNOFFICIAL_ORDER}</p>` : '';
/** The printed report's note: no tooltips on paper, so the meaning is spelled out. */
export const unofficialNotePrintHtml = (show: boolean): string =>
  show ? `<p class="unofficial-note"><b>~ ${UNOFFICIAL_ORDER}.</b> ${esc(UNOFFICIAL_ORDER_TIP)}</p>` : '';

type Res = Pick<BoatResult, 'finishPos' | 'finishCode' | 'scoredPoints' | 'onWaterPlace' | 'penaltyPlaces'>;

/** "DPI 15" (a code with its points, when the boat finished with it), else the code ("DNF"); null without a code. */
export function codeShort(b: Res): string | null {
  if (!b.finishCode) return null;
  return b.onWaterPlace != null && b.scoredPoints != null && !codeInfo(b.finishCode).lost ? `${b.finishCode} ${pointsText(b.scoredPoints)}` : b.finishCode;
}

/** "scored DPI: 15 points, 12th on the water"; "scored UFD: 16 points (12th on the water)"; "scored DNF". */
export function codeWords(b: Res): string {
  const code = b.finishCode ?? '';
  const pts = b.scoredPoints != null ? `${pointsText(b.scoredPoints)} points` : '';
  const water = b.onWaterPlace != null ? `${ordinal(b.onWaterPlace)} on the water` : '';
  if (codeInfo(code).lost) return `scored ${code}${pts ? `: ${pts}` : ''}${water ? ` (${water})` : ''}`;
  return `scored ${code}${[pts, water].filter(Boolean).length ? `: ${[pts, water].filter(Boolean).join(', ')}` : ''}`;
}
