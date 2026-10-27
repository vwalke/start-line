/**
 * "Notify me", for an event with no races yet: on each Upcoming card of the landing page and on the app's
 * event card (ui/eventCard.ts). Only with the paywall on (/api/auth/me); with it off the button isn't shown.
 *   - Signed out: the sign-in sheet, which comes back to the event. The landing page has no sheet, so it
 *     goes to the event with `notify=1` and the app opens the sheet there (and drops the marker).
 *   - Signed in: notifyMe(eventId), the one place race alerts hook in.
 * No imports from the app: the landing page loads this.
 */
import type { Me } from '../data/paywall';

/** `?notify=1`: carry a Notify me click from the landing page into the app. */
export const NOTIFY_PARAM = 'notify';
export const NOTIFY_LABEL = 'Notify me';

/** Off until race emails ship (/api/alerts): no button anywhere, and `?notify=1` only drops the marker. */
export const NOTIFY_ENABLED = false;

/** As RaceSense ids are (and landing/landing.ts checks): safe in an attribute and a URL as is. */
const EVENT_ID = /^[A-Za-z0-9_-]{4,64}$/;

export type NotifyAction = 'hidden' | 'signin' | 'notify';

/** What the button does for this viewer. */
export const notifyAction = (me: Me): NotifyAction => (!me.paywall ? 'hidden' : me.user ? 'notify' : 'signin');

/** The event's page in the app. */
export const eventPath = (eventId: string): string => `/?event=${encodeURIComponent(eventId)}`;

/** The event's page, asking the app to carry on with Notify me (from the landing page). */
export const notifyHref = (eventId: string): string => `${eventPath(eventId)}&${NOTIFY_PARAM}=1`;

/**
 * The button ('' when hidden). `describedBy`: the card's title, so a screen reader hears which event.
 * `enabled`: NOTIFY_ENABLED (a parameter for the tests).
 */
export function notifyButtonHtml(eventId: string, me: Me, describedBy?: string, enabled = NOTIFY_ENABLED): string {
  if (!enabled || notifyAction(me) === 'hidden' || !EVENT_ID.test(eventId)) return '';
  const desc = describedBy && EVENT_ID.test(describedBy) ? ` aria-describedby="${describedBy}"` : '';
  return `<button type="button" class="lock-secondary notify-btn" data-notify="${eventId}"${desc}>${NOTIFY_LABEL}</button>`;
}

/**
 * Signed in and Notify me clicked. For now this opens the event page (nothing to do when it is already
 * open); race alerts replace it.
 */
export async function notifyMe(eventId: string, loc: Pick<Location, 'search' | 'assign'> = location): Promise<void> {
  if (new URLSearchParams(loc.search).get('event') === eventId) return;
  loc.assign(eventPath(eventId));
}

/** A Notify me click: sign in first when signed out, else the hook. Returns what it did. */
export function handleNotify(
  eventId: string,
  me: Me,
  o: { signIn: (eventId: string) => void; notify?: (eventId: string) => void | Promise<void> },
): NotifyAction {
  const a = notifyAction(me);
  if (a === 'signin') o.signIn(eventId);
  else if (a === 'notify') void (o.notify ?? notifyMe)(eventId);
  return a;
}
