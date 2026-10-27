/**
 * Race emails' toggle, "Email me when races are posted" (README "Race emails"): on each Upcoming card of
 * the landing page, on the app's event card (ui/eventCard.ts), and small in the race title's line. Only
 * with the paywall on (/api/auth/me); with it off the button isn't shown.
 *   - Signed out: the sign-in sheet, which comes back to the event with `notify=1`; the app then turns
 *     the emails on (and drops the marker). The landing page has no sheet, so it goes to the event with
 *     `notify=1` and the app opens the sheet there.
 *   - Signed in: "Notify me" turns them on (POST /api/alerts); "Emails on ✓" turns them off (DELETE).
 * The signed-in user's list (GET /api/alerts) lives in `createAlerts`, which the account sheet shows too.
 * No imports from the app: the landing page loads this.
 */
import type { Me } from '../data/paywall';

/** `?notify=1`: carry a Notify me click through a sign-in (or from the landing page) into the app. */
export const NOTIFY_PARAM = 'notify';
export const NOTIFY_LABEL = 'Notify me';
export const NOTIFY_ON_LABEL = 'Emails on ✓';
export const ALERTS_URL = '/api/alerts';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** As RaceSense ids are (and landing/landing.ts checks): safe in an attribute and a URL as is. */
const EVENT_ID = /^[A-Za-z0-9_-]{4,64}$/;

export type NotifyAction = 'hidden' | 'signin' | 'notify';

/** What the button does for this viewer. */
export const notifyAction = (me: Me): NotifyAction => (!me.paywall ? 'hidden' : me.user ? 'notify' : 'signin');

/** The event's page in the app. */
export const eventPath = (eventId: string): string => `/?event=${encodeURIComponent(eventId)}`;

/** The event's page, asking the app to carry on with Notify me (from the landing page). */
export const notifyHref = (eventId: string): string => `${eventPath(eventId)}&${NOTIFY_PARAM}=1`;

/** `href` (a path or URL) with `notify=1`, as a path: where a sign-in from Notify me comes back to. */
export function withNotify(href: string): string {
  const u = new URL(href, 'https://x.invalid');
  u.searchParams.set(NOTIFY_PARAM, '1');
  return `${u.pathname}${u.search}${u.hash}`;
}

export interface NotifyState {
  /** Emails are on for this event. */
  on: boolean;
  busy?: boolean;
  /** Why the last change didn't go through. */
  note?: string;
}

/**
 * The button ('' when hidden). `describedBy`: the card's title, so a screen reader hears which event.
 * `quiet`: the small link-style one in the race title's line.
 */
export function notifyButtonHtml(eventId: string, me: Me, describedBy?: string, state: NotifyState = { on: false }, o: { quiet?: boolean } = {}): string {
  if (notifyAction(me) === 'hidden' || !EVENT_ID.test(eventId)) return '';
  const on = notifyAction(me) === 'notify' && state.on;
  const desc = describedBy && EVENT_ID.test(describedBy) ? ` aria-describedby="${describedBy}"` : '';
  const cls = o.quiet ? 'linkish notify-btn notify-quiet' : 'lock-secondary notify-btn';
  const title = on ? 'Race emails are on. Turn them off' : 'Email me when races are posted';
  const label = on ? NOTIFY_ON_LABEL : NOTIFY_LABEL;
  const aria = on ? 'Emails on: turn off race emails' : 'Notify me: email me when races are posted';
  const note = state.note ? ` <span class="notify-note" role="status">${esc(state.note)}</span>` : '';
  return `<button type="button" class="${cls}${on ? ' notify-on' : ''}" data-notify="${eventId}" title="${title}" aria-label="${aria}"${desc}${state.busy ? ' disabled' : ''}>${label}</button>${note}`;
}

// ---- the signed-in user's race emails

export interface RaceAlert {
  eventId: string;
  title: string;
  startMs: number;
  endMs: number;
  createdAt: number;
}

export interface Alerts {
  /** GET /api/alerts (signed in only; anything else empties the list). */
  load(me: Me): Promise<void>;
  /** null until loaded. */
  list(): RaceAlert[] | null;
  state(eventId: string): NotifyState;
  /** Turn emails on (`on`) or off for an event; true when it went through. */
  set(eventId: string, on: boolean): Promise<boolean>;
  onChange(fn: () => void): void;
}

const parseAlerts = (raw: unknown): RaceAlert[] =>
  Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
        .filter((x) => x && typeof x.eventId === 'string' && EVENT_ID.test(x.eventId) && typeof x.title === 'string')
        .map((x) => ({ eventId: x.eventId as string, title: x.title as string, startMs: Number(x.startMs) || 0, endMs: Number(x.endMs) || 0, createdAt: Number(x.createdAt) || 0 }))
    : [];

const FAILED = "Couldn't change that just now. Try again in a minute.";

export function createAlerts(doFetch: typeof fetch = (...a) => fetch(...a)): Alerts {
  let list: RaceAlert[] | null = null;
  const busy = new Set<string>();
  const notes = new Map<string, string>();
  const fns: (() => void)[] = [];
  const changed = (): void => fns.forEach((f) => f());
  const call = async (method: string, body?: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> => {
    try {
      const res = await doFetch(ALERTS_URL, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, status: res.status, body: b && typeof b === 'object' ? b : {} };
    } catch {
      return { ok: false, status: 0, body: {} };
    }
  };
  return {
    async load(me) {
      if (!me.paywall || !me.user) {
        list = me.paywall ? [] : null;
        return changed();
      }
      const r = await call('GET');
      list = r.ok ? parseAlerts(r.body.alerts) : [];
      changed();
    },
    list: () => list,
    state: (eventId) => ({ on: !!list?.some((a) => a.eventId === eventId), busy: busy.has(eventId), note: notes.get(eventId) }),
    async set(eventId, on) {
      if (busy.has(eventId) || !EVENT_ID.test(eventId)) return false;
      busy.add(eventId);
      notes.delete(eventId);
      changed();
      const r = await call(on ? 'POST' : 'DELETE', { eventId });
      busy.delete(eventId);
      if (r.ok) list = parseAlerts(r.body.alerts);
      else notes.set(eventId, typeof r.body.message === 'string' ? r.body.message : FAILED);
      changed();
      return r.ok;
    },
    onChange: (fn) => void fns.push(fn),
  };
}

/**
 * A Notify me click: sign in first when signed out, else turn the emails on, or off when they are on.
 * `ensure` (back from a sign-in with `notify=1`): only ever on. Returns what it did.
 */
export function handleNotify(eventId: string, me: Me, o: { signIn: (eventId: string) => void; alerts?: Pick<Alerts, 'state' | 'set'>; ensure?: boolean }): NotifyAction {
  const a = notifyAction(me);
  if (a === 'signin') o.signIn(eventId);
  else if (a === 'notify' && o.alerts) {
    const on = o.alerts.state(eventId).on;
    if (!(on && o.ensure)) void o.alerts.set(eventId, !on);
  }
  return a;
}
