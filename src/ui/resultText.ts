/**
 * A boat's result as the race view shows it (the header chip, the table's Fin, the boat list): the official place,
 * or the code — with its points and the on-water place when the boat finished with one (DPI, SCP, …; DSQ / UFD / BFD
 * with a finish time). The order on the water is analysis/result.ts finishRank.
 */
import { codeInfo, pointsText } from '../data/official/codes';
import type { BoatResult } from '../analysis/types';
import { esc, ordinal } from './format';

/** A place from the tracker's finish-line crossing (`~`), in words: the boat list's label, Coach's place chip, the report. */
export const UNOFFICIAL_PLACE = 'unofficial (tracker finish)';
/** The note under a list of places when any is `~`, and its tooltip. */
export const UNOFFICIAL_ORDER = 'Unofficial finish order';
export const UNOFFICIAL_ORDER_TIP = "Official results aren't posted yet. These places come from when each boat's tracker crossed the finish line.";

/** `<p class="…">~ Unofficial finish order</p>` with its tooltip; '' when no place shown is `~`. */
export const unofficialNoteHtml = (show: boolean, cls: string): string =>
  show ? `<p class="${cls}" title="${esc(UNOFFICIAL_ORDER_TIP)}">~ ${UNOFFICIAL_ORDER}</p>` : '';

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
