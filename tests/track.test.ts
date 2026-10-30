import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BATCH_MAX, BODY_MAX, SESSION_MAX } from '../functions/_trackSchema';
import { FLUSH_MS, SESSION_KEY, THIN_MS, TRACK_URL, createTracker, deviceClass, raceId, track, type TrackEnvDeps } from '../src/ui/track';
import { trackPoints } from '../functions/_track';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A page for the tracker: a clock, timers run by hand, a fetch that records, sessionStorage in memory. */
function page(over: Partial<TrackEnvDeps> = {}) {
  let now = 1_000_000;
  const sent: { body: string; init: RequestInit }[] = [];
  const timers: (() => void)[] = [];
  const store = new Map<string, string>();
  let leave: (() => void) | null = null;
  const d: TrackEnvDeps = {
    enabled: true,
    now: () => now,
    path: () => '/regattas/start',
    referrer: () => 'https://www.google.com/search?q=recall',
    host: () => 'recall.walkeforward.com',
    theme: () => 'dark',
    device: () => 'mobile',
    storage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }),
    uuid: () => SID,
    fetch: (url, init) => {
      expect(url).toBe(TRACK_URL);
      sent.push({ body: String(init.body), init });
      return Promise.resolve();
    },
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
    optedOut: () => false,
    onLeave: (fn) => (leave = fn),
    ...over,
  };
  const t = createTracker(d);
  return {
    t,
    sent,
    store,
    advance: (ms: number) => (now += ms),
    runTimers: () => timers.splice(0).forEach((f) => f()),
    leave: () => leave?.(),
    batches: () => sent.map((s) => JSON.parse(s.body) as { sid: string; dev: string; th: string; auth: string; ev: Record<string, unknown>[] }),
  };
}

describe('the usage tracker (src/ui/track.ts)', () => {
  it('queues, then sends one batch on the timer, with only the schema keys', () => {
    const p = page();
    p.t.setAuth('no');
    p.t.setPage({ event: 'cbc2026', race: raceId('J/105', 3) });
    p.t.track('race_open');
    p.advance(2_000);
    p.t.track('tab', { detail: 'coach' });
    expect(p.sent).toEqual([]);
    expect(p.t.queued()).toBe(2);
    p.runTimers();
    expect(p.sent).toHaveLength(1);
    const [b] = p.batches();
    expect(Object.keys(b).sort()).toEqual(['auth', 'dev', 'ev', 'sid', 'th']);
    expect(b).toMatchObject({ sid: SID, dev: 'mobile', th: 'dark', auth: 'no' });
    expect(b.ev).toEqual([
      { n: 'race_open', p: '/regattas/start', e: 'cbc2026', r: 'J/105|3', f: 'www.google.com', s: 1, t: 0 },
      { n: 'tab', p: '/regattas/start', e: 'cbc2026', r: 'J/105|3', d: 'coach', s: 2, t: 2000 },
    ]);
    // What it sends is what the server takes.
    expect(trackPoints(b)).toHaveLength(2);
    expect(p.t.queued()).toBe(0);
  });

  it('sends nothing that names a person: no email, name, user id, cookie or query string', () => {
    const p = page({ path: () => '/regattas/coach' });
    p.t.track('signin_done', { detail: 'google' });
    p.t.track('feedback_sent', { detail: 'bug' });
    p.t.flush();
    const body = p.sent[0].body;
    expect(body).not.toMatch(/@|email|name|user|cookie|\?/i);
    for (const e of p.batches()[0].ev) for (const k of Object.keys(e)) expect(['n', 'p', 'e', 'r', 'd', 'f', 's', 't']).toContain(k);
  });

  it('keeps the referrer to its host, on the first event only, and drops our own', () => {
    const p = page();
    p.t.track('app_open');
    p.t.track('tab', { detail: 'race' });
    p.t.flush();
    const [first, second] = p.batches()[0].ev;
    expect(first.f).toBe('www.google.com');
    expect(second.f).toBeUndefined();
    const own = page({ referrer: () => 'https://recall.walkeforward.com/' });
    own.t.track('app_open');
    own.t.flush();
    expect(own.batches()[0].ev[0].f).toBeUndefined();
  });

  it('flushes at once when a batch is full, and on leaving the page', () => {
    const p = page();
    for (let i = 0; i < BATCH_MAX; i++) p.t.track('tab', { detail: `t${i}` });
    expect(p.sent).toHaveLength(1);
    expect(p.batches()[0].ev).toHaveLength(BATCH_MAX);
    p.t.track('report_open');
    p.leave();
    expect(p.sent).toHaveLength(2);
    expect(p.batches()[1].ev.map((e) => e.n)).toEqual(['report_open']);
    expect(FLUSH_MS).toBeLessThanOrEqual(10_000);
  });

  it('splits a batch that would be over the server cap', () => {
    const p = page();
    // ~250 bytes an event: 19 of them are over 4 KB.
    for (let i = 0; i < BATCH_MAX - 1; i++) p.t.track('race_open', { event: `${'x'.repeat(62)}${10 + i}`, race: `${'D'.repeat(46)}|${100000000 + i}`, detail: 'd'.repeat(32) });
    p.t.flush();
    expect(p.sent.length).toBeGreaterThan(1);
    for (const s of p.sent) expect(s.body.length).toBeLessThanOrEqual(BODY_MAX);
    expect(p.batches().reduce((n, b) => n + b.ev.length, 0)).toBe(BATCH_MAX - 1);
  });

  it('thins the scrubber and repeats; one replay_play per press', () => {
    const p = page();
    for (let i = 0; i < 30; i++) {
      p.t.track('replay_scrub');
      p.advance(100);
    }
    p.advance(THIN_MS.replay_scrub!);
    p.t.track('replay_scrub');
    p.t.track('replay_play');
    p.t.track('replay_play');
    p.advance(1_500);
    p.t.track('replay_play');
    p.t.flush();
    expect(p.batches()[0].ev.map((e) => e.n)).toEqual(['replay_scrub', 'replay_scrub', 'replay_play', 'replay_play']);
  });

  it('stops at the per-session cap, which survives a reload (sessionStorage)', () => {
    const p = page();
    for (let i = 0; i < SESSION_MAX + 10; i++) p.t.track('tab', { detail: `t${i}` });
    p.t.flush();
    expect(p.batches().reduce((n, b) => n + b.ev.length, 0)).toBe(SESSION_MAX);
    expect(JSON.parse(p.store.get(SESSION_KEY)!)).toMatchObject({ id: SID, seq: SESSION_MAX });
    // The same tab's next page: the same session, still capped.
    const again = page({ storage: () => ({ getItem: (k) => p.store.get(k) ?? null, setItem: (k, v) => void p.store.set(k, v) }) });
    again.t.track('app_open');
    again.t.flush();
    expect(again.sent).toEqual([]);
  });

  it('carries the session id and count across pages of one tab', () => {
    const store = new Map<string, string>();
    const storage = () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const a = page({ storage });
    a.t.track('landing_view');
    a.t.flush();
    const b = page({ storage, uuid: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    b.t.track('app_open');
    b.t.flush();
    expect(b.batches()[0]).toMatchObject({ sid: SID, ev: [{ n: 'app_open', s: 2 }] });
    expect(b.batches()[0].ev[0].f).toBeUndefined();
  });

  it('honors Do Not Track and Global Privacy Control, and is off unless enabled', () => {
    for (const p of [page({ optedOut: () => true }), page({ enabled: false })]) {
      p.t.track('app_open');
      p.t.flush();
      p.leave();
      expect(p.sent).toEqual([]);
      expect(p.store.size).toBe(0);
    }
    // In tests the page's own tracker is off.
    expect(() => track('app_open')).not.toThrow();
  });

  it('never throws: storage, fetch and the rest missing or throwing', () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const p = page({
      storage: boom,
      fetch: boom,
      referrer: boom,
      theme: boom,
      device: boom,
      path: boom,
      optedOut: () => false,
      onLeave: boom,
    });
    expect(() => {
      p.t.track('app_open');
      p.t.track('tab', { detail: 'coach' });
      p.t.flush();
    }).not.toThrow();
    const none = page({ fetch: null, storage: () => null });
    expect(() => {
      none.t.track('app_open');
      none.t.flush();
    }).not.toThrow();
    const rejects = page({ fetch: () => Promise.reject(new Error('offline')) });
    rejects.t.track('app_open');
    expect(() => rejects.t.flush()).not.toThrow();
    // An unusable storage reading: a fresh session, not an error.
    const junk = page({ storage: () => ({ getItem: () => '{not json', setItem: boom }) });
    expect(() => junk.t.track('app_open')).not.toThrow();
    junk.t.flush();
    expect(junk.batches()[0].sid).toBe(SID);
  });

  it('sends each batch by fetch with keepalive, no credentials and a JSON body, on the timer and on leaving', () => {
    const p = page();
    p.t.track('app_open');
    p.t.flush();
    p.t.track('tab', { detail: 'race' });
    p.leave();
    expect(p.sent).toHaveLength(2);
    for (const s of p.sent) {
      expect(s.init).toEqual({ method: 'POST', keepalive: true, credentials: 'omit', headers: { 'content-type': 'application/json' }, body: s.body });
      // Inside keepalive's 64 KB (for all requests in flight together) with room to spare.
      expect(new TextEncoder().encode(s.body).length).toBeLessThanOrEqual(BODY_MAX);
    }
    expect(BODY_MAX).toBeLessThan(64 * 1024);
  });

  it('never calls sendBeacon (it would send cookies), even where the browser has it', () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { ...globalThis.navigator, sendBeacon });
    try {
      const p = page();
      p.t.track('app_open');
      p.leave();
      expect(p.sent).toHaveLength(1);
      expect(sendBeacon).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(readFileSync(new URL('../src/ui/track.ts', import.meta.url), 'utf8')).not.toMatch(/\.sendBeacon\(/);
  });

  it('a fetch that throws or rejects on leaving loses the batch, never the page', () => {
    const throws = page({
      fetch: () => {
        throw new TypeError('keepalive quota');
      },
    });
    throws.t.track('app_open');
    expect(() => throws.leave()).not.toThrow();
    expect(throws.t.queued()).toBe(0);
  });

  it('leaves out a field the server would refuse, rather than lose the batch', () => {
    const p = page({ path: () => '/regattas/start%20x' });
    p.t.track('tab', { detail: 'Not A Detail!', event: 'bad id', race: 'no-bar' });
    p.t.flush();
    const [e] = p.batches()[0].ev;
    expect(e).toMatchObject({ n: 'tab', p: '/other' });
    expect(e.d).toBeUndefined();
    expect(e.e).toBeUndefined();
    expect(e.r).toBeUndefined();
    expect(trackPoints(p.batches()[0])).toHaveLength(1);
  });

  it('device classes and race ids', () => {
    expect(deviceClass({ coarse: false, shortSide: 390 })).toBe('desktop');
    expect(deviceClass({ coarse: true, shortSide: 390 })).toBe('mobile');
    expect(deviceClass({ coarse: true, shortSide: 820 })).toBe('tablet');
    expect(raceId('ORC A|B', 4)).toBe('ORC A B|4');
  });
});
