/**
 * Which page a URL opens: the landing page (src/landing/landing.ts) or the app (ui/app.ts).
 *
 *   - `/` (or `/index.html`) with no app parameters and no app hash: the landing page.
 *   - `/regattas`: the app as `/` used to be (the event picker; reopens the last race viewed, else the latest).
 *   - Any other URL is the app, unchanged: every deep link (`/?event=…&div=…&race=…` with `nc`, `ys`, `ysc`,
 *     `boat`, `grp`, `cview`, `t`, `trail`, `report`, `buy`, `checkout`, `signin`, …, and the `#start`, `#race`,
 *     `#coach`, `#report` hashes) keeps opening the app. A parameter the app doesn't know still counts: only
 *     campaign tagging (`utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_cid`, `mc_eid`) leaves `/` on the landing page.
 *
 * Cloudflare Pages serves index.html for `/regattas` (no 404.html: single-page-app fallback; /api/* is the
 * Functions' and /assets/* are files, so neither reaches it). index.html's inline script makes the same call
 * before first paint (tests/landing.test.ts holds the two in step).
 */
// No imports from ui/: the landing page loads this module and nothing of the app.
export const REGATTAS_PATH = '/regattas';
export type Route = 'landing' | 'app';

const LANDING_PATH = /^\/(index\.html)?$/;
/** Campaign / click tagging that a shared link may carry: never an app parameter. */
export const TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|msclkid|mc_cid|mc_eid)$/i;
/** The hashes the app reads: its tabs (ui/tabs.ts TABS) and the report (ui/report.ts REPORT_HASH); tested to match. */
export const APP_HASHES: readonly string[] = ['start', 'race', 'coach', 'report'];

export function routeOf(pathname: string, search: string, hash: string): Route {
  if (!LANDING_PATH.test(pathname)) return 'app';
  for (const k of new URLSearchParams(search).keys()) if (!TRACKING_PARAM.test(k)) return 'app';
  return APP_HASHES.includes(hash.replace(/^#/, '')) ? 'app' : 'landing';
}

/**
 * `href` (absolute or a path) as the app should keep it: when dropping its parameters would leave the
 * landing page's URL, on `/regattas` instead, so a reload stays in the app. Returns a path.
 */
export function appPath(href: string): string {
  const u = new URL(href, 'https://x.invalid');
  if (routeOf(u.pathname, u.search, u.hash) === 'landing') u.pathname = REGATTAS_PATH;
  return `${u.pathname}${u.search}${u.hash}`;
}
