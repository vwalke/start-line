/**
 * /api/auth/*: sign-in for the paywall (see functions/_auth.ts). More specific than the catch-all
 * proxy functions/api/[[path]].ts, so it wins for these paths; with PAYWALL_ENABLED off it answers
 * the proxy's own 404 for every path, /api/auth/me included.
 */
import { handleAuth, type AuthCtx } from '../../_auth';

export const onRequest = (ctx: AuthCtx): Promise<Response> => handleAuth(ctx);
