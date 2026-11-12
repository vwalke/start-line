import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet as proxyGet } from '../functions/api/[[path]]';
import { TELEMETRY_RETRY_S, TELEMETRY_UNAVAILABLE_MESSAGE, telemetryUnavailable } from '../functions/_lib';
import type { PaywallEnv } from '../functions/_paywall';
import { currentDoc, telemetryWindow } from '../src/data/racesense/adapter';
import { MemD1 } from './d1mem';
import { EVENT, FakeCache, ORIGIN, beneluxRegatta, giveRegatta, mockUpstream, paywallEnv, resetPaywallCaches, signIn } from './paywallHelpers';

const doc = currentDoc(beneluxRegatta());
const R1 = telemetryWindow(doc, { division: 'J70', raceNumber: 1 });
const R2 = telemetryWindow(doc, { division: 'J70', raceNumber: 2 });

let cache: FakeCache;
let pending: Promise<unknown>[];

/** The Benelux document as usual; teleapi answers `status` (or throws for 'down'). */
function teleapi(status: number | 'down'): typeof fetch & { tele: number } {
  const base = mockUpstream();
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://teleapi.regatta.app/')) {
      f.tele++;
      if (status === 'down') throw new TypeError('fetch failed');
      return new Response(status === 401 ? '{"message":"Unauthorized"}' : 'nope', { status });
    }
    return base(input);
  }) as typeof fetch & { tele: number };
  f.tele = 0;
  return f;
}

beforeEach(() => {
  resetPaywallCaches();
  cache = new FakeCache();
  pending = [];
  vi.stubGlobal('caches', { default: cache });
});
afterEach(() => vi.unstubAllGlobals());

const teleUrl = (w: { after: number; before: number }): string =>
  `${ORIGIN}/api/telemetry/event/${EVENT}?${new URLSearchParams({ after: String(w.after), before: String(w.before), limit: '100000', division: 'J70' })}`;

async function proxy(url: string, env?: PaywallEnv, cookie?: string): Promise<Response> {
  const path = new URL(url).pathname.replace(/^\/api\//, '').split('/');
  const res = await proxyGet({ request: new Request(url, { headers: cookie ? { cookie } : {} }), params: { path }, ...(env ? { env } : {}), waitUntil: (p) => void pending.push(p) });
  await Promise.all(pending);
  return res;
}

async function expectUnavailable(res: Response): Promise<void> {
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('60');
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  const text = await res.text();
  expect(text).not.toMatch(/error code: 502|Upstream \d+/);
  expect(JSON.parse(text)).toEqual({ error: 'telemetry_unavailable', message: TELEMETRY_UNAVAILABLE_MESSAGE, retryAfter: 60 });
}

describe('telemetry: the track feed unavailable', () => {
  it('the shape: 503, calm message, a minute to wait', async () => {
    expect(TELEMETRY_RETRY_S).toBe(60);
    expect(TELEMETRY_UNAVAILABLE_MESSAGE).not.toMatch(/\d{3}|http|teleapi|\/api\/|error|fail|block|outage/i);
    await expectUnavailable(telemetryUnavailable());
  });

  for (const status of [401, 403, 500, 502, 503] as const) {
    it(`teleapi ${status} → 503 telemetry_unavailable (paywall off)`, async () => {
      const f = teleapi(status);
      vi.stubGlobal('fetch', f);
      await expectUnavailable(await proxy(teleUrl(R2)));
      expect(f.tele).toBe(1);
      // Never stored: the next request asks upstream again.
      expect(cache.store.size).toBe(0);
    });
  }

  it('teleapi unreachable (fetch throws) → 503 telemetry_unavailable', async () => {
    vi.stubGlobal('fetch', teleapi('down'));
    await expectUnavailable(await proxy(teleUrl(R1)));
  });

  it('a 404 stays a 404; a 429 stays the generic 502', async () => {
    vi.stubGlobal('fetch', teleapi(404));
    expect((await proxy(teleUrl(R1))).status).toBe(404);
    vi.stubGlobal('fetch', teleapi(429));
    const res = await proxy(teleUrl(R1));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Upstream 429' });
  });

  it('paywall on: free race 1 passes the gate, then gets the 503', async () => {
    const f = teleapi(401);
    vi.stubGlobal('fetch', f);
    await expectUnavailable(await proxy(teleUrl(R1), paywallEnv(new MemD1())));
    expect(f.tele).toBe(1);
  });

  it('paywall on: an entitled later race passes the gate, then gets the 503', async () => {
    const db = new MemD1();
    const a = await signIn(db, 'a@example.com');
    await giveRegatta(db, a.user.id);
    vi.stubGlobal('fetch', teleapi(403));
    await expectUnavailable(await proxy(teleUrl(R2), paywallEnv(db), a.cookie));
  });

  it('paywall on: a later race signed out is still 401 sign_in_required (teleapi never asked)', async () => {
    const f = teleapi(401);
    vi.stubGlobal('fetch', f);
    const res = await proxy(teleUrl(R2), paywallEnv(new MemD1()));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ error: 'sign_in_required', eventId: EVENT, race: null });
    expect(f.tele).toBe(0);
  });

  it('paywall on, the document unreachable and no pass: still 502 Upstream unreachable', async () => {
    const f = teleapi(401);
    vi.stubGlobal('fetch', (async (u: RequestInfo | URL) => (String(u).includes('racesense') ? new Response('down', { status: 503 }) : f(u))) as typeof fetch);
    const res = await proxy(teleUrl(R1), paywallEnv(new MemD1()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Upstream unreachable' });
  });

  it('the event document keeps its own 502 mapping', async () => {
    vi.stubGlobal('fetch', (async () => new Response('nope', { status: 401 })) as typeof fetch);
    const res = await proxy(`${ORIGIN}/api/regatta?event=${EVENT}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Upstream 401' });
  });
});
