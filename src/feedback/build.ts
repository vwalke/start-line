/**
 * The build this page came from: vite.config.ts `define`s both (the commit from CF_PAGES_COMMIT_SHA, else
 * `git rev-parse --short HEAD`, else 'dev'). Read defensively so a test or a tool without the define still runs.
 */
declare const __APP_COMMIT__: string | undefined;
declare const __APP_BUILT_AT__: string | undefined;

export const APP_COMMIT: string = typeof __APP_COMMIT__ === 'string' && __APP_COMMIT__ ? __APP_COMMIT__ : 'dev';
export const APP_BUILT_AT: string | null = typeof __APP_BUILT_AT__ === 'string' && __APP_BUILT_AT__ ? __APP_BUILT_AT__ : null;
