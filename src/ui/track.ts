/**
 * Usage events for POST /api/track (functions/_track.ts; the schema is functions/_trackSchema.ts). Anonymous:
 * a random session id in sessionStorage (this tab only, gone when it closes), no cookies, nothing in
 * localStorage, no names, emails or user ids. Do Not Track or Global Privacy Control turns it off. Off in
 * dev and tests unless VITE_TRACK=1.
 *
 * Events wait in a queue and go in batches: a few seconds after the first, as soon as a batch is full, and
 * when the page is hidden or left (navigator.sendBeacon, else fetch with keepalive). Noisy ones are thinned
 * (replay_scrub at most once every few seconds; the same event twice within a second counts once) and a
 * session stops at SESSION_MAX. Nothing here throws or waits: a failure loses the events, never the page.
 * No imports from the app: the landing page loads this too.
 */
import {
  BATCH_MAX,
  BODY_MAX,
  DETAIL_RE,
  EVENT_ID_RE,
  HOST_RE,
  PATH_RE,
  RACE_ID_RE,
  SESSION_MAX,
  SESSION_MS_MAX,
  SID_RE,
  type Auth,
  type Device,
  type TrackEvent,
} from '../../functions/_trackSchema';

export type { TrackEvent } from '../../functions/_trackSchema';

export const TRACK_URL = '/api/track';
export const SESSION_KEY = 'recall.track';
export const FLUSH_MS = 5_000;
/** The same event (name, detail, race) again within this: counted once. */
export const REPEAT_MS = 1_000;
/** At most one of these in each window, ms. */
export const THIN_MS: Partial<Record<TrackEvent, number>> = { replay_scrub: 5_000 };

export interface TrackFields {
  /** A RaceSense event id (default: the page's, setTrackPage). */
  event?: string;
  /** `<division>|<race number>` (default: the page's). */
  race?: string;
  /** A short detail: a tab, a provider, a theme (lower case, digits, `_` and `-`). */
  detail?: string;
}

interface Wire {
  n: TrackEvent;
  p: string;
  e?: string;
  r?: string;
  d?: string;
  f?: string;
  s: number;
  t: number;
}

interface Session {
  id: string;
  t0: number;
  seq: number;
}

/** Everything the tracker touches, so tests can swap any of it (or make it throw). */
export interface TrackEnvDeps {
  enabled: boolean;
  now: () => number;
  path: () => string;
  /** `document.referrer` (read once, for the session's first event). */
  referrer: () => string;
  host: () => string;
  theme: () => string;
  device: () => Device;
  storage: () => Pick<Storage, 'getItem' | 'setItem'> | null;
  uuid: () => string;
  beacon: ((url: string, body: string) => boolean) | null;
  fetch: ((url: string, init: RequestInit) => Promise<unknown>) | null;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Do Not Track or Global Privacy Control. */
  optedOut: () => boolean;
  /** Called with a function to run when the page is hidden or left. */
  onLeave: (fn: () => void) => void;
}

export interface Tracker {
  track(name: TrackEvent, f?: TrackFields): void;
  /** The event and race on screen, added to every event that doesn't name its own. */
  setPage(p: { event?: string | null; race?: string | null }): void;
  setAuth(a: Auth): void;
  flush(): void;
  /** The queue's length (tests). */
  queued(): number;
}

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export function createTracker(d: TrackEnvDeps): Tracker {
  const on = d.enabled && !safe(d.optedOut, true);
  let session: Session | null = null;
  let page: { event?: string; race?: string } = {};
  let auth: Auth = 'unknown';
  let queue: Wire[] = [];
  let timer: unknown = null;
  const last = new Map<string, number>();

  const loadSession = (): Session => {
    if (session) return session;
    const st = safe(d.storage, null);
    const raw = st ? safe(() => st.getItem(SESSION_KEY), null) : null;
    const old = raw ? safe(() => JSON.parse(raw) as Session, null) : null;
    if (old && typeof old.id === 'string' && SID_RE.test(old.id) && Number.isFinite(old.t0) && Number.isInteger(old.seq)) session = old;
    else session = { id: safe(d.uuid, ''), t0: d.now(), seq: 0 };
    return session;
  };
  const saveSession = (s: Session): void => {
    const st = safe(d.storage, null);
    if (st) safe(() => st.setItem(SESSION_KEY, JSON.stringify(s)), undefined);
  };
  const refHost = (): string => {
    const r = safe(d.referrer, '');
    if (!r) return '';
    const h = safe(() => new URL(r).hostname.toLowerCase(), '');
    return h && h !== safe(d.host, '') ? h : '';
  };

  /** A beacon when there is one (it outlives the page); else fetch with keepalive. */
  const send = (body: string): void => {
    if (d.beacon && safe(() => d.beacon!(TRACK_URL, body), false)) return;
    if (!d.fetch) return;
    safe(() => {
      const p = d.fetch!(TRACK_URL, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'content-type': 'text/plain;charset=UTF-8' } });
      (p as Promise<unknown>)?.catch?.(() => undefined);
    }, undefined);
  };

  const flush = (): void => {
    if (timer != null) safe(() => d.clearTimer(timer), undefined);
    timer = null;
    if (!queue.length || !session) return;
    const head = { sid: session.id, dev: safe(d.device, 'desktop' as Device), th: safe(d.theme, '') === 'dark' ? 'dark' : 'light', auth };
    while (queue.length) {
      let n = Math.min(queue.length, BATCH_MAX);
      let body = JSON.stringify({ ...head, ev: queue.slice(0, n) });
      // Over the server's cap: fewer events a time (one that never fits is dropped).
      while (body.length > BODY_MAX && n > 1) body = JSON.stringify({ ...head, ev: queue.slice(0, --n) });
      if (body.length <= BODY_MAX) send(body);
      queue = queue.slice(n);
    }
  };

  const track = (name: TrackEvent, f: TrackFields = {}): void => {
    if (!on) return;
    try {
      const now = d.now();
      const e = f.event ?? page.event;
      const r = f.race ?? page.race;
      const thin = THIN_MS[name];
      const key = thin ? name : `${name}|${f.detail ?? ''}|${e ?? ''}|${r ?? ''}`;
      const prev = last.get(key);
      if (prev != null && now - prev < (thin ?? REPEAT_MS)) return;
      last.set(key, now);
      const s = loadSession();
      const t = Math.max(0, Math.round(now - s.t0));
      if (!SID_RE.test(s.id) || s.seq >= SESSION_MAX || t > SESSION_MS_MAX) return;
      s.seq += 1;
      saveSession(s);
      const path = safe(d.path, '/');
      // The server refuses a batch with any malformed part: a field that doesn't fit is left out instead.
      const w: Wire = { n: name, p: PATH_RE.test(path) ? path : '/other', s: s.seq, t };
      if (e && EVENT_ID_RE.test(e)) w.e = e;
      if (r && RACE_ID_RE.test(r)) w.r = r;
      if (f.detail && DETAIL_RE.test(f.detail)) w.d = f.detail;
      if (s.seq === 1) {
        const h = refHost();
        if (h && HOST_RE.test(h)) w.f = h;
      }
      queue.push(w);
      if (queue.length >= BATCH_MAX) flush();
      else if (timer == null) timer = d.setTimer(() => flush(), FLUSH_MS);
    } catch {
      // never the page's problem
    }
  };

  if (on) safe(() => d.onLeave(flush), undefined);

  return {
    track,
    setPage(p) {
      page = { ...(p.event ? { event: p.event } : {}), ...(p.race ? { race: p.race } : {}) };
    },
    setAuth(a) {
      auth = a;
    },
    flush,
    queued: () => queue.length,
  };
}

/** Phone, tablet or desktop: a coarse pointer on a small screen, a coarse one on a larger, else a desktop. */
export function deviceClass(o: { coarse: boolean; shortSide: number }): Device {
  if (!o.coarse) return 'desktop';
  return o.shortSide < 600 ? 'mobile' : 'tablet';
}

/** `<division>|<race number>`, as the schema's race id. */
export const raceId = (division: string, raceNumber: number): string => `${division.replace(/[|<>\p{Cc}]/gu, ' ').trim().slice(0, 48)}|${raceNumber}`;

function browserDeps(): TrackEnvDeps {
  const g = globalThis as typeof globalThis & { doNotTrack?: string };
  const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as (Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string }) | undefined;
  return {
    enabled: typeof window !== 'undefined' && (import.meta.env.PROD || import.meta.env.VITE_TRACK === '1') && import.meta.env.MODE !== 'test',
    now: () => Date.now(),
    path: () => location.pathname,
    referrer: () => document.referrer,
    host: () => location.hostname.toLowerCase(),
    theme: () => document.documentElement.getAttribute('data-theme') ?? '',
    device: () => deviceClass({ coarse: matchMedia('(pointer: coarse)').matches, shortSide: Math.min(screen.width, screen.height) }),
    storage: () => sessionStorage,
    uuid: () => crypto.randomUUID(),
    beacon: nav && typeof nav.sendBeacon === 'function' ? (url, body) => nav.sendBeacon(url, body) : null,
    fetch: typeof fetch === 'function' ? (url, init) => fetch(url, init) : null,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    optedOut: () => nav?.doNotTrack === '1' || g.doNotTrack === '1' || nav?.msDoNotTrack === '1' || nav?.globalPrivacyControl === true,
    onLeave: (fn) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') fn();
      });
      addEventListener('pagehide', fn);
    },
  };
}

/** Tracking off: what a page gets when the browser's own deps can't be read. */
const offDeps: TrackEnvDeps = {
  enabled: false,
  now: () => 0,
  path: () => '/',
  referrer: () => '',
  host: () => '',
  theme: () => '',
  device: () => 'desktop',
  storage: () => null,
  uuid: () => '',
  beacon: null,
  fetch: null,
  setTimer: () => null,
  clearTimer: () => undefined,
  optedOut: () => true,
  onLeave: () => undefined,
};

let tracker: Tracker | null = null;
const the = (): Tracker => (tracker ??= createTracker(safe(browserDeps, { ...offDeps })));

/** Count a usage event (a no-op when tracking is off). Never throws. */
export function track(name: TrackEvent, f?: TrackFields): void {
  safe(() => the().track(name, f), undefined);
}

/** The event and race on screen now (null: none), added to later events. */
export function setTrackPage(p: { event?: string | null; race?: string | null }): void {
  safe(() => the().setPage(p), undefined);
}

/** Signed in or not, for later events. */
export function setTrackAuth(a: Auth): void {
  safe(() => the().setAuth(a), undefined);
}
