/**
 * The /api/vkx/* routes are their own Pages Function files: Cloudflare Pages
 * matches a static path (functions/api/vkx/upload.ts → /api/vkx/upload) before
 * the catch-all functions/api/[[path]].ts, so the RaceSense proxy is untouched.
 */
import { describe, expect, it } from 'vitest';
import * as data from '../functions/api/vkx/data';
import * as del from '../functions/api/vkx/delete';
import * as list from '../functions/api/vkx/list';
import * as upload from '../functions/api/vkx/upload';
import { parseRoute } from '../functions/_lib';

describe('vkx route files', () => {
  it('export a handler per method and 405 otherwise', async () => {
    expect(typeof upload.onRequestPost).toBe('function');
    expect(typeof list.onRequestGet).toBe('function');
    expect(typeof data.onRequestGet).toBe('function');
    expect(typeof del.onRequestPost).toBe('function');
    expect(typeof del.onRequestDelete).toBe('function');
    for (const m of [upload, list, data, del]) expect(m.onRequest().status).toBe(405);
    expect(upload.onRequest().headers.get('allow')).toBe('POST');
  });

  it("answer 503 with no binding (env as Pages passes it)", async () => {
    const res = await list.onRequestGet({ request: new Request('https://x.example/api/vkx/list?event=abcde&div=Open'), env: {}, waitUntil: () => undefined });
    expect(res.status).toBe(503);
  });

  it('are unknown to the catch-all proxy (so it never serves them by accident)', () => {
    expect(parseRoute('vkx/upload').kind).toBe('error');
  });
});
