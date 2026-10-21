/** GET /api/coach/status: is Ask Coach on here, and its limits (see functions/_askCoach.ts). */
import { handleStatus, type AskEnv } from '../../_askCoach';
import { methodNotAllowed } from '../../_vkx';

interface PagesCtx {
  request: Request;
  env: AskEnv;
}

export const onRequestGet = (ctx: PagesCtx): Response => handleStatus(ctx);

export const onRequest = (): Response => methodNotAllowed('GET');
