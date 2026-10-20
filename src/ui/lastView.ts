/**
 * The last race viewed and how it was viewed (leg, picked boat, table sorts, tab),
 * kept in localStorage so a home-screen launch, an evicted-and-relaunched
 * web app or a bare `/` link comes back to it. An explicit `?event=` wins.
 */
import type { RaceAnalysis } from '../analysis/types';
import type { RaceListItem } from '../data/racesense/adapter';
import { parsePickerParams, parseYscParam, type PickerParams } from './params';
import { readPref, removePref, writePref } from './speed';
import { sortTable, type SortState } from './table';
import { COACH_TABS, TABS, initialTab, parseTab, type Tab } from './tabs';

export const LAST_VIEW_KEY = 'recall.lastView';
/** As the /api proxy accepts (functions/_lib.ts). */
const EVENT_ID = /^[A-Za-z0-9_-]{4,64}$/;

/** Per-race view state: reset when another race is picked. */
export interface ViewState {
  leg: number | null;
  boat: string | null;
  /** The legs table's sort. A record from before the split may hold a start-table column here; `applyView` moves it. */
  sort: SortState | null;
  /** The start table's sort (absent in records from before the split). */
  startSort?: SortState | null;
}

export interface LastView extends ViewState {
  v: 1;
  eventId: string;
  division: string;
  raceNumber: number;
  allCompetitors?: true;
  /** The digest tab on screen (absent in records from before the tabs: Start). */
  tab?: Tab;
  /** The official-results link set by hand (`ys=`, 0: off) and its class (`ysc=`); absent: automatic. */
  ys?: number;
  ysc?: string;
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
  if (typeof raceNumber !== 'number' || !Number.isInteger(raceNumber) || raceNumber < 1) return null;
  if (leg !== null && !(typeof leg === 'number' && Number.isInteger(leg) && leg >= 0)) return null;
  if (boat !== null && (typeof boat !== 'string' || !boat)) return null;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  if (x.allCompetitors !== undefined && x.allCompetitors !== true) return null;
  const sort = parseSort(x.sort);
  if (sort === undefined) return null;
  const out: LastView = { v: 1, eventId, division, raceNumber, leg, boat, sort, savedAt };
  // Added with the start table: optional, and a malformed one is just dropped.
  const startSort = parseSort(x.startSort);
  if (startSort) out.startSort = startSort;
  if (x.allCompetitors) out.allCompetitors = true;
  // Added with the tabs: optional, and an unknown one is just dropped (Coach is kept: whether it opens depends on the flag).
  const tab = parseTab(x.tab, COACH_TABS);
  if (tab) out.tab = tab;
  // Added with official results: optional, and a malformed one is just dropped.
  if (typeof x.ys === 'number' && Number.isInteger(x.ys) && x.ys >= 0 && x.ys < 1e7) {
    out.ys = x.ys;
    const ysc = x.ys ? parseYscParam(typeof x.ysc === 'string' ? x.ysc : null) : undefined;
    if (ysc) out.ysc = ysc;
  }
  return out;
}

export function serializeLastView(r: LastView): string {
  const { v, eventId, division, raceNumber, allCompetitors, leg, boat, sort, startSort, tab, ys, ysc, savedAt } = r;
  return JSON.stringify({
    v,
    eventId,
    division,
    raceNumber,
    ...(allCompetitors ? { allCompetitors } : {}),
    leg,
    boat,
    sort,
    ...(startSort ? { startSort } : {}),
    ...(tab ? { tab } : {}),
    ...(ys !== undefined ? { ys } : {}),
    ...(ys && ysc ? { ysc } : {}),
    savedAt,
  });
}

export const readLastView = (): LastView | null => parseLastView(readPref(LAST_VIEW_KEY));
export const writeLastView = (r: LastView): void => writePref(LAST_VIEW_KEY, serializeLastView(r));
export const clearLastView = (): void => removePref(LAST_VIEW_KEY);

export const viewOf = (r: ViewState): ViewState => ({ leg: r.leg, boat: r.boat, sort: r.sort, ...(r.startSort ? { startSort: r.startSort } : {}) });

/**
 * View to apply for this load: an explicit restore (boot / matching URL) wins;
 * else keep what's on screen when this is the race already showing (nc toggle,
 * or a race switch that never landed). A different race starts clean.
 */
export function viewForRace(
  current: { eventId: string; division: string; raceNumber: number } | null,
  next: { eventId: string; division: string; raceNumber: number },
  showing: ViewState,
  explicit?: ViewState,
): ViewState | undefined {
  if (explicit !== undefined) return explicit;
  if (current && current.eventId === next.eventId && current.division === next.division && current.raceNumber === next.raceNumber) {
    return showing;
  }
  return undefined;
}

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
    const official = { ...(saved.ys !== undefined ? { ys: saved.ys } : {}), ...(saved.ys && saved.ysc ? { ysc: saved.ysc } : {}) };
    return {
      source: 'saved',
      params: saved.allCompetitors ? { eventId: saved.eventId, want, allCompetitors: true, ...official } : { eventId: saved.eventId, want, ...official },
      view: viewOf(saved),
    };
  }
  return { source: 'latest', params };
}

/**
 * The tab to boot on: the URL hash wins; else the saved tab when the plan restores the saved view
 * (the saved race, or a link to that same race); else Start (a link to another race, or nothing saved).
 */
export const startTab = (hash: string, plan: StartPlan, saved: LastView | null, tabs: readonly Tab[] = TABS): Tab =>
  initialTab(hash, saved?.tab, plan.source === 'saved' || (plan.source === 'url' && plan.view !== undefined), tabs);

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

/**
 * Saved view state that still fits this analysis: unknown legs, boats and sort columns are dropped,
 * and each saved sort goes to the table that has its column (so a record from before the split,
 * sorted by a start column, restores onto the start table).
 */
export function applyView(a: RaceAnalysis, v: ViewState): Required<ViewState> {
  const leg = v.leg != null && Number.isInteger(v.leg) && v.leg >= 0 && v.leg < a.legs.length ? v.leg : null;
  const known = v.boat != null && (a.boats.some((b) => b.id === v.boat) || a.excluded.some((e) => e.result.id === v.boat));
  let sort: SortState | null = null;
  let startSort: SortState | null = null;
  for (const s of [v.startSort, v.sort]) {
    const t = s ? sortTable(a, s.key) : null;
    if (t === 'start' && !startSort) startSort = s!;
    if (t === 'legs' && !sort) sort = s!;
  }
  return { leg, boat: known ? v.boat : null, sort, startSort };
}

/** A failure worth retrying (offline, timeout, 5xx), as opposed to one that will recur (4xx, missing race, bad data). */
export function isTransientError(message: string): boolean {
  return /^(5\d\d|408|429)\b/.test(message) || /failed to fetch|networkerror|network error|load failed|network connection|offline|timed? ?out/i.test(message);
}
