/** GET / POST / DELETE /api/alerts: the signed-in user's race emails (see functions/_alerts.ts). */
import { handleAlerts, type AlertsEnv } from '../../_alerts';

interface PagesCtx {
  request: Request;
  env: AlertsEnv;
}

export const onRequest = (ctx: PagesCtx): Promise<Response> => handleAlerts(ctx);
