/**
 * Polite client-side caching: an in-memory map backed by the Cache API
 * (when available) so a revisit of a finished race costs no requests.
 * Each entry records when it was fetched; the caller decides freshness.
 */
const CACHE_NAME = 'start-line-v1';
const FETCHED_AT = 'x-start-line-fetched-at';
const memory = new Map<string, { at: number; body: unknown }>();

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
  if (mem && now - mem.at < ttl(mem.body)) return mem.body as T;

  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const at = Number(hit.headers.get(FETCHED_AT) ?? 0);
        const body: unknown = await hit.json();
        if (now - at < ttl(body)) {
          memory.set(url, { at, body });
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
  memory.set(url, { at: now, body });
  if (cache && ttl(body) > 0) {
    const stored = new Response(text, { headers: { 'content-type': 'application/json', [FETCHED_AT]: String(now) } });
    cache.put(url, stored).catch(() => undefined);
  }
  return body;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
