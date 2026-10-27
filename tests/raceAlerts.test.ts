/**
 * Race emails (README "Race emails"): the /api/alerts routes, the unsubscribe token and page, the posted-race
 * rule, and the recall-race-alerts Worker's runs (baseline, de-dup, late subscribers, window, bounds, the email).
 * D1 is the in-memory engine (tests/d1mem.ts) with every migration; RaceSense and the mailer are faked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SUBS, POSTED_AFTER_GUN_MS, handleAlerts, handleUnsubscribe, postedRaces, readUnsub, signUnsub, UNSUB_PURPOSE } from '../functions/_alerts';
import { b64url, hmac, signBuy } from '../functions/_auth';
import type { EmailBindingLike } from '../functions/_paywall';
import type { Race, RegattaDoc, RegattaResponse } from '../src/data/racesense/types';
import { raceMail, runRaceAlerts, venueTime, type AlertsWorkerEnv, type RunDeps } from '../workers/race-alerts/src/run';
import worker from '../workers/race-alerts/src/index';
import type { Me } from '../src/data/paywall';
import { showUpcoming, upcomingCardsHtml } from '../src/landing/landing';
import { eventCardHtml, eventCardView } from '../src/ui/eventCard';
import { createAlerts } from '../src/ui/notify';
import { raceAlertsHtml, sheetHtml } from '../src/ui/paywall';
import { MemD1 } from './d1mem';
import { ORIGIN, paywallEnv, resetPaywallCaches, signIn } from './paywallHelpers';

const EV = 'Qn47enc7fKR7Th1Qj1ZI';
const TITLE = '2026 J/70 North Americans';
const at = (iso: string): number => Date.parse(iso);
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
const R4 = race(4, '2026-10-28T18:00:00Z');

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

beforeEach(() => {
  resetPaywallCaches();
  db = new MemD1();
  docs = new Map([[EV, docOf([R1, R2])]]);
  up = upstream(docs);
  mails = [];
  const binding: EmailBindingLike = { send: async (m) => void mails.push(m as Sent) };
  env = { ...paywallEnv(db), EMAIL: binding };
});

const req = (method: string, o: { cookie?: string; body?: unknown; origin?: string | null; path?: string } = {}): Request =>
  new Request(`${ORIGIN}${o.path ?? '/api/alerts'}`, {
    method,
    headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), 'content-type': 'application/json' },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });

const api = (r: Request, now: number, e: AlertsWorkerEnv = env): Promise<Response> => handleAlerts({ request: r, env: e }, { now: () => now, fetch: up, cache: null });
const subscribe = async (cookie: string, now: number, eventId = EV): Promise<Response> => api(req('POST', { cookie, body: { eventId } }), now);
const run = (now: number, deps: RunDeps = {}): ReturnType<typeof runRaceAlerts> => runRaceAlerts(env, { now: () => now, fetch: up, cache: null, ...deps });

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

  it('subscribes (idempotently), lists with title and dates, baselines the races already posted, and unsubscribes', async () => {
    const { cookie, user } = await signIn(db, 'a@example.com');
    const now = at('2026-10-28T17:00:00Z');
    const r = await subscribe(cookie, now);
    expect(r.status).toBe(200);
    const want = [{ eventId: EV, title: TITLE, startMs: at('2026-10-28T00:00:00Z'), endMs: at('2026-11-01T00:00:00Z'), createdAt: now }];
    expect(await r.json()).toEqual({ ok: true, alerts: want });
    expect((await subscribe(cookie, now + 1000)).status).toBe(200);
    expect(db.rows('race_alert_subs')).toEqual([{ user_id: user.id, event_id: EV, created_at: now }]);
    expect(db.rows('race_alert_seen').map((x) => x.race_key)).toEqual(['J70|1', 'J70|2']);
    expect(db.rows('race_alert_events')[0]).toMatchObject({ baselined_at: now });
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
});

describe('the unsubscribe token', () => {
  const SECRET = 'auth_secret_test_fake';

  it('round-trips the user and event', async () => {
    const t = await signUnsub(SECRET, 'user-1', EV);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(await readUnsub(SECRET, t)).toEqual({ userId: 'user-1', eventId: EV });
  });

  it('refuses a tampered payload or signature, another secret, another purpose, and junk', async () => {
    const t = await signUnsub(SECRET, 'user-1', EV);
    const [p, s] = t.split('.');
    const other = b64url(new TextEncoder().encode(JSON.stringify({ p: UNSUB_PURPOSE, u: 'user-2', e: EV })));
    expect(await readUnsub(SECRET, `${other}.${s}`)).toBeNull();
    expect(await readUnsub(SECRET, `${p}.${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(await readUnsub('another_secret', t)).toBeNull();
    expect(await readUnsub(undefined, t)).toBeNull();
    // Signed with this purpose's prefix but naming another purpose; and another kind of signed value.
    const wrong = b64url(new TextEncoder().encode(JSON.stringify({ p: 'recall-buy', u: 'user-1', e: EV })));
    expect(await readUnsub(SECRET, `${wrong}.${await hmac(SECRET, `${UNSUB_PURPOSE}:${wrong}`)}`)).toBeNull();
    expect(await readUnsub(SECRET, await signBuy(SECRET, { product: 'regatta', eventId: EV, userId: 'user-1', exp: Date.now() + 60_000 }))).toBeNull();
    for (const junk of ['', '.', 'a.b.c', `${t}.x`, 42, null, 'x'.repeat(700)]) expect(await readUnsub(SECRET, junk)).toBeNull();
  });

  it('GET shows a page with a button and changes nothing; POST (the button, or a one-click POST) unsubscribes', async () => {
    const { cookie, user } = await signIn(db, 'a@example.com');
    await subscribe(cookie, at('2026-10-28T17:00:00Z'));
    const t = await signUnsub(env.AUTH_SECRET!, user.id, EV);
    const url = `${ORIGIN}/api/alerts/unsubscribe?t=${encodeURIComponent(t)}`;
    const g = await handleUnsubscribe({ request: new Request(url), env });
    expect(g.status).toBe(200);
    expect(g.headers.get('content-security-policy')).toContain("form-action 'self'");
    const html = await g.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain(TITLE);
    expect(db.rows('race_alert_subs')).toHaveLength(1);
    const p = await handleUnsubscribe({ request: new Request(url, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), env: { ...env, PAYWALL_ENABLED: 'false' } });
    expect(p.status).toBe(200);
    expect(await p.text()).toContain('Race emails are off');
    expect(db.rows('race_alert_subs')).toEqual([]);
  });

  it('a bad token is a 400 page, and the title is escaped', async () => {
    const bad = await handleUnsubscribe({ request: new Request(`${ORIGIN}/api/alerts/unsubscribe?t=nope`, { method: 'POST' }), env });
    expect(bad.status).toBe(400);
    await db.prepare('INSERT INTO race_alert_events (event_id, title, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?)').bind(EV, '<b>"Fleet" & co</b>', 1, 2, 3).run();
    const t = await signUnsub(env.AUTH_SECRET!, 'user-1', EV);
    const html = await (await handleUnsubscribe({ request: new Request(`${ORIGIN}/api/alerts/unsubscribe?t=${t}`), env })).text();
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

  it('mails each subscriber once per race posted after they subscribed; a second run sends nothing', async () => {
    const a = await signIn(db, 'a@example.com');
    await subscribe(a.cookie, at('2026-10-28T17:00:00Z'));
    // Races 1 and 2 were posted before: nothing.
    expect(await run(at('2026-10-28T17:10:00Z'))).toMatchObject({ events: 1, sent: 0, baselined: 0 });
    docs.set(EV, docOf([R1, R2, R3]));
    expect(await run(at('2026-10-28T18:00:00Z'))).toMatchObject({ sent: 1, failed: 0 });
    expect(mails.map((m) => [m.to, m.subject])).toEqual([['a@example.com', `Race 3 is up: ${TITLE}`]]);
    expect(await run(at('2026-10-28T18:10:00Z'))).toMatchObject({ sent: 0 });
    expect(mails).toHaveLength(1);
    expect(db.rows('race_alert_sent')).toEqual([{ user_id: a.user.id, event_id: EV, race_key: 'J70|3', sent_at: at('2026-10-28T18:00:00Z'), status: 'sent', error: null }]);

    // B subscribes after race 3 was seen: not race 3; both get race 4.
    const b = await signIn(db, 'b@example.com');
    await subscribe(b.cookie, at('2026-10-28T18:20:00Z'));
    expect(await run(at('2026-10-28T18:30:00Z'))).toMatchObject({ sent: 0 });
    docs.set(EV, docOf([R1, R2, R3, R4]));
    expect(await run(at('2026-10-28T19:30:00Z'))).toMatchObject({ sent: 2 });
    expect(mails.slice(1).map((m) => [m.to, m.subject]).sort()).toEqual([
      ['a@example.com', `Race 4 is up: ${TITLE}`],
      ['b@example.com', `Race 4 is up: ${TITLE}`],
    ]);
  });

  it('baselines an event it has never baselined before mailing anything', async () => {
    const a = await signIn(db, 'a@example.com');
    const t0 = at('2026-10-28T17:00:00Z');
    // As if subscribed while RaceSense was down and the event was known without a baseline.
    await db.prepare('INSERT INTO race_alert_events (event_id, title, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?)').bind(EV, TITLE, at('2026-10-28T00:00:00Z'), at('2026-11-01T00:00:00Z'), t0).run();
    await db.prepare('INSERT INTO race_alert_subs (user_id, event_id, created_at) VALUES (?, ?, ?)').bind(a.user.id, EV, t0 - 3_600_000).run();
    expect(await run(t0)).toMatchObject({ baselined: 1, sent: 0 });
    expect(db.rows('race_alert_seen').map((x) => x.race_key)).toEqual(['J70|1', 'J70|2']);
    docs.set(EV, docOf([R1, R2, R3]));
    expect(await run(t0 + 3_600_000)).toMatchObject({ sent: 1 });
    expect(mails[0].subject).toBe(`Race 3 is up: ${TITLE}`);
  });

  it('a crash between claiming and sending never resends; a failed send is recorded and not retried', async () => {
    const a = await signIn(db, 'a@example.com');
    const b = await signIn(db, 'b@example.com');
    await subscribe(a.cookie, at('2026-10-28T17:00:00Z'));
    await subscribe(b.cookie, at('2026-10-28T17:00:00Z'));
    docs.set(EV, docOf([R1, R2, R3]));
    // A's email was claimed by an earlier run that died before sending.
    await db.prepare("INSERT INTO race_alert_sent (user_id, event_id, race_key, sent_at, status) VALUES (?, ?, ?, ?, 'pending')").bind(a.user.id, EV, 'J70|3', at('2026-10-28T17:55:00Z')).run();
    env.EMAIL = { send: async () => Promise.reject(new Error('mailer down')) };
    expect(await run(at('2026-10-28T18:00:00Z'))).toMatchObject({ sent: 0, failed: 1 });
    expect(db.rows('race_alert_sent').find((r) => r.user_id === b.user.id)).toMatchObject({ status: 'failed' });
    env.EMAIL = { send: async (m) => void mails.push(m as Sent) };
    expect(await run(at('2026-10-28T18:10:00Z'))).toMatchObject({ sent: 0, failed: 0 });
    expect(mails).toEqual([]);
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
    const t0 = at('2026-10-28T17:00:00Z');
    const users = [];
    for (const e of ['a', 'b', 'c']) users.push(await signIn(db, `${e}@example.com`));
    for (const u of users) await subscribe(u.cookie, t0);
    docs.set(EV, docOf([R1, R2, R3]));
    expect(await run(at('2026-10-28T18:00:00Z'), { bounds: { emails: 2 } })).toMatchObject({ sent: 2, stopped: 'emails' });
    expect(await run(at('2026-10-28T18:10:00Z'), { bounds: { emails: 2 } })).toMatchObject({ sent: 1 });
    expect(new Set(mails.map((m) => m.to)).size).toBe(3);

    docs.set('second-event', docOf([R1]));
    await subscribe(users[0].cookie, t0, 'second-event');
    up.calls.length = 0;
    expect(await run(at('2026-10-28T18:20:00Z'), { bounds: { events: 1 } })).toMatchObject({ events: 1, stopped: 'events' });
    expect(up.calls).toHaveLength(1);
    let tick = 0;
    expect(await run(at('2026-10-28T18:30:00Z'), { bounds: { ms: 5 }, clock: () => (tick += 10) })).toMatchObject({ events: 0, stopped: 'time' });
  });

  it('the scheduled handler runs once; fetch is a 404', async () => {
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: 0, cron: '*/10 * * * *' }, { ...env, PAYWALL_ENABLED: 'off' }, { waitUntil: (p) => void waits.push(p) });
    expect(waits).toHaveLength(1);
    expect(worker.fetch().status).toBe(404);
  });
});

describe('the email', () => {
  const r = { key: 'J70|3', division: 'J70', rsNumber: 3, number: 3, gunMs: at('2026-10-28T15:05:00Z'), tzOffsetMs: EDT };
  const unsub = `${ORIGIN}/api/alerts/unsubscribe?t=abc.def`;

  it('names the race, the gun on the venue clock, links the race and the unsubscribe, and carries List-Unsubscribe', () => {
    const m = raceMail({ to: 'a@example.com', title: TITLE, eventId: EV, race: r, multiDivision: false, origin: ORIGIN, unsubUrl: unsub });
    expect(venueTime(r.gunMs, EDT)).toBe('Wed, Oct 28, 11:05 AM');
    expect(m.subject).toBe(`Race 3 is up: ${TITLE}`);
    expect(m.text).toContain('J70 · Race 3 · Gun Wed, Oct 28, 11:05 AM local time');
    expect(m.text).toContain(`${ORIGIN}/?event=${EV}&div=J70&race=3`);
    expect(m.text).toContain(unsub);
    expect(m.html).toContain(`href="${ORIGIN}/?event=${EV}&amp;div=J70&amp;race=3"`);
    expect(m.html).toContain(`href="${unsub}"`);
    expect(m.headers).toEqual({ 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(raceMail({ to: 'a@example.com', title: TITLE, eventId: EV, race: r, multiDivision: true, origin: ORIGIN, unsubUrl: unsub }).subject).toBe(`Race 3 (J70) is up: ${TITLE}`);
  });

  it('escapes everything in the HTML and encodes the link', () => {
    const odd = { ...r, division: 'J/70 <Gold> & "Silver"' };
    const m = raceMail({ to: 'a@example.com', title: '<script>alert(1)</script> & Co’s "Cup"', eventId: EV, race: odd, multiDivision: false, origin: ORIGIN, unsubUrl: unsub });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co’s &quot;Cup&quot;');
    expect(m.html).toContain('J/70 &lt;Gold&gt; &amp; &quot;Silver&quot;');
    expect(m.text).toContain(`div=J%2F70+%3CGold%3E+%26+%22Silver%22`);
  });

  it('names no one: no sail numbers or boats from the document in what the Worker sends', async () => {
    const a = await signIn(db, 'a@example.com');
    await subscribe(a.cookie, at('2026-10-28T17:00:00Z'));
    docs.set(EV, docOf([R1, R2, R3]));
    await run(at('2026-10-28T18:00:00Z'));
    expect(mails).toHaveLength(1);
    for (const part of [mails[0].subject, mails[0].text, mails[0].html]) expect(part).not.toMatch(/USA \d+/);
    expect(mails[0].text).toContain('/api/alerts/unsubscribe?t=');
    const t = decodeURIComponent(/unsubscribe\?t=(\S+)/.exec(mails[0].text)![1]);
    expect(await readUnsub(env.AUTH_SECRET, t)).toEqual({ userId: a.user.id, eventId: EV });
  });
});

describe('the toggles and the account sheet', () => {
  const OFF: Me = { paywall: false };
  const OUT: Me = { paywall: true, user: null, entitlements: [], signIn: { email: true, google: true } };
  const IN: Me = { paywall: true, user: { email: 'a@example.com' }, entitlements: [], signIn: { email: true, google: true } };
  const now = at('2026-10-27T15:00:00Z');
  const landing = { eventId: EV, title: TITLE, startMs: at('2026-10-28T00:00:00Z'), endMs: at('2026-11-01T00:00:00Z') };
  const alert = { eventId: EV, title: '<i>J/70</i> NAs', startMs: landing.startMs, endMs: landing.endMs, createdAt: now };

  it('the event card shows Emails on ✓ when on; nothing with the paywall off', () => {
    const v = eventCardView(EV, null, landing, now);
    expect(eventCardHtml(v, { me: IN, free: false, notify: { on: true } })).toContain('>Emails on ✓</button>');
    expect(eventCardHtml(v, { me: OUT, free: false, notify: { on: false } })).toContain('>Notify me</button>');
    expect(eventCardHtml(v, { me: OFF, free: false, notify: { on: true } })).not.toContain('data-notify');
  });

  it('the account sheet lists race emails (title, dates, Turn off), escaped; nothing when there are none', () => {
    const html = sheetHtml(IN, { mode: 'account' }, (id) => id, 'system', [alert]);
    expect(html).toContain('<h3 class="account-sub">Race emails</h3>');
    expect(html).toContain('&lt;i&gt;J/70&lt;/i&gt; NAs');
    expect(html).toContain('Oct 28 – Nov 1');
    expect(html).toContain(`data-pw="alert-off" data-id="${EV}"`);
    expect(html.indexOf('Race emails')).toBeLessThan(html.indexOf('Theme'));
    expect(raceAlertsHtml([])).toBe('');
    expect(sheetHtml(IN, { mode: 'account' }, (id) => id)).not.toContain('Race emails');
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
    expect(ul.innerHTML).toContain('>Emails on ✓</button>');
    expect(upcomingCardsHtml([landing], OFF, now, 0, alerts)).not.toContain('data-notify');
  });
});
