import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import type { Card } from '../src/analysis/coach/rank';
import { startReplays } from '../src/analysis/startReplay';
import { mapBox, scrubFrame } from '../src/ui/charts';
import {
  cardFocus,
  cardMapHref,
  cardRoute,
  coverTrail,
  focusArrive,
  focusFrom,
  focusPendFromUrl,
  focusPlayFrom,
  focusResume,
  focusTime,
  focusTrail,
  focusView,
  mapFocusLink,
  parseMapFocus,
  trailAfterFocus,
  type MapFocus,
} from '../src/ui/mapLink';
import { legRanges, timeRange } from '../src/ui/mapPieces';
import { replayPending, replayRaceKey } from '../src/ui/replay';
import { DEFAULT_TRAIL, TRAIL_PARAM, T_PARAM, WINDOW_TRAIL, parseTParam, playFrom, scrubParams, scrubWindow, timeOfParam, trailWindow, type Trail } from '../src/ui/scrub';
import { ic37Race } from './helpers';

/**
 * Map D, the framed view shows the finding: "Show on map" parks the scrubber at the card window's end with the
 * window's own trail (from its start), so paused, the boat's and the comparison boats' tracks over the whole window
 * are drawn, and nothing before it (IC37 North Americans race 5, as mapCoach.test.ts).
 */
const data = ic37Race();
const a = analyzeRace(data);
const raw = coachRaw(a, data);
const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null)!;
const gun = a.meta.gunMs;
const replays = startReplays(a, data);
const w = scrubWindow(a);
const fit = mapBox(a, null);
const idOf = (sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
const cardOf = (sail: string, kind: Card['kind']): Card => coachDebrief(a, m, idOf(sail))!.cards.find((c) => c.kind === kind)!;
const EVENT = 'VaWTh1uA7TrLejoSFlUn';
const SEARCH = `?event=${EVENT}&div=IC37&race=5`;
const R5 = replayRaceKey(EVENT, 'IC37', 5);
const searchOf = (href: string): string => href.split('#')[0];
/** A query string with its parameters in a fixed order (setting one may move it). */
const norm = (q: string): string => {
  const p = new URLSearchParams(q);
  p.sort();
  return p.toString();
};

/** A boat's first and last drawn fixes in a window lie within this of its ends (the drawn tracks are thinned), ms. */
const NEAR_MS = 30_000;

/** Boat `id`'s drawn fix times in [t0, t1], in order (the source the map draws). */
function fixTimes(id: string, t0: number, t1: number): number[] {
  const d = a.drawings.find((x) => x.id === id)!;
  const out: number[] = [];
  for (const g of legRanges(d, true)) {
    const [i0, i1] = timeRange(g.src.t, t0, t1, g.lo, g.hi);
    for (let i = i0; i < i1; i++) out.push(g.src.t[i]);
  }
  return out.sort((x, y) => x - y);
}

/** The drawn trail's time span per boat in a frame at `t` with trail window `win`. */
function drawnSpans(f: MapFocus, t: number, win: [number, number]): Map<string, [number, number]> {
  const fr = scrubFrame(a, f.boat, null, { vs: f.vs, view: focusView(a, f, fit) }, { t, win });
  const out = new Map<string, [number, number]>();
  for (const pc of fr.pieces) {
    if (pc.i1 <= pc.i0) continue;
    const [p, q] = [pc.src.t[pc.i0], pc.src.t[pc.i1 - 1]];
    const was = out.get(pc.id);
    out.set(pc.id, was ? [Math.min(was[0], p), Math.max(was[1], q)] : [p, q]);
  }
  return out;
}

/** Parked as the link opens it: at the window's end, the window's trail from its start; the drawn tracks span the window. */
function expectShowsWindow(f: MapFocus): void {
  const t0 = f.spans[0][0];
  const t1 = f.spans[f.spans.length - 1][1];
  const t = focusTime(f);
  expect(t).toBe(t1);
  expect(focusTrail(f)).toBe(WINDOW_TRAIL);
  const win = trailWindow(t, focusTrail(f), w, focusFrom(f));
  // The trail holds the whole window (the union from the first span's start), and starts exactly there.
  expect(win[0]).toBeLessThanOrEqual(t0);
  expect(win[1]).toBeGreaterThanOrEqual(t1);
  expect(win[0]).toBe(Math.max(w.t0, t0));
  const drawn = drawnSpans(f, t, win);
  // A boat's drawn trail runs from its first fix in the window to its last (each near the window's ends).
  const reaches = (id: string): boolean => {
    const s = drawn.get(id);
    const fx = fixTimes(id, t0, t1);
    return !!s && fx.length > 0 && s[0] <= fx[0] && s[1] >= fx[fx.length - 1] && fx[0] - t0 <= NEAR_MS && t1 - fx[fx.length - 1] <= NEAR_MS;
  };
  expect(reaches(f.boat)).toBe(true);
  expect(f.vs.length).toBeGreaterThan(0);
  expect(f.vs.some(reaches)).toBe(true);
  // Nothing far before the window.
  for (const [, [p]] of drawn) expect(p).toBeGreaterThanOrEqual(t0 - 1000);
}

describe('the framed view opens showing the window', () => {
  it('USA 027 second-row start (gun − 10 s → past the crossing): its track and the front row through the window, paused', () => {
    const c = cardOf('USA 027', 'D1');
    expect(c.variant).toBe('second-row');
    const route = cardRoute(a, idOf('USA 027'), c, replays)!;
    expect(route.kind).toBe('focus');
    const f = route.kind === 'focus' ? route.focus : null!;
    expectShowsWindow(f);
    // As it was (the window's start, All): nothing of the window after its start was drawn.
    const before = drawnSpans(f, f.spans[0][0], trailWindow(f.spans[0][0], 'all', w));
    expect(before.get(f.boat)![1]).toBeLessThanOrEqual(f.spans[0][0]);
  });

  it('a D6 upwind card (USA 11): the same over its beat window', () => {
    const c = cardOf('USA 11', 'D6');
    const route = cardRoute(a, idOf('USA 11'), c, replays)!;
    expect(route.kind).toBe('focus');
    expectShowsWindow(route.kind === 'focus' ? route.focus : null!);
  });

  it("USA 016's two-span D6: over the union, from the first span's start to the last one's end", () => {
    const c = cardOf('USA 016', 'D6');
    expect(c.spans!.length).toBe(2);
    const f = cardFocus(a, idOf('USA 016'), c)!;
    expectShowsWindow(f);
    expect(focusTime(f)).toBe(c.spans![1][1]);
    expect(focusFrom(f)).toBe(c.spans![0][0]);
  });

  it('a synthetic card across the beat and the run: the union too', () => {
    const c = cardOf('USA 016', 'D6');
    const run = a.drawings.find((d) => d.id === idOf('USA 016'))!.segments.find((s) => s.leg === 1)!;
    const spans: [number, number][] = [
      [gun + 120_000, gun + 240_000],
      // Within the run's drawn track (the race ends under 5 min into it).
      [run.t[0] + 60_000, Math.min(run.t[0] + 300_000, run.t[run.t.length - 1] - 30_000)],
    ];
    expect(spans[1][1]).toBeGreaterThan(spans[1][0] + 60_000);
    expectShowsWindow(cardFocus(a, idOf('USA 016'), { ...c, t0: spans[0][0], t1: spans[1][1], spans })!);
  });
});

describe("the window's trail", () => {
  const from = gun + 100_000;
  it('[from, t] from the window start; before it, the default trail; with no window, All', () => {
    expect(trailWindow(gun + 400_000, WINDOW_TRAIL, w, from)).toEqual([from, gun + 400_000]);
    expect(trailWindow(from, WINDOW_TRAIL, w, from)).toEqual([from, from]);
    expect(trailWindow(gun + 50_000, WINDOW_TRAIL, w, from)).toEqual(trailWindow(gun + 50_000, DEFAULT_TRAIL, w));
    expect(trailWindow(gun + 400_000, WINDOW_TRAIL, w)).toEqual(trailWindow(gun + 400_000, 'all', w));
    expect(trailWindow(gun, WINDOW_TRAIL, w, w.t0 - 60_000)).toEqual([w.t0, gun]);
  });

  it('leaving the focus: the window trail becomes the shortest usual one covering the window (All with none); others stay', () => {
    const f = (s0: number, s1: number): MapFocus => ({ boat: 'X', vs: [], spans: [[gun + s0 * 1000, gun + s1 * 1000]] });
    expect(trailAfterFocus(WINDOW_TRAIL, f(0, 25))).toBe('30');
    expect(trailAfterFocus(WINDOW_TRAIL, f(0, 100))).toBe('120');
    expect(trailAfterFocus(WINDOW_TRAIL, f(0, 500))).toBe('all');
    expect(trailAfterFocus(WINDOW_TRAIL, null)).toBe('all');
    for (const t of ['30', '120', 'all'] as Trail[]) expect(trailAfterFocus(t, f(0, 500))).toBe(t);
    const c = cardOf('USA 027', 'D1');
    const real = cardFocus(a, idOf('USA 027'), c)!;
    expect(trailAfterFocus(WINDOW_TRAIL, real)).toBe(coverTrail(real));
    expect(['30', '120', 'all']).toContain(coverTrail(real));
    // The usual trail still holds the window at the parked time.
    const win = trailWindow(focusTime(real), coverTrail(real), w);
    expect(win[0]).toBeLessThanOrEqual(real.spans[0][0]);
  });
});

describe('Play from the parked end', () => {
  const f = cardFocus(a, idOf('USA 027'), cardOf('USA 027', 'D1'))!;
  it("parked (within the URL's whole second): plays the window from its start; elsewhere, as ever", () => {
    expect(focusPlayFrom(f, focusTime(f), w)).toBe(focusFrom(f));
    expect(focusPlayFrom(f, focusTime(f) - 600, w)).toBe(focusFrom(f));
    expect(focusPlayFrom(f, focusTime(f) + 1000, w)).toBe(focusFrom(f));
    const mid = (focusFrom(f) + focusTime(f)) / 2;
    expect(focusPlayFrom(f, mid, w)).toBe(playFrom(mid, w));
    expect(focusPlayFrom(f, null, w)).toBe(playFrom(null, w));
    expect(focusPlayFrom(f, w.t1, w)).toBe(playFrom(w.t1, w));
    expect(focusPlayFrom(null, focusTime(f), w)).toBe(playFrom(focusTime(f), w));
    // Played from there, the trail grows from the window start (it is never empty for long, nor before it).
    expect(trailWindow(focusFrom(f) + 5000, WINDOW_TRAIL, w, focusFrom(f))).toEqual([focusFrom(f), focusFrom(f) + 5000]);
  });
});

describe('deep links: the parked state round-trips, and older links park the same', () => {
  const c = cardOf('USA 027', 'D1');
  const href = cardMapHref(SEARCH, a, idOf('USA 027'), c, replays)!;
  const search = searchOf(href);
  const p = new URLSearchParams(search);

  /** A load of the page at `url` (openScrub's 'shown', then show()'s focusArrive), as app.ts. */
  const reopen = (url: string) => {
    const pend = replayPending(focusPendFromUrl(url), { type: 'shown', race: R5 });
    return focusArrive(pend, R5, url, gun, a.drawings.map((d) => d.id));
  };
  /** The URL after openFocus(f, at): the focus link with the scrubber's own t= / trail=. */
  const urlAfter = (url: string, f: MapFocus, t: number, trail: Trail): string => {
    const q = new URLSearchParams(mapFocusLink(url, a, f));
    for (const [k, v] of Object.entries(scrubParams(timeOfParam((t - gun) / 1000, gun, w), gun, trail))) {
      if (v == null) q.delete(k);
      else q.set(k, v);
    }
    return `?${q.toString()}`;
  };

  it('t= the window end (as win= rounds it), trail=win; it reopens there, and a reload reopens identically', () => {
    const f = parseMapFocus(search, gun)!;
    expect(parseTParam(p.get(T_PARAM))).toBe(Math.ceil((c.t1 - gun) / 1000));
    expect(p.get(TRAIL_PARAM)).toBe('win');
    expect(focusResume(f, search, gun)).toEqual({ t: focusTime(f), trail: WINDOW_TRAIL });
    const first = reopen(search);
    expect(first.open).toEqual(f);
    expect(first.at).toEqual({ t: focusTime(f), trail: WINDOW_TRAIL });
    expect(first.state).toEqual({ race: R5, boat: idOf('USA 027') });
    const after = urlAfter(search, first.open!, first.at!.t, first.at!.trail);
    expect(after).toBe(search);
    // Same-race reload: the same focus, time and trail, the same URL.
    const second = reopen(after);
    expect(second).toEqual(first);
    expect(urlAfter(after, second.open!, second.at!.t, second.at!.trail)).toBe(search);
    // Parked as reloaded, the window still shows.
    expectShowsWindow(second.open!);
  });

  it('scrubbed or with another trail while the focus is on: a reload keeps that', () => {
    const f = parseMapFocus(search, gun)!;
    const mid = new URLSearchParams(search);
    mid.set(T_PARAM, '60');
    expect(reopen(`?${mid}`).at).toEqual({ t: gun + 60_000, trail: WINDOW_TRAIL });
    mid.set(TRAIL_PARAM, '30');
    expect(reopen(`?${mid}`).at).toEqual({ t: gun + 60_000, trail: '30' });
    // At the window's start with the window's own trail: kept (only an older link's usual trail parks).
    mid.set(T_PARAM, String(Math.floor((f.spans[0][0] - gun) / 1000)));
    mid.set(TRAIL_PARAM, 'win');
    expect(reopen(`?${mid}`).at).toEqual({ t: f.spans[0][0], trail: WINDOW_TRAIL });
  });

  it('an older link (t= the window start, trail=all / 120 / 30, or no t=) parks at the window end with the window trail', () => {
    const f = parseMapFocus(search, gun)!;
    for (const trail of ['all', '30', null] as const) {
      const old = new URLSearchParams(search);
      old.set(T_PARAM, '-10');
      if (trail) old.set(TRAIL_PARAM, trail);
      else old.delete(TRAIL_PARAM); // the 2 min default
      const res = reopen(`?${old}`);
      expect(res.open).toEqual(f);
      expect(res.at).toEqual({ t: focusTime(f), trail: WINDOW_TRAIL });
      expect(norm(urlAfter(`?${old}`, res.open!, res.at!.t, res.at!.trail))).toBe(norm(search));
    }
    const none = new URLSearchParams(search);
    none.delete(T_PARAM);
    none.delete(TRAIL_PARAM);
    expect(reopen(`?${none}`).at).toEqual({ t: focusTime(f), trail: WINDOW_TRAIL });
  });
});
