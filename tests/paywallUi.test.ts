import { describe, expect, it } from 'vitest';
import { PAYWALL_OFF, fetchMe, isPaywallError, parseMe, type Me } from '../src/data/paywall';
import { askCoach } from '../src/data/askCoach/api';
import { ASK_MESSAGES, type AskErrorCode } from '../src/data/askCoach/protocol';
import { freeRaces } from '../src/data/freeRace';
import { buildRaceList } from '../src/data/raceList';
import { currentDoc } from '../src/data/racesense/adapter';
import { hereWithout, isLocked, lockCardHtml, lockView, lockedRange, passLine, returnParam, sheetHtml, valueLine } from '../src/ui/paywall';
import { EVENT, NOW, beneluxRegatta } from './paywallHelpers';

const doc = currentDoc(beneluxRegatta());
const free = freeRaces(doc);
const races = buildRaceList(doc).races;
const DAY = 86_400_000;

const on = (over: Partial<Extract<Me, { paywall: true }>> = {}): Me => ({ paywall: true, user: null, entitlements: [], signIn: { email: true, google: false }, ...over });
const pass = (scope: 'regatta' | 'season', eventId: string | null, expiresAt: number | null = null) => ({ scope, eventId, startsAt: NOW - DAY, expiresAt, seats: null, owner: true });

describe('paywall flag on the page', () => {
  it('reads anything but a well-formed { paywall: true } as off', async () => {
    expect(parseMe({ paywall: false })).toEqual(PAYWALL_OFF);
    expect(parseMe(null)).toEqual(PAYWALL_OFF);
    expect(parseMe({ paywall: 'true' })).toEqual(PAYWALL_OFF);
    expect(parseMe({ paywall: true, user: { email: 'a@example.com' }, entitlements: [pass('regatta', EVENT), 'junk'], signIn: { google: true } })).toEqual({
      paywall: true,
      user: { email: 'a@example.com' },
      entitlements: [pass('regatta', EVENT)],
      signIn: { email: false, google: true },
    });
    const html = (async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    expect(await fetchMe(html)).toEqual(PAYWALL_OFF);
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchMe(down)).toEqual(PAYWALL_OFF);
    const offJson = (async () => new Response('{"paywall":false}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    expect(await fetchMe(offJson)).toEqual(PAYWALL_OFF);
  });

  it('spots a refused data request in the worker’s error text', () => {
    expect(isPaywallError('402 Payment Required for /api/telemetry/event/x')).toBe(true);
    expect(isPaywallError('401  for /api/telemetry/event/x')).toBe(true);
    expect(isPaywallError('404 Not Found for /api/telemetry/event/x')).toBe(false);
    expect(isPaywallError('4021 rows')).toBe(false);
  });
});

describe('lock decision', () => {
  it('never locks with the paywall off, nor race 1', () => {
    expect(isLocked(PAYWALL_OFF, free, EVENT, 'J70', 5, NOW)).toBe(false);
    expect(isLocked(on(), free, EVENT, 'J70', 1, NOW)).toBe(false);
  });

  it('locks races 2+ without a pass for this event (or every event)', () => {
    expect(isLocked(on(), free, EVENT, 'J70', 2, NOW)).toBe(true);
    expect(isLocked(on({ user: { email: 'a@example.com' } }), free, EVENT, 'J70', 9, NOW)).toBe(true);
    expect(isLocked(on({ entitlements: [pass('regatta', 'otherEvent1234')] }), free, EVENT, 'J70', 2, NOW)).toBe(true);
    expect(isLocked(on({ entitlements: [pass('regatta', EVENT)] }), free, EVENT, 'J70', 2, NOW)).toBe(false);
    expect(isLocked(on({ entitlements: [pass('season', null, NOW + DAY)] }), free, EVENT, 'J70', 2, NOW)).toBe(false);
    expect(isLocked(on({ entitlements: [pass('season', null, NOW - 1)] }), free, EVENT, 'J70', 2, NOW)).toBe(true);
    // A rebuilt race (its gun minute) is locked like any race after race 1.
    expect(isLocked(on(), free, EVENT, 'J70', 202610171230, NOW)).toBe(true);
  });

  it('names the races a pass opens as the picker does', () => {
    expect(lockedRange(races, free, 'J70')).toBe('R2–R9');
    expect(lockedRange(races.filter((r) => r.raceNumber <= 2), free, 'J70')).toBe('R2');
    expect(lockedRange(races.filter((r) => r.raceNumber === 1), free, 'J70')).toBe('');
    expect(valueLine('R2–R9')).toBe("See the start, every leg and Coach's top 3 for every boat in R2–R9.");
  });
});

describe('lock card', () => {
  const listed = races.find((r) => r.raceNumber === 3);
  const view = lockView(doc, { division: 'J70', raceNumber: 3, listed, range: 'R2–R9', me: on() });

  it('keeps the race header and the free finishes, from the regatta document alone', () => {
    expect(view.titleHtml).toContain('Benelux Sailing League Act III');
    expect(view.titleHtml).toContain('Race 3');
    expect(view.gunLine).toMatch(/^Sat 17 Oct 2026 \d\d:03:01 \(local\)/);
    expect(view.boats).toBeGreaterThan(0);
    expect(view.results.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(view.results[0].elapsed).toMatch(/^\d+:\d\d$/);
  });

  it('offers both passes, race 1 free, sign in and restore; escapes what it shows', () => {
    const html = lockCardHtml(view);
    expect(html).toContain('Unlock this regatta — $12');
    expect(html).toContain('Season Pass — $49/yr');
    expect(html).toContain('<h3 id="lock-title">See the start, every leg and Coach&#39;s top 3 for every boat in R2–R9.</h3>');
    expect(html).toContain('Race 1 is free');
    expect(html).toContain('data-pw="signin"');
    expect(html).toContain('data-pw="restore"');
    expect(html).toContain('class="lock-teaser"');
    expect(html).not.toContain('<script');
    const signedIn = lockCardHtml({ ...view, signedIn: '<b>x</b>@example.com', results: [{ place: 1, sail: '<i>', name: 'A&B', elapsed: '1:00' }] });
    expect(signedIn).toContain('Signed in as &lt;b&gt;x&lt;/b&gt;@example.com');
    expect(signedIn).not.toContain('data-pw="signin"');
    expect(signedIn).toContain('&lt;i&gt;');
  });
});

describe('account sheet', () => {
  const title = (id: string): string => (id === EVENT ? 'Benelux Act III' : id);

  it('is empty with the paywall off', () => {
    expect(sheetHtml(PAYWALL_OFF, { mode: 'signin' }, title)).toBe('');
  });

  it('signs in by email (and Google when set up), then says to check the email', () => {
    const m = on({ signIn: { email: true, google: true } });
    const s = sheetHtml(m, { mode: 'signin', note: 'Sign in first: your pass is kept with your email.' }, title);
    expect(s).toContain('type="email"');
    expect(s).toContain('Continue with Google');
    expect(s).toContain('Sign in first');
    expect(sheetHtml(on(), { mode: 'signin' }, title)).not.toContain('Continue with Google');
    expect(sheetHtml(m, { mode: 'sent', email: 'a@example.com' }, title)).toContain('Check your email');
  });

  it('lists passes with their expiry, Manage subscription for a season owner, Restore and Sign out', () => {
    const m = on({ user: { email: 'a@example.com' }, entitlements: [pass('season', null, Date.parse('2027-10-22T12:00:00Z')), pass('regatta', EVENT)] });
    const s = sheetHtml(m, { mode: 'account' }, title);
    expect(s).toContain('Signed in as <strong>a@example.com</strong>');
    expect(s).toContain('Season Pass · every regatta · until 22 Oct 2027');
    expect(s).toContain('Regatta Pass · Benelux Act III');
    expect(s).toContain('Manage subscription');
    expect(s).toContain('data-pw="signout"');
    expect(passLine(pass('regatta', 'unknownEvent12'), title)).toBe('Regatta Pass · unknownEvent12');
  });
});

describe('return trips', () => {
  it('reads and strips the checkout / sign-in markers', () => {
    expect(returnParam('?event=x&checkout=success')).toEqual({ kind: 'checkout', value: 'success' });
    expect(returnParam('?checkout=cancel')).toEqual({ kind: 'checkout', value: 'cancel' });
    expect(returnParam('?signin=expired')).toEqual({ kind: 'signin', value: 'expired' });
    expect(returnParam('?checkout=hack')).toBeNull();
    expect(hereWithout('https://recall.walkeforward.com/?event=x&race=3&checkout=success#coach')).toBe('/?event=x&race=3#coach');
  });
});

describe('Ask Coach on a locked race', () => {
  it('says so (401 / 402 → locked)', async () => {
    for (const status of [401, 402]) {
      let got: AskErrorCode | null = null;
      const f = (async () => new Response(JSON.stringify({ error: 'payment_required' }), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
      await askCoach(
        { session: 'abcdefghijklmnop1234', question: 'q', history: [], ids: {}, context: { view: 'race' } } as unknown as Parameters<typeof askCoach>[0],
        { onDelta: () => undefined, onDone: () => undefined, onError: (c) => (got = c) },
        { fetch: f },
      );
      expect(got).toBe('locked');
    }
    expect(ASK_MESSAGES.locked).toMatch(/Race 1 is free/);
  });
});
