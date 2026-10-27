import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RETURN_TO,
  EMAIL_RATE_MAX,
  EXPIRED_LINK_HREF,
  VERIFY_PAGE_CSP,
  VERIFY_SCRIPT,
  verifyScriptHash,
  checkClaims,
  emailProvider,
  handleAuth,
  readState,
  safeReturnTo,
  signState,
  trustedOrigin,
  verifyPageHtml,
  type AuthCtx,
} from '../functions/_auth';
import { DEFAULT_MAX_SESSIONS, LOGIN_TOKEN_TTL_MS, recordPurchase, ensureUser, userByEmail } from '../functions/_authDb';
import { cookieDomain, flagOn, sessionCookie, tokenHash, viewerOf, type PaywallEnv } from '../functions/_paywall';
import { jsonError } from '../functions/_lib';
import { onRequest as authRoute } from '../functions/api/auth/[[path]]';
import { onRequestGet as proxyGet } from '../functions/api/[[path]]';
import { THEME_SCRIPT } from '../functions/_theme';
import { MemD1 } from './d1mem';
import { EVENT, FREE_PASS_VIEWS, NOW, ORIGIN, TURNSTILE_TOKEN, giveRegatta, mailbox, paywallEnv, queryLink, resetPaywallCaches, signIn, tokenOf, withTurnstile } from './paywallHelpers';

const ctx = (request: Request, env: PaywallEnv, path: string): AuthCtx => ({ request, env, params: { path: path.split('/') } });
const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
/** A POST from the page; email and restore carry the Turnstile widget's token unless the body says otherwise. */
const postJson = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}, origin = ORIGIN): Request =>
  new Request(`${origin}/api/auth/${path}`, { method: 'POST', body: JSON.stringify(path === 'email' || path === 'restore' ? { turnstileToken: TURNSTILE_TOKEN, ...body } : body), headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': '203.0.113.9', ...headers } });

/** The confirm page's form POST for the token in an emailed link (same origin, as a browser sends it). */
const confirmPost = (link: string, headers: Record<string, string> = { origin: ORIGIN }): Request =>
  new Request(`${ORIGIN}/api/auth/verify`, {
    method: 'POST',
    body: new URLSearchParams({ token: tokenOf(link) }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'TestBrowser/1', ...headers },
  });

beforeEach(resetPaywallCaches);

describe('flag', () => {
  it('is on only for 1 / true / on (any case)', () => {
    for (const v of ['1', 'true', 'on', 'TRUE', ' On ']) expect(flagOn(v)).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'off', 'yes', 'enabled']) expect(flagOn(v)).toBe(false);
  });

  it('off: every route, /api/auth/me included, is the proxy’s own 404 (byte for byte, as on main)', async () => {
    const db = new MemD1();
    const env = paywallEnv(db, { PAYWALL_ENABLED: undefined });
    // Before the paywall, GET /api/auth/me fell through to the catch-all proxy.
    const before = await proxyGet({ request: new Request(`${ORIGIN}/api/auth/me`), params: { path: ['auth', 'me'] }, waitUntil: () => undefined });
    for (const e of [env, paywallEnv(db, { PAYWALL_ENABLED: 'false' }), paywallEnv(db, { PAYWALL_ENABLED: 'yes' })]) {
      const me = await authRoute({ request: new Request(`${ORIGIN}/api/auth/me`), env: e, params: { path: ['me'] } });
      expect(me.status).toBe(404);
      expect(await me.text()).toBe(await before.clone().text());
      expect([...me.headers]).toEqual([...before.headers]);
    }
    const proxy404 = jsonError(404, 'Unknown endpoint');
    for (const [path, req] of [
      ['email', postJson('email', { email: 'a@example.com' })],
      ['verify', new Request(`${ORIGIN}/api/auth/verify?token=x`)],
      ['verify', confirmPost(`${ORIGIN}/api/auth/verify?token=${'A'.repeat(43)}`)],
      ['google/start', new Request(`${ORIGIN}/api/auth/google/start`)],
      ['logout', postJson('logout', {})],
      ['restore', postJson('restore', { email: 'a@example.com' })],
      ['me', postJson('me', {})],
    ] as const) {
      const res = await authRoute({ request: req, env, params: { path: path.split('/') } });
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe(await proxy404.clone().text());
      expect([...res.headers]).toEqual([...proxy404.headers]);
    }
    expect(db.log).toEqual([]);
  });
});

describe('me', () => {
  it('signed out: paywall on, no user, the sign-in options configured', async () => {
    const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`), paywallEnv(new MemD1()), 'me'), mailbox());
    expect(await json(res)).toEqual({ paywall: true, user: null, entitlements: [], signIn: { email: true, google: true, microsoft: false, apple: false, turnstileSiteKey: 'turnstile_site_test_fake' } });
  });

  it('signed in: the email and the active passes', async () => {
    const db = new MemD1();
    const { user, cookie } = await signIn(db, 'me@example.com');
    await giveRegatta(db, user.id);
    const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie } }), paywallEnv(db), 'me'), mailbox());
    const b = await json(res);
    expect(b.user).toEqual({ email: 'me@example.com' });
    expect(b.entitlements).toEqual([{ scope: 'regatta', eventId: EVENT, startsAt: NOW - 1000, expiresAt: null, seats: null, owner: true }, ...FREE_PASS_VIEWS]);
  });

  it('with the flag on but no D1 bound: signed out, nothing to sign in with', async () => {
    const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`), paywallEnv(undefined), 'me'), mailbox());
    expect(await json(res)).toEqual({ paywall: true, user: null, entitlements: [], signIn: { email: false, google: false, microsoft: false, apple: false, turnstileSiteKey: 'turnstile_site_test_fake' } });
  });
});

describe('magic link', () => {
  it('stores only the token’s hash, 15 minutes; the link signs in once and goes back to returnTo', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const m = mailbox();
    const res = await handleAuth(ctx(postJson('email', { email: ' Racer@Example.COM ', returnTo: `/?event=${EVENT}&race=3` }), env, 'email'), m);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    const [link] = m.links();
    // The token rides in the fragment: never sent to a server, a log or a Referer.
    expect(link).toMatch(/^https:\/\/recall\.walkeforward\.com\/api\/auth\/verify#token=[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = db.rows('login_tokens');
    expect(row).toMatchObject({ email: 'racer@example.com', expires_at: NOW + LOGIN_TOKEN_TTL_MS, used_at: null, return_to: `/?event=${EVENT}&race=3` });
    expect(row.token_hash).toBe(await tokenHash('login', token));
    expect(JSON.stringify(db.rows('login_tokens'))).not.toContain(token);

    const verify = (at: number): Promise<Response> => handleAuth(ctx(confirmPost(link), env, 'verify'), mailbox(at));
    const ok = await verify(NOW + 60_000);
    expect(ok.status).toBe(303);
    // returnTo, with the marker for the app's welcome toast.
    expect(ok.headers.get('location')).toBe(`/?event=${EVENT}&race=3&signin=ok`);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^wf_session=[A-Za-z0-9_-]{43}; Domain=\.walkeforward\.com; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax$/);
    expect(await userByEmail(db, 'racer@example.com')).not.toBeNull();
    const [s] = db.rows('sessions');
    expect(s).toMatchObject({ expires_at: NOW + 60_000 + 30 * 86_400_000, user_agent: 'TestBrowser/1' });
    // Single use: a second POST gets a page saying so (with a way back), no cookie.
    const again = await verify(NOW + 61_000);
    expect(again.status).toBe(400);
    expect(again.headers.get('cache-control')).toBe('no-store');
    expect(again.headers.get('content-security-policy')).toMatch(/^default-src 'none';/);
    const gone = await again.text();
    expect(gone).toContain('<p>This link has expired or was already used.</p>');
    // A way to ask for a new one: the app opens its sign-in sheet for signin=expired.
    expect(gone).toContain(`<a class="btn" href="${EXPIRED_LINK_HREF}">Get a new link</a>`);
    expect(EXPIRED_LINK_HREF).toBe('/regattas?signin=expired');
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(db.rows('sessions')).toHaveLength(1);
  });

  /** The page's one inline script and the CSP hash that allows it. */
  const scriptOf = (html: string): string => {
    const all = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(all).toHaveLength(1);
    return all[0][1];
  };
  const sha256B64 = async (s: string): Promise<string> => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('base64');

  it('GET never uses the token, from a #token= link or an old ?token= one (a link scanner can’t spend it)', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const m = mailbox();
    await handleAuth(ctx(postJson('email', { email: 'scan@example.com', returnTo: '/?race=2' }), env, 'email'), m);
    const [link] = m.links();
    const token = tokenOf(link);
    // What reaches the server: a browser never sends the fragment.
    const fragmentGet = (): Request => new Request(link.split('#')[0]);
    const queryGet = (): Request => new Request(queryLink(link));
    for (const [style, req] of [['fragment', fragmentGet], ['query', queryGet], ['fragment', fragmentGet], ['query', queryGet]] as const) {
      const page = await handleAuth(ctx(req(), env, 'verify'), mailbox());
      expect(page.status, style).toBe(200);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(page.headers.get('set-cookie')).toBeNull();
      const csp = page.headers.get('content-security-policy')!;
      expect(csp.startsWith(`${VERIFY_PAGE_CSP}; script-src 'sha256-`)).toBe(true);
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      const html = await page.text();
      // The auto-submit script, allowed by its hash and nothing else.
      const script = scriptOf(html);
      expect(script).toBe(VERIFY_SCRIPT);
      expect(csp).toContain(`script-src 'sha256-${await sha256B64(script)}'`);
      // And the color theme's, in the head before the style (functions/_theme.ts).
      expect(csp).toContain(` 'sha256-${await sha256B64(THEME_SCRIPT)}'`);
      expect(html.indexOf(`<script data-theme-script>${THEME_SCRIPT}</script>`)).toBeLessThan(html.indexOf('<style>'));
      expect(html.indexOf('<script data-theme-script>')).toBeGreaterThan(0);
      expect(await verifyScriptHash()).toBe(`'sha256-${await sha256B64(VERIFY_SCRIPT)}'`);
      expect(script).toContain("location.hash.slice(1)).get('token')");
      expect(script).toContain('new URLSearchParams(location.search).get(\'token\')');
      expect(script).toContain("history.replaceState(null, '', location.pathname)");
      expect(script).toContain(".submit()");
      // "Signing you in…", announced, with a spinner screen readers skip.
      expect(html).toContain('<div id="status" role="status" aria-live="polite"><span id="busy" class="busy" hidden><span class="spin" aria-hidden="true"></span>Signing you in…</span></div>');
      expect(html).toContain('@media (prefers-reduced-motion:reduce){.spin{animation:none}}');
      expect(html).toContain('<form id="f" method="post" action="/api/auth/verify">');
      expect(html).toContain('<button type="submit">Sign in</button>');
      expect(html).toContain('<div id="gone" hidden><p>This link has expired or was already used.</p>');
      // Self-contained: nothing loaded from anywhere; the only link is Recall's own.
      expect(html).not.toMatch(/src=|url\(|<link/i);
      expect([...html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]).every((h) => h === EXPIRED_LINK_HREF)).toBe(true);
      if (style === 'fragment') {
        // The token is only in the fragment: the form waits for the script; noscript says what to do.
        expect(html).toContain('<input type="hidden" id="t" name="token" value="">');
        expect(html).toContain('<div id="manual" hidden>');
        expect(html).toMatch(/<noscript><div id="nojs"><p>Recall needs JavaScript to finish signing in from this link\. Turn it on and open the link again\.<\/p>/);
        expect(html).not.toContain(token);
      } else {
        // An old link: the button works with no script at all (the fallback), and the script presses it.
        expect(html).toContain(`<input type="hidden" id="t" name="token" value="${token}">`);
        expect(html).toContain('<div id="manual"><p>Tap the button to finish signing in.</p><button type="submit">Sign in</button></div>');
        expect(html).not.toContain('<noscript>');
      }
    }
    expect(db.rows('login_tokens')[0].used_at).toBeNull();
    expect(db.rows('sessions')).toEqual([]);
    // A malformed token is never written into the page (the script shows the expired message).
    const bad = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/verify?token=%22%3E%3Cscript%3E`), env, 'verify'), mailbox());
    expect(bad.status).toBe(200);
    const badHtml = await bad.text();
    expect(badHtml).toContain('name="token" value=""');
    expect(badHtml).not.toContain('"><script>');
    expect(verifyPageHtml('"><script>x</script>&\'')).toContain('name="token" value=""');
    // Then the page's POST signs in, once.
    const ok = await handleAuth(ctx(confirmPost(link), env, 'verify'), mailbox());
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/?race=2&signin=ok');
    expect((await handleAuth(ctx(confirmPost(link), env, 'verify'), mailbox())).status).toBe(400);
  });

  it('an old ?token= link still works end to end: its page posts the token it carries', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const m = mailbox();
    await handleAuth(ctx(postJson('email', { email: 'old@example.com', returnTo: '/?race=4' }), env, 'email'), m);
    const old = queryLink(m.links()[0]);
    expect(old).toMatch(/\/api\/auth\/verify\?token=[A-Za-z0-9_-]{43}$/);
    const html = await (await handleAuth(ctx(new Request(old), env, 'verify'), mailbox())).text();
    const form = /<form id="f" method="post" action="([^"]+)"><input type="hidden" id="t" name="token" value="([^"]*)">/.exec(html)!;
    expect(form[1]).toBe('/api/auth/verify');
    const res = await handleAuth(
      ctx(new Request(new URL(form[1], ORIGIN), { method: 'POST', body: new URLSearchParams({ token: form[2] }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', 'sec-fetch-site': 'same-origin' } }), env, 'verify'),
      mailbox(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/?race=4&signin=ok');
    expect(res.headers.get('set-cookie')).toMatch(/^wf_session=/);
  });

  it('the success marker goes on the safe returnTo, or the default; an outside returnTo is never kept', async () => {
    for (const [returnTo, want] of [
      [`/?event=${EVENT}&race=3#coach`, `/?event=${EVENT}&race=3&signin=ok#coach`],
      ['https://legwork.walkeforward.com/x?y=1', 'https://legwork.walkeforward.com/x?y=1&signin=ok'],
      ['https://evil.example/x', `${DEFAULT_RETURN_TO}?signin=ok`],
      [undefined, `${DEFAULT_RETURN_TO}?signin=ok`],
      ['/?signin=expired', '/?signin=ok'],
    ] as const) {
      const db = new MemD1();
      const env = paywallEnv(db);
      const m = mailbox();
      await handleAuth(ctx(postJson('email', { email: 'r@example.com', returnTo }), env, 'email'), m);
      const res = await handleAuth(ctx(confirmPost(m.links()[0]), env, 'verify'), mailbox());
      expect(res.headers.get('location'), String(returnTo)).toBe(want);
    }
  });

  it('POST: same origin only (Origin, or Sec-Fetch-Site when the Origin is null); a cross-site POST spends nothing', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const m = mailbox();
    await handleAuth(ctx(postJson('email', { email: 'csrf@example.com' }), env, 'email'), m);
    const [link] = m.links();
    const refusals: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'https://legwork.walkeforward.com' },
      {},
      { origin: 'null' },
      { origin: 'null', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of refusals) {
      const res = await handleAuth(ctx(confirmPost(link, headers), env, 'verify'), mailbox());
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(db.rows('login_tokens')[0].used_at).toBeNull();
    expect(db.rows('sessions')).toEqual([]);
    // The confirm page's own POST: its no-referrer policy makes the Origin "null"; Sec-Fetch-Site vouches for it.
    const ok = await handleAuth(ctx(confirmPost(link, { origin: 'null', 'sec-fetch-site': 'same-origin' }), env, 'verify'), mailbox());
    expect(ok.status).toBe(303);
    expect(ok.headers.get('set-cookie')).toMatch(/^wf_session=/);
  });

  it('refuses an expired or unknown token', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const m = mailbox();
    await handleAuth(ctx(postJson('email', { email: 'late@example.com' }), env, 'email'), m);
    const expiredPage = async (res: Response): Promise<void> => {
      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toBeNull();
      const html = await res.text();
      expect(html).toContain('<p>This link has expired or was already used.</p>');
      expect(html).toContain('<a class="btn" href="/regattas?signin=expired">Get a new link</a>');
      // One script, the color theme before first paint, allowed by its hash.
      expect([...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((x) => x[1])).toEqual([THEME_SCRIPT]);
      expect(html).not.toMatch(/src=/i);
      expect(res.headers.get('content-security-policy')).toBe(`${VERIFY_PAGE_CSP}; script-src 'sha256-${await sha256B64(THEME_SCRIPT)}'`);
    };
    await expiredPage(await handleAuth(ctx(confirmPost(m.links()[0]), env, 'verify'), mailbox(NOW + LOGIN_TOKEN_TTL_MS)));
    await expiredPage(await handleAuth(ctx(confirmPost(`${ORIGIN}/api/auth/verify?token=${'A'.repeat(43)}`), env, 'verify'), mailbox()));
    await expiredPage(await handleAuth(ctx(confirmPost(`${ORIGIN}/api/auth/verify`), env, 'verify'), mailbox()));
    expect(db.rows('users')).toEqual([]);
  });

  it('answers alike for any address, limits per email and per IP, refuses cross-site posts and bad input', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const m = mailbox();
    const send = (email: string, headers: Record<string, string> = {}): Promise<Response> => handleAuth(ctx(postJson('email', { email }, headers), env, 'email'), m);
    await ensureUser(db, 'known@example.com', NOW);
    const known = await send('known@example.com');
    const unknown = await send('unknown@example.com');
    expect([known.status, unknown.status]).toEqual([200, 200]);
    expect(await json(known)).toEqual(await json(unknown));
    for (let i = 1; i < EMAIL_RATE_MAX; i++) expect((await send('known@example.com', { 'cf-connecting-ip': `198.51.100.${i}` })).status).toBe(200);
    expect((await send('known@example.com', { 'cf-connecting-ip': '198.51.100.99' })).status).toBe(429);
    expect((await send('not-an-email')).status).toBe(400);
    const cross = await handleAuth(ctx(postJson('email', { email: 'a@example.com' }, { origin: 'https://evil.example' }), env, 'email'), m);
    expect(cross.status).toBe(403);
  });

  it('fails closed (503) with no email provider outside localhost; logs by default on localhost only', async () => {
    const db = new MemD1();
    const env = paywallEnv(db, { EMAIL_PROVIDER: undefined, TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined });
    expect(emailProvider(env, 'recall.walkeforward.com')).toBeNull();
    expect(emailProvider(env, 'start-line.pages.dev')).toBeNull();
    expect(emailProvider(env, 'localhost:8788')).toBe('log');
    const m = mailbox();
    const res = await handleAuth(ctx(postJson('email', { email: 'a@example.com' }), env, 'email'), m);
    expect(res.status).toBe(503);
    expect(m.sent).toEqual([]);
    expect(db.rows('login_tokens')).toEqual([]);
    const local = await handleAuth(ctx(postJson('email', { email: 'a@example.com' }, {}, 'http://localhost:8788'), env, 'email'), m);
    expect(local.status).toBe(200);
    expect(m.links()[0]).toMatch(/^http:\/\/localhost:8788\/api\/auth\/verify#token=/);
  });

  it('sends through Resend with the API key, and says so when it fails', async () => {
    const db = new MemD1();
    const env = paywallEnv(db, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_fake' });
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const f = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response('{}', { status });
    }) as typeof fetch;
    const res = await handleAuth(ctx(postJson('email', { email: 'a@example.com' }), env, 'email'), { ...mailbox(), fetch: withTurnstile(f) });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer re_test_fake' });
    const sentBody = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(sentBody).toMatchObject({ from: 'Recall <recall@walkeforward.example>', to: ['a@example.com'], subject: 'Your Recall sign-in link' });
    expect(String(sentBody.text)).toMatch(/\/api\/auth\/verify#token=/);
    expect(String(sentBody.html)).toContain('>Sign in to Recall</a>');
    status = 500;
    expect((await handleAuth(ctx(postJson('email', { email: 'b@example.com' }), env, 'email'), { ...mailbox(), fetch: withTurnstile(f) })).status).toBe(502);
  });

  it('cloudflare provider: hands an email binding the builder shape (from, to, subject, html, text)', async () => {
    const sent: unknown[] = [];
    const env = paywallEnv(new MemD1(), { EMAIL_PROVIDER: 'cloudflare', EMAIL_FROM: 'Recall <signin@walkeforward.com>', EMAIL: { send: async (msg: unknown) => void sent.push(msg) } });
    expect((await handleAuth(ctx(postJson('email', { email: 'a@example.com' }), env, 'email'), mailbox())).status).toBe(200);
    const msg = sent[0] as Record<string, unknown>;
    expect(Object.keys(msg).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
    expect(msg).toMatchObject({ from: { email: 'signin@walkeforward.com', name: 'Recall' }, to: 'a@example.com', subject: 'Your Recall sign-in link' });
    expect(String(msg.text)).toMatch(/\/api\/auth\/verify#token=/);
    expect(String(msg.html)).toContain('Sign in to Recall');
    const missing = paywallEnv(new MemD1(), { EMAIL_PROVIDER: 'cloudflare', EMAIL: undefined });
    const res = await handleAuth(ctx(postJson('email', { email: 'a@example.com' }), missing, 'email'), mailbox());
    expect(res.status).toBe(503);
    expect((await json(res)).message).toContain('(EMAIL binding)');
  });
});

describe('restore access', () => {
  it('emails a link only for an address with purchases, with the same answer either way', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const buyer = await ensureUser(db, 'buyer@example.com', NOW);
    await recordPurchase(db, { userId: buyer.id, providerRef: 'cs_test_x', product: 'regatta', amount: 5000, currency: 'usd', email: 'Buyer@Example.com', now: NOW });
    const m = mailbox();
    const yes = await handleAuth(ctx(postJson('restore', { email: 'buyer@example.com' }), env, 'restore'), m);
    const no = await handleAuth(ctx(postJson('restore', { email: 'nobody@example.com' }), env, 'restore'), m);
    expect([yes.status, no.status]).toEqual([200, 200]);
    expect(await json(yes)).toEqual(await json(no));
    expect(m.links()).toHaveLength(1);
    expect(m.sent[0]).toContain('buyer@example.com');
    expect(db.rows('login_tokens').map((r) => r.email)).toEqual(['buyer@example.com']);
  });
});

describe('sessions and cookies', () => {
  it('sets Domain for the cookie domain only; none on localhost, *.pages.dev or other hosts', () => {
    const env: PaywallEnv = {};
    expect(cookieDomain('recall.walkeforward.com', env)).toBe('.walkeforward.com');
    expect(cookieDomain('walkeforward.com', env)).toBe('.walkeforward.com');
    expect(cookieDomain('localhost:5173', env)).toBeNull();
    expect(cookieDomain('127.0.0.1:8788', env)).toBeNull();
    expect(cookieDomain('start-line.pages.dev', env)).toBeNull();
    expect(cookieDomain('abc123.start-line.pages.dev', env)).toBeNull();
    expect(cookieDomain('evil.example', env)).toBeNull();
    expect(cookieDomain('recall.example.org', { AUTH_COOKIE_DOMAIN: '.example.org' })).toBe('.example.org');
    const local = sessionCookie('tok', new Request('http://localhost:8788/api/auth/verify'), env, 60);
    expect(local).toBe('wf_session=tok; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax');
  });

  it(`keeps at most ${DEFAULT_MAX_SESSIONS} live sessions per user, revoking (not deleting) the oldest`, async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const cookies: string[] = [];
    for (let i = 0; i < 4; i++) cookies.push((await signIn(db, 'many@example.com', NOW + i * 1000)).cookie);
    expect(db.rows('sessions').filter((r) => r.revoked_at == null)).toHaveLength(DEFAULT_MAX_SESSIONS);
    expect(db.rows('sessions').filter((r) => r.revoked_at != null)).toHaveLength(1);
    const who = async (cookie: string) => (await viewerOf(new Request(ORIGIN, { headers: { cookie } }), env, NOW + 10_000)).user?.email ?? null;
    expect(await who(cookies[0])).toBeNull();
    for (const c of cookies.slice(1)) expect(await who(c)).toBe('many@example.com');
  });

  it('expires a session after 30 days', async () => {
    const db = new MemD1();
    const { cookie } = await signIn(db, 'old@example.com');
    const at = (t: number) => viewerOf(new Request(ORIGIN, { headers: { cookie } }), paywallEnv(db), t);
    expect((await at(NOW + 29 * 86_400_000)).user).not.toBeNull();
    expect((await at(NOW + 30 * 86_400_000)).user).toBeNull();
  });

  it('logout ends this session and clears the cookie', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const { cookie } = await signIn(db, 'bye@example.com');
    expect((await viewerOf(new Request(ORIGIN, { headers: { cookie } }), env, NOW)).user).not.toBeNull();
    const res = await handleAuth(ctx(postJson('logout', {}, { cookie }), env, 'logout'), mailbox());
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBe('wf_session=; Domain=.walkeforward.com; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax');
    expect(db.rows('sessions')).toEqual([]);
    // Nothing is cached: the very next lookup misses.
    expect((await viewerOf(new Request(ORIGIN, { headers: { cookie } }), env, NOW)).user).toBeNull();
  });

  it('the D1 stand-in enforces the migration’s keys (one user per email)', async () => {
    const db = new MemD1();
    await db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind('u1', 'a@example.com', NOW).run();
    await expect(db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind('u2', 'a@example.com', NOW).run()).rejects.toThrow(/UNIQUE/);
    expect((await db.prepare('INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)').bind('u3', 'a@example.com', NOW).run()).meta?.changes).toBe(0);
  });
});

describe('returnTo', () => {
  it('allows site paths and https walkeforward.com pages, nothing else', () => {
    const o = ORIGIN;
    expect(safeReturnTo('/?event=abc&race=2#coach', o)).toBe('/?event=abc&race=2#coach');
    expect(safeReturnTo('https://recall.walkeforward.com/x?y=1', o)).toBe('/x?y=1');
    expect(safeReturnTo('https://legwork.walkeforward.com/a', o)).toBe('https://legwork.walkeforward.com/a');
    expect(safeReturnTo('https://walkeforward.com/', o)).toBe('https://walkeforward.com/');
    for (const bad of [
      '//evil.example/x',
      '/\\evil.example',
      'https://evil.example/',
      'https://walkeforward.com.evil.example/',
      'https://evilwalkeforward.com/',
      'http://recall2.walkeforward.com/',
      'https://user:pw@legwork.walkeforward.com/',
      'https://legwork.walkeforward.com:8443/',
      'javascript:alert(1)',
      '/ok\nSet-Cookie: x',
      '',
      42,
      null,
      undefined,
      '//evil',
    ]) {
      expect(safeReturnTo(bad, o), String(bad)).toBe('/regattas');
    }
    expect(safeReturnTo('http://localhost:5173/?race=2', 'http://localhost:5173')).toBe('/?race=2');
  });

  it('falls back to the regatta list, not the landing page, and leaves a valid deep link alone', () => {
    expect(DEFAULT_RETURN_TO).toBe('/regattas');
    expect(safeReturnTo(undefined, ORIGIN)).toBe('/regattas');
    expect(safeReturnTo('/?event=x&race=3', ORIGIN)).toBe('/?event=x&race=3');
    expect(safeReturnTo('/regattas', ORIGIN)).toBe('/regattas');
  });

  it('trusted origins (the portal POST): this site and https walkeforward.com pages only', () => {
    const o = ORIGIN;
    for (const good of [o, 'https://walkeforward.com', 'https://legwork.walkeforward.com']) expect(trustedOrigin(good, o), good).toBe(true);
    expect(trustedOrigin('http://localhost:8788', 'http://localhost:8788')).toBe(true);
    for (const bad of ['null', '', 'https://evil.example', 'http://walkeforward.com', 'https://walkeforward.com:8443', 'https://evilwalkeforward.com', 'https://walkeforward.com.evil.example', 'https://walkeforward.com/x']) {
      expect(trustedOrigin(bad, o), bad).toBe(false);
    }
  });
});

describe('Google', () => {
  const env = (db: MemD1): PaywallEnv => paywallEnv(db);
  const idToken = (claims: Record<string, unknown>): string => {
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`;
  };

  async function startFlow(db: MemD1): Promise<{ state: string; nonce: string; cookie: string; location: URL }> {
    const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/google/start?returnTo=${encodeURIComponent('/?race=3')}`), env(db), 'google/start'), mailbox());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^wf_oauth=[^;]+; Path=\/api\/auth\/google; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/);
    return { state: location.searchParams.get('state')!, nonce: location.searchParams.get('nonce')!, cookie: setCookie.split(';')[0], location };
  }

  const tokenEndpoint = (claims: Record<string, unknown>, calls: string[] = []): typeof fetch =>
    (async (url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(`${String(url)} ${String(init.body)}`);
      return new Response(JSON.stringify({ id_token: idToken(claims), access_token: 'ya29.test_fake' }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

  it('start: PKCE (S256), state and nonce, our redirect URI', async () => {
    const { location } = await startFlow(new MemD1());
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: 'google-client-id-test-fake.apps.example',
      redirect_uri: `${ORIGIN}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email',
      code_challenge_method: 'S256',
    });
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('callback: exchanges the code (with the verifier), checks the claims, links by verified email', async () => {
    const db = new MemD1();
    const existing = await ensureUser(db, 'skipper@example.com', NOW);
    const { state, nonce, cookie } = await startFlow(db);
    const calls: string[] = [];
    const claims = { iss: 'https://accounts.google.com', aud: 'google-client-id-test-fake.apps.example', exp: NOW / 1000 + 600, sub: 'g-123', email: 'Skipper@Example.com', email_verified: true, nonce };
    const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/google/callback?code=4/test&state=${state}`, { headers: { cookie } }), env(db), 'google/callback'), { ...mailbox(), fetch: tokenEndpoint(claims, calls) });
    expect(res.status).toBe(302);
    // The same welcome marker as the magic link's.
    expect(res.headers.get('location')).toBe('/?race=3&signin=ok');
    expect(res.headers.get('set-cookie')).toMatch(/wf_session=[A-Za-z0-9_-]{43}; Domain=\.walkeforward\.com/);
    expect(calls[0]).toMatch(/^https:\/\/oauth2\.googleapis\.com\/token .*code_verifier=/);
    expect(db.rows('users')).toEqual([expect.objectContaining({ id: existing.id, google_sub: 'g-123' })]);
  });

  it('callback: refuses a wrong state, audience, nonce or an unverified email', async () => {
    const db = new MemD1();
    const { state, nonce, cookie } = await startFlow(db);
    const good = { iss: 'accounts.google.com', aud: 'google-client-id-test-fake.apps.example', exp: NOW / 1000 + 600, sub: 'g-1', email: 'a@example.com', email_verified: true, nonce };
    const run = (claims: Record<string, unknown>, s = state): Promise<Response> =>
      handleAuth(ctx(new Request(`${ORIGIN}/api/auth/google/callback?code=c&state=${s}`, { headers: { cookie } }), env(db), 'google/callback'), { ...mailbox(), fetch: tokenEndpoint(claims) });
    expect((await run(good, 'other-state')).headers.get('location')).toBe('/?signin=failed&via=google');
    for (const bad of [{ aud: 'someone-else' }, { nonce: 'x' }, { email_verified: false }, { iss: 'https://evil.example' }, { exp: NOW / 1000 - 1 }]) {
      const res = await run({ ...good, ...bad });
      expect(res.headers.get('location'), JSON.stringify(bad)).toBe('/?race=3&signin=failed&via=google');
    }
    expect(db.rows('sessions')).toEqual([]);
    expect(checkClaims(good, 'google-client-id-test-fake.apps.example', nonce, NOW)).toEqual({ sub: 'g-1', email: 'a@example.com' });
  });

  it('signs its short-lived state cookie (tampering or expiry voids it)', async () => {
    const s = { state: 's', nonce: 'n', verifier: 'v', returnTo: '/', exp: NOW + 1000 };
    const signed = await signState('auth_secret_test_fake', s);
    expect(await readState('auth_secret_test_fake', signed, NOW)).toEqual(s);
    expect(await readState('auth_secret_other_fake', signed, NOW)).toBeNull();
    expect(await readState('auth_secret_test_fake', signed, NOW + 1000)).toBeNull();
    const [p, sig] = signed.split('.');
    expect(await readState('auth_secret_test_fake', `${p}x.${sig}`, NOW)).toBeNull();
  });
});
