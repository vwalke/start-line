/**
 * POST /api/track: usage events into Workers Analytics Engine (see functions/_track.ts). Needs the
 * RECALL_EVENTS binding (204 and nothing stored without it). A static route: it wins over the catch-all
 * proxy functions/api/[[path]].ts.
 */
import { handleTrack, type TrackEnv } from '../_track';

interface PagesCtx {
  request: Request;
  env: TrackEnv;
}

export const onRequest = (ctx: PagesCtx): Promise<Response> => handleTrack(ctx);
