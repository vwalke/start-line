/**
 * "Race tracks are paused": the card shown in place of the digest when the telemetry proxy says the track feed
 * can't be reached (503 telemetry_unavailable, data/loadErrors.ts), with a Try again button and one quiet retry
 * timer. Also the page's plain words for any other failed load: never a URL, query or status code (those go to
 * the console).
 */
import { isTelemetryUnavailable, DEFAULT_RETRY_S } from '../data/loadErrors';
import { isPaywallError } from '../data/paywall';
import { esc } from './format';

export const PAUSED_TITLE = 'Race tracks are paused';
export const PAUSED_BODY = "We're working with Vakaros to restore RaceSense track data. The event schedule and race list are still here.";
export const PAUSED_RETRY = 'Try again';
export const PAUSED_TRYING = 'Trying again…';

/** A race that didn't load for any other reason. */
export const RACE_LOAD_FAILED = "Couldn't load that race. Try again.";
export const EVENT_LOAD_FAILED = "Couldn't load that event. Pick another event or try again.";
export const RACE_LIST_FAILED = "Couldn't load the live race list.";
export const REOPEN_FAILED = "Couldn't reopen your last race.";

export type LoadFailure = 'paywall' | 'unavailable' | 'other';

/** Why a load failed, as the page acts on it: locked (401 / 402), the track feed paused, or anything else. */
export function classifyLoadError(e: unknown): LoadFailure {
  if (isTelemetryUnavailable(e)) return 'unavailable';
  return e instanceof Error && isPaywallError(e.message) ? 'paywall' : 'other';
}

/** The failure for the console: status and message (the request's URL was logged where it failed). */
export function logLoadFailure(what: string, e: unknown): void {
  console.warn(`[recall] ${what}:`, e instanceof Error ? `${e.name}: ${e.message}` : e);
}

const ET = 'America/New_York';
let etFormat: Intl.DateTimeFormat | null = null;

/** "12:10 p.m. ET": the gun's clock time in Eastern Time, 12-hour, a.m. / p.m. */
export function easternTime(ms: number): string {
  etFormat ??= new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit', hour12: true });
  const parts = etFormat.formatToParts(new Date(ms));
  const part = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? '';
  const period = part('dayPeriod').toLowerCase().startsWith('p') ? 'p.m.' : 'a.m.';
  return `${part('hour')}:${part('minute')} ${period} ET`;
}

export interface PausedView {
  /** Which race this is (event, division, race): the same race keeps the card in place on a retry. */
  key: string;
  eventName?: string | null;
  raceName?: string | null;
  gunMs?: number | null;
}

/** "ClubSwan 28 Gold Cup 2026 · Race 1 · Gun 12:10 p.m. ET", with whatever isn't known left out. */
export function pausedContext(v: Pick<PausedView, 'eventName' | 'raceName' | 'gunMs'>): string {
  const gun = v.gunMs != null && Number.isFinite(v.gunMs) && v.gunMs > 0 ? `Gun ${easternTime(v.gunMs)}` : '';
  return [v.eventName?.trim(), v.raceName?.trim(), gun].filter(Boolean).join(' · ');
}

/** A tracker sending to a satellite: the feed, not missing data. */
const ICON = `<svg class="paused-icon" viewBox="0 0 48 48" width="44" height="44" aria-hidden="true" focusable="false">
  <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <g transform="rotate(-45 18 30)">
      <rect x="13" y="25" width="10" height="10" rx="2"/>
      <rect x="1" y="27" width="9" height="6" rx="1"/>
      <rect x="26" y="27" width="9" height="6" rx="1"/>
      <path d="M10 30h3M23 30h3M18 35v3"/>
    </g>
  </g>
  <g class="paused-signal" fill="none" stroke-width="2" stroke-linecap="round">
    <path d="M31 11a8 8 0 0 1 6 6"/>
    <path d="M31 4.5a14.5 14.5 0 0 1 12.5 12.5" opacity="0.55"/>
  </g>
</svg>`;

export function pausedCardHtml(v: PausedView): string {
  const context = pausedContext(v);
  return `<section class="card paused-card" role="status" aria-labelledby="paused-title">
    ${ICON}
    <div class="paused-main">
      <h2 id="paused-title" class="paused-title">${esc(PAUSED_TITLE)}</h2>
      ${context ? `<p class="paused-context">${esc(context)}</p>` : ''}
      <p class="paused-body">${esc(PAUSED_BODY)}</p>
      <div class="paused-actions">
        <button type="button" class="lock-secondary paused-retry" data-paused="retry">${esc(PAUSED_RETRY)}</button>
        <span class="paused-hint"></span>
      </div>
    </div>
  </section>`;
}

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** One pending retry at most: arming again replaces it. */
export function createRetryTimer(timers: Timers = realTimers): { arm(run: () => void, seconds?: number): void; clear(): void; armed(): boolean } {
  let handle: unknown = null;
  const clear = (): void => {
    if (handle != null) timers.clearTimeout(handle);
    handle = null;
  };
  return {
    arm(run, seconds = DEFAULT_RETRY_S) {
      clear();
      handle = timers.setTimeout(() => {
        handle = null;
        run();
      }, seconds * 1000);
    },
    clear,
    armed: () => handle != null,
  };
}

/** The bits of an element the card uses (an HTMLElement in the page, a stub in the tests). */
export interface PausedHost {
  innerHTML: string;
  hidden: boolean;
  addEventListener(type: 'click', fn: (ev: { target: unknown }) => void): void;
  querySelector(sel: string): { textContent: string | null } | null;
}

export interface PausedCard {
  /** Show (or keep) the card for `v`, and try again after `retryAfterS`. */
  show(v: PausedView, retryAfterS?: number): void;
  /** Take it away and stop trying (loaded, or another race or event opened). */
  hide(): void;
  /** The race shown, or null. */
  key(): string | null;
}

/**
 * The card in `host`. A retry (the timer or Try again) calls `retry`, at most one at a time; the page then calls
 * show (still paused) or hide (loaded, or something else). A retry that ends with neither re-arms the timer.
 * `hidden()`: the page is in the background, so the timer's retry waits another round.
 */
export function createPausedCard(
  host: PausedHost,
  retry: () => Promise<unknown>,
  o: { timers?: Timers; hidden?: () => boolean } = {},
): PausedCard {
  const timer = createRetryTimer(o.timers);
  let shown: string | null = null;
  let delay = DEFAULT_RETRY_S;
  let busy = false;
  const hint = (text: string): void => {
    const el = host.querySelector('.paused-hint');
    if (el) el.textContent = text;
  };
  const fire = (auto: boolean): void => {
    if (!shown || busy) return;
    if (auto && o.hidden?.()) return timer.arm(() => fire(true), delay);
    const key = shown;
    busy = true;
    timer.clear();
    hint(PAUSED_TRYING);
    void retry()
      .catch(() => undefined)
      .finally(() => {
        if (!busy || shown !== key) return;
        busy = false;
        hint('');
        timer.arm(() => fire(true), delay);
      });
  };
  host.addEventListener('click', (ev) => {
    const t = ev.target as { closest?: (s: string) => unknown } | null;
    if (t?.closest?.('[data-paused="retry"]')) fire(false);
  });
  return {
    show(v, retryAfterS = DEFAULT_RETRY_S) {
      busy = false;
      delay = retryAfterS > 0 ? retryAfterS : DEFAULT_RETRY_S;
      if (shown !== v.key || host.hidden) host.innerHTML = pausedCardHtml(v);
      else hint('');
      shown = v.key;
      host.hidden = false;
      timer.arm(() => fire(true), delay);
    },
    hide() {
      timer.clear();
      busy = false;
      shown = null;
      host.hidden = true;
    },
    key: () => shown,
  };
}
