/**
 * Picker deep-link parameters: `?event=<id>&div=<division>&race=<n>`, plus
 * `nc=all` to keep coach/spare boats as competitors. Anything else
 * (including the retired `?demo=`) is ignored.
 */
export interface PickerParams {
  eventId: string;
  want?: { division: string; raceNumber: number };
  /** `nc=all`: treat every boat as a competitor. */
  allCompetitors?: true;
}

export const NC_PARAM = 'nc';
export const NC_ALL = 'all';

export function parsePickerParams(search: string): PickerParams {
  const p = new URLSearchParams(search);
  const eventId = p.get('event') ?? '';
  const division = p.get('div');
  const raceNumber = Number(p.get('race'));
  const want = division && p.get('race') && Number.isFinite(raceNumber) ? { division, raceNumber } : undefined;
  const out: PickerParams = want ? { eventId, want } : { eventId };
  if (p.get(NC_PARAM) === NC_ALL) out.allCompetitors = true;
  return out;
}
