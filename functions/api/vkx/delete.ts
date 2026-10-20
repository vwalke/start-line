/** POST (or DELETE) /api/vkx/delete with JSON {event, div, race, sn, token}: remove your upload (see functions/_vkx.ts). */
import { edgeCache, handleDelete, methodNotAllowed, type VkxEnv } from '../../_vkx';

interface PagesCtx {
  request: Request;
  env: VkxEnv;
  waitUntil(p: Promise<unknown>): void;
}

export const onRequestPost = (ctx: PagesCtx): Promise<Response> => handleDelete(ctx, { cache: edgeCache() });
export const onRequestDelete = onRequestPost;

export const onRequest = (): Response => methodNotAllowed('POST, DELETE');
