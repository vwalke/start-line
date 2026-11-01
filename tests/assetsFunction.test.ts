import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ASSET_CACHE_CONTROL, handleAsset, type AssetsEnv } from '../functions/_assets';
import { onRequest } from '../functions/assets/[[path]]';

const URL_JS = 'https://recall.walkeforward.com/assets/index-CoQVDCzS.js';
const INDEX_HTML = '<!doctype html><html><head></head><body>Loading…</body></html>';

/** An ASSETS binding that answers every request with `res`, and records what it was asked. */
const assets = (res: () => Response) => {
  const seen: Request[] = [];
  const env: AssetsEnv = { ASSETS: { fetch: async (r) => (seen.push(r), res()) } };
  return { env, seen };
};
/** A real file as the asset server answers a Function: no _headers rule applied. */
const js = (cacheControl = 'public, max-age=0, must-revalidate') =>
  new Response('export{};', { status: 200, headers: { 'content-type': 'application/javascript', 'cache-control': cacheControl, etag: '"abc"' } });
/** Pages' SPA fallback for a file it doesn't have. */
const fallback = () => new Response(INDEX_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': ASSET_CACHE_CONTROL } });

describe('functions/_assets.ts', () => {
  it("ASSET_CACHE_CONTROL is public/_headers' Cache-Control for /assets/*", () => {
    const text = readFileSync(fileURLToPath(new URL('../public/_headers', import.meta.url)), 'utf8');
    const rule = text.split(/\n(?=\S)/).find((r) => r.split('\n')[0].trim() === '/assets/*');
    const line = rule?.split('\n').find((l) => /^\s+cache-control:/i.test(l));
    expect(line?.replace(/^\s*cache-control:\s*/i, '').trim()).toBe(ASSET_CACHE_CONTROL);
  });

  it('serves a real asset with the same status, body and headers, and the year-long Cache-Control', async () => {
    const { env, seen } = assets(() => js());
    const req = new Request(URL_JS);
    const res = await handleAsset({ request: req, env });
    expect(seen).toEqual([req]);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(await res.text()).toBe('export{};');
  });

  it('answers a conditional request with the 304, its headers and the year-long Cache-Control', async () => {
    const { env } = assets(() => new Response(null, { status: 304, headers: { etag: '"abc"' } }));
    const res = await handleAsset({ request: new Request(URL_JS, { headers: { 'if-none-match': '"abc"' } }), env });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
  });

  it('serves HEAD for a real asset with the year-long Cache-Control', async () => {
    const { env } = assets(() => new Response(null, { status: 200, headers: { 'content-type': 'text/css', 'content-length': '42' } }));
    const res = await handleAsset({ request: new Request(URL_JS, { method: 'HEAD' }), env });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('42');
    expect(res.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
  });

  it('leaves any other status that is not HTML as it is, never immutable', async () => {
    for (const status of [206, 404, 416, 500]) {
      const other = new Response(status === 206 ? 'part' : 'nope', { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-cache' } });
      const { env } = assets(() => other);
      const res = await handleAsset({ request: new Request(URL_JS), env });
      expect(res, String(status)).toBe(other);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it("turns the SPA fallback (index.html for a missing file) into a 404 that isn't stored", async () => {
    for (const ct of ['text/html; charset=utf-8', 'text/html', 'TEXT/HTML']) {
      const { env } = assets(() => new Response(INDEX_HTML, { headers: { 'content-type': ct, 'cache-control': ASSET_CACHE_CONTROL } }));
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

  it('passes other methods through untouched, even an HTML answer', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const html = fallback();
      const { env, seen } = assets(() => html);
      const req = new Request(URL_JS, { method, ...(method === 'POST' || method === 'PUT' ? { body: 'x' } : {}) });
      expect(await handleAsset({ request: req, env }), method).toBe(html);
      expect(seen[0]).toBe(req);
    }
  });

  it('is the /assets/* route', async () => {
    expect((await onRequest({ request: new Request(URL_JS), env: assets(fallback).env })).status).toBe(404);
    const res = await onRequest({ request: new Request(URL_JS), env: assets(() => js()).env });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
  });
});
