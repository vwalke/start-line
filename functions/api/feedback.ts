/**
 * GET / POST /api/feedback: the Feedback sheet (see functions/_feedback.ts). With the paywall on or off;
 * needs the AUTH_DB binding. A static route: it wins over the catch-all proxy functions/api/[[path]].ts.
 */
import { handleFeedback, handleFeedbackInfo, type FeedbackEnv } from '../_feedback';
import { methodNotAllowed } from '../_vkx';

interface PagesCtx {
  request: Request;
  env: FeedbackEnv;
  waitUntil(p: Promise<unknown>): void;
}

export const onRequestGet = (ctx: PagesCtx): Promise<Response> => handleFeedbackInfo(ctx);

export const onRequestPost = (ctx: PagesCtx): Promise<Response> => handleFeedback(ctx);

export const onRequest = (): Response => methodNotAllowed('GET, POST');
