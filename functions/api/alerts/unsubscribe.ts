/** GET / POST /api/alerts/unsubscribe?t=: a race email's unsubscribe link (see functions/_alerts.ts). */
import { handleUnsubscribe, type AlertsEnv } from '../../_alerts';

interface PagesCtx {
  request: Request;
  env: AlertsEnv;
}

export const onRequest = (ctx: PagesCtx): Promise<Response> => handleUnsubscribe(ctx);
