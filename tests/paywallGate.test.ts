import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet as proxyGet } from '../functions/api/[[path]]';
import { onRequestGet as vkxDataGet } from '../functions/api/vkx/data';
import { onRequestPost as askPost } from '../functions/api/coach/ask';
import { objectKey } from '../functions/_vkx';
import { PRIVATE_CACHE, askContextIsFree, type PaywallEnv } from '../functions/_paywall';
import { handleBilling } from '../functions/_stripe';
import { handleAuth } from '../functions/_auth';
import { telemetryWindow, currentDoc, listRaces } from '../src/data/racesense/adapter';
import { freeRaces } from '../src/data/freeRace';
import type { AskContext } from '../src/analysis/coach/askContext';
import type { AskIds } from '../src/data/askCoach/protocol';
import { MemBucket } from './r2mem';
import { MemD1 } from './d1mem';
import { EVENT, FakeCache, NOW, ORIGIN, beneluxRegatta, fixture, giveRegatta, giveSeason, mockUpstream, paywallEnv, resetPaywallCaches, signIn, signedWebhook } from './paywallHelpers';

const doc = currentDoc(beneluxRegatta());
const R1 = telemetryWindow(doc, { division: 'J70', raceNumber: 1 });
const R2 = telemetryWindow(doc, { division: 'J70', raceNumber: 2 });

let cache: FakeCache;
let upstream: ReturnType<typeof mockUpstream>;
let pending: Promise<unknown>[];

beforeEach(() => {
  resetPaywallCaches();
  cache = new FakeCache();
  upstream = mockUpstream();
  pending = [];
  vi.stubGlobal('caches', { default: cache });
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

const teleUrl = (w: { after: number; before: number }, division: string | null = 'J70'): string =>
  `${ORIGIN}/api/telemetry/event/${EVENT}?${new URLSearchParams({ after: String(w.after), before: String(w.before), limit: '100000', ...(division ? { division } : {}) })}`;

async function proxy(url: string, env: PaywallEnv | undefined, cookie?: string): Promise<Response> {
  const path = new URL(url).pathname.replace(/^\/api\//, '').split('/');
  const res = await proxyGet({ request: new Request(url, { headers: cookie ? { cookie } : {} }), params: { path }, ...(env ? { env } : {}), waitUntil: (p) => void pending.push(p) });
  await Promise.all(pending);
  return res;
}

const snapshot = async (r: Response): Promise<{ status: number; headers: [string, string][]; body: string }> => ({ status: r.status, headers: [...r.headers], body: await r.text() });
const teleCalls = (): number => upstream.calls.filter((u) => u.includes('teleapi')).length;

describe('flag off: the proxy is unchanged', () => {
  it('serves every race (status, headers, body) exactly as with no paywall at all, and never touches D1', async () => {
    const db = new MemD1();
    for (const env of [{ PAYWALL_ENABLED: 'off', AUTH_DB: db }, { AUTH_DB: db }, { PAYWALL_ENABLED: 'yes' }] as PaywallEnv[]) {
      for (const url of [teleUrl(R2), teleUrl(R1), `${ORIGIN}/api/regatta?event=${EVENT}`]) {
        resetPaywallCaches();
        cache.store.clear();
        const before = await snapshot(await proxy(url, undefined));
        cache.store.clear();
        const after = await snapshot(await proxy(url, env));
        expect(after).toEqual(before);
        expect(after.status).toBe(200);
        expect(after.headers.find(([k]) => k === 'cache-control')?.[1]).toMatch(/^public, max-age=\d+, s-maxage=\d+$/);
      }
    }
    expect(db.log).toEqual([]);
  });
});

describe('flag on: telemetry', () => {
  it('race 1 is free and keeps today’s caching, signed in or not', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const off = await snapshot(await proxy(teleUrl(R1), undefined));
    cache.store.clear();
    const on = await snapshot(await proxy(teleUrl(R1), env));
    expect(on).toEqual(off);
    const { user, cookie } = await signIn(db, 'fan@example.com');
    await giveRegatta(db, user.id);
    const entitled = await proxy(teleUrl(R1), env, cookie);
    expect(entitled.headers.get('cache-control')).toMatch(/^public/);
    expect(entitled.headers.get('vary')).toBeNull();
    // A later page of race 1 (after moves on, before stays) and the mark top-up at the gun are free too.
    expect((await proxy(teleUrl({ after: R1.after + 900_000, before: R1.before }), env)).status).toBe(200);
    expect((await proxy(teleUrl({ after: R1.after + 130_000, before: R1.after + 190_000 }, null), env)).status).toBe(200);
  });

  it('race 2: 401 signed out, 402 signed in without a pass; nothing fetched from teleapi', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const anon = await proxy(teleUrl(R2), env);
    expect(anon.status).toBe(401);
    expect(anon.headers.get('cache-control')).toBe('no-store');
    expect(await anon.json()).toMatchObject({ error: 'sign_in_required', eventId: EVENT, race: null });
    const { cookie } = await signIn(db, 'fan@example.com');
    const paid = await proxy(teleUrl(R2), env, cookie);
    expect(paid.status).toBe(402);
    expect(await paid.json()).toMatchObject({ error: 'payment_required', eventId: EVENT });
    // A window that starts in race 1 but runs into race 2 is not race 1's.
    expect((await proxy(teleUrl({ after: R1.after, before: R2.before }), env, cookie)).status).toBe(402);
    expect(teleCalls()).toBe(0);
  });

  it('entitled: 200 from upstream, sent private with Vary: Cookie; nothing stored under the public cache key', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const a = await signIn(db, 'a@example.com');
    const b = await signIn(db, 'b@example.com');
    const c = await signIn(db, 'c@example.com');
    await giveRegatta(db, a.user.id);
    await giveSeason(db, c.user.id, Date.now() + 86_400_000);

    const first = await proxy(teleUrl(R2), env, a.cookie);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe(PRIVATE_CACHE);
    expect(first.headers.get('vary')).toBe('Cookie');
    const body = await first.text();
    expect(teleCalls()).toBe(1);
    // Nothing paid in the shared cache: no entry under the public URL (only the free regatta document is there).
    expect(cache.store.has(teleUrl(R2))).toBe(false);
    expect([...cache.store.keys()].filter((k) => k.includes('/api/telemetry/'))).toEqual([]);

    expect((await proxy(teleUrl(R2), env, b.cookie)).status).toBe(402);
    expect((await proxy(teleUrl(R2), env)).status).toBe(401);
    const third = await proxy(teleUrl(R2), env, c.cookie);
    expect(third.status).toBe(200);
    expect(third.headers.get('cache-control')).toBe(PRIVATE_CACHE);
    expect(await third.text()).toBe(body);
    // Each entitled request goes upstream; the denied ones never did.
    expect(teleCalls()).toBe(2);
    expect(cache.store.has(teleUrl(R2))).toBe(false);
  });

  it('a gated window already in the edge cache (from before the flip) is never served from it', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    await proxy(teleUrl(R2), undefined);
    expect(cache.store.has(teleUrl(R2))).toBe(true);
    expect((await proxy(teleUrl(R2), env)).status).toBe(401);
    const a = await signIn(db, 'a@example.com');
    expect((await proxy(teleUrl(R2), env, a.cookie)).status).toBe(402);
    await giveRegatta(db, a.user.id);
    const ok = await proxy(teleUrl(R2), env, a.cookie);
    expect(ok.headers.get('cache-control')).toBe(PRIVATE_CACHE);
    expect(teleCalls()).toBe(2);
  });

  it('race 1 still fills and reads the shared cache as today', async () => {
    const env = paywallEnv(new MemD1());
    await proxy(teleUrl(R1), env);
    expect(cache.store.get(teleUrl(R1))?.headers.get('cache-control')).toMatch(/^public, max-age=\d+, s-maxage=\d+$/);
    await proxy(teleUrl(R1), env);
    expect(teleCalls()).toBe(1);
  });

  it('grants, ended subscriptions and sign-outs count from the very next request (nothing cached)', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const { user, cookie } = await signIn(db, 'crew@example.com');
    expect((await proxy(teleUrl(R2), env, cookie)).status).toBe(402);
    // A Season Pass lands through the webhook: allowed at once.
    const checkout = fixture('checkout_season') as { data: { object: Record<string, unknown> } };
    checkout.data.object.client_reference_id = user.id;
    const at = NOW;
    expect((await handleBilling({ request: await signedWebhook(JSON.stringify(checkout)), env, params: { path: ['webhook'] } }, { now: () => at, cache: null })).status).toBe(200);
    expect((await proxy(teleUrl(R2), env, cookie)).status).toBe(200);
    // The subscription is deleted (ended now): refused at once.
    const deleted = fixture('subscription_deleted') as { data: { object: Record<string, unknown> } };
    deleted.data.object.ended_at = Math.floor(NOW / 1000) - 60;
    expect((await handleBilling({ request: await signedWebhook(JSON.stringify(deleted)), env, params: { path: ['webhook'] } }, { now: () => at, cache: null })).status).toBe(200);
    expect((await proxy(teleUrl(R2), env, cookie)).status).toBe(402);
    // Given a regatta pass again, then signed out: 401 at once.
    await giveRegatta(db, user.id);
    expect((await proxy(teleUrl(R2), env, cookie)).status).toBe(200);
    const out = await handleAuth({ request: new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: { origin: ORIGIN, cookie } }), env, params: { path: ['logout'] } });
    expect(out.status).toBe(200);
    expect((await proxy(teleUrl(R2), env, cookie)).status).toBe(401);
  });

  it('an expired season pass or another event’s regatta pass opens nothing', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const a = await signIn(db, 'a@example.com');
    await giveSeason(db, a.user.id, NOW - 1);
    const b = await signIn(db, 'b@example.com');
    await giveRegatta(db, b.user.id, 'someOtherEvent01');
    expect((await proxy(teleUrl(R2), env, a.cookie)).status).toBe(402);
    expect((await proxy(teleUrl(R2), env, b.cookie)).status).toBe(402);
  });

  it('reads the regatta document through the same edge cache entry as /api/regatta', async () => {
    const env = paywallEnv(new MemD1());
    await proxy(`${ORIGIN}/api/regatta?event=${EVENT}`, env);
    const docCalls = (): number => upstream.calls.filter((u) => u.includes('racesense')).length;
    expect(docCalls()).toBe(1);
    await proxy(teleUrl(R2), env);
    await proxy(teleUrl(R1), env);
    expect(docCalls()).toBe(1);
  });

  it('with D1 down: race 1 still free, later races fail closed (503)', async () => {
    const db = new MemD1();
    const { cookie } = await signIn(db, 'a@example.com');
    db.fail = true;
    const env = paywallEnv(db);
    expect((await proxy(teleUrl(R1), env, cookie)).status).toBe(200);
    const res = await proxy(teleUrl(R2), env, cookie);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'auth_unavailable' });
    expect(teleCalls()).toBe(1);
  });

  it('with the document unreachable: only a pass lets data through (else 502)', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    vi.stubGlobal('fetch', (async (u: RequestInfo | URL) => (String(u).includes('racesense') ? new Response('down', { status: 503 }) : upstream(u))) as typeof fetch);
    expect((await proxy(teleUrl(R1), env)).status).toBe(502);
    const a = await signIn(db, 'a@example.com');
    await giveRegatta(db, a.user.id);
    expect((await proxy(teleUrl(R2), env, a.cookie)).status).toBe(200);
  });
});

describe('flag on: boat logs (vkx data)', () => {
  const sha = 'a'.repeat(64);
  async function bucketWith(...races: string[]): Promise<MemBucket> {
    const b = new MemBucket();
    for (const race of races) await b.put(objectKey({ event: EVENT, div: 'J70', race, sn: 4242 }), new Uint8Array([1, 2, 3]), { customMetadata: { sha } });
    return b;
  }
  const get = (race: string, env: PaywallEnv, cookie?: string): Promise<Response> =>
    vkxDataGet({
      request: new Request(`${ORIGIN}/api/vkx/data?${new URLSearchParams({ event: EVENT, div: 'J70', race, sn: '4242', h: sha })}`, { headers: cookie ? { cookie } : {} }),
      env,
      waitUntil: () => undefined,
    });

  it('race 1 free (immutable caching kept); race 2 gated; entitled private', async () => {
    const db = new MemD1();
    const bucket = await bucketWith('1', '2');
    const env = { ...paywallEnv(db), VKX_BUCKET: bucket };
    const r1 = await get('1', env);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await get('2', env)).status).toBe(401);
    const a = await signIn(db, 'a@example.com');
    expect((await get('2', env, a.cookie)).status).toBe(402);
    await giveRegatta(db, a.user.id);
    resetPaywallCaches();
    const ok = await get('2', env, a.cookie);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe(PRIVATE_CACHE);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    // A rebuilt race's key is never race 1.
    expect((await get('202610170805', { ...env })).status).toBe(401);
  });

  it('flag off: race 2 served as today', async () => {
    const bucket = await bucketWith('2');
    const res = await get('2', { VKX_BUCKET: bucket, PAYWALL_ENABLED: '0' } as PaywallEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});

describe('flag on: Ask Coach', () => {
  const SSE = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Good start.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
    .map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`)
    .join('');
  let ip = 0;

  beforeEach(() => {
    vi.stubGlobal('fetch', (async (u: RequestInfo | URL) =>
      String(u).includes('anthropic') ? new Response(SSE, { headers: { 'content-type': 'text/event-stream' } }) : upstream(u)) as typeof fetch);
  });

  const ask = (ids: Record<string, string>, env: PaywallEnv, cookie?: string, context: unknown = raceContext()): Promise<Response> =>
    askPost({
      request: new Request(`${ORIGIN}/api/coach/ask`, {
        method: 'POST',
        body: JSON.stringify({ session: 'abcdefghijklmnop1234', question: 'How was my start?', ids, context }),
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${++ip}`, ...(cookie ? { cookie } : {}) },
      }),
      env: { ...env, ANTHROPIC_API_KEY: 'sk-ant-test-fake' },
      waitUntil: () => undefined,
    });

  // Race 1 and race 2 of the J70s, on the venue clock, as the page's Coach header and cards print them.
  const W1 = freeRaces(doc).windows.find((w) => w.division === 'J70')!;
  const hm = (ms: number): string => new Date(ms + W1.tzOffsetMs).toISOString().slice(11, 16);
  const gun2 = listRaces(doc).find((r) => r.division === 'J70' && r.raceNumber === 2)!.gunMs;
  /** A Race-view context as the page builds it for race 1 (coachAskContext.ts raceAskContext). */
  const raceContext = (over: Record<string, unknown> = {}, race: Record<string, unknown> = {}): Record<string, unknown> => ({
    view: 'race',
    boat: { sail: 'NED 1' },
    event: doc.name,
    division: 'J70',
    group: 'Top 3',
    race: { name: 'Race 1', header: ['3rd of 10', '12 s behind Winner', `gun ${hm(W1.gunMs)}`], ...race },
    findings: [
      { title: 'Late off the line', seconds: 8, when: `${hm(W1.gunMs)}–${hm(W1.gunMs + 120_000)}` },
      { title: 'Lost on the first beat', seconds: 12, when: 'Legs 1–2' },
    ],
    ...over,
  });
  const race = (r: string, view = 'race') => ({ event: EVENT, div: 'J70', race: r, view });

  it('answers about race 1; races 2+ and the Regatta view need a pass', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    expect(hm(gun2)).not.toBe(hm(W1.gunMs));
    const r1 = await ask(race('1'), env);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect((await ask(race('2'), env)).status).toBe(401);
    expect((await ask(race('1', 'regatta'), env)).status).toBe(401);
    expect((await ask({ div: 'J70', race: '1' }, env)).status).toBe(401);
    const a = await signIn(db, 'a@example.com');
    const refused = await ask(race('2'), env, a.cookie);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: 'payment_required', eventId: EVENT, race: '2' });
    await giveRegatta(db, a.user.id);
    expect((await ask(race('2'), env, a.cookie, raceContext({}, { name: 'Race 2', header: [`gun ${hm(gun2)}`] }))).status).toBe(200);
    expect((await ask(race('1', 'regatta'), env, a.cookie, { view: 'regatta', boat: { sail: 'NED 1' }, regatta: { status: '9 of 9 races analysed' } })).status).toBe(200);
  });

  it('race 1’s label is not enough: the server checks the context against race 1 in the document it fetched', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const { user, cookie } = await signIn(db, 'a@example.com');
    const smuggled: [string, Record<string, unknown>][] = [
      ['race 2’s gun in the header', raceContext({}, { header: ['3rd of 10', `gun ${hm(gun2)}`] })],
      ['no gun in the header', raceContext({}, { header: ['3rd of 10'] })],
      ['no header at all', raceContext({}, { header: undefined })],
      ['a card from race 2’s window', raceContext({ findings: [{ title: 'Late off the line', when: `${hm(gun2)}–${hm(gun2 + 120_000)}` }] })],
      ['a hole chip outside race 1', raceContext({}, { header: [`gun ${hm(W1.gunMs)}`, `⚠ no data ${hm(gun2)}–${hm(gun2 + 60_000)}`] })],
      ['another race’s name', raceContext({}, { name: 'Race 3' })],
      ['no race name', raceContext({}, { name: undefined })],
      ['another division', raceContext({ division: 'J80' })],
      ['no division', raceContext({ division: undefined })],
      ['another event’s name', raceContext({ event: 'Some Other Regatta' })],
      ['a regatta section', raceContext({ regatta: { status: '9 of 9 races analysed', places: [{ race: 'R2', place: '1st of 10' }] } })],
      ['the Regatta view’s context under race ids', raceContext({ view: 'regatta' })],
    ];
    for (const [what, context] of smuggled) {
      expect((await ask(race('1'), env, undefined, context)).status, what).toBe(401);
      const res = await ask(race('1'), env, cookie, context);
      expect(res.status, what).toBe(402);
      expect(await res.json()).toMatchObject({ error: 'payment_required', eventId: EVENT, race: '1' });
    }
    // The page's own race 1 contexts pass: a ⚠ chip in the header, a card at the very end of the free window, RaceSense's label.
    for (const context of [
      raceContext({}, { header: [`⚠ no tracked finish`, `gun ${hm(W1.gunMs)}`, `⚠ no data ${hm(W1.gunMs + 300_000)}–${hm(W1.gunMs + 360_000)}`] }),
      raceContext({ findings: [{ title: 'Slow at the finish', when: hm(W1.before) }] }),
      raceContext({}, { name: 'RS 1' }),
      raceContext({ findings: undefined }),
    ]) {
      expect((await ask(race('1'), env, undefined, context)).status).toBe(200);
    }
    // With a pass for the event, all of it is answered.
    await giveRegatta(db, user.id);
    for (const [what, context] of smuggled) expect((await ask(race('1'), env, cookie, context)).status, what).toBe(200);
  });

  it('askContextIsFree: race 1 only, from the document’s own race 1', () => {
    const free = freeRaces(doc);
    const ctx = raceContext() as unknown as AskContext;
    const ids = race('1') as AskIds;
    expect(askContextIsFree(free, ids, ctx)).toBe(true);
    expect(askContextIsFree(free, { ...ids, race: '2' }, ctx)).toBe(false);
    expect(askContextIsFree(free, { ...ids, div: 'J80' }, ctx)).toBe(false);
    expect(askContextIsFree(free, { ...ids, race: undefined }, ctx)).toBe(false);
    expect(askContextIsFree({ divisions: [], windows: [] }, ids, ctx)).toBe(false);
    // The gun may be a minute off (seconds rounding either side), no more.
    const at = (ms: number) => raceContext({}, { header: [`gun ${hm(ms)}`] }) as unknown as AskContext;
    expect(askContextIsFree(free, ids, at(W1.gunMs + 60_000))).toBe(true);
    expect(askContextIsFree(free, ids, at(W1.gunMs - 60_000))).toBe(true);
    expect(askContextIsFree(free, ids, at(W1.gunMs + 180_000))).toBe(false);
  });

  it('flag off: race 2 (or any context) is answered as today', async () => {
    const res = await ask({ event: EVENT, div: 'J70', race: '2', view: 'race' }, { PAYWALL_ENABLED: 'false' }, undefined, { view: 'race', boat: { sail: 'NED 1' }, findings: [] });
    expect(res.status).toBe(200);
  });
});
