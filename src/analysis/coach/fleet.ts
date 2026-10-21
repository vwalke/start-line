/**
 * The fleet a place is out of, and which tracked boats official results leave out.
 * Isolated so the leg table and the D9 fallback can share it without importing the
 * Regatta view (which pulls the whole debrief).
 */
import type { RaceAnalysis } from '../types';

/**
 * The fleet a place is out of, as the results count it: linked to official results, the official
 * fleet (tracked boats they don't list out, listed boats with no track in); else the tracked fleet.
 */
export function fleetOf(a: Pick<RaceAnalysis, 'boats' | 'meta'>): number {
  const r = a.meta.results;
  if (r?.places !== 'official') return a.boats.length;
  return a.boats.length - (r.trackNoOfficial?.length ?? 0) + (r.officialNoTrack?.length ?? 0);
}

/** Tracked boats official results don't list (by sail or id); empty when places aren't official. */
export function extraTracked(a: Pick<RaceAnalysis, 'meta'>): Set<string> {
  if (a.meta.results?.places !== 'official') return new Set();
  return new Set(a.meta.results.trackNoOfficial ?? []);
}

/** Official codes for a boat that never started: leave them out of mid-race places. */
export const neverRaced = (code: string | undefined): boolean => !!code && /^(DNS|DNC|DNE)$/i.test(code);
