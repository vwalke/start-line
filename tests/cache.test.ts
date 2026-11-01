import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_TIMEOUT_MS, DAY, MINUTE, cachedJson, cachedJsonFrom } from '../src/data/cache';
import { fetchRegatta, fetchUsableRegatta } from '../src/data/racesense/api';
import type { RegattaResponse } from '../src/data/racesense/types';

// The J105 CBC case: endDate is midnight at the start of the last race day.
const END = Date.UTC(2026, 9, 18);
const regatta = (finished: boolean): RegattaResponse =>
  ({ revisions: [{ doc: { endDate: END, finished } }] }) as unknown as RegattaResponse;
const isFinished = (r: RegattaResponse): boolean => !!(r.revisions?.at(-1)?.doc as { finished?: boolean } | undefined)?.finished;

// The in-memory cache is module-wide, so each test uses its own event id.
let n = 0;
const eventId = (): string => `cache-test-${++n}`;

let served: RegattaResponse;
const fetchMock = vi.fn(async () => new Response(JSON.stringify(served), { status: 200 }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('regatta cache TTL', () => {
  it('keeps a copy fetched during the event short-lived after the event ends', async () => {
    const id = eventId();
    vi.setSystemTime(END + 12 * 60 * MINUTE); // race day, no finishers yet
    served = regatta(false);
    await fetchRegatta(id);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(END + 1 * MINUTE + 12 * 60 * MINUTE); // still within 2 minutes: cached
    await fetchRegatta(id);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(END + 2 * DAY); // event over; the mid-event copy must not become fresh
    served = regatta(true);
    expect(isFinished(await fetchRegatta(id))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives a copy fetched more than a day after the end the long TTL', async () => {
    const id = eventId();
    vi.setSystemTime(END + 2 * DAY);
    served = regatta(true);
    await fetchRegatta(id);
    vi.setSystemTime(END + 8 * DAY);
    await fetchRegatta(id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(END + 9 * DAY + MINUTE); // past 7 days from the fetch
    await fetchRegatta(id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips cached copies with fresh, but stores the result', async () => {
    const id = eventId();
    vi.setSystemTime(END + 2 * DAY);
    served = regatta(false);
    await fetchRegatta(id);
    served = regatta(true);
    expect(isFinished(await fetchRegatta(id, undefined, { fresh: true }))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual([expect.any(String), expect.objectContaining({ cache: 'no-cache' })]);
    expect(isFinished(await fetchRegatta(id))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchUsableRegatta', () => {
  it('refetches once from the network when the cached copy has no finished races', async () => {
    const id = eventId();
    vi.setSystemTime(END + 2 * DAY);
    served = regatta(false);
    await fetchRegatta(id); // cached, unusable copy
    served = regatta(true);
    expect(isFinished(await fetchUsableRegatta(id, isFinished))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries only once when the network copy is unusable too', async () => {
    const id = eventId();
    vi.setSystemTime(END + 2 * DAY);
    served = regatta(false);
    await fetchRegatta(id);
    expect(isFinished(await fetchUsableRegatta(id, isFinished))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not refetch a copy that just came from the network', async () => {
    vi.setSystemTime(END + 2 * DAY);
    served = regatta(false);
    expect(isFinished(await fetchUsableRegatta(eventId(), isFinished))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refetch a usable cached copy', async () => {
    const id = eventId();
    vi.setSystemTime(END + 2 * DAY);
    served = regatta(true);
    await fetchRegatta(id);
    await fetchUsableRegatta(id, isFinished);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a ttl-0 body (a live race’s tail page) is kept nowhere', () => {
  it('skips the in-memory map and Cache Storage; a body with a ttl is kept in both', async () => {
    const put = vi.fn(async () => undefined);
    vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined, put }), delete: async () => true });
    served = regatta(false);
    const tail = `/api/telemetry/event/ttl0-${++n}?after=1&before=2`;
    await cachedJson(tail, 0);
    // Read again as if it could live a day: nothing held, so it's fetched again.
    await cachedJson(tail, DAY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    const kept = `/api/telemetry/event/ttl1-${++n}?after=1&before=2`;
    await cachedJson(kept, MINUTE);
    await cachedJson(kept, MINUTE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe('a stuck Cache API (WebKit) falls back to the network', () => {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  const url = (): string => `/api/regatta/stuck-${++n}`;
  /** Lets the pending promise chain run, without moving the clock. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('fetches once caches.open has hung for CACHE_TIMEOUT_MS, and not before', async () => {
    vi.stubGlobal('caches', { open: () => never<Cache>(), delete: async () => true });
    served = regatta(true);
    const got = cachedJsonFrom<RegattaResponse>(url(), DAY);
    await vi.advanceTimersByTimeAsync(CACHE_TIMEOUT_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await got).toEqual({ body: served, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches once cache.match has hung for CACHE_TIMEOUT_MS, and still stores the copy', async () => {
    const put = vi.fn(async () => undefined);
    vi.stubGlobal('caches', { open: async () => ({ match: () => never<Response | undefined>(), put }), delete: async () => true });
    served = regatta(true);
    const got = cachedJsonFrom<RegattaResponse>(url(), DAY);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CACHE_TIMEOUT_MS);
    expect(await got).toEqual({ body: served, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('does not wait on cache.put', async () => {
    vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined, put: () => never<void>() }), delete: async () => true });
    served = regatta(true);
    const got = cachedJsonFrom<RegattaResponse>(url(), DAY);
    await settle();
    let done = false;
    void got.then(() => (done = true));
    await settle();
    expect(done).toBe(true);
  });

  it('drops a late failure without an unhandled rejection', async () => {
    const late = <T>(): Promise<T> => new Promise<T>((_, reject) => setTimeout(() => reject(new Error('late')), 2 * CACHE_TIMEOUT_MS));
    vi.stubGlobal('caches', { open: async () => ({ match: () => late<Response | undefined>(), put: async () => undefined }), delete: async () => true });
    served = regatta(true);
    const got = cachedJsonFrom<RegattaResponse>(url(), DAY);
    await vi.advanceTimersByTimeAsync(3 * CACHE_TIMEOUT_MS);
    expect((await got).cached).toBe(false);
  });

  it('still answers from a quick Cache Storage hit without a fetch', async () => {
    vi.setSystemTime(END + 2 * DAY);
    const body = regatta(true);
    const hit = (): Response => new Response(JSON.stringify(body), { headers: { 'x-start-line-fetched-at': String(Date.now() - MINUTE) } });
    vi.stubGlobal('caches', { open: async () => ({ match: async () => hit(), put: async () => undefined }), delete: async () => true });
    expect(await cachedJsonFrom<RegattaResponse>(url(), DAY)).toEqual({ body, cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
