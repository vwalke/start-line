import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailProvider, emailReady, handleAuth, linkMinutes, parseFrom, sendEmail, signInMail, turnstileReady, type AuthCtx, type AuthDeps } from '../functions/_auth';
import { LOGIN_TOKEN_TTL_MS } from '../functions/_authDb';
import type { PaywallEnv } from '../functions/_paywall';
import { MemD1 } from './d1mem';
import { NOW, ORIGIN, TURNSTILE_TOKEN, TURNSTILE_VERIFY, mailbox, paywallEnv, resetPaywallCaches, withTurnstile } from './paywallHelpers';

const ctx = (request: Request, env: PaywallEnv, path: string): AuthCtx => ({ request, env, params: { path: path.split('/') } });
const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
const post = (path: string, body: Record<string, unknown>, origin = ORIGIN, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}/api/auth/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': '203.0.113.9', ...headers } });
const CF_URL = 'https://api.cloudflare.com/client/v4/accounts/acct_test_fake/email/sending/send';

const deps = (f: typeof fetch = withTurnstile()): AuthDeps & { readonly sent: string[] } => mailbox(NOW, f);

/** Cloudflare's Email Sending API, faked: answers `reply` and keeps each request. */
function cloudflareApi(reply: () => Response | Promise<Response>): typeof fetch & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return reply();
  }) as typeof fetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const cfEnv = (over: Partial<PaywallEnv> = {}): PaywallEnv =>
  paywallEnv(new MemD1(), { EMAIL_PROVIDER: 'cloudflare-api', EMAIL_FROM: 'Recall <signin@walkeforward.com>', CF_EMAIL_ACCOUNT_ID: 'acct_test_fake', CF_EMAIL_API_TOKEN: 'cf_token_test_fake', ...over });

beforeEach(resetPaywallCaches);

describe('EMAIL_FROM', () => {
  it('takes "Name <address>" or a bare address; anything else is not set up', () => {
    expect(parseFrom('Recall <signin@walkeforward.com>')).toEqual({ email: 'signin@walkeforward.com', name: 'Recall' });
    expect(parseFrom('  "Recall" <signin@walkeforward.com> ')).toEqual({ email: 'signin@walkeforward.com', name: 'Recall' });
    expect(parseFrom('signin@walkeforward.com')).toEqual({ email: 'signin@walkeforward.com' });
    expect(parseFrom('<signin@walkeforward.com>')).toEqual({ email: 'signin@walkeforward.com' });
    for (const bad of [undefined, '', 'Recall', 'Recall <>', 'Recall <not an address>', 'Recall <a@b>', 'Re\ncall <signin@walkeforward.com>', 'signin@walkeforward.com, x@example.com']) {
      expect(parseFrom(bad), String(bad)).toBeNull();
    }
  });
});

describe('the sign-in email', () => {
  const link = `${ORIGIN}/api/auth/verify#token=${'a'.repeat(43)}`;
  const minutes = LOGIN_TOKEN_TTL_MS / 60_000;

  it('says it plainly in text, with the link on its own line and no HTML', () => {
    expect(linkMinutes()).toBe(minutes);
    const m = signInMail('a@example.com', link);
    expect(m.subject).toBe('Your Recall sign-in link');
    expect(m.text).toBe(
      `Hi there,\n\nHere's your link to sign in to Recall.\n\n${link}\n\nThe link works once and expires in ${minutes} minutes.\n\nIf you didn't ask for this, you can ignore it.\n\nRecall\n${ORIGIN}\n`,
    );
    expect(m.text.split('\n')).toContain(link);
    expect(m.text).not.toMatch(/<|>|&[a-z#0-9]+;/i);
    const r = signInMail('a@example.com', link, 'restore');
    expect(r.subject).toBe('Your Recall sign-in link');
    expect(r.text.split('\n')[2]).toBe("Here's your link to get back into Recall and your passes.");
    expect(r.text.split('\n')).toContain(link);
  });

  it('HTML: the wordmark as text, a bulletproof button with a VML fallback, the plain link, the expiry, the footer', () => {
    const m = signInMail('a@example.com', link);
    const h = m.html;
    expect(h).toContain('<meta name="color-scheme" content="light dark">');
    expect(h).toContain('<meta name="supported-color-schemes" content="light dark">');
    // Hidden preheader.
    expect(h).toMatch(/<div style="display:none;[^"]*mso-hide:all[^"]*">Your link to sign in to Recall\./);
    // The masthead: carbon, the wordmark as live text, the gold rule.
    expect(h).toMatch(/bgcolor="#16181c"[^>]*border-bottom:4px solid #ffc94d/);
    expect(h).toMatch(/text-transform:uppercase;color:#f2f4f7">Recall<\/p>/);
    expect(h).toContain('max-width:560px');
    // The button: a padded cell in the brand blue, an <a> for most clients, a VML roundrect for Outlook desktop.
    expect(h).toContain('<td align="center" bgcolor="#1f6bc4" style="background:#1f6bc4;border-radius:8px">');
    expect(h.match(/>Sign in to Recall<\/a>/g)).toHaveLength(1);
    expect(h).toMatch(/<!--\[if mso\]>\s*<v:roundrect [^>]*href="https:\/\/recall\.walkeforward\.com\/api\/auth\/verify#token=a{43}"[^>]*fillcolor="#1f6bc4">[\s\S]*<center[^>]*>Sign in to Recall<\/center>\s*<\/v:roundrect>\s*<!\[endif\]-->/);
    expect(h).toContain('<!--[if !mso]><!-- -->');
    // Then the plain link, the expiry from the constant, the footer.
    expect(h).toContain('Or paste this link into your browser:');
    expect(h).toContain(`>${link}</a>`);
    expect(h).toContain(`The link works once and expires in ${minutes} minutes.`);
    expect(h).toContain(`<a href="${ORIGIN}" target="_blank" style="color:#5b6675;text-decoration:underline">recall.walkeforward.com</a>`);
    expect(h).toContain('If you didn&#39;t ask for this, you can ignore it.');
    expect(h).toContain('Hi there,');
    // Nothing loaded from anywhere: no images, styles sheets or scripts.
    expect(h).not.toMatch(/<img|<link|<script|<style|src=|url\(|background-image/i);
    // The footer links to the site the email was sent from.
    expect(signInMail('a@example.com', 'https://abc.start-line.pages.dev/api/auth/verify#token=x').html).toContain('<a href="https://abc.start-line.pages.dev" target="_blank"');
    const r = signInMail('a@example.com', link, 'restore').html;
    expect(r).toContain('Here&#39;s your link to get back into Recall and your passes.');
    expect(r).toContain('>Your link to get back into Recall.');
  });

  it('escapes the link everywhere it goes (button, VML, plain link)', () => {
    const m = signInMail('a@example.com', `${ORIGIN}/api/auth/verify#token=x&y="<b>`);
    expect(m.html.match(/href="https:\/\/recall\.walkeforward\.com\/api\/auth\/verify#token=x&amp;y=&quot;&lt;b&gt;"/g)).toHaveLength(3);
    expect(m.html).toContain('>https://recall.walkeforward.com/api/auth/verify#token=x&amp;y=&quot;&lt;b&gt;</a>');
    expect(m.html).not.toContain('"<b>');
  });

  it('copy: American, short, no dashes or exclamation marks', () => {
    for (const kind of ['signin', 'restore'] as const) {
      const m = signInMail('a@example.com', link, kind);
      // Tags and comments aside (<!doctype>, <!--[if mso]>), and the preheader's fillers.
      for (const copy of [m.text, m.html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '')]) expect(copy).not.toMatch(/[–—!]/);
      expect(m.text).not.toMatch(/colour|cancell|organis/i);
    }
  });
});

describe('cloudflare-api provider', () => {
  it('POSTs the message as JSON to the Email Sending API with the token; success: true is sent', async () => {
    const api = cloudflareApi(() => Response.json({ success: true, errors: [], messages: [], result: {} }));
    const r = await sendEmail(cfEnv(), 'recall.walkeforward.com', signInMail('a@example.com', 'https://x.example/l'), deps(api));
    expect(r).toEqual({ ok: true });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].url).toBe(CF_URL);
    expect(api.calls[0].init.method).toBe('POST');
    expect(api.calls[0].init.headers).toEqual({ authorization: 'Bearer cf_token_test_fake', 'content-type': 'application/json' });
    const body = JSON.parse(String(api.calls[0].init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
    expect(body).toMatchObject({ to: 'a@example.com', subject: 'Your Recall sign-in link' });
    // The REST API takes a named sender as { address, name } (not the binding's { email, name }).
    expect(body.from).toEqual({ address: 'signin@walkeforward.com', name: 'Recall' });
    // A bare EMAIL_FROM goes as the address alone.
    await sendEmail(cfEnv({ EMAIL_FROM: 'signin@walkeforward.com' }), 'recall.walkeforward.com', signInMail('a@example.com', 'https://x.example/l'), deps(api));
    expect(JSON.parse(String(api.calls[1].init.body)).from).toBe('signin@walkeforward.com');
  });

  it('passes List-Unsubscribe and List-Unsubscribe-Post through with an https link; drops both with an http one, and anything else always', async () => {
    const api = cloudflareApi(() => Response.json({ success: true, errors: [], messages: [], result: {} }));
    const unsub = 'https://recall.walkeforward.com/api/alerts/unsubscribe?t=abc.def';
    const mail = (headers: Record<string, string>) => ({ ...signInMail('a@example.com', 'https://x.example/l'), headers });
    const bodyOf = (n: number) => JSON.parse(String(api.calls[n].init.body)) as Record<string, unknown>;
    await sendEmail(cfEnv(), 'recall.walkeforward.com', mail({ 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'X-Other': 'no' }), deps(api));
    expect(bodyOf(0).headers).toEqual({ 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(Object.keys(bodyOf(0)).sort()).toEqual(['from', 'headers', 'html', 'subject', 'text', 'to']);
    await sendEmail(cfEnv(), 'localhost', mail({ 'List-Unsubscribe': '<http://localhost:8788/api/alerts/unsubscribe?t=abc.def>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }), deps(api));
    expect(bodyOf(1)).not.toHaveProperty('headers');
    await sendEmail(cfEnv(), 'recall.walkeforward.com', mail({ 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'yes' }), deps(api));
    expect(bodyOf(2).headers).toEqual({ 'List-Unsubscribe': `<${unsub}>` });
    await sendEmail(cfEnv(), 'recall.walkeforward.com', mail({ 'X-Other': 'no' }), deps(api));
    expect(bodyOf(3)).not.toHaveProperty('headers');
  });

  it('the EMAIL binding still gets a named sender as { email, name }', async () => {
    const sent: unknown[] = [];
    const env = cfEnv({ EMAIL_PROVIDER: 'cloudflare', EMAIL: { send: async (msg) => void sent.push(msg) } });
    expect(await sendEmail(env, 'recall.walkeforward.com', signInMail('a@example.com', 'https://x.example/l'), deps())).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect((sent[0] as { from: unknown }).from).toEqual({ email: 'signin@walkeforward.com', name: 'Recall' });
  });

  it('a failed send logs the status and Cloudflare error codes, never the token, recipient or link', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const reply = () => Response.json({ success: false, errors: [{ code: 10001, message: 'email.sending.error.invalid_request_schema' }], messages: [], result: null }, { status: 400 });
      const mail = signInMail('rcpt@example.com', `${ORIGIN}/api/auth/verify?token=secret_link_token`);
      const r = await sendEmail(cfEnv(), 'recall.walkeforward.com', mail, deps(cloudflareApi(reply)));
      expect(r).toEqual({ ok: false, status: 502, error: "Couldn't send the email just now. Try again in a minute." });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls.flat().map(String).join(' ');
      expect(line).toContain('400');
      expect(line).toContain('10001 email.sending.error.invalid_request_schema');
      for (const secret of ['cf_token_test_fake', 'rcpt@example.com', '/api/auth/verify', 'secret_link_token']) expect(line).not.toContain(secret);
      // Unparseable bodies and throws are logged too, without the details.
      await sendEmail(cfEnv(), 'recall.walkeforward.com', mail, deps(cloudflareApi(() => new Response('<html>oops</html>', { status: 502 }))));
      await sendEmail(cfEnv(), 'recall.walkeforward.com', mail, deps(cloudflareApi(() => Promise.reject(new Error('rcpt@example.com cf_token_test_fake')))));
      expect(spy).toHaveBeenCalledTimes(3);
      const all = spy.mock.calls.flat().map(String).join(' ');
      expect(all).toContain('HTTP 502; unparseable body');
      for (const secret of ['cf_token_test_fake', 'rcpt@example.com', '/api/auth/verify']) expect(all).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  it('anything but ok + success: true (or a throw) is the 502', async () => {
    const replies: (() => Response | Promise<Response>)[] = [
      () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 }),
      () => Response.json({ success: false }),
      () => Response.json({ success: 'true' }),
      () => new Response('<html>oops</html>', { status: 200 }),
      () => Response.json({ success: true }, { status: 500 }),
      () => Promise.reject(new Error('network down')),
    ];
    for (const reply of replies) {
      const r = await sendEmail(cfEnv(), 'recall.walkeforward.com', signInMail('a@example.com', 'https://x.example/l'), deps(cloudflareApi(reply)));
      expect(r).toEqual({ ok: false, status: 502, error: "Couldn't send the email just now. Try again in a minute." });
    }
  });

  it('missing settings: the 503 names the variable, never its value; nothing is sent', async () => {
    const api = cloudflareApi(() => Response.json({ success: true }));
    const cases: [Partial<PaywallEnv>, string][] = [
      [{ CF_EMAIL_ACCOUNT_ID: undefined }, 'CF_EMAIL_ACCOUNT_ID'],
      [{ CF_EMAIL_API_TOKEN: ' ' }, 'CF_EMAIL_API_TOKEN'],
      [{ EMAIL_FROM: 'not an address' }, 'EMAIL_FROM'],
    ];
    for (const [over, name] of cases) {
      const r = await sendEmail(cfEnv(over), 'recall.walkeforward.com', signInMail('a@example.com', 'https://x.example/l'), deps(api));
      expect(r).toEqual({ ok: false, status: 503, error: `Email sign-in is not set up on this site yet (${name}).` });
      expect(JSON.stringify(r)).not.toMatch(/acct_test_fake|cf_token_test_fake/);
    }
    expect(api.calls).toEqual([]);
  });

  it('end to end: the route sends through it and answers as before', async () => {
    const api = cloudflareApi(() => Response.json({ success: true }));
    const env = cfEnv();
    const res = await handleAuth(ctx(post('email', { email: 'a@example.com', turnstileToken: TURNSTILE_TOKEN }), env, 'email'), deps(withTurnstile(api)));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(api.calls.map((c) => c.url)).toEqual([CF_URL]);
    expect(JSON.parse(String(api.calls[0].init.body)).text).toMatch(/\n\S+\/api\/auth\/verify#token=[A-Za-z0-9_-]{43}\n/);
    const failing = cloudflareApi(() => Response.json({ success: false }, { status: 400 }));
    const bad = await handleAuth(ctx(post('email', { email: 'b@example.com', turnstileToken: TURNSTILE_TOKEN }), env, 'email'), deps(withTurnstile(failing)));
    expect(bad.status).toBe(502);
    expect((await json(bad)).message).toBe("Couldn't send the email just now. Try again in a minute.");
  });
});

describe('the log provider', () => {
  afterEach(() => vi.restoreAllMocks());
  const logEnv = (): PaywallEnv => paywallEnv(new MemD1(), { EMAIL_PROVIDER: 'log' });
  const mail = signInMail('a@example.com', `${ORIGIN}/api/auth/verify?token=${'a'.repeat(43)}`);

  it('an explicit EMAIL_PROVIDER=log off localhost is not set up: 503, signIn.email false, nothing logged', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const origin of [ORIGIN, 'https://start-line.pages.dev', 'https://abc123.start-line.pages.dev']) {
      const host = new URL(origin).host;
      const env = logEnv();
      expect(emailProvider(env, host), host).toBeNull();
      expect(await sendEmail(env, host, mail, { now: () => NOW, cache: null }), host).toMatchObject({ ok: false, status: 503 });
      const d: AuthDeps = { now: () => NOW, cache: null, fetch: withTurnstile(undefined, new URL(origin).hostname) };
      for (const route of ['email', 'restore']) {
        const res = await handleAuth(ctx(post(route, { email: 'a@example.com', turnstileToken: TURNSTILE_TOKEN }, origin), env, route), d);
        expect(res.status, `${host} ${route}`).toBe(503);
      }
      const me = await json(await handleAuth(ctx(new Request(`${origin}/api/auth/me`), env, 'me'), d));
      expect((me.signIn as Record<string, unknown>).email, host).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('still logs the link on localhost (without Turnstile)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env = paywallEnv(new MemD1(), { EMAIL_PROVIDER: 'log', TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined });
    expect(emailProvider(env, 'localhost:8788')).toBe('log');
    const res = await handleAuth(ctx(post('email', { email: 'a@example.com' }, 'http://localhost:8788'), env, 'email'), { now: () => NOW, cache: null, fetch: withTurnstile() });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('http://localhost:8788/api/auth/verify#token=');
  });
});

describe('Turnstile', () => {
  const env = (over: Partial<PaywallEnv> = {}): PaywallEnv => paywallEnv(new MemD1(), over);
  const me = async (e: PaywallEnv, origin = ORIGIN): Promise<Record<string, unknown>> => (await json(await handleAuth(ctx(new Request(`${origin}/api/auth/me`), e, 'me'), deps()))).signIn as Record<string, unknown>;

  it('signIn.email needs an email provider and Turnstile, except on localhost; the site key goes to the page', async () => {
    expect(await me(env())).toEqual({ email: true, google: true, microsoft: false, apple: false, turnstileSiteKey: 'turnstile_site_test_fake' });
    const noTs = env({ TURNSTILE_SECRET_KEY: undefined });
    expect(turnstileReady(noTs)).toBe(false);
    expect(await me(noTs)).toEqual({ email: false, google: true, microsoft: false, apple: false, turnstileSiteKey: null });
    expect(await me(env({ TURNSTILE_SITE_KEY: '' }))).toMatchObject({ email: false, turnstileSiteKey: null });
    expect(await me(env({ EMAIL_PROVIDER: 'nope' }))).toMatchObject({ email: false });
    // Localhost: the log provider works without Turnstile.
    const local = env({ EMAIL_PROVIDER: undefined, TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined });
    expect(await me(local, 'http://localhost:8788')).toMatchObject({ email: true, turnstileSiteKey: null });
    expect(await me(local, 'http://127.0.0.1:8788')).toMatchObject({ email: true });
    expect(emailReady(local, 'start-line.pages.dev')).toBe(false);
  });

  it('without Turnstile set up, email sign-in refuses (503) anywhere but localhost', async () => {
    const e = env({ TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined });
    const d = deps();
    const res = await handleAuth(ctx(post('email', { email: 'a@example.com' }), e, 'email'), d);
    expect(res.status).toBe(503);
    expect((await handleAuth(ctx(post('restore', { email: 'a@example.com' }), e, 'restore'), d)).status).toBe(503);
    expect(d.sent).toEqual([]);
    const local = await handleAuth(ctx(post('email', { email: 'a@example.com' }, 'http://localhost:8788'), e, 'email'), d);
    expect(local.status).toBe(200);
    expect(d.sent).toHaveLength(1);
  });

  it('checks the token with Cloudflare: secret, response and the client IP as form data', async () => {
    const f = withTurnstile();
    const res = await handleAuth(ctx(post('email', { email: 'a@example.com', turnstileToken: TURNSTILE_TOKEN }), env(), 'email'), deps(f));
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect(Object.fromEntries(f.calls[0])).toEqual({ secret: 'turnstile_secret_test_fake', response: TURNSTILE_TOKEN, remoteip: '203.0.113.9' });
  });

  it('a missing or failed check is a 400 and sends nothing; the same for Restore access', async () => {
    for (const route of ['email', 'restore']) {
      const d = deps();
      for (const token of [undefined, '', 42, 'x'.repeat(2049), 'wrong_token']) {
        const res = await handleAuth(ctx(post(route, { email: 'a@example.com', turnstileToken: token }), env(), route), d);
        expect(res.status, `${route} ${String(token).slice(0, 10)}`).toBe(400);
        expect(await json(res)).toEqual({ error: 'turnstile_failed', message: 'Please complete the check and try again.' });
      }
      expect(d.sent).toEqual([]);
    }
  });

  it('a token solved on another hostname is refused', async () => {
    const d = deps(withTurnstile(undefined, 'evil.example'));
    const res = await handleAuth(ctx(post('email', { email: 'a@example.com', turnstileToken: TURNSTILE_TOKEN }), env(), 'email'), d);
    expect(res.status).toBe(400);
    expect(d.sent).toEqual([]);
    const noHost = (async () => Response.json({ success: true })) as unknown as typeof fetch;
    expect((await handleAuth(ctx(post('email', { email: 'a@example.com', turnstileToken: TURNSTILE_TOKEN }), env(), 'email'), deps(noHost))).status).toBe(400);
  });

  it('fails closed when Cloudflare can’t be asked (503), and sends nothing', async () => {
    const answers: typeof fetch[] = [
      (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
      (async () => new Response('busy', { status: 500 })) as unknown as typeof fetch,
      (async () => new Response('not json')) as unknown as typeof fetch,
    ];
    for (const f of answers) {
      const d = deps(f);
      const res = await handleAuth(ctx(post('email', { email: 'a@example.com', turnstileToken: TURNSTILE_TOKEN }), env(), 'email'), d);
      expect(res.status).toBe(503);
      expect(await json(res)).toEqual({ error: 'turnstile_unavailable', message: "Couldn't check that you're human just now. Try again in a minute." });
      expect(d.sent).toEqual([]);
    }
  });

  it('order: a bad address is refused before Turnstile is asked; a failed check counts against no rate limit', async () => {
    const db = new MemD1();
    const e = paywallEnv(db);
    const f = withTurnstile();
    expect((await handleAuth(ctx(post('email', { email: 'nope', turnstileToken: TURNSTILE_TOKEN }), e, 'email'), deps(f))).status).toBe(400);
    expect(f.calls).toHaveLength(0);
    for (let i = 0; i < 8; i++) expect((await handleAuth(ctx(post('email', { email: 'a@example.com', turnstileToken: 'wrong' }), e, 'email'), deps(f))).status).toBe(400);
    expect(db.rows('auth_rate_limits')).toEqual([]);
    expect((await handleAuth(ctx(post('email', { email: 'a@example.com', turnstileToken: TURNSTILE_TOKEN }), e, 'email'), deps(f))).status).toBe(200);
  });

  it('restore keeps the same answer whether or not the address bought anything', async () => {
    const d = deps();
    const yes = await handleAuth(ctx(post('restore', { email: 'nobody@example.com', turnstileToken: TURNSTILE_TOKEN }), env(), 'restore'), d);
    expect(yes.status).toBe(200);
    expect(await json(yes)).toEqual({ ok: true });
    expect(d.sent).toEqual([]);
  });

  it('never reaches the network for anything but siteverify here', async () => {
    const seen: string[] = [];
    const f = withTurnstile((async (u: RequestInfo | URL) => {
      seen.push(String(u));
      return new Response('nope', { status: 404 });
    }) as typeof fetch);
    await handleAuth(ctx(post('email', { email: 'a@example.com', turnstileToken: TURNSTILE_TOKEN }), env(), 'email'), deps(f));
    expect(seen).toEqual([]);
    expect(f.calls.length).toBe(1);
    expect(TURNSTILE_VERIFY).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  });
});
