import { describe, expect, it } from 'vitest';
import { handleTrack, trackPoints, type AnalyticsDatasetLike, type TrackPoint } from '../functions/_track';
import { BATCH_MAX, BODY_MAX, SESSION_MAX, TRACK_EVENTS } from '../functions/_trackSchema';
import { onRequest } from '../functions/api/track';

const ORIGIN = 'https://recall.walkeforward.com';
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const fakeDataset = () => {
  const points: TrackPoint[] = [];
  const ds: AnalyticsDatasetLike = { writeDataPoint: (p) => void points.push(p as TrackPoint) };
  return { ds, points };
};

const batch = (ev: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ sid: SID, dev: 'desktop', th: 'light', auth: 'yes', ev, ...over });
const ok = { n: 'race_open', p: '/regattas/start', e: 'cbc2026', r: 'J/105|3', f: 'www.google.com', s: 1, t: 0 };

function post(body: unknown, o: { origin?: string | null; method?: string; raw?: string; country?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'text/plain;charset=UTF-8' };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  const req = new Request(`${ORIGIN}/api/track`, { method: o.method ?? 'POST', headers, ...(o.method === 'GET' ? {} : { body: o.raw ?? JSON.stringify(body) }) });
  if (o.country) Object.defineProperty(req, 'cf', { value: { country: o.country } });
  return req;
}

describe('POST /api/track (functions/_track.ts)', () => {
  it('writes one data point per event, in the documented columns', async () => {
    const { ds, points } = fakeDataset();
    const res = await handleTrack({ request: post(batch([ok, { n: 'tab', p: '/regattas/coach', d: 'coach', s: 2, t: 4_000 }]), { country: 'US' }), env: { RECALL_EVENTS: ds } });
    expect(res.status).toBe(204);
    expect(points).toEqual([
      { indexes: [SID], blobs: ['race_open', '/regattas/start', 'cbc2026', 'J/105|3', 'yes', 'desktop', 'www.google.com', 'light', '', 'US'], doubles: [1, 0] },
      { indexes: [SID], blobs: ['tab', '/regattas/coach', '', '', 'yes', 'desktop', '', 'light', 'coach', 'US'], doubles: [2, 4000] },
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

  it("refuses another site's page; a beacon without an Origin is taken", async () => {
    const { ds, points } = fakeDataset();
    expect((await handleTrack({ request: post(batch([ok]), { origin: 'https://evil.example' }), env: { RECALL_EVENTS: ds } })).status).toBe(403);
    expect(points).toEqual([]);
    expect((await handleTrack({ request: post(batch([ok]), { origin: null }), env: { RECALL_EVENTS: ds } })).status).toBe(204);
    expect(points).toHaveLength(1);
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
