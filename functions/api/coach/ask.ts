/**
 * POST /api/coach/ask: one Ask Coach question, answered as an event stream (see functions/_askCoach.ts).
 * A static route: it wins over the catch-all proxy functions/api/[[path]].ts, as functions/api/vkx/* do.
 * Paywall (PAYWALL_ENABLED): free only when the server can tell the whole request (context, question,
 * earlier turns) carries race 1 and nothing else (functions/_paywall.ts askGate); anything else needs an entitlement.
 */
import { handleAsk, type AskEnv } from '../../_askCoach';
import { methodNotAllowed, edgeCache } from '../../_vkx';
import { askGate, paywallOn, type PaywallEnv } from '../../_paywall';

interface PagesCtx {
  request: Request;
  env: AskEnv & PaywallEnv;
  waitUntil(p: Promise<unknown>): void;
}

export const onRequestPost = (ctx: PagesCtx): Promise<Response> =>
  handleAsk(ctx, paywallOn(ctx.env) ? { gate: (ask) => askGate(ctx.request, ctx.env, ask, { cache: edgeCache() }) } : {});

export const onRequest = (): Response => methodNotAllowed('POST');
