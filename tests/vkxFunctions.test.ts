import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  RateLimiter,
  handleData,
  handleDelete,
  handleList,
  handleUpload,
  objectKey,
  type Ctx,
  type VkxDeps,
  type VkxEnv,
} from '../functions/_vkx';
import { encodePayload, encodePayloadRaw, gzip } from '../src/data/vkx/compact';
import { coveredRaces, type RaceWindow } from '../src/data/vkx/match';
import { parseVkx } from '../src/data/vkx/parse';
import { payloadFor } from '../src/data/vkx/plan';
import { MemBucket } from './r2mem';
import { DIV, EVENT, R7_GUN, RO, Z, editFeed, mockUpstream, trimVkx } from './vkxHelpers';

const ORIGIN = 'https://recall.example';
const R7_SHORT: RaceWindow = { id: '7', label: 'R7', gunMs: R7_GUN, endMs: Z('12:07:50'), endKnown: false };

async function payload(src = 'b'.repeat(64)): Promise<Uint8Array> {
  const log = parseVkx(trimVkx());
  const [c] = coveredRaces(log.pos.t, [R7_SHORT]);
  return (await payloadFor(log, c, { event: EVENT, div: DIV }, RO, { sha256: src, bytes: 1 })).bytes;
}

/** A Cache-API stand-in (exact URL keys). */
class FakeCache {
  readonly store = new Map<string, Response>();
  async match(req: Request): Promise<Response | undefined> {
    return this.store.get(req.url)?.clone();
  }
  async put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, res.clone());
  }
  async delete(req: Request): Promise<boolean> {
    return this.store.delete(req.url);
  }
}

const ctx = (req: Request, env: VkxEnv): Ctx => ({ request: req, env, waitUntil: () => undefined });
const post = (body: BodyInit, headers: Record<string, string> = { 'content-type': 'application/octet-stream' }): Request =>
  new Request(`${ORIGIN}/api/vkx/upload`, { method: 'POST', body, headers });
const get = (path: string, q: Record<string, string>): Request => new Request(`${ORIGIN}${path}?${new URLSearchParams(q)}`);
const del = (body: unknown): Request => new Request(`${ORIGIN}/api/vkx/delete`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const deps = (over: VkxDeps = {}): VkxDeps => ({ fetch: mockUpstream(), limiter: null, cache: null, ...over });
const body = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
const id = { event: EVENT, div: DIV, race: '7', sn: RO.sn };

describe('vkx Pages Functions', () => {
  it('without the R2 binding every route answers 503 (and the client shows "uploads unavailable")', async () => {
    const env: VkxEnv = {};
    for (const r of [
      await handleUpload(ctx(post(await payload()), env)),
      await handleList(ctx(get('/api/vkx/list', { event: EVENT, div: DIV }), env)),
      await handleData(ctx(get('/api/vkx/data', { event: EVENT, div: DIV, race: '7', sn: '1', h: 'a'.repeat(64) }), env)),
      await handleDelete(ctx(del({ ...id, token: 'x' }), env)),
    ]) {
      expect(r.status).toBe(503);
      expect(await body(r)).toMatchObject({ ok: false, code: 'no-storage' });
    }
  });

  it('stores a verified upload, lists it and serves it immutable', async () => {
    const bucket = new MemBucket();
    const up = mockUpstream();
    const gz = await payload();
    const res = await handleUpload(ctx(post(gz), { VKX_BUCKET: bucket }), deps({ fetch: up }));
    const j = await body(res);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(j).toMatchObject({ ok: true, race: '7', sn: RO.sn, sail: RO.sail, prevKept: false, size: gz.length });
    expect(String(j.token)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((j.check as { medianM: number }).medianM).toBeLessThan(1);
    // Bounded upstream use: at most 8 small windows, the same host and UA as the proxy.
    expect(up.calls.length).toBeGreaterThan(0);
    expect(up.calls.length).toBeLessThanOrEqual(8);
    for (const u of up.calls) {
      expect(u).toMatch(/^https:\/\/teleapi\.regatta\.app\/telemetry\/event\/oRkxbTpSZPbSkrmKrbj2\?/);
      const q = new URL(u).searchParams;
      expect(Number(q.get('before')) - Number(q.get('after'))).toBeLessThanOrEqual(50_000);
      expect(q.get('division')).toBe(DIV);
    }
    // Key layout; only the token's hash is kept.
    expect(objectKey(id)).toBe(`v1/${EVENT}/T3Blbg/7/${RO.sn}.bin`);
    const stored = bucket.objects.get(objectKey(id))!;
    expect(stored.meta.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.meta)).not.toContain(String(j.token));
    expect(stored.meta).toMatchObject({ sail: RO.sail, rateHz: '10', sha: j.sha });

    const list = await handleList(ctx(get('/api/vkx/list', { event: EVENT, div: DIV, race: '7' }), { VKX_BUCKET: bucket }), deps());
    expect(list.headers.get('cache-control')).toBe('public, max-age=60');
    const items = (await body(list)).uploads as { sail: string; url: string; sha: string; n: number }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sail: RO.sail, sha: j.sha });
    expect(items[0].url).toBe(j.url);

    const u = new URL(items[0].url, ORIGIN);
    const data = await handleData(ctx(new Request(u), { VKX_BUCKET: bucket }), deps());
    expect(data.status).toBe(200);
    expect(data.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(data.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await data.arrayBuffer())).toEqual(gz);
    // A stale hash (replaced upload): 404, not cached.
    u.searchParams.set('h', 'c'.repeat(64));
    const stale = await handleData(ctx(new Request(u), { VKX_BUCKET: bucket }), deps());
    expect(stale.status).toBe(404);
    expect(stale.headers.get('cache-control')).toBe('no-store');
  });

  it('caps the size (413) and the content type (415)', async () => {
    const env = { VKX_BUCKET: new MemBucket() };
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    expect((await handleUpload(ctx(post(big), env), deps())).status).toBe(413);
    expect((await handleUpload(ctx(post(await payload(), { 'content-type': 'text/plain' }), env), deps())).status).toBe(415);
    expect(env.VKX_BUCKET.objects.size).toBe(0);
  });

  it('rejects bad ids (400) and bad payloads (422)', async () => {
    const env = { VKX_BUCKET: new MemBucket() };
    const log = parseVkx(trimVkx());
    const s = { t: log.pos.t.subarray(0, 1200), latE7: log.pos.latE7, lonE7: log.pos.lonE7, sog: log.pos.sog, cog: log.pos.cog };
    const head = { event: EVENT, div: DIV, race: '7', gunMs: log.pos.t[600], sn: RO.sn, sail: RO.sail, rateHz: 10, timers: [], pings: [], declinationRad: null, srcSha256: 'a'.repeat(64), srcBytes: 1 };
    const badRace = await encodePayload({ ...head, race: '../7' }, s);
    expect((await handleUpload(ctx(post(badRace), env), deps())).status).toBe(400);
    const badEvent = await encodePayload({ ...head, event: 'x' }, s);
    expect((await handleUpload(ctx(post(badEvent), env), deps())).status).toBe(400);
    // Not gzip / not a payload / timestamps going backwards.
    expect((await handleUpload(ctx(post(new Uint8Array([1, 2, 3])), env), deps())).status).toBe(422);
    expect((await handleUpload(ctx(post(await gzip(new TextEncoder().encode('hello world'))), env), deps())).status).toBe(422);
    // (The format can't carry a backwards step at all; a repeated time it can, and the check refuses it.)
    const back = Float64Array.from(s.t);
    back[500] = back[400];
    expect(() => encodePayloadRaw(head, { ...s, t: back })).toThrow(/backwards/);
    const repeat = Float64Array.from(s.t);
    repeat[500] = repeat[499];
    const r = await handleUpload(ctx(post(await gzip(encodePayloadRaw(head, { ...s, t: repeat }))), env), deps());
    expect(r.status).toBe(422);
    expect((await body(r)).error).toMatch(/not increasing/);
    // A 300 m jump in a tenth of a second, over and over.
    const lat = Int32Array.from(s.latE7.subarray(0, 1200), (v, k) => (k % 10 === 5 ? v + 27_000 : v));
    const jumpy = await handleUpload(ctx(post(await encodePayload(head, { ...s, latE7: lat })), env), deps());
    expect(jumpy.status).toBe(422);
    expect((await body(jumpy)).error).toMatch(/jumps/);
    // List / data ids.
    expect((await handleList(ctx(get('/api/vkx/list', { event: '../x', div: DIV }), env), deps())).status).toBe(400);
    expect((await handleData(ctx(get('/api/vkx/data', { event: EVENT, div: DIV, race: '7', sn: 'x', h: 'a'.repeat(64) }), env), deps())).status).toBe(400);
    expect((await handleData(ctx(get('/api/vkx/data', { event: EVENT, div: DIV, race: '7', sn: '1', h: 'nope' }), env), deps())).status).toBe(400);
    expect(env.VKX_BUCKET.objects.size).toBe(0);
  });

  it('checks the log against the boat’s public feed: mismatch 422, too few fixes 422, feed down 503', async () => {
    const env = { VKX_BUCKET: new MemBucket() };
    const gz = await payload();
    const moved = await handleUpload(ctx(post(gz), env), deps({ fetch: mockUpstream({ page: editFeed(RO.sn, { dLat: 0.0018 }) }) }));
    expect(moved.status).toBe(422);
    expect(await body(moved)).toMatchObject({ code: 'mismatch' });
    const gone = await handleUpload(ctx(post(gz), env), deps({ fetch: mockUpstream({ page: editFeed(RO.sn, { keep: () => false }) }) }));
    expect(gone.status).toBe(422);
    expect(await body(gone)).toMatchObject({ code: 'too-few' });
    for (const down of ['throw', 'status'] as const) {
      const r = await handleUpload(ctx(post(gz), env), deps({ fetch: mockUpstream({ down }) }));
      expect(r.status).toBe(503);
      expect((await body(r)).error).toMatch(/nothing was stored/);
    }
    expect(env.VKX_BUCKET.objects.size).toBe(0);
  });

  it('keeps the replaced upload as .prev, unless you replace your own', async () => {
    const bucket = new MemBucket();
    const env = { VKX_BUCKET: bucket };
    const first = await body(await handleUpload(ctx(post(await payload('1'.repeat(64))), env), deps()));
    const second = await body(await handleUpload(ctx(post(await payload('2'.repeat(64))), env), deps()));
    expect(second.prevKept).toBe(true);
    expect(bucket.objects.get(objectKey(id, true))!.meta.sha).toBe(first.sha);
    expect(bucket.objects.get(objectKey(id))!.meta.sha).toBe(second.sha);
    // The second uploader re-uploads with their token: the first stays as .prev.
    const req = post(await payload('3'.repeat(64)), { 'content-type': 'application/octet-stream', 'x-replace-token': String(second.token) });
    const third = await body(await handleUpload(ctx(req, env), deps()));
    expect(third.prevKept).toBe(false);
    expect(bucket.objects.get(objectKey(id, true))!.meta.sha).toBe(first.sha);
    // The list shows only the current one.
    const items = (await body(await handleList(ctx(get('/api/vkx/list', { event: EVENT, div: DIV }), env), deps()))).uploads as unknown[];
    expect(items).toHaveLength(1);

    // Delete: a wrong token is refused; the current token removes it and brings the previous back.
    expect((await handleDelete(ctx(del({ ...id, token: 'A'.repeat(43) }), env), deps())).status).toBe(403);
    expect((await handleDelete(ctx(del({ ...id, token: 'short' }), env), deps())).status).toBe(400);
    const d = await handleDelete(ctx(del({ ...id, token: third.token }), env), deps());
    expect(await body(d)).toMatchObject({ ok: true, removed: 'current', restored: true });
    expect(bucket.objects.get(objectKey(id))!.meta.sha).toBe(first.sha);
    expect(bucket.objects.has(objectKey(id, true))).toBe(false);
    // The first uploader's token now removes it for good.
    expect(await body(await handleDelete(ctx(del({ ...id, token: first.token }), env), deps()))).toMatchObject({ removed: 'current', restored: false });
    expect(bucket.objects.size).toBe(0);
    expect((await handleDelete(ctx(del({ ...id, token: first.token }), env), deps())).status).toBe(404);
  });

  it("a replaced upload's token removes the kept .prev copy", async () => {
    const bucket = new MemBucket();
    const env = { VKX_BUCKET: bucket };
    const first = await body(await handleUpload(ctx(post(await payload('1'.repeat(64))), env), deps()));
    await handleUpload(ctx(post(await payload('2'.repeat(64))), env), deps());
    expect(await body(await handleDelete(ctx(del({ ...id, token: first.token }), env), deps()))).toMatchObject({ removed: 'previous' });
    expect([...bucket.objects.keys()]).toEqual([objectKey(id)]);
  });

  it('caches the list for a minute and purges it on upload', async () => {
    const bucket = new MemBucket();
    const cache = new FakeCache() as unknown as Cache;
    const env = { VKX_BUCKET: bucket };
    const listReq = (): Request => get('/api/vkx/list', { event: EVENT, div: DIV, race: '7' });
    expect(((await body(await handleList(ctx(listReq(), env), deps({ cache })))).uploads as unknown[]).length).toBe(0);
    expect((cache as unknown as FakeCache).store.size).toBe(1);
    await handleUpload(ctx(post(await payload()), env), deps({ cache }));
    expect(((await body(await handleList(ctx(listReq(), env), deps({ cache })))).uploads as unknown[]).length).toBe(1);
  });

  it("refuses a genuine log filed under another boat's sail", async () => {
    const log = parseVkx(trimVkx());
    const [c] = coveredRaces(log.pos.t, [R7_SHORT]);
    const gz = (await payloadFor(log, c, { event: EVENT, div: DIV }, { sn: RO.sn, sail: 'ITA 1490' }, { sha256: 'b'.repeat(64), bytes: 1 })).bytes;
    const env = { VKX_BUCKET: new MemBucket() };
    const r = await handleUpload(ctx(post(gz), env), deps());
    expect(r.status).toBe(422);
    expect(await body(r)).toMatchObject({ code: 'sail', error: expect.stringMatching(/sails as USA 833/) });
    expect(env.VKX_BUCKET.objects.size).toBe(0);
  });

  it('bounds the sample count before allocating', async () => {
    const log = parseVkx(trimVkx());
    const s = { t: log.pos.t.subarray(0, 100), latE7: log.pos.latE7, lonE7: log.pos.lonE7, sog: log.pos.sog, cog: log.pos.cog };
    const raw = encodePayloadRaw({ event: EVENT, div: DIV, race: '7', gunMs: log.pos.t[50], sn: RO.sn, sail: RO.sail, rateHz: 10, timers: [], pings: [], declinationRad: null, srcSha256: 'a'.repeat(64), srcBytes: 1 }, s);
    // Rewrite the header's n to 5 million.
    const hl = new DataView(raw.buffer).getUint32(5, true);
    const head = JSON.parse(new TextDecoder().decode(raw.subarray(9, 9 + hl)));
    const big = new TextEncoder().encode(JSON.stringify({ ...head, n: 5_000_000 }));
    const out = new Uint8Array(9 + big.length + raw.length - 9 - hl);
    out.set(raw.subarray(0, 9));
    new DataView(out.buffer).setUint32(5, big.length, true);
    out.set(big, 9);
    out.set(raw.subarray(9 + hl), 9 + big.length);
    const r = await handleUpload(ctx(post(await gzip(out)), { VKX_BUCKET: new MemBucket() }), deps());
    expect(r.status).toBe(422);
    expect((await body(r)).error).toMatch(/sample count/);
  });

  it('re-reads the list past the edge cache with fresh=1, and never edge-caches payloads', async () => {
    const bucket = new MemBucket();
    const cache = new FakeCache();
    const env = { VKX_BUCKET: bucket };
    const q = { event: EVENT, div: DIV, race: '7' };
    await handleList(ctx(get('/api/vkx/list', q), env), deps({ cache: cache as unknown as Cache }));
    // Stored straight into R2 (not via upload, so nothing purges the cached empty list).
    await handleUpload(ctx(post(await payload()), env), deps());
    expect(((await body(await handleList(ctx(get('/api/vkx/list', q), env), deps({ cache: cache as unknown as Cache })))).uploads as unknown[]).length).toBe(0);
    const fresh = await handleList(ctx(get('/api/vkx/list', { ...q, fresh: '1' }), env), deps({ cache: cache as unknown as Cache }));
    expect(fresh.headers.get('cache-control')).toBe('no-store');
    const items = (await body(fresh)).uploads as { url: string }[];
    expect(items).toHaveLength(1);
    // …and it refreshed the cached copy for everyone.
    expect(((await body(await handleList(ctx(get('/api/vkx/list', q), env), deps({ cache: cache as unknown as Cache })))).uploads as unknown[]).length).toBe(1);
    const before = cache.store.size;
    await handleData(ctx(new Request(new URL(items[0].url, ORIGIN)), env), deps({ cache: cache as unknown as Cache }));
    expect(cache.store.size).toBe(before);
  });

  it('answers 503 when the bucket fails, and rate-limits per client', async () => {
    const bucket = new MemBucket();
    bucket.fail = true;
    expect((await handleList(ctx(get('/api/vkx/list', { event: EVENT, div: DIV }), { VKX_BUCKET: bucket }), deps())).status).toBe(503);
    const lim = new RateLimiter(2, 60_000);
    expect(await lim.allow('1.2.3.4', 0)).toBe(true);
    expect(await lim.allow('1.2.3.4', 1)).toBe(true);
    expect(await lim.allow('1.2.3.4', 2)).toBe(false);
    expect(await lim.allow('5.6.7.8', 2)).toBe(true);
    expect(await lim.allow('1.2.3.4', 70_000)).toBe(true);
    const tight = new RateLimiter(0);
    expect((await handleUpload(ctx(post(await payload()), { VKX_BUCKET: new MemBucket() }), deps({ limiter: tight }))).status).toBe(429);
  });
});
