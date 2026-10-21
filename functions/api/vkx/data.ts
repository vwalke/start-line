/** GET /api/vkx/data?event&div&race&sn&h: one uploaded payload, immutable (h = its SHA-256; see functions/_vkx.ts). */
import { edgeCache, handleData, methodNotAllowed, type VkxEnv } from '../../_vkx';

interface PagesCtx {
  request: Request;
  env: VkxEnv;
  waitUntil(p: Promise<unknown>): void;
}

export const onRequestGet = (ctx: PagesCtx): Promise<Response> => handleData(ctx, { cache: edgeCache() });

export const onRequest = (): Response => methodNotAllowed('GET');
