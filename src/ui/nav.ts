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
 *
 * Back and forward land on popstate (a hash typed or linked in the page does too, so there is no separate
 * hashchange handling): the app sets the tab and the report from the entry's hash, then does what
 * `popAction` says for its event and race, from the empty picker to another race of the same event.
 */
import { DEFAULT_TAB, tabFromHash, type Tab } from './tabs';
import { reportFromUrl } from './report';
import { parsePickerParams } from './params';

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

/** What the app shows now, as popAction reads it. */
export interface Screen {
  /** The event whose card is shown (no races yet), else ''. */
  card: string;
  /** The event whose races are loaded, else '' (also while the empty picker is shown). */
  eventId: string;
  /** The race on screen, of `eventId`. */
  race: { division: string; raceNumber: number } | null;
}

export type PopAction =
  | { kind: 'none' }
  /** The bare /regattas: no event, the picker empty. */
  | { kind: 'picker' }
  /** Open the event: its wanted race, else its default race, or its card when it has no races. */
  | { kind: 'event'; eventId: string; want?: { division: string; raceNumber: number } }
  /** Another race of the event already loaded. */
  | { kind: 'race'; division: string; raceNumber: number };

/** What back / forward to an entry with this query must do, given what is on screen. */
export function popAction(search: string, screen: Screen): PopAction {
  const p = parsePickerParams(search);
  const event = (): PopAction => ({ kind: 'event', eventId: p.eventId, ...(p.want ? { want: p.want } : {}) });
  if (!p.eventId) return screen.card || screen.eventId ? { kind: 'picker' } : { kind: 'none' };
  // A card is up: the same card stays; anything else (a race of that event too) is loaded.
  if (screen.card) return p.eventId === screen.card && !p.want ? { kind: 'none' } : event();
  if (p.eventId !== screen.eventId) return event();
  // The event alone, while one of its races is shown: its card's entry (or its default race), so open it again.
  if (!p.want) return event();
  const r = screen.race;
  if (r && r.division === p.want.division && r.raceNumber === p.want.raceNumber) return { kind: 'none' };
  return { kind: 'race', division: p.want.division, raceNumber: p.want.raceNumber };
}
