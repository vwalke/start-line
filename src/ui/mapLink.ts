/**
 * Coach → track map (Map D): a card's "Show on map", as pure pieces. A card with a window opens the Race
 * tab's map on it: the whole race, the card's boat selected, the scrubber paused at the window's start
 * with a trail that covers it, the view framing the boat's drawn track over the window (the union of its
 * spans) with the comparison boats' (the card's `refBoats`, at most MAP_VS_MAX), and those boats ringed
 * and listed ("vs USA 11 · GBR 015 · USA 12").
 *
 * A start card for a boat over early goes to Map C's replay instead (replay.ts): keyed on the boat having
 * a replay (the worker's start facts) and the card being a start card (D1, or a window from the gun),
 * never on the card's variant, so a renamed over-early or penalty card still goes there.
 *
 * The URL: `boat=` (Coach's), `vs=<id>,<id>`, `win=<s0>,<s1>[,<s2>,<s3>…]` (gun-relative seconds, each
 * pair a span, rounded outward) with the scrubber's `t=` / `trail=`, and `#race`.
 *
 * The cards themselves are not touched (coachCards.ts): `withMapActions` appends one link to each.
 */
import type { Card } from '../analysis/coach/rank';
import type { StartReplay } from '../analysis/startReplay';
import type { RaceAnalysis } from '../analysis/types';
import { BOAT_PARAM } from './coach';
import { esc } from './format';
import { boatAt, legRanges, rotator, timeRange } from './mapPieces';
import { drawingGapMs } from './mapPoints';
import { REPLAY_PARAM, replayLink, replayPendFromUrl, type ReplayPend } from './replay';
import { mapTimeSearch, paramOfTime, parseTParam, type Trail } from './scrub';
import { clampView, type Box, type View } from './view';

export const VS_PARAM = 'vs';
export const WIN_PARAM = 'win';
/** At most this many comparison boats are drawn ringed (more: the nearest to the boat at the window's end). */
export const MAP_VS_MAX = 5;
/** A card whose window starts no later than this after the gun (and ends after it) is a start card, s. */
export const START_NEAR_S = 30;
/** The shortest trail that covers a window this long, s: 30 s, then 2 min; longer, All. */
export const TRAIL_30_MAX_S = 30;
export const TRAIL_120_MAX_S = 120;

/** What the map frames for a card: its boat, the comparison boats, and the window's spans (ms, in order). */
export interface MapFocus {
  boat: string;
  vs: string[];
  spans: [number, number][];
}

type Windowed = Pick<Card, 'kind' | 't0' | 't1' | 'spans'>;

/** A card's spans (its `spans`, else [t0, t1]), the empty and malformed ones left out, in time order. */
export function windowSpans(c: Pick<Card, 't0' | 't1' | 'spans'>): [number, number][] {
  return (c.spans ?? [[c.t0, c.t1]])
    .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && q > p)
    .map(([p, q]): [number, number] => [p, q])
    .sort((x, y) => x[0] - y[0]);
}

/** Where the focus opens the scrubber: the window's start. */
export const focusTime = (f: Pick<MapFocus, 'spans'>): number => f.spans[0][0];

/** The trail that covers the window from its start to its end (spans and all). */
export function focusTrail(f: Pick<MapFocus, 'spans'>): Trail {
  const s = (f.spans[f.spans.length - 1][1] - f.spans[0][0]) / 1000;
  return s <= TRAIL_30_MAX_S ? '30' : s <= TRAIL_120_MAX_S ? '120' : 'all';
}

/** Boat `id`'s drawn position at `t` (map coordinates), null where it has none. */
function posAt(a: RaceAnalysis, id: string, t: number): [number, number] | null {
  const d = a.drawings.find((x) => x.id === id);
  const b = d ? boatAt(id, legRanges(d, true), t, drawingGapMs(d), a.wind.twdAtGunDeg) : null;
  return b ? [b.mx, b.my] : null;
}

/**
 * The comparison boats: `refs` (the card's, in its order) less the boat itself and any not drawn; with more
 * than MAP_VS_MAX, the MAP_VS_MAX nearest to the boat at `at` (those with no position there last).
 */
export function comparisonBoats(a: RaceAnalysis, boat: string, refs: readonly string[], at: number): string[] {
  const ids = [...new Set(refs)].filter((id) => id !== boat && a.drawings.some((d) => d.id === id));
  if (ids.length <= MAP_VS_MAX) return ids;
  const me = posAt(a, boat, at);
  if (!me) return ids.slice(0, MAP_VS_MAX);
  const dist = (id: string): number => {
    const p = posAt(a, id, at);
    return p ? Math.hypot(p[0] - me[0], p[1] - me[1]) : Infinity;
  };
  return ids
    .map((id, i) => ({ id, i, d: dist(id) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .slice(0, MAP_VS_MAX)
    .map((x) => x.id);
}

/** Card `c` of boat `boat` as a map focus; null when it has no window. */
export function cardFocus(a: RaceAnalysis, boat: string, c: Pick<Card, 't0' | 't1' | 'spans' | 'refBoats'>): MapFocus | null {
  const spans = windowSpans(c);
  if (!spans.length) return null;
  return { boat, vs: comparisonBoats(a, boat, c.refBoats, spans[spans.length - 1][1]), spans };
}

/** A start card: D1, or a window from the gun (starting no later than START_NEAR_S after it, ending after it). */
export function isStartCard(c: Windowed, gunMs: number): boolean {
  if (c.kind === 'D1') return true;
  const sp = windowSpans(c);
  return sp.length > 0 && sp[0][0] <= gunMs + START_NEAR_S * 1000 && sp[sp.length - 1][1] >= gunMs;
}

/** Where card `c` (boat `boat`'s) shows on the map: Map C's replay (a start card of a boat with one), its focus, or nowhere. */
export type MapRoute = { kind: 'replay'; boat: string } | { kind: 'focus'; focus: MapFocus } | null;

export function cardRoute(a: RaceAnalysis, boat: string, c: Windowed & Pick<Card, 'refBoats'>, replays: readonly Pick<StartReplay, 'boat'>[]): MapRoute {
  if (!windowSpans(c).length) return null;
  if (replays.some((r) => r.boat === boat) && isStartCard(c, a.meta.gunMs)) return { kind: 'replay', boat };
  const focus = cardFocus(a, boat, c);
  return focus ? { kind: 'focus', focus } : null;
}

// ---- URL --------------------------------------------------------------------------

/** The URL parameters of a focus (besides `t=` / `trail=`): `boat=`, `vs=` (none: removed), `win=`. */
export function focusParams(a: Pick<RaceAnalysis, 'meta'>, f: MapFocus): Record<string, string | null> {
  const gun = a.meta.gunMs;
  const win = f.spans.flatMap(([p, q]) => [Math.floor((p - gun) / 1000), Math.ceil((q - gun) / 1000)]);
  return { [BOAT_PARAM]: f.boat, [VS_PARAM]: f.vs.length ? f.vs.join(',') : null, [WIN_PARAM]: win.join(',') };
}

/** The focus parameters cleared (leaving it). */
export const NO_FOCUS: Readonly<Record<string, null>> = { [VS_PARAM]: null, [WIN_PARAM]: null };

const withParams = (search: string, next: Record<string, string | null>): URLSearchParams => {
  const p = new URLSearchParams(search);
  for (const [k, v] of Object.entries(next)) {
    if (v == null) p.delete(k);
    else p.set(k, v);
  }
  return p;
};

/** `search` with the map on focus `f`: `t=` its start, `trail=` covering it, `boat=`, `vs=`, `win=` (any replay dropped). */
export function mapFocusLink(search: string, a: Pick<RaceAnalysis, 'meta'>, f: MapFocus): string {
  const base = mapTimeSearch(search, paramOfTime(focusTime(f), a.meta.gunMs), focusTrail(f));
  return `?${withParams(base, { ...focusParams(a, f), [REPLAY_PARAM]: null }).toString()}`;
}

/** The focus in `search` (`boat=` and a well-formed `win=`; `vs=` optional, capped), its spans in race time; null without one. */
export function parseMapFocus(search: string, gunMs: number): MapFocus | null {
  const p = new URLSearchParams(search);
  const boat = p.get(BOAT_PARAM)?.trim();
  const raw = p.get(WIN_PARAM);
  if (!boat || !raw) return null;
  const s = raw.split(',').map((x) => parseTParam(x));
  if (s.length < 2 || s.length % 2 || s.some((x) => x == null)) return null;
  const spans: [number, number][] = [];
  for (let i = 0; i < s.length; i += 2) {
    const [p0, p1] = [s[i]!, s[i + 1]!];
    if (!(p1 > p0)) return null;
    spans.push([gunMs + p0 * 1000, gunMs + p1 * 1000]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const vs = [
    ...new Set(
      (p.get(VS_PARAM) ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x && x !== boat),
    ),
  ].slice(0, MAP_VS_MAX);
  return { boat, vs, spans };
}

/**
 * The page's focus as a pending entry (keyed on the race its `event=` / `div=` / `race=` name, else the first race
 * shown), for replay.ts's `replayPending` reducer, as `replay=` is: it survives every load of that race and is
 * dropped by another race or by leaving the focus. Null without a focus (`boat=` and a well-formed `win=`).
 */
export function focusPendFromUrl(search: string): ReplayPend | null {
  const f = parseMapFocus(search, 0);
  return f ? replayPendFromUrl(withParams(search, { [REPLAY_PARAM]: f.boat }).toString()) : null;
}

/**
 * Race `race` drawn (boats `drawn`): the focus to reopen (the pending one's, read from `search` with its gun, if its
 * boat is drawn) and the state after (dropped if it can't open).
 */
export function focusArrive(
  state: ReplayPend | null,
  race: string,
  search: string,
  gunMs: number,
  drawn: readonly string[],
): { open: MapFocus | null; state: ReplayPend | null } {
  if (!state || state.race !== race) return { open: null, state };
  const f = parseMapFocus(search, gunMs);
  return f && f.boat === state.boat && drawn.includes(f.boat) ? { open: f, state } : { open: null, state: null };
}

/** Card `c`'s map link (with `#race`): the replay's for a start card of a boat with one, else its focus; null with no window. */
export function cardMapHref(search: string, a: RaceAnalysis, boat: string, c: Windowed & Pick<Card, 'refBoats'>, replays: readonly Pick<StartReplay, 'boat'>[]): string | null {
  const route = cardRoute(a, boat, c, replays);
  return route ? routeHref(search, a, route) : null;
}

/** A route's link, with `#race`; the replay's drops any focus and names its boat. */
function routeHref(search: string, a: RaceAnalysis, route: NonNullable<MapRoute>): string {
  if (route.kind === 'focus') return `${mapFocusLink(search, a, route.focus)}#race`;
  return `${replayLink(withParams(search, { ...NO_FOCUS, [BOAT_PARAM]: route.boat }).toString(), route.boat)}#race`;
}

// ---- the cards' action ---------------------------------------------------------------

const sailOf = (a: Pick<RaceAnalysis, 'boats'>, id: string): string => a.boats.find((b) => b.id === id)?.sail ?? id;

/** One card's "Show on map" link (a real link: it opens in a new tab as a deep link); '' with no window. */
export function cardMapAction(i: number, a: RaceAnalysis, boat: string, c: Windowed & Pick<Card, 'refBoats'>, replays: readonly Pick<StartReplay, 'boat'>[], search: string): string {
  const route = cardRoute(a, boat, c, replays);
  if (!route) return '';
  const href = routeHref(search, a, route);
  const title =
    route.kind === 'replay' ? 'Replay the start on the track map' : `On the track map${route.focus.vs.length ? `, vs ${route.focus.vs.map((id) => sailOf(a, id)).join(' · ')}` : ''}`;
  return `<p class="opp-map"><a class="opp-map-link" href="${esc(href)}" data-map-opp="${i}" title="${esc(title)}">Show on map <span aria-hidden="true">→</span></a></p>`;
}

/** The actions for `cards` (boat `boat`'s), by card index. */
export const cardMapActions = (a: RaceAnalysis, boat: string, cards: readonly Card[], replays: readonly Pick<StartReplay, 'boat'>[], search: string): string[] =>
  cards.map((c, i) => cardMapAction(i, a, boat, c, replays, search));

/** The cards' HTML (coachCardsHtml) with action `actions[i]` appended at the end of card `i` (data-opp="i"); the rest unchanged. */
export function withMapActions(html: string, actions: readonly string[]): string {
  return html.replace(/(<article\b[^>]*\bclass="card coach-opp[^"]*"[^>]*\bdata-opp="(\d+)"[\s\S]*?)(\s*<\/article>)/g, (_m, body: string, i: string, end: string) => {
    const act = actions[Number(i)];
    return act ? `${body}\n    ${act}${end}` : `${body}${end}`;
  });
}

// ---- the map ------------------------------------------------------------------------

/** The legend line under a focus: "vs USA 11 · GBR 015 · USA 12" (with the comparison ring's swatch); '' with none. */
export function mapFocusLegend(a: Pick<RaceAnalysis, 'boats'>, f: Pick<MapFocus, 'vs'> | null): string {
  if (!f?.vs.length) return '';
  return `<span class="vs-sw" aria-hidden="true"></span>vs ${f.vs.map((id) => esc(sailOf(a, id))).join('<span class="sep" aria-hidden="true"> · </span>')}`;
}

/** The focus frame grows by this share of its size each way (and at least FOCUS_PAD_M), as a replay's. */
const FOCUS_PAD = 0.15;
const FOCUS_PAD_M = 25;

/** What a focus frames, in map coordinates: the boat's and the comparison boats' drawn tracks over the spans, and the start line when they include the gun. */
export function focusExtent(a: RaceAnalysis, f: MapFocus): Box {
  const rot = rotator(a.wind.twdAtGunDeg);
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = ([x, y]: [number, number]): void => {
    box.x0 = Math.min(box.x0, x);
    box.x1 = Math.max(box.x1, x);
    box.y0 = Math.min(box.y0, y);
    box.y1 = Math.max(box.y1, y);
  };
  const gun = a.meta.gunMs;
  if (f.spans.some(([p, q]) => p <= gun && gun <= q)) {
    grow(rot(a.line.left));
    grow(rot(a.line.right));
  }
  for (const id of [f.boat, ...f.vs]) {
    const d = a.drawings.find((x) => x.id === id);
    if (!d) continue;
    for (const g of legRanges(d, true)) {
      for (const [t0, t1] of f.spans) {
        const [i0, i1] = timeRange(g.src.t, t0, t1, g.lo, g.hi);
        for (let i = i0; i < i1; i++) grow(rot([g.src.x[i], g.src.y[i]]));
      }
    }
  }
  return box;
}

/** The view (on the whole race's fit box `fit`) that frames focus `f`: its extent, padded, zoomed in as far as that allows; Fit with nothing to frame. */
export function focusView(a: RaceAnalysis, f: MapFocus, fit: Box): View {
  const e = focusExtent(a, f);
  if (!Number.isFinite(e.x0)) return clampView(fit, { cx: (fit.x0 + fit.x1) / 2, cy: (fit.y0 + fit.y1) / 2, k: 1 });
  const pad = Math.max(FOCUS_PAD_M, FOCUS_PAD * Math.max(e.x1 - e.x0, e.y1 - e.y0));
  const w = e.x1 - e.x0 + 2 * pad;
  const h = e.y1 - e.y0 + 2 * pad;
  const k = Math.min((fit.x1 - fit.x0) / w, (fit.y1 - fit.y0) / h);
  return clampView(fit, { cx: (e.x0 + e.x1) / 2, cy: (e.y0 + e.y1) / 2, k });
}
