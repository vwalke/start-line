/**
 * The race list Recall offers: every race with a gun and tracks, numbered officially when the
 * event is linked to official results, else by an unofficial ordinal when RaceSense's own
 * numbers would mislead (a practice race or a rebuilt one in the list).
 *
 * - Zero-finisher races are listed (their finishes come from the official results or the tracks).
 * - Practice: RaceSense's `isPractice`; linked, a race with no official match before official
 *   race 1; unlinked, a lone zero-finisher race on the first racing day before the first day
 *   with finishes (Cascais Monday).
 * - Hidden (not offered): a race with no recorded start line (nothing to analyse) or a gun more
 *   than a day outside the event's dates (AYC J105 race 6: four starts on Oct 13, a week after
 *   the weekend, no line, no fixes).
 */
import type { DivisionLink } from './official/link';
import type { OrphanFound } from './orphans';
import { listRaces, type RaceListItem } from './racesense/adapter';
import type { RegattaDoc } from './racesense/types';

export const OUTSIDE_EVENT_MS = 86_400_000;

export type Numbering = 'official' | 'racesense' | 'ordinal';

export interface ListedRace extends RaceListItem {
  /** RaceSense's race number; null for a race rebuilt from the feed (its raceNumber is its key). */
  rsNumber: number | null;
  practice: boolean;
  /** The number to show (official or ordinal or RaceSense); null for practice or an unmatched race in a linked division. */
  number: number | null;
  numbering: Numbering;
  officialNumber: number | null;
  /** Where its places will come from. */
  finishes: 'official' | 'racesense' | 'tracker';
  rebuilt?: { gunFrom: OrphanFound['gunFrom'] };
  /** Linked division, RaceSense race after official race 1 with no official race at its gun. */
  noOfficial?: boolean;
}

export interface HiddenRace {
  division: string;
  raceNumber: number;
  why: string;
}

export interface RaceList {
  /** Newest first, as the picker lists them. */
  races: ListedRace[];
  hidden: HiddenRace[];
}

export interface ListOptions {
  /** Linked divisions (by RaceSense division name). */
  links?: ReadonlyMap<string, DivisionLink>;
  /** Rebuilt races per division (already merged into `doc`, or not: either works). */
  orphans?: ReadonlyMap<string, readonly OrphanFound[]>;
}

const tzOf = (doc: RegattaDoc, division: string): number => {
  const raw = doc.divisions.find((d) => d.name === division)?.races.find((r) => r.timezoneOffset != null)?.timezoneOffset ?? 0;
  return Math.abs(raw) > 15 * 3_600_000 ? raw / 1000 : raw;
};
const dayOf = (ms: number, tz: number): number => Math.floor((ms + tz) / 86_400_000);

export function buildRaceList(doc: RegattaDoc, opts: ListOptions = {}): RaceList {
  const hidden: HiddenRace[] = [];
  const races: ListedRace[] = [];
  const all = listRaces(doc, { practice: true });
  const startOk = (ms: number): boolean =>
    !(doc.startDate != null && ms < doc.startDate - OUTSIDE_EVENT_MS) && !(doc.endDate != null && ms > doc.endDate + OUTSIDE_EVENT_MS);
  for (const div of doc.divisions ?? []) {
    const link = opts.links?.get(div.name) ?? null;
    const orphans = opts.orphans?.get(div.name) ?? [];
    const orphanKeys = new Set(orphans.map((o) => o.key));
    const mine: ListedRace[] = [];
    for (const r of all.filter((x) => x.division === div.name)) {
      const race = div.races.find((x) => x.raceNumber === r.raceNumber)!;
      const line = race.starts?.filter((s) => s.startTime != null).at(-1)?.startLine;
      if (!line) {
        hidden.push({ division: div.name, raceNumber: r.raceNumber, why: 'no recorded start line' });
        continue;
      }
      if (!startOk(r.gunMs)) {
        hidden.push({ division: div.name, raceNumber: r.raceNumber, why: 'gun outside the event dates' });
        continue;
      }
      if (orphanKeys.has(r.raceNumber)) continue; // merged rebuilt race: listed from `orphans` below
      mine.push({ ...r, rsNumber: r.raceNumber, practice: !!race.isPractice, number: null, numbering: 'racesense', officialNumber: null, finishes: r.finishers ? 'racesense' : 'tracker' });
    }
    for (const o of orphans) {
      if (mine.some((m) => m.raceNumber === o.key)) continue;
      mine.push({
        division: div.name,
        raceNumber: o.key,
        gunMs: o.gunMs,
        finishers: 0,
        finished: false,
        lastFinishMs: null,
        rsNumber: null,
        practice: false,
        number: null,
        numbering: 'racesense',
        officialNumber: o.officialNumber ?? null,
        finishes: 'tracker',
        rebuilt: { gunFrom: o.gunFrom },
      });
    }
    mine.sort((a, b) => a.gunMs - b.gunMs);

    if (link) {
      const byRs = new Map(link.races.map((a) => [a.rsRace, a.official]));
      for (const r of mine) {
        const n = r.rsNumber != null ? byRs.get(r.rsNumber) : (r.officialNumber ?? undefined);
        if (n != null) {
          r.officialNumber = n;
          r.number = r.practice ? null : n;
          r.numbering = 'official';
          if (link.results[n]?.length) r.finishes = 'official';
        } else if (r.gunMs < link.firstGunMs - 60_000) {
          r.practice = true;
        } else if (!r.practice) {
          r.noOfficial = true;
          r.number = r.rsNumber;
        }
      }
    } else {
      // Unlinked: a lone zero-finisher race on the first racing day, before the first day with finishes, is practice.
      const tz = tzOf(doc, div.name);
      const days = [...new Set(mine.map((r) => dayOf(r.gunMs, tz)))].sort((a, b) => a - b);
      const firstFinDay = mine.filter((r) => r.finishers > 0).map((r) => dayOf(r.gunMs, tz))[0];
      const day0 = mine.filter((r) => dayOf(r.gunMs, tz) === days[0]);
      if (days.length > 1 && firstFinDay != null && firstFinDay > days[0] && day0.length === 1 && day0[0].finishers === 0) day0[0].practice = true;
      // Ordinal numbering when RaceSense's numbers would mislead (a practice or rebuilt race among them).
      const counted = mine.filter((r) => !r.practice);
      const ordinal = counted.some((r, k) => r.rsNumber !== k + 1);
      counted.forEach((r, k) => {
        r.number = ordinal ? k + 1 : r.rsNumber;
        r.numbering = ordinal ? 'ordinal' : 'racesense';
      });
    }
    races.push(...mine);
  }
  races.sort((a, b) => b.gunMs - a.gunMs);
  return { races, hidden };
}

/** The race a link or saved view asks for: `race=` is a RaceSense number or a rebuilt race's key (see orphans.ts). */
export const findListed = (list: RaceList, division: string, raceNumber: number): ListedRace | undefined =>
  list.races.find((r) => r.division === division && r.raceNumber === raceNumber);
