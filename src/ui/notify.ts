/**
 * Race emails' toggle, "Email me when races are posted" (README "Race emails"): on each Upcoming card of
 * the landing page, on the app's event card (ui/eventCard.ts), and small in the race title's line. Only
 * with the paywall on (/api/auth/me); with it off the button isn't shown.
 *   - Signed out: the sign-in sheet, which comes back to the event with `notify=1`; the app then drops the
 *     marker and asks ("Email me when races are posted for <event>?", the button highlighted). Nothing is
 *     turned on until that click. The landing page has no sheet, so it goes to the event with `notify=1`
 *     and the app opens the sheet there.
 *   - Signed in: "Notify me" turns them on (POST /api/alerts); on, it says "You'll get an email when races
 *     are posted." with Turn off (DELETE). Only ever from a click, shown at once, and put back with a quiet
 *     note if the server says no. Hidden until the list has loaded, and when /api/alerts isn't there.
 * The signed-in user's list (GET /api/alerts) lives in `createAlerts`, which the account sheet's
 * Notifications section shows too; every change to it (loaded, saved, put back) calls onChange.
 * No imports from the app: the landing page loads this.
 */
import type { Me } from '../data/paywall';

/** `?notify=1`: carry a Notify me click through a sign-in (or from the landing page) into the app. */
export const NOTIFY_PARAM = 'notify';
export const NOTIFY_LABEL = 'Notify me';
export const NOTIFY_ON_LABEL = 'Turn off';
export const NOTIFY_ON_TEXT = "You'll get an email when races are posted.";
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
  /** Emails are on for this event (or turning on: the change shows before the server answers). */
  on: boolean;
  busy?: boolean;
  /** Why the last change didn't go through. */
  note?: string;
  /** Back from a sign-in with `notify=1`: the event's title, for the question asked next to the button. */
  ask?: string;
  /** Race emails can't be used right now (the list hasn't loaded, or /api/alerts isn't there): no control for a signed-in viewer. */
  hidden?: boolean;
}

/**
 * The control ('' when hidden). Off: the Notify me button. On: "You'll get an email when races are posted."
 * and a Turn off link. `describedBy`: the card's title, so a screen reader hears which event. `quiet`: the
 * small one in the race title's line ("Race emails on · Turn off").
 */
export function notifyButtonHtml(eventId: string, me: Me, describedBy?: string, state: NotifyState = { on: false }, o: { quiet?: boolean } = {}): string {
  const action = notifyAction(me);
  if (action === 'hidden' || !EVENT_ID.test(eventId) || (action === 'notify' && state.hidden)) return '';
  const on = action === 'notify' && state.on;
  const desc = describedBy && EVENT_ID.test(describedBy) ? ` aria-describedby="${describedBy}"` : '';
  const note = state.note ? ` <span class="notify-note" role="status">${esc(state.note)}</span>` : '';
  const busy = state.busy ? ' disabled' : '';
  if (on) {
    const said = o.quiet ? 'Race emails on' : NOTIFY_ON_TEXT;
    return `<span class="notify-status${o.quiet ? ' notify-quiet' : ''}" role="status">${said}</span> <button type="button" class="linkish notify-btn notify-on${o.quiet ? ' notify-quiet' : ''}" data-notify="${eventId}" aria-label="Turn off race emails"${desc}${busy}>${NOTIFY_ON_LABEL}</button>${note}`;
  }
  const cls = o.quiet ? 'linkish notify-btn notify-quiet' : 'lock-secondary notify-btn';
  const ask = action === 'notify' && state.ask ? state.ask : '';
  const button = `<button type="button" class="${cls}${ask ? ' notify-ask-btn' : ''}" data-notify="${eventId}" title="Email me when races are posted" aria-label="Notify me: email me when races are posted"${desc}${busy}>${NOTIFY_LABEL}</button>`;
  if (ask) return `<span class="notify-ask" role="status">Email me when races are posted for <strong>${esc(ask)}</strong>?</span> ${button}${note}`;
  return `${button}${note}`;
}

// ---- the signed-in user's race emails

export interface RaceAlert {
  eventId: string;
  title: string;
  startMs: number;
  endMs: number;
  createdAt: number;
}

/** off: paywall off; out: signed out; loading: asking; ok: the list is in; unavailable: /api/alerts didn't answer with one. */
export type AlertsStatus = 'off' | 'out' | 'loading' | 'ok' | 'unavailable';

export interface Alerts {
  /** GET /api/alerts (signed in only). Any answer but a list (404 without the feature, 503 without its tables): unavailable. */
  load(me: Me): Promise<void>;
  status(): AlertsStatus;
  /** The events with emails on, as the viewer sees them (a removal in flight already gone); null unless available. */
  list(): RaceAlert[] | null;
  state(eventId: string): NotifyState;
  /**
   * Turn emails on (`on`) or off for an event, from a click only. Shown at once; put back, with a quiet
   * note, if the server says no. True when it went through.
   */
  set(eventId: string, on: boolean): Promise<boolean>;
  /** Ask about an event (back from a sign-in with `notify=1`): its toggle shows the question until a click. */
  ask(eventId: string, title: string): void;
  onChange(fn: () => void): void;
}

const parseAlerts = (raw: unknown): RaceAlert[] =>
  Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
        .filter((x) => x && typeof x.eventId === 'string' && EVENT_ID.test(x.eventId) && typeof x.title === 'string')
        .map((x) => ({ eventId: x.eventId as string, title: x.title as string, startMs: Number(x.startMs) || 0, endMs: Number(x.endMs) || 0, createdAt: Number(x.createdAt) || 0 }))
    : [];

export const SAVE_FAILED = "Couldn't save that. Try again.";

export function createAlerts(doFetch: typeof fetch = (...a) => fetch(...a)): Alerts {
  let list: RaceAlert[] = [];
  let status: AlertsStatus = 'off';
  /** The latest load: an older answer arriving late is dropped. */
  let loads = 0;
  /** Changes in flight: the value being saved. */
  const pending = new Map<string, boolean>();
  const notes = new Map<string, string>();
  const asks = new Map<string, string>();
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
  const isOn = (eventId: string): boolean => pending.get(eventId) ?? list.some((a) => a.eventId === eventId);
  return {
    async load(me) {
      const n = ++loads;
      list = [];
      if (!me.paywall || !me.user) {
        status = me.paywall ? 'out' : 'off';
        return changed();
      }
      status = 'loading';
      changed();
      const r = await call('GET');
      if (n !== loads) return;
      const ok = r.ok && Array.isArray(r.body.alerts);
      list = ok ? parseAlerts(r.body.alerts) : [];
      status = ok ? 'ok' : 'unavailable';
      changed();
    },
    status: () => status,
    list: () => (status === 'ok' ? list.filter((a) => pending.get(a.eventId) !== false) : null),
    state: (eventId) => {
      const on = isOn(eventId);
      return {
        on,
        busy: pending.has(eventId),
        note: notes.get(eventId),
        ...(!on && asks.has(eventId) ? { ask: asks.get(eventId) } : {}),
        ...(status !== 'ok' ? { hidden: true } : {}),
      };
    },
    async set(eventId, on) {
      if (status !== 'ok' || pending.has(eventId) || !EVENT_ID.test(eventId)) return false;
      pending.set(eventId, on);
      notes.delete(eventId);
      asks.delete(eventId);
      changed();
      const r = await call(on ? 'POST' : 'DELETE', { eventId });
      pending.delete(eventId);
      if (r.ok) list = parseAlerts(r.body.alerts);
      // Too many, over, or too many changes: the server's own words; anything else, the quiet default.
      else notes.set(eventId, (r.status === 409 || r.status === 429) && typeof r.body.message === 'string' ? r.body.message : SAVE_FAILED);
      // Gone from this site (404): no control that can't work.
      if (r.status === 404) status = 'unavailable';
      changed();
      return r.ok;
    },
    ask(eventId, title) {
      if (!EVENT_ID.test(eventId)) return;
      asks.set(eventId, title.trim() || 'this regatta');
      changed();
    },
    onChange: (fn) => void fns.push(fn),
  };
}

/**
 * Keep a view's toggles current: `render` on every change to the store, and load the list once /api/auth/me
 * has answered (which renders straight away, then again when the list is in). So a view drawn before the
 * viewer is known never stays without its toggle.
 */
export function watchAlerts(ready: Promise<Me>, alerts: Pick<Alerts, 'load' | 'onChange'>, render: () => void): void {
  alerts.onChange(render);
  void ready.then((me) => alerts.load(me));
}

/** A Notify me click: sign in first when signed out, else turn the emails on, or off when they are on. Returns what it did. */
export function handleNotify(eventId: string, me: Me, o: { signIn: (eventId: string) => void; alerts?: Pick<Alerts, 'state' | 'set'> }): NotifyAction {
  const a = notifyAction(me);
  if (a === 'signin') o.signIn(eventId);
  else if (a === 'notify' && o.alerts) void o.alerts.set(eventId, !o.alerts.state(eventId).on);
  return a;
}

/**
 * `notify=1` in the URL (from the landing page, or back from a sign-in): never turns anything on. Signed
 * out, the sign-in sheet; signed in, the question next to the button, for the user to click.
 */
export function handleNotifyParam(eventId: string, me: Me, o: { signIn: (eventId: string) => void; alerts: Pick<Alerts, 'ask'>; title: string }): NotifyAction {
  const a = notifyAction(me);
  if (a === 'signin') o.signIn(eventId);
  else if (a === 'notify') o.alerts.ask(eventId, o.title);
  return a;
}
