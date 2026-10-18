/**
 * The last race viewed and how it was viewed (leg, picked boat, table sort),
 * kept in localStorage so a home-screen launch, an evicted-and-relaunched
 * web app or a bare `/` link comes back to it. An explicit `?event=` wins.
 */
import type { RaceAnalysis } from '../analysis/types';
import type { RaceListItem } from '../data/racesense/adapter';
import { parsePickerParams, type PickerParams } from './params';
import { readPref, removePref, writePref } from './speed';
import { hasSortKey, type SortState } from './table';

export const LAST_VIEW_KEY = 'recall.lastView';
/** As the /api proxy accepts (functions/_lib.ts). */
const EVENT_ID = /^[A-Za-z0-9_-]{4,64}$/;

/** Per-race view state: reset when another race is picked. */
export interface ViewState {
  leg: number | null;
  boat: string | null;
  sort: SortState | null;
}

export interface LastView extends ViewState {
  v: 1;
  eventId: string;
  division: string;
  raceNumber: number;
  allCompetitors?: true;
  savedAt: number;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function parseSort(x: unknown): SortState | null | undefined {
  if (x === null) return null;
  if (!isObj(x) || typeof x.key !== 'string' || !x.key || (x.dir !== 'asc' && x.dir !== 'desc')) return undefined;
  return { key: x.key, dir: x.dir };
}

/** A stored record, or null for anything malformed, of another version or naming an event the proxy would refuse. */
export function parseLastView(raw: string | null | undefined): LastView | null {
  if (!raw) return null;
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(x) || x.v !== 1) return null;
  const { eventId, division, raceNumber, leg, boat, savedAt } = x;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) return null;
  if (typeof division !== 'string' || !division) return null;
  if (typeof raceNumber !== 'number' || !Number.isFinite(raceNumber)) return null;
  if (leg !== null && !(typeof leg === 'number' && Number.isInteger(leg) && leg >= 0)) return null;
  if (boat !== null && (typeof boat !== 'string' || !boat)) return null;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  if (x.allCompetitors !== undefined && x.allCompetitors !== true) return null;
  const sort = parseSort(x.sort);
  if (sort === undefined) return null;
  const out: LastView = { v: 1, eventId, division, raceNumber, leg, boat, sort, savedAt };
  if (x.allCompetitors) out.allCompetitors = true;
  return out;
}

export function serializeLastView(r: LastView): string {
  const { v, eventId, division, raceNumber, allCompetitors, leg, boat, sort, savedAt } = r;
  return JSON.stringify({ v, eventId, division, raceNumber, ...(allCompetitors ? { allCompetitors } : {}), leg, boat, sort, savedAt });
}

export const readLastView = (): LastView | null => parseLastView(readPref(LAST_VIEW_KEY));
export const writeLastView = (r: LastView): void => writePref(LAST_VIEW_KEY, serializeLastView(r));
export const clearLastView = (): void => removePref(LAST_VIEW_KEY);

export const viewOf = (r: ViewState): ViewState => ({ leg: r.leg, boat: r.boat, sort: r.sort });

/** How to boot: the URL's race, the saved one, or the latest (no explicit or saved race). */
export type StartPlan =
  | { source: 'url'; params: PickerParams; view?: ViewState }
  | { source: 'saved'; params: PickerParams & { want: { division: string; raceNumber: number } }; view: ViewState }
  | { source: 'latest'; params: PickerParams };

export function resolveStart(search: string, saved: LastView | null): StartPlan {
  const params = parsePickerParams(search);
  if (params.eventId) {
    const same = saved && saved.eventId === params.eventId && saved.division === params.want?.division && saved.raceNumber === params.want.raceNumber;
    return same ? { source: 'url', params, view: viewOf(saved) } : { source: 'url', params };
  }
  if (saved) {
    const want = { division: saved.division, raceNumber: saved.raceNumber };
    return {
      source: 'saved',
      params: saved.allCompetitors ? { eventId: saved.eventId, want, allCompetitors: true } : { eventId: saved.eventId, want },
      view: viewOf(saved),
    };
  }
  return { source: 'latest', params };
}

/** The race to open: the wanted one if listed; else (unless `strict`, for a restore) the fallback. */
export function pickRace(
  races: RaceListItem[],
  want: { division: string; raceNumber: number } | undefined,
  fallback: RaceListItem | null,
  strict = false,
): RaceListItem | null {
  const hit = want && races.find((r) => r.division === want.division && r.raceNumber === want.raceNumber);
  if (hit) return hit;
  return strict ? null : (fallback ?? races[0] ?? null);
}

/** Saved view state that still fits this analysis: unknown legs, boats and sort columns are dropped. */
export function applyView(a: RaceAnalysis, v: ViewState): ViewState {
  const leg = v.leg != null && Number.isInteger(v.leg) && v.leg >= 0 && v.leg < a.legs.length ? v.leg : null;
  const known = v.boat != null && (a.boats.some((b) => b.id === v.boat) || a.excluded.some((e) => e.result.id === v.boat));
  return { leg, boat: known ? v.boat : null, sort: v.sort && hasSortKey(a, v.sort.key) ? v.sort : null };
}

/** A failure worth retrying (offline, timeout, 5xx), as opposed to one that will recur (4xx, missing race, bad data). */
export function isTransientError(message: string): boolean {
  return /^(5\d\d|408|429)\b/.test(message) || /failed to fetch|networkerror|network error|load failed|network connection|offline|timed? ?out/i.test(message);
}
