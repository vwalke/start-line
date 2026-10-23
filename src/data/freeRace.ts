/**
 * The paywall's free race: race 1 of each division, and the telemetry window that goes with it.
 * Shared by the Pages Functions (server-side gating) and the page (the lock card), so both sides
 * always agree on which race is free.
 *
 * Race 1 = the division's earliest non-practice race in the race list as built from the RaceSense
 * document alone (data/raceList.ts with no official link and no rebuilt races): a gun, a recorded
 * start line, within the event's dates, not RaceSense practice nor the unlinked practice heuristic.
 * Rebuilt races (YYYYMMDDHHMM keys, data/orphans.ts) are never race 1: they are found in the browser
 * only, and their windows lie outside race 1's.
 *
 * The free window is what Recall fetches for race 1 (adapter.ts telemetryWindow: the gun less
 * PRE_START_FETCH_MS to just past the last finish), widened by FREE_PRE_MS / FREE_POST_MS so a
 * slightly newer copy of the document (finishes still arriving) can't lock race 1, and capped so
 * the widening never reaches back into an earlier race's window or within NEXT_GUN_GAP_MS of the
 * next gun. The caps never cut race 1's own window.
 */
import { buildRaceList } from './raceList';
import { currentDoc, findRace, listRaces, telemetryWindow, tzOffsetMs } from './racesense/adapter';
import type { RegattaDoc, RegattaResponse } from './racesense/types';

export const FREE_PRE_MS = 5 * 60_000;
export const FREE_POST_MS = 2 * 60_000;
/** The widened window stops this long before the division's next gun. */
export const NEXT_GUN_GAP_MS = 60_000;

export interface FreeWindow {
  division: string;
  /** RaceSense race number of the free race. */
  raceNumber: number;
  gunMs: number;
  after: number;
  before: number;
  /** The venue clock's offset from UTC, ms (the race's own, as the page's analysis uses it). */
  tzOffsetMs: number;
  /** The names the page may give this race ("Race 1", "Race 2" for RaceSense's number, "RS 2"), whatever the official numbering. */
  names: string[];
}

export interface FreeRaces {
  /** The document's event name, when it has one. */
  eventName?: string;
  /** Every division of the document (a known division filters teleapi's rows). */
  divisions: string[];
  /** Race 1 of each division that has one. */
  windows: FreeWindow[];
}

const windowOf = (doc: RegattaDoc, division: string, raceNumber: number): { after: number; before: number } | null => {
  try {
    return telemetryWindow(doc, { division, raceNumber });
  } catch {
    return null;
  }
};

/** Each division's race 1 and its free telemetry window. */
export function freeRaces(doc: RegattaDoc): FreeRaces {
  const list = buildRaceList(doc).races;
  const guns = listRaces(doc, { practice: true });
  const windows: FreeWindow[] = [];
  for (const div of doc.divisions ?? []) {
    const first = list.filter((r) => r.division === div.name && !r.practice && r.rsNumber != null).sort((a, b) => a.gunMs - b.gunMs)[0];
    const win = first ? windowOf(doc, div.name, first.raceNumber) : null;
    if (!first || !win) continue;
    const others = guns.filter((r) => r.division === div.name && r.raceNumber !== first.raceNumber);
    const nextGun = Math.min(...others.filter((r) => r.gunMs > first.gunMs + 60_000).map((r) => r.gunMs));
    const prevEnd = Math.max(...others.filter((r) => r.gunMs < first.gunMs - 60_000).map((r) => windowOf(doc, div.name, r.raceNumber)?.before ?? r.gunMs));
    windows.push({
      division: div.name,
      raceNumber: first.raceNumber,
      gunMs: first.gunMs,
      after: Math.min(win.after, Math.max(win.after - FREE_PRE_MS, prevEnd)),
      before: Math.max(win.before, Math.min(win.before + FREE_POST_MS, nextGun - NEXT_GUN_GAP_MS)),
      tzOffsetMs: tzOffsetMs(findRace(doc, { division: div.name, raceNumber: first.raceNumber }).race.timezoneOffset),
      names: [...new Set(['Race 1', `Race ${first.raceNumber}`, `RS ${first.raceNumber}`, ...(first.number != null ? [`Race ${first.number}`] : [])])],
    });
  }
  return { ...(doc.name ? { eventName: doc.name } : {}), divisions: (doc.divisions ?? []).map((d) => d.name), windows };
}

/** Free races of a regatta response (none when it has no usable document). */
export function freeRacesOf(resp: RegattaResponse): FreeRaces {
  try {
    return freeRaces(currentDoc(resp));
  } catch {
    return { divisions: [], windows: [] };
  }
}

/** Is race `raceNumber` of `division` the free one? */
export const isFreeRace = (free: FreeRaces, division: string, raceNumber: number): boolean =>
  free.windows.some((w) => w.division === division && w.raceNumber === raceNumber);

/**
 * Is a telemetry request for [after, before] free? With a division the document knows, it must lie
 * wholly within that division's free window (teleapi filters by division). Without one (or with an
 * unknown one) the response may carry every division, so it must lie within every division's free
 * window: never another division's later race.
 */
export function telemetryIsFree(free: FreeRaces, division: string | null, after: number, before: number): boolean {
  if (!(before > after)) return false;
  const inside = (w: FreeWindow): boolean => after >= w.after && before <= w.before;
  if (division && free.divisions.includes(division)) {
    const w = free.windows.find((x) => x.division === division);
    return !!w && inside(w);
  }
  return free.windows.length > 0 && free.divisions.every((d) => free.windows.some((w) => w.division === d && inside(w)));
}
