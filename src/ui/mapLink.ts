/**
 * Coach → track map (Map D): a card's "Show on map", as pure pieces. A card with a window opens the Race
 * tab's map on it: the whole race, the card's boat selected, the scrubber paused at the window's end
 * with the window's own trail (from its start: the whole window drawn, nothing before it), the view framing the boat's drawn track over the window (the union of its
 * spans) with the comparison boats' (the card's `refBoats`, at most MAP_VS_MAX), and those boats ringed
 * and listed ("vs USA 11 · GBR 015 · USA 12").
 *
 * A start card for a boat over early goes to Map C's replay instead (replay.ts): keyed on the boat having
 * a replay (the worker's start facts) and the card being a start card (D1, or a window from the gun),
 * never on the card's variant, so a renamed over-early or penalty card still goes there.
 *
 * The URL: `boat=` (Coach's), `vs=<id>,<id>`, `win=<s0>,<s1>[,<s2>,<s3>…]` (gun-relative seconds, each
 * pair a span, rounded outward) with the scrubber's `t=` (the window's end, as `win=` rounds it) / `trail=win`, and
 * `#race`. An older link (`t=` the window's start, a 30 s / 2 min / All trail) opens the same way (`focusResume`).
 *
 * The cards themselves are not touched (coachCards.ts): `withMapActions` appends one link to each.
 */
import type { Card } from '../analysis/coach/rank';
import type { StartReplay } from '../analysis/startReplay';
import type { RaceAnalysis } from '../analysis/types';
import { ACT } from './act';
import { BOAT_PARAM } from './coach';
import { esc } from './format';
import { boatAt, filledRanges, rotTrack, rotator, timeRange } from './mapPieces';
import { REPLAY_PARAM, replayLink, replayPendFromUrl, type ReplayPend } from './replay';
import { DEFAULT_TRAIL, T_PARAM, TRAIL_PARAM, WINDOW_TRAIL, mapTimeSearch, parseTParam, parseTrail, playFrom, type ScrubWindow, type Trail } from './scrub';
import type { RankBy, SpeedTop, TrackColour } from './speed';
import { clampView, type Box, type View } from './view';

export const VS_PARAM = 'vs';
export const WIN_PARAM = 'win';
/** A leg's view (`leg=<n>`, 1-based): the view frames the whole fleet's leg, the trail is All. */
export const LEG_PARAM = 'leg';
/** `fast=<n>`: the tracks colored by speed rank on each leg with the top N picked out (Colour: Rank, Top N). */
export const FAST_PARAM = 'fast';
/** A leg's view picks out this many of the fastest boats on it. */
export const LEG_FAST_TOP = 10;
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
  /** A leg's view (legFocus): the leg (0-based), framed whole, with the trail All. */
  leg?: number;
  /** The tracks by speed rank on each leg, the top `fast` picked out (Colour: Rank, Top N). */
  fast?: 10 | 3;
}

type Windowed = Pick<Card, 'kind' | 't0' | 't1' | 'spans'>;

/** A card's spans (its `spans`, else [t0, t1]), the empty and malformed ones left out, in time order. */
export function windowSpans(c: Pick<Card, 't0' | 't1' | 'spans'>): [number, number][] {
  return (c.spans ?? [[c.t0, c.t1]])
    .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && q > p)
    .map(([p, q]): [number, number] => [p, q])
    .sort((x, y) => x[0] - y[0]);
}

/**
 * Where the focus parks the scrubber: the window's end (its last span's), so that, paused, the trail shows the whole
 * finding (the cards carry no key moment of their own; the end is where the window's outcome is).
 */
export const focusTime = (f: Pick<MapFocus, 'spans'>): number => f.spans[f.spans.length - 1][1];

/** Where the focus's trail starts ('win': `trailWindow`'s `from`): the window's start (its first span's). */
export const focusFrom = (f: Pick<MapFocus, 'spans'>): number => f.spans[0][0];

/** The focus's trail: the window's own, from its start (focusFrom) to the time shown; a leg's view, the whole trail. */
export const focusTrail = (f: Pick<MapFocus, 'spans' | 'leg'>): Trail => (f.leg != null ? 'all' : WINDOW_TRAIL);

/** The shortest of the trails always offered that covers the window from its start to its end (spans and all): the trail once the focus is left. */
export function coverTrail(f: Pick<MapFocus, 'spans'>): Trail {
  const s = (focusTime(f) - focusFrom(f)) / 1000;
  return s <= TRAIL_30_MAX_S ? '30' : s <= TRAIL_120_MAX_S ? '120' : 'all';
}

/** The trail once focus `f` (null: none open) is left: the window's own becomes coverTrail (All with no window); the rest stay. */
export const trailAfterFocus = (trail: Trail, f: Pick<MapFocus, 'spans'> | null): Trail => (trail !== WINDOW_TRAIL ? trail : f ? coverTrail(f) : 'all');

/** Within this of a window's end (or, for an older link, its start) the scrubber is on it: `t=` and `win=` are whole seconds, ms. */
const PARKED_MS = 1000;

/**
 * Where Play starts with focus `f` open: parked at the window's end, from the window's start (it plays the window
 * through, and on); anywhere else, or with no focus, as the scrubber does (playFrom).
 */
export function focusPlayFrom(f: Pick<MapFocus, 'spans'> | null, t: number | null, w: ScrubWindow): number {
  return f && t != null && Math.abs(t - focusTime(f)) <= PARKED_MS ? Math.min(w.t1, Math.max(w.t0, focusFrom(f))) : playFrom(t, w);
}

/** Boat `id`'s drawn position at `t` (map coordinates), null where it has none. */
function posAt(a: RaceAnalysis, id: string, t: number): [number, number] | null {
  const d = a.drawings.find((x) => x.id === id);
  const b = d ? boatAt(id, filledRanges(d, true), t, a.wind.twdAtGunDeg) : null;
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

/**
 * Leg `leg` (0-based) as boat `boat`'s map focus, a leg's view: the scrubber at the boat's rounding at the leg's end
 * (its time on the leg is the window), the whole trail, the view framing the fleet's leg, the tracks by speed rank on
 * each leg with the LEG_FAST_TOP fastest picked out. The boat's own leg times, else the fleet's first start and last
 * end of the leg; null when neither is known.
 */
export function legFocus(a: Pick<RaceAnalysis, 'boats' | 'legs'>, boat: string, leg: number): MapFocus | null {
  if (!(leg >= 0 && leg < a.legs.length)) return null;
  const mine = a.boats.find((b) => b.id === boat)?.legs[leg];
  let span: [number, number] | null = mine && mine.endMs > mine.startMs ? [mine.startMs, mine.endMs] : null;
  if (!span) {
    const all = a.boats.map((b) => b.legs[leg]).filter((l): l is NonNullable<typeof l> => !!l && l.endMs > l.startMs);
    if (all.length) span = [Math.min(...all.map((l) => l.startMs)), Math.max(...all.map((l) => l.endMs))];
  }
  return span ? { boat, vs: [], spans: [span], leg, fast: LEG_FAST_TOP } : null;
}

/** The link (with `#race`) to leg `leg`'s view for boat `boat` (legFocus); null when the leg has no times. */
export function legMapHref(search: string, a: Pick<RaceAnalysis, 'boats' | 'legs' | 'meta'>, boat: string, leg: number): string | null {
  const f = legFocus(a, boat, leg);
  return f ? `${mapFocusLink(search, a, f)}#race` : null;
}

/** The leg a side-of-the-course card (D14) is about, by its name; null for any other card. */
export function cardLeg(a: Pick<RaceAnalysis, 'legs'>, c: Pick<Card, 'kind' | 'facts'>): number | null {
  if (c.kind !== 'D14') return null;
  const k = a.legs.findIndex((l) => l.name === c.facts.leg);
  return k >= 0 ? k : null;
}

/** A start card: D1, or a window from the gun (starting no later than START_NEAR_S after it, ending after it). */
export function isStartCard(c: Windowed, gunMs: number): boolean {
  if (c.kind === 'D1') return true;
  const sp = windowSpans(c);
  return sp.length > 0 && sp[0][0] <= gunMs + START_NEAR_S * 1000 && sp[sp.length - 1][1] >= gunMs;
}

/** Where card `c` (boat `boat`'s) shows on the map: Map C's replay (a start card of a boat with one), its focus, or nowhere. */
export type MapRoute = { kind: 'replay'; boat: string } | { kind: 'focus'; focus: MapFocus } | null;

export function cardRoute(a: RaceAnalysis, boat: string, c: Windowed & Pick<Card, 'refBoats'> & Partial<Pick<Card, 'facts'>>, replays: readonly Pick<StartReplay, 'boat'>[]): MapRoute {
  if (!windowSpans(c).length) return null;
  // The side of the course: that leg's view (framed whole, the fastest picked out, as the positions chart opens it),
  // over the card's own window and comparison boats.
  const leg = c.facts ? cardLeg(a, { kind: c.kind, facts: c.facts }) : null;
  if (leg != null) {
    const own = cardFocus(a, boat, c);
    if (own) return { kind: 'focus', focus: { ...own, leg, fast: LEG_FAST_TOP } };
  }
  if (replays.some((r) => r.boat === boat) && isStartCard(c, a.meta.gunMs)) return { kind: 'replay', boat };
  const focus = cardFocus(a, boat, c);
  return focus ? { kind: 'focus', focus } : null;
}

/** The map's track coloring (the Colour controls): what a leg's view sets for as long as it's open. */
export interface Colouring {
  colour: TrackColour;
  rankBy: RankBy;
  top: SpeedTop;
}

/**
 * The coloring once focus `f` is shown (null: none, the focus left): a leg's view (`fast=`) colors by speed rank on
 * each leg with its fastest picked out and keeps the coloring it replaced (`before`, kept across a second leg's view);
 * any other focus, or none, puts that one back. Nothing here is saved: the saved preference stays the user's.
 */
export function focusColouring(now: Colouring, before: Colouring | null, f: Pick<MapFocus, 'fast'> | null): { now: Colouring; before: Colouring | null } {
  if (f?.fast != null) return { now: { colour: 'rank', rankBy: 'leg', top: f.fast }, before: before ?? now };
  return { now: before ?? now, before: null };
}

/** The map's leg selection (the leg buttons; null: All) a leg's view replaced, put back when it's left. */
export interface LegBefore {
  leg: number | null;
}

/**
 * The leg selection once focus `f` is shown (null: none, the focus left), as focusColouring: a leg's view draws the
 * whole race (its scrubber's) and keeps the selection it replaced (`before`, kept across a second leg's view); any
 * other focus, or none, puts that one back. The selection the user made is `before`'s while one is kept (what is saved).
 */
export function focusLeg(now: number | null, before: LegBefore | null, f: Pick<MapFocus, 'leg'> | null): { now: number | null; before: LegBefore | null } {
  if (f?.leg != null) return { now: null, before: before ?? { leg: now } };
  return { now: before ? before.leg : now, before: null };
}

/** The leg the leg buttons show pressed (null: All): a leg's view's own leg, else the selection the map draws. */
export const shownLeg = (sel: number | null, f: Pick<MapFocus, 'leg'> | null): number | null => f?.leg ?? sel;

/** The selection after leg button `pressed` (null: All) with `shown` pressed (shownLeg): the one pressed, or All for the one already shown. */
export const legAfterPress = (shown: number | null, pressed: number | null): number | null => (pressed == null || pressed === shown ? null : pressed);

// ---- URL --------------------------------------------------------------------------

/** The URL parameters of a focus (besides `t=` / `trail=`): `boat=`, `vs=` (none: removed), `win=`. */
export function focusParams(a: Pick<RaceAnalysis, 'meta'>, f: MapFocus): Record<string, string | null> {
  const gun = a.meta.gunMs;
  const win = f.spans.flatMap(([p, q]) => [Math.floor((p - gun) / 1000), Math.ceil((q - gun) / 1000)]);
  return {
    [BOAT_PARAM]: f.boat,
    [VS_PARAM]: f.vs.length ? f.vs.join(',') : null,
    [WIN_PARAM]: win.join(','),
    [LEG_PARAM]: f.leg != null ? String(f.leg + 1) : null,
    [FAST_PARAM]: f.fast != null ? String(f.fast) : null,
  };
}

/** The focus parameters cleared (leaving it). */
export const NO_FOCUS: Readonly<Record<string, null>> = { [VS_PARAM]: null, [WIN_PARAM]: null, [LEG_PARAM]: null, [FAST_PARAM]: null };

const withParams = (search: string, next: Record<string, string | null>): URLSearchParams => {
  const p = new URLSearchParams(search);
  for (const [k, v] of Object.entries(next)) {
    if (v == null) p.delete(k);
    else p.set(k, v);
  }
  return p;
};

/** `search` with the map on focus `f`: `t=` its end (rounded up, as `win=`), `trail=win`, `boat=`, `vs=`, `win=` (any replay dropped). */
export function mapFocusLink(search: string, a: Pick<RaceAnalysis, 'meta'>, f: MapFocus): string {
  const base = mapTimeSearch(search, Math.ceil((focusTime(f) - a.meta.gunMs) / 1000), focusTrail(f));
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
  const legRaw = p.get(LEG_PARAM);
  const leg = legRaw && /^\d{1,2}$/.test(legRaw) && Number(legRaw) >= 1 ? Number(legRaw) - 1 : null;
  const fastRaw = p.get(FAST_PARAM);
  const fast = fastRaw === '10' ? 10 : fastRaw === '3' ? 3 : null;
  return { boat, vs, spans, ...(leg != null ? { leg } : {}), ...(fast != null ? { fast } : {}) };
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

/** Where focus `f` opens the scrubber: its time (race ms, unclamped) and trail. */
export interface FocusAt {
  t: number;
  trail: Trail;
}

/**
 * Where focus `f` (read from `search`, gun `gunMs`) reopens: at the URL's own `t=` / `trail=` (the focus left where
 * it was: scrubbed, another trail), else parked (focusTime, focusTrail). Parked too: no `t=`, and an older link's
 * `t=` at the window's start with a 30 s / 2 min / All trail (which drew nothing of the window).
 */
export function focusResume(f: Pick<MapFocus, 'spans'>, search: string, gunMs: number): FocusAt {
  const p = new URLSearchParams(search);
  const s = parseTParam(p.get(T_PARAM));
  const trail = p.has(TRAIL_PARAM) ? parseTrail(p.get(TRAIL_PARAM)) : DEFAULT_TRAIL;
  const parked = { t: focusTime(f), trail: focusTrail(f) };
  if (s == null) return parked;
  const t = gunMs + s * 1000;
  return trail !== WINDOW_TRAIL && Math.abs(t - focusFrom(f)) <= PARKED_MS ? parked : { t, trail };
}

/**
 * Race `race` drawn (boats `drawn`): the focus to reopen (the pending one's, read from `search` with its gun, if its
 * boat is drawn) with where its scrubber opens (`at`, focusResume), and the state after (dropped if it can't open).
 */
export function focusArrive(
  state: ReplayPend | null,
  race: string,
  search: string,
  gunMs: number,
  drawn: readonly string[],
): { open: MapFocus | null; at?: FocusAt; state: ReplayPend | null } {
  if (!state || state.race !== race) return { open: null, state };
  const f = parseMapFocus(search, gunMs);
  return f && f.boat === state.boat && drawn.includes(f.boat) ? { open: f, at: focusResume(f, search, gunMs), state } : { open: null, state: null };
}

/** Card `c`'s map link (with `#race`): the replay's for a start card of a boat with one, else its focus; null with no window. */
export function cardMapHref(search: string, a: RaceAnalysis, boat: string, c: Windowed & Pick<Card, 'refBoats'> & Partial<Pick<Card, 'facts'>>, replays: readonly Pick<StartReplay, 'boat'>[]): string | null {
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
export function cardMapAction(i: number, a: RaceAnalysis, boat: string, c: Windowed & Pick<Card, 'refBoats'> & Partial<Pick<Card, 'facts'>>, replays: readonly Pick<StartReplay, 'boat'>[], search: string): string {
  const route = cardRoute(a, boat, c, replays);
  if (!route) return '';
  const href = routeHref(search, a, route);
  const title =
    route.kind === 'replay'
      ? 'Replay the start on the track map'
      : route.focus.leg != null
        ? `${a.legs[route.focus.leg]?.name ?? 'The leg'} on the track map, the ${route.focus.fast ?? LEG_FAST_TOP} fastest on it picked out`
        : `On the track map${route.focus.vs.length ? `, vs ${route.focus.vs.map((id) => sailOf(a, id)).join(' · ')}` : ''}`;
  return `<p class="opp-map"><a class="opp-map-link ${ACT}" href="${esc(href)}" data-map-opp="${i}" title="${esc(title)}">Show on map <span aria-hidden="true">→</span></a></p>`;
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
  // A leg's view: the whole fleet's leg (its drawn segments), the boat's own span below adding nothing new.
  if (f.leg != null) {
    for (const d of a.drawings) {
      for (const seg of d.segments) {
        if (seg.leg !== f.leg) continue;
        const { x, y } = rotTrack(a.wind.twdAtGunDeg, seg);
        for (let i = 0; i < x.length; i++) grow([x[i], y[i]]);
      }
    }
  }
  for (const id of [f.boat, ...f.vs]) {
    const d = a.drawings.find((x) => x.id === id);
    if (!d) continue;
    for (const g of filledRanges(d, true)) {
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
