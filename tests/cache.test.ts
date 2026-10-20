import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY, MINUTE } from '../src/data/cache';
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
