import { describe, expect, it } from 'vitest';
import { createNav, pageKey, pageView, popAction, viewHref, type NavHistory, type PopAction, type Screen } from '../src/ui/nav';
import { routeOf } from '../src/landing/route';
import { TRACK_PATHS } from '../functions/_trackSchema';
import { withTabHash } from '../src/ui/tabs';
import { reportHref } from '../src/ui/report';

const ORIGIN = 'https://recall.walkeforward.com';

/** A browser's session history: entries, a cursor, back / forward; pushState drops the forward entries. */
class FakeHistory implements NavHistory {
  entries: { url: string; state: unknown }[];
  i = 0;
  pushes: string[] = [];
  constructor(url: string) {
    this.entries = [{ url, state: null }];
  }
  get state(): unknown {
    return this.entries[this.i].state;
  }
  get href(): string {
    return new URL(this.entries[this.i].url, ORIGIN).href;
  }
  pushState(state: unknown, _u: string, url?: string | null): void {
    this.entries = this.entries.slice(0, this.i + 1);
    this.entries.push({ url: url ?? this.entries[this.i].url, state });
    this.i++;
    this.pushes.push(url ?? '');
  }
  replaceState(state: unknown, _u: string, url?: string | null): void {
    this.entries[this.i] = { url: url ?? this.entries[this.i].url, state };
  }
  back(): string {
    this.i = Math.max(0, this.i - 1);
    return this.entries[this.i].url;
  }
  forward(): string {
    this.i = Math.min(this.entries.length - 1, this.i + 1);
    return this.entries[this.i].url;
  }
}

/** As app.ts setUrl: the query changed on the current URL. */
const withParams = (href: string, next: Record<string, string | null>): string => {
  const u = new URL(href);
  for (const [k, v] of Object.entries(next)) {
    if (v == null) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  return u.href;
};

describe('the app\'s paths (src/ui/nav.ts)', () => {
  it('names each view by its path, keeping the query and hash', () => {
    expect(viewHref('/regattas')).toBe('/regattas');
    expect(viewHref('/?event=cbc2026')).toBe('/regattas?event=cbc2026');
    expect(viewHref('/?event=cbc2026&div=J105&race=3')).toBe('/regattas/start?event=cbc2026&div=J105&race=3');
    expect(viewHref('/?event=cbc2026&div=J105&race=3&boat=b1#coach')).toBe('/regattas/coach?event=cbc2026&div=J105&race=3&boat=b1#coach');
    expect(viewHref('/regattas/start?event=e1&div=A&race=1#race')).toBe('/regattas/race?event=e1&div=A&race=1#race');
    expect(viewHref('/?event=e1&div=A&race=1#report')).toBe('/regattas/report?event=e1&div=A&race=1#report');
    expect(viewHref('/?event=e1&div=A&race=1&report=1')).toBe('/regattas/report?event=e1&div=A&race=1&report=1');
    expect(pageView('?event=e1&div=A&race=1', '')).toBe('start');
  });

  it('every path opens the app (no 404.html: Pages serves index.html), and each is a path the tracker keeps', () => {
    for (const href of ['/regattas', '/?event=e1&div=A&race=1', '/?event=e1&div=A&race=1#race', '/?event=e1&div=A&race=1#coach', '/?event=e1&div=A&race=1#report']) {
      const u = new URL(viewHref(href), ORIGIN);
      expect(routeOf(u.pathname, u.search, u.hash)).toBe('app');
      expect(TRACK_PATHS).toContain(u.pathname);
    }
    // Older links keep opening the same view (the path is written, never read).
    expect(routeOf('/', '?event=e1&div=A&race=1', '#coach')).toBe('app');
  });

  it('a page is its view, event and race: the time, boat or trail are not', () => {
    const a = '/regattas/start?event=e1&div=A&race=1';
    expect(pageKey(`${a}&t=120&boat=b2&trail=60`)).toBe(pageKey(a));
    expect(pageKey(`${a}#race`)).not.toBe(pageKey(a));
    expect(pageKey(a.replace('race=1', 'race=2'))).not.toBe(pageKey(a));
    expect(pageKey('/regattas?event=e2')).not.toBe(pageKey('/regattas?event=e1'));
  });
});

describe('history entries (createNav)', () => {
  const start = '/?event=e1&div=A&race=1';
  const setup = () => {
    const h = new FakeHistory(start);
    const nav = createNav({ history: h, href: () => h.href });
    return { h, nav };
  };

  it('boot writes replace: a link is tidied in place, never a new entry', () => {
    const { h, nav } = setup();
    nav.write(withParams(h.href, { t: '30' }));
    nav.write(withTabHash(h.href, 'start'));
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0].url).toBe('/regattas/start?event=e1&div=A&race=1&t=30#start');
  });

  it('a race, a tab, the report and an event each push one entry; back and forward restore each view', () => {
    const { h, nav } = setup();
    nav.write(withTabHash(h.href, 'start'));
    // Another race: its load writes the new race's boat and time first (into the entry being left), then the race.
    nav.begin();
    nav.write(withParams(h.href, { boat: 'b9', t: '45' }));
    nav.write(withParams(h.href, { event: 'e1', div: 'A', race: '2' }));
    // The Coach tab.
    nav.begin();
    nav.write(withTabHash(h.href, 'coach'));
    // Fine-grained state on it: replaced.
    nav.write(withParams(h.href, { boat: 'b3' }));
    nav.write(withParams(h.href, { t: '90' }));
    // The report, then another event (no races yet: its card).
    nav.begin();
    nav.write(reportHref(h.href, true, '#coach'));
    nav.begin();
    nav.write(withParams(reportHref(h.href, false, '#coach'), { event: 'e2', div: null, race: null, boat: null, t: null }));
    expect(h.pushes).toEqual([
      '/regattas/start?event=e1&div=A&race=2&boat=b9&t=45#start',
      '/regattas/coach?event=e1&div=A&race=2&boat=b9&t=45#coach',
      '/regattas/report?event=e1&div=A&race=2&boat=b3&t=90#report',
      '/regattas?event=e2#coach',
    ]);
    const view = (url: string) => {
      const u = new URL(url, ORIGIN);
      return [pageView(u.search, u.hash), u.searchParams.get('event'), u.searchParams.get('race'), u.searchParams.get('boat')];
    };
    // The entry left before the race switch kept its own URL (not the new race's boat and time).
    expect(h.entries[0].url).toBe('/regattas/start?event=e1&div=A&race=1#start');
    expect(view(h.back())).toEqual(['report', 'e1', '2', 'b3']);
    expect(view(h.back())).toEqual(['coach', 'e1', '2', 'b3']);
    expect(view(h.back())).toEqual(['start', 'e1', '2', 'b9']);
    expect(view(h.back())).toEqual(['start', 'e1', '1', null]);
    expect(view(h.forward())).toEqual(['start', 'e1', '2', 'b9']);
    expect(view(h.forward())).toEqual(['coach', 'e1', '2', 'b3']);
  });

  it('following back / forward (cancel) replaces: no entry pushed over the forward ones', () => {
    const { h, nav } = setup();
    nav.begin();
    nav.write(withTabHash(h.href, 'race'));
    h.back();
    nav.cancel();
    nav.write(withTabHash(h.href, 'start'));
    expect(h.entries).toHaveLength(2);
    expect(h.i).toBe(0);
  });

  it('a move that fails (cancel) leaves the next write a replace', () => {
    const { h, nav } = setup();
    nav.begin();
    nav.cancel();
    nav.write(withParams(h.href, { event: 'e3', div: null, race: null }));
    expect(h.pushes).toEqual([]);
  });

  it('never pushes while full screen holds its own entry (push: false), nor for the same page', () => {
    const { h, nav } = setup();
    nav.begin();
    nav.write(withParams(h.href, { t: '10' }));
    expect(h.pushes).toEqual([]);
    nav.write(withParams(h.href, { race: '5' }), { push: false });
    expect(h.pushes).toEqual([]);
  });

  it('without history (pushState throws) it replaces instead', () => {
    const { h, nav } = setup();
    h.pushState = () => {
      throw new Error('SecurityError');
    };
    nav.begin();
    expect(() => nav.write(withTabHash(h.href, 'coach'))).not.toThrow();
    expect(h.entries[0].url).toBe('/regattas/coach?event=e1&div=A&race=1#coach');
  });
});

describe('back and forward (popAction)', () => {
  const race = (division: string, raceNumber: number) => ({ division, raceNumber });
  const shows = (o: Partial<Screen>): Screen => ({ card: '', eventId: '', race: null, ...o });
  const search = (url: string): string => new URL(url, ORIGIN).search;

  /**
   * The app, cut down: what each action leaves on screen. e1 has races A 1 (its default) and A 2; e2 has
   * none until `e2Races` (then B 1).
   */
  const app = () => {
    let screen = shows({});
    let e2Races = false;
    const open = (id: string, want?: { division: string; raceNumber: number }): Screen => {
      if (id === 'e2' && !e2Races) return shows({ card: 'e2', eventId: screen.eventId, race: screen.race });
      return shows({ eventId: id, race: want ?? (id === 'e1' ? race('A', 1) : race('B', 1)) });
    };
    const apply = (a: PopAction): void => {
      if (a.kind === 'picker') screen = shows({});
      else if (a.kind === 'event') screen = open(a.eventId, a.want);
      else if (a.kind === 'race') screen = { ...screen, race: race(a.division, a.raceNumber) };
    };
    return {
      get screen() {
        return screen;
      },
      set: (s: Screen) => void (screen = s),
      open: (id: string, want?: { division: string; raceNumber: number }) => void (screen = open(id, want)),
      racesPosted: () => void (e2Races = true),
      /** Back or forward to `url`: what popstate does. */
      pop: (url: string): PopAction => {
        const a = popAction(search(url), screen);
        apply(a);
        return a;
      },
    };
  };

  it('back to the empty /regattas picker, and forward again', () => {
    const h = new FakeHistory('/regattas');
    const nav = createNav({ history: h, href: () => h.href });
    const a = app();
    // Boot found nothing to open: the picker is empty. The user picks e1.
    nav.begin();
    a.open('e1');
    nav.write(withParams(h.href, { event: 'e1', div: 'A', race: '1' }));
    expect(h.pushes).toEqual(['/regattas/start?event=e1&div=A&race=1']);
    expect(a.pop(h.back())).toEqual({ kind: 'picker' });
    expect(a.screen).toEqual(shows({}));
    expect(a.pop(h.forward())).toEqual({ kind: 'event', eventId: 'e1', want: race('A', 1) });
    expect(a.screen).toEqual(shows({ eventId: 'e1', race: race('A', 1) }));
    // From a card, too.
    a.set(shows({ card: 'e2', eventId: 'e1', race: race('A', 1) }));
    expect(popAction('', a.screen)).toEqual({ kind: 'picker' });
    // Already empty: nothing to do.
    expect(popAction('', shows({}))).toEqual({ kind: 'none' });
  });

  it('within one event: another race, and back to the event card it was on', () => {
    const a = app();
    a.open('e1');
    // Another race of the same event: just that race.
    expect(a.pop('/regattas/start?event=e1&div=A&race=2')).toEqual({ kind: 'race', division: 'A', raceNumber: 2 });
    expect(a.pop('/regattas/coach?event=e1&div=A&race=1#coach')).toEqual({ kind: 'race', division: 'A', raceNumber: 1 });
    // The same race (a tab or the report): nothing to load.
    expect(a.pop('/regattas/report?event=e1&div=A&race=1#report')).toEqual({ kind: 'none' });

    // e2's card, then its first race once posted; back goes to the card's entry within e2.
    a.open('e2');
    expect(a.screen.card).toBe('e2');
    expect(a.pop('/regattas?event=e2')).toEqual({ kind: 'none' });
    a.racesPosted();
    expect(a.pop('/regattas/start?event=e2&div=B&race=1')).toEqual({ kind: 'event', eventId: 'e2', want: race('B', 1) });
    expect(a.screen).toEqual(shows({ eventId: 'e2', race: race('B', 1) }));
    expect(a.pop('/regattas?event=e2')).toEqual({ kind: 'event', eventId: 'e2' });
  });

  it('back from a race of an event to its card entry opens the event again (its card while it has no races)', () => {
    const a = app();
    a.open('e2');
    expect(a.screen).toEqual(shows({ card: 'e2' }));
    a.set(shows({ eventId: 'e2', race: race('B', 1) }));
    // Back to `/regattas?event=e2` with a race of e2 on screen: e2 is opened again (its card while it has no races).
    expect(a.pop('/regattas?event=e2')).toEqual({ kind: 'event', eventId: 'e2' });
    expect(a.screen.card).toBe('e2');
  });

  it('a card over another loaded event: back to that event reopens it (never a race of the wrong list)', () => {
    const s = shows({ card: 'e2', eventId: 'e1', race: race('A', 1) });
    expect(popAction(search('/regattas/start?event=e1&div=A&race=1'), s)).toEqual({ kind: 'event', eventId: 'e1', want: race('A', 1) });
    expect(popAction(search('/regattas/start?event=e2&div=B&race=1'), s)).toEqual({ kind: 'event', eventId: 'e2', want: race('B', 1) });
    expect(popAction(search('/regattas?event=e3'), shows({ eventId: 'e1', race: race('A', 1) }))).toEqual({ kind: 'event', eventId: 'e3' });
  });
});
