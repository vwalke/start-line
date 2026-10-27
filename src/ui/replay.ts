/**
 * The track map's "Replay start" for a boat over early (Map C), as pure pieces: the `replay=` URL
 * parameter and its deep link (on top of the scrubber's `t=` / `trail=`), the replay's time window,
 * its one-line label, the stretches it highlights, and the view that frames it.
 *
 * The facts come from analysis/startReplay.ts (the worker, from the raw fixes, as the Coach's start
 * crossings): never from a Coach card, so the replay works whatever card the start gets.
 */
import type { Vec } from '../analysis/geo';
import { OVER_HORIZON_MS, type StartReplay } from '../analysis/startReplay';
import type { RaceAnalysis } from '../analysis/types';
import { ACT, ACT_CHIP } from './act';
import { esc, f1 } from './format';
import { legRanges, rotator, timeRange } from './mapPieces';
import { mapTimeSearch, type Trail } from './scrub';
import { clampView, type Box, type View } from './view';

export const REPLAY_PARAM = 'replay';
/** The replay opens this long before the gun, s… */
export const REPLAY_PRE_S = 30;
/** …and frames the start until this long after the boat cleared, s. */
export const REPLAY_POST_S = 15;
/** The trail a replay draws: the whole window, so the dip back stays in sight. */
export const REPLAY_TRAIL: Trail = 'all';

/** `replay=` → a boat id; null when missing or blank. */
export const parseReplayParam = (raw: string | null | undefined): string | null => (raw?.trim() ? raw.trim() : null);

/** `search` with the map replaying boat `boatId`'s start: `replay=`, `t=` REPLAY_PRE_S before the gun, `trail=all` (for deep links, e.g. Coach). */
export function replayLink(search: string, boatId: string): string {
  const p = new URLSearchParams(mapTimeSearch(search, -REPLAY_PRE_S, REPLAY_TRAIL));
  p.set(REPLAY_PARAM, boatId);
  return `?${p.toString()}`;
}

/**
 * The race time the replay frames: REPLAY_PRE_S before the gun to REPLAY_POST_S after it cleared (else went back,
 * else the end of its over stretch, else the gun), ms.
 */
export function replayWindow(r: StartReplay): [number, number] {
  const end = r.clearedMs ?? r.wentBackMs ?? r.over?.[1] ?? r.gunMs;
  return [r.gunMs - REPLAY_PRE_S * 1000, end + REPLAY_POST_S * 1000];
}

/** "+13 s" from the gun (whole seconds, as the Coach card rounds). */
const plusS = (ms: number, gun: number): string => {
  const s = Math.round((ms - gun) / 1000);
  return `${s < 0 ? '−' : '+'}${Math.abs(s)} s`;
};

/**
 * "over 12.1 m · back +13 s · recrossed +35 s · ≈ 35 s lost vs front row"; never back: "over 4.2 m at the gun ·
 * never back"; flagged with its track on the pre-start side at the gun: "flagged over · track not over at the
 * gun" (or the bow's "bow over 0.8 m at the gun"), then its crossing. What isn't known is left out, or said.
 */
export function replayLabel(r: StartReplay): string {
  const parts: string[] = [];
  const m = r.maxOverM != null ? f1(Math.max(0, r.maxOverM)) : null;
  if (!r.over) parts.push(m != null ? `bow over ${m} m at the gun` : 'flagged over · track not over at the gun');
  else if (r.wentBackMs == null) parts.push(m != null ? `over ${m} m at the gun` : 'over at the gun');
  else parts.push(m != null ? `over ${m} m` : 'over at the gun');
  if (r.wentBackMs != null) {
    parts.push(`back ${plusS(r.wentBackMs, r.gunMs)}`);
    parts.push(r.clearedMs != null ? `recrossed ${plusS(r.clearedMs, r.gunMs)}` : 'not recrossed');
  } else if (r.over) parts.push('never back');
  else if (r.clearedMs != null) parts.push(`crossed ${plusS(r.clearedMs, r.gunMs)}`);
  if (r.lostS != null) parts.push(`≈ ${Math.round(r.lostS)} s lost vs front row`);
  return parts.join(' · ');
}

/** The button's title: what the replay shows, as the facts have it. */
export function replayTitle(r: StartReplay, sail: string): string {
  const what = !r.over
    ? 'flagged over, its track not over at the gun'
    : r.wentBackMs == null
      ? 'over early, never went back'
      : r.clearedMs == null
        ? 'over early, went back, not recrossed'
        : 'over early, went back and recrossed';
  return `Replay ${sail}'s start: ${what}`;
}

/**
 * The stretches the replay highlights: over the line (the facts' `over`: to going back, else bounded at
 * OVER_HORIZON_MS after the gun) and the dip back (back → recrossed, else at most OVER_HORIZON_MS on); ms,
 * never open-ended, so a boat that never went back or recrossed doesn't paint the rest of its race.
 */
export function replaySpans(r: StartReplay): { over: [number, number] | null; dip: [number, number] | null } {
  const over: [number, number] | null = r.over ? [r.over[0], r.over[1]] : null;
  const dip: [number, number] | null = r.wentBackMs != null ? [r.wentBackMs, r.clearedMs ?? Math.max(r.wentBackMs, r.gunMs) + OVER_HORIZON_MS] : null;
  return { over, dip };
}

/**
 * The race a `replay=` deep link or an open replay belongs to: event, division and race number (the
 * URL's `event=` / `div=` / `race=`, the analysis's meta).
 */
export const replayRaceKey = (event: string | null | undefined, division: string, race: number | string): string => `${event ?? ''}|${division}|${race}`;

/** A replay wanted (from `replay=`, or one opened) for race `race` (replayRaceKey); null `race`: the first race shown. */
export interface ReplayPend {
  race: string | null;
  boat: string;
}

/** The page's `replay=` (with the race its `event=` / `div=` / `race=` name, when they do); null without one. */
export function replayPendFromUrl(search: string): ReplayPend | null {
  const p = new URLSearchParams(search);
  const boat = parseReplayParam(p.get(REPLAY_PARAM));
  if (boat == null) return null;
  const event = p.get('event');
  const div = p.get('div');
  const race = p.get('race');
  return { race: event && div && race ? replayRaceKey(event, div, race) : null, boat };
}

export type ReplayEvent =
  /** A race shown (each load, including a reload of the same race, e.g. when official results arrive). */
  | { type: 'shown'; race: string }
  /** A replay opened (by hand, or the pending one). */
  | { type: 'opened'; race: string; boat: string }
  /** The replay left (✕ Full race, Fit, another boat, a leg, the pressed button). */
  | { type: 'left' }
  /** The race's replays arrived from the worker: these boats have one. */
  | { type: 'arrived'; race: string; boats: readonly string[] };

/**
 * The `replay=` waiting to open (or open), keyed on the race: it survives every load of that race (a reload
 * re-opens it once the replays come in again), and is dropped by another race, by leaving the replay, or when
 * its boat turns out to have none. URL `replay=` follows: present iff this is non-null.
 */
export function replayPending(state: ReplayPend | null, ev: ReplayEvent): ReplayPend | null {
  switch (ev.type) {
    case 'shown':
      if (!state) return null;
      if (state.race == null) return { race: ev.race, boat: state.boat };
      return state.race === ev.race ? state : null;
    case 'opened':
      return { race: ev.race, boat: ev.boat };
    case 'left':
      return null;
    case 'arrived':
      if (!state || state.race !== ev.race) return state;
      return ev.boats.includes(state.boat) ? state : null;
  }
}

/**
 * Race `race`'s replays arrived (for the analysis on screen): the replay to open (the pending one's, if its boat
 * has one) and the state after (dropped if it hasn't).
 */
export function replayArrive(state: ReplayPend | null, race: string, replays: readonly StartReplay[]): { open: StartReplay | null; state: ReplayPend | null } {
  const open = state && state.race === race ? (replays.find((r) => r.boat === state.boat) ?? null) : null;
  return { open, state: replayPending(state, { type: 'arrived', race, boats: replays.map((r) => r.boat) }) };
}

/** The boats a replay is offered for: the selected one if it qualifies (none if it doesn't), else every one that does. */
export function replayOffer(replays: readonly StartReplay[], highlight: string | null): StartReplay[] {
  if (highlight == null) return [...replays];
  return replays.filter((r) => r.boat === highlight);
}

const sailOf = (a: Pick<RaceAnalysis, 'boats'>, id: string): string => a.boats.find((b) => b.id === id)?.sail ?? id;

/**
 * The map's "Replay start" control: one button for the selected boat ("Replay start", pressed while it
 * plays), or with none selected one per boat ("Replay start: USA 017 · USA 019"); '' when none qualifies.
 */
export function replayControls(a: Pick<RaceAnalysis, 'boats'>, replays: readonly StartReplay[], highlight: string | null, active: string | null): string {
  const offer = replayOffer(replays, highlight);
  if (!offer.length) return '';
  const btn = (r: StartReplay, text: string): string =>
    `<button type="button" class="replay-btn ${ACT_CHIP}" data-replay="${esc(r.boat)}" aria-pressed="${active === r.boat}" title="${esc(replayTitle(r, sailOf(a, r.boat)))}${active === r.boat ? ' (click again to leave it)' : ''}">${esc(text)}</button>`;
  if (highlight != null) return btn(offer[0], 'Replay start');
  return `<span class="replay-lbl">Replay start:</span> ${offer.map((r) => btn(r, sailOf(a, r.boat))).join('<span class="sep" aria-hidden="true"> · </span>')}`;
}

/**
 * The Start tab's "Replay start → USA 017" buttons for the boats offered ('' with none): each plays that boat's start
 * in the "Start Playback" view just below (ui/laneSnapshotsView.ts), the boat selected; the track map's own replay
 * stays on the Race tab ("Replay start" there, and `replay=` deep links).
 */
export function startReplayLinks(a: Pick<RaceAnalysis, 'boats'>, replays: readonly StartReplay[], highlight: string | null): string {
  const offer = replayOffer(replays, highlight);
  if (!offer.length) return '';
  const links = offer.map(
    (r) =>
      `<button type="button" class="replay-link ${ACT}" data-replay="${esc(r.boat)}" aria-controls="lane-snapshots" title="${esc(`${replayTitle(r, sailOf(a, r.boat))}, in Start Playback below`)}">Replay start → ${esc(sailOf(a, r.boat))}</button>`,
  );
  return `<span class="replay-lbl">Over early:</span> ${links.join('<span class="sep" aria-hidden="true"> · </span>')}`;
}

/** The map's frame for a replay grows by this share of its size each way (and at least REPLAY_PAD_M). */
const REPLAY_PAD = 0.15;
const REPLAY_PAD_M = 25;

/** What the replay frames, in map coordinates: the start line's ends and the boat's drawn track over the replay window. */
export function replayExtent(a: RaceAnalysis, r: StartReplay): Box {
  const rot = rotator(a.wind.twdAtGunDeg);
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = ([x, y]: Vec): void => {
    box.x0 = Math.min(box.x0, x);
    box.x1 = Math.max(box.x1, x);
    box.y0 = Math.min(box.y0, y);
    box.y1 = Math.max(box.y1, y);
  };
  grow(rot(a.line.left));
  grow(rot(a.line.right));
  const d = a.drawings.find((x) => x.id === r.boat);
  const [t0, t1] = replayWindow(r);
  if (d) {
    for (const g of legRanges(d, true)) {
      const [i0, i1] = timeRange(g.src.t, t0, t1, g.lo, g.hi);
      for (let i = i0; i < i1; i++) grow(rot([g.src.x[i], g.src.y[i]]));
    }
  }
  return box;
}

/** The view (on the whole race's fit box `fit`, Map A's View) that frames the replay: its extent, padded, zoomed in as far as that allows. */
export function replayView(a: RaceAnalysis, r: StartReplay, fit: Box): View {
  const e = replayExtent(a, r);
  const pad = Math.max(REPLAY_PAD_M, REPLAY_PAD * Math.max(e.x1 - e.x0, e.y1 - e.y0));
  const w = e.x1 - e.x0 + 2 * pad;
  const h = e.y1 - e.y0 + 2 * pad;
  const k = Math.min((fit.x1 - fit.x0) / w, (fit.y1 - fit.y0) / h);
  return clampView(fit, { cx: (e.x0 + e.x1) / 2, cy: (e.y0 + e.y1) / 2, k });
}
