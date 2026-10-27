import { beforeEach, describe, expect, it } from 'vitest';
import { BODY_MAX_BYTES, feedbackMail, feedbackRecipients, handleFeedback, handleFeedbackInfo, ipHash, parseFeedback, type FeedbackDeps, type FeedbackEnv } from '../functions/_feedback';
import { onRequest, onRequestGet, onRequestPost } from '../functions/api/feedback';
import type { EmailBindingLike } from '../functions/_paywall';
import { MemD1 } from './d1mem';
import { MemBucket } from './r2mem';
import { NOW, ORIGIN, TURNSTILE_TOKEN, resetPaywallCaches, signIn, withTurnstile } from './paywallHelpers';

type Sent = Parameters<EmailBindingLike['send']>[0];

/** An EMAIL binding that keeps every message whole (html too); `fail` makes it throw. */
function mailer(): EmailBindingLike & { sent: Sent[]; fail: boolean } {
  const m = {
    sent: [] as Sent[],
    fail: false,
    async send(msg: Sent) {
      if (m.fail) throw new Error('mail down');
      m.sent.push(msg);
    },
  };
  return m;
}

const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4));
const WEBP = btoa('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');

function env(db: MemD1 | undefined, over: Partial<FeedbackEnv> = {}): FeedbackEnv & { EMAIL: ReturnType<typeof mailer> } {
  return {
    AUTH_DB: db,
    AUTH_SECRET: 'auth_secret_test_fake',
    EMAIL_PROVIDER: 'cloudflare',
    EMAIL_FROM: 'Recall <recall@walkeforward.example>',
    EMAIL: mailer(),
    FEEDBACK_TO: 'owner@walkeforward.example, not-an-address, Second@Walkeforward.example',
    ...over,
  } as FeedbackEnv & { EMAIL: ReturnType<typeof mailer> };
}

const deps = (over: FeedbackDeps = {}): FeedbackDeps => ({ now: () => NOW, random: () => 1, fetch: withTurnstile(), ...over });

const context = {
  v: 1,
  where: { url: `${ORIGIN}/regattas?event=E1&div=J70&race=3#race`, path: '/regattas', eventId: 'E1', eventTitle: 'Fall <Series>', division: 'J70', race: '3', tab: 'race', boats: ['USA 833'] },
  device: { viewport: '390×844', screen: '390×844', dpr: 3, platform: 'iOS', touch: true, language: 'en-US', timeZone: 'America/New_York' },
  theme: { resolved: 'dark', source: 'system' },
  app: { commit: 'abc1234', builtAt: '2026-10-27T00:00:00Z' },
  data: { loaded: true, boatCount: 18 },
  problems: [{ kind: 'api', at: '2026-10-22T11:59:00Z', text: 'GET /api/regatta?event → 502' }],
};

function post(body: unknown, o: { cookie?: string; ip?: string; origin?: string; raw?: string } = {}): Request {
  const h = new Headers({ 'content-type': 'application/json', origin: o.origin ?? ORIGIN, 'cf-connecting-ip': o.ip ?? '203.0.113.7', 'user-agent': 'Mozilla/5.0 (iPhone) test' });
  if (o.cookie) h.set('cookie', o.cookie);
  return new Request(`${ORIGIN}/api/feedback`, { method: 'POST', headers: h, body: o.raw ?? JSON.stringify(body) });
}

const good = (over: Record<string, unknown> = {}) => ({ type: 'bug', message: 'The map froze at the second mark.', context, ...over });

beforeEach(() => resetPaywallCaches());

describe('POST /api/feedback', () => {
  it('stores a signed-out submission with the server-side details and emails each FEEDBACK_TO address', async () => {
    const db = new MemD1();
    const e = env(db);
    const res = await handleFeedback({ request: post(good({ email: ' Sender@Example.COM ' })), env: e }, deps());
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; id: string };
    expect(out.ok).toBe(true);
    const [row] = db.rows('feedback');
    expect(row).toMatchObject({
      id: out.id,
      created_at: NOW,
      type: 'bug',
      message: 'The map froze at the second mark.',
      email: 'sender@example.com',
      user_id: null,
      session_public_id: null,
      url: context.where.url,
      event_id: 'E1',
      division: 'J70',
      race: '3',
      app_commit: 'abc1234',
      user_agent: 'Mozilla/5.0 (iPhone) test',
      image_key: null,
      emailed_at: NOW,
      email_error: null,
    });
    expect(row.ip_hash).toBe(await ipHash('203.0.113.7', 'auth_secret_test_fake'));
    expect(row.ip_hash).not.toContain('203.0.113.7');
    expect(JSON.parse(String(row.context_json))).toEqual(context);
    // One email per good address; the bad entry is skipped.
    expect(e.EMAIL.sent.map((m) => m.to)).toEqual(['owner@walkeforward.example', 'second@walkeforward.example']);
    const m = e.EMAIL.sent[0];
    expect(m.subject).toBe('Recall feedback: Bug · Fall <Series>');
    expect(m.text).toContain('The map froze at the second mark.');
    expect(m.text).toContain('sender@example.com (signed out)');
    expect(m.text).toContain('GET /api/regatta?event → 502');
    expect(m.text).toContain('abc1234');
    expect(m.text).toContain('dark, system');
    expect(m.html).toContain(`<a href="${context.where.url.replace(/&/g, '&amp;')}">`);
  });

  it('takes who it is from the session, never from the page', async () => {
    const db = new MemD1();
    const { user, cookie, publicId } = await signIn(db, 'member@example.com');
    const res = await handleFeedback(
      { request: post(good({ email: 'someone-else@example.com', userId: 'u_fake', context: { ...context, user: { id: 'u_fake', email: 'x@example.com' } } }), { cookie }), env: env(db) },
      deps(),
    );
    expect(res.status).toBe(200);
    const [row] = db.rows('feedback');
    expect(row).toMatchObject({ email: 'member@example.com', user_id: user.id, session_public_id: publicId });
  });

  it('escapes everything the page sent in the HTML email, and sets Reply-To when the sender gave an address', async () => {
    const db = new MemD1();
    const e = env(db, { FEEDBACK_TO: 'owner@walkeforward.example' });
    const evil = '<script>alert(1)</script> & "quotes"';
    const ctx = { ...context, where: { ...context.where, eventTitle: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' }, problems: [{ kind: 'error', at: 'now', text: '<b>boom</b>' }] };
    await handleFeedback({ request: post(good({ message: evil, context: ctx, email: 'a@example.com' })), env: e }, deps());
    const [m] = e.EMAIL.sent;
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).not.toContain('<b>boom</b>');
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(m.html).not.toContain('href="javascript:');
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(feedbackMail('o@example.com', { id: 'x', type: 'idea', message: 'hi', email: 'a@example.com', userId: null, url: null, context: {}, appCommit: null, country: null, userAgent: null, images: [] }).replyTo).toBe('a@example.com');
  });

  it('a failed email still answers 200 and records the error', async () => {
    const db = new MemD1();
    const e = env(db);
    e.EMAIL.fail = true;
    const res = await handleFeedback({ request: post(good()), env: e }, deps());
    expect(res.status).toBe(200);
    const [row] = db.rows('feedback');
    expect(row.emailed_at).toBeNull();
    expect(String(row.email_error)).toContain('owner@walkeforward.example');
    expect(String(row.email_error)).not.toContain('auth_secret');
  });

  it('no FEEDBACK_TO: no email, nothing recorded about one', async () => {
    const db = new MemD1();
    const e = env(db, { FEEDBACK_TO: ' , ' });
    expect((await handleFeedback({ request: post(good()), env: e }, deps())).status).toBe(200);
    expect(e.EMAIL.sent).toEqual([]);
    expect(db.rows('feedback')[0]).toMatchObject({ emailed_at: null, email_error: null });
  });

  it('stores images in the bucket under feedback/<id>/, or saves without them when there is no bucket', async () => {
    const db = new MemD1();
    const bucket = new MemBucket();
    const e = env(db, { VKX_BUCKET: bucket });
    const res = await handleFeedback({ request: post(good({ image: { type: 'image/png', data: PNG }, map: { type: 'image/webp', data: WEBP } })), env: e }, deps());
    const { id } = (await res.json()) as { id: string };
    expect([...bucket.objects.keys()].sort()).toEqual([`feedback/${id}/image.png`, `feedback/${id}/map.webp`]);
    expect(bucket.objects.get(`feedback/${id}/image.png`)?.type).toBe('image/png');
    expect(db.rows('feedback')[0]).toMatchObject({ image_key: `feedback/${id}/image.png`, image_type: 'image/png', image_bytes: 12, map_key: `feedback/${id}/map.webp`, image_note: null });
    expect(e.EMAIL.sent[0].text).toContain(`R2 key feedback/${id}/image.png`);

    const db2 = new MemD1();
    const e2 = env(db2);
    const res2 = await handleFeedback({ request: post(good({ image: { type: 'image/png', data: PNG } })), env: e2 }, deps());
    expect(res2.status).toBe(200);
    expect(db2.rows('feedback')[0]).toMatchObject({ image_key: null, image_type: 'image/png', image_bytes: 12, image_note: 'image not stored: no R2 bucket bound here' });
    expect(e2.EMAIL.sent[0].text).toContain('Image: not stored (no R2 bucket bound here)');
  });

  it('refuses what does not check out, in plain words', async () => {
    const db = new MemD1();
    const e = env(db);
    const cases: [unknown, number, string][] = [
      [good({ type: 'rant' }), 400, 'bad_type'],
      [good({ message: '   ' }), 400, 'no_message'],
      [good({ message: 'x'.repeat(4_001) }), 400, 'too_long'],
      [good({ email: 'not an email' }), 400, 'bad_email'],
      [good({ context: ['a'] }), 400, 'bad_context'],
      [good({ context: { blob: 'x'.repeat(33_000) } }), 413, 'context_too_big'],
      [good({ image: { type: 'image/gif', data: PNG } }), 400, 'bad_image'],
      [good({ image: { type: 'image/jpeg', data: PNG } }), 400, 'bad_image'],
      [good({ image: { type: 'image/png', data: '!!not base64!!' } }), 400, 'bad_image'],
      [good({ image: { type: 'image/png', data: 'A'.repeat(3_400_000) } }), 400, 'bad_image'],
    ];
    for (const [body, status, error] of cases) {
      const res = await handleFeedback({ request: post(body), env: e }, deps());
      const out = (await res.json()) as { error: string; message: string };
      expect([res.status, out.error], error).toEqual([status, error]);
      expect(out.message.length, error).toBeGreaterThan(5);
    }
    expect((await handleFeedback({ request: post(null, { raw: '{nope' }), env: e }, deps())).status).toBe(400);
    expect((await handleFeedback({ request: post(null, { raw: 'x'.repeat(BODY_MAX_BYTES + 1) }), env: e }, deps())).status).toBe(413);
    expect((await handleFeedback({ request: post(good(), { origin: 'https://evil.example' }), env: e }, deps())).status).toBe(403);
    expect(db.rows('feedback')).toEqual([]);
    expect(e.EMAIL.sent).toEqual([]);
  });

  it('is limited to 10 an hour per IP, and per signed-in user', async () => {
    const db = new MemD1();
    const e = env(db, { FEEDBACK_TO: '' });
    for (let i = 0; i < 10; i++) expect((await handleFeedback({ request: post(good()), env: e }, deps())).status).toBe(200);
    const over = await handleFeedback({ request: post(good()), env: e }, deps());
    expect(over.status).toBe(429);
    expect(((await over.json()) as { message: string }).message).toMatch(/later/);
    // Another IP is fine; the next hour too.
    expect((await handleFeedback({ request: post(good(), { ip: '198.51.100.1' }), env: e }, deps())).status).toBe(200);
    expect((await handleFeedback({ request: post(good()), env: e }, deps({ now: () => NOW + 3_600_000 }))).status).toBe(200);
    const keys = db.rows('auth_rate_limits').map((r) => String(r.key));
    expect(keys.every((k) => /^feedback-ip:[0-9a-f]{64}$/.test(k))).toBe(true);

    const { cookie, user } = await signIn(db, 'busy@example.com');
    for (let i = 0; i < 10; i++) expect((await handleFeedback({ request: post(good(), { cookie, ip: `192.0.2.${i}` }), env: e }, deps())).status).toBe(200);
    expect((await handleFeedback({ request: post(good(), { cookie, ip: '192.0.2.200' }), env: e }, deps())).status).toBe(429);
    expect(db.rows('auth_rate_limits').some((r) => r.key === `feedback-user:${user.id}`)).toBe(true);
  });

  it('needs Turnstile when the site has both keys', async () => {
    const db = new MemD1();
    const e = env(db, { TURNSTILE_SITE_KEY: 'turnstile_site_test_fake', TURNSTILE_SECRET_KEY: 'turnstile_secret_test_fake', FEEDBACK_TO: '' });
    const f = withTurnstile();
    expect((await handleFeedback({ request: post(good()), env: e }, deps({ fetch: f }))).status).toBe(400);
    expect((await handleFeedback({ request: post(good({ turnstileToken: 'wrong' })), env: e }, deps({ fetch: f }))).status).toBe(400);
    expect(db.rows('feedback')).toEqual([]);
    expect((await handleFeedback({ request: post(good({ turnstileToken: TURNSTILE_TOKEN })), env: e }, deps({ fetch: f }))).status).toBe(200);
    expect(f.calls.map((c) => c.get('response'))).toEqual(['wrong', TURNSTILE_TOKEN]);
    const down = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect((await handleFeedback({ request: post(good({ turnstileToken: TURNSTILE_TOKEN })), env: e }, deps({ fetch: down }))).status).toBe(503);
  });

  it('answers 503 in plain words without AUTH_DB, paywall on or off', async () => {
    for (const PAYWALL_ENABLED of ['true', undefined]) {
      const res = await handleFeedback({ request: post(good()), env: env(undefined, { PAYWALL_ENABLED }) }, deps());
      expect(res.status).toBe(503);
      expect(((await res.json()) as { message: string }).message).toMatch(/isn't set up/);
    }
  });
});

describe('GET /api/feedback and the route', () => {
  it('says whether the sheet can send, who is asking and the Turnstile site key', async () => {
    const db = new MemD1();
    const get = (cookie?: string) => new Request(`${ORIGIN}/api/feedback`, { headers: cookie ? { cookie } : {} });
    expect(await (await handleFeedbackInfo({ request: get(), env: env(db) }, deps())).json()).toEqual({ ok: true, ready: true, signedIn: false, turnstileSiteKey: null });
    const { cookie } = await signIn(db, 'member@example.com');
    const keys = { TURNSTILE_SITE_KEY: 'turnstile_site_test_fake', TURNSTILE_SECRET_KEY: 'turnstile_secret_test_fake' };
    expect(await (await handleFeedbackInfo({ request: get(cookie), env: env(db, keys) }, deps())).json()).toEqual({ ok: true, ready: true, signedIn: true, turnstileSiteKey: 'turnstile_site_test_fake' });
    expect(await (await handleFeedbackInfo({ request: get(), env: env(undefined) }, deps())).json()).toMatchObject({ ready: false });
  });

  it('serves GET and POST only', async () => {
    const db = new MemD1();
    const ctx = (request: Request) => ({ request, env: env(db, { FEEDBACK_TO: '' }), waitUntil: () => undefined });
    expect((await onRequestGet(ctx(new Request(`${ORIGIN}/api/feedback`)))).status).toBe(200);
    expect((await onRequestPost(ctx(post(good())))).status).toBe(200);
    const res = onRequest();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');
  });
});

describe('feedback helpers', () => {
  it('parses FEEDBACK_TO as a comma list: trimmed, lower-cased, checked, distinct', () => {
    expect(feedbackRecipients(undefined)).toEqual([]);
    expect(feedbackRecipients('')).toEqual([]);
    expect(feedbackRecipients(' A@Example.com ,bad,, b@example.com, a@example.com,c@ example.com ')).toEqual(['a@example.com', 'b@example.com']);
  });

  it('salts the IP hash with AUTH_SECRET when there is one', async () => {
    const plain = await ipHash('203.0.113.7', undefined);
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
    expect(await ipHash('203.0.113.7', 'auth_secret_test_fake')).not.toBe(plain);
    expect(await ipHash('203.0.113.7', 'auth_secret_test_fake')).toBe(await ipHash('203.0.113.7', 'auth_secret_test_fake'));
  });

  it('ignores a page-sent identity and keeps the message as typed (trimmed)', () => {
    const f = parseFeedback({ type: 'idea', message: '  more wind data  ', context: {}, userId: 'u1' });
    expect(f).toMatchObject({ type: 'idea', message: 'more wind data', email: null, image: null, map: null });
    expect(f).not.toHaveProperty('userId');
  });
});
