/**
 * The card for an event opened before any race is posted (an Upcoming one, or one just underway): its
 * title, dates, venue, class, how many boats are entered, when racing starts, and the race emails' toggle (notify.ts).
 * Boats are counted, never named. Pure (tested in node); the app shows it in place of the digest.
 */
import type { Me } from '../data/paywall';
import { tzOffsetMs } from '../data/racesense/adapter';
import type { LandingEvent, RegattaDoc } from '../data/racesense/types';
import { dateRangeText, dayText, eventStarted } from '../data/upcoming';
import { esc } from './format';
import { notifyButtonHtml, type NotifyState } from './notify';

export interface EventCardView {
  eventId: string;
  title: string;
  /** "Oct 28 – Nov 1" ('' when unknown). */
  dates: string;
  venue: string;
  classLabel: string;
  /** Boats entered, across divisions (0: the document lists none yet). */
  entries: number;
  /** When racing starts, or that it's underway ('' when the dates are unknown). */
  when: string;
}

export const UNDERWAY_TEXT = "Racing is underway. Races will show up here as they're posted.";

/**
 * The card's facts, from the regatta document and its /api/landing entry (either may be thin). Racing
 * starts on the day of the first scheduled start when the document has one, else on the event's first day.
 */
export function eventCardView(eventId: string, doc: RegattaDoc | null | undefined, landing: LandingEvent | undefined, now: number): EventCardView {
  const startMs = doc?.startDate || landing?.startMs || 0;
  const endMs = doc?.endDate || landing?.endMs || 0;
  const divisions = doc?.divisions ?? [];
  const entries = new Set(divisions.flatMap((d) => (d.participants ?? []).map((p) => `${d.name}|${p.sailNumber}`))).size;
  const classes = [...new Set(divisions.map((d) => d.boatClass || d.name).filter(Boolean))];
  // A start's day at the venue (startTime is UTC; dayText reads the shifted time in UTC).
  const firstStart = divisions
    .flatMap((d) => d.races ?? [])
    .flatMap((r) => (r.starts ?? []).map((s) => (s.startTime != null && s.startTime > 0 ? s.startTime + tzOffsetMs(r.timezoneOffset) : NaN)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const racingMs = firstStart ?? startMs;
  // Underway from the event's first day where it's sailed (the venue's offset when a race gives one).
  const venueRace = divisions.flatMap((d) => d.races ?? []).find((r) => r.timezoneOffset != null);
  const zone = venueRace ? tzOffsetMs(venueRace.timezoneOffset) : undefined;
  const when = startMs > 0 && eventStarted(startMs, now, zone) ? UNDERWAY_TEXT : racingMs > 0 ? `Racing starts ${dayText(racingMs)}.` : '';
  return {
    eventId,
    title: doc?.name || landing?.title || eventId,
    dates: dateRangeText(startMs, endMs),
    venue: landing?.venue?.trim() ?? '',
    classLabel: landing?.classLabel?.trim() || classes.join(', '),
    entries,
    when,
  };
}

/** "24 boats entered" ('' for none). */
export const entriesText = (n: number): string => (n > 0 ? `${n} boat${n === 1 ? '' : 's'} entered` : '');

/** The card; `free`: the "Free" badge (paywall.free); `notify`: the race emails' toggle state. */
export function eventCardHtml(v: EventCardView, o: { me: Me; free: boolean; notify?: NotifyState }): string {
  const meta = [v.classLabel, v.dates, v.venue].filter(Boolean).map(esc).join(' · ');
  const entries = entriesText(v.entries);
  const notify = notifyButtonHtml(v.eventId, o.me, 'event-card-title', o.notify);
  return `<section class="card event-card" aria-labelledby="event-card-title">
    <h2 id="event-card-title">${esc(v.title)}${o.free ? ' <span class="free-tag">Free</span>' : ''}</h2>
    ${meta ? `<p class="event-card-meta">${meta}</p>` : ''}
    ${entries ? `<p class="event-card-entries">${esc(entries)}</p>` : ''}
    ${v.when ? `<p class="event-card-when">${esc(v.when)}</p>` : ''}
    ${notify ? `<p class="event-card-actions">${notify}</p>` : ''}
  </section>`;
}
