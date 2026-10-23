import { beforeEach, describe, expect, it } from 'vitest';
import { BUY_PARAM, BUY_TTL_MS, EMAIL_RATE_MAX, handleAuth, parseIntent, readBuy, signBuy, type AuthCtx, type AuthDeps } from '../functions/_auth';
import { ensureUser } from '../functions/_authDb';
import { handleBilling, type BillingCtx } from '../functions/_stripe';
import { RateLimiter } from '../functions/_vkx';
import type { PaywallEnv } from '../functions/_paywall';
import { googleStartUrl, peekBuy, type Me } from '../src/data/paywall';
import { autoCheckout, hereWithout, lockCardHtml, sheetHtml, type LockView } from '../src/ui/paywall';
import type { PassView } from '../functions/_entitlements';
import { grantSql } from '../scripts/grant-gift.mjs';
import { MemD1 } from './d1mem';
import { EVENT, NOW, ORIGIN, giveRegatta, giveSeason, paywallEnv, resetPaywallCaches, signIn } from './paywallHelpers';

const SECRET = 'auth_secret_test_fake';
const authCtx = (request: Request, env: PaywallEnv, path: string): AuthCtx => ({ request, env, params: { path: path.split('/') } });
const billCtx = (request: Request, env: PaywallEnv, path: string): BillingCtx => ({ request, env, params: { path: path.split('/') } });
const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;

function mailbox(now = NOW): AuthDeps & { links: () => string[] } {
  const sent: string[] = [];
  return {
    now: () => now,
    cache: null,
    limits: { email: new RateLimiter(EMAIL_RATE_MAX, 3_600_000), ip: new RateLimiter(20, 3_600_000) },
    log: (line) => sent.push(line),
    links: () => sent.flatMap((s) => s.match(/https?:\/\/\S+\/api\/auth\/verify\?token=[A-Za-z0-9_-]+/g) ?? []),
  };
}

/** The magic-link round trip with a body (returnTo, buy …): the confirm POST's redirect. */
async function magicLink(db: MemD1, body: Record<string, unknown>, route = 'email'): Promise<Response> {
  const env = paywallEnv(db);
  const m = mailbox();
  const req = new Request(`${ORIGIN}/api/auth/${route}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' } });
  expect((await handleAuth(authCtx(req, env, route), m)).status).toBe(200);
  const token = new URL(m.links()[0]).searchParams.get('token')!;
  const confirm = new Request(`${ORIGIN}/api/auth/verify`, { method: 'POST', body: new URLSearchParams({ token }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } });
  const res = await handleAuth(authCtx(confirm, env, 'verify'), m);
  expect(res.status).toBe(303);
  return res;
}

/** Google, start to callback, with these start query parameters. */
async function google(db: MemD1, query: Record<string, string>, email = 'skipper@example.com'): Promise<Response> {
  const env = paywallEnv(db);
  const start = await handleAuth(authCtx(new Request(`${ORIGIN}/api/auth/google/start?${new URLSearchParams(query)}`), env, 'google/start'), mailbox());
  const loc = new URL(start.headers.get('location')!);
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, exp: NOW / 1000 + 600, sub: `g-${email}`, email, email_verified: true, nonce: loc.searchParams.get('nonce') };
  const tokenEndpoint = (async () => new Response(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc(claims)}.sig` }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const res = await handleAuth(authCtx(new Request(`${ORIGIN}/api/auth/google/callback?code=c&state=${loc.searchParams.get('state')}`, { headers: { cookie } }), env, 'google/callback'), { ...mailbox(), fetch: tokenEndpoint });
  expect(res.status).toBe(302);
  return res;
}

const markerOf = (res: Response): string | null => new URL(res.headers.get('location')!, ORIGIN).searchParams.get(BUY_PARAM);
const userIdOf = async (db: MemD1, email: string): Promise<string> => (await ensureUser(db, email, NOW)).id;

beforeEach(resetPaywallCaches);

describe('the buy intent: validated, signed, expiring, bound to the user', () => {
  it('parseIntent: the Regatta Pass (the only pass on sale) and EVENT_ID_RE only', () => {
    expect(parseIntent('regatta', EVENT)).toEqual({ product: 'regatta', eventId: EVENT });
    for (const [p, e] of [['regatta', null], ['regatta', '../x'], ['regatta', 'a'], ['coach', EVENT], ['', EVENT], [undefined, undefined], ['SEASON', null]]) expect(parseIntent(p, e), `${p} ${e}`).toBeNull();
  });

  it('the Season Pass is no longer an intent: not parsed, and an old signed season marker reads as none', async () => {
    for (const e of [null, 'ignored', EVENT]) expect(parseIntent('season', e)).toBeNull();
    // A marker signed before the Season Pass was dropped (same secret, user and expiry): refused.
    const { createHmac } = await import('node:crypto');
    const hand = (o: Record<string, unknown>): string => {
      const payload = Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${payload}.${createHmac('sha256', SECRET).update(`recall-buy:${payload}`).digest('base64url')}`;
    };
    // The hand-made signature is the real one (a regatta marker made this way is accepted), so the refusal is the product.
    expect(await readBuy(SECRET, hand({ p: 'regatta', e: EVENT, u: 'u1', x: NOW + BUY_TTL_MS }), 'u1', NOW)).toEqual({ product: 'regatta', eventId: EVENT });
    const old = hand({ p: 'season', e: null, u: 'u1', x: NOW + BUY_TTL_MS });
    expect(await readBuy(SECRET, old, 'u1', NOW)).toBeNull();
    expect(peekBuy(old)).toBeNull();
  });

  it('readBuy accepts its own marker for that user before it expires, and nothing else', async () => {
    const tok = await signBuy(SECRET, { product: 'regatta', eventId: EVENT, userId: 'u1', exp: NOW + BUY_TTL_MS });
    expect(await readBuy(SECRET, tok, 'u1', NOW)).toEqual({ product: 'regatta', eventId: EVENT });
    expect(await readBuy(SECRET, tok, 'u1', NOW + BUY_TTL_MS)).toBeNull(); // expired
    expect(await readBuy(SECRET, tok, 'u2', NOW)).toBeNull(); // someone else's
    expect(await readBuy('another_secret_fake', tok, 'u1', NOW)).toBeNull();
    expect(await readBuy('', tok, 'u1', NOW)).toBeNull();
    const [payload, sig] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ p: 'season', e: null, u: 'u1', x: NOW + 1e9 })).toString('base64url');
    expect(await readBuy(SECRET, `${forged}.${sig}`, 'u1', NOW)).toBeNull(); // payload swapped
    expect(await readBuy(SECRET, `${payload}.${sig.slice(0, -2)}AA`, 'u1', NOW)).toBeNull();
    expect(await readBuy(SECRET, `${tok}.x`, 'u1', NOW)).toBeNull();
    for (const junk of [null, 42, '', 'abc', `${'a'.repeat(700)}.b`]) expect(await readBuy(SECRET, junk, 'u1', NOW)).toBeNull();
    // A correctly signed but invalid intent (never produced, but checked anyway).
    const bad = await signBuy(SECRET, { product: 'regatta', eventId: '../x', userId: 'u1', exp: NOW + 1000 });
    expect(await readBuy(SECRET, bad, 'u1', NOW)).toBeNull();
  });
});

describe('sign-in carries the intent to a one-time marker', () => {
  it('Google: the intent rides in the signed state; the callback adds a marker signed for that user', async () => {
    const db = new MemD1();
    const res = await google(db, { returnTo: `/?event=${EVENT}&div=J70&race=3`, buy: 'regatta', event: EVENT });
    const loc = new URL(res.headers.get('location')!, ORIGIN);
    expect(loc.pathname + '?' + [...loc.searchParams.keys()].join(',')).toBe('/?event,div,race,buy');
    expect(await readBuy(SECRET, markerOf(res), await userIdOf(db, 'skipper@example.com'), NOW)).toEqual({ product: 'regatta', eventId: EVENT });
  });

  it('Google: an invalid intent, none, or a forged marker in returnTo give no marker', async () => {
    const queries: Record<string, string>[] = [{ buy: 'coach' }, { buy: 'season' }, { buy: 'regatta' }, { buy: 'regatta', event: '../x' }, {}, { returnTo: '/?race=3&buy=forged.token' }];
    for (const q of queries) {
      const res = await google(new MemD1(), { returnTo: '/?race=3', ...q });
      expect(markerOf(res), JSON.stringify(q)).toBeNull();
    }
    // Never an open redirect: an outside returnTo is still "/".
    expect((await google(new MemD1(), { returnTo: 'https://evil.example/x', buy: 'regatta', event: EVENT })).headers.get('location')).toMatch(/^\/\?buy=/);
  });

  it('already entitled after sign-in (bought earlier, or a gift that just attached): no marker, the race just opens', async () => {
    const db = new MemD1();
    await giveRegatta(db, await userIdOf(db, 'skipper@example.com'));
    expect(markerOf(await google(db, { returnTo: '/?race=3', buy: 'regatta', event: EVENT }))).toBeNull();
    // That pass doesn't cover another regatta: that intent still goes on.
    expect(markerOf(await google(db, { returnTo: '/?race=3', buy: 'regatta', event: 'someOtherEvent1' }))).not.toBeNull();

    const db2 = new MemD1();
    for (const stmt of grantSql({ email: 'gifted@example.com', scope: 'season', now: NOW - 1000 }).split('\n')) await db2.prepare(stmt.replace(/;$/, '')).run();
    expect(markerOf(await magicLink(db2, { email: 'gifted@example.com', returnTo: '/?race=3', buy: { product: 'regatta', eventId: EVENT } }))).toBeNull();
  });

  it('magic link: the intent is kept server-side with the link and signed at confirm', async () => {
    const db = new MemD1();
    const res = await magicLink(db, { email: 'a@example.com', returnTo: `/?event=${EVENT}&race=3`, buy: { product: 'regatta', eventId: EVENT } });
    expect(res.headers.get('location')).toMatch(new RegExp(`^/\\?event=${EVENT}&race=3&buy=`));
    expect(await readBuy(SECRET, markerOf(res), await userIdOf(db, 'a@example.com'), NOW)).toEqual({ product: 'regatta', eventId: EVENT });
    expect(db.rows('login_tokens')[0].return_to).toBe(`/?event=${EVENT}&race=3&pw_buy=regatta.${EVENT}`);
  });

  it('magic link: a season intent (no longer sold) is dropped: no pw_buy kept, no marker', async () => {
    const db = new MemD1();
    const res = await magicLink(db, { email: 'a@example.com', returnTo: `/?event=${EVENT}&race=3`, buy: { product: 'season' } });
    expect(res.headers.get('location')).toBe(`/?event=${EVENT}&race=3`);
    expect(db.rows('login_tokens')[0].return_to).toBe(`/?event=${EVENT}&race=3`);
  });

  it('magic link: no intent, a bad one, a smuggled pw_buy or buy in returnTo, or Restore access: no marker', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['email', { email: 'a@example.com', returnTo: '/?race=3' }],
      ['email', { email: 'b@example.com', returnTo: '/?race=3', buy: { product: 'regatta', eventId: '../x' } }],
      ['email', { email: 'c@example.com', returnTo: '/?race=3&pw_buy=season' }],
      ['email', { email: 'd@example.com', returnTo: '/?race=3&buy=forged.token' }],
    ];
    for (const [route, body] of cases) {
      const res = await magicLink(new MemD1(), body, route);
      expect(res.headers.get('location'), JSON.stringify(body)).toBe('/?race=3');
    }
    const db = new MemD1();
    const { user } = await signIn(db, 'buyer@example.com');
    await db.prepare("INSERT INTO purchases (id, user_id, provider, provider_ref, product, amount, status, email, created_at) VALUES ('p1', ?, 'stripe', 'cs_test_x', 'regatta', 5000, 'paid', 'buyer@example.com', ?)").bind(user.id, NOW).run();
    expect((await magicLink(db, { email: 'buyer@example.com', returnTo: '/?race=3&pw_buy=season' }, 'restore')).headers.get('location')).toBe('/?race=3');
  });
});

describe('checkout with the marker', () => {
  const post = (cookie: string, body: Record<string, unknown>): Request =>
    new Request(`${ORIGIN}/api/billing/checkout`, { method: 'POST', body: JSON.stringify({ returnTo: '/', ...body }), headers: { 'content-type': 'application/json', origin: ORIGIN, cookie } });
  const stripe = (async () => new Response(JSON.stringify({ id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const run = async (db: MemD1, cookie: string, body: Record<string, unknown>): Promise<Response> =>
    handleBilling(billCtx(post(cookie, body), paywallEnv(db), 'checkout'), { now: () => NOW, cache: null, fetch: stripe });

  it('opens Stripe for a good marker; refuses a forged, expired, someone else’s or mismatched one (400); 409 when held', async () => {
    const db = new MemD1();
    const { user, cookie } = await signIn(db, 'a@example.com');
    const mk = (o: Partial<{ product: 'regatta'; eventId: string; userId: string; exp: number }> = {}) =>
      signBuy(SECRET, { product: 'regatta', eventId: EVENT, userId: user.id, exp: NOW + BUY_TTL_MS, ...o });
    expect(await json(await run(db, cookie, { product: 'regatta', eventId: EVENT, intent: await mk() }))).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
    for (const [what, body] of [
      ['forged', { product: 'regatta', eventId: EVENT, intent: 'eyJwIjoicmVnYXR0YSJ9.AAAA' }],
      ['expired', { product: 'regatta', eventId: EVENT, intent: await mk({ exp: NOW }) }],
      ['other user', { product: 'regatta', eventId: EVENT, intent: await mk({ userId: 'someone-else' }) }],
      ['other event', { product: 'regatta', eventId: 'someOtherEvent1', intent: await mk() }],
      ['not a string', { product: 'regatta', eventId: EVENT, intent: 7 }],
    ] as const) {
      const res = await run(db, cookie, body);
      expect(res.status, what).toBe(400);
      expect(await json(res), what).toEqual({ error: 'bad_intent' });
    }
    // No marker: a click, as before.
    expect((await run(db, cookie, { product: 'regatta', eventId: EVENT })).status).toBe(200);
    // An existing all-regattas pass (a Season Pass subscription) holds every regatta.
    await giveSeason(db, user.id, NOW + 1e10);
    expect((await run(db, cookie, { product: 'regatta', eventId: EVENT, intent: await mk() })).status).toBe(409);
  });
});

describe('the page: automatic checkout, once, only when needed', () => {
  const pass = (p: Partial<PassView>): PassView => ({ scope: 'regatta', eventId: EVENT, startsAt: NOW - 1000, expiresAt: null, seats: null, owner: true, ...p });
  const me = (entitlements: PassView[] = [], user: { email: string } | null = { email: 'a@example.com' }): Me => ({ paywall: true, user, entitlements, signIn: { email: true, google: true } });

  it('decides from the marker and the passes held', async () => {
    const reg = await signBuy(SECRET, { product: 'regatta', eventId: EVENT, userId: 'u', exp: NOW + 1000 });
    const season = Buffer.from(JSON.stringify({ p: 'season', e: null, u: 'u', x: NOW + 1000 })).toString('base64url') + '.sig';
    const q = (t: string): string => `?event=${EVENT}&race=3&buy=${t}`;
    expect(peekBuy(reg)).toEqual({ product: 'regatta', eventId: EVENT });
    expect(autoCheckout(me(), q(reg), NOW)).toEqual({ product: 'regatta', eventId: EVENT, intent: reg });
    // An old season marker: nothing to buy.
    expect(peekBuy(season)).toBeNull();
    expect(autoCheckout(me(), q(season), NOW)).toBeNull();
    expect(autoCheckout({ paywall: false }, q(reg), NOW)).toBeNull();
    expect(autoCheckout(me([], null), q(reg), NOW)).toBeNull();
    expect(autoCheckout(me(), `?event=${EVENT}`, NOW)).toBeNull();
    expect(autoCheckout(me(), q('garbage'), NOW)).toBeNull();
    // Already held: the race just opens.
    expect(autoCheckout(me([pass({})]), q(reg), NOW)).toBeNull();
    expect(autoCheckout(me([pass({ scope: 'season', eventId: null })]), q(reg), NOW)).toBeNull();
    // Another regatta's pass doesn't hold this one.
    expect(autoCheckout(me([pass({ eventId: 'someOtherEvent1' })]), q(reg), NOW)).not.toBeNull();
  });

  it('the marker leaves the URL; the intent rides on the Google start link', () => {
    expect(hereWithout(`${ORIGIN}/?event=${EVENT}&race=3&buy=abc.def#coach`)).toBe(`/?event=${EVENT}&race=3#coach`);
    expect(googleStartUrl('/?race=3', { product: 'regatta', eventId: EVENT })).toBe(`/api/auth/google/start?returnTo=%2F%3Frace%3D3&buy=regatta&event=${EVENT}`);
    expect(googleStartUrl('/?race=3')).toBe('/api/auth/google/start?returnTo=%2F%3Frace%3D3');
  });
});

describe('only the sign-in methods set up here are shown', () => {
  const title = (id: string): string => id;
  const me = (email: boolean, google: boolean, user: { email: string } | null = null): Me => ({ paywall: true, user, entitlements: [], signIn: { email, google } });
  const lock = (o: Partial<LockView>): string => lockCardHtml({ titleHtml: '<h2>R3</h2>', gunLine: '', boats: 10, results: [], range: 'R2–R9', signedIn: null, canBuy: true, ...o });
  const all = (): string[] => {
    const out: string[] = [];
    for (const e of [true, false]) for (const g of [true, false]) for (const mode of ['signin', 'sent', 'restore', 'restore-sent', 'account'] as const) for (const u of [null, { email: 'a@example.com' }]) out.push(sheetHtml(me(e, g, u), { mode, email: 'a@example.com' }, title));
    for (const e of [true, false]) for (const g of [true, false]) for (const s of [null, 'a@example.com']) out.push(lock({ signInEmail: e, signInGoogle: g, signedIn: s }));
    return out;
  };

  it('email off, Google on: only Continue with Google; no email form, Restore access or "check your email"', () => {
    for (const mode of ['signin', 'sent', 'restore', 'restore-sent'] as const) {
      const s = sheetHtml(me(false, true), { mode, email: 'a@example.com' }, title);
      expect(s, mode).toContain('Continue with Google');
      expect(s, mode).not.toMatch(/type="email"|Restore access|Check your email|sign-in link|Email sign-in/);
    }
    expect(sheetHtml(me(false, true, { email: 'a@example.com' }), { mode: 'account' }, title)).not.toContain('Restore access');
    const card = lock({ signInEmail: false, signInGoogle: true });
    expect(card).toContain('Race 1 of every regatta is free; unlock the rest of a regatta for $50 · Already bought? <button type="button" class="linkish" data-pw="signin">Sign in</button></p>');
    expect(card).not.toContain('Restore access');
  });

  it('email on, Google off: the email form and Restore access, no Google', () => {
    const s = sheetHtml(me(true, false), { mode: 'signin' }, title);
    expect(s).toContain('type="email"');
    expect(s).toContain('Restore access');
    expect(s).not.toContain('Google');
    expect(sheetHtml(me(true, false), { mode: 'sent', email: 'a@example.com' }, title)).toContain('Check your email');
    expect(lock({ signInEmail: true, signInGoogle: false })).toContain('data-pw="restore">Restore access');
    expect(sheetHtml(me(true, true), { mode: 'signin' }, title)).toMatch(/type="email"[\s\S]*Continue with Google/);
  });

  it('neither: a short "unavailable" line instead of buttons', () => {
    const s = sheetHtml(me(false, false), { mode: 'signin' }, title);
    expect(s).toContain('Sign-in is unavailable right now');
    expect(s.match(/data-pw="(\w+)"/g)).toEqual(['data-pw="close"']);
    expect(s).not.toMatch(/<form|Google|Restore/);
    const card = lock({ signInEmail: false, signInGoogle: false });
    expect(card).toContain('Race 1 of every regatta is free; unlock the rest of a regatta for $50 · Sign-in is unavailable right now');
    expect(card).not.toMatch(/data-pw="(signin|restore)"/);
  });

  it('no copy anywhere mentions passwords', () => {
    for (const html of all()) expect(html).not.toMatch(/password/i);
  });
});
