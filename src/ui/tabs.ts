/**
 * The digest's three tabs: Start (start chart, speed through the start, start
 * findings and table), Race (track map, place changes, race findings, legs
 * table) and Coach (one boat's debrief, ui/coach.ts). The tab is page state,
 * not per-race: it stays put when another race is picked. It lives in the URL
 * hash (`#start` / `#race` / `#coach`, replaced, never pushed) and in
 * recall.lastView. A hash on the URL wins; else the saved tab when the saved
 * view is being restored; else Start.
 */

export const TABS = ['start', 'race', 'coach'] as const;
export type Tab = (typeof TABS)[number];
export const DEFAULT_TAB: Tab = 'start';

/** A tab name among `tabs`, or null for anything else. */
export const parseTab = (x: unknown, tabs: readonly Tab[] = TABS): Tab | null => (typeof x === 'string' && (tabs as readonly string[]).includes(x) ? (x as Tab) : null);

/** The tab a location hash names ("#race"), or null (no hash, or one the app doesn't use). */
export const tabFromHash = (hash: string | null | undefined, tabs: readonly Tab[] = TABS): Tab | null => parseTab((hash ?? '').replace(/^#/, ''), tabs);

export const tabHash = (t: Tab): string => `#${t}`;

/**
 * The tab to open with: the URL's hash; else `saved` when the saved view is
 * being restored (the saved race, or a link to that same race); else Start.
 */
export function initialTab(hash: string | null | undefined, saved: Tab | null | undefined, restoring: boolean, tabs: readonly Tab[] = TABS): Tab {
  return tabFromHash(hash, tabs) ?? (restoring ? (parseTab(saved, tabs) ?? DEFAULT_TAB) : DEFAULT_TAB);
}

/** The tab a key moves to from `cur` (arrows wrap; Home / End), or null for other keys. */
export function tabForKey(cur: Tab, key: string, tabs: readonly Tab[] = TABS): Tab | null {
  const i = tabs.indexOf(cur);
  // A horizontal tablist: Left / Right only (Up / Down keep scrolling the page).
  if (key === 'ArrowRight') return tabs[(i + 1) % tabs.length];
  if (key === 'ArrowLeft') return tabs[(i - 1 + tabs.length) % tabs.length];
  if (key === 'Home') return tabs[0];
  if (key === 'End') return tabs[tabs.length - 1];
  return null;
}

/** `href` with its hash set to `tab` (search and path untouched), for history.replaceState. */
export function withTabHash(href: string, tab: Tab): string {
  const u = new URL(href);
  u.hash = tabHash(tab);
  return u.toString();
}
