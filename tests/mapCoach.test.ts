import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import type { Card } from '../src/analysis/coach/rank';
import { startReplays } from '../src/analysis/startReplay';
import { mapBox, scrubFrame } from '../src/ui/charts';
import { BOAT_PARAM } from '../src/ui/coach';
import { coachCardsHtml } from '../src/ui/coachCards';
import {
  MAP_VS_MAX,
  VS_PARAM,
  WIN_PARAM,
  cardFocus,
  cardMapActions,
  cardMapHref,
  cardRoute,
  coverTrail,
  focusExtent,
  focusFrom,
  focusTrail,
  focusView,
  isStartCard,
  mapFocusLegend,
  mapFocusLink,
  parseMapFocus,
  withMapActions,
  type MapFocus,
} from '../src/ui/mapLink';
import { boatAt, legRanges, rotator, timeRange } from '../src/ui/mapPieces';
import { drawingGapMs } from '../src/ui/mapPoints';
import { REPLAY_PARAM, parseReplayParam } from '../src/ui/replay';
import { T_PARAM, TRAIL_PARAM, parseTParam, parseTrail, scrubWindow, trailWindow } from '../src/ui/scrub';
import { viewBox } from '../src/ui/view';
import { ic37Race } from './helpers';

/**
 * Map D: a Coach card's "Show on map", on IC37 North Americans race 5 (mapReplay.test.ts, coachStartGolden.test.ts).
 * The cards there: USA 027's merged second-row start (D1, gun − 10 s → crossing + 5 min, against the front row),
 * D6 upwind cards against the whole fleet (USA 11 'slow'; USA 016 'low-fast' in two spans, the start cut out),
 * and USA 017 / USA 019 over early (D1 'ocs': Map C's replay).
 */
const data = ic37Race();
const a = analyzeRace(data);
const raw = coachRaw(a, data);
const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null)!;
const gun = a.meta.gunMs;
const replays = startReplays(a, data);
const idOf = (sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
const debOf = (sail: string) => coachDebrief(a, m, idOf(sail))!;
const cardOf = (sail: string, kind: Card['kind']): Card => debOf(sail).cards.find((c) => c.kind === kind)!;
const fit = mapBox(a, null);
const rot = rotator(a.wind.twdAtGunDeg);
const SEARCH = '?event=e1&div=IC37&race=5';

/** The link's parameters (no hash). */
const paramsOf = (href: string): URLSearchParams => new URLSearchParams(href.replace(/#race$/, ''));

/** The view rectangle for `f`, and whether a map point is in it. */
function framed(f: MapFocus) {
  const v = focusView(a, f, fit);
  const vb = viewBox(fit, v);
  const view = { x0: vb.x0, y0: vb.y0, x1: vb.x0 + vb.w, y1: vb.y0 + vb.h };
  const inView = ([x, y]: [number, number]): boolean => x >= view.x0 - 1e-6 && x <= view.x1 + 1e-6 && y >= view.y0 - 1e-6 && y <= view.y1 + 1e-6;
  return { v, view, inView };
}

/** Boat `id`'s drawn fixes over `spans`, in map coordinates. */
function fixesOver(id: string, spans: [number, number][]): [number, number][] {
  const d = a.drawings.find((x) => x.id === id)!;
  const out: [number, number][] = [];
  for (const g of legRanges(d, true)) {
    for (const [t0, t1] of spans) {
      const [i0, i1] = timeRange(g.src.t, t0, t1, g.lo, g.hi);
      for (let i = i0; i < i1; i++) out.push(rot([g.src.x[i], g.src.y[i]]));
    }
  }
  return out;
}

/** The view inside the fit box, zoomed at least to Fit, and every fix of the boat and the comparison boats over the window in it. */
function expectFramed(f: MapFocus, minFixes: number): void {
  const { v, view, inView } = framed(f);
  expect(v.k).toBeGreaterThanOrEqual(1);
  expect(view.x0).toBeGreaterThanOrEqual(fit.x0 - 1e-6);
  expect(view.y0).toBeGreaterThanOrEqual(fit.y0 - 1e-6);
  expect(view.x1).toBeLessThanOrEqual(fit.x1 + 1e-6);
  expect(view.y1).toBeLessThanOrEqual(fit.y1 + 1e-6);
  const own = fixesOver(f.boat, f.spans);
  expect(own.length).toBeGreaterThan(minFixes);
  for (const p of own) expect(inView(p)).toBe(true);
  for (const id of f.vs) {
    const theirs = fixesOver(id, f.spans);
    expect(theirs.length).toBeGreaterThan(0);
    for (const p of theirs) expect(inView(p)).toBe(true);
  }
  const e = focusExtent(a, f);
  expect(inView([e.x0, e.y0]) && inView([e.x1, e.y1])).toBe(true);
}

/** The link round-trips: boat=, t= (the window's end, whole s rounded up as win=), trail=win, vs=, win= (outward-rounded), #race. */
function expectLink(href: string, sail: string, c: Card, f: MapFocus): void {
  expect(href.endsWith('#race')).toBe(true);
  const p = paramsOf(href);
  expect(p.get('event')).toBe('e1');
  expect(p.get(BOAT_PARAM)).toBe(idOf(sail));
  expect(p.get(REPLAY_PARAM)).toBeNull();
  expect(parseTParam(p.get(T_PARAM))).toBe(Math.ceil((f.spans[f.spans.length - 1][1] - gun) / 1000));
  expect(parseTrail(p.get(TRAIL_PARAM))).toBe(focusTrail(f));
  expect(focusTrail(f)).toBe('win');
  expect(p.get(VS_PARAM)).toBe(f.vs.join(','));
  const back = parseMapFocus(href.replace(/#race$/, ''), gun)!;
  expect(back.boat).toBe(idOf(sail));
  expect(back.vs).toEqual(f.vs);
  expect(back.spans).toHaveLength(f.spans.length);
  back.spans.forEach(([p0, p1], i) => {
    const [q0, q1] = f.spans[i];
    expect(p0).toBeLessThanOrEqual(q0);
    expect(q0 - p0).toBeLessThan(1000);
    expect(p1).toBeGreaterThanOrEqual(q1);
    expect(p1 - q1).toBeLessThan(1000);
  });
  // The window is the card's.
  expect(f.spans[0][0]).toBe(c.spans?.[0][0] ?? c.t0);
  expect(f.spans[f.spans.length - 1][1]).toBe(c.spans?.at(-1)![1] ?? c.t1);
  // Read back, it opens the same: a link to the parsed focus is the same link.
  expect(mapFocusLink(SEARCH, a, back)).toBe(href.replace(/#race$/, ''));
}

describe("IC37 R5: USA 027's start card on the map", () => {
  const c = cardOf('USA 027', 'D1');
  const href = cardMapHref(SEARCH, a, idOf('USA 027'), c, replays)!;
  const route = cardRoute(a, idOf('USA 027'), c, replays);

  it('is the merged second-row start card (gun − 10 s → past the crossing), not a replay', () => {
    expect(c.variant).toBe('second-row');
    expect(c.t0).toBe(gun - 10_000);
    expect(route?.kind).toBe('focus');
  });

  it("links boat=USA 027, t= the window's end, trail=win, vs= the front row it was measured against, win=, #race", () => {
    const f = route!.kind === 'focus' ? route!.focus : null!;
    expect(f.vs).toEqual(c.refBoats.slice(0, MAP_VS_MAX));
    expect(f.vs.map((id) => a.boats.find((b) => b.id === id)!.sail)).toEqual(['GBR 015', 'USA 12', 'USA 005', 'USA 008', 'USA 11']);
    expect(parseTParam(paramsOf(href).get(T_PARAM))).toBe(Math.ceil((c.t1 - gun) / 1000));
    expect(paramsOf(href).get(TRAIL_PARAM)).toBe('win');
    expect(paramsOf(href).get(WIN_PARAM)).toBe(`-10,${Math.ceil((c.t1 - gun) / 1000)}`);
    expectLink(href, 'USA 027', c, f);
  });

  it('frames its track and the front row over the window, and the start line (the window has the gun)', () => {
    const f = cardFocus(a, idOf('USA 027'), c)!;
    expectFramed(f, 100);
    const { inView } = framed(f);
    expect(inView(rot(a.line.left))).toBe(true);
    expect(inView(rot(a.line.right))).toBe(true);
  });
});

describe('IC37 R5: a D6 upwind card on the map', () => {
  const sail = 'USA 11';
  const c = cardOf(sail, 'D6');
  const id = idOf(sail);
  const f = cardFocus(a, id, c)!;
  const href = cardMapHref(SEARCH, a, id, c, replays)!;

  it('the window lies within the beat', () => {
    const beat = a.drawings.find((d) => d.id === id)!.segments.filter((s) => s.leg === 0);
    const from = beat[0].t[0];
    const to = beat.at(-1)!.t.at(-1)!;
    expect(a.legs[0].name).toMatch(/^Beat/);
    for (const [p, q] of f.spans) {
      expect(p).toBeGreaterThanOrEqual(from - 1000);
      expect(q).toBeLessThanOrEqual(to + 1000);
    }
  });

  it(`compares with the ${MAP_VS_MAX} of the fleet nearest at the window's end`, () => {
    expect(c.refBoats.length).toBeGreaterThan(MAP_VS_MAX);
    expect(f.vs).toHaveLength(MAP_VS_MAX);
    expect(f.vs).not.toContain(id);
    for (const v of f.vs) expect(c.refBoats).toContain(v);
    const at = f.spans.at(-1)![1];
    const pos = (bid: string): [number, number] | null => {
      const d = a.drawings.find((x) => x.id === bid)!;
      const b = boatAt(bid, legRanges(d, true), at, drawingGapMs(d), a.wind.twdAtGunDeg);
      return b ? [b.mx, b.my] : null;
    };
    const me = pos(id)!;
    const dist = (bid: string): number => {
      const p = pos(bid);
      return p ? Math.hypot(p[0] - me[0], p[1] - me[1]) : Infinity;
    };
    const far = Math.max(...f.vs.map(dist));
    for (const other of c.refBoats.filter((x) => x !== id && !f.vs.includes(x))) expect(dist(other)).toBeGreaterThanOrEqual(far);
  });

  it('links and frames as the start card does (trail win; once left, All: the beat is longer than 2 min)', () => {
    expect(cardRoute(a, id, c, replays)?.kind).toBe('focus');
    expect(coverTrail(f)).toBe('all');
    expectLink(href, sail, c, f);
    expectFramed(f, 150);
  });
});

describe('IC37 R5: over-early start cards go to the replay (Map C)', () => {
  for (const sail of ['USA 019', 'USA 017']) {
    it(`${sail}: replay=, t=−30, trail=all; still so with the variant renamed (a penalty card)`, () => {
      const c = cardOf(sail, 'D1');
      expect(c.variant).toBe('ocs');
      for (const card of [c, { ...c, variant: 'penalty' }]) {
        expect(cardRoute(a, idOf(sail), card, replays)).toEqual({ kind: 'replay', boat: idOf(sail) });
        const href = cardMapHref(`${SEARCH}&win=1,2&vs=USA+11`, a, idOf(sail), card, replays)!;
        expect(href.endsWith('#race')).toBe(true);
        const p = paramsOf(href);
        expect(parseReplayParam(p.get(REPLAY_PARAM))).toBe(idOf(sail));
        expect(parseTParam(p.get(T_PARAM))).toBe(-30);
        expect(p.get(TRAIL_PARAM)).toBe('all');
        expect(p.get(BOAT_PARAM)).toBe(idOf(sail));
        // A focus in the page's URL doesn't come along.
        expect(p.get(WIN_PARAM)).toBeNull();
        expect(p.get(VS_PARAM)).toBeNull();
        expect(p.get('race')).toBe('5');
      }
    });
  }

  it('keyed on the boat having a replay and a start window, not on the card kind or variant', () => {
    const c = cardOf('USA 019', 'D1');
    // A start card of another kind (a window from the gun) still goes there…
    const d3: Card = { ...c, kind: 'D3', variant: 'penalty', t0: gun, t1: gun + 300_000 };
    expect(isStartCard(d3, gun)).toBe(true);
    expect(cardRoute(a, idOf('USA 019'), { ...c, kind: 'D3', t0: gun, t1: gun + 300_000 }, replays)?.kind).toBe('replay');
    // …a later window doesn't, nor does a boat without a replay, nor before the replays are known.
    expect(cardRoute(a, idOf('USA 019'), { ...c, kind: 'D6', t0: gun + 400_000, t1: gun + 900_000 }, replays)?.kind).toBe('focus');
    expect(cardRoute(a, idOf('USA 027'), cardOf('USA 027', 'D1'), replays)?.kind).toBe('focus');
    expect(cardRoute(a, idOf('USA 019'), c, [])?.kind).toBe('focus');
    const usa020 = cardOf('USA 020', 'D6');
    expect(cardRoute(a, idOf('USA 020'), usa020, [{ boat: idOf('USA 020') }])?.kind).toBe('focus');
  });
});

describe('IC37 R5: a card in several spans frames their union', () => {
  it("USA 016's D6 (its start cut out): two spans in win=, both framed", () => {
    const c = cardOf('USA 016', 'D6');
    expect(c.spans!.length).toBe(2);
    const f = cardFocus(a, idOf('USA 016'), c)!;
    expect(f.spans).toEqual(c.spans);
    const href = cardMapHref(SEARCH, a, idOf('USA 016'), c, replays)!;
    expect(paramsOf(href).get(WIN_PARAM)!.split(',')).toHaveLength(4);
    expectLink(href, 'USA 016', c, f);
    expectFramed(f, 50);
  });

  it("a card across the beat and the run (as D7 over the runs): t= the last span's end, trail win (All once left), both stretches in view", () => {
    const c = cardOf('USA 016', 'D6');
    const run = a.drawings.find((d) => d.id === idOf('USA 016'))!.segments.find((s) => s.leg === 1)!;
    const spans: [number, number][] = [
      [gun + 120_000, gun + 240_000],
      [run.t[0] + 60_000, run.t[0] + 300_000],
    ];
    const d7: Card = { ...c, kind: 'D7', variant: 'low', t0: spans[0][0], t1: spans[1][1], spans };
    const f = cardFocus(a, idOf('USA 016'), d7)!;
    expect(f.spans).toEqual(spans);
    expect(coverTrail(f)).toBe('all');
    const href = cardMapHref(SEARCH, a, idOf('USA 016'), d7, replays)!;
    expect(parseTParam(paramsOf(href).get(T_PARAM))).toBe(Math.ceil((spans[1][1] - gun) / 1000));
    expectLink(href, 'USA 016', d7, f);
    expectFramed(f, 50);
    // Both stretches count: the union's frame is bigger than either span's alone.
    const one = focusExtent(a, { ...f, spans: [spans[0]] });
    const two = focusExtent(a, { ...f, spans: [spans[1]] });
    const both = focusExtent(a, f);
    expect(both.x0).toBeLessThanOrEqual(Math.min(one.x0, two.x0) + 1e-9);
    expect(both.x1).toBeGreaterThanOrEqual(Math.max(one.x1, two.x1) - 1e-9);
    expect(both.y0).toBeLessThanOrEqual(Math.min(one.y0, two.y0) + 1e-9);
    expect(both.y1).toBeGreaterThanOrEqual(Math.max(one.y1, two.y1) - 1e-9);
    expect(both.y1 - both.y0).toBeGreaterThan(Math.max(one.y1 - one.y0, two.y1 - two.y0));
  });
});

describe('trail and URL rules', () => {
  const f = (s0: number, s1: number): MapFocus => ({ boat: 'X', vs: [], spans: [[gun + s0 * 1000, gun + s1 * 1000]] });
  it("the window's own trail; once left, the shortest usual trail that covers the window", () => {
    for (const x of [f(0, 30), f(0, 500)]) expect(focusTrail(x)).toBe('win');
    expect(coverTrail(f(0, 30))).toBe('30');
    expect(coverTrail(f(0, 31))).toBe('120');
    expect(coverTrail(f(-10, 110))).toBe('120');
    expect(coverTrail(f(0, 121))).toBe('all');
  });

  it('parses only a well-formed win= with a boat; vs= deduped, without the boat, capped', () => {
    expect(parseMapFocus('?boat=A&win=-10,20', gun)).toEqual({ boat: 'A', vs: [], spans: [[gun - 10_000, gun + 20_000]] });
    expect(parseMapFocus('?boat=A&win=%E2%88%9210,20', gun)?.spans).toEqual([[gun - 10_000, gun + 20_000]]);
    expect(parseMapFocus('?win=-10,20', gun)).toBeNull();
    expect(parseMapFocus('?boat=A', gun)).toBeNull();
    for (const w of ['10', '10,5', '1,2,3', 'a,b', '1,,2', '']) expect(parseMapFocus(`?boat=A&win=${w}`, gun)).toBeNull();
    expect(parseMapFocus('?boat=A&win=300,400,0,100', gun)?.spans).toEqual([
      [gun, gun + 100_000],
      [gun + 300_000, gun + 400_000],
    ]);
    expect(parseMapFocus('?boat=A&win=0,1&vs=B,A,C,B,D,E,F,G', gun)?.vs).toEqual(['B', 'C', 'D', 'E', 'F']);
  });

  it('a focus link keeps other parameters and drops a replay', () => {
    const p = paramsOf(mapFocusLink('?event=e1&replay=USA+019&trail=30', a, f(0, 200)));
    expect(p.get('event')).toBe('e1');
    expect(p.get(REPLAY_PARAM)).toBeNull();
    expect(p.get(TRAIL_PARAM)).toBe('win');
    expect(p.get(T_PARAM)).toBe('200');
    expect(p.get(VS_PARAM)).toBeNull();
    expect(p.get(WIN_PARAM)).toBe('0,200');
  });
});

describe('IC37 R5: the cards get one "Show on map" each, and are otherwise unchanged', () => {
  const ACTION = /\n {4}<p class="opp-map"><a class="opp-map-link" [^>]*>Show on map <span aria-hidden="true">→<\/span><\/a><\/p>/g;
  for (const b of a.boats) {
    it(`${b.sail}`, () => {
      const d = coachDebrief(a, m, b.id);
      if (!d) return;
      const html = coachCardsHtml(a, d, null, b.coverage ?? null);
      const actions = cardMapActions(a, b.id, d.cards, replays, SEARCH);
      const out = withMapActions(html, actions);
      // Exactly one per card (every card has a window), inside it, at its end.
      expect(out.match(ACTION)?.length ?? 0).toBe(d.cards.length);
      for (let i = 0; i < d.cards.length; i++) {
        const card = new RegExp(`<article class="card coach-opp[^"]*" data-opp="${i}"[\\s\\S]*?</article>`).exec(out)![0];
        expect(card.match(/class="opp-map-link"/g)).toHaveLength(1);
        expect(card).toMatch(/<\/a><\/p>\s*<\/article>$/);
        expect(card).toContain(`data-map-opp="${i}"`);
      }
      // Strip them and it is the cards as before.
      expect(out.replace(ACTION, '')).toBe(html);
    });
  }

  it('a card without a window gets none; a selected card (class "on") still gets its own', () => {
    const d = debOf('USA 027');
    const cards = [...d.cards];
    cards[0] = { ...cards[0], t0: NaN, t1: NaN };
    const actions = cardMapActions(a, idOf('USA 027'), cards, replays, SEARCH);
    expect(actions[0]).toBe('');
    const html = coachCardsHtml(a, d, 0, null);
    expect(html).toContain('class="card coach-opp on"');
    const out = withMapActions(html, cardMapActions(a, idOf('USA 027'), d.cards, replays, SEARCH));
    expect(out.match(/class="opp-map-link"/g)).toHaveLength(d.cards.length);
    expect(withMapActions(html, [])).toBe(html);
  });

  it("the link is the card's own: escaped in the href, the comparison boats in its title", () => {
    const d = debOf('USA 027');
    const i = d.cards.findIndex((x) => x.kind === 'D1');
    const c = d.cards[i];
    const act = cardMapActions(a, idOf('USA 027'), d.cards, replays, SEARCH)[i];
    const href = cardMapHref(SEARCH, a, idOf('USA 027'), c, replays)!;
    expect(act).toContain(`href="${href.replace(/&/g, '&amp;')}"`);
    expect(act).toContain('title="On the track map, vs GBR 015 · USA 12 · USA 005 · USA 008 · USA 11"');
    const ocs = debOf('USA 019');
    expect(cardMapActions(a, idOf('USA 019'), ocs.cards, replays, SEARCH).join('')).toContain('title="Replay the start on the track map"');
  });
});

describe('IC37 R5: the comparison boats drawn while scrubbing', () => {
  const c = cardOf('USA 027', 'D1');
  const f = cardFocus(a, idOf('USA 027'), c)!;
  const w = scrubWindow(a);
  const t = c.t0 + 60_000;
  const frame = (vs: readonly string[] | null) => scrubFrame(a, f.boat, null, { vs, view: focusView(a, f, fit) }, { t, win: trailWindow(t, focusTrail(f), w, focusFrom(f)) });

  it('their trails cased (trk-vs), their dots ringed (dot vs, dot-vs) and labelled; the boat itself stays the selection', () => {
    const fr = frame(f.vs);
    for (const id of f.vs) {
      const sail = a.boats.find((b) => b.id === id)!.sail;
      expect(fr.tracks).toContain(`class="trk-vs" data-id="${id}"`);
      expect(fr.dots).toMatch(new RegExp(`<g class="boat-at vs"><circle class="dot-vs"[^>]*/>(<line[^>]*/>)?<circle class="dot vs" data-id="${id}"`));
      expect(fr.dots).toContain(`class="dot-lbl vs"`);
      expect(fr.dots).toContain(`>${sail}</text>`);
    }
    expect(fr.tracks).not.toContain(`class="trk-vs" data-id="${f.boat}"`);
    expect(fr.dots).toContain(`class="dot on" data-id="${f.boat}"`);
    expect(fr.dots.match(/class="dot-vs"/g)).toHaveLength(f.vs.length);
    // The casing is under the tracks; the selected boat's dot is drawn last.
    expect(fr.tracks.indexOf('trk-vs')).toBeLessThan(fr.tracks.indexOf('class="trk '));
    expect(fr.dots.lastIndexOf('<g class="boat-at')).toBe(fr.dots.indexOf('<g class="boat-at on"'));
  });

  it('the legend line lists them by sail', () => {
    const html = mapFocusLegend(a, f);
    expect(html.replace(/<[^>]+>/g, '')).toBe('vs GBR 015 · USA 12 · USA 005 · USA 008 · USA 11');
    expect(mapFocusLegend(a, { ...f, vs: [] })).toBe('');
    expect(mapFocusLegend(a, null)).toBe('');
  });

  it('nothing of it without comparison boats', () => {
    for (const fr of [frame(null), frame([])]) {
      expect(fr.tracks).not.toContain('trk-vs');
      expect(fr.dots).not.toContain('dot-vs');
      expect(fr.dots).not.toContain(' vs"');
    }
  });
});
