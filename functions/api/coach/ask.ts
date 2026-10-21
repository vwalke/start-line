/**
 * POST /api/coach/ask: one Ask Coach question, answered as an event stream (see functions/_askCoach.ts).
 * A static route: it wins over the catch-all proxy functions/api/[[path]].ts, as functions/api/vkx/* do.
 */
import { handleAsk, type AskEnv } from '../../_askCoach';
import { methodNotAllowed } from '../../_vkx';

interface PagesCtx {
  request: Request;
  env: AskEnv;
  waitUntil(p: Promise<unknown>): void;
}

export const onRequestPost = (ctx: PagesCtx): Promise<Response> => handleAsk(ctx);

export const onRequest = (): Response => methodNotAllowed('POST');
