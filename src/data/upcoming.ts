/**
 * Upcoming regattas (README "Upcoming regattas"): the /api/landing events that start within the next
 * UPCOMING_DAYS, soonest first, and the words for them ("Oct 28 – Nov 1", "Starts tomorrow"). Pure (no
 * DOM), shared by the landing page and the app (the picker, ui/eventCard.ts). RaceSense dates are calendar
 * days, so they are read in UTC. Whether an event has started is the event's own day (eventStarted: its
 * time zone when known, else America/New_York); "Starts tomorrow" counts from the viewer's own day.
 */
import type { LandingEvent } from './racesense/types';

export const DAY = 86_400_000;

/** How far ahead the Upcoming lists look. */
export const UPCOMING_DAYS = 14;

/** Where an event's calendar days are read when its time zone isn't known (most RaceSense events are in the US East). */
export const EVENT_TIME_ZONE = 'America/New_York';

/** A UTC calendar day as a day number. */
export const dayNo = (ms: number): number => Math.floor(ms / DAY);

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar day (a day number) at `now` at the event: in `zone`, an IANA time zone or a fixed offset from
 * UTC in ms (a race's timezoneOffset); else, or for a zone Intl doesn't know, in EVENT_TIME_ZONE.
 */
export function eventDayNo(now: number, zone: string | number = EVENT_TIME_ZONE): number {
  if (typeof zone === 'number') return Number.isFinite(zone) ? dayNo(now + zone) : eventDayNo(now);
  let f = dayFormats.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' });
    } catch {
      return zone === EVENT_TIME_ZONE ? dayNo(now) : eventDayNo(now);
    }
    dayFormats.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(now)) p[x.type] = Number(x.value);
  return dayNo(Date.UTC(p.year, p.month - 1, p.day));
}

/** Days from the event's own today to its first day (`startMs`, a calendar day in UTC): 1 the day before, 0 or less once it has started. */
export const eventDaysAway = (startMs: number, now: number, zone?: string | number): number => dayNo(startMs) - eventDayNo(now, zone);

/** The event's first day has come where it's sailed (it stays Upcoming all of the day before). */
export const eventStarted = (startMs: number, now: number, zone?: string | number): boolean => eventDaysAway(startMs, now, zone) <= 0;

/** Events that haven't started yet (eventStarted) but start within `days` days, soonest first (title breaks a tie). */
export function upcomingEvents(events: readonly LandingEvent[], now: number, days = UPCOMING_DAYS): LandingEvent[] {
  return events
    .filter((e) => {
      if (!Number.isFinite(e.startMs)) return false;
      const n = eventDaysAway(e.startMs, now);
      return n >= 1 && n <= days;
    })
    .sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
}
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
