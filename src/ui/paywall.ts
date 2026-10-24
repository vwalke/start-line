/**
 * The paywall on the page (only when /api/auth/me says it is on; otherwise none of this shows):
 *   - the lock card, in place of the digest for a race the viewer can't open (race 2+ without a
 *     pass, or a data request answered 401 / 402): the race header from the free regatta document,
 *     its RaceSense finishes, a blurred placeholder chart (no tracks are loaded), and the Regatta Pass
 *     (the only pass on sale: race 1 of every regatta is free, the rest of a regatta is $50);
 *   - an account button in the masthead opening a sheet: sign in (Google, Apple or Microsoft, each only
 *     when set up, then an email link, behind Turnstile when the site has a key), the passes held,
 *     the signed-in devices (with how each signed in; sign out any other one, or all of them),
 *     Restore access, Manage subscription (an existing Season Pass subscriber only), Sign out;
 *   - a browser signed out from elsewhere (the 3-device cap, another device, the admin) gets the
 *     sign-in sheet once, saying why; a sign-in that signed out another device says which, once;
 *   - back from a sign-in (`signin=ok`): a "You're signed in." toast that hides itself after 5 seconds.
 * Decisions and markup are pure functions (tested in node); createPaywall wires them to the DOM.
 */
import { passesUnlock, type PassView } from '../../functions/_entitlements';
import { isFreeRace, type FreeRaces } from '../data/freeRace';
import { PRICE_REGATTA } from '../data/price';
import { appPath } from '../landing/route';
import {
  BUY_PARAM,
  PAYWALL_OFF,
  fetchMe,
  oauthStartUrl,
  openPortal,
  revokeDevice,
  revokeOtherDevices,
  sendRestoreLink,
  sendSignInLink,
  signOut,
  peekBuy,
  startCheckout,
  type BumpedView,
  type BuyIntent,
  type DeviceView,
  type Me,
  type OAuthProvider,
  type SignInMethod,
  type SignedOutReason,
} from '../data/paywall';
import { createTurnstile, type Turnstile } from './turnstile';
import type { ListedRace } from '../data/raceList';
import { findRace, tzOffsetMs, type RaceListItem } from '../data/racesense/adapter';
import type { RegattaDoc } from '../data/racesense/types';
import { pickRace } from './lastView';
import { duration, esc, gunTimeLine } from './format';
import { raceName, raceTitleHtml, shortRaceName } from './races';

export { PRICE_REGATTA };

// ---- decisions

/** Is this race locked for this viewer? Never with the paywall off, never race 1. */
export function isLocked(me: Me, free: FreeRaces, eventId: string, division: string, raceNumber: number, now: number): boolean {
  if (!me.paywall) return false;
  if (isFreeRace(free, division, raceNumber)) return false;
  return !passesUnlock(me.entitlements, eventId, now);
}

/**
 * The race to open when the link names none: `last` (the latest finished race, as always) unless the
 * paywall is on and this viewer can't open this regatta, then race 1 of last's division as the server
 * counts it (freeRace.ts), so a first visit opens on the free race rather than a lock card. `last`
 * again when that division has no listed race 1. `free` is only worked out when it is needed.
 */
export function defaultRaceFor(races: readonly RaceListItem[], last: RaceListItem | null, o: { me: Me; free: () => FreeRaces; eventId: string; now: number }): RaceListItem | null {
  if (!o.me.paywall || passesUnlock(o.me.entitlements, o.eventId, o.now)) return last;
  const division = (last ?? races[0])?.division;
  const w = division == null ? undefined : o.free().windows.find((x) => x.division === division);
  return (w && races.find((r) => r.division === w.division && r.raceNumber === w.raceNumber)) || last;
}

/** The race an event opens on: the wanted one (an explicit `race=`, locked or not) if listed, else defaultRaceFor (pickRace's rules). */
export const startRace = (
  races: RaceListItem[],
  want: { division: string; raceNumber: number } | undefined,
  last: RaceListItem | null,
  o: { me: Me; free: () => FreeRaces; eventId: string; now: number },
  strict = false,
): RaceListItem | null => pickRace(races, want, defaultRaceFor(races, last, o), strict);

/** The races a pass would open in this division, as the picker names them: "R2–R8", "R2", or '' when none. */
export function lockedRange(races: readonly ListedRace[], free: FreeRaces, division: string): string {
  const names = races
    .filter((r) => r.division === division && !r.practice && !isFreeRace(free, division, r.raceNumber))
    .sort((a, b) => a.gunMs - b.gunMs)
    .map((r) => shortRaceName(raceName(r)));
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names[0]}–${names[names.length - 1]}`;
}

export const valueLine = (range: string): string => `See the start, every leg and Coach's top 3 for every boat in ${range || 'every race after race 1'}.`;

/** A pass, in a line: "Regatta Pass · this regatta", "All-regattas pass · every regatta · until 21 Oct 2027" (a Season Pass, no longer sold, or a gift). */
export function passLine(p: PassView, eventTitle: (id: string) => string): string {
  const until = p.expiresAt != null ? ` · until ${new Date(p.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
  const gift = p.gift ? ' (gift)' : '';
  if (p.scope === 'regatta') return `Regatta Pass${gift} · ${p.eventId ? eventTitle(p.eventId) : 'one regatta'}${until}`;
  if (p.scope === 'season') return `All-regattas pass${gift} · every regatta${until}`;
  return `Coach plan${p.owner ? '' : ' (team seat)'} · every regatta${until}`;
}

// ---- the lock card

export interface LockResult {
  place: number;
  sail: string;
  name: string;
  elapsed: string;
}

export interface LockView {
  titleHtml: string;
  gunLine: string;
  boats: number;
  results: LockResult[];
  range: string;
  signedIn: string | null;
  canBuy: boolean;
  /** The sign-in methods set up here (/api/auth/me signIn): email links (and so Restore access), Google, Microsoft, Apple. */
  signInEmail?: boolean;
  signInGoogle?: boolean;
  signInMicrosoft?: boolean;
  signInApple?: boolean;
  message?: string;
}

/** The lock card's facts, all from the (free) regatta document. */
export function lockView(doc: RegattaDoc, o: { division: string; raceNumber: number; listed: ListedRace | undefined; range: string; me: Me }): LockView {
  const { div, race } = findRace(doc, { division: o.division, raceNumber: o.raceNumber });
  const gun = race.starts?.filter((s) => s.startTime != null).at(-1)?.startTime ?? o.listed?.gunMs ?? null;
  const names = new Map((div.participants ?? []).map((p) => [p.sailNumber, p.boatName ?? '']));
  const seen = new Set<string>();
  const results = (race.finishes ?? [])
    .map((f) => ({ f, t: Date.parse(f.finishingTime) }))
    .filter(({ f, t }) => Number.isFinite(t) && !seen.has(f.sailNumber) && seen.add(f.sailNumber))
    .sort((a, b) => a.t - b.t)
    .map(({ f, t }, i) => ({ place: i + 1, sail: f.sailNumber, name: names.get(f.sailNumber) ?? '', elapsed: gun != null ? duration((t - gun) / 1000) : '—' }));
  return {
    titleHtml: raceTitleHtml({ eventName: doc.name, boatClass: div.boatClass ?? div.name, raceNumber: o.raceNumber }, o.listed),
    gunLine: gun != null ? gunTimeLine(gun, tzOffsetMs(race.timezoneOffset)) : '',
    boats: (div.participants ?? []).length,
    results,
    range: o.range,
    signedIn: o.me.paywall && o.me.user ? o.me.user.email : null,
    canBuy: o.me.paywall,
    signInEmail: o.me.paywall && o.me.signIn.email,
    signInGoogle: o.me.paywall && o.me.signIn.google,
    signInMicrosoft: o.me.paywall && !!o.me.signIn.microsoft,
    signInApple: o.me.paywall && !!o.me.signIn.apple,
  };
}

/** A blurred stand-in for the track map: static shapes only (no tracks are fetched for a locked race). */
export const TEASER_SVG = `<svg class="lock-teaser" viewBox="0 0 320 140" aria-hidden="true" focusable="false">
  <rect width="320" height="140" fill="var(--grid)" />
  <path d="M20 120 C70 90 60 40 120 30 S220 60 250 20" fill="none" stroke="var(--s1)" stroke-width="3" />
  <path d="M30 124 C90 100 80 60 140 44 S230 80 280 26" fill="none" stroke="var(--s2)" stroke-width="3" />
  <path d="M40 128 C100 110 110 70 160 60 S250 96 300 34" fill="none" stroke="var(--s3)" stroke-width="3" />
  <path d="M12 116 C50 70 90 50 110 20 S200 30 240 12" fill="none" stroke="var(--s4)" stroke-width="3" />
  <circle cx="250" cy="20" r="5" fill="var(--ink-2)" /><circle cx="26" cy="122" r="5" fill="var(--ink-2)" />
</svg>`;

export function lockCardHtml(v: LockView): string {
  const rows = v.results
    .map((r) => `<tr><td>${r.place}</td><td>${esc(r.sail)}</td><td>${esc(r.name)}</td><td class="num">${esc(r.elapsed)}</td></tr>`)
    .join('');
  const results = v.results.length
    ? `<details class="lock-results"><summary>Finishes <span class="muted">(RaceSense, unofficial)</span></summary>
        <table><thead><tr><th scope="col">#</th><th scope="col">Sail</th><th scope="col">Boat</th><th scope="col" class="num">Elapsed</th></tr></thead><tbody>${rows}</tbody></table></details>`
    : '';
  // Only what is set up: Restore access sends an email, so it goes with email sign-in.
  const restore = v.signInEmail ? ' · <button type="button" class="linkish" data-pw="restore">Restore access</button>' : '';
  const who = v.signedIn
    ? `Signed in as ${esc(v.signedIn)}${restore}`
    : v.signInEmail || v.signInGoogle || v.signInMicrosoft || v.signInApple
      ? `Already bought? <button type="button" class="linkish" data-pw="signin">Sign in</button>${restore}`
      : 'Sign-in is unavailable right now';
  return `<div id="lock-summary">${v.titleHtml}<p>${[esc(v.gunLine), `${v.boats} boats`].filter(Boolean).join(' · ')}</p></div>
    <section class="card lock-card" aria-labelledby="lock-title">
      <div class="lock-teaser-wrap">${TEASER_SVG}<span class="lock-badge" aria-hidden="true">🔒</span></div>
      <h3 id="lock-title">${esc(valueLine(v.range))}</h3>
      <div class="lock-buy">
        <button type="button" class="lock-primary" data-pw="buy-regatta"${v.canBuy ? '' : ' disabled'}>Unlock this regatta — ${PRICE_REGATTA}</button>
      </div>
      ${v.message ? `<p class="lock-msg" role="status">${esc(v.message)}</p>` : ''}
      <p class="lock-small">Race 1 of every regatta is free; unlock the rest of a regatta for ${PRICE_REGATTA} · ${who}</p>
      ${results}
    </section>`;
}

// ---- the account sheet

export type SheetMode = 'signin' | 'sent' | 'restore' | 'restore-sent' | 'account';

export interface SheetState {
  mode: SheetMode;
  /** Why the sheet opened ("Sign in first: …"), or the last error. */
  note?: string;
  email?: string;
  busy?: boolean;
}

/** "Oct 20" (with the year when it isn't this year's), in the viewer's time zone. */
export function shortDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** The sign-in sheet's note for a browser signed out from elsewhere (/api/auth/me signedOutReason). */
export function signedOutNote(reason: SignedOutReason): string {
  if (reason === 'device_limit') return 'You were signed out on this device because your account signed in somewhere else. Recall stays signed in on up to 3 devices at a time.';
  if (reason === 'remote') return 'You were signed out on this device from another device.';
  return 'You were signed out. Sign in again to keep going.';
}

/** "Signing in here signed out Safari on iPhone (last used Oct 20)." for the devices this sign-in bumped; '' for none. */
export function bumpedNote(bumped: readonly BumpedView[], now = Date.now()): string {
  const names = bumped.map((b) => `${b.label} (last used ${shortDate(b.lastSeenAt, now)})`);
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Signing in here signed out ${list}.`;
}

/** How a device signed in, after its name: "Chrome on Mac · Google"; nothing for an older session. */
export const METHOD_TEXT: Record<SignInMethod, string> = { email: 'Email link', google: 'Google', microsoft: 'Microsoft', apple: 'Apple' };

/** The account sheet's Devices section: how many of the cap, one row per device (with how it signed in), Sign out for the others. */
export function devicesHtml(devices: { max: number; list: readonly DeviceView[] } | undefined, busy = false, now = Date.now()): string {
  if (!devices || !devices.list.length) return '';
  const dis = busy ? ' disabled' : '';
  const rows = devices.list
    .map(
      (d) => `<li class="account-device"><span class="account-device-name">${esc(d.label)}${d.method ? ` · ${METHOD_TEXT[d.method]}` : ''}</span>
        <span class="account-device-when muted">${d.current ? 'This device' : `Last used ${esc(shortDate(d.lastSeenAt, now))}`}</span>
        ${d.current ? '' : `<button type="button" class="lock-secondary" data-pw="revoke" data-id="${esc(d.id)}"${dis}>Sign out</button>`}</li>`,
    )
    .join('');
  const others = devices.list.length > 1 ? `<p class="account-actions"><button type="button" class="lock-secondary" data-pw="revoke-others"${dis}>Sign out all other devices</button></p>` : '';
  return `<h3 class="account-sub">Devices</h3><p>Signed in on ${devices.list.length} of ${devices.max} devices.</p><ul class="account-devices">${rows}</ul>${others}`;
}

/** Apple's logo glyph (white on the black button, black on the white one in dark mode: it takes the text color). */
export const APPLE_LOGO =
  '<svg class="signin-logo" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>';
/** Microsoft's four squares, 1px apart, in its colors. */
export const MICROSOFT_LOGO =
  '<svg class="signin-logo" viewBox="0 0 21 21" width="18" height="18" aria-hidden="true" focusable="false"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>';

/** The provider buttons set up here, in this order: Google, Apple, Microsoft ('' for none). */
export function providerButtonsHtml(signIn: { google: boolean; microsoft?: boolean; apple?: boolean }): string {
  const buttons = [
    signIn.google ? '<p><a class="lock-secondary google" data-pw="google" href="#">Continue with Google</a></p>' : '',
    signIn.apple ? `<p><a class="lock-secondary signin-apple" data-pw="apple" href="#">${APPLE_LOGO}<span>Continue with Apple</span></a></p>` : '',
    signIn.microsoft ? `<p><a class="lock-secondary signin-microsoft" data-pw="microsoft" href="#">${MICROSOFT_LOGO}<span>Continue with Microsoft</span></a></p>` : '',
  ].join('');
  return buttons ? `<div class="account-providers">${buttons}</div>` : '';
}

export function sheetHtml(me: Me, s: SheetState, eventTitle: (id: string) => string): string {
  if (!me.paywall) return '';
  const note = s.note ? `<p class="account-note" role="status">${esc(s.note)}</p>` : '';
  const head = (title: string): string =>
    `<div class="switcher-head"><h2 class="switcher-title" id="account-title">${esc(title)}</h2><button type="button" class="switcher-close" data-pw="close">Close</button></div>`;
  // Turnstile's widget goes in the slot (src/ui/turnstile.ts), only when the site has a key.
  const slot = (action: 'signin' | 'restore'): string => (me.signIn.turnstileSiteKey ? `<div class="account-turnstile" data-pw-turnstile="${action}"></div>` : '');
  const emailForm = (action: 'signin' | 'restore', label: string): string =>
    `<form class="account-form" data-pw-form="${action}">
      <label>Email <input type="email" name="email" autocomplete="email" required maxlength="254" value="${esc(s.email ?? '')}"${s.busy ? ' disabled' : ''}></label>
      ${slot(action)}<button type="submit" class="lock-primary"${s.busy ? ' disabled' : ''}>${esc(label)}</button>
    </form>`;
  const email = me.signIn.email;
  // With email sign-in off there is no email UI at all (no link form, Restore access or "check your email").
  if (!email && (s.mode === 'sent' || s.mode === 'restore-sent' || s.mode === 'restore')) s = { ...s, mode: me.user ? 'account' : 'signin' };
  if (s.mode === 'sent' || s.mode === 'restore-sent') {
    const what = s.mode === 'sent' ? 'a sign-in link' : 'a sign-in link if we have a purchase for that address';
    return `${head('Check your email')}<p>We've sent ${what} to <strong>${esc(s.email ?? '')}</strong>. It works once, for 15 minutes.</p>
      <p><button type="button" class="linkish" data-pw="signin">Use another address</button></p>`;
  }
  if (s.mode === 'restore') {
    return `${head('Restore access')}${note}<p>Bought a pass before? Enter the email you paid with and we'll send a sign-in link: your passes come back with it.</p>${emailForm('restore', 'Send the link')}`;
  }
  if (s.mode === 'account' && me.user) {
    const passes = me.entitlements.length
      ? `<ul class="account-passes">${me.entitlements.map((p) => `<li>${esc(passLine(p, eventTitle))}</li>`).join('')}</ul>`
      : '<p class="muted">No passes yet. Race 1 of every regatta is free.</p>';
    // Manage subscription: for an existing Season Pass subscriber (no longer sold; never a gift).
    const manage = me.entitlements.some((p) => p.scope === 'season' && p.owner && !p.gift) ? `<button type="button" class="lock-secondary" data-pw="portal"${s.busy ? ' disabled' : ''}>Manage subscription</button>` : '';
    return `${head('Your account')}${note}<p>Signed in as <strong>${esc(me.user.email)}</strong></p>
      <h3 class="account-sub">Passes</h3>${passes}
      ${devicesHtml(me.devices, s.busy)}
      <p class="account-actions">${manage}${email ? '<button type="button" class="lock-secondary" data-pw="restore">Restore access</button>' : ''}<button type="button" class="lock-secondary" data-pw="signout"${s.busy ? ' disabled' : ''}>Sign out</button></p>`;
  }
  const providers = providerButtonsHtml(me.signIn);
  if (!email && !providers) return `${head('Sign in')}${note}<p class="muted">Sign-in is unavailable right now. Race 1 of every regatta is free.</p>`;
  if (!email) return `${head('Sign in')}${note}<p>Your passes are kept with your account.</p>${providers}`;
  // The providers first, then the email link (its form, Turnstile and Restore access).
  const kept = providers ? 'Your passes are kept with your account and its email address.' : 'Your passes are kept with your email address.';
  return `${head('Sign in')}${note}<p>${kept}</p>${providers}${providers ? '<p class="account-or">or</p>' : ''}${emailForm('signin', 'Email me a sign-in link')}
    <p class="lock-small"><button type="button" class="linkish" data-pw="restore">Restore access</button></p>`;
}

// ---- return trips (Stripe, the email link, Google)

export type ReturnParam =
  | { kind: 'checkout'; value: 'success' | 'cancel' }
  | { kind: 'signin'; value: 'ok' | 'expired' | 'failed'; via?: OAuthProvider; reason?: string }
  | null;

const PROVIDERS: readonly OAuthProvider[] = ['google', 'microsoft', 'apple'];

/**
 * `signin=ok` (the server's marker on a fresh sign-in, functions/_auth.ts SIGNED_IN_PARAM), `expired`,
 * `failed` (with `via`, the provider, and `reason` when there is more to say); `checkout=`.
 */
export function returnParam(search: string): ReturnParam {
  const q = new URLSearchParams(search);
  const c = q.get('checkout');
  if (c === 'success' || c === 'cancel') return { kind: 'checkout', value: c };
  const s = q.get('signin');
  if (s === 'ok' || s === 'expired') return { kind: 'signin', value: s };
  if (s !== 'failed') return null;
  const via = q.get('via') as OAuthProvider | null;
  const reason = q.get('reason');
  return { kind: 'signin', value: s, ...(via && PROVIDERS.includes(via) ? { via } : {}), ...(reason && /^[a-z_]{1,40}$/.test(reason) ? { reason } : {}) };
}

export const PROVIDER_NAMES: Record<OAuthProvider, string> = { google: 'Google', microsoft: 'Microsoft', apple: 'Apple' };
export const MICROSOFT_EMAIL_NOTE = "Your Microsoft account didn't share a verified email address, so it can't be used to sign in here. Try Google, Apple or an email link.";
export const APPLE_EMAIL_NOTE = "Apple didn't share a verified email address, so we couldn't sign you in. Try again, or use Google, Microsoft or an email link.";

/** What the page says after a failed provider sign-in ('' for a sign-in the sailor cancelled at Apple); no `via` is Google's (older links). */
export function failedNote(via?: OAuthProvider, reason?: string): string {
  if (reason === 'cancelled') return '';
  if (reason === 'microsoft_email') return MICROSOFT_EMAIL_NOTE;
  if (reason === 'apple_email') return APPLE_EMAIL_NOTE;
  return `Couldn't sign you in with ${PROVIDER_NAMES[via ?? 'google']}. Try again, or use an email link.`;
}

export const EXPIRED_NOTE = 'That sign-in link has expired or was already used. Ask for a new one below.';

/** The welcome toast's line: with the address when /api/auth/me knows it. */
export const welcomeText = (email?: string | null): string => (email ? `You're signed in as ${email}.` : "You're signed in.");

/** How long the toast stays up. */
export const TOAST_MS = 5_000;

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

/**
 * A short toast (`render` draws it, '' hides it): shown, then hidden after `ms` or when dismissed.
 * Never takes focus. On the page it has its own element (#signin-toast), so loading a race can't clear it.
 */
export function createToast(o: { render: (text: string) => void; timers?: Timers; ms?: number }) {
  const t = o.timers ?? realTimers;
  let timer: unknown = null;
  let text = '';
  const stop = (): void => {
    if (timer != null) t.clear(timer);
    timer = null;
  };
  const hide = (): void => {
    stop();
    if (!text) return;
    text = '';
    o.render('');
  };
  return {
    show(next: string): void {
      stop();
      text = next;
      o.render(next);
      timer = t.set(hide, o.ms ?? TOAST_MS);
    },
    /** The close button. */
    dismiss: hide,
    text: (): string => text,
  };
}

/** This page, to come back to after sign-in or checkout (without those markers; in the app, never the landing page: landing/route.ts appPath). */
export function hereWithout(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('checkout');
  u.searchParams.delete('signin');
  u.searchParams.delete('via');
  u.searchParams.delete('reason');
  u.searchParams.delete(BUY_PARAM);
  return appPath(`${u.pathname}${u.search}${u.hash}`);
}

/**
 * Back from a sign-in that carried a purchase intent (the server's one-time `buy=` marker): the checkout to
 * start, or null: paywall off, signed out, no or unreadable marker, or the pass is already held (a purchase
 * or a gift that just attached: the race simply opens). The server re-checks the marker's signature, user and expiry.
 */
export function autoCheckout(me: Me, search: string, now: number): (BuyIntent & { intent: string }) | null {
  if (!me.paywall || !me.user) return null;
  const token = new URLSearchParams(search).get(BUY_PARAM);
  const b = peekBuy(token);
  if (!b || passesUnlock(me.entitlements, b.eventId, now)) return null;
  return { ...b, intent: token! };
}

// ---- the controller

export interface LockTarget {
  doc: RegattaDoc;
  eventId: string;
  division: string;
  raceNumber: number;
  listed: ListedRace | undefined;
  range: string;
}

export interface Paywall {
  /** /api/auth/me's first answer (off on any failure). */
  ready: Promise<Me>;
  me(): Me;
  locked(free: FreeRaces, eventId: string, division: string, raceNumber: number): boolean;
  showLock(before: HTMLElement, t: LockTarget): void;
  hideLock(): void;
  lockShown(): boolean;
  /** Re-read /api/auth/me; true when it changed (onChange has run). */
  refresh(): Promise<boolean>;
}

export type NoteStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The "Signing in here signed out …" note until the sailor has seen it: shown (as often as /me is
 * re-read) and only marked seen in `store` (sessionStorage on the page, by the current device's id)
 * when they dismiss it or open the account sheet, which then carries it as its note. It shows in its
 * own element (`render`), never the app's #notice, so loading a race can't wipe it.
 */
export function createBumpNote(o: { store: NoteStore | null; render: (text: string) => void; now?: () => number }) {
  let key: string | null = null;
  let text = '';
  const seen = new Set<string>();
  const wasSeen = (k: string): boolean => {
    if (seen.has(k)) return true;
    try {
      return !!o.store?.getItem(k);
    } catch {
      return false;
    }
  };
  const markSeen = (): void => {
    if (!key) return;
    seen.add(key);
    try {
      o.store?.setItem(key, '1');
    } catch {
      /* storage off: remembered for this page only */
    }
  };
  const hide = (): void => {
    text = '';
    key = null;
    o.render('');
  };
  return {
    /** After each /me: show the note if this session bumped devices and it hasn't been seen. */
    update(me: Me): void {
      const current = me.paywall && me.user && me.bumped?.length ? me.devices?.list.find((d) => d.current)?.id : undefined;
      const k = current ? `recall.bumped.${current}` : null;
      if (!k || !me.paywall || wasSeen(k)) {
        if (text) hide();
        return;
      }
      key = k;
      text = bumpedNote(me.bumped ?? [], (o.now ?? Date.now)());
      o.render(text);
    },
    /** The Dismiss button. */
    dismiss(): void {
      markSeen();
      hide();
    },
    /** The account sheet opened: its note (if any), now seen; the separate note goes. */
    takeForSheet(): string {
      const t = text;
      if (t) {
        markSeen();
        hide();
      }
      return t;
    },
    text: (): string => text,
  };
}

const sessionStore = (): Storage | null => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
};

export function createPaywall(o: { onChange: () => void; notice: (text: string) => void; eventTitle: (id: string) => string }): Paywall {
  let me: Me = PAYWALL_OFF;
  let lockEl: HTMLElement | null = null;
  let target: LockTarget | null = null;
  let lockMsg: string | undefined;
  let dialog: HTMLDialogElement | null = null;
  let openBtn: HTMLButtonElement | null = null;
  let sheet: SheetState = { mode: 'signin' };
  /** The pass clicked while signed out: carried through the sign-in the sheet starts. */
  let pendingBuy: BuyIntent | null = null;
  let autoStarted = false;
  /** Turnstile on the email forms: made the first time a form shows with a site key (never with the paywall off). */
  let turnstile: Turnstile | null = null;
  let reasonShown = false;
  /** The bump note's own element, right after the app's #notice (which race loading clears freely). */
  let noteEl: HTMLElement | null = null;
  /** The welcome toast (fixed, bottom of the screen): a live region inside, filled a frame after it shows so it is announced. */
  let toastEl: HTMLElement | null = null;
  const toast = createToast({
    render: (text) => {
      if (!toastEl && text) {
        toastEl = document.createElement('div');
        toastEl.id = 'signin-toast';
        toastEl.className = 'toast';
        toastEl.hidden = true;
        toastEl.innerHTML = '<p class="toast-text" role="status" aria-live="polite"></p><button type="button" class="toast-close" aria-label="Dismiss">×</button>';
        toastEl.querySelector('.toast-close')?.addEventListener('click', () => toast.dismiss());
        document.body.appendChild(toastEl);
      }
      if (!toastEl) return;
      const live = toastEl.querySelector<HTMLElement>('.toast-text');
      toastEl.hidden = !text;
      if (!live) return;
      if (!text) live.textContent = '';
      else
        requestAnimationFrame(() => {
          if (toast.text() === text) live.textContent = text;
        });
    },
  });
  const bump = createBumpNote({
    store: sessionStore(),
    render: (text) => {
      if (!noteEl && text) {
        const anchor = document.getElementById('notice');
        if (!anchor) return;
        noteEl = document.createElement('div');
        noteEl.id = 'account-notice';
        noteEl.className = 'notice account-notice';
        noteEl.setAttribute('role', 'status');
        noteEl.addEventListener('click', (ev) => {
          if ((ev.target as HTMLElement).closest('[data-pw="dismiss-note"]')) bump.dismiss();
        });
        anchor.after(noteEl);
      }
      if (!noteEl) return;
      noteEl.textContent = text;
      if (text) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.pw = 'dismiss-note';
        btn.textContent = 'Dismiss';
        noteEl.append(' ', btn);
      }
      noteEl.hidden = !text;
    },
  });

  const renderLock = (): void => {
    if (!lockEl || !target) return;
    lockEl.innerHTML = lockCardHtml({ ...lockView(target.doc, { ...target, me }), message: lockMsg });
  };
  /** The widget follows the form's slot: rendered into a new slot, removed with the form. */
  const syncTurnstile = (box: Element): void => {
    const key = me.paywall ? me.signIn.turnstileSiteKey : null;
    const slot = key ? box.querySelector<HTMLElement>('[data-pw-turnstile]') : null;
    if (!slot || !key) return turnstile?.unmount();
    turnstile ??= createTurnstile({ siteKey: key });
    void turnstile.mount(slot, slot.dataset.pwTurnstile === 'restore' ? 'restore' : 'signin');
  };
  const renderSheet = (): void => {
    const box = dialog?.querySelector('.switcher-sheet');
    if (!box) return;
    box.innerHTML = sheetHtml(me, sheet, o.eventTitle);
    syncTurnstile(box);
  };
  /** Signed out from elsewhere: open the sign-in sheet once, saying why. */
  const sayWhySignedOut = (): void => {
    if (!me.paywall || me.user || !me.signedOutReason || reasonShown) return;
    reasonShown = true;
    pendingBuy = null;
    openSheet({ mode: 'signin', note: signedOutNote(me.signedOutReason) });
  };
  /** Just signed in and that bumped a device: say which, until dismissed or the account sheet opens. */
  const sayWhoWasBumped = (): void => bump.update(me);
  const renderButton = (): void => {
    if (!openBtn) return;
    openBtn.textContent = me.paywall && me.user ? 'Account' : 'Sign in';
  };
  const openSheet = (s: SheetState): void => {
    // The account sheet carries the bump note at its top (and that counts as seen).
    const bumpText = s.mode === 'account' && !s.note ? bump.takeForSheet() : '';
    sheet = bumpText ? { ...s, note: bumpText } : s;
    renderSheet();
    if (dialog && !dialog.open) {
      openBtn?.setAttribute('aria-expanded', 'true');
      dialog.showModal();
    }
    dialog?.querySelector<HTMLElement>('input, .switcher-close')?.focus();
  };

  async function refresh(): Promise<boolean> {
    const next = await fetchMe();
    const changed = JSON.stringify(next) !== JSON.stringify(me);
    me = next;
    if (!changed) return false;
    mount();
    renderButton();
    renderLock();
    if (dialog?.open) renderSheet();
    o.onChange();
    sayWhySignedOut();
    sayWhoWasBumped();
    return true;
  }

  /** Unlock this regatta (the Regatta Pass, the only pass on sale). */
  async function buy(): Promise<void> {
    if (!me.paywall) return;
    const eventId = target?.eventId;
    if (!me.user) {
      pendingBuy = eventId ? { product: 'regatta', eventId } : null;
      return openSheet({ mode: 'signin', note: 'Sign in first: checkout opens right after.' });
    }
    if (!eventId) return;
    lockMsg = 'Opening the payment page…';
    renderLock();
    const r = await startCheckout(eventId, hereWithout(location.href));
    if (r.ok && typeof r.body.url === 'string') {
      location.assign(r.body.url);
      return;
    }
    lockMsg = typeof r.body.message === 'string' ? r.body.message : "Couldn't open the payment page. Try again in a minute.";
    if (r.status === 401) {
      lockMsg = undefined;
      openSheet({ mode: 'signin', note: 'Sign in first: your pass is kept with your email.' });
    }
    if (r.status === 409) lockMsg = undefined;
    renderLock();
    if (r.status === 401 || r.status === 409) await refresh();
  }

  /** Manage subscription: POST for Stripe's portal URL, then go there. */
  async function manage(): Promise<void> {
    sheet = { ...sheet, busy: true, note: undefined };
    renderSheet();
    const r = await openPortal();
    if (r.ok && typeof r.body.url === 'string') {
      location.assign(r.body.url);
      return;
    }
    sheet = { ...sheet, busy: false, note: typeof r.body.message === 'string' ? r.body.message : "Couldn't open the subscription page. Try again in a minute." };
    renderSheet();
  }

  async function submitEmail(form: HTMLFormElement, action: 'signin' | 'restore'): Promise<void> {
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim();
    sheet = { mode: action, email, busy: true };
    // Busy in place (not a re-render), so the Turnstile widget in the form keeps its token.
    for (const el of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) el.disabled = true;
    let token: string | null = null;
    if (me.paywall && me.signIn.turnstileSiteKey) {
      token = turnstile ? await turnstile.token() : null;
      if (!token) {
        sheet = { mode: action, email, note: 'Please complete the check and try again.' };
        return renderSheet();
      }
    }
    const back = hereWithout(location.href);
    const r = action === 'signin' ? await sendSignInLink(email, back, undefined, pendingBuy, token) : await sendRestoreLink(email, back, undefined, token);
    // A token is good once: ask for a fresh one whatever the answer.
    turnstile?.reset();
    if (r.ok) sheet = { mode: action === 'signin' ? 'sent' : 'restore-sent', email };
    else sheet = { mode: action, email, note: typeof r.body.message === 'string' ? r.body.message : "Couldn't send the email. Try again in a minute." };
    renderSheet();
  }

  /** Sign out another device (or every other one), then show the list as it now stands. */
  async function revoke(id: string | null): Promise<void> {
    sheet = { mode: 'account', busy: true };
    renderSheet();
    const r = id ? await revokeDevice(id) : await revokeOtherDevices();
    sheet = { mode: 'account', note: r.ok ? undefined : typeof r.body.message === 'string' ? r.body.message : "Couldn't sign that device out. Try again in a minute." };
    await refresh();
    renderSheet();
  }

  function onAction(ev: Event): void {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-pw]');
    if (!el) return;
    const a = el.dataset.pw;
    if (a === 'google' || a === 'microsoft' || a === 'apple') {
      ev.preventDefault();
      location.assign(oauthStartUrl(a, hereWithout(location.href), pendingBuy));
    } else if (a === 'buy-regatta') void buy();
    else if (a === 'signin') {
      pendingBuy = null;
      openSheet({ mode: 'signin' });
    }
    else if (a === 'restore') openSheet({ mode: 'restore', email: me.paywall && me.user ? me.user.email : undefined });
    else if (a === 'close') dialog?.close();
    else if (a === 'portal') void manage();
    else if (a === 'revoke' && el.dataset.id) void revoke(el.dataset.id);
    else if (a === 'revoke-others') void revoke(null);
    else if (a === 'signout') {
      sheet = { ...sheet, busy: true };
      renderSheet();
      void signOut().then(async () => {
        await refresh();
        sheet = { mode: 'signin' };
        renderSheet();
      });
    }
  }

  /** The masthead button and the sheet: made once, the first time the paywall is on. */
  function mount(): void {
    if (!me.paywall || dialog) return;
    const inner = document.querySelector('.masthead-inner');
    if (!inner) return;
    openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'account-open';
    openBtn.setAttribute('aria-haspopup', 'dialog');
    openBtn.setAttribute('aria-expanded', 'false');
    openBtn.setAttribute('aria-controls', 'account');
    inner.appendChild(openBtn);
    dialog = document.createElement('dialog');
    dialog.id = 'account';
    dialog.className = 'switcher account';
    dialog.setAttribute('aria-labelledby', 'account-title');
    dialog.innerHTML = '<div class="switcher-sheet"></div>';
    document.body.appendChild(dialog);
    openBtn.addEventListener('click', () => {
      pendingBuy = null;
      openSheet({ mode: me.paywall && me.user ? 'account' : 'signin' });
    });
    dialog.addEventListener('close', () => {
      turnstile?.unmount();
      openBtn?.setAttribute('aria-expanded', 'false');
      openBtn?.focus();
    });
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) dialog?.close();
      else onAction(ev);
    });
    dialog.addEventListener('submit', (ev) => {
      const form = (ev.target as HTMLElement).closest<HTMLFormElement>('form[data-pw-form]');
      if (!form) return;
      ev.preventDefault();
      void submitEmail(form, form.dataset.pwForm === 'restore' ? 'restore' : 'signin');
    });
    renderButton();
  }

  /** Back from Stripe, Google, Microsoft, Apple or an email link: say so, tidy the URL, and wait for the pass to land. */
  async function arrive(): Promise<void> {
    // Read once: the markers leave the URL below.
    const search = location.search;
    const p = returnParam(search);
    const welcome = (): void => {
      if (p?.kind === 'signin' && p.value === 'ok' && me.paywall && me.user) toast.show(welcomeText(me.user.email));
    };
    // A sign-in that carried a purchase intent: straight on to Stripe, once (the markers leave the URL first; no toast in the way).
    const auto = autoCheckout(me, search, Date.now());
    if (new URLSearchParams(search).has(BUY_PARAM)) history.replaceState(history.state, '', hereWithout(location.href));
    if (auto && !autoStarted) {
      autoStarted = true;
      o.notice('Opening the payment page…');
      const r = await startCheckout(auto.eventId, hereWithout(location.href), undefined, auto.intent);
      if (r.ok && typeof r.body.url === 'string') {
        location.assign(r.body.url);
        return;
      }
      o.notice('');
      // 409: the pass is held after all (refresh unlocks); anything else leaves the lock card to click.
      if (r.status === 409 || r.status === 401) await refresh();
      welcome();
      return;
    }
    if (!p) return;
    history.replaceState(history.state, '', hereWithout(location.href));
    if (p.kind === 'signin') {
      if (p.value === 'ok') welcome();
      // An expired link: the sign-in sheet, to ask for a new one (a note instead when signed in already, or without email sign-in here).
      else if (p.value === 'expired' && me.paywall && !me.user && me.signIn.email) openSheet({ mode: 'signin', note: EXPIRED_NOTE });
      else if (p.value === 'expired') o.notice('That sign-in link has expired or was already used. Ask for a new one.');
      else if (p.value === 'failed') {
        const n = failedNote(p.via, p.reason);
        if (n) o.notice(n);
      }
      return;
    }
    if (p.value !== 'success') return;
    const eventId = new URLSearchParams(location.search).get('event');
    const unlocked = (): boolean => me.paywall && passesUnlock(me.entitlements, eventId, Date.now());
    o.notice('Payment received: unlocking…');
    // The webhook may land a moment after the browser does.
    for (let i = 0; i < 10 && !unlocked(); i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      await refresh();
    }
    o.notice(unlocked() ? '' : 'Payment received. Your pass should appear in a minute: reload the page then.');
  }

  const ready = fetchMe().then((m) => {
    me = m;
    mount();
    if (m.paywall) {
      sayWhySignedOut();
      sayWhoWasBumped();
      void arrive();
    }
    return m;
  });

  return {
    ready,
    me: () => me,
    locked: (free, eventId, division, raceNumber) => isLocked(me, free, eventId, division, raceNumber, Date.now()),
    showLock(before, t) {
      if (!lockEl) {
        lockEl = document.createElement('div');
        lockEl.id = 'lock';
        lockEl.className = 'lock';
        lockEl.addEventListener('click', onAction);
        before.parentElement?.insertBefore(lockEl, before);
      }
      if (target?.eventId !== t.eventId || target?.raceNumber !== t.raceNumber || target?.division !== t.division) lockMsg = undefined;
      target = t;
      lockEl.hidden = false;
      renderLock();
    },
    hideLock() {
      if (lockEl) lockEl.hidden = true;
      target = null;
    },
    lockShown: () => !!lockEl && !lockEl.hidden,
    refresh,
  };
}
