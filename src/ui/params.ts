/**
 * Picker deep-link parameters: `?event=<id>&div=<division>&race=<n>`, plus
 * `nc=all` to keep coach/spare boats as competitors and the official-results
 * link: `ys=<Yachtscoring event>` (`ys=0`: off) with `ysc=<split id | circle|class>`.
 * `race` is a RaceSense race number, or a rebuilt race's key (its gun's UTC
 * minute, YYYYMMDDHHMM: data/orphans.ts). Anything else (including the retired
 * `?demo=`) is ignored.
 */
export interface PickerParams {
  eventId: string;
  want?: { division: string; raceNumber: number };
  /** `nc=all`: treat every boat as a competitor. */
  allCompetitors?: true;
  /** `ys=`: a Yachtscoring event to link (0: no official results for this event). */
  ys?: number;
  /** `ysc=`: the class within it. */
  ysc?: string;
}

export const NC_PARAM = 'nc';
export const NC_ALL = 'all';
export const YS_PARAM = 'ys';
export const YSC_PARAM = 'ysc';

/** `ys=` value: 0 (off) or a Yachtscoring event id; undefined when absent or malformed. */
export function parseYsParam(v: string | null): number | undefined {
  if (v == null || !/^\d{1,7}$/.test(v)) return undefined;
  return Number(v);
}

/** `ysc=` value: a split id or `circle|class` (printable, ≤ 80 chars); undefined otherwise. */
export function parseYscParam(v: string | null): string | undefined {
  const s = (v ?? '').trim();
  return s && s.length <= 80 && !/[<>\p{Cc}]/u.test(s) ? s : undefined;
}

export function parsePickerParams(search: string): PickerParams {
  const p = new URLSearchParams(search);
  const eventId = p.get('event') ?? '';
  const division = p.get('div');
  const raw = p.get('race');
  const raceNumber = Number(raw);
  const want = division && raw && /^\d{1,12}$/.test(raw) && Number.isFinite(raceNumber) ? { division, raceNumber } : undefined;
  const out: PickerParams = want ? { eventId, want } : { eventId };
  if (p.get(NC_PARAM) === NC_ALL) out.allCompetitors = true;
  const ys = parseYsParam(p.get(YS_PARAM));
  if (ys !== undefined) out.ys = ys;
  const ysc = ys ? parseYscParam(p.get(YSC_PARAM)) : undefined;
  if (ysc) out.ysc = ysc;
  return out;
}
