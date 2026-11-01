/**
 * Polite client-side caching: an in-memory map backed by the Cache API
 * (when available) so a revisit of a finished race costs no requests.
 * Each entry records when it was fetched; the caller decides freshness.
 *
 * Large telemetry pages (~100k rows) skip the in-memory map so a 5 Hz race
 * does not pin tens of megabytes in the worker. The Cache API still holds
 * them for a later visit.
 */
const CACHE_NAME = 'start-line-v2';
/** Older caches whose entries could be wrongly fresh (TTL judged by the read time). */
const OLD_CACHES = ['start-line-v1'];
const FETCHED_AT = 'x-start-line-fetched-at';
const MEMORY_ENTRY_MAX = 750_000;
const MEMORY_TOTAL_MAX = 4_000_000;
/**
 * How long opening Cache Storage, or a read from it, may take before it counts as no cache: a stuck Cache
 * API (a known WebKit failure) then costs a short wait and a network fetch instead of a page that never loads.
 */
export const CACHE_TIMEOUT_MS = 2000;

const memory = new Map<string, { at: number; body: unknown; bytes: number }>();
let memoryBytes = 0;

function remember(url: string, at: number, body: unknown, bytes: number): void {
  if (bytes > MEMORY_ENTRY_MAX) return;
  const prev = memory.get(url);
  if (prev) {
    memory.delete(url);
    memoryBytes -= prev.bytes;
  }
  while (memoryBytes + bytes > MEMORY_TOTAL_MAX && memory.size) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    const ev = memory.get(oldest);
    memory.delete(oldest);
    if (ev) memoryBytes -= ev.bytes;
  }
  memory.set(url, { at, body, bytes });
  memoryBytes += bytes;
}

function touch(url: string, entry: { at: number; body: unknown; bytes: number }): void {
  memory.delete(url);
  memory.set(url, entry);
}

let purged = false;
function purgeOldCaches(): void {
  if (purged) return;
  purged = true;
  try {
    if (typeof caches === 'undefined') return;
    for (const name of OLD_CACHES) caches.delete(name).catch(() => undefined);
  } catch {
    /* best-effort */
  }
}

/** `p`, or `fallback` if it fails or takes longer than CACHE_TIMEOUT_MS (a late answer or failure is dropped). */
function orAfterTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), CACHE_TIMEOUT_MS);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(fallback)),
    );
  });
}

async function openCache(): Promise<Cache | null> {
  purgeOldCaches();
  try {
    return typeof caches === 'undefined' ? null : await orAfterTimeout(caches.open(CACHE_NAME), null);
  } catch {
    return null; // e.g. insecure context or storage disabled
  }
}

/** Freshness in ms, possibly from the body and when that copy was fetched (not when it's read). */
export type Ttl = number | ((body: unknown, fetchedAt: number) => number);

export interface CacheOpts {
  signal?: AbortSignal;
  /** Skip the memory and Cache Storage reads (still stores the result). */
  fresh?: boolean;
}

/**
 * GET JSON with caching, reporting whether the body came from a cached copy.
 * `ttlMs` may depend on the body (e.g. long for a finished event) and is
 * evaluated with the copy's own fetch time.
 */
export async function cachedJsonFrom<T>(url: string, ttlMs: Ttl, opts: CacheOpts = {}): Promise<{ body: T; cached: boolean }> {
  const now = Date.now();
  const ttl = (body: unknown, at: number): number => (typeof ttlMs === 'function' ? ttlMs(body, at) : ttlMs);
  const mem = opts.fresh ? undefined : memory.get(url);
  if (mem && now - mem.at < ttl(mem.body, mem.at)) {
    touch(url, mem);
    return { body: mem.body as T, cached: true };
  }

  const cache = await openCache();
  if (cache && !opts.fresh) {
    try {
      const hit = await orAfterTimeout(cache.match(url), undefined);
      if (hit) {
        const at = Number(hit.headers.get(FETCHED_AT) ?? 0);
        const text = await hit.text();
        const body: unknown = JSON.parse(text);
        if (now - at < ttl(body, at)) {
          remember(url, at, body, text.length);
          return { body: body as T, cached: true };
        }
      }
    } catch {
      /* corrupt entry: refetch */
    }
  }

  const res = await fetch(url, {
    signal: opts.signal,
    headers: { accept: 'application/json' },
    ...(opts.fresh ? { cache: 'no-cache' as const } : {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();
  const body = JSON.parse(text) as T;
  // A ttl of 0 (a live race's tail, a new URL each minute) is kept nowhere.
  const keep = ttl(body, now) > 0;
  if (keep) remember(url, now, body, text.length);
  if (cache && keep) {
    const stored = new Response(text, { headers: { 'content-type': 'application/json', [FETCHED_AT]: String(now) } });
    cache.put(url, stored).catch(() => undefined);
  }
  return { body, cached: false };
}

/** GET JSON with caching; see cachedJsonFrom. */
export async function cachedJson<T>(url: string, ttlMs: Ttl, signal?: AbortSignal, opts: CacheOpts = {}): Promise<T> {
  return (await cachedJsonFrom<T>(url, ttlMs, { ...opts, signal })).body;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
