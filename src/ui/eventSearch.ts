/**
 * Client-side search over the landing event list. Pure (no DOM) so it can be
 * tested in node. `/api/landing` returns every listed event in one response,
 * so filtering the fetched list covers the whole feed.
 */
import type { LandingEvent } from '../data/racesense/types';
import { dateRangeText, startsInText } from '../data/upcoming';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Lower case with diacritics stripped: "Malmö" → "malmo". */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Letters and digits only, so "J/70" and "j70" compare equal. */
const squash = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, '');

/** Year and month names ("2026 sep september") for a timestamp; '' when it is missing. */
function dateWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const month = MONTHS[d.getUTCMonth()];
  return `${d.getUTCFullYear()} ${month.slice(0, 3)} ${month}`;
}

/** Everything an event can be found by, folded for matching. */
export function eventHaystack(e: LandingEvent): string {
  return fold(
    [e.title, e.venue, e.classLabel, e.division, e.dateLabel, e.fleetLabel, e.eventId, dateWords(e.startMs), dateWords(e.endMs)]
      .filter(Boolean)
      .join(' '),
  );
}

/** The query split into folded words; empty when there is nothing to filter by. */
const queryWords = (query: string): string[] => fold(query).split(/\s+/).filter(Boolean);

/**
 * Events where every query word appears somewhere in the haystack: case and
 * diacritic insensitive, with punctuation optional ("j70" finds "J/70").
 * Keeps the input order; an empty query returns the input unchanged.
 */
export function filterEvents(events: LandingEvent[], query: string): LandingEvent[] {
  const words = queryWords(query);
  if (!words.length) return events;
  const squashed = words.map(squash);
  return events.filter((e) => {
    const hay = eventHaystack(e);
    const hayLoose = squash(hay);
    // A word that is only punctuation ("·", "-") squashes to '' and matches anything.
    return words.every((w, i) => hay.includes(w) || hayLoose.includes(squashed[i]));
  });
}

const plural = (n: number): string => `${n} event${n === 1 ? '' : 's'}`;

/** "48 events", "3 of 48 events", or "No events match “xyz”". */
export function matchCountLabel(shown: number, total: number, query: string): string {
  const q = query.trim();
  if (!q) return plural(total);
  if (shown === 0) return `No events match “${q}”`;
  return `${shown} of ${plural(total)}`;
}

/** What a key in the search box does: Esc clears a query, Enter loads the only match. */
export function searchKeyAction(key: string, query: string, matchCount: number): 'clear' | 'pick' | null {
  if (key === 'Escape') return query ? 'clear' : null;
  // Empty query is not a filter: don't load just because the feed has one event.
  if (key === 'Enter') return query.trim() !== '' && matchCount === 1 ? 'pick' : null;
  return null;
}

export interface EventOption {
  eventId: string;
  label: string;
}

export const eventLabel = (e: LandingEvent): string => `${e.title}${e.dateLabel ? ` — ${e.dateLabel}` : ''}`;

/** An Upcoming event in the picker: "2026 J/70 North Americans — Oct 28 – Nov 1 · Starts tomorrow". */
export const upcomingLabel = (e: LandingEvent, now: number, tzOffsetMin?: number): string =>
  `${e.title} — ${[dateRangeText(e.startMs, e.endMs), startsInText(e.startMs, now, tzOffsetMin)].filter(Boolean).join(' · ')}`;

/**
 * The Event select's options for a query: `options` (events that have started, as listed) and `upcoming`
 * (data/upcoming.ts: shown in their own group). The loaded event stays first, marked "(current)", when it
 * is not a match, so the select never shows a different event than the digest; `matches` holds only the
 * true matches, started then upcoming.
 */
export function pickerOptions(
  events: LandingEvent[],
  query: string,
  currentId: string,
  free: (eventId: string) => boolean = () => false,
  upcoming: { events: LandingEvent[]; now: number; tzOffsetMin?: number } = { events: [], now: 0 },
): { options: EventOption[]; upcoming: EventOption[]; matches: LandingEvent[] } {
  const started = filterEvents(events, query);
  const soon = filterEvents(upcoming.events, query);
  // A free regatta (data/freeEvents.ts) says so, with the paywall on.
  const badge = (e: LandingEvent): string => (free(e.eventId) ? ' · Free' : '');
  const isSoon = (e: LandingEvent): boolean => upcoming.events.includes(e);
  const label = (e: LandingEvent): string => `${isSoon(e) ? upcomingLabel(e, upcoming.now, upcoming.tzOffsetMin) : eventLabel(e)}${badge(e)}`;
  const options = started.map((e) => ({ eventId: e.eventId, label: label(e) }));
  const soonOptions = soon.map((e) => ({ eventId: e.eventId, label: label(e) }));
  const matches = [...started, ...soon];
  const current =
    currentId && !matches.some((e) => e.eventId === currentId) ? [...events, ...upcoming.events].find((e) => e.eventId === currentId) : undefined;
  if (current) options.unshift({ eventId: current.eventId, label: `${label(current)} (current)` });
  return { options, upcoming: soonOptions, matches };
}
