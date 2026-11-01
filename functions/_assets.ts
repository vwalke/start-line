/**
 * GET /assets/*: Vite's hashed build files, passed through from the static assets. A name the deploy doesn't
 * have (a page from another deploy, or an edge that hasn't got this one yet) would get Pages' SPA fallback,
 * index.html as 200 text/html, which the year-long cache header would keep as the script, and the page would
 * never start. So an HTML answer here becomes a 404 that nothing stores. Other methods pass through as they are.
 *
 * Pages doesn't apply public/_headers to a Function's responses, so a real file (200, or 304 to a conditional
 * request) gets its /assets/* Cache-Control, ASSET_CACHE_CONTROL, here; tests/assetsFunction.test.ts keeps the
 * two the same. Any other status keeps its own headers.
 */

/** public/_headers' Cache-Control for /assets/*: the names are content hashes, so a file never changes. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The part of Pages' ASSETS binding used here. */
export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface AssetsEnv {
  ASSETS: AssetsFetcher;
}

export async function handleAsset(ctx: { request: Request; env: AssetsEnv }): Promise<Response> {
  const { request, env } = ctx;
  const res = await env.ASSETS.fetch(request);
  if (request.method !== 'GET' && request.method !== 'HEAD') return res;
  if (/^\s*text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
    return new Response(request.method === 'HEAD' ? null : 'Not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (res.status !== 200 && res.status !== 304) return res;
  const headers = new Headers(res.headers);
  headers.set('cache-control', ASSET_CACHE_CONTROL);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
