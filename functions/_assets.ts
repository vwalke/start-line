/**
 * GET /assets/*: Vite's hashed build files, passed through from the static assets untouched. A name the
 * deploy doesn't have (a page from another deploy, or an edge that hasn't got this one yet) would get Pages'
 * SPA fallback, index.html as 200 text/html, and public/_headers marks /assets/* immutable for a year: the
 * browser and the edge would keep that HTML as the script and the page would never start. So an HTML answer
 * here becomes a 404 that nothing stores. Other methods pass through as they are.
 */

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
  if (!/^\s*text\/html\b/i.test(res.headers.get('content-type') ?? '')) return res;
  return new Response(request.method === 'HEAD' ? null : 'Not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
