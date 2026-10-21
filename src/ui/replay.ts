/**
 * The track map's "Replay start" for a boat over early (Map C), as pure pieces: the `replay=` URL
 * parameter and its deep link (on top of the scrubber's `t=` / `trail=`), the replay's time window,
 * its one-line label, the stretches it highlights, and the view that frames it.
 *
 * The facts come from analysis/startReplay.ts (the worker, from the raw fixes, as the Coach's start
 * crossings): never from a Coach card, so the replay works whatever card the start gets.
 */
import type { Vec } from '../analysis/geo';
import type { StartReplay } from '../analysis/startReplay';
import type { RaceAnalysis } from '../analysis/types';
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

/** The race time the replay frames: REPLAY_PRE_S before the gun to REPLAY_POST_S after it cleared (else went back, else crossed), ms. */
export function replayWindow(r: StartReplay): [number, number] {
  const end = r.clearedMs ?? r.wentBackMs ?? Math.max(r.firstCrossMs, r.gunMs);
  return [r.gunMs - REPLAY_PRE_S * 1000, end + REPLAY_POST_S * 1000];
}

/** "+13 s" from the gun (whole seconds, as the Coach card rounds). */
const plusS = (ms: number, gun: number): string => {
  const s = Math.round((ms - gun) / 1000);
  return `${s < 0 ? '−' : '+'}${Math.abs(s)} s`;
};

/** "over 12.1 m · back +13 s · recrossed +35 s · ≈ 35 s lost vs front row" (what isn't known is left out, or said). */
export function replayLabel(r: StartReplay): string {
  const parts: string[] = [];
  if (r.maxOverM != null) parts.push(`over ${f1(Math.max(0, r.maxOverM))} m`);
  else parts.push('over at the gun');
  parts.push(r.wentBackMs != null ? `back ${plusS(r.wentBackMs, r.gunMs)}` : 'never back');
  if (r.wentBackMs != null) parts.push(r.clearedMs != null ? `recrossed ${plusS(r.clearedMs, r.gunMs)}` : 'not recrossed');
  if (r.lostS != null) parts.push(`≈ ${Math.round(r.lostS)} s lost vs front row`);
  return parts.join(' · ');
}

/** The stretches the replay highlights: over the line (first crossing → back) and the dip back (back → recrossed); ms, open ends Infinity. */
export function replaySpans(r: StartReplay): { over: [number, number] | null; dip: [number, number] | null } {
  const over: [number, number] | null = r.early ? [r.firstCrossMs, r.wentBackMs ?? Infinity] : r.wentBackMs != null ? [r.firstCrossMs, r.wentBackMs] : null;
  const dip: [number, number] | null = r.wentBackMs != null ? [r.wentBackMs, r.clearedMs ?? Infinity] : null;
  return { over, dip };
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
    `<button type="button" class="replay-btn" data-replay="${esc(r.boat)}" aria-pressed="${active === r.boat}" title="Replay ${esc(sailOf(a, r.boat))}'s start: over early, back and recrossed">${esc(text)}</button>`;
  if (highlight != null) return btn(offer[0], 'Replay start');
  return `<span class="replay-lbl">Replay start:</span> ${offer.map((r) => btn(r, sailOf(a, r.boat))).join('<span class="sep" aria-hidden="true"> · </span>')}`;
}

/** The Start tab's way to it: "Replay start → USA 017" links (deep links to the Race tab) for the boats offered; '' with none. */
export function startReplayLinks(a: Pick<RaceAnalysis, 'boats'>, replays: readonly StartReplay[], highlight: string | null, search: string): string {
  const offer = replayOffer(replays, highlight);
  if (!offer.length) return '';
  const links = offer.map(
    (r) => `<a class="replay-link" href="${esc(`${replayLink(search, r.boat)}#race`)}" data-replay="${esc(r.boat)}">Replay start → ${esc(sailOf(a, r.boat))}</a>`,
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
