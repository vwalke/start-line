/**
 * /assets/*: the build's hashed files from the static assets, untouched; a missing one is a 404 that nothing
 * caches instead of index.html (see functions/_assets.ts). Pages' generated routes include /assets/* for it.
 */
import { handleAsset, type AssetsEnv } from '../_assets';

interface PagesCtx {
  request: Request;
  env: AssetsEnv;
}

export const onRequest = (ctx: PagesCtx): Promise<Response> => handleAsset(ctx);
