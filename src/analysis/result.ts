/**
 * A boat's place in two senses. `finishPos` is the result (the official place, null with a code); `finishRank` is
 * where it finished on the water: the result, else the on-water place of a boat that finished with a code (DPI,
 * SCP, …; DSQ / UFD / BFD with a finish time). Everything that orders boats by how they sailed (the analysis's
 * boat order, the places chart, the legs' finish column, the Coach's reference groups, D5 / D10's boats ahead)
 * reads finishRank; everything that shows the result (the header chip, the table's Fin, the boat list, the
 * Regatta view's places) shows finishPos or the code with its points. A penalised boat's on-water place can tie
 * an official place when Yachtscoring re-ranked the others (a DSQ); the orderings tolerate the tie.
 */
import type { BoatResult } from './types';

export const finishRank = (b: Pick<BoatResult, 'finishPos' | 'onWaterPlace'>): number | null => b.finishPos ?? b.onWaterPlace ?? null;
