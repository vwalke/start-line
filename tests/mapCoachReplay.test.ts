import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import type { Card } from '../src/analysis/coach/rank';
import { startReplays, type StartReplay } from '../src/analysis/startReplay';
import { BOAT_PARAM } from '../src/ui/coach';
import { VS_PARAM, WIN_PARAM, cardMapHref, cardRoute, focusArrive, focusPendFromUrl, mapFocusLink, parseMapFocus, type MapFocus } from '../src/ui/mapLink';
import { REPLAY_PARAM, replayArrive, replayPendFromUrl, replayPending, replayRaceKey, type ReplayPend } from '../src/ui/replay';
import { T_PARAM, TRAIL_PARAM, parseTParam } from '../src/ui/scrub';
import { ic37Race } from './helpers';

/**
 * Map D on top of the per-race pending replay (df5d88c): a card's over-early route goes through replay.ts's
 * reducer, and a card's focus (`win=` / `vs=`) is kept per race the same way (IC37 North Americans race 5).
 */
const data = ic37Race();
const a = analyzeRace(data);
const raw = coachRaw(a, data);
const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null)!;
const gun = a.meta.gunMs;
const replays = startReplays(a, data);
const idOf = (sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
const cardOf = (sail: string, kind: Card['kind']): Card => coachDebrief(a, m, idOf(sail))!.cards.find((c) => c.kind === kind)!;
const EVENT = 'VaWTh1uA7TrLejoSFlUn';
const SEARCH = `?event=${EVENT}&div=IC37&race=5`;
const R5 = replayRaceKey(EVENT, 'IC37', 5);
const R4 = replayRaceKey(EVENT, 'IC37', 4);
const drawn = a.drawings.map((d) => d.id);
const U019 = idOf('USA 019');
const U027 = idOf('USA 027');

const searchOf = (href: string): string => href.split('#')[0];

/**
 * app.ts's wiring as events: openScrub ('shown' for both), show()'s focus reopen (focusArrive), the worker's
 * replays for the analysis on screen (replayArrive; replies for an older load dropped first, as askReplays does),
 * openReplay ('opened', leaving any focus) and openFocus ('opened', leaving any replay).
 */
function app(href: string) {
  let url = searchOf(href);
  let replayPend: ReplayPend | null = replayPendFromUrl(url);
  let focusPend: ReplayPend | null = focusPendFromUrl(url);
  let load = 0;
  let replayOn: string | null = null;
  let focusOn: MapFocus | null = null;
  const set = (k: string, v: string | null): void => {
    const p = new URLSearchParams(url);
    if (v == null) p.delete(k);
    else p.set(k, v);
    url = `?${p.toString()}`;
  };
  const leaveReplay = (): void => {
    if (replayPend) {
      replayPend = replayPending(replayPend, { type: 'left' });
      set(REPLAY_PARAM, null);
    }
    replayOn = null;
  };
  const leaveFocus = (): void => {
    if (focusPend) {
      focusPend = replayPending(focusPend, { type: 'left' });
      set(WIN_PARAM, null);
      set(VS_PARAM, null);
    }
    focusOn = null;
  };
  const openReplay = (race: string, r: StartReplay): void => {
    leaveFocus();
    replayOn = r.boat;
    replayPend = replayPending(replayPend, { type: 'opened', race, boat: r.boat });
    set(REPLAY_PARAM, r.boat);
  };
  const openFocus = (race: string, f: MapFocus): void => {
    leaveReplay();
    focusOn = f;
    focusPend = replayPending(focusPend, { type: 'opened', race, boat: f.boat });
    url = mapFocusLink(url, a, f);
  };
  return {
    /** A load of race `race` (each one, a reload included); returns the load's number. */
    show(race: string): number {
      replayOn = null;
      focusOn = null;
      replayPend = replayPending(replayPend, { type: 'shown', race });
      if (!replayPend) set(REPLAY_PARAM, null);
      focusPend = replayPending(focusPend, { type: 'shown', race });
      const res = focusArrive(focusPend, race, url, gun, drawn);
      focusPend = res.state;
      if (res.open) openFocus(race, res.open);
      else if (!focusPend) {
        set(WIN_PARAM, null);
        set(VS_PARAM, null);
      }
      return ++load;
    },
    arrive(n: number, race: string, rs: readonly StartReplay[]): void {
      if (n !== load) return;
      const res = replayArrive(replayPend, race, rs);
      replayPend = res.state;
      if (res.open) openReplay(race, res.open);
      else if (!replayPend) set(REPLAY_PARAM, null);
    },
    /** A card's "Show on map" clicked in the page (app.ts's delegated handler). */
    click(race: string, sail: string, c: Card): void {
      const route = cardRoute(a, idOf(sail), c, replays)!;
      if (route.kind === 'replay') openReplay(race, replays.find((r) => r.boat === route.boat)!);
      else openFocus(race, route.focus);
    },
    get replayOn() {
      return replayOn;
    },
    get focusOn() {
      return focusOn;
    },
    get replayPend() {
      return replayPend;
    },
    get focusPend() {
      return focusPend;
    },
    get url() {
      return url;
    },
  };
}

describe("USA 027's start card: a focus link, round-trip", () => {
  const c = cardOf('USA 027', 'D1');
  // Even from a page with a replay open: the focus link drops it.
  const href = cardMapHref(`${SEARCH}&replay=USA+019&t=-30&trail=all`, a, U027, c, replays)!;
  const p = new URLSearchParams(searchOf(href));

  it('boat=, t=, win=, vs=, trail=, #race; parsed back it is the card focus and rebuilds the same link', () => {
    const route = cardRoute(a, U027, c, replays);
    expect(route?.kind).toBe('focus');
    const f = route!.kind === 'focus' ? route!.focus : null!;
    expect(href.endsWith('#race')).toBe(true);
    expect(p.get(BOAT_PARAM)).toBe(U027);
    expect(parseTParam(p.get(T_PARAM))).toBe(-10);
    expect(p.get(TRAIL_PARAM)).toBe('all');
    expect(p.get(WIN_PARAM)).toBe(`-10,${Math.ceil((c.t1 - gun) / 1000)}`);
    expect(p.get(VS_PARAM)!.split(',')).toEqual(f.vs);
    const back = parseMapFocus(searchOf(href), gun)!;
    expect(back.boat).toBe(U027);
    expect(back.vs).toEqual(f.vs);
    expect(mapFocusLink(searchOf(href), a, back)).toBe(searchOf(href));
  });

  it('carries no replay=, so no pending replay; its focus is pending for race 5', () => {
    expect(p.get(REPLAY_PARAM)).toBeNull();
    expect(replayPendFromUrl(searchOf(href))).toBeNull();
    expect(focusPendFromUrl(searchOf(href))).toEqual({ race: R5, boat: U027 });
  });
});

describe("USA 019's over-early card: the replay link, through the pending-replay reducer", () => {
  const c = cardOf('USA 019', 'D1');
  const href = cardMapHref(`${SEARCH}&win=1,2&vs=USA+11`, a, U019, c, replays)!;

  it('routes to replayLink; the URL names its race and boat for replayPendFromUrl, and no focus', () => {
    expect(cardRoute(a, U019, c, replays)).toEqual({ kind: 'replay', boat: U019 });
    expect(replayPendFromUrl(searchOf(href))).toEqual({ race: R5, boat: 'USA 019' });
    expect(focusPendFromUrl(searchOf(href))).toBeNull();
  });

  it('opens USA 019 once the replays arrive, also after a same-race reload (shown → reload shown → arrived)', () => {
    const x = app(href);
    const first = x.show(R5);
    const second = x.show(R5);
    expect(x.replayPend).toEqual({ race: R5, boat: U019 });
    x.arrive(first, R5, replays); // the first load's reply: stale
    expect(x.replayOn).toBeNull();
    x.arrive(second, R5, replays);
    expect(x.replayOn).toBe(U019);
    expect(new URLSearchParams(x.url).get(REPLAY_PARAM)).toBe(U019);
    // Reloaded once more with the replay open: it reopens.
    const third = x.show(R5);
    x.arrive(third, R5, replays);
    expect(x.replayOn).toBe(U019);
    // Another race drops it.
    x.arrive(x.show(R4), R4, []);
    expect(x.replayPend).toBeNull();
    expect(new URLSearchParams(x.url).get(REPLAY_PARAM)).toBeNull();
  });

  it('without event= / div= / race= in the page, it binds to the first race shown (as df5d88c does)', () => {
    const bare = cardMapHref('', a, U019, c, replays)!;
    expect(replayPendFromUrl(searchOf(bare))).toEqual({ race: null, boat: U019 });
    const x = app(bare);
    x.arrive(x.show(R5), R5, replays);
    expect(x.replayOn).toBe(U019);
    expect(x.replayPend).toEqual({ race: R5, boat: U019 });
  });

  it("in-page: the card opens the replay ('opened'); a focus card then leaves it ('left'), and back", () => {
    const x = app(SEARCH);
    x.arrive(x.show(R5), R5, replays);
    x.click(R5, 'USA 019', c);
    expect(x.replayOn).toBe(U019);
    expect(x.replayPend).toEqual({ race: R5, boat: U019 });
    x.click(R5, 'USA 027', cardOf('USA 027', 'D1'));
    expect(x.replayOn).toBeNull();
    expect(x.replayPend).toBeNull();
    expect(x.focusOn?.boat).toBe(U027);
    expect(new URLSearchParams(x.url).get(REPLAY_PARAM)).toBeNull();
    // A reload now reopens the focus, not the old replay.
    const n = x.show(R5);
    x.arrive(n, R5, replays);
    expect(x.replayOn).toBeNull();
    expect(x.focusOn?.boat).toBe(U027);
    // Opening the replay leaves the focus.
    x.click(R5, 'USA 019', c);
    expect(x.focusOn).toBeNull();
    expect(x.focusPend).toBeNull();
    expect(new URLSearchParams(x.url).get(WIN_PARAM)).toBeNull();
    expect(new URLSearchParams(x.url).get(VS_PARAM)).toBeNull();
  });
});

describe('a focus link survives a reload of its race, and only that race', () => {
  const c = cardOf('USA 027', 'D1');
  const href = cardMapHref(SEARCH, a, U027, c, replays)!;
  const want = parseMapFocus(searchOf(href), gun)!;

  it('same-race reload (e.g. reapplyOfficial) keeps the focus, at the URL’s t=', () => {
    const x = app(href);
    x.show(R5);
    expect(x.focusOn).toEqual(want);
    x.show(R5);
    expect(x.focusOn).toEqual(want);
    expect(x.focusPend).toEqual({ race: R5, boat: U027 });
    expect(parseMapFocus(x.url, gun)).toEqual(want);
  });

  it('a different race drops it, and coming back does not bring it back', () => {
    const x = app(href);
    x.show(R5);
    x.show(R4);
    expect(x.focusOn).toBeNull();
    expect(x.focusPend).toBeNull();
    expect(new URLSearchParams(x.url).get(WIN_PARAM)).toBeNull();
    x.show(R5);
    expect(x.focusOn).toBeNull();
  });

  it('a link for another race never opens here', () => {
    const x = app(href.replace('race=5', 'race=4'));
    x.show(R5);
    expect(x.focusOn).toBeNull();
    expect(x.focusPend).toBeNull();
  });

  it('dropped when its boat is not drawn or its win= is malformed', () => {
    expect(focusArrive({ race: R5, boat: 'NOPE' }, R5, '?boat=NOPE&win=-10,20', gun, drawn)).toEqual({ open: null, state: null });
    expect(focusPendFromUrl(`?boat=${encodeURIComponent(U027)}&win=20,-10`)).toBeNull();
    expect(focusArrive({ race: R5, boat: U027 }, R5, `?boat=${encodeURIComponent(U027)}&win=20,-10`, gun, drawn)).toEqual({ open: null, state: null });
    // Another race's state is left alone (the reducer's 'shown' drops it).
    expect(focusArrive({ race: R4, boat: U027 }, R5, searchOf(href), gun, drawn)).toEqual({ open: null, state: { race: R4, boat: U027 } });
  });

  it('leaving the focus (✕ Full race, a leg, another boat, Fit, a replay) drops it for good', () => {
    const x = app(href);
    x.show(R5);
    x.click(R5, 'USA 019', cardOf('USA 019', 'D1'));
    x.show(R5);
    expect(x.focusOn).toBeNull();
  });
});
