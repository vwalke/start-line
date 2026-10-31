import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_TELEMETRY_TTL, LIVE_TTL, buildYsQuery, telemetryTtl, ttlFor, ysTtl, ysUpstreamQuery } from '../functions/_lib';
import { DAY } from '../src/data/cache';
import { LIVE_REGATTA_TTL_MS, LIVE_SPAN_MS, PRE_GUN_MS, SETTLED_MS, hasLiveGun, telemetrySettled } from '../src/data/live';
import { httpYsSource } from '../src/data/official/yachtscoring';
import { fetchRegatta, fetchTelemetry } from '../src/data/racesense/api';
import type { RegattaResponse } from '../src/data/racesense/types';

const NOW = Date.parse('2026-10-31T15:30:00Z');
const GUN = Date.parse('2026-10-31T15:25:01Z');
const docWith = (gun: number, endDate: number | null = Date.parse('2026-11-01T00:00:00Z')) => ({
  endDate,
  divisions: [{ name: 'J70', races: [{ raceNumber: 7, starts: [{ startTime: gun - 2 * 3_600_000 }] }, { raceNumber: 8, starts: [{ startTime: gun }] }] }],
});
const body = (doc: unknown): string => JSON.stringify({ revisions: [{ doc }] });

describe('live race detection for caching', () => {
  it('sees a gun within the live window (its start sequence included), not one older or still hours off', () => {
    expect(hasLiveGun(docWith(GUN), NOW)).toBe(true);
    expect(hasLiveGun(docWith(GUN), GUN + LIVE_SPAN_MS + 1)).toBe(false);
    // Race 8's sequence under way (race 7 long over): the gun to come is picked up.
    expect(hasLiveGun(docWith(GUN), GUN - 5 * 60_000)).toBe(true);
    // Both guns still over PRE_GUN_MS off.
    expect(hasLiveGun(docWith(GUN), GUN - 2 * 3_600_000 - PRE_GUN_MS - 1)).toBe(false);
    expect(hasLiveGun(null, NOW)).toBe(false);
    expect(hasLiveGun({ divisions: [{ races: [{ starts: [{ startTime: null }] }] }] }, NOW)).toBe(false);
  });
});

describe('edge TTLs (functions/_lib.ts)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps a live regatta document LIVE_TTL, a quiet one 2 min, a finished one 7 days', () => {
    const qs = new URLSearchParams('event=Qn47enc7fKR7Th1Qj1ZI');
    expect(ttlFor('regatta', qs, body(docWith(GUN)))).toBe(LIVE_TTL);
    expect(ttlFor('regatta', qs, body(docWith(GUN - 7 * 3_600_000)))).toBe(120);
    // The next race's sequence under way: short too, so its gun is seen within the minute.
    expect(ttlFor('regatta', qs, body(docWith(NOW + 10 * 60_000)))).toBe(LIVE_TTL);
    expect(ttlFor('regatta', qs, body(docWith(GUN, NOW - 2 * DAY)))).toBe(7 * 86_400);
  });

  it('keeps an open telemetry window or a recent tail short; past windows as before', () => {
    const q = (after: number, before: number): URLSearchParams => new URLSearchParams(`after=${after}&before=${before}`);
    // Race 8 in progress, no finishes: its window runs to gun + 2 h.
    expect(telemetryTtl(q(GUN - 130_000, GUN + 2 * 3_600_000))).toBe(LIVE_TELEMETRY_TTL);
    // A refresh's tail.
    expect(telemetryTtl(q(NOW - 6 * 60_000, GUN - 2 * 3_600_000 + 80 * 60_000))).toBe(LIVE_TELEMETRY_TTL);
    // Race 7, finished this morning: unchanged (1 min while within a day, 7 days after).
    expect(telemetryTtl(q(GUN - 2 * 3_600_000 - 130_000, GUN - 40 * 60_000))).toBe(60);
    expect(telemetryTtl(q(NOW - 3 * DAY, NOW - 2 * DAY))).toBe(7 * 86_400);
  });

  it('keeps a live Yachtscoring ask short only while the event is current, and never sends `live` upstream', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const current = { rows: [{ startTime: '2026-10-19T11:05:00.000Z' }] };
    expect(ysTtl('results', current, now, true)).toBe(LIVE_TTL);
    expect(ysTtl('results', current, now)).toBe(300);
    expect(ysTtl('races', { endDate: '2026-10-11T23:59:59.999Z' }, now, true)).toBe(7 * 86_400);
    const r = buildYsQuery('results', new URLSearchParams('raceNumber=8&live=1'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.qs.toString()).toBe('raceNumber=8&live=1');
    expect(ysUpstreamQuery(r.qs).toString()).toBe('raceNumber=8');
    expect(buildYsQuery('results', new URLSearchParams('raceNumber=8&live=yes')).ok).toBe(false);
    const ev = buildYsQuery('event', new URLSearchParams('live=1'));
    expect(ev.ok && ev.qs.size).toBe(0);
  });
});

describe('client TTLs', () => {
  let served: unknown;
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(served), { status: 200 }));
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps a live regatta document LIVE_REGATTA_TTL_MS; a finished one stays long', async () => {
    vi.setSystemTime(NOW);
    served = { revisions: [{ doc: docWith(GUN) }] } as unknown as RegattaResponse;
    await fetchRegatta('live-ttl-1');
    vi.setSystemTime(NOW + LIVE_REGATTA_TTL_MS - 1000);
    await fetchRegatta('live-ttl-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + LIVE_REGATTA_TTL_MS + 1000);
    await fetchRegatta('live-ttl-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(NOW);
    served = { revisions: [{ doc: docWith(GUN - 3 * DAY, NOW - 2 * DAY) }] };
    await fetchRegatta('live-ttl-2');
    vi.setSystemTime(NOW + 6 * DAY);
    await fetchRegatta('live-ttl-2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('asks Yachtscoring afresh with live=1 only for the live race and its race list', async () => {
    vi.setSystemTime(NOW);
    served = { rows: [] };
    const src = httpYsSource(undefined, { eventId: 50575, raceNumber: 8 });
    await src.races(50575);
    await src.results(50575, 8);
    await src.results(50575, 7);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      '/api/ys/event/50575/races?size=200&live=1',
      '/api/ys/event/50575/result-detail-report?raceNumber=8&live=1',
      '/api/ys/event/50575/result-detail-report?raceNumber=7',
    ]);
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ cache: 'no-cache' }));
    // Again within the TTL: the live ones are asked for again, race 7 comes from the cache.
    await src.races(50575);
    await src.results(50575, 7);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Without `live`, nothing changes.
    await httpYsSource().results(50575, 7);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('a finished race’s telemetry is kept 30 days in the browser only once settled', () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ Fields: ['ts'], Rows: [[1]] }), { status: 200 }));
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  let n = 0;
  const id = (): string => `settled-${++n}`;
  // Race 8: its window ends 30 s after its last finish.
  const after = GUN - 130_000;
  const before = Date.parse('2026-10-31T17:20:00Z');

  it('the rule: the window ended a day before the copy was fetched, or the event did', () => {
    expect(telemetrySettled(before, before + SETTLED_MS + 1)).toBe(true);
    expect(telemetrySettled(before, before + 2 * 3_600_000)).toBe(false);
    expect(telemetrySettled(before, before + 2 * 3_600_000, before - SETTLED_MS - 1)).toBe(true);
    expect(telemetrySettled(before, before + 2 * 3_600_000, before)).toBe(false);
  });

  it('fetched the same afternoon (over in the feed, the feed maybe stalled): a minute, and still a minute days later', async () => {
    const e = id();
    vi.setSystemTime(before + 20 * 60_000);
    await fetchTelemetry(e, 'J70', after, before, { finished: true });
    vi.setSystemTime(before + 22 * 60_000);
    await fetchTelemetry(e, 'J70', after, before, { finished: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Read three days on: that copy was fetched unsettled, so it isn't taken now either.
    const f = id();
    vi.setSystemTime(before + 20 * 60_000);
    await fetchTelemetry(f, 'J70', after, before, { finished: true });
    vi.setSystemTime(before + 3 * DAY);
    await fetchTelemetry(f, 'J70', after, before, { finished: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // …and the copy fetched then (settled) is kept.
    vi.setSystemTime(before + 10 * DAY);
    await fetchTelemetry(f, 'J70', after, before, { finished: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('fetched a day after the window, or after the event is over: kept 30 days', async () => {
    const e = id();
    vi.setSystemTime(before + DAY + 60_000);
    await fetchTelemetry(e, 'J70', after, before, { finished: true });
    vi.setSystemTime(before + 20 * DAY);
    await fetchTelemetry(e, 'J70', after, before, { finished: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(before + 32 * DAY);
    await fetchTelemetry(e, 'J70', after, before, { finished: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The event over a day before the copy was fetched counts on its own.
    const g = id();
    vi.setSystemTime(before + 3 * 3_600_000);
    await fetchTelemetry(g, 'J70', after, before, { finished: true, eventEndMs: before - DAY - 60_000 });
    vi.setSystemTime(before + 5 * DAY);
    await fetchTelemetry(g, 'J70', after, before, { finished: true, eventEndMs: before - DAY - 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('not finished: a minute, settled or not', async () => {
    const e = id();
    vi.setSystemTime(before + 3 * DAY);
    await fetchTelemetry(e, 'J70', after, before);
    vi.setSystemTime(before + 3 * DAY + 2 * 60_000);
    await fetchTelemetry(e, 'J70', after, before);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the edge judges a window the same way (7 days once settled)', () => {
    const q = new URLSearchParams(`after=${after}&before=${before}`);
    expect(telemetryTtl(q, before + SETTLED_MS + 1)).toBe(7 * 86_400);
    expect(telemetryTtl(q, before + 2 * 3_600_000)).toBe(60);
  });
});
