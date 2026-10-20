/**
 * Glue between the RaceSense event and the two recoveries: the official results link
 * (official/link.ts) and the rebuilt races (orphans.ts). Pure builders plus the probe fetcher;
 * the app runs them after the race list first renders.
 */
import { DAY } from './cache';
import type { DivisionLink, LinkOutcome, LinkRequest, LinkOverride } from './official/link';
import type { DivisionInput } from './official/match';
import { withOrphans, type FetchRows, type OrphanContext, type OrphanFound } from './orphans';
import { buildRaceList, type ListedRace, type RaceList } from './raceList';
import { currentDoc, parseTelemetry, tzOffsetMs, type OfficialRaceInput } from './racesense/adapter';
import { fetchTelemetry } from './racesense/api';
import type { LandingEvent, RegattaDoc, RegattaResponse } from './racesense/types';

/** A finished event's probe windows and fetches are cached long (as its race tracks). */
export const eventFinished = (doc: RegattaDoc, now = Date.now()): boolean => doc.endDate != null && now - doc.endDate > DAY;

/** The link request for an event: its name, dates, venue, and each division's boats and listed races' guns. */
export function linkRequest(doc: RegattaDoc, landing?: Pick<LandingEvent, 'venue' | 'startMs' | 'endMs'> | null, override?: LinkOverride | null): LinkRequest {
  const list = buildRaceList(doc);
  const tz = doc.divisions.flatMap((d) => d.races).find((r) => r.timezoneOffset != null)?.timezoneOffset;
  const divisions: DivisionInput[] = doc.divisions.map((d) => ({
    name: d.name,
    boatClass: d.boatClass,
    boats: (d.participants ?? []).map((p) => ({ sail: p.sailNumber, name: p.boatName ?? null })),
    races: list.races.filter((r) => r.division === d.name && !r.practice).map((r) => ({ raceNumber: r.raceNumber, gunMs: r.gunMs })),
  }));
  const startMs = doc.startDate ?? (landing?.startMs || Math.min(...list.races.map((r) => r.gunMs)));
  const endMs = doc.endDate ?? (landing?.endMs || Math.max(...list.races.map((r) => r.gunMs)));
  return {
    meta: { name: doc.name, startMs, endMs, ...(landing?.venue ? { venue: landing.venue } : {}) },
    tzPriorMs: tz != null ? tzOffsetMs(tz) : null,
    divisions: divisions.filter((d) => d.races.length),
    override: override ?? null,
  };
}

/** Linked divisions by RaceSense division name. */
export function linksOf(outcome: LinkOutcome | null | undefined): Map<string, DivisionLink> {
  return new Map(outcome?.status === 'linked' ? outcome.divisions.map((d) => [d.division, d]) : []);
}

/** The worker's official input for one listed race, or null. */
export function officialFor(outcome: LinkOutcome | null | undefined, race: ListedRace | undefined): OfficialRaceInput | null {
  if (outcome?.status !== 'linked' || !race || race.officialNumber == null) return null;
  const link = outcome.divisions.find((d) => d.division === race.division);
  const rows = link?.results[race.officialNumber];
  return rows?.length ? { number: race.officialNumber, tzOffsetMs: outcome.tzOffsetMs, rows } : null;
}

/** Where each division may have unlisted races (see orphans.ts for the rule). */
export function orphanContexts(doc: RegattaDoc, list: RaceList, outcome: LinkOutcome | null | undefined): OrphanContext[] {
  const links = linksOf(outcome);
  return doc.divisions
    .map((d): OrphanContext | null => {
      const listed = list.races.filter((r) => r.division === d.name);
      if (!listed.length) return null;
      const link = links.get(d.name);
      const st = d.courses?.flatMap((c) => c.achievements).find((a) => a.type === 'startLine');
      const l = st?.deviceRoles.find((x) => /left/i.test(x.role));
      const r = st?.deviceRoles.find((x) => /right/i.test(x.role));
      const tz = d.races.find((x) => x.timezoneOffset != null)?.timezoneOffset;
      return {
        division: d.name,
        listed: listed.map((x) => ({ raceNumber: x.raceNumber, gunMs: x.gunMs, practice: x.practice })),
        officialOnly: link ? link.officialOnly : null,
        tzOffsetMs: tz != null ? tzOffsetMs(tz) : 0,
        startDevices: l && r ? { left: l.sn, right: r.sn } : null,
      };
    })
    .filter((c): c is OrphanContext => c != null);
}

/** One telemetry request per probe, through the /api proxy and the client cache (30 days for a finished event). */
export const probeFetcher = (eventId: string, finished: boolean): FetchRows => async (after, before, division) =>
  parseTelemetry(await fetchTelemetry(eventId, division, after, before, { finished }));

/** The regatta response with its current document swapped (rebuilt races merged in). */
export function withDoc(resp: RegattaResponse, doc: RegattaDoc): RegattaResponse {
  const revs = resp.revisions.slice();
  revs[revs.length - 1] = { ...revs[revs.length - 1], doc };
  return { ...resp, revisions: revs };
}

/** The response with rebuilt races merged into their divisions. */
export const mergeOrphans = (resp: RegattaResponse, found: ReadonlyMap<string, readonly OrphanFound[]>): RegattaResponse =>
  found.size ? withDoc(resp, withOrphans(currentDoc(resp), found)) : resp;
