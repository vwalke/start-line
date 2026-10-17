/**
 * Polite client-side caching: an in-memory map backed by the Cache API
 * (when available) so a revisit of a finished race costs no requests.
 * Each entry records when it was fetched; the caller decides freshness.
 *
 * Large telemetry pages (~100k rows) skip the in-memory map so a 5 Hz race
 * does not pin tens of megabytes in the worker. The Cache API still holds
 * them for a later visit.
 */
const CACHE_NAME = 'start-line-v1';
const FETCHED_AT = 'x-start-line-fetched-at';
const MEMORY_ENTRY_MAX = 750_000;
const MEMORY_TOTAL_MAX = 4_000_000;

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

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    return null; // e.g. insecure context or storage disabled
  }
}

export type Ttl = number | ((body: unknown) => number);

/**
 * GET JSON with caching. `ttlMs` may depend on the body (e.g. long for a
 * finished event); it's evaluated against the cached copy on read.
 */
export async function cachedJson<T>(url: string, ttlMs: Ttl, signal?: AbortSignal): Promise<T> {
  const now = Date.now();
  const ttl = (body: unknown): number => (typeof ttlMs === 'function' ? ttlMs(body) : ttlMs);
  const mem = memory.get(url);
  if (mem && now - mem.at < ttl(mem.body)) {
    touch(url, mem);
    return mem.body as T;
  }

  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const at = Number(hit.headers.get(FETCHED_AT) ?? 0);
        const text = await hit.text();
        const body: unknown = JSON.parse(text);
        if (now - at < ttl(body)) {
          remember(url, at, body, text.length);
          return body as T;
        }
      }
    } catch {
      /* corrupt entry: refetch */
    }
  }

  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();
  const body = JSON.parse(text) as T;
  remember(url, now, body, text.length);
  if (cache && ttl(body) > 0) {
    const stored = new Response(text, { headers: { 'content-type': 'application/json', [FETCHED_AT]: String(now) } });
    cache.put(url, stored).catch(() => undefined);
  }
  return body;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
