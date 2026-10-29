/**
 * The app's history entries. The URL's query (`?event=…&div=…&race=…`, ui/params.ts) and hash (`#start` /
 * `#race` / `#coach`, ui/tabs.ts; `#report`, ui/report.ts) say what is on screen, as they always have; the path
 * now names the view too, so each is a page of its own (to the browser's back button and to Cloudflare Web
 * Analytics, which counts pushState navigations by path):
 *
 *   /regattas          no race on screen: the picker, or an event's card (`?event=` alone)
 *   /regattas/start    a race, on the Start tab (also /regattas/race, /regattas/coach)
 *   /regattas/report   a race's report
 *
 * The path is only ever written, never read: an older link (`/?event=…#coach`) opens the same view and is
 * rewritten to its path in place. Cloudflare Pages serves index.html for these paths (no 404.html), and
 * landing/route.ts sends any path but `/` to the app.
 *
 * A user's move to another event, race, tab or the report pushes one entry, once the new view is on screen
 * (`begin`, then the `write` that changes the page); everything else (the scrubber's time, the selected boat,
 * the Coach's group, a load that settles, a link tidied at boot) replaces the entry it is on.
 */
import { DEFAULT_TAB, tabFromHash, type Tab } from './tabs';
import { reportFromUrl } from './report';

export const VIEW_BASE = '/regattas';
export type PageView = 'regattas' | Tab | 'report';

/** The view a URL's query and hash show. */
export function pageView(search: string, hash: string): PageView {
  if (reportFromUrl(search, hash)) return 'report';
  const p = new URLSearchParams(search);
  if (!(p.get('event') && p.get('div') && p.get('race'))) return 'regattas';
  return tabFromHash(hash) ?? DEFAULT_TAB;
}

export const viewPath = (v: PageView): string => (v === 'regattas' ? VIEW_BASE : `${VIEW_BASE}/${v}`);

/** `href` (absolute or a path) with its path naming its view; query and hash untouched. Returns a path. */
export function viewHref(href: string): string {
  const u = new URL(href, 'https://x.invalid');
  u.pathname = viewPath(pageView(u.search, u.hash));
  return `${u.pathname}${u.search}${u.hash}`;
}

/** What makes a page of its own: the view, and the event and race it shows. */
export function pageKey(href: string): string {
  const u = new URL(href, 'https://x.invalid');
  const p = u.searchParams;
  return [pageView(u.search, u.hash), p.get('event') ?? '', p.get('div') ?? '', p.get('race') ?? ''].join('|');
}

export interface NavHistory {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

export interface Nav {
  /** A user's move starts: the next write that shows another page pushes it (the entry left keeps its own URL). */
  begin(): void;
  /** The move went nowhere (a failed load), or back/forward is being followed: the next write replaces. */
  cancel(): void;
  /** Put `href` in the URL: pushed when a move is pending and it is another page (and `push` isn't false), else replaced. */
  write(href: string, opts?: { push?: boolean }): void;
}

export function createNav(o: { history: NavHistory; href: () => string }): Nav {
  /** The entry's URL when the pending move began (what it goes back to before the push). */
  let from: string | null = null;
  const replace = (url: string): void => o.history.replaceState(o.history.state, '', url);
  return {
    begin() {
      from ??= viewHref(o.href());
    },
    cancel() {
      from = null;
    },
    write(href, opts = {}) {
      const to = viewHref(href);
      const start = from;
      if (start != null && opts.push !== false && pageKey(to) !== pageKey(start)) {
        from = null;
        try {
          // A load writes the new race's time or boat before its race: the entry being left gets its own URL back.
          if (viewHref(o.href()) !== start) replace(start);
          o.history.pushState(null, '', to);
          return;
        } catch {
          // no history (a sandbox): replaced, as before
        }
      }
      replace(to);
    },
  };
}
