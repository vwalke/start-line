/**
 * The landing page at `/` (its content is static HTML in index.html, `#landing`, so it renders and is
 * crawlable without waiting on any script or RaceSense fetch). This only fills in two things:
 *   - the Regatta Pass price, from data/price.ts (the HTML carries the same text; tests hold them equal);
 *   - "Continue: <event · race>", a link to /regattas (which reopens it) when a race was viewed before;
 *   - "Upcoming regattas": cards for the /api/landing events starting in the next two weeks (data/upcoming.ts),
 *     each with Notify me (ui/notify.ts) when the paywall is on; the section stays hidden when there are none;
 * and starts the feature cards' lightbox (lightbox.ts). Nothing of the app (ui/app.ts) is loaded here
 * (ui/notify.ts imports nothing of it).
 */
import { isFreeEvent } from '../data/freeEvents';
import { PAYWALL_OFF, fetchMe, type Me } from '../data/paywall';
import { PRICE_REGATTA } from '../data/price';
import { fetchLanding } from '../data/racesense/api';
import type { LandingEvent } from '../data/racesense/types';
import { dateRangeText, startsInText, upcomingEvents } from '../data/upcoming';
import { createAlerts, eventPath, handleNotify, notifyButtonHtml, notifyHref, type Alerts } from '../ui/notify';
import { startLightbox } from './lightbox';
import { REGATTAS_PATH } from './route';

/** recall.lastView (ui/lastView.ts LAST_VIEW_KEY): read here without loading the app's modules. */
export const LAST_VIEW_KEY = 'recall.lastView';
/** As ui/lastView.ts parseLastView requires. */
const EVENT_ID = /^[A-Za-z0-9_-]{4,64}$/;
/** Rebuilt races are keyed by their gun's UTC minute (data/orphans.ts): not a number to show. */
const MAX_RACE_NO = 1e6;

const text = (x: unknown): string => (typeof x === 'string' && x.trim().length <= 120 ? x.trim() : '');

/**
 * The "Continue" link for a saved record (the raw localStorage value), or null when there is none
 * or it isn't one the app would reopen. The link goes to /regattas, where the app restores it.
 */
export function continueLink(raw: string | null | undefined): { href: string; label: string } | null {
  if (!raw) return null;
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!x || typeof x !== 'object' || x.v !== 1) return null;
  const { eventId, division, raceNumber } = x;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) return null;
  if (typeof division !== 'string' || !division) return null;
  if (typeof raceNumber !== 'number' || !Number.isInteger(raceNumber) || raceNumber < 1) return null;
  const event = text(x.eventTitle);
  const race = text(x.raceName) || (raceNumber < MAX_RACE_NO ? `Race ${raceNumber}` : '');
  const where = [event, division.trim().slice(0, 40), race].filter(Boolean).join(' · ');
  return { href: REGATTAS_PATH, label: event ? `Continue: ${where}` : `Continue your last race: ${where}` };
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(LAST_VIEW_KEY);
  } catch {
    return null;
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** As ui/format.ts esc (not imported: that module brings analysis code along). */
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** The Upcoming cards ('' for none): title (a link to the event), class and venue, dates, "Starts in …", Free, Notify me. */
export function upcomingCardsHtml(events: readonly LandingEvent[], me: Me, now: number, tzOffsetMin?: number, alerts?: Pick<Alerts, 'state'>): string {
  return upcomingEvents(events, now)
    .map((e) => {
      const id = `up-${e.eventId}`;
      const free = me.paywall && isFreeEvent(e.eventId, now) ? ' <span class="free-tag">Free</span>' : '';
      const meta = [e.classLabel?.trim(), e.venue?.trim()].filter((x): x is string => !!x).map(esc).join(' · ');
      const notify = notifyButtonHtml(e.eventId, me, id, alerts?.state(e.eventId));
      return `<li class="land-card land-up">
        <h3 id="${esc(id)}"><a href="${esc(eventPath(e.eventId))}">${esc(e.title)}</a>${free}</h3>
        ${meta ? `<p class="land-up-meta">${meta}</p>` : ''}
        <p class="land-up-when">${esc(dateRangeText(e.startMs, e.endMs))} · <strong>${esc(startsInText(e.startMs, now, tzOffsetMin))}</strong></p>
        ${notify ? `<p class="land-up-actions">${notify}</p>` : ''}
      </li>`;
    })
    .join('');
}

/** Fill in "Upcoming regattas" (hidden until there is one); any failure leaves it hidden. */
export async function showUpcoming(
  doc: Document,
  o: { landing?: () => Promise<{ events: LandingEvent[] }>; me?: () => Promise<Me>; now?: () => number; go?: (href: string) => void; alerts?: Alerts } = {},
): Promise<void> {
  const section = doc.getElementById('land-upcoming');
  const list = section?.querySelector<HTMLElement>('.land-upcoming-list');
  if (!section || !list) return;
  let events: LandingEvent[];
  let me: Me;
  try {
    [events, me] = await Promise.all([(o.landing ?? fetchLanding)().then((r) => r.events ?? []), (o.me ?? fetchMe)().catch(() => PAYWALL_OFF)]);
  } catch {
    return;
  }
  const alerts = o.alerts ?? createAlerts();
  const render = (): void => {
    const html = upcomingCardsHtml(events, me, (o.now ?? Date.now)(), undefined, alerts);
    list.innerHTML = html;
    section.hidden = !html;
  };
  render();
  alerts.onChange(render);
  const go = o.go ?? ((href: string) => location.assign(href));
  section.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button[data-notify]');
    // Signed out: to the event, where the app opens the sign-in sheet (which comes back there).
    if (b?.dataset.notify) handleNotify(b.dataset.notify, me, { signIn: (id) => go(notifyHref(id)), alerts });
  });
  if (me.paywall && me.user && section.hidden === false) await alerts.load(me);
}

export function startLanding(doc: Document = document): void {
  for (const n of doc.querySelectorAll<HTMLElement>('[data-price="regatta"]')) n.textContent = PRICE_REGATTA;
  const link = continueLink(readSaved());
  const a = doc.getElementById('landing-continue') as HTMLAnchorElement | null;
  if (link && a) {
    a.href = link.href;
    a.textContent = link.label;
    a.hidden = false;
  }
  startLightbox(doc);
  void showUpcoming(doc);
}
