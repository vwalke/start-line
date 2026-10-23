/**
 * The paywall on the page (only when /api/auth/me says it is on; otherwise none of this shows):
 *   - the lock card, in place of the digest for a race the viewer can't open (race 2+ without a
 *     pass, or a data request answered 401 / 402): the race header from the free regatta document,
 *     its RaceSense finishes, a blurred placeholder chart (no tracks are loaded), and the Regatta Pass
 *     (the only pass on sale: race 1 of every regatta is free, the rest of a regatta is $50);
 *   - an account button in the masthead opening a sheet: sign in (email link or Google), the
 *     passes held, Restore access, Manage subscription (an existing Season Pass subscriber only), Sign out.
 * Decisions and markup are pure functions (tested in node); createPaywall wires them to the DOM.
 */
import { passesUnlock, type PassView } from '../../functions/_entitlements';
import { isFreeRace, type FreeRaces } from '../data/freeRace';
import {
  BUY_PARAM,
  PAYWALL_OFF,
  fetchMe,
  googleStartUrl,
  openPortal,
  sendRestoreLink,
  sendSignInLink,
  signOut,
  peekBuy,
  startCheckout,
  type BuyIntent,
  type Me,
} from '../data/paywall';
import type { ListedRace } from '../data/raceList';
import { findRace, tzOffsetMs, type RaceListItem } from '../data/racesense/adapter';
import type { RegattaDoc } from '../data/racesense/types';
import { pickRace } from './lastView';
import { duration, esc, gunTimeLine } from './format';
import { raceName, raceTitleHtml, shortRaceName } from './races';

/** The displayed price (copy only: what is charged comes from the Stripe price id, STRIPE_PRICE_REGATTA). */
export const PRICE_REGATTA = '$50';

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
  /** The sign-in methods set up here (/api/auth/me signIn): email links (and so Restore access), Google. */
  signInEmail?: boolean;
  signInGoogle?: boolean;
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
    : v.signInEmail || v.signInGoogle
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

export function sheetHtml(me: Me, s: SheetState, eventTitle: (id: string) => string): string {
  if (!me.paywall) return '';
  const note = s.note ? `<p class="account-note" role="status">${esc(s.note)}</p>` : '';
  const head = (title: string): string =>
    `<div class="switcher-head"><h2 class="switcher-title" id="account-title">${esc(title)}</h2><button type="button" class="switcher-close" data-pw="close">Close</button></div>`;
  const emailForm = (action: 'signin' | 'restore', label: string): string =>
    `<form class="account-form" data-pw-form="${action}">
      <label>Email <input type="email" name="email" autocomplete="email" required maxlength="254" value="${esc(s.email ?? '')}"${s.busy ? ' disabled' : ''}></label>
      <button type="submit" class="lock-primary"${s.busy ? ' disabled' : ''}>${esc(label)}</button>
    </form>`;
  const email = me.signIn.email;
  const google = me.signIn.google;
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
      <p class="account-actions">${manage}${email ? '<button type="button" class="lock-secondary" data-pw="restore">Restore access</button>' : ''}<button type="button" class="lock-secondary" data-pw="signout"${s.busy ? ' disabled' : ''}>Sign out</button></p>`;
  }
  if (!email && !google) return `${head('Sign in')}${note}<p class="muted">Sign-in is unavailable right now. Race 1 of every regatta is free.</p>`;
  const googleBtn = google ? `<p><a class="lock-secondary google" data-pw="google" href="#">Continue with Google</a></p>` : '';
  if (!email) return `${head('Sign in')}${note}<p>Your passes are kept with your account.</p>${googleBtn}`;
  return `${head('Sign in')}${note}<p>Your passes are kept with your email address.</p>${emailForm('signin', 'Email me a sign-in link')}${googleBtn}
    <p class="lock-small"><button type="button" class="linkish" data-pw="restore">Restore access</button></p>`;
}

// ---- return trips (Stripe, the email link, Google)

export type ReturnParam = { kind: 'checkout'; value: 'success' | 'cancel' } | { kind: 'signin'; value: 'expired' | 'failed' } | null;

export function returnParam(search: string): ReturnParam {
  const q = new URLSearchParams(search);
  const c = q.get('checkout');
  if (c === 'success' || c === 'cancel') return { kind: 'checkout', value: c };
  const s = q.get('signin');
  if (s === 'expired' || s === 'failed') return { kind: 'signin', value: s };
  return null;
}

/** This page, to come back to after sign-in or checkout (without those markers). */
export function hereWithout(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('checkout');
  u.searchParams.delete('signin');
  u.searchParams.delete(BUY_PARAM);
  return `${u.pathname}${u.search}${u.hash}`;
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

  const renderLock = (): void => {
    if (!lockEl || !target) return;
    lockEl.innerHTML = lockCardHtml({ ...lockView(target.doc, { ...target, me }), message: lockMsg });
  };
  const renderSheet = (): void => {
    if (dialog) dialog.querySelector('.switcher-sheet')!.innerHTML = sheetHtml(me, sheet, o.eventTitle);
  };
  const renderButton = (): void => {
    if (!openBtn) return;
    openBtn.textContent = me.paywall && me.user ? 'Account' : 'Sign in';
  };
  const openSheet = (s: SheetState): void => {
    sheet = s;
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
    renderSheet();
    const r = action === 'signin' ? await sendSignInLink(email, hereWithout(location.href), undefined, pendingBuy) : await sendRestoreLink(email, hereWithout(location.href));
    if (r.ok) sheet = { mode: action === 'signin' ? 'sent' : 'restore-sent', email };
    else sheet = { mode: action, email, note: typeof r.body.message === 'string' ? r.body.message : "Couldn't send the email. Try again in a minute." };
    renderSheet();
  }

  function onAction(ev: Event): void {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-pw]');
    if (!el) return;
    const a = el.dataset.pw;
    if (a === 'google') {
      ev.preventDefault();
      location.assign(googleStartUrl(hereWithout(location.href), pendingBuy));
    } else if (a === 'buy-regatta') void buy();
    else if (a === 'signin') {
      pendingBuy = null;
      openSheet({ mode: 'signin' });
    }
    else if (a === 'restore') openSheet({ mode: 'restore', email: me.paywall && me.user ? me.user.email : undefined });
    else if (a === 'close') dialog?.close();
    else if (a === 'portal') void manage();
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

  /** Back from Stripe, Google or an email link: say so, tidy the URL, and wait for the pass to land. */
  async function arrive(): Promise<void> {
    // A sign-in that carried a purchase intent: straight on to Stripe, once (the marker leaves the URL first).
    const auto = autoCheckout(me, location.search, Date.now());
    if (new URLSearchParams(location.search).has(BUY_PARAM)) history.replaceState(history.state, '', hereWithout(location.href));
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
      return;
    }
    const p = returnParam(location.search);
    if (!p) return;
    history.replaceState(history.state, '', hereWithout(location.href));
    if (p.kind === 'signin') {
      o.notice(p.value === 'expired' ? 'That sign-in link has expired or was already used. Ask for a new one.' : "Couldn't sign you in with Google. Try again, or use an email link.");
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
    if (m.paywall) void arrive();
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
