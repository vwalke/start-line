/**
 * POST /api/vkx/upload: store one race's boat-log payload (see functions/_vkx.ts).
 *
 * Route precedence: Cloudflare Pages matches the most specific route first,
 * so this file (a static path) wins over the catch-all functions/api/[[path]].ts
 * proxy for /api/vkx/upload; the proxy never sees /api/vkx/* requests that
 * one of these files serves.
 */
import { edgeCache, handleUpload, methodNotAllowed, type VkxEnv } from '../../_vkx';

interface PagesCtx {
  request: Request;
  env: VkxEnv;
  waitUntil(p: Promise<unknown>): void;
}

export const onRequestPost = (ctx: PagesCtx): Promise<Response> => handleUpload(ctx, { cache: edgeCache() });

export const onRequest = (): Response => methodNotAllowed('POST');
