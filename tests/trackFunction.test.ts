import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TRACK_IP_LIMIT, handleTrack, trackOriginOk, trackPoints, type AnalyticsDatasetLike, type TrackEnv, type TrackPoint } from '../functions/_track';
import type { D1Like } from '../functions/_authDb';
import { MemD1 } from './d1mem';
import { BATCH_MAX, BODY_MAX, SESSION_MAX, TRACK_EVENTS } from '../functions/_trackSchema';
import { onRequest } from '../functions/api/track';

const ORIGIN = 'https://recall.walkeforward.com';
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** As functions/_feedback.ts ipHash: the IP, salted with a hash of AUTH_SECRET. */
const ipKey = (ip: string, secret: string): string => sha(`recall-feedback-ip:${sha(`salt:${secret}`)}:${ip}`);

const fakeDataset = () => {
  const points: TrackPoint[] = [];
  const ds: AnalyticsDatasetLike = { writeDataPoint: (p) => void points.push(p as TrackPoint) };
  return { ds, points };
};

const batch = (ev: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ sid: SID, dev: 'desktop', th: 'light', auth: 'yes', ev, ...over });
const ok = { n: 'race_open', p: '/regattas/start', e: 'cbc2026', r: 'J/105|3', f: 'www.google.com', s: 1, t: 0 };

interface PostOpts {
  origin?: string | null;
  method?: string;
  raw?: string;
  country?: string;
  ip?: string;
  type?: string;
  url?: string;
}

function post(body: unknown, o: PostOpts = {}): Request {
  const headers: Record<string, string> = { 'content-type': o.type ?? 'application/json' };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.ip) headers['cf-connecting-ip'] = o.ip;
  const req = new Request(o.url ?? `${ORIGIN}/api/track`, { method: o.method ?? 'POST', headers, ...(o.method === 'GET' ? {} : { body: o.raw ?? JSON.stringify(body) }) });
  if (o.country) Object.defineProperty(req, 'cf', { value: { country: o.country } });
  return req;
}

describe('POST /api/track (functions/_track.ts)', () => {
  it('writes one data point per event, in the documented columns', async () => {
    const { ds, points } = fakeDataset();
    const res = await handleTrack({ request: post(batch([ok, { n: 'tab', p: '/regattas/coach', d: 'coach', s: 2, t: 4_000 }]), { country: 'US' }), env: { RECALL_EVENTS: ds } });
    expect(res.status).toBe(204);
    expect(points).toEqual([
      { indexes: ['race_open'], blobs: ['race_open', '/regattas/start', 'cbc2026', 'J/105|3', 'yes', 'desktop', 'www.google.com', 'light', '', 'US', SID], doubles: [1, 0] },
      { indexes: ['tab'], blobs: ['tab', '/regattas/coach', '', '', 'yes', 'desktop', '', 'light', 'coach', 'US', SID], doubles: [2, 4000] },
    ]);
  });

  it('answers 204 and stores nothing without the binding', async () => {
    const res = await onRequest({ request: post(batch([ok])), env: {} });
    expect(res.status).toBe(204);
    expect((await onRequest({ request: post('not even json', { raw: '{' }), env: {} })).status).toBe(204);
  });

  it('POST only', async () => {
    const { ds, points } = fakeDataset();
    const res = await handleTrack({ request: post(null, { method: 'GET' }), env: { RECALL_EVENTS: ds } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(points).toEqual([]);
  });

  it('the index is the event name (low-cardinality, the sampling key); the session is blob11', () => {
    const pts = trackPoints(batch([ok, { n: 'tab', p: '/regattas/race', d: 'race', s: 2, t: 10 }, { n: 'tab', p: '/regattas/coach', d: 'coach', s: 3, t: 20 }]))!;
    expect(pts.map((p) => p.indexes)).toEqual([['race_open'], ['tab'], ['tab']]);
    for (const p of pts) {
      expect(p.indexes[0]).toBe(p.blobs[0]);
      expect(p.blobs[10]).toBe(SID);
      expect(p.indexes).not.toContain(SID);
    }
  });

  describe('the Origin header', () => {
    const accepted = ['https://recall.walkeforward.com', 'https://start-line.pages.dev', 'https://usage-tracking.start-line.pages.dev', 'https://4a48b696.start-line.pages.dev'];
    const rejected: (string | null)[] = [
      null,
      '',
      'null',
      'https://evil.example',
      'https://evil-start-line.pages.dev',
      'https://evilstart-line.pages.dev',
      'https://a.b.start-line.pages.dev',
      'https://start-line.pages.dev.evil.com',
      'https://x.start-line.pages.dev.evil.com',
      'https://recall.walkeforward.com.evil.com',
      'https://evilrecall.walkeforward.com',
      'https://walkeforward.com',
      'https://www.walkeforward.com',
      'http://recall.walkeforward.com',
      'https://recall.walkeforward.com:8443',
      'https://recall.walkeforward.com/',
      'http://start-line.pages.dev',
      'http://localhost:5173',
      'http://127.0.0.1:8788',
      'http://localhost',
    ];

    it.each(accepted)('takes %s', async (origin) => {
      const { ds, points } = fakeDataset();
      expect(trackOriginOk(origin, `${ORIGIN}/api/track`)).toBe(true);
      expect((await handleTrack({ request: post(batch([ok]), { origin }), env: { RECALL_EVENTS: ds } })).status).toBe(204);
      expect(points).toHaveLength(1);
    });

    it.each(rejected)('refuses %s in production and previews', async (origin) => {
      const { ds, points } = fakeDataset();
      expect(trackOriginOk(origin, `${ORIGIN}/api/track`)).toBe(false);
      expect(trackOriginOk(origin, 'https://usage-tracking.start-line.pages.dev/api/track')).toBe(false);
      expect((await handleTrack({ request: post(batch([ok]), { origin }), env: { RECALL_EVENTS: ds } })).status).toBe(403);
      expect(points).toEqual([]);
    });

    it('takes http://localhost:<port> and http://127.0.0.1:<port> only when the request itself is local (dev)', async () => {
      for (const url of ['http://localhost:8788/api/track', 'http://127.0.0.1:8788/api/track']) {
        expect(trackOriginOk('http://localhost:5173', url)).toBe(true);
        expect(trackOriginOk('http://127.0.0.1:8788', url)).toBe(true);
        expect(trackOriginOk('http://localhost', url)).toBe(false);
        expect(trackOriginOk('https://localhost:5173', url)).toBe(false);
        expect(trackOriginOk('http://localhost.evil.com:5173', url)).toBe(false);
        expect(trackOriginOk('http://evil.localhost:5173', url)).toBe(false);
        expect(trackOriginOk(null, url)).toBe(false);
        expect(trackOriginOk('null', url)).toBe(false);
      }
      const { ds, points } = fakeDataset();
      const res = await handleTrack({ request: post(batch([ok]), { origin: 'http://localhost:5173', url: 'http://localhost:8788/api/track' }), env: { RECALL_EVENTS: ds } });
      expect(res.status).toBe(204);
      expect(points).toHaveLength(1);
    });
  });

  it('JSON only: a text/plain or form post is refused (415), writing nothing', async () => {
    const { ds, points } = fakeDataset();
    for (const type of ['text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp']) {
      expect((await handleTrack({ request: post(batch([ok]), { type }), env: { RECALL_EVENTS: ds } })).status).toBe(415);
    }
    expect(points).toEqual([]);
    expect((await handleTrack({ request: post(batch([ok]), { type: 'application/json; charset=utf-8' }), env: { RECALL_EVENTS: ds } })).status).toBe(204);
  });

  describe('the per-IP rate limit (auth_rate_limits)', () => {
    const NOW = Date.UTC(2026, 9, 29, 12, 30);
    const send = (env: TrackEnv, ip: string, o: { ipLimit?: number | null; now?: number } = {}): Promise<Response> =>
      handleTrack({ request: post(batch([ok]), { ip }), env }, { now: () => o.now ?? NOW, random: () => 0.5, ...('ipLimit' in o ? { ipLimit: o.ipLimit } : {}) });

    it('over the hourly limit: 429, writing nothing; another IP and the next hour are fine', async () => {
      const db = new MemD1();
      const { ds, points } = fakeDataset();
      const env = { RECALL_EVENTS: ds, AUTH_DB: db, AUTH_SECRET: 's3cret' };
      for (let i = 0; i < 3; i++) expect((await send(env, '203.0.113.7', { ipLimit: 3 })).status).toBe(204);
      const over = await send(env, '203.0.113.7', { ipLimit: 3 });
      expect(over.status).toBe(429);
      expect(over.headers.get('cache-control')).toBe('no-store');
      expect(points).toHaveLength(3);
      expect((await send(env, '203.0.113.8', { ipLimit: 3 })).status).toBe(204);
      expect((await send(env, '203.0.113.7', { ipLimit: 3, now: NOW + 3_600_000 })).status).toBe(204);
    });

    it(`${TRACK_IP_LIMIT} batches an hour per IP by default`, async () => {
      expect(TRACK_IP_LIMIT).toBe(2_000);
      const db = new MemD1();
      const { ds } = fakeDataset();
      const env = { RECALL_EVENTS: ds, AUTH_DB: db, AUTH_SECRET: 's3cret' };
      expect((await send(env, '198.51.100.1')).status).toBe(204);
      const key = `track-ip:${ipKey('198.51.100.1', 's3cret')}`;
      // Fill the hour to the limit by hand, then one more is over.
      await db.prepare('UPDATE auth_rate_limits SET count = ? WHERE key = ?').bind(TRACK_IP_LIMIT, key).run();
      expect((await send(env, '198.51.100.1')).status).toBe(429);
    });

    it('keys the counter by a salted hash of the IP, and never puts the IP (or its hash) in a data point', async () => {
      const db = new MemD1();
      const { ds, points } = fakeDataset();
      await send({ RECALL_EVENTS: ds, AUTH_DB: db, AUTH_SECRET: 's3cret' }, '203.0.113.7');
      const keys = db.rows('auth_rate_limits').map((r) => String(r.key));
      expect(keys).toEqual([`track-ip:${ipKey('203.0.113.7', 's3cret')}`]);
      expect(points).toHaveLength(1);
      const flat = JSON.stringify(points);
      for (const bad of ['203.0.113.7', keys[0].slice('track-ip:'.length), sha('203.0.113.7')]) expect(flat).not.toContain(bad);
    });

    it('fails open: a database that errs, sends no count back, or is missing lets the batch through', async () => {
      const throwing: D1Like = {
        prepare: () => {
          throw new Error('D1 is down');
        },
        batch: () => Promise.reject(new Error('D1 is down')),
      };
      const rejecting = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('timeout')) }) }), batch: async () => [] } as unknown as D1Like;
      const noRow = { prepare: () => ({ bind: () => ({ first: async () => null }) }), batch: async () => [] } as unknown as D1Like;
      for (const db of [throwing, rejecting, noRow, undefined]) {
        const { ds, points } = fakeDataset();
        const res = await send({ RECALL_EVENTS: ds, ...(db ? { AUTH_DB: db } : {}) }, '203.0.113.7', { ipLimit: 0 });
        expect(res.status).toBe(204);
        expect(points).toHaveLength(1);
      }
    });

    it('touches no database without the dataset binding', async () => {
      const db = new MemD1();
      expect((await send({ AUTH_DB: db }, '203.0.113.7', { ipLimit: 0 })).status).toBe(204);
      expect(db.rows('auth_rate_limits')).toEqual([]);
    });

    it('one counter hit per batch, however many events it holds', async () => {
      const db = new MemD1();
      const { ds, points } = fakeDataset();
      const full = batch(Array.from({ length: BATCH_MAX }, (_, i) => ({ ...ok, f: undefined, s: i + 1 })));
      const res = await handleTrack({ request: post(full, { ip: '203.0.113.9' }), env: { RECALL_EVENTS: ds, AUTH_DB: db } }, { now: () => NOW, random: () => 0.5 });
      expect(res.status).toBe(204);
      expect(points).toHaveLength(BATCH_MAX);
      expect(db.rows('auth_rate_limits').map((r) => r.count)).toEqual([1]);
    });
  });

  it('refuses an oversize body, bad JSON and bad shapes, writing nothing', async () => {
    const { ds, points } = fakeDataset();
    const status = async (raw: string): Promise<number> => (await handleTrack({ request: post(null, { raw }), env: { RECALL_EVENTS: ds } })).status;
    expect(await status(JSON.stringify(batch([{ ...ok, d: 'x' }], { pad: 'y'.repeat(BODY_MAX) })))).toBe(413);
    expect(await status('{')).toBe(400);
    expect(await status('[]')).toBe(400);
    const bad: unknown[] = [
      batch([]),
      batch(Array.from({ length: BATCH_MAX + 1 }, (_, i) => ({ ...ok, f: undefined, s: i + 1 }))),
      batch([ok], { sid: 'not-a-uuid' }),
      batch([ok], { dev: 'fridge' }),
      batch([ok], { th: 'sepia' }),
      batch([ok], { auth: 'maybe' }),
      batch([ok], { email: 'a@example.com' }),
      batch([{ ...ok, n: 'page_hack' }]),
      batch([{ ...ok, email: 'a@example.com' }]),
      batch([{ ...ok, user: 'u1' }]),
      batch([{ ...ok, p: 'regattas' }]),
      batch([{ ...ok, e: 'bad id!' }]),
      batch([{ ...ok, r: 'no bar' }]),
      batch([{ ...ok, d: 'Has Spaces' }]),
      batch([{ ...ok, f: 'https://x.com/a' }]),
      batch([{ ...ok, f: 'x.com', s: 2 }]),
      batch([{ ...ok, s: 0 }]),
      batch([{ ...ok, s: SESSION_MAX + 1 }]),
      batch([{ ...ok, s: 1.5 }]),
      batch([{ ...ok, t: -1 }]),
      batch([{ ...ok, t: 'soon' }]),
      batch([ok, 'not an event' as unknown as Record<string, unknown>]),
    ];
    for (const b of bad) expect(await status(JSON.stringify(b)), JSON.stringify(b).slice(0, 120)).toBe(400);
    expect(points).toEqual([]);
  });

  it('stores a path the app does not use as "other", never the raw string', () => {
    expect(trackPoints(batch([{ ...ok, p: '/wp-admin/x.php' }]))![0].blobs[1]).toBe('other');
    expect(trackPoints(batch([{ ...ok, p: '/' }]))![0].blobs[1]).toBe('/');
  });

  it('takes every known event name', () => {
    const pts = trackPoints(batch(TRACK_EVENTS.slice(0, BATCH_MAX).map((n, i) => ({ n, p: '/', s: i + 1, t: i }))));
    expect(pts?.map((p) => p.blobs[0])).toEqual(TRACK_EVENTS.slice(0, BATCH_MAX));
  });

  it('a binding that throws does not fail the request', async () => {
    const ds: AnalyticsDatasetLike = {
      writeDataPoint: () => {
        throw new Error('quota');
      },
    };
    expect((await handleTrack({ request: post(batch([ok])), env: { RECALL_EVENTS: ds } })).status).toBe(204);
  });
});
