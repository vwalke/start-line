import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  APPLE_ISSUER,
  APPLE_JWKS_URL,
  APPLE_TOKEN_URL,
  MICROSOFT_JWKS_URL,
  MICROSOFT_PERSONAL_TENANT,
  MICROSOFT_TOKEN_URL,
  appleClientSecret,
  appleReady,
  handleAuth,
  microsoftReady,
  readBuy,
  readState,
  signBuy,
  signState,
  type AuthCtx,
  type OAuthState,
} from '../functions/_auth';
import { ensureUser, linkIdentity, setGoogleSub, setStripeCustomer } from '../functions/_authDb';
import { clearJwksCache } from '../functions/_jwt';
import type { EmailBindingLike, PaywallEnv } from '../functions/_paywall';
import { appleStartUrl, microsoftStartUrl, oauthStartUrl, type DeviceView, type Me } from '../src/data/paywall';
import { APPLE_EMAIL_NOTE, MICROSOFT_EMAIL_NOTE, devicesHtml, failedNote, hereWithout, lockCardHtml, lockView, providerButtonsHtml, returnParam, sheetHtml } from '../src/ui/paywall';
import { currentDoc } from '../src/data/racesense/adapter';
import { MIGRATIONS_DIR, MemD1 } from './d1mem';
import { fakeProvider, jwtParts, p256Pem, rsaKey, signRs256, type RsaKey } from './oauthHelpers';
import { EVENT, NOW, ORIGIN, beneluxRegatta, giveRegatta, mailbox, paywallEnv, resetPaywallCaches, signIn } from './paywallHelpers';

const ctx = (request: Request, env: PaywallEnv, path: string, waitUntil?: AuthCtx['waitUntil']): AuthCtx => ({ request, env, params: { path: path.split('/') }, ...(waitUntil ? { waitUntil } : {}) });
const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const MS_ID = 'ms-client-id-test-fake';
const APPLE_ID = 'com.walkeforward.recall.test-fake';
const WORK_TID = '11111111-2222-4333-8444-555555555555';
const APPLE_COOKIE_ATTRS = 'Path=/api/auth/apple; Max-Age=600; Secure; HttpOnly; SameSite=None';

let msKey: RsaKey;
let appleKey: RsaKey;
let strangerKey: RsaKey;
let applePem: string;
let applePublic: CryptoKey;
beforeAll(async () => {
  [msKey, appleKey, strangerKey] = await Promise.all([rsaKey('ms-kid-1'), rsaKey('apple-kid-1'), rsaKey('ms-kid-1')]);
  ({ pem: applePem, publicKey: applePublic } = await p256Pem());
});
beforeEach(() => {
  resetPaywallCaches();
  clearJwksCache();
});

const env = (db: MemD1 | undefined, over: Partial<PaywallEnv> = {}): PaywallEnv =>
  paywallEnv(db, {
    MICROSOFT_CLIENT_ID: MS_ID,
    MICROSOFT_CLIENT_SECRET: 'ms_secret_test_fake',
    APPLE_SERVICES_ID: APPLE_ID,
    APPLE_TEAM_ID: 'TEAMTEST01',
    APPLE_KEY_ID: 'KEYTEST001',
    APPLE_PRIVATE_KEY: applePem,
    ...over,
  });

type Provider = 'google' | 'microsoft' | 'apple';

/** A start route: where it sends the browser, its state cookie and the state and nonce it signed. */
async function start(provider: Provider, e: PaywallEnv, query: Record<string, string> = {}): Promise<{ res: Response; location: URL; setCookie: string; cookie: string; state: string; nonce: string }> {
  const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/${provider}/start?${new URLSearchParams({ returnTo: '/?race=3', ...query })}`), e, `${provider}/start`), mailbox());
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  const setCookie = res.headers.get('set-cookie')!;
  return { res, location, setCookie, cookie: setCookie.split(';')[0], state: location.searchParams.get('state')!, nonce: location.searchParams.get('nonce')! };
}

const msClaims = (nonce: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const tid = (over.tid as string | undefined) ?? MICROSOFT_PERSONAL_TENANT;
  return { ver: '2.0', iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: MS_ID, tid, sub: 'ms-sub-1', email: 'Skipper@Outlook.example', iat: NOW / 1000 - 5, exp: NOW / 1000 + 3600, nonce, ...over };
};

const appleClaims = (nonce: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: APPLE_ISSUER,
  aud: APPLE_ID,
  sub: '001234.apple-sub-1',
  email: 'skipper@example.com',
  email_verified: 'true',
  is_private_email: 'false',
  iat: NOW / 1000 - 5,
  exp: NOW / 1000 + 600,
  auth_time: NOW / 1000 - 5,
  nonce_supported: true,
  nonce,
  ...over,
});

interface FlowOpts {
  query?: Record<string, string>;
  key?: RsaKey;
  e?: PaywallEnv;
  now?: number;
  tokenStatus?: number;
  waitUntil?: AuthCtx['waitUntil'];
}

/** Microsoft, start to callback, the ID token carrying `over`. */
async function microsoft(db: MemD1, over: Record<string, unknown> = {}, o: FlowOpts = {}) {
  const e = o.e ?? env(db);
  const st = await start('microsoft', e, o.query);
  const f = fakeProvider({ tokenUrl: MICROSOFT_TOKEN_URL, jwksUrl: MICROSOFT_JWKS_URL, keys: () => [msKey.jwk], idToken: () => signRs256(o.key ?? msKey, msClaims(st.nonce, over)), tokenStatus: o.tokenStatus });
  const req = new Request(`${ORIGIN}/api/auth/microsoft/callback?code=M.test_code_fake&state=${st.state}`, { headers: { cookie: st.cookie, 'user-agent': UA } });
  const res = await handleAuth(ctx(req, e, 'microsoft/callback', o.waitUntil), { ...mailbox(o.now ?? NOW), fetch: f });
  return { res, f, st, location: res.headers.get('location') ?? '' };
}

interface AppleOpts extends FlowOpts {
  form?: Record<string, string>;
  headers?: Record<string, string>;
  cookie?: string | null;
  /** The form post's Origin (default Apple's; null: none). */
  origin?: string | null;
}

/** Apple, start to its form post, the ID token carrying `over`. */
async function apple(db: MemD1, over: Record<string, unknown> = {}, o: AppleOpts = {}) {
  const e = o.e ?? env(db);
  const st = await start('apple', e, o.query);
  const f = fakeProvider({ tokenUrl: APPLE_TOKEN_URL, jwksUrl: APPLE_JWKS_URL, keys: () => [appleKey.jwk], idToken: () => signRs256(o.key ?? appleKey, appleClaims(st.nonce, over)), tokenStatus: o.tokenStatus });
  const cookie = o.cookie === undefined ? st.cookie : o.cookie;
  const body = new URLSearchParams({ code: 'c.apple_test_code_fake', state: st.state, ...o.form });
  const req = new Request(`${ORIGIN}/api/auth/apple/callback`, {
    method: 'POST',
    body: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(o.origin === null ? {} : { origin: o.origin ?? 'https://appleid.apple.com' }), 'user-agent': UA, ...(cookie ? { cookie } : {}), ...o.headers },
  });
  const res = await handleAuth(ctx(req, e, 'apple/callback', o.waitUntil), { ...mailbox(o.now ?? NOW), fetch: f });
  return { res, f, st, location: res.headers.get('location') ?? '' };
}

const tokenCalls = (f: { calls: { url: string }[] }, url: string): number => f.calls.filter((c) => c.url === url).length;

describe('Microsoft', () => {
  it('start: PKCE (S256), state and nonce in a signed Lax cookie on its own path, the fixed redirect URI', async () => {
    const { location, setCookie } = await start('microsoft', env(new MemD1()));
    expect(location.origin + location.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: MS_ID,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: `${ORIGIN}/api/auth/microsoft/callback`,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toMatch(/^wf_oauth=[^;]+; Path=\/api\/auth\/microsoft; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/);
  });

  it('callback: sends the PKCE verifier and secret, checks the signature, signs a personal account in with signin=ok', async () => {
    const db = new MemD1();
    const { res, f, st, location } = await microsoft(db);
    expect(res.status).toBe(302);
    expect(location).toBe('/?race=3&signin=ok');
    const cookies = res.headers.getSetCookie();
    expect(cookies[0]).toMatch(/^wf_session=[A-Za-z0-9_-]{43}; Domain=\.walkeforward\.com/);
    expect(cookies[1]).toBe('wf_oauth=; Path=/api/auth/microsoft; Max-Age=0; Secure; HttpOnly; SameSite=Lax');
    const token = f.calls.find((c) => c.url === MICROSOFT_TOKEN_URL)!.body!;
    expect(Object.fromEntries(token)).toMatchObject({ client_id: MS_ID, client_secret: 'ms_secret_test_fake', code: 'M.test_code_fake', grant_type: 'authorization_code', redirect_uri: `${ORIGIN}/api/auth/microsoft/callback` });
    const verifier = token.get('code_verifier')!;
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    expect(challenge).toBe(st.location.searchParams.get('code_challenge'));
    expect(f.calls.map((c) => c.url)).toEqual([MICROSOFT_TOKEN_URL, MICROSOFT_JWKS_URL]);
    const [user] = db.rows('users');
    expect(user).toMatchObject({ email: 'skipper@outlook.example', google_sub: null });
    expect(db.rows('identities')).toEqual([
      { provider: 'microsoft', subject: 'ms-sub-1', user_id: user.id, email: 'skipper@outlook.example', email_verified: 1, tenant: MICROSOFT_PERSONAL_TENANT, is_private_relay: 0, created_at: NOW, last_used_at: NOW },
    ]);
    expect(db.rows('sessions')).toEqual([expect.objectContaining({ user_id: user.id, method: 'microsoft' })]);
  });

  it('the issuer must name the token’s own tenant (a GUID); a token from another key fails', async () => {
    for (const bad of [
      { iss: `https://login.microsoftonline.com/${WORK_TID}/v2.0` },
      { tid: 'not-a-guid', iss: 'https://login.microsoftonline.com/not-a-guid/v2.0' },
      { iss: 'https://login.microsoftonline.com/common/v2.0' },
      { aud: 'someone-else' },
      { nonce: 'x' },
      { exp: NOW / 1000 - 600 },
    ]) {
      const db = new MemD1();
      const { location } = await microsoft(db, bad);
      expect(location, JSON.stringify(bad)).toBe('/?race=3&signin=failed&via=microsoft');
      expect(db.rows('users')).toEqual([]);
    }
    const db = new MemD1();
    expect((await microsoft(db, {}, { key: strangerKey })).location).toBe('/?race=3&signin=failed&via=microsoft');
    expect((await microsoft(db, {}, { tokenStatus: 400 })).location).toBe('/?race=3&signin=failed&via=microsoft');
    expect(db.rows('sessions')).toEqual([]);
  });

  it('a work or school account is trusted with xms_edov true (true, "true" or "1")', async () => {
    for (const edov of [true, 'true', '1']) {
      const db = new MemD1();
      const { location } = await microsoft(db, { tid: WORK_TID, email: 'Crew@Club.example', xms_edov: edov });
      expect(location, String(edov)).toBe('/?race=3&signin=ok');
      expect(db.rows('identities')).toEqual([expect.objectContaining({ tenant: WORK_TID, email: 'crew@club.example', email_verified: 1 })]);
    }
  });

  it('email_verified: absent keeps the rule above, true too; present and false (or "false") is never trusted', async () => {
    for (const v of [undefined, true, 'true']) {
      const db = new MemD1();
      expect((await microsoft(db, { email_verified: v })).location, String(v)).toBe('/?race=3&signin=ok');
      expect((await microsoft(new MemD1(), { tid: WORK_TID, email: 'crew@club.example', xms_edov: true, email_verified: v })).location, String(v)).toBe('/?race=3&signin=ok');
    }
    for (const v of [false, 'false']) {
      for (const over of [{ email_verified: v }, { tid: WORK_TID, email: 'crew@club.example', xms_edov: true, email_verified: v }]) {
        const db = new MemD1();
        const existing = await ensureUser(db, 'tid' in over ? 'crew@club.example' : 'skipper@outlook.example', NOW);
        const { location } = await microsoft(db, over);
        expect(location, JSON.stringify(over)).toBe('/?race=3&signin=failed&via=microsoft&reason=microsoft_email');
        expect(db.rows('users')).toEqual([expect.objectContaining({ id: existing.id })]);
        expect(db.rows('identities')).toEqual([]);
        expect(db.rows('sessions')).toEqual([]);
      }
    }
  });

  it('a work account without a verified domain (or with no email) is refused: nothing is created or linked', async () => {
    for (const over of [{ tid: WORK_TID, email: 'crew@club.example' }, { tid: WORK_TID, email: 'crew@club.example', xms_edov: false }, { tid: WORK_TID, email: 'crew@club.example', xms_edov: 'false' }, { email: undefined }, { email: 'not an email' }]) {
      const db = new MemD1();
      const existing = await ensureUser(db, 'crew@club.example', NOW);
      const { res, location } = await microsoft(db, over);
      expect(location, JSON.stringify(over)).toBe('/?race=3&signin=failed&via=microsoft&reason=microsoft_email');
      expect(res.headers.getSetCookie()).toEqual(['wf_oauth=; Path=/api/auth/microsoft; Max-Age=0; Secure; HttpOnly; SameSite=Lax']);
      expect(db.rows('users')).toEqual([expect.objectContaining({ id: existing.id })]);
      expect(db.rows('identities')).toEqual([]);
      expect(db.rows('sessions')).toEqual([]);
    }
  });

  it('an existing identity signs its user in whatever the email says now (changed, missing, untrusted)', async () => {
    const db = new MemD1();
    await microsoft(db);
    const [user] = db.rows('users');
    for (const over of [{ email: 'renamed@outlook.example' }, { email: undefined }]) {
      const { location } = await microsoft(db, over, { now: NOW + 60_000 });
      expect(location).toBe('/?race=3&signin=ok');
    }
    expect(db.rows('users')).toHaveLength(1);
    expect(db.rows('identities')).toEqual([expect.objectContaining({ user_id: user.id, email: 'skipper@outlook.example', created_at: NOW, last_used_at: NOW + 60_000 })]);
    expect(db.rows('sessions').every((s) => s.user_id === user.id)).toBe(true);
  });

  it('a trusted email links to the existing user with that address, keeping their passes and Stripe customer', async () => {
    const db = new MemD1();
    const existing = await ensureUser(db, 'skipper@outlook.example', NOW - 86_400_000);
    await setStripeCustomer(db, existing.id, 'cus_test_fake');
    await giveRegatta(db, existing.id);
    const { location } = await microsoft(db);
    expect(location).toBe('/?race=3&signin=ok');
    expect(db.rows('users')).toEqual([expect.objectContaining({ id: existing.id, stripe_customer_id: 'cus_test_fake' })]);
    expect(db.rows('entitlements')).toEqual([expect.objectContaining({ user_id: existing.id, event_id: EVENT })]);
    expect(db.rows('identities')).toEqual([expect.objectContaining({ user_id: existing.id })]);
  });

  it('two first sign-ins at once end on one user and one identity', async () => {
    const db = new MemD1();
    const [a, b] = await Promise.all([microsoft(db), microsoft(db)]);
    expect([a.location, b.location]).toEqual(['/?race=3&signin=ok', '/?race=3&signin=ok']);
    expect(db.rows('users')).toHaveLength(1);
    expect(db.rows('identities')).toHaveLength(1);
    // linkIdentity keeps the first row: a second user is never attached to the same identity.
    const other = await ensureUser(db, 'other@example.com', NOW);
    const back = await linkIdentity(db, { provider: 'microsoft', subject: 'ms-sub-1', email: 'other@example.com', emailVerified: true }, other.id, NOW);
    expect(back?.id).toBe(db.rows('users')[0].id);
  });

  it('a state is good on its own provider’s callback only (Google’s on Microsoft’s, and back)', async () => {
    const db = new MemD1();
    const e = env(db);
    const g = await start('google', e);
    const f = fakeProvider({ tokenUrl: MICROSOFT_TOKEN_URL, jwksUrl: MICROSOFT_JWKS_URL, keys: () => [msKey.jwk], idToken: () => signRs256(msKey, msClaims(g.nonce)) });
    const onMs = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/microsoft/callback?code=c&state=${g.state}`, { headers: { cookie: g.cookie } }), e, 'microsoft/callback'), { ...mailbox(), fetch: f });
    expect(onMs.headers.get('location')).toBe('/?signin=failed&via=microsoft');
    const m = await start('microsoft', e);
    const onGoogle = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/google/callback?code=c&state=${m.state}`, { headers: { cookie: m.cookie } }), e, 'google/callback'), { ...mailbox(), fetch: f });
    expect(onGoogle.headers.get('location')).toBe('/?signin=failed&via=google');
    // Microsoft's state in Apple's cookie, posted to Apple's callback.
    const onApple = await handleAuth(
      ctx(
        new Request(`${ORIGIN}/api/auth/apple/callback`, {
          method: 'POST',
          body: new URLSearchParams({ code: 'c', state: m.state }).toString(),
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: m.cookie.replace(/^wf_oauth=/, 'wf_oauth_apple=') },
        }),
        e,
        'apple/callback',
      ),
      { ...mailbox(), fetch: f },
    );
    expect(onApple.headers.get('location')).toBe('/?signin=failed&via=apple');
    expect(f.calls).toEqual([]);
    expect(db.rows('sessions')).toEqual([]);
    // A wrong or missing state, with the right cookie, fails before any call too.
    const m2 = await start('microsoft', e);
    const wrong = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/microsoft/callback?code=c&state=other`, { headers: { cookie: m2.cookie } }), e, 'microsoft/callback'), { ...mailbox(), fetch: f });
    expect(wrong.headers.get('location')).toBe('/?signin=failed&via=microsoft');
    const cancelled = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/microsoft/callback?error=access_denied&state=${m2.state}`, { headers: { cookie: m2.cookie } }), e, 'microsoft/callback'), { ...mailbox(), fetch: f });
    expect(cancelled.headers.get('location')).toBe('/?race=3&signin=failed&via=microsoft');
    expect(f.calls).toEqual([]);
  });
});

describe('Apple', () => {
  it('client secret: an ES256 JWT (kid, team, Services ID, Apple’s audience, 5 minutes) that verifies with the public key', async () => {
    const jwt = await appleClientSecret(env(new MemD1()), NOW);
    const { header, payload, input, sig } = jwtParts(jwt);
    expect(header).toEqual({ alg: 'ES256', kid: 'KEYTEST001' });
    expect(payload).toEqual({ iss: 'TEAMTEST01', iat: NOW / 1000, exp: NOW / 1000 + 300, aud: 'https://appleid.apple.com', sub: APPLE_ID });
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, applePublic, sig, new TextEncoder().encode(input))).toBe(true);
    // The PEM as one line with literal \n (how a dashboard often stores it), with stray whitespace.
    const flat = await appleClientSecret(env(new MemD1(), { APPLE_PRIVATE_KEY: ` ${applePem.trim().replace(/\n/g, '\\n')} ` }), NOW);
    const p = jwtParts(flat);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, applePublic, p.sig, new TextEncoder().encode(p.input))).toBe(true);
  });

  it('start: form_post, scope email only, no PKCE; state in a host-only SameSite=None cookie on /api/auth/apple', async () => {
    const { location, setCookie } = await start('apple', env(new MemD1()));
    expect(location.origin + location.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: 'code',
      response_mode: 'form_post',
      client_id: APPLE_ID,
      redirect_uri: `${ORIGIN}/api/auth/apple/callback`,
      scope: 'email',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(setCookie).toMatch(new RegExp(`^wf_oauth_apple=[^;]+; ${APPLE_COOKIE_ATTRS.replace(/[/.]/g, '\\$&')}$`));
    expect(setCookie).not.toContain('Domain=');
  });

  it('callback: a cross-site POST from Apple signs in (303, signin=ok), with the client secret JWT, clearing the cookie', async () => {
    const db = new MemD1();
    const { res, f, location } = await apple(db);
    expect(res.status).toBe(303);
    expect(location).toBe('/?race=3&signin=ok');
    const cookies = res.headers.getSetCookie();
    expect(cookies[0]).toMatch(/^wf_session=[A-Za-z0-9_-]{43}; Domain=\.walkeforward\.com; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax$/);
    expect(cookies[1]).toBe(`wf_oauth_apple=; ${APPLE_COOKIE_ATTRS.replace('Max-Age=600', 'Max-Age=0')}`);
    const body = f.calls.find((c) => c.url === APPLE_TOKEN_URL)!.body!;
    expect(Object.fromEntries(body)).toMatchObject({ client_id: APPLE_ID, code: 'c.apple_test_code_fake', grant_type: 'authorization_code', redirect_uri: `${ORIGIN}/api/auth/apple/callback` });
    expect(body.has('code_verifier')).toBe(false);
    const secret = jwtParts(body.get('client_secret')!);
    expect(secret.header).toEqual({ alg: 'ES256', kid: 'KEYTEST001' });
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, applePublic, secret.sig, new TextEncoder().encode(secret.input))).toBe(true);
    const [user] = db.rows('users');
    expect(user.email).toBe('skipper@example.com');
    expect(db.rows('identities')).toEqual([expect.objectContaining({ provider: 'apple', subject: '001234.apple-sub-1', user_id: user.id, email_verified: 1, is_private_relay: 0, tenant: null })]);
    expect(db.rows('sessions')).toEqual([expect.objectContaining({ method: 'apple' })]);
  });

  it('the cross-site Origin is accepted on this route only', async () => {
    const db = new MemD1();
    const e = env(db);
    for (const [path, body] of [
      ['verify', new URLSearchParams({ token: 'A'.repeat(43) }).toString()],
      ['logout', '{}'],
    ] as const) {
      const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/${path}`, { method: 'POST', body, headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded' } }), e, path), mailbox());
      expect(res.status, path).toBe(403);
    }
    expect((await apple(db)).location).toBe('/?race=3&signin=ok');
  });

  it('Origin: Apple’s, none or "null" is accepted (the signed state decides)', async () => {
    for (const origin of ['https://appleid.apple.com', null, 'null']) {
      const db = new MemD1();
      const { res, location } = await apple(db, {}, { origin });
      expect(location, String(origin)).toBe('/?race=3&signin=ok');
      expect(res.headers.getSetCookie()[0]).toMatch(/^wf_session=/);
      expect(db.rows('sessions')).toHaveLength(1);
    }
  });

  it('Origin: any other (ours included, or Apple’s over http) is refused before anything is read or spent', async () => {
    for (const origin of [ORIGIN, 'https://evil.example', 'http://appleid.apple.com']) {
      const db = new MemD1();
      const { res, f, location } = await apple(db, {}, { origin });
      expect(res.status, origin).toBe(303);
      expect(location, origin).toBe('/?signin=failed&via=apple');
      expect(res.headers.getSetCookie(), origin).toEqual([`wf_oauth_apple=; ${APPLE_COOKIE_ATTRS.replace('Max-Age=600', 'Max-Age=0')}`]);
      expect(f.calls, origin).toEqual([]);
      expect(db.rows('users')).toEqual([]);
      expect(db.rows('sessions')).toEqual([]);
    }
  });

  it('refuses a POST without the cookie, with another state, or not a form; GET is 405', async () => {
    const db = new MemD1();
    const noCookie = await apple(db, {}, { cookie: null });
    expect(noCookie.res.status).toBe(303);
    expect(noCookie.location).toBe('/?signin=failed&via=apple');
    expect(noCookie.res.headers.getSetCookie()).toEqual([`wf_oauth_apple=; ${APPLE_COOKIE_ATTRS.replace('Max-Age=600', 'Max-Age=0')}`]);
    expect(tokenCalls(noCookie.f, APPLE_TOKEN_URL)).toBe(0);
    const otherState = await apple(db, {}, { form: { state: 'someone-elses-state' } });
    expect(otherState.location).toBe('/?signin=failed&via=apple');
    expect(tokenCalls(otherState.f, APPLE_TOKEN_URL)).toBe(0);
    const asJson = await apple(db, {}, { headers: { 'content-type': 'application/json' } });
    expect(asJson.location).toBe('/?signin=failed&via=apple');
    const tampered = await apple(db, {}, { cookie: 'wf_oauth_apple=eyJ4Ijox.c2ln' });
    expect(tampered.location).toBe('/?signin=failed&via=apple');
    const get = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/apple/callback?code=c&state=s`), env(db), 'apple/callback'), mailbox());
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(db.rows('users')).toEqual([]);
    expect(db.rows('sessions')).toEqual([]);
  });

  it('error=user_cancelled_authorize goes quietly back to returnTo (reason cancelled), cookie cleared', async () => {
    const db = new MemD1();
    const { res, f, location } = await apple(db, {}, { form: { error: 'user_cancelled_authorize', code: '' } });
    expect(res.status).toBe(303);
    expect(location).toBe('/?race=3&signin=failed&via=apple&reason=cancelled');
    expect(res.headers.getSetCookie()).toEqual([`wf_oauth_apple=; ${APPLE_COOKIE_ATTRS.replace('Max-Age=600', 'Max-Age=0')}`]);
    expect(f.calls).toEqual([]);
    expect(failedNote('apple', 'cancelled')).toBe('');
    // Any other error is a plain failure.
    expect((await apple(db, {}, { form: { error: 'invalid_request' } })).location).toBe('/?race=3&signin=failed&via=apple');
  });

  it('ignores the posted `user` field: no name is stored anywhere', async () => {
    const db = new MemD1();
    const user = JSON.stringify({ name: { firstName: 'Testfirstname', lastName: 'Testlastname' }, email: 'posted@example.com' });
    const { location } = await apple(db, {}, { form: { user } });
    expect(location).toBe('/?race=3&signin=ok');
    expect(db.rows('users')).toEqual([expect.objectContaining({ email: 'skipper@example.com' })]);
    const everything = JSON.stringify([...db.tables.keys()].map((t) => db.rows(t)));
    expect(everything).not.toMatch(/Testfirstname|Testlastname|posted@example\.com/);
  });

  it('a private relay address gets its own account; it matches only a user with that very address', async () => {
    const db = new MemD1();
    const real = await ensureUser(db, 'skipper@example.com', NOW);
    const relay = await apple(db, { email: 'abc123xyz@privaterelay.appleid.com', is_private_email: true });
    expect(relay.location).toBe('/?race=3&signin=ok');
    const users = db.rows('users');
    expect(users).toHaveLength(2);
    const relayUser = users.find((u) => u.email === 'abc123xyz@privaterelay.appleid.com')!;
    expect(relayUser.id).not.toBe(real.id);
    expect(db.rows('identities')).toEqual([expect.objectContaining({ user_id: relayUser.id, is_private_relay: 1, email_verified: 1 })]);
    // The relay domain alone marks it too; an existing user with exactly that relay address is matched.
    const db2 = new MemD1();
    const known = await ensureUser(db2, 'r9@privaterelay.appleid.com', NOW);
    expect((await apple(db2, { sub: '009.other', email: 'r9@privaterelay.appleid.com', is_private_email: undefined })).location).toBe('/?race=3&signin=ok');
    expect(db2.rows('identities')).toEqual([expect.objectContaining({ user_id: known.id, is_private_relay: 1 })]);
  });

  it('a real verified email links to the existing user; unverified, or no email and no identity, is refused', async () => {
    const db = new MemD1();
    const existing = await ensureUser(db, 'skipper@example.com', NOW);
    await giveRegatta(db, existing.id);
    expect((await apple(db, { email: 'Skipper@Example.com', email_verified: true })).location).toBe('/?race=3&signin=ok');
    expect(db.rows('users')).toHaveLength(1);
    expect(db.rows('identities')).toEqual([expect.objectContaining({ user_id: existing.id })]);
    for (const over of [{ email_verified: 'false' }, { email_verified: false }, { email_verified: undefined }, { email: undefined }]) {
      const fresh = new MemD1();
      const { location } = await apple(fresh, { sub: '002.new', ...over });
      expect(location, JSON.stringify(over)).toBe('/?race=3&signin=failed&via=apple&reason=apple_email');
      expect(fresh.rows('users')).toEqual([]);
      expect(fresh.rows('identities')).toEqual([]);
    }
    // A later sign-in without an email (Apple often leaves it out) finds the identity.
    expect((await apple(db, { email: undefined, email_verified: undefined }, { now: NOW + 1000 })).location).toBe('/?race=3&signin=ok');
    expect(db.rows('sessions').filter((s) => s.user_id === existing.id)).toHaveLength(2);
  });

  it('a token signed by another key, for another audience or with another nonce fails', async () => {
    const db = new MemD1();
    for (const [over, o] of [[{}, { key: strangerKey }], [{ aud: 'com.other.app' }, {}], [{ iss: 'https://evil.example' }, {}], [{ nonce: 'x' }, {}], [{}, { tokenStatus: 400 }]] as const) {
      expect((await apple(db, over, o)).location).toBe('/?race=3&signin=failed&via=apple');
    }
    expect(db.rows('users')).toEqual([]);
  });

  it('a bad APPLE_PRIVATE_KEY fails the sign-in (logged without the key), never the site', async () => {
    const db = new MemD1();
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(' '));
    try {
      const { location, f } = await apple(db, {}, { e: env(db, { APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }) });
      expect(location).toBe('/?race=3&signin=failed&via=apple');
      expect(f.calls).toEqual([]);
    } finally {
      console.error = orig;
    }
    expect(errors.join('\n')).not.toContain('AAAA');
  });
});

describe('Microsoft and Apple alike', () => {
  const both = [
    ['microsoft', microsoft],
    ['apple', apple],
  ] as const;

  it('sessions record the method; /me lists it on the device', async () => {
    for (const [name, run] of both) {
      const db = new MemD1();
      const { res } = await run(db);
      const cookie = res.headers.getSetCookie()[0].split(';')[0];
      const me = await json(await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie } }), env(db), 'me'), mailbox()));
      expect((me.devices as { list: DeviceView[] }).list, name).toEqual([expect.objectContaining({ label: 'Chrome on Mac', method: name, current: true })]);
    }
  });

  it('the device cap applies', async () => {
    for (const [name, run] of both) {
      const db = new MemD1();
      const email = name === 'microsoft' ? 'skipper@outlook.example' : 'skipper@example.com';
      for (let i = 0; i < 3; i++) await signIn(db, email, NOW - (3 - i) * 60_000);
      await run(db);
      const rows = db.rows('sessions');
      expect(rows.filter((r) => r.revoked_at == null), name).toHaveLength(3);
      expect(rows.filter((r) => r.revoked_reason === 'device_limit'), name).toHaveLength(1);
    }
  });

  it('a buy intent rides in the signed state and comes back as a checkout marker for that user', async () => {
    for (const [name, run] of both) {
      const db = new MemD1();
      const { location } = await run(db, {}, { query: { returnTo: `/?event=${EVENT}&div=J70&race=3`, buy: 'regatta', event: EVENT } });
      const u = new URL(location, ORIGIN);
      expect(u.searchParams.get('signin'), name).toBe('ok');
      const user = db.rows('users')[0];
      expect(await readBuy('auth_secret_test_fake', u.searchParams.get('buy'), user.id as string, NOW)).toEqual({ product: 'regatta', eventId: EVENT });
      // Already held: the race just opens.
      await giveRegatta(db, user.id as string);
      const again = new URL((await run(db, {}, { query: { returnTo: '/?race=3', buy: 'regatta', event: EVENT } })).location, ORIGIN);
      expect(again.searchParams.has('buy'), name).toBe(false);
    }
  });

  it('paywall off: every new route is the proxy’s 404 and touches nothing', async () => {
    const db = new MemD1();
    const e = env(db, { PAYWALL_ENABLED: undefined });
    for (const [path, method] of [
      ['microsoft/start', 'GET'],
      ['microsoft/callback', 'GET'],
      ['apple/start', 'GET'],
      ['apple/callback', 'POST'],
      ['apple/callback', 'GET'],
    ] as const) {
      const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/${path}`, { method, ...(method === 'POST' ? { body: 'state=x' } : {}) }), e, path), mailbox());
      expect(res.status, path).toBe(404);
      expect(await json(res)).toEqual({ error: 'Unknown endpoint' });
    }
    expect(db.log).toEqual([]);
  });

  it('not set up: the routes answer not_configured (503) and /me offers neither', async () => {
    const db = new MemD1();
    const bare = paywallEnv(db);
    for (const [path, method] of [
      ['microsoft/start', 'GET'],
      ['microsoft/callback', 'GET'],
      ['apple/start', 'GET'],
      ['apple/callback', 'POST'],
    ] as const) {
      const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/${path}`, { method }), bare, path), mailbox());
      expect(res.status, path).toBe(503);
      expect((await json(res)).error).toBe('not_configured');
    }
    const me = await json(await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`), bare, 'me'), mailbox()));
    expect(me.signIn).toMatchObject({ microsoft: false, apple: false });
    expect(db.log).toEqual([]);
  });
});

describe('the new-link notice email', () => {
  const both = [
    ['microsoft', microsoft, 'skipper@outlook.example', 'Microsoft'],
    ['apple', apple, 'skipper@example.com', 'Apple'],
  ] as const;

  /** An EMAIL binding keeping every message whole (`fail`: it throws instead). */
  const inbox = (fail = false) => {
    const mails: { to: string; subject: string; html: string; text: string }[] = [];
    const binding: EmailBindingLike = {
      send: async (m) => {
        if (fail) throw new Error('binding down');
        mails.push(m);
      },
    };
    return { mails, binding };
  };

  it('goes once to the account’s address when a sign-in is first linked to an existing user (passes kept)', async () => {
    for (const [name, run, email, label] of both) {
      const db = new MemD1();
      const existing = await ensureUser(db, email, NOW - 86_400_000);
      await giveRegatta(db, existing.id);
      const box = inbox();
      const { location } = await run(db, {}, { e: env(db, { EMAIL: box.binding }) });
      expect(location, name).toBe('/?race=3&signin=ok');
      expect(box.mails, name).toEqual([expect.objectContaining({ to: email, subject: `${label} sign-in was added to your Recall account` })]);
      expect(db.rows('entitlements')).toEqual([expect.objectContaining({ user_id: existing.id })]);
      // Signing in again with that identity sends nothing.
      expect((await run(db, {}, { e: env(db, { EMAIL: box.binding }), now: NOW + 60_000 })).location, name).toBe('/?race=3&signin=ok');
      expect(box.mails, name).toHaveLength(1);
    }
  });

  it('says what happened and what to do, with the provider’s name; no button, sign-in link or token', async () => {
    for (const [name, run, email, label] of both) {
      const db = new MemD1();
      await ensureUser(db, email, NOW - 86_400_000);
      const box = inbox();
      await run(db, {}, { e: env(db, { EMAIL: box.binding }) });
      const [m] = box.mails;
      const other = label === 'Apple' ? 'Microsoft' : 'Apple';
      expect(m.text, name).toBe(
        `You can now sign in to Recall with ${label}. If you did this, there's nothing else to do.\n\nIf it wasn't you, open Recall, go to Account, and use Sign out all other devices. Then sign in again with your email.\n\nRecall\n${ORIGIN}\nWe send this whenever a sign-in method is added to your account.\n`,
      );
      const visible = m.html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
      expect(visible).toContain(`You can now sign in to Recall with ${label}. If you did this, there&#39;s nothing else to do.`);
      expect(visible).toContain('use Sign out all other devices. Then sign in again with your email.');
      expect(m.html).toContain(`<title>${label} sign-in was added to your Recall account</title>`);
      expect(m.html).toContain(`<a href="${ORIGIN}" target="_blank"`);
      for (const copy of [m.text, m.html]) {
        expect(copy).not.toMatch(/\/api\/auth|token|v:roundrect|Sign in to Recall<|reply|ignore it/i);
        expect(copy).not.toContain(other);
      }
      for (const copy of [m.text, visible, m.subject]) expect(copy).not.toMatch(/[–—!]/);
      expect([...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1])).toEqual([ORIGIN]);
    }
  });

  it('not for a brand-new user, a repeat sign-in, or Google; skipped with no email provider', async () => {
    for (const [name, run, email] of both) {
      const box = inbox();
      const fresh = new MemD1();
      expect((await run(fresh, {}, { e: env(fresh, { EMAIL: box.binding }) })).location, name).toBe('/?race=3&signin=ok');
      expect((await run(fresh, {}, { e: env(fresh, { EMAIL: box.binding }), now: NOW + 1000 })).location, name).toBe('/?race=3&signin=ok');
      expect(box.mails, name).toEqual([]);
      const db = new MemD1();
      await ensureUser(db, email, NOW - 86_400_000);
      expect((await run(db, {}, { e: env(db, { EMAIL_PROVIDER: undefined, EMAIL: box.binding }) })).location, name).toBe('/?race=3&signin=ok');
      expect(box.mails, name).toEqual([]);
    }
    // Google linking by email to an existing user stays as it was: no notice.
    const db = new MemD1();
    await ensureUser(db, 'skipper@example.com', NOW - 86_400_000);
    const box = inbox();
    const e = env(db, { EMAIL: box.binding });
    const st = await start('google', e);
    const claims = { iss: 'https://accounts.google.com', aud: e.GOOGLE_CLIENT_ID, exp: NOW / 1000 + 600, sub: 'g-1', email: 'skipper@example.com', email_verified: true, nonce: st.nonce };
    const idToken = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
    const f = (async () => new Response(JSON.stringify({ id_token: idToken }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/google/callback?code=c&state=${st.state}`, { headers: { cookie: st.cookie } }), e, 'google/callback'), { ...mailbox(), fetch: f });
    expect(res.headers.get('location')).toBe('/?race=3&signin=ok');
    expect(box.mails).toEqual([]);
  });

  it('a send that fails (or never finishes, in waitUntil) changes nothing about the sign-in; the log has no address', async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(' '));
    try {
      for (const [name, run, email] of both) {
        const db = new MemD1();
        await ensureUser(db, email, NOW - 86_400_000);
        const { res, location } = await run(db, {}, { e: env(db, { EMAIL: inbox(true).binding }) });
        expect(location, name).toBe('/?race=3&signin=ok');
        expect(res.headers.getSetCookie()[0], name).toMatch(/^wf_session=[A-Za-z0-9_-]{43};/);
        expect(db.rows('sessions'), name).toHaveLength(1);
        // With waitUntil the response doesn't wait for the send at all.
        const db2 = new MemD1();
        await ensureUser(db2, email, NOW - 86_400_000);
        const waited: Promise<unknown>[] = [];
        const hanging: EmailBindingLike = { send: () => new Promise(() => undefined) };
        const r2 = await run(db2, {}, { e: env(db2, { EMAIL: hanging }), waitUntil: (p) => void waited.push(p) });
        expect(r2.location, name).toBe('/?race=3&signin=ok');
        expect(waited, name).toHaveLength(1);
      }
    } finally {
      console.error = orig;
    }
    expect(errors.filter((l) => l.includes('link notice'))).toEqual(['[recall auth] microsoft link notice not sent: 502', '[recall auth] apple link notice not sent: 502']);
    expect(errors.join('\n')).not.toMatch(/@/);
  });
});

describe('the signed state and buy marker: each with its own purpose', () => {
  const SECRET = 'auth_secret_test_fake';
  const mac = (data: string): string => createHmac('sha256', SECRET).update(data).digest('base64url');
  const state: OAuthState = { provider: 'microsoft', state: 's', nonce: 'n', verifier: 'v', returnTo: '/', exp: NOW + 60_000 };
  const statePayload = Buffer.from(JSON.stringify(state)).toString('base64url');

  it('a state is an HMAC of `oauth-state.v1.` + payload; a bare one (from before) or the buy purpose fails', async () => {
    const signed = await signState(SECRET, state);
    expect(signed).toBe(`${statePayload}.${mac(`oauth-state.v1.${statePayload}`)}`);
    expect(await readState(SECRET, signed, NOW, 'microsoft')).toEqual(state);
    expect(await readState(SECRET, `${statePayload}.${mac(statePayload)}`, NOW, 'microsoft')).toBeNull();
    expect(await readState(SECRET, `${statePayload}.${mac(`recall-buy:${statePayload}`)}`, NOW, 'microsoft')).toBeNull();
  });

  it('a buy marker can’t be read as a state, nor a state as a buy marker; tampered fails', async () => {
    const buy = await signBuy(SECRET, { product: 'regatta', eventId: EVENT, userId: 'u1', exp: NOW + 60_000 });
    expect(await readBuy(SECRET, buy, 'u1', NOW)).toEqual({ product: 'regatta', eventId: EVENT });
    expect(await readState(SECRET, buy, NOW, 'microsoft')).toBeNull();
    const [buyPayload] = buy.split('.');
    expect(await readBuy(SECRET, `${buyPayload}.${mac(`oauth-state.v1.${buyPayload}`)}`, 'u1', NOW)).toBeNull();
    expect(await readBuy(SECRET, await signState(SECRET, state), 'u1', NOW)).toBeNull();
    const signed = await signState(SECRET, state);
    const tampered = `${Buffer.from(JSON.stringify({ ...state, returnTo: 'https://evil.example' })).toString('base64url')}.${signed.split('.')[1]}`;
    expect(await readState(SECRET, tampered, NOW, 'microsoft')).toBeNull();
    expect(await readState(SECRET, `${signed.split('.')[0]}.${mac('x')}`, NOW, 'microsoft')).toBeNull();
    expect(await readBuy(SECRET, `${buyPayload}x.${buy.split('.')[1]}`, 'u1', NOW)).toBeNull();
  });
});

describe('gating: /me offers Microsoft and Apple only when every setting is there', () => {
  const signInOf = async (e: PaywallEnv): Promise<Record<string, unknown>> => (await json(await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`), e, 'me'), mailbox()))).signIn as Record<string, unknown>;

  it('all set: both true', async () => {
    expect(await signInOf(env(new MemD1()))).toEqual({ email: true, google: true, microsoft: true, apple: true, turnstileSiteKey: 'turnstile_site_test_fake' });
  });

  it('any one missing (or blank) turns that provider off, and only that one', async () => {
    for (const k of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'] as const) {
      for (const v of [undefined, '', '  ']) {
        const e = env(new MemD1(), { [k]: v });
        expect(microsoftReady(e), `${k}=${String(v)}`).toBe(false);
        expect(await signInOf(e)).toMatchObject({ microsoft: false, apple: true });
      }
    }
    for (const k of ['APPLE_SERVICES_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'] as const) {
      const e = env(new MemD1(), { [k]: undefined });
      expect(appleReady(e), k).toBe(false);
      expect(await signInOf(e)).toMatchObject({ microsoft: true, apple: false });
    }
    expect(await signInOf(env(new MemD1(), { AUTH_SECRET: undefined }))).toMatchObject({ microsoft: false, apple: false });
    expect(await signInOf(env(undefined))).toMatchObject({ microsoft: false, apple: false });
  });
});

describe('Google and migration 0003', () => {
  const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
  const idToken = (claims: Record<string, unknown>): string => `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

  async function google(db: MemD1): Promise<string> {
    const e = env(db);
    const st = await start('google', e);
    const claims = { iss: 'https://accounts.google.com', aud: e.GOOGLE_CLIENT_ID, exp: NOW / 1000 + 600, sub: 'g-123', email: 'Skipper@Example.com', email_verified: true, nonce: st.nonce };
    const f = (async () => new Response(JSON.stringify({ id_token: idToken(claims) }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/google/callback?code=c&state=${st.state}`, { headers: { cookie: st.cookie } }), e, 'google/callback'), { ...mailbox(), fetch: f });
    return res.headers.get('location')!;
  }

  it('before 0003 is applied, Google signs in exactly as before (the identity write fails quietly)', async () => {
    const db = new MemD1(migration('0001_paywall.sql') + migration('0002_signin_phase1.sql'));
    expect(db.tables.has('identities')).toBe(false);
    expect(await google(db)).toBe('/?race=3&signin=ok');
    expect(db.rows('users')).toEqual([expect.objectContaining({ email: 'skipper@example.com', google_sub: 'g-123' })]);
    expect(db.rows('sessions')).toEqual([expect.objectContaining({ method: 'google' })]);
    // With Microsoft and Apple unset nothing else changes: /me offers neither.
    const me = await json(await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`), paywallEnv(db), 'me'), mailbox()));
    expect(me.signIn).toMatchObject({ google: true, microsoft: false, apple: false });
  });

  it('after it, a Google sign-in also writes (then reuses) its identity row; google_sub is still what signs in', async () => {
    const db = new MemD1();
    expect(await google(db)).toBe('/?race=3&signin=ok');
    const [user] = db.rows('users');
    expect(user.google_sub).toBe('g-123');
    expect(db.rows('identities')).toEqual([expect.objectContaining({ provider: 'google', subject: 'g-123', user_id: user.id, email: 'skipper@example.com', email_verified: 1, is_private_relay: 0 })]);
    expect(await google(db)).toBe('/?race=3&signin=ok');
    expect(db.rows('identities')).toHaveLength(1);
  });

  it('0003 is additive, says it needs the owner’s OK, and copies existing Google links', async () => {
    const sql = migration('0003_identities.sql');
    expect(sql).toMatch(/OWNER'S OK/);
    expect(sql).toMatch(/BEFORE any[\s-]+MICROSOFT_\* or APPLE_\* key is set/);
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(/^\s*(DROP|DELETE|UPDATE|ALTER)\b/im);
    const db = new MemD1();
    const a = await ensureUser(db, 'a@example.com', NOW);
    await setGoogleSub(db, a.id, 'g-a');
    await ensureUser(db, 'b@example.com', NOW);
    const backfill = /INSERT OR IGNORE INTO identities[\s\S]*?;/.exec(sql)![0].replace(/;$/, '');
    await db.prepare(backfill).run();
    await db.prepare(backfill).run();
    expect(db.rows('identities')).toEqual([{ provider: 'google', subject: 'g-a', user_id: a.id, email: 'a@example.com', email_verified: 1, tenant: null, is_private_relay: 0, created_at: NOW, last_used_at: null }]);
  });
});

describe('the page', () => {
  const title = (id: string): string => id;
  const me = (signIn: Partial<Extract<Me, { paywall: true }>['signIn']>, user: { email: string } | null = null): Me => ({
    paywall: true,
    user,
    entitlements: [],
    signIn: { email: false, google: false, ...signIn },
  });
  const plain = (html: string): string => html.replace(/<[^>]*>/g, ' ');

  it('start URLs carry returnTo and the buy intent like Google’s', () => {
    expect(microsoftStartUrl('/?race=3', { product: 'regatta', eventId: EVENT })).toBe(`/api/auth/microsoft/start?returnTo=%2F%3Frace%3D3&buy=regatta&event=${EVENT}`);
    expect(appleStartUrl('/?race=3')).toBe('/api/auth/apple/start?returnTo=%2F%3Frace%3D3');
    expect(oauthStartUrl('google', '/x')).toBe('/api/auth/google/start?returnTo=%2Fx');
  });

  it('the sheet: Google, Apple, Microsoft, then the email form and Restore access', () => {
    const s = sheetHtml(me({ email: true, google: true, microsoft: true, apple: true }), { mode: 'signin' }, title);
    const at = ['Continue with Google', 'Continue with Apple', 'Continue with Microsoft', 'type="email"', 'data-pw="restore"'].map((x) => s.indexOf(x));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(s).toContain('Your passes are kept with your account and its email address.');
    expect(plain(s)).not.toMatch(/[–—!]/);
  });

  it('only what is set up shows; email alone looks as before', () => {
    const emailOnly = sheetHtml(me({ email: true }), { mode: 'signin' }, title);
    expect(emailOnly).not.toMatch(/account-providers|account-or|Continue with/);
    expect(emailOnly).toContain('<p>Your passes are kept with your email address.</p><form class="account-form" data-pw-form="signin">');
    const msOnly = sheetHtml(me({ microsoft: true }), { mode: 'signin' }, title);
    expect(msOnly).toContain('Continue with Microsoft');
    expect(msOnly).not.toMatch(/Continue with (Google|Apple)|<form|Restore/);
    expect(msOnly).toContain('Your passes are kept with your account.');
    const appleGoogle = sheetHtml(me({ google: true, apple: true }), { mode: 'signin' }, title);
    expect(appleGoogle).toMatch(/Continue with Google[\s\S]*Continue with Apple/);
    expect(appleGoogle).not.toContain('Microsoft');
    expect(sheetHtml(me({}), { mode: 'signin' }, title)).toContain('Sign-in is unavailable right now');
    // The lock card's "Already bought? Sign in" shows with any method.
    const card = (signIn: Partial<Extract<Me, { paywall: true }>['signIn']>): string => lockCardHtml(lockView(currentDoc(beneluxRegatta()), { division: 'J70', raceNumber: 3, listed: undefined, range: 'R2–R9', me: me(signIn) }));
    expect(card({ apple: true })).toContain('data-pw="signin">Sign in');
    expect(card({ microsoft: true })).toContain('data-pw="signin">Sign in');
    expect(card({})).toContain('Sign-in is unavailable right now');
  });

  it('the buttons: inline logos (no images), accessible text, the brand classes', () => {
    const html = providerButtonsHtml({ google: true, microsoft: true, apple: true });
    expect(html).not.toMatch(/<img|https?:\/\//);
    const g = /<a class="lock-secondary signin-google" data-pw="google" href="#"><svg class="signin-logo"[\s\S]*?<\/a>/.exec(html)![0];
    expect(g).toContain('aria-hidden="true"');
    expect(g.match(/<path /g)).toHaveLength(4);
    for (const c of ['#EA4335', '#4285F4', '#FBBC05', '#34A853']) expect(g).toContain(`fill="${c}"`);
    expect(g).toContain('</svg><span>Continue with Google</span></a>');
    expect(html).toMatch(/<a class="lock-secondary signin-apple" data-pw="apple" href="#"><svg class="signin-logo"[^>]*aria-hidden="true"[^>]*><path fill="currentColor" d="M12\.152[^"]+"\/><\/svg><span>Continue with Apple<\/span><\/a>/);
    const ms = /<a class="lock-secondary signin-microsoft"[\s\S]*?<\/a>/.exec(html)![0];
    expect(ms).toContain('aria-hidden="true"');
    expect(ms.match(/<rect /g)).toHaveLength(4);
    for (const c of ['#F25022', '#7FBA00', '#00A4EF', '#FFB900']) expect(ms).toContain(`fill="${c}"`);
    expect(ms).toContain('<span>Continue with Microsoft</span>');
    expect(providerButtonsHtml({ google: false })).toBe('');
  });

  it('devices say how they signed in; older rows say nothing', () => {
    const d = (label: string, method: DeviceView['method'], i: number): DeviceView => ({ id: String(i).repeat(24), label, method, createdAt: NOW, lastSeenAt: NOW - i, current: i === 1 });
    const html = devicesHtml({ max: 5, list: [d('Chrome on Mac', 'google', 1), d('Safari on iPhone', 'apple', 2), d('Edge on Windows', 'microsoft', 3), d('Firefox on Linux', 'email', 4), d('Safari on iPad', null, 5)] });
    const names = [...html.matchAll(/<span class="account-device-name">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(names).toEqual(['Chrome on Mac · Google', 'Safari on iPhone · Apple', 'Edge on Windows · Microsoft', 'Firefox on Linux · Email link', 'Safari on iPad']);
  });

  it('failed sign-ins name the provider, or say why; the markers leave the URL', () => {
    expect(returnParam('?signin=failed&via=microsoft&reason=microsoft_email')).toEqual({ kind: 'signin', value: 'failed', via: 'microsoft', reason: 'microsoft_email' });
    expect(returnParam('?signin=failed&via=evil&reason=%3Cb%3E')).toEqual({ kind: 'signin', value: 'failed' });
    expect(failedNote('microsoft', 'microsoft_email')).toBe(MICROSOFT_EMAIL_NOTE);
    expect(MICROSOFT_EMAIL_NOTE).toBe("Your Microsoft account didn't share a verified email address, so it can't be used to sign in here. Try Google, Apple or an email link.");
    expect(failedNote('apple', 'apple_email')).toBe(APPLE_EMAIL_NOTE);
    expect(APPLE_EMAIL_NOTE).toBe("Apple didn't share a verified email address, so we couldn't sign you in. Try again, or use Google, Microsoft or an email link.");
    expect(failedNote('microsoft')).toBe("Couldn't sign you in with Microsoft. Try again, or use an email link.");
    expect(failedNote('apple')).toBe("Couldn't sign you in with Apple. Try again, or use an email link.");
    // No provider named (a link from before): Google's, as today.
    expect(failedNote()).toBe("Couldn't sign you in with Google. Try again, or use an email link.");
    for (const n of [MICROSOFT_EMAIL_NOTE, APPLE_EMAIL_NOTE, failedNote('apple')]) expect(n).not.toMatch(/[–—!]/);
    expect(hereWithout(`${ORIGIN}/?event=${EVENT}&race=3&signin=failed&via=apple&reason=apple_email`)).toBe(`/?event=${EVENT}&race=3`);
  });
});
