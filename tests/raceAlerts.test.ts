/**
 * Race emails (README "Race emails"): the /api/alerts routes and their rate limits, the versioned unsubscribe
 * token and page, the posted-race rule, and the recall-race-alerts Worker's runs (the silent first read and
 * re-reads, one combined email per user, de-dup, retries, late subscribers, window, bounds, the email).
 * D1 is the in-memory engine (tests/d1mem.ts) with every migration; RaceSense and the mailer are faked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SUBS, POSTED_AFTER_GUN_MS, handleAlerts, handleUnsubscribe, postedRaces, readUnsub, signUnsub, UNSUB_PURPOSE, type AlertsDeps } from '../functions/_alerts';
import { b64url, hmac, signBuy } from '../functions/_auth';
import type { EmailBindingLike } from '../functions/_paywall';
import type { Race, RegattaDoc, RegattaResponse } from '../src/data/racesense/types';
import { MAX_ATTEMPTS, combinedMail, mailSubject, runRaceAlerts, venueTime, type AlertsWorkerEnv, type MailEvent, type RunDeps } from '../workers/race-alerts/src/run';
import worker from '../workers/race-alerts/src/index';
import type { Me } from '../src/data/paywall';
import { showUpcoming, upcomingCardsHtml } from '../src/landing/landing';
import { eventCardHtml, eventCardView } from '../src/ui/eventCard';
import { SAVE_FAILED, createAlerts } from '../src/ui/notify';
import { NOTIFICATIONS_EMPTY, notificationsHtml, notificationsView, sheetHtml } from '../src/ui/paywall';
import { MemD1 } from './d1mem';
import { ORIGIN, paywallEnv, resetPaywallCaches, signIn } from './paywallHelpers';

const EV = 'Qn47enc7fKR7Th1Qj1ZI';
const EV2 = 'FallBrawl2026xyz';
const TITLE = '2026 J/70 North Americans';
const TITLE2 = 'Fall Brawl';
const at = (iso: string): number => Date.parse(iso);
const MIN = 60_000;
const EDT = -4 * 3_600_000;

/** A race with a gun, a start line and `fins` finishers an hour after the gun (sail numbers only). */
function race(n: number, gunIso: string, fins = 3, extra: Partial<Race> = {}): Race {
  const gun = at(gunIso);
  return {
    raceNumber: n,
    timezoneOffset: EDT,
    starts: [{ startTime: gun, startLine: { leftEnd: [-76.4, 38.9], rightEnd: [-76.41, 38.9] }, stopReason: fins ? 'finished' : null }],
    finishes: Array.from({ length: fins }, (_, i) => ({ sailNumber: `USA ${100 + i}`, finishingTime: new Date(gun + 3_600_000 + i * 1000).toISOString() })),
    ...extra,
  };
}

const docOf = (races: Race[], o: Partial<RegattaDoc> = {}): RegattaDoc => ({
  name: TITLE,
  startDate: at('2026-10-28T00:00:00Z'),
  endDate: at('2026-11-01T00:00:00Z'),
  divisions: [{ name: 'J70', courses: [], participants: [], races }],
  ...o,
});

const R1 = race(1, '2026-10-28T14:05:00Z');
const R2 = race(2, '2026-10-28T15:05:00Z');
const R3 = race(3, '2026-10-28T16:30:00Z');

/** RaceSense: the current document per event (missing: 404); counts the fetches. */
function upstream(docs: Map<string, RegattaDoc | 'down'>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.searchParams.get('event') ?? '');
    const d = docs.get(url.searchParams.get('event') ?? '');
    if (d === 'down') return new Response('oops', { status: 503 });
    if (!d) return new Response('{}', { status: 404 });
    const body: RegattaResponse = { eventId: url.searchParams.get('event')!, revisions: [{ doc: d }] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

let db: MemD1;
let docs: Map<string, RegattaDoc | 'down'>;
let up: ReturnType<typeof upstream>;
let mails: Sent[];
let env: AlertsWorkerEnv;
const okMailer = (): EmailBindingLike => ({ send: async (m) => void mails.push(m as Sent) });

beforeEach(() => {
  resetPaywallCaches();
  db = new MemD1();
  docs = new Map([[EV, docOf([R1, R2])]]);
  up = upstream(docs);
  mails = [];
  env = { ...paywallEnv(db), EMAIL: okMailer() };
});

const req = (method: string, o: { cookie?: string; body?: unknown; origin?: string | null; path?: string; ip?: string } = {}): Request =>
  new Request(`${ORIGIN}${o.path ?? '/api/alerts'}`, {
    method,
    headers: {
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }),
      ...(o.ip ? { 'cf-connecting-ip': o.ip } : {}),
      'content-type': 'application/json',
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });

const api = (r: Request, now: number, e: AlertsWorkerEnv = env, deps: AlertsDeps = {}): Promise<Response> =>
  handleAlerts({ request: r, env: e }, { now: () => now, fetch: up, cache: null, random: () => 1, ...deps });
const subscribe = async (cookie: string, now: number, eventId = EV): Promise<Response> => api(req('POST', { cookie, body: { eventId } }), now);
const run = (now: number, deps: RunDeps = {}): ReturnType<typeof runRaceAlerts> => runRaceAlerts(env, { now: () => now, fetch: up, cache: null, ...deps });

/** The cron: a run every 10 minutes from `from` to `to` (inclusive); the reports summed. */
async function every(from: number, to: number, deps: RunDeps = {}): Promise<{ sent: number; failed: number; baselined: number; races: number }> {
  const sum = { sent: 0, failed: 0, baselined: 0, races: 0 };
  for (let t = from; t <= to; t += 10 * MIN) {
    const r = await run(t, deps);
    sum.sent += r.sent;
    sum.failed += r.failed;
    sum.baselined += r.baselined;
    sum.races += r.races;
  }
  return sum;
}

/** The unsubscribe tokens in an email's text, read back. */
const tokensIn = async (text: string) =>
  Promise.all([...text.matchAll(/unsubscribe\?t=(\S+)/g)].map(async (m) => readUnsub(env.AUTH_SECRET, decodeURIComponent(m[1]))));

const unsubAt = (url: string, method = 'GET', e: AlertsWorkerEnv = env): Promise<Response> =>
  handleUnsubscribe({ request: new Request(url, method === 'POST' ? { method, body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}), env: e });
const subVersion = (userId: string, eventId = EV): number => db.rows('race_alert_subs').find((r) => r.user_id === userId && r.event_id === eventId)!.created_at as number;

describe('posted races', () => {
  it('counts a race with a finish, or over by its end time or by four hours after the gun; never practice or a race not started', () => {
    const now = at('2026-10-28T17:00:00Z');
    const doc = docOf([
      race(1, '2026-10-28T12:00:00Z', 0, { isPractice: true }),
      race(2, '2026-10-28T12:30:00Z', 0),
      race(3, '2026-10-28T14:05:00Z'),
      race(4, '2026-10-28T15:30:00Z', 0, { endTime: '2026-10-28T16:40:00Z' }),
      race(5, '2026-10-28T16:30:00Z', 0),
      race(6, '2026-10-28T18:00:00Z', 0),
    ]);
    expect(postedRaces(doc, now).map((r) => r.key)).toEqual(['J70|2', 'J70|3', 'J70|4']);
    expect(now - at('2026-10-28T12:30:00Z')).toBeGreaterThanOrEqual(POSTED_AFTER_GUN_MS);
    const r3 = postedRaces(doc, now).find((r) => r.rsNumber === 3)!;
    expect(r3).toMatchObject({ division: 'J70', number: 2, gunMs: at('2026-10-28T14:05:00Z'), tzOffsetMs: EDT });
  });
});

describe('/api/alerts', () => {
  it('is the proxy’s 404 with the paywall off', async () => {
    const r = await api(req('GET'), at('2026-10-28T17:00:00Z'), { ...env, PAYWALL_ENABLED: 'false' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'Unknown endpoint' });
  });

  it('signed out: 401 sign_in_required for the list, subscribe and unsubscribe', async () => {
    const now = at('2026-10-28T17:00:00Z');
    for (const m of ['GET', 'POST', 'DELETE']) {
      const r = await api(req(m, m === 'GET' ? {} : { body: { eventId: EV } }), now);
      expect(r.status).toBe(401);
      expect(((await r.json()) as { error: string }).error).toBe('sign_in_required');
    }
  });

  it('refuses a POST or DELETE without this site’s Origin', async () => {
    const { cookie } = await signIn(db, 'a@example.com');
    const now = at('2026-10-28T17:00:00Z');
    expect((await api(req('POST', { cookie, body: { eventId: EV }, origin: null }), now)).status).toBe(403);
    expect((await api(req('DELETE', { cookie, body: { eventId: EV }, origin: 'https://evil.example' }), now)).status).toBe(403);
    expect(db.rows('race_alert_subs')).toEqual([]);
  });

  it('validates the event id, and 404s an event RaceSense doesn’t have', async () => {
    const { cookie } = await signIn(db, 'a@example.com');
    const now = at('2026-10-28T17:00:00Z');
    for (const eventId of ['', 'x', 'has space', '../../etc', 42, null]) expect((await api(req('POST', { cookie, body: { eventId } }), now)).status).toBe(400);
    expect((await api(req('POST', { cookie, body: 'not json' }), now)).status).toBe(400);
    expect((await subscribe(cookie, now, 'NoSuchEvent123')).status).toBe(404);
    expect(db.rows('race_alert_subs')).toEqual([]);
  });

  it('subscribes (idempotently), lists with title and dates, records the races already posted, and unsubscribes', async () => {
    const { cookie, user } = await signIn(db, 'a@example.com');
    const now = at('2026-10-28T17:00:00Z');
    const r = await subscribe(cookie, now);
    expect(r.status).toBe(200);
    const want = [{ eventId: EV, title: TITLE, startMs: at('2026-10-28T00:00:00Z'), endMs: at('2026-11-01T00:00:00Z'), createdAt: now }];
    expect(await r.json()).toEqual({ ok: true, alerts: want });
    expect((await subscribe(cookie, now + 1000)).status).toBe(200);
    expect(db.rows('race_alert_subs')).toEqual([{ user_id: user.id, event_id: EV, created_at: now }]);
    expect(db.rows('race_alert_seen').map((x) => x.race_key)).toEqual(['J70|1', 'J70|2']);
    // The Worker's own first read is the baseline; the page's doesn't count as one.
    expect(db.rows('race_alert_events')[0]).toMatchObject({ baselined_at: null, synced_at: null });
    expect(await (await api(req('GET', { cookie }), now)).json()).toEqual({ alerts: want });
    const d = await api(req('DELETE', { cookie, body: { eventId: EV } }), now);
    expect(await d.json()).toEqual({ ok: true, alerts: [] });
    expect(db.rows('race_alert_subs')).toEqual([]);
  });

  it(`caps a user at ${MAX_SUBS} events`, async () => {
    const { cookie, user } = await signIn(db, 'a@example.com');
    const now = at('2026-10-28T17:00:00Z');
    for (let i = 0; i < MAX_SUBS; i++) await db.prepare('INSERT INTO race_alert_subs (user_id, event_id, created_at) VALUES (?, ?, ?)').bind(user.id, `event-${String(i).padStart(3, '0')}`, now).run();
    const r = await subscribe(cookie, now);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('too_many');
    expect(up.calls).toEqual([]);
  });

  it('refuses an event that is over', async () => {
    const { cookie } = await signIn(db, 'a@example.com');
    const r = await subscribe(cookie, at('2026-11-04T00:00:00Z'));
    expect(r.status).toBe(409);
    expect(db.rows('race_alert_subs')).toEqual([]);
  });

  it('with RaceSense down: 502 for an unknown event; a known one subscribes', async () => {
    const a = await signIn(db, 'a@example.com');
    const b = await signIn(db, 'b@example.com');
    const now = at('2026-10-28T17:00:00Z');
    docs.set(EV, 'down');
    expect((await subscribe(a.cookie, now)).status).toBe(502);
    docs.set(EV, docOf([R1]));
    expect((await subscribe(a.cookie, now)).status).toBe(200);
    docs.set(EV, 'down');
    expect((await subscribe(b.cookie, now + 60_000)).status).toBe(200);
  });

  it('limits changes per user per hour: the next is a 429 with plain words; reading the list doesn’t count; a new hour starts over', async () => {
    const { cookie } = await signIn(db, 'a@example.com');
    const now = at('2026-10-28T17:00:00Z');
    const lim = { alertLimits: { user: 3, ip: 100 } };
    const change = (m: string, t = now) => api(req(m, { cookie, body: { eventId: EV }, ip: '203.0.113.9' }), t, env, lim);
    expect((await change('POST')).status).toBe(200);
    expect((await change('DELETE')).status).toBe(200);
    expect((await api(req('GET', { cookie }), now, env, lim)).status).toBe(200);
    expect((await change('POST')).status).toBe(200);
    const r = await change('DELETE');
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited', message: "That's a lot of changes in one hour. Try again later." });
    expect(db.rows('race_alert_subs')).toHaveLength(1);
    expect((await change('DELETE', now + 3_600_000)).status).toBe(200);
    expect(db.rows('auth_rate_limits').map((r) => String(r.key)).sort()).toEqual([expect.stringMatching(/^alerts-ip:[0-9a-f]{64}$/), expect.stringMatching(/^alerts-user:/)]);
  });

  it('limits changes per IP across users', async () => {
    const a = await signIn(db, 'a@example.com');
    const b = await signIn(db, 'b@example.com');
    const now = at('2026-10-28T17:00:00Z');
    const lim = { alertLimits: { user: 100, ip: 2 } };
    const change = (cookie: string, ip: string) => api(req('POST', { cookie, body: { eventId: EV }, ip }), now, env, lim);
    expect((await change(a.cookie, '203.0.113.9')).status).toBe(200);
    expect((await change(b.cookie, '203.0.113.9')).status).toBe(200);
    expect((await change(b.cookie, '203.0.113.9')).status).toBe(429);
    expect((await change(b.cookie, '198.51.100.7')).status).toBe(200);
  });

  it('has default limits of 30 an hour per user and 60 per IP', async () => {
    const { cookie } = await signIn(db, 'a@example.com');
    const now = at('2026-10-28T17:00:00Z');
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await api(req(i % 2 ? 'DELETE' : 'POST', { cookie, body: { eventId: EV } }), now)).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe('the unsubscribe token', () => {
  const SECRET = 'auth_secret_test_fake';
  const one = [{ eventId: EV, version: 1_793_200_000_000 }];

  it('round-trips the user and each event with its subscription’s version', async () => {
    const t = await signUnsub(SECRET, 'user-1', one);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(await readUnsub(SECRET, t)).toEqual({ userId: 'user-1', subs: one });
    const two = [...one, { eventId: EV2, version: 5 }];
    expect(await readUnsub(SECRET, await signUnsub(SECRET, 'user-1', two))).toEqual({ userId: 'user-1', subs: two });
  });

  it('refuses a tampered payload, version or signature, another secret, another purpose, and junk', async () => {
    const t = await signUnsub(SECRET, 'user-1', one);
    const [p, s] = t.split('.');
    const enc = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));
    expect(await readUnsub(SECRET, `${enc({ p: UNSUB_PURPOSE, u: 'user-2', s: [[EV, one[0].version]] })}.${s}`)).toBeNull();
    expect(await readUnsub(SECRET, `${enc({ p: UNSUB_PURPOSE, u: 'user-1', s: [[EV, one[0].version + 1]] })}.${s}`)).toBeNull();
    expect(await readUnsub(SECRET, `${p}.${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(await readUnsub('another_secret', t)).toBeNull();
    expect(await readUnsub(undefined, t)).toBeNull();
    // Signed with this purpose's prefix but naming another purpose, or with a bad list; and another kind of signed value.
    for (const o of [{ p: 'recall-buy', u: 'user-1', s: [[EV, 1]] }, { p: UNSUB_PURPOSE, u: 'user-1', s: [] }, { p: UNSUB_PURPOSE, u: 'user-1', s: [[EV, 'x']] }, { p: UNSUB_PURPOSE, u: 'user-1', e: EV }]) {
      const w = enc(o);
      expect(await readUnsub(SECRET, `${w}.${await hmac(SECRET, `${UNSUB_PURPOSE}:${w}`)}`)).toBeNull();
    }
    expect(await readUnsub(SECRET, await signBuy(SECRET, { product: 'regatta', eventId: EV, userId: 'user-1', exp: Date.now() + 60_000 }))).toBeNull();
    for (const junk of ['', '.', 'a.b.c', `${t}.x`, 42, null, 'x'.repeat(2000)]) expect(await readUnsub(SECRET, junk)).toBeNull();
  });

  it('GET shows a page with a button and changes nothing; POST (the button, or a one-click POST) unsubscribes', async () => {
    const { cookie, user } = await signIn(db, 'a@example.com');
    await subscribe(cookie, at('2026-10-28T17:00:00Z'));
    const t = await signUnsub(env.AUTH_SECRET!, user.id, [{ eventId: EV, version: subVersion(user.id) }]);
    const url = `${ORIGIN}/api/alerts/unsubscribe?t=${encodeURIComponent(t)}`;
    const g = await unsubAt(url);
    expect(g.status).toBe(200);
    expect(g.headers.get('content-security-policy')).toContain("form-action 'self'");
    const html = await g.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain(TITLE);
    expect(db.rows('race_alert_subs')).toHaveLength(1);
    const p = await unsubAt(url, 'POST', { ...env, PAYWALL_ENABLED: 'false' });
    expect(p.status).toBe(200);
    expect(await p.text()).toContain('Race emails are off');
    expect(db.rows('race_alert_subs')).toEqual([]);
    // Again: already off, nothing to do.
    const again = await (await unsubAt(url, 'POST')).text();
    expect(again).toContain('Race emails are already off');
    expect(again).not.toContain('<form');
  });

  it('an old email’s link can’t turn off emails turned back on since; the new one’s can', async () => {
    const { cookie, user } = await signIn(db, 'a@example.com');
    const t0 = at('2026-10-28T17:00:00Z');
    await subscribe(cookie, t0);
    const oldUrl = `${ORIGIN}/api/alerts/unsubscribe?t=${encodeURIComponent(await signUnsub(env.AUTH_SECRET!, user.id, [{ eventId: EV, version: t0 }]))}`;
    await unsubAt(oldUrl, 'POST');
    expect(db.rows('race_alert_subs')).toEqual([]);
    await subscribe(cookie, t0 + 3_600_000);
    for (const m of ['GET', 'POST']) {
      const r = await unsubAt(oldUrl, m);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('Race emails are still on');
      expect(html).toContain('This link is from an older email.');
      expect(html).not.toContain('<form');
    }
    expect(db.rows('race_alert_subs')).toEqual([{ user_id: user.id, event_id: EV, created_at: t0 + 3_600_000 }]);
    const newUrl = `${ORIGIN}/api/alerts/unsubscribe?t=${encodeURIComponent(await signUnsub(env.AUTH_SECRET!, user.id, [{ eventId: EV, version: t0 + 3_600_000 }]))}`;
    expect(await (await unsubAt(newUrl, 'POST')).text()).toContain('Race emails are off');
    expect(db.rows('race_alert_subs')).toEqual([]);
  });

  it('a bad token is a 400 page, and the title is escaped', async () => {
    const bad = await handleUnsubscribe({ request: new Request(`${ORIGIN}/api/alerts/unsubscribe?t=nope`, { method: 'POST' }), env });
    expect(bad.status).toBe(400);
    await db.prepare('INSERT INTO race_alert_events (event_id, title, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?)').bind(EV, '<b>"Fleet" & co</b>', 1, 2, 3).run();
    const t = await signUnsub(env.AUTH_SECRET!, 'user-1', [{ eventId: EV, version: 1 }]);
    const html = await (await unsubAt(`${ORIGIN}/api/alerts/unsubscribe?t=${t}`)).text();
    expect(html).toContain('&lt;b&gt;&quot;Fleet&quot; &amp; co&lt;/b&gt;');
    expect(html).not.toContain('<b>"Fleet"');
  });
});

describe('the Worker', () => {
  it('does nothing with the paywall off or without D1 / AUTH_SECRET', async () => {
    expect(await runRaceAlerts({ ...env, PAYWALL_ENABLED: 'off' }, { fetch: up })).toMatchObject({ skipped: 'off' });
    expect(await runRaceAlerts({ ...env, AUTH_SECRET: '' }, { fetch: up })).toMatchObject({ skipped: 'not_configured' });
    expect(up.calls).toEqual([]);
  });

  it('mails each subscriber once per race that started and was posted after they subscribed; a second run sends nothing', async () => {
    const a = await signIn(db, 'a@example.com');
    await subscribe(a.cookie, at('2026-10-28T14:30:00Z'));
    // Its first read records race 1 (posted before) and mails nothing; race 2 isn't posted yet.
    expect(await run(at('2026-10-28T14:40:00Z'))).toMatchObject({ events: 1, baselined: 1, sent: 0 });
    expect(await every(at('2026-10-28T14:50:00Z'), at('2026-10-28T15:20:00Z'))).toMatchObject({ sent: 1, failed: 0, baselined: 0 });
    expect(mails.map((m) => [m.to, m.subject])).toEqual([['a@example.com', `Race 2 is up: ${TITLE}`]]);
    expect(db.rows('race_alert_sent')).toEqual([{ user_id: a.user.id, event_id: EV, race_key: 'J70|2', sent_at: at('2026-10-28T15:10:00Z'), status: 'sent', attempts: 1, error: null }]);

    // B subscribes after race 2 was seen: not race 2; both get race 3. C subscribes after race 4's gun: not race 4.
    const b = await signIn(db, 'b@example.com');
    await subscribe(b.cookie, at('2026-10-28T15:25:00Z'));
    docs.set(EV, docOf([R1, R2, R3]));
    expect(await every(at('2026-10-28T15:30:00Z'), at('2026-10-28T16:40:00Z'))).toMatchObject({ sent: 2 });
    expect(mails.slice(1).map((m) => [m.to, m.subject]).sort()).toEqual([
      ['a@example.com', `Race 3 is up: ${TITLE}`],
      ['b@example.com', `Race 3 is up: ${TITLE}`],
    ]);
    const c = await signIn(db, 'c@example.com');
    await subscribe(c.cookie, at('2026-10-28T17:45:00Z'));
    docs.set(EV, docOf([R1, R2, R3, race(4, '2026-10-28T17:30:00Z', 0, { endTime: '2026-10-28T18:15:00Z' })]));
    expect(await every(at('2026-10-28T16:50:00Z'), at('2026-10-28T18:30:00Z'))).toMatchObject({ sent: 2 });
    expect(mails.slice(3).map((m) => m.to).sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('no burst for an early subscriber: races there before the Worker starts watching are recorded silently; the next one is mailed', async () => {
    const a = await signIn(db, 'a@example.com');
    // A week out; nothing posted.
    docs.set(EV, docOf([]));
    await subscribe(a.cookie, at('2026-10-21T12:00:00Z'));
    // Races show up while the event is still outside the Worker's window (it opens a day before the first day).
    docs.set(EV, docOf([race(1, '2026-10-22T15:00:00Z'), race(2, '2026-10-24T15:00:00Z'), race(3, '2026-10-26T15:00:00Z')]));
    up.calls.length = 0;
    expect(await every(at('2026-10-26T22:00:00Z'), at('2026-10-27T02:00:00Z'))).toEqual({ sent: 0, failed: 0, baselined: 1, races: 0 });
    expect(up.calls[0]).toBe(EV);
    expect(db.rows('race_alert_events')[0]).toMatchObject({ baselined_at: at('2026-10-27T00:00:00Z') });
    expect(mails).toEqual([]);
    // Posted after the window opened: mailed, alone.
    docs.set(EV, docOf([race(1, '2026-10-22T15:00:00Z'), race(2, '2026-10-24T15:00:00Z'), race(3, '2026-10-26T15:00:00Z'), race(4, '2026-10-27T14:00:00Z')]));
    expect(await every(at('2026-10-27T02:10:00Z'), at('2026-10-27T14:10:00Z'))).toMatchObject({ sent: 1, races: 1 });
    expect(mails).toHaveLength(1);
    // RaceSense's race 4 (Recall numbers the races before the first day apart, so it shows as Race 1).
    expect(mails[0].text).toContain(`${ORIGIN}/?event=${EV}&div=J70&race=4`);
    expect(mails[0].text).not.toMatch(/race=[123]\b/);
  });

  it('after an outage of over an hour, reads again silently; then mails as before', async () => {
    const a = await signIn(db, 'a@example.com');
    await subscribe(a.cookie, at('2026-10-28T12:00:00Z'));
    await run(at('2026-10-28T12:10:00Z'));
    // No runs from 12:10 to 15:20: races 1 and 2 were posted meanwhile.
    expect(await run(at('2026-10-28T15:20:00Z'))).toMatchObject({ baselined: 1, sent: 0 });
    docs.set(EV, docOf([R1, R2, R3]));
    expect(await every(at('2026-10-28T15:30:00Z'), at('2026-10-28T16:40:00Z'))).toMatchObject({ sent: 1, baselined: 0 });
    expect(mails.map((m) => m.subject)).toEqual([`Race 3 is up: ${TITLE}`]);
  });

  it('one email for two races posted together in one event', async () => {
    const a = await signIn(db, 'a@example.com');
    docs.set(EV, docOf([]));
    await subscribe(a.cookie, at('2026-10-28T13:50:00Z'));
    await run(at('2026-10-28T13:55:00Z'));
    docs.set(EV, docOf([R1, race(2, '2026-10-28T14:30:00Z')]));
    expect(await run(at('2026-10-28T14:50:00Z'))).toMatchObject({ sent: 1, races: 2 });
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe(`Races 1 and 2 are up: ${TITLE}`);
    expect(mails[0].text.indexOf('Race 1 · Gun Wed, Oct 28, 10:05 AM local time')).toBeLessThan(mails[0].text.indexOf('Race 2 · Gun Wed, Oct 28, 10:30 AM local time'));
    expect(db.rows('race_alert_sent').map((r) => [r.race_key, r.status])).toEqual([
      ['J70|1', 'sent'],
      ['J70|2', 'sent'],
    ]);
  });

  it('one email for races in two events, grouped by event, each with its own unsubscribe link; List-Unsubscribe turns off both', async () => {
    const a = await signIn(db, 'a@example.com');
    docs.set(EV, docOf([]));
    docs.set(EV2, docOf([], { name: TITLE2 }));
    await subscribe(a.cookie, at('2026-10-28T13:50:00Z'));
    await subscribe(a.cookie, at('2026-10-28T13:51:00Z'), EV2);
    await run(at('2026-10-28T13:55:00Z'));
    docs.set(EV, docOf([R1, race(2, '2026-10-28T14:30:00Z')]));
    docs.set(EV2, docOf([race(2, '2026-10-28T14:20:00Z')], { name: TITLE2 }));
    expect(await run(at('2026-10-28T14:50:00Z'))).toMatchObject({ sent: 1, races: 3 });
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.subject).toBe(`3 new races: ${TITLE} and 1 more`);
    expect(m.text.startsWith('3 new races are up.\n')).toBe(true);
    expect(m.text.indexOf(TITLE)).toBeLessThan(m.text.indexOf(TITLE2));
    expect(m.text).toContain(`${ORIGIN}/?event=${EV2}&div=J70&race=2`);
    expect(await tokensIn(m.text)).toEqual([
      { userId: a.user.id, subs: [{ eventId: EV, version: at('2026-10-28T13:50:00Z') }] },
      { userId: a.user.id, subs: [{ eventId: EV2, version: at('2026-10-28T13:51:00Z') }] },
    ]);
    const header = m.headers!['List-Unsubscribe'];
    expect(new TextEncoder().encode(header).length).toBeLessThan(2000);
    expect(m.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const listUrl = header.slice(1, -1);
    expect(await tokensIn(listUrl)).toEqual([{ userId: a.user.id, subs: [{ eventId: EV, version: at('2026-10-28T13:50:00Z') }, { eventId: EV2, version: at('2026-10-28T13:51:00Z') }] }]);
    expect(await (await unsubAt(listUrl, 'POST')).text()).toContain(`<strong>${TITLE}</strong> and <strong>${TITLE2}</strong>`);
    expect(db.rows('race_alert_subs')).toEqual([]);
  });

  it('overlapping runs never mail a race twice, and a race claimed by a run that died is never sent', async () => {
    const a = await signIn(db, 'a@example.com');
    const b = await signIn(db, 'b@example.com');
    docs.set(EV, docOf([]));
    await subscribe(a.cookie, at('2026-10-28T13:50:00Z'));
    await subscribe(b.cookie, at('2026-10-28T13:50:00Z'));
    await run(at('2026-10-28T13:55:00Z'));
    docs.set(EV, docOf([R1, race(2, '2026-10-28T14:30:00Z')]));
    // A's race 1 was claimed by an earlier run that died before sending.
    await db.prepare('INSERT INTO race_alert_sent (user_id, event_id, race_key, sent_at, status) VALUES (?, ?, ?, ?, ?)').bind(a.user.id, EV, 'J70|1', at('2026-10-28T14:45:00Z'), 'pending').run();
    const t = at('2026-10-28T14:50:00Z');
    await Promise.all([run(t), run(t), run(t + MIN)]);
    const per = new Map<string, string[]>();
    for (const m of mails) per.set(m.to, [...(per.get(m.to) ?? []), ...[...m.text.matchAll(/^Race (\d+) ·/gm)].map((x) => x[1])]);
    expect([...per.get('a@example.com')!].sort()).toEqual(['2']);
    expect([...per.get('b@example.com')!].sort()).toEqual(['1', '2']);
    await every(at('2026-10-28T15:00:00Z'), at('2026-10-28T15:30:00Z'));
    expect(mails.flatMap((m) => [...m.text.matchAll(/^Race (\d+) ·/gm)])).toHaveLength(3);
    expect(db.rows('race_alert_sent').find((r) => r.user_id === a.user.id && r.race_key === 'J70|1')).toMatchObject({ status: 'pending' });
  });

  it(`a failed send is retried by the next run, up to ${MAX_ATTEMPTS} tries in all`, async () => {
    const a = await signIn(db, 'a@example.com');
    docs.set(EV, docOf([]));
    await subscribe(a.cookie, at('2026-10-28T13:50:00Z'));
    await run(at('2026-10-28T13:55:00Z'));
    docs.set(EV, docOf([R1]));
    let tries = 0;
    env.EMAIL = {
      send: async () => {
        tries++;
        throw new Error('mailer down');
      },
    };
    expect(await run(at('2026-10-28T14:50:00Z'))).toMatchObject({ sent: 0, failed: 1 });
    expect(db.rows('race_alert_sent')).toEqual([expect.objectContaining({ race_key: 'J70|1', status: 'failed', attempts: 1 })]);
    expect(await every(at('2026-10-28T15:00:00Z'), at('2026-10-28T15:40:00Z'))).toMatchObject({ sent: 0, failed: MAX_ATTEMPTS - 1 });
    expect(tries).toBe(MAX_ATTEMPTS);
    expect(db.rows('race_alert_sent')[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    env.EMAIL = okMailer();
    expect(await every(at('2026-10-28T15:50:00Z'), at('2026-10-28T16:10:00Z'))).toMatchObject({ sent: 0, failed: 0 });
    expect(mails).toEqual([]);
  });

  it('a send that fails once goes out on the next run', async () => {
    const a = await signIn(db, 'a@example.com');
    docs.set(EV, docOf([]));
    await subscribe(a.cookie, at('2026-10-28T13:50:00Z'));
    await run(at('2026-10-28T13:55:00Z'));
    docs.set(EV, docOf([R1]));
    env.EMAIL = { send: async () => Promise.reject(new Error('mailer down')) };
    expect(await run(at('2026-10-28T14:50:00Z'))).toMatchObject({ failed: 1 });
    env.EMAIL = okMailer();
    expect(await run(at('2026-10-28T15:00:00Z'))).toMatchObject({ sent: 1, races: 1 });
    expect(mails.map((m) => m.subject)).toEqual([`Race 1 is up: ${TITLE}`]);
    expect(db.rows('race_alert_sent')[0]).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('looks only at events in the window (a day before to two days after), with subscribers', async () => {
    const a = await signIn(db, 'a@example.com');
    const t0 = at('2026-10-28T17:00:00Z');
    const add = (id: string, start: string, end: string) =>
      db.prepare('INSERT INTO race_alert_events (event_id, title, start_ms, end_ms, baselined_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, id, at(start), at(end), t0, t0).run();
    await add('over-event', '2026-10-20T00:00:00Z', '2026-10-25T00:00:00Z');
    await add('later-event', '2026-10-31T00:00:00Z', '2026-11-02T00:00:00Z');
    await add('soon-event', '2026-10-29T12:00:00Z', '2026-10-30T00:00:00Z');
    await add('just-over', '2026-10-24T00:00:00Z', '2026-10-26T18:00:00Z');
    await add('nobody-event', '2026-10-28T00:00:00Z', '2026-10-30T00:00:00Z');
    for (const id of ['over-event', 'later-event', 'soon-event', 'just-over']) await db.prepare('INSERT INTO race_alert_subs (user_id, event_id, created_at) VALUES (?, ?, ?)').bind(a.user.id, id, t0).run();
    await run(t0);
    expect(up.calls.sort()).toEqual(['just-over', 'soon-event']);
  });

  it('keeps to its bounds: emails per run (the rest next run), events per run, and time', async () => {
    const users = [];
    for (const e of ['a', 'b', 'c']) users.push(await signIn(db, `${e}@example.com`));
    docs.set(EV, docOf([]));
    for (const u of users) await subscribe(u.cookie, at('2026-10-28T13:50:00Z'));
    await run(at('2026-10-28T13:55:00Z'));
    docs.set(EV, docOf([R1, race(2, '2026-10-28T14:30:00Z')]));
    // Two races each, one email each: the bound counts emails.
    expect(await run(at('2026-10-28T14:50:00Z'), { bounds: { emails: 2 } })).toMatchObject({ sent: 2, races: 4, stopped: 'emails' });
    expect(await run(at('2026-10-28T15:00:00Z'), { bounds: { emails: 2 } })).toMatchObject({ sent: 1, races: 2 });
    expect(new Set(mails.map((m) => m.to)).size).toBe(3);

    docs.set('second-event', docOf([R1]));
    await subscribe(users[0].cookie, at('2026-10-28T15:05:00Z'), 'second-event');
    up.calls.length = 0;
    expect(await run(at('2026-10-28T15:10:00Z'), { bounds: { events: 1 } })).toMatchObject({ events: 1, stopped: 'events' });
    expect(up.calls).toHaveLength(1);
    let tick = 0;
    expect(await run(at('2026-10-28T15:20:00Z'), { bounds: { ms: 5 }, clock: () => (tick += 10) })).toMatchObject({ events: 0, stopped: 'time' });
  });

  it('the scheduled handler runs once; fetch is a 404', async () => {
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: 0, cron: '*/10 * * * *' }, { ...env, PAYWALL_ENABLED: 'off' }, { waitUntil: (p) => void waits.push(p) });
    expect(waits).toHaveLength(1);
    expect(worker.fetch().status).toBe(404);
  });
});

describe('the email', () => {
  const r = (n: number, gunIso: string, division = 'J70') => ({ key: `${division}|${n}`, division, rsNumber: n, number: n, gunMs: at(gunIso), tzOffsetMs: EDT });
  const unsub = `${ORIGIN}/api/alerts/unsubscribe?t=abc.def`;
  const ev1 = (races: MailEvent['races'], o: Partial<MailEvent> = {}): MailEvent => ({ eventId: EV, title: TITLE, multiDivision: false, races, unsubUrl: unsub, ...o });

  it('one race: names it, the gun on the venue clock, links the race and the unsubscribe, and carries List-Unsubscribe', () => {
    const m = combinedMail({ to: 'a@example.com', origin: ORIGIN, events: [ev1([r(3, '2026-10-28T15:05:00Z')])], listUnsubUrl: unsub });
    expect(venueTime(at('2026-10-28T15:05:00Z'), EDT)).toBe('Wed, Oct 28, 11:05 AM');
    expect(m.subject).toBe(`Race 3 is up: ${TITLE}`);
    expect(m.text).toContain('Race 3 · Gun Wed, Oct 28, 11:05 AM local time');
    expect(m.text).toContain(`${ORIGIN}/?event=${EV}&div=J70&race=3`);
    expect(m.text).toContain(`Turn off emails for this regatta:\n${unsub}`);
    expect(m.html).toContain(`href="${ORIGIN}/?event=${EV}&amp;div=J70&amp;race=3"`);
    expect(m.html).toContain(`href="${unsub}"`);
    expect(m.headers).toEqual({ 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  });

  it('subjects: one race, two, a run, a scatter, several divisions, several events', () => {
    const s = (events: MailEvent[]) => mailSubject(events);
    expect(s([ev1([r(3, '2026-10-28T15:05:00Z')], { multiDivision: true })])).toBe(`Race 3 (J70) is up: ${TITLE}`);
    expect(s([ev1([r(4, '2026-10-28T15:05:00Z'), r(5, '2026-10-28T16:05:00Z')])])).toBe(`Races 4 and 5 are up: ${TITLE}`);
    expect(s([ev1([r(3, '2026-10-28T15:05:00Z'), r(4, '2026-10-28T16:05:00Z'), r(5, '2026-10-28T17:05:00Z')])])).toBe(`Races 3–5 are up: ${TITLE}`);
    expect(s([ev1([r(3, '2026-10-28T15:05:00Z'), r(5, '2026-10-28T16:05:00Z'), r(6, '2026-10-28T17:05:00Z')])])).toBe(`3 new races: ${TITLE}`);
    expect(s([ev1([r(3, '2026-10-28T15:05:00Z', 'Gold'), r(3, '2026-10-28T15:10:00Z', 'Silver')], { multiDivision: true })])).toBe(`2 new races: ${TITLE}`);
    expect(s([ev1([r(3, '2026-10-28T15:05:00Z')]), ev1([r(1, '2026-10-28T15:05:00Z')], { eventId: EV2, title: TITLE2 })])).toBe(`2 new races: ${TITLE} and 1 more`);
  });

  it('several divisions: each race names its division', () => {
    const m = combinedMail({ to: 'a@example.com', origin: ORIGIN, events: [ev1([r(3, '2026-10-28T15:10:00Z', 'Silver'), r(3, '2026-10-28T15:05:00Z', 'Gold')], { multiDivision: true })], listUnsubUrl: unsub });
    expect(m.text.indexOf('Gold · Race 3 · Gun')).toBeLessThan(m.text.indexOf('Silver · Race 3 · Gun'));
  });

  it('leaves List-Unsubscribe out when the link is too long for the header', () => {
    const long = `${ORIGIN}/api/alerts/unsubscribe?t=${'a'.repeat(2000)}`;
    expect(combinedMail({ to: 'a@example.com', origin: ORIGIN, events: [ev1([r(3, '2026-10-28T15:05:00Z')])], listUnsubUrl: long }).headers).toBeUndefined();
  });

  it('escapes everything in the HTML and encodes the link', () => {
    const m = combinedMail({ to: 'a@example.com', origin: ORIGIN, events: [ev1([r(3, '2026-10-28T15:05:00Z', 'J/70 <Gold> & "Silver"')], { title: '<script>alert(1)</script> & Co’s "Cup"', multiDivision: true })], listUnsubUrl: unsub });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co’s &quot;Cup&quot;');
    expect(m.html).toContain('J/70 &lt;Gold&gt; &amp; &quot;Silver&quot;');
    expect(m.text).toContain(`div=J%2F70+%3CGold%3E+%26+%22Silver%22`);
  });

  it('names no one: no sail numbers or boats from the document in what the Worker sends; no dashes in the copy', async () => {
    const a = await signIn(db, 'a@example.com');
    docs.set(EV, docOf([]));
    await subscribe(a.cookie, at('2026-10-28T13:50:00Z'));
    await run(at('2026-10-28T13:55:00Z'));
    docs.set(EV, docOf([R1]));
    await run(at('2026-10-28T14:50:00Z'));
    expect(mails).toHaveLength(1);
    for (const part of [mails[0].subject, mails[0].text, mails[0].html]) expect(part).not.toMatch(/USA \d+/);
    expect(mails[0].text).not.toMatch(/[—!]/);
    expect(await tokensIn(mails[0].text)).toEqual([{ userId: a.user.id, subs: [{ eventId: EV, version: at('2026-10-28T13:50:00Z') }] }]);
    // One event: the header is that event's own link.
    expect(mails[0].headers!['List-Unsubscribe']).toBe(`<${/(https:\S+unsubscribe\?t=\S+)/.exec(mails[0].text)![1]}>`);
  });
});

describe('the toggles and the account sheet', () => {
  const OFF: Me = { paywall: false };
  const OUT: Me = { paywall: true, user: null, entitlements: [], signIn: { email: true, google: true } };
  const IN: Me = { paywall: true, user: { email: 'a@example.com' }, entitlements: [], signIn: { email: true, google: true } };
  const now = at('2026-10-27T15:00:00Z');
  const landing = { eventId: EV, title: TITLE, startMs: at('2026-10-28T00:00:00Z'), endMs: at('2026-11-01T00:00:00Z') };
  const alert = { eventId: EV, title: '<i>J/70</i> NAs', startMs: landing.startMs, endMs: landing.endMs, createdAt: now };

  it('the event card shows the subscribed state with Turn off when on; nothing with the paywall off', () => {
    const v = eventCardView(EV, null, landing, now);
    const on = eventCardHtml(v, { me: IN, free: false, notify: { on: true } });
    expect(on).toContain("You'll get an email when races are posted.");
    expect(on).toContain('>Turn off</button>');
    expect(eventCardHtml(v, { me: OUT, free: false, notify: { on: false } })).toContain('>Notify me</button>');
    expect(eventCardHtml(v, { me: OFF, free: false, notify: { on: true } })).not.toContain('data-notify');
  });

  it('the account sheet’s Notifications: each event (title, dates, Remove), escaped; the empty state; hidden when not available', () => {
    const html = sheetHtml(IN, { mode: 'account' }, (id) => id, 'system', { list: [alert] });
    expect(html).toContain('<h3 class="account-sub">Notifications</h3>');
    expect(html).not.toContain('Race emails</h3>');
    expect(html).toContain('&lt;i&gt;J/70&lt;/i&gt; NAs');
    expect(html).toContain('Oct 28 – Nov 1');
    expect(html).toContain(`data-pw="alert-off" data-id="${EV}" aria-label="Stop race emails for &lt;i&gt;J/70&lt;/i&gt; NAs">Remove</button>`);
    expect(html.indexOf('Notifications')).toBeLessThan(html.indexOf('Theme'));
    const empty = notificationsHtml({ list: [] });
    expect(empty).toBe(`<h3 class="account-sub">Notifications</h3><p class="muted">${NOTIFICATIONS_EMPTY}</p>`);
    expect(NOTIFICATIONS_EMPTY).toBe("You're not getting race emails for any regattas. Use Notify me on an upcoming regatta to get one when races are posted.");
    expect(sheetHtml(IN, { mode: 'account' }, (id) => id)).not.toContain('Notifications');
    expect(notificationsHtml(null)).toBe('');
    for (const part of [html, empty]) for (const w of [/no data/i, /\bgap\b/i, /—/]) expect(part).not.toMatch(w);
  });

  it('Notifications from the store: shown once the list is in, hidden when /api/alerts isn’t there; Remove goes at once and comes back with a note if it fails', async () => {
    let list: unknown[] = [alert];
    let fail = false;
    let open: () => void = () => undefined;
    let gate = Promise.resolve();
    const calls: string[] = [];
    const f = (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
      const m = init.method ?? 'GET';
      calls.push(m);
      if (m === 'GET') return new Response(JSON.stringify({ alerts: list }));
      await gate;
      if (fail) return new Response('{}', { status: 503 });
      list = [];
      return new Response(JSON.stringify({ ok: true, alerts: list }));
    }) as typeof fetch;
    const alerts = createAlerts(f);
    expect(notificationsView(alerts)).toBeNull();
    await alerts.load(IN);
    expect(notificationsHtml(notificationsView(alerts))).toContain('>Remove</button>');
    // Fails: gone at once, then back with the note.
    fail = true;
    gate = new Promise((r) => (open = r));
    const removing = alerts.set(EV, false);
    expect(notificationsHtml(notificationsView(alerts))).toContain(NOTIFICATIONS_EMPTY);
    open();
    expect(await removing).toBe(false);
    const back = notificationsHtml(notificationsView(alerts));
    expect(back).toContain('>Remove</button><span class="notify-note" role="status">Couldn&#39;t save that. Try again.</span>');
    expect(alerts.state(EV).note).toBe(SAVE_FAILED);
    // Works: the DELETE goes out and the empty state stays.
    fail = false;
    gate = Promise.resolve();
    expect(await alerts.set(EV, false)).toBe(true);
    expect(calls).toEqual(['GET', 'DELETE', 'DELETE']);
    expect(notificationsHtml(notificationsView(alerts))).toContain(NOTIFICATIONS_EMPTY);
    // Not available: no section at all.
    const gone = createAlerts((async () => new Response('{"error":"x"}', { status: 404 })) as unknown as typeof fetch);
    await gone.load(IN);
    expect(notificationsHtml(notificationsView(gone))).toBe('');
    expect(sheetHtml(IN, { mode: 'account' }, (id) => id, 'system', notificationsView(gone))).not.toContain('Notifications');
  });

  it('the landing page: signed in, Notify me turns emails on and the card shows it', async () => {
    let list: unknown[] = [];
    const f = (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'POST') list = [alert];
      return new Response(JSON.stringify({ ok: true, alerts: list }));
    }) as typeof fetch;
    const alerts = createAlerts(f);
    const ul = { innerHTML: '' };
    let click: ((ev: unknown) => void) | null = null;
    const section = { hidden: true, querySelector: () => ul, addEventListener: (_: string, fn: (ev: unknown) => void) => (click = fn) };
    const doc = { getElementById: (id: string) => (id === 'land-upcoming' ? section : null) } as unknown as Document;
    await showUpcoming(doc, { landing: async () => ({ events: [landing] }), me: async () => IN, now: () => now, alerts });
    expect(ul.innerHTML).toContain('>Notify me</button>');
    click!({ target: { closest: () => ({ dataset: { notify: EV } }) } });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ul.innerHTML).toContain('>Turn off</button>');
    expect(upcomingCardsHtml([landing], OFF, now, 0, alerts)).not.toContain('data-notify');
  });
});
