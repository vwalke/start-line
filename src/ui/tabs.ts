/**
 * The digest's two tabs: Start (start chart, speed through the start, start
 * findings and table) and Race (track map, place changes, race findings,
 * legs table). The tab is page state, not per-race: it stays put when
 * another race is picked. It lives in the URL hash (`#start` / `#race`,
 * replaced, never pushed) and in recall.lastView. A hash on the URL wins;
 * else the saved tab when the saved view is being restored; else Start.
 */

export const TABS = ['start', 'race'] as const;
export type Tab = (typeof TABS)[number];
export const DEFAULT_TAB: Tab = 'start';

/** A tab name, or null for anything else. */
export const parseTab = (x: unknown): Tab | null => (x === 'start' || x === 'race' ? x : null);

/** The tab a location hash names ("#race"), or null (no hash, or one the app doesn't use). */
export const tabFromHash = (hash: string | null | undefined): Tab | null => parseTab((hash ?? '').replace(/^#/, ''));

export const tabHash = (t: Tab): string => `#${t}`;

/**
 * The tab to open with: the URL's hash; else `saved` when the saved view is
 * being restored (the saved race, or a link to that same race); else Start.
 */
export function initialTab(hash: string | null | undefined, saved: Tab | null | undefined, restoring: boolean): Tab {
  return tabFromHash(hash) ?? (restoring ? (parseTab(saved) ?? DEFAULT_TAB) : DEFAULT_TAB);
}

/** The tab a key moves to from `cur` (arrows wrap; Home / End), or null for other keys. */
export function tabForKey(cur: Tab, key: string): Tab | null {
  const i = TABS.indexOf(cur);
  // A horizontal tablist: Left / Right only (Up / Down keep scrolling the page).
  if (key === 'ArrowRight') return TABS[(i + 1) % TABS.length];
  if (key === 'ArrowLeft') return TABS[(i - 1 + TABS.length) % TABS.length];
  if (key === 'Home') return TABS[0];
  if (key === 'End') return TABS[TABS.length - 1];
  return null;
}

/** `href` with its hash set to `tab` (search and path untouched), for history.replaceState. */
export function withTabHash(href: string, tab: Tab): string {
  const u = new URL(href);
  u.hash = tabHash(tab);
  return u.toString();
}
