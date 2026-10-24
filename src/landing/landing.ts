/**
 * The landing page at `/` (its content is static HTML in index.html, `#landing`, so it renders and is
 * crawlable without waiting on any script or RaceSense fetch). This only fills in two things:
 *   - the Regatta Pass price, from data/price.ts (the HTML carries the same text; tests hold them equal);
 *   - "Continue: <event · race>", a link to /regattas (which reopens it) when a race was viewed before;
 * and starts the feature cards' lightbox (lightbox.ts). Nothing of the app (ui/app.ts) is loaded here.
 */
import { PRICE_REGATTA } from '../data/price';
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
}
