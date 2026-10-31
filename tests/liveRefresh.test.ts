import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_SPAN_MS, raceLive, unaccountedBoats, type RaceLiveFacts } from '../src/data/live';
import { buildRaceData, parseTelemetry, telemetryWindow, currentDoc } from '../src/data/racesense/adapter';
import { fetchTelemetry } from '../src/data/racesense/api';
import { TAIL_BUCKET_MS, TAIL_OVERLAP_MS, canTail, joinTail, pagesLastTs, tailAfter } from '../src/data/racesense/tail';
import type { TelemetryPage } from '../src/data/racesense/types';
import {
  LIVE_END_SLACK_MS,
  LIVE_EVERY_MS,
  LIVE_MAX_BACKOFF_MS,
  LIVE_VISIBLE_GAP_MS,
  liveDelay,
  liveLabel,
  liveScrubT,
  liveView,
  startLivePoller,
  type LiveTick,
} from '../src/ui/live';
import { fitView, viewBox } from '../src/ui/view';
import { loadFixture } from './helpers';

const GUN = Date.parse('2026-10-31T15:25:01Z');
const facts = (f: Partial<RaceLiveFacts> = {}): RaceLiveFacts => ({
  gunMs: GUN,
  feedFinished: false,
  eventOver: false,
  unaccounted: 12,
  officialWanted: true,
  officialIn: false,
  ...f,
});

describe('a race in progress (raceLive)', () => {
  const now = GUN + 20 * 60_000;
  it('is live from its gun while incomplete, within the span', () => {
    expect(raceLive(facts(), now)).toBe(true);
    expect(raceLive(facts(), GUN - 1)).toBe(false);
    expect(raceLive(facts(), GUN + LIVE_SPAN_MS)).toBe(false);
    expect(raceLive(facts({ eventOver: true }), now)).toBe(false);
  });

  it('stays live until over in the feed, every boat accounted for and the official results in', () => {
    // Boats finishing, the feed not stopped yet (no endTime).
    expect(raceLive(facts({ unaccounted: 3 }), now)).toBe(true);
    // Over in the feed (race 7: endTime set), a boat still without a finish or a code.
    expect(raceLive(facts({ feedFinished: true, unaccounted: 1 }), now)).toBe(true);
    // Every boat finished, the official results not posted yet.
    expect(raceLive(facts({ feedFinished: true, unaccounted: 0 }), now)).toBe(true);
    expect(raceLive(facts({ feedFinished: true, unaccounted: 0, officialIn: true }), now)).toBe(false);
    // A division with no official results: done with the feed.
    expect(raceLive(facts({ feedFinished: true, unaccounted: 0, officialWanted: false }), now)).toBe(false);
  });

  it('counts boats racing with neither a finish nor a code', () => {
    const boats = [
      { colorSlot: 0, finishMs: 1 },
      { colorSlot: 1, finishMs: null, finishCode: 'DNF' },
      { colorSlot: 2, finishMs: null },
      { colorSlot: -1, finishMs: null },
    ];
    expect(unaccountedBoats(boats)).toBe(1);
  });
});

describe('the live poller', () => {
  let hidden = false;
  let listeners: (() => void)[] = [];
  const setHidden = (h: boolean): void => {
    hidden = h;
    for (const l of listeners) l();
  };
  const deps = (tick: () => Promise<LiveTick>) => ({
    tick,
    hidden: () => hidden,
    onVisibility: (cb: () => void) => {
      listeners.push(cb);
      return () => (listeners = listeners.filter((l) => l !== cb));
    },
  });
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    listeners = [];
  });
  afterEach(() => vi.useRealTimers());

  it('refreshes every minute, the first a minute after the start', async () => {
    const tick = vi.fn(async (): Promise<LiveTick> => 'more');
    const p = startLivePoller(deps(tick));
    await vi.advanceTimersByTimeAsync(LIVE_EVERY_MS - 1);
    expect(tick).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * LIVE_EVERY_MS);
    expect(tick).toHaveBeenCalledTimes(4);
    p.stop();
    await vi.advanceTimersByTimeAsync(5 * LIVE_EVERY_MS);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(listeners).toHaveLength(0);
  });

  it('stops by itself once the race is complete', async () => {
    let n = 0;
    const tick = vi.fn(async (): Promise<LiveTick> => (++n >= 2 ? 'done' : 'more'));
    const p = startLivePoller(deps(tick));
    await vi.advanceTimersByTimeAsync(10 * LIVE_EVERY_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(p.stopped()).toBe(true);
  });

  it('pauses while hidden and refreshes at once when shown again', async () => {
    const tick = vi.fn(async (): Promise<LiveTick> => 'more');
    startLivePoller(deps(tick));
    await vi.advanceTimersByTimeAsync(LIVE_EVERY_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * LIVE_EVERY_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    // …and carries on each minute.
    await vi.advanceTimersByTimeAsync(LIVE_EVERY_MS);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('shown again just after a refresh: waits its turn', async () => {
    const tick = vi.fn(async (): Promise<LiveTick> => 'more');
    startLivePoller(deps(tick));
    await vi.advanceTimersByTimeAsync(LIVE_EVERY_MS);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(LIVE_VISIBLE_GAP_MS / 2);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_EVERY_MS - LIVE_VISIBLE_GAP_MS / 2);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('backs off on errors (1, 2, 4, 5 min) and resets on success', async () => {
    expect([0, 1, 2, 3, 6].map((f) => liveDelay(f))).toEqual([60_000, 120_000, 240_000, LIVE_MAX_BACKOFF_MS, LIVE_MAX_BACKOFF_MS]);
    let fail = true;
    const at: number[] = [];
    const start = Date.now();
    const tick = vi.fn(async (): Promise<LiveTick> => {
      at.push(Date.now() - start);
      if (fail) throw new Error('503');
      return 'more';
    });
    startLivePoller(deps(tick));
    await vi.advanceTimersByTimeAsync(60_000 + 120_000 + 240_000);
    expect(at).toEqual([60_000, 180_000, 420_000]);
    fail = false;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(at.at(-1)).toBe(720_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(at.at(-1)).toBe(780_000);
  });

  it('never runs two refreshes at once', async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(() => new Promise<LiveTick>((r) => (release = () => r('more'))));
    startLivePoller(deps(tick));
    await vi.advanceTimersByTimeAsync(LIVE_EVERY_MS);
    setHidden(true);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(5 * LIVE_EVERY_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(LIVE_EVERY_MS);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});

describe('telemetry tail', () => {
  const f = loadFixture();
  const doc = currentDoc(f.regatta);
  const ref = { division: 'J70', raceNumber: 8 };
  const win = telemetryWindow(doc, ref);
  const ts = f.telemetry.Fields!.indexOf('ts');
  const rows = f.telemetry.Rows!;
  const page = (rs: typeof rows): TelemetryPage => ({ Fields: f.telemetry.Fields, Rows: rs });
  const last = pagesLastTs([f.telemetry])!;

  it('starts a tail five minutes before the last fix held, on a minute', () => {
    const t = Date.parse('2026-10-31T15:47:23.400Z');
    expect(tailAfter(t, { after: 0, before: Infinity })).toBe(Date.parse('2026-10-31T15:42:00Z'));
    expect(tailAfter(t, { after: 0, before: Infinity }) % TAIL_BUCKET_MS).toBe(0);
    expect(tailAfter(null, win)).toBe(win.after);
    expect(tailAfter(win.after + 1000, win)).toBe(win.after);
    expect(canTail(win, { ...win, before: win.before + 60_000 })).toBe(true);
    expect(canTail(win, { ...win, before: win.before - 60_000 })).toBe(false);
    expect(canTail(win, { ...win, after: win.after + 1 })).toBe(false);
  });

  it('joined to the pages held, reads as one fetch of the whole window', () => {
    // Held: the first half of the window's fixes; the tail: from 5 min (floored) before the last fix held, as fetched.
    const cut = Math.floor((win.after + last) / 2);
    const held = [page(rows.filter((r) => Number(r[ts]) <= cut))];
    const from = tailAfter(pagesLastTs(held), win);
    expect(from === win.after || pagesLastTs(held)! - from >= TAIL_OVERLAP_MS).toBe(true);
    const tail = [page(rows.filter((r) => Number(r[ts]) > from))];
    const joined = joinTail(held, tail, from);
    expect(parseTelemetry(joined)).toEqual(parseTelemetry([f.telemetry]));
    // The overlap isn't kept twice.
    expect(joined.reduce((n, p) => n + (p.Rows?.length ?? 0), 0)).toBe(rows.length);
    const opts = { eventId: f.eventId, kind: 'fixture' as const, wind: f.wind };
    expect(buildRaceData(f.regatta, ref, joined, opts)).toEqual(buildRaceData(f.regatta, ref, [f.telemetry], opts));
  });

  it('picks up a fix uploaded late within the overlap', () => {
    const cut = Math.floor((win.after + last) / 2);
    const late = rows.find((r) => Number(r[ts]) > cut - 2 * 60_000 && Number(r[ts]) <= cut)!;
    const held = [page(rows.filter((r) => Number(r[ts]) <= cut && r !== late))];
    const from = tailAfter(pagesLastTs(held), win);
    const joined = joinTail(held, [page(rows.filter((r) => Number(r[ts]) > from))], from);
    // The same fixes; the late one comes after the others of its moment (each boat's own order is unchanged).
    const key = (r: { ts: number; sn: number; role: string }): string => `${r.ts}|${r.sn}|${r.role}`;
    const sorted = (pages: TelemetryPage[]) => parseTelemetry(pages).sort((p, q) => (key(p) < key(q) ? -1 : 1));
    expect(sorted(joined)).toEqual(sorted([f.telemetry]));
  });

  describe('fetching', () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ Fields: ['ts'], Rows: [[1]] }), { status: 200 }));
    beforeEach(() => {
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    it('asks for a tail past the caches, every time; a usual fetch is cached', async () => {
      await fetchTelemetry('tail-test', 'J70', 1_792_000_000_000, 1_792_000_600_000, { tail: true });
      await fetchTelemetry('tail-test', 'J70', 1_792_000_000_000, 1_792_000_600_000, { tail: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ cache: 'no-cache' }));
      await fetchTelemetry('tail-test-2', 'J70', 1_792_000_000_000, 1_792_000_600_000);
      await fetchTelemetry('tail-test-2', 'J70', 1_792_000_000_000, 1_792_000_600_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await fetchTelemetry('tail-test-2', 'J70', 1_792_000_000_000, 1_792_000_600_000, { fresh: true });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});

describe('keeping the view across a refresh (swapLive)', () => {
  const end = GUN + 40 * 60_000;
  const next = { t0: GUN - 60_000, t1: end + 60_000 };
  it('the scrubber follows the new end when at the end, else keeps its time; off stays off', () => {
    expect(liveScrubT(end, end, next)).toBe(next.t1);
    expect(liveScrubT(end - LIVE_END_SLACK_MS + 1, end, next)).toBe(next.t1);
    expect(liveScrubT(GUN + 10 * 60_000, end, next)).toBe(GUN + 10 * 60_000);
    expect(liveScrubT(null, end, next)).toBe(null);
  });

  it('the map at Fit refits to the grown box; zoomed in, it keeps its centre and the width it shows', () => {
    const from = { x0: 0, y0: 0, x1: 1000, y1: 600 };
    const to = { x0: -100, y0: 0, x1: 1100, y1: 720 };
    expect(liveView(from, fitView(from), to)).toEqual(fitView(to));
    const v = { cx: 400, cy: 300, k: 4 };
    const kept = liveView(from, v, to);
    expect(kept.cx).toBe(400);
    expect(kept.cy).toBe(300);
    expect(viewBox(to, kept).w).toBeCloseTo(viewBox(from, v).w);
  });

  it('labels the update in the race’s local time', () => {
    // 11:32 EDT.
    expect(liveLabel(Date.parse('2026-10-31T15:32:40Z'), -4 * 3_600_000)).toBe('Live · updated 11:32');
  });
});
