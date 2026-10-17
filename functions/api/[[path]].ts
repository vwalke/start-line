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
import {
  MAX_UPSTREAM_BYTES,
  UPSTREAM,
  buildQuery,
  endpointPath,
  jsonError,
  looksLikeJson,
  ttlFor,
} from '../_lib';

interface Ctx {
  request: Request;
  params: { path?: string | string[] };
  waitUntil(p: Promise<unknown>): void;
}

function edgeCache(): Cache | null {
  try {
    const bag = globalThis.caches as CacheStorage & { default?: Cache };
    return bag.default ?? null;
  } catch {
    return null;
  }
}

export const onRequestGet = async (ctx: Ctx): Promise<Response> => {
  const path = endpointPath(ctx.params.path);
  const url = new URL(ctx.request.url);
  const q = buildQuery(path, url.searchParams);
  if (!q.ok) return jsonError(q.status, q.error);

  const qs = q.qs;
  const suffix = qs.size ? `?${qs}` : '';
  const upstream = `${UPSTREAM}${path}${suffix}`;
  const cacheKey = new Request(`${url.origin}/api/${path}${suffix}`);
  const cache = edgeCache();

  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      /* cache read is best-effort */
    }
  }

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: { accept: 'application/json', 'user-agent': 'StartLine/1 (+https://walkeforward.com)' },
    });
  } catch {
    return jsonError(502, 'Upstream unreachable');
  }

  const announced = Number(res.headers.get('content-length') ?? 0);
  if (announced > MAX_UPSTREAM_BYTES) return jsonError(502, 'Upstream response too large');

  const body = await res.text();
  if (body.length > MAX_UPSTREAM_BYTES) return jsonError(502, 'Upstream response too large');
  if (!res.ok) return jsonError(res.status === 404 ? 404 : 502, `Upstream ${res.status}`);
  if (!looksLikeJson(body)) return jsonError(502, 'Upstream returned non-JSON');

  const ttl = ttlFor(path, qs, body);
  const out = new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${Math.min(ttl, 300)}, s-maxage=${ttl}`,
      'x-content-type-options': 'nosniff',
      'x-start-line-cache-ttl': String(ttl),
    },
  });
  if (cache) {
    ctx.waitUntil(cache.put(cacheKey, out.clone()).catch(() => undefined));
  }
  return out;
};
