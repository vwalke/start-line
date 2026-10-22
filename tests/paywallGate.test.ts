import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet as proxyGet } from '../functions/api/[[path]]';
import { onRequestGet as vkxDataGet } from '../functions/api/vkx/data';
import { onRequestPost as askPost } from '../functions/api/coach/ask';
import { objectKey } from '../functions/_vkx';
import { PRIVATE_CACHE, type PaywallEnv } from '../functions/_paywall';
import { telemetryWindow, currentDoc } from '../src/data/racesense/adapter';
import { MemBucket } from './r2mem';
import { MemD1 } from './d1mem';
import { EVENT, FakeCache, NOW, ORIGIN, beneluxRegatta, giveRegatta, giveSeason, mockUpstream, paywallEnv, resetPaywallCaches, signIn } from './paywallHelpers';

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

  it('entitled: 200 from the shared edge cache entry, sent private with Vary: Cookie; never leaked to others', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const a = await signIn(db, 'a@example.com');
    const b = await signIn(db, 'b@example.com');
    const c = await signIn(db, 'c@example.com');
    await giveRegatta(db, a.user.id);
    await giveSeason(db, c.user.id, NOW + 86_400_000);

    const first = await proxy(teleUrl(R2), env, a.cookie);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe(PRIVATE_CACHE);
    expect(first.headers.get('vary')).toBe('Cookie');
    const body = await first.text();
    expect(teleCalls()).toBe(1);
    // The edge copy itself keeps the public header (it is shared by everyone entitled).
    expect(cache.store.get(teleUrl(R2))?.headers.get('cache-control')).toMatch(/^public/);

    expect((await proxy(teleUrl(R2), env, b.cookie)).status).toBe(402);
    expect((await proxy(teleUrl(R2), env)).status).toBe(401);
    const third = await proxy(teleUrl(R2), env, c.cookie);
    expect(third.status).toBe(200);
    expect(third.headers.get('cache-control')).toBe(PRIVATE_CACHE);
    expect(await third.text()).toBe(body);
    expect(teleCalls()).toBe(1);
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

  const ask = (ids: Record<string, string>, env: PaywallEnv, cookie?: string): Promise<Response> =>
    askPost({
      request: new Request(`${ORIGIN}/api/coach/ask`, {
        method: 'POST',
        body: JSON.stringify({ session: 'abcdefghijklmnop1234', question: 'How was my start?', ids, context: { view: 'race', boat: { sail: 'NED 1' }, findings: [] } }),
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${++ip}`, ...(cookie ? { cookie } : {}) },
      }),
      env: { ...env, ANTHROPIC_API_KEY: 'sk-ant-test-fake' },
      waitUntil: () => undefined,
    });

  it('answers about race 1; races 2+ and the Regatta view need a pass', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const race = (r: string, view = 'race') => ({ event: EVENT, div: 'J70', race: r, view });
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
    resetPaywallCaches();
    expect((await ask(race('2'), env, a.cookie)).status).toBe(200);
    expect((await ask(race('1', 'regatta'), env, a.cookie)).status).toBe(200);
  });

  it('flag off: race 2 is answered as today', async () => {
    const res = await ask({ event: EVENT, div: 'J70', race: '2', view: 'race' }, { PAYWALL_ENABLED: 'false' });
    expect(res.status).toBe(200);
  });
});
