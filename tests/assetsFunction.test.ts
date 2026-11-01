import { describe, expect, it } from 'vitest';
import { handleAsset, type AssetsEnv } from '../functions/_assets';
import { onRequest } from '../functions/assets/[[path]]';

const URL_JS = 'https://recall.walkeforward.com/assets/index-CoQVDCzS.js';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const INDEX_HTML = '<!doctype html><html><head></head><body>Loading…</body></html>';

/** An ASSETS binding that answers every request with `res`, and records what it was asked. */
const assets = (res: () => Response) => {
  const seen: Request[] = [];
  const env: AssetsEnv = { ASSETS: { fetch: async (r) => (seen.push(r), res()) } };
  return { env, seen };
};
const js = () => new Response('export{};', { status: 200, headers: { 'content-type': 'application/javascript', 'cache-control': IMMUTABLE, etag: '"abc"' } });
/** Pages' SPA fallback for a file it doesn't have. */
const fallback = () => new Response(INDEX_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': IMMUTABLE } });

describe('functions/_assets.ts', () => {
  it('passes a real asset through untouched: the same response, status, headers and body', async () => {
    const real = js();
    const { env, seen } = assets(() => real);
    const req = new Request(URL_JS);
    const res = await handleAsset({ request: req, env });
    expect(res).toBe(real);
    expect(seen).toEqual([req]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(await res.text()).toBe('export{};');
  });

  it('passes a 304 through as it is', async () => {
    const nm = new Response(null, { status: 304, headers: { etag: '"abc"' } });
    const { env } = assets(() => nm);
    expect(await handleAsset({ request: new Request(URL_JS, { headers: { 'if-none-match': '"abc"' } }), env })).toBe(nm);
  });

  it("turns the SPA fallback (index.html for a missing file) into a 404 that isn't stored", async () => {
    for (const ct of ['text/html; charset=utf-8', 'text/html', 'TEXT/HTML']) {
      const { env } = assets(() => new Response(INDEX_HTML, { headers: { 'content-type': ct, 'cache-control': IMMUTABLE } }));
      const res = await handleAsset({ request: new Request(URL_JS), env });
      expect(res.status, ct).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(await res.text()).not.toContain('<html');
    }
  });

  it('answers HEAD for a missing file with a 404 and no body', async () => {
    const { env } = assets(fallback);
    const res = await handleAsset({ request: new Request(URL_JS, { method: 'HEAD' }), env });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toBeNull();
  });

  it('passes other methods through, even an HTML answer', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const html = fallback();
      const { env, seen } = assets(() => html);
      const req = new Request(URL_JS, { method, ...(method === 'POST' || method === 'PUT' ? { body: 'x' } : {}) });
      expect(await handleAsset({ request: req, env }), method).toBe(html);
      expect(seen[0]).toBe(req);
    }
  });

  it('is the /assets/* route', async () => {
    const { env } = assets(fallback);
    expect((await onRequest({ request: new Request(URL_JS), env })).status).toBe(404);
    const real = js();
    expect(await onRequest({ request: new Request(URL_JS), env: assets(() => real).env })).toBe(real);
  });
});
