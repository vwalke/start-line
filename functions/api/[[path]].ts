/**
 * Cloudflare Pages Function: a narrow, cached proxy for the public
 * RaceSense endpoints Recall needs.
 *
 *   /api/landing                          → events list
 *   /api/regatta?event=ID                 → event document
 *   /api/wind?v=3&lat&lon&start&end       → modelled wind (not measured)
 *   /api/telemetry/event/ID?after&before  → 5 Hz GPS tracks (streamed)
 *
 * racesense.vakaros.com sends no CORS headers. teleapi.regatta.app advertises
 * CORS but the browser Web Worker still sees "Failed to fetch" from
 * *.pages.dev (credentials:* + ACAO * is a brittle combo). Both go through
 * this same-origin proxy.
 */
import {
  MAX_UPSTREAM_BYTES,
  TELE_UPSTREAM,
  UA,
  UPSTREAM,
  buildQuery,
  buildTelemetryQuery,
  endpointPath,
  jsonError,
  looksLikeJson,
  parseRoute,
  telemetryTtl,
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

async function cachedUpstream(
  ctx: Ctx,
  cacheKey: Request,
  upstream: string,
  ttl: number,
  opts: { buffer: boolean },
): Promise<Response> {
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
    res = await fetch(upstream, { headers: { accept: 'application/json', 'user-agent': UA } });
  } catch {
    return jsonError(502, 'Upstream unreachable');
  }
  if (!res.ok) return jsonError(res.status === 404 ? 404 : 502, `Upstream ${res.status}`);

  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${Math.min(ttl, 300)}, s-maxage=${ttl}`,
    'x-content-type-options': 'nosniff',
    'x-start-line-cache-ttl': String(ttl),
  };

  let out: Response;
  if (opts.buffer) {
    const announced = Number(res.headers.get('content-length') ?? 0);
    if (announced > MAX_UPSTREAM_BYTES) return jsonError(502, 'Upstream response too large');
    const body = await res.text();
    if (body.length > MAX_UPSTREAM_BYTES) return jsonError(502, 'Upstream response too large');
    if (!looksLikeJson(body)) return jsonError(502, 'Upstream returned non-JSON');
    out = new Response(body, { headers });
  } else {
    // Telemetry pages can be tens of MB: stream, do not buffer.
    out = new Response(res.body, { headers });
  }
  if (cache) ctx.waitUntil(cache.put(cacheKey, out.clone()).catch(() => undefined));
  return out;
}

export const onRequestGet = async (ctx: Ctx): Promise<Response> => {
  const path = endpointPath(ctx.params.path);
  const url = new URL(ctx.request.url);
  const route = parseRoute(path);
  if (route.kind === 'error') return jsonError(route.status, route.error);

  if (route.kind === 'telemetry') {
    const q = buildTelemetryQuery(url.searchParams);
    if (!q.ok) return jsonError(q.status, q.error);
    const suffix = `?${q.qs}`;
    return cachedUpstream(
      ctx,
      new Request(`${url.origin}/api/${path}${suffix}`),
      `${TELE_UPSTREAM}${route.eventId}${suffix}`,
      telemetryTtl(q.qs),
      { buffer: false },
    );
  }

  const q = buildQuery(route.path, url.searchParams);
  if (!q.ok) return jsonError(q.status, q.error);
  const suffix = q.qs.size ? `?${q.qs}` : '';
  // Buffer these three so we can pick a TTL from the body (finished event).
  // Fetch once, then ttlFor — landing/wind ignore the body.
  const cache = edgeCache();
  const cacheKey = new Request(`${url.origin}/api/${route.path}${suffix}`);
  const upstream = `${UPSTREAM}${route.path}${suffix}`;
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      /* best-effort */
    }
  }
  let res: Response;
  try {
    res = await fetch(upstream, { headers: { accept: 'application/json', 'user-agent': UA } });
  } catch {
    return jsonError(502, 'Upstream unreachable');
  }
  const announced = Number(res.headers.get('content-length') ?? 0);
  if (announced > MAX_UPSTREAM_BYTES) return jsonError(502, 'Upstream response too large');
  const body = await res.text();
  if (body.length > MAX_UPSTREAM_BYTES) return jsonError(502, 'Upstream response too large');
  if (!res.ok) return jsonError(res.status === 404 ? 404 : 502, `Upstream ${res.status}`);
  if (!looksLikeJson(body)) return jsonError(502, 'Upstream returned non-JSON');
  const ttl = ttlFor(route.path, q.qs, body);
  const out = new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${Math.min(ttl, 300)}, s-maxage=${ttl}`,
      'x-content-type-options': 'nosniff',
      'x-start-line-cache-ttl': String(ttl),
    },
  });
  if (cache) ctx.waitUntil(cache.put(cacheKey, out.clone()).catch(() => undefined));
  return out;
};
