/**
 * Upcoming regattas (README "Upcoming regattas"): the /api/landing events that start within the next
 * UPCOMING_DAYS, soonest first, and the words for them ("Oct 28 – Nov 1", "Starts tomorrow"). Pure (no
 * DOM), shared by the landing page and the app (ui/eventCard.ts). RaceSense dates are calendar days, so
 * they are read in UTC; "today" is the viewer's own day.
 */
import type { LandingEvent } from './racesense/types';

export const DAY = 86_400_000;

/** How far ahead the Upcoming lists look. */
export const UPCOMING_DAYS = 14;

/** Events that haven't started yet but start within `days`, soonest first (title breaks a tie). */
export function upcomingEvents(events: readonly LandingEvent[], now: number, days = UPCOMING_DAYS): LandingEvent[] {
  return events
    .filter((e) => Number.isFinite(e.startMs) && e.startMs > now && e.startMs <= now + days * DAY)
    .sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
}

/** A UTC calendar day as a day number. */
export const dayNo = (ms: number): number => Math.floor(ms / DAY);
/** The viewer's calendar day at `now` (`tzOffsetMin` as Date#getTimezoneOffset gives it: minutes behind UTC). */
const viewerDay = (now: number, tzOffsetMin = new Date(now).getTimezoneOffset()): number => dayNo(now - tzOffsetMin * 60_000);

/** Whole days from the viewer's today to the event's first day (0 or less: today or before). */
export const daysUntil = (startMs: number, now: number, tzOffsetMin?: number): number => dayNo(startMs) - viewerDay(now, tzOffsetMin);

/** "Starts today", "Starts tomorrow", "Starts in 5 days". */
export function startsInText(startMs: number, now: number, tzOffsetMin?: number): string {
  const n = daysUntil(startMs, now, tzOffsetMin);
  if (n <= 0) return 'Starts today';
  if (n === 1) return 'Starts tomorrow';
  return `Starts in ${n} days`;
}

const fmt = (ms: number, o: Intl.DateTimeFormatOptions): string => new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });

/** "Oct 28 – Nov 1", "Oct 28 – 30", or "Oct 28" for a one-day event ('' with no start). */
export function dateRangeText(startMs: number, endMs?: number): string {
  if (!Number.isFinite(startMs) || startMs <= 0) return '';
  const from = fmt(startMs, { month: 'short', day: 'numeric' });
  if (endMs == null || !Number.isFinite(endMs) || dayNo(endMs) <= dayNo(startMs)) return from;
  const sameMonth = fmt(startMs, { month: 'short' }) === fmt(endMs, { month: 'short' });
  return `${from} – ${sameMonth ? fmt(endMs, { day: 'numeric' }) : fmt(endMs, { month: 'short', day: 'numeric' })}`;
}

/** "Wed, Oct 28". */
export const dayText = (ms: number): string => fmt(ms, { weekday: 'short', month: 'short', day: 'numeric' });
