/** GET /api/vkx/data?event&div&race&sn&h: one uploaded payload, immutable (h = its SHA-256; see functions/_vkx.ts). */
import { edgeCache, handleData, methodNotAllowed, type VkxEnv } from '../../_vkx';
import { paywallOn, privately, vkxGate, type PaywallEnv } from '../../_paywall';

interface PagesCtx {
  request: Request;
  env: VkxEnv & PaywallEnv;
  waitUntil(p: Promise<unknown>): void;
}

export const onRequestGet = async (ctx: PagesCtx): Promise<Response> => {
  if (!paywallOn(ctx.env)) return handleData(ctx, { cache: edgeCache() });
  // Paywall: race 1's logs are free; a later race's need an entitlement and go out private.
  const g = await vkxGate(ctx.request, ctx.env, { cache: edgeCache() });
  if (g.kind === 'deny') return g.response;
  const res = await handleData(ctx, { cache: edgeCache() });
  return g.kind === 'entitled' && res.ok ? privately(res) : res;
};

export const onRequest = (): Response => methodNotAllowed('GET');
