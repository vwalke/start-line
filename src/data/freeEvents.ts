/**
 * Regattas open in full to anyone signed in, at no charge (README "Free regattas"). Matched by
 * RaceSense event id, so every race counts as it appears. Shared by the Pages Functions (each
 * signed-in user gets a free pass for these: functions/_entitlements.ts freePasses) and the page
 * (the lock card's sign-in copy and the "Free" badges), so both sides agree. A change needs a deploy.
 */

export interface FreeEvent {
  /** RaceSense event id. */
  id: string;
  /** For the account sheet and this list's readers. */
  label: string;
  /** Free until this time (ms); absent: for good. */
  until?: number;
}

export const FREE_EVENTS: readonly FreeEvent[] = [{ id: 'Qn47enc7fKR7Th1Qj1ZI', label: '2026 J/70 North Americans' }];

/** The free events running at `now`. */
export const freeEventsAt = (now: number, list: readonly FreeEvent[] = FREE_EVENTS): FreeEvent[] => list.filter((e) => e.until == null || now < e.until);

/** The list's name for a free event (the event picker may not list it yet: it shows events that have started or start within two weeks). */
export const freeEventLabel = (eventId: string, list: readonly FreeEvent[] = FREE_EVENTS): string | undefined => list.find((e) => e.id === eventId)?.label;

/** Is `eventId` free (with an account) at `now`? */
export const isFreeEvent = (eventId: string | null | undefined, now: number, list: readonly FreeEvent[] = FREE_EVENTS): boolean =>
  eventId != null && freeEventsAt(now, list).some((e) => e.id === eventId);
