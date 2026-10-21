/**
 * A boat's result as the race view shows it (the header chip, the table's Fin, the boat list): the official place,
 * or the code — with its points and the on-water place when the boat finished with one (DPI, SCP, …; DSQ / UFD / BFD
 * with a finish time). The order on the water is analysis/result.ts finishRank.
 */
import { codeInfo, pointsText } from '../data/official/codes';
import type { BoatResult } from '../analysis/types';
import { ordinal } from './format';

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
