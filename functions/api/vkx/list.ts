/** GET /api/vkx/list?event&div[&race]: the race's (or division's) uploaded boat logs (see functions/_vkx.ts). */
import { edgeCache, handleList, methodNotAllowed, type VkxEnv } from '../../_vkx';

interface PagesCtx {
  request: Request;
  env: VkxEnv;
  waitUntil(p: Promise<unknown>): void;
}

export const onRequestGet = (ctx: PagesCtx): Promise<Response> => handleList(ctx, { cache: edgeCache() });

export const onRequest = (): Response => methodNotAllowed('GET');
