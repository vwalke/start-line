/**
 * Picker deep-link parameters: `?event=<id>&div=<division>&race=<n>`.
 * Anything else (including the retired `?demo=`) is ignored.
 */
export interface PickerParams {
  eventId: string;
  want?: { division: string; raceNumber: number };
}

export function parsePickerParams(search: string): PickerParams {
  const p = new URLSearchParams(search);
  const eventId = p.get('event') ?? '';
  const division = p.get('div');
  const raceNumber = Number(p.get('race'));
  const want = division && p.get('race') && Number.isFinite(raceNumber) ? { division, raceNumber } : undefined;
  return want ? { eventId, want } : { eventId };
}
