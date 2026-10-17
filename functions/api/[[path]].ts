/**
 * Cloudflare Pages Function: a narrow, cached proxy for the three public
 * racesense.vakaros.com endpoints Start Line needs (that host sends no CORS
 * headers). teleapi.regatta.app is CORS-open and is called directly by the
 * browser, so it is not proxied.
 *
 *   /api/landing             → events list            (edge cache 10 min)
 *   /api/regatta?event=ID    → event document          (2 min live, 7 days once the event ended)
 *   /api/wind?v=3&lat&lon&…  → modelled wind (not measured) (6 h, 30 days for past days)
 */

interface CacheStorageCF {
  default: Cache;
}

interface Ctx {
  request: Request;
  params: { path?: string | string[] };
  waitUntil(p: Promise<unknown>): void;
}

const UPSTREAM = 'https://racesense.vakaros.com/api/';
const MIN = 60;
const DAY = 86_400;

const ALLOWED: Record<string, string[]> = {
  landing: [],
  regatta: ['event'],
  wind: ['v', 'lat', 'lon', 'start', 'end'],
};

function ttlFor(path: string, url: URL, body: string): number {
  if (path === 'landing') return 10 * MIN;
  if (path === 'wind') {
    const end = Date.parse(url.searchParams.get('end') ?? '');
    return Number.isFinite(end) && Date.now() - end > 2 * DAY * 1000 ? 30 * DAY : 6 * 3600;
  }
  // regatta: long once the event is over.
  try {
    const doc = (JSON.parse(body) as { revisions?: { doc?: { endDate?: number } }[] }).revisions?.at(-1)?.doc;
    if (doc?.endDate && Date.now() - doc.endDate > DAY * 1000) return 7 * DAY;
  } catch {
    /* not JSON: short */
  }
  return 2 * MIN;
}

const json = (status: number, msg: string): Response =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { 'content-type': 'application/json' } });

export const onRequestGet = async (ctx: Ctx): Promise<Response> => {
  const raw = ctx.params.path;
  const path = (Array.isArray(raw) ? raw.join('/') : raw ?? '').replace(/\/+$/, '');
  const allowed = ALLOWED[path];
  if (!allowed) return json(404, 'Unknown endpoint');

  const url = new URL(ctx.request.url);
  // Only forward known parameters, in a stable order, so the cache key is canonical.
  const qs = new URLSearchParams();
  for (const k of allowed) {
    const v = url.searchParams.get(k);
    if (v != null) qs.set(k, v);
  }
  if (path === 'regatta' && !/^[A-Za-z0-9_-]{4,64}$/.test(qs.get('event') ?? '')) return json(400, 'Bad event id');
  const upstream = `${UPSTREAM}${path}${qs.size ? `?${qs}` : ''}`;
  const cacheKey = new Request(`${url.origin}/api/${path}${qs.size ? `?${qs}` : ''}`);
  const cache = (globalThis.caches as unknown as CacheStorageCF).default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let res: Response;
  try {
    res = await fetch(upstream, { headers: { accept: 'application/json', 'user-agent': 'StartLine/1 (+https://walkeforward.com)' } });
  } catch {
    return json(502, 'Upstream unreachable');
  }
  const body = await res.text();
  if (!res.ok) return json(res.status === 404 ? 404 : 502, `Upstream ${res.status}`);
  const ttl = ttlFor(path, url, body);
  const out = new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${Math.min(ttl, 300)}, s-maxage=${ttl}`,
      'x-start-line-cache-ttl': String(ttl),
    },
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
};
