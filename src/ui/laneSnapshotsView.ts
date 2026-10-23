/**
 * The Start tab's "Around the gun" section: under the start chart (open by default, collapsible; a view of its
 * own, apart from the chart), it draws ui/laneSnapshots.ts's fleet at one second from gun −1:30 to gun +3:00,
 * full width. A time slider (−90 … 180 s, 1 s steps), ‹ › (∓1 s), ← → (1 s; with Shift LANE_SHIFT_STEP_S),
 * Home / End and a play / pause button move it, clamped at the ends. The map pans and zooms as the track map
 * does (ui/panzoom.ts and the same Fit / 2× / 4× / 8× presets): Fit, the default, is the fixed extent over the
 * whole slider; the presets and + / − center on the selected boat at the second on show with the follow camera's
 * look-ahead (laneFollowTarget), else the fleet, and zoomed in, scrubbing and play keep it framed with more room
 * ahead upwind and astern downwind (follow.ts) until the map is panned by hand; they never change the zoom level.
 * Thin: SVG strings from the frames, and the section's wiring (worked out only while open and on show, once per
 * race and selection; the over-early facts asked of the worker once per race; the second picked and the zoom kept
 * for the session; scrubbing redraws just the map).
 *
 * Sizes stay constant on screen whatever the frame's rendered size and zoom: strokes are non-scaling (css px),
 * and text, dots and label offsets are given in view units from the measured css px per unit (lanePxPerUnit,
 * × the zoom). Boats are the start chart's hull (to scale, or at least BOAT_SHAPE_PX long) where they can be
 * (ui/boatShape.ts), else dots; a boat over early is drawn as the track map's replay draws it (ui/ocsStyle.ts).
 * The true wind is a small badge over the map's top-right corner (HTML, outside the map's extent).
 */
import { groupIds, type Group } from '../analysis/coach/groups';
import type { Vec } from '../analysis/geo';
import type { StartReplay } from '../analysis/startReplay';
import type { RaceAnalysis } from '../analysis/types';
import type { ClassDims } from '../data/classes';
import { BOAT_SHAPE_ON_PX, BOAT_SHAPE_PX, boatShapeOr, HULL_LABEL_GAP_PX, HULL_LABEL_SIDES, hullLabelBox, hullPathAt } from './boatShape';
import { boatColor, DOT_LABEL_MAX } from './charts';
import { esc } from './format';
import { textWidth, type Rect } from './labels';
import { laneScrub, laneSecond, LANE_START_S, type LaneBoat, type LaneFrame, type LaneScrub } from './laneSnapshots';
import { ocsLegend, ocsSvg } from './ocsStyle';
import { attachPanZoom } from './panzoom';
import { FOLLOW_COURSE_S, followAfter, followCam, followStep, followTarget, reducedMotion, resetFollow, type FollowInput } from './follow';
import { boatsZoomTarget, clampView, fitView, presetActive, viewBox, zoomPreset, type Box, type View } from './view';

/** The frame's width when it can't be measured (tests, before layout), css px. */
export const LANE_DEFAULT_W_PX = 640;
/** The map's rendered height cap, css px (the CSS also caps it at 60vh). */
export const LANE_MAX_H_PX = 560;
/** The zoom presets, as the track map's (1 = Fit: the default extent). */
export const LANE_ZOOMS = [1, 2, 4, 8] as const;

/**
 * Css px per view unit for the map drawn `widthPx` wide in `view`: the SVG is full width, its height the view's
 * aspect up to `heightPx` (default: capped at LANE_MAX_H_PX), the map centred and scaled to fit (xMidYMid meet).
 */
export function lanePxPerUnit(view: Box, widthPx = LANE_DEFAULT_W_PX, heightPx?: number): number {
  const w = view.x1 - view.x0;
  const h = view.y1 - view.y0;
  if (!(w > 0) || !(h > 0) || !(widthPx > 0)) return 1;
  const hPx = heightPx != null && heightPx > 0 ? heightPx : Math.min((widthPx * h) / w, LANE_MAX_H_PX);
  return Math.min(widthPx / w, hPx / h);
}

/** `px` css px in view units at `ppu` css px per unit. */
export const pxToUnits = (px: number, ppu: number): number => px / ppu;

/** The rectangle the map shows for zoom `zoom` on the fit box `box` (default: Fit, the whole box). */
export function laneVisible(box: Box, zoom?: View): Box {
  const vb = viewBox(box, clampView(box, zoom ?? fitView(box)));
  return { x0: vb.x0, y0: vb.y0, x1: vb.x0 + vb.w, y1: vb.y0 + vb.h };
}

/** Label sizes, css px. */
const LABEL_PX = { me: 13, other: 12 } as const;

const xy = (p: Vec): string => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/** The line and its ends (`u`: view units per css px; strokes in css px, non-scaling). */
function lineSvg(L: LaneScrub, u: number): string {
  const [p, r] = L.line;
  const line = `<line class="startline" x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${r[0].toFixed(1)}" y2="${r[1].toFixed(1)}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`;
  const ends = `<circle class="lane-pin" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(4 * u).toFixed(2)}" stroke-width="1" vector-effect="non-scaling-stroke"/><rect class="lane-rc" x="${(r[0] - 3.5 * u).toFixed(1)}" y="${(r[1] - 3.5 * u).toFixed(1)}" width="${(7 * u).toFixed(2)}" height="${(7 * u).toFixed(2)}"/>`;
  return line + ends;
}

/**
 * The true wind as a small badge over the map's top-right corner (HTML, so it takes no map space): an arrow
 * pointing downwind (turned as the map is; dashed when assumed ⟂ the line) and "TWD ~18° est."; its title says it in full.
 */
export function windBadgeHtml(L: Pick<LaneScrub, 'wind'>): string {
  if (!L.wind) return '';
  const [dx, dy] = L.wind.down;
  // The arrow is drawn pointing down (0, 1); turned clockwise by θ it points (−sin θ, cos θ) = down.
  const deg = (Math.atan2(-dx, dy) * 180) / Math.PI;
  const dash = L.wind.assumed ? ' stroke-dasharray="2.2 1.8"' : '';
  return (
    `<div class="lane-wind${L.wind.assumed ? ' assumed' : ''}" title="${esc(L.wind.title)}">` +
    `<svg class="lane-wind-arrow" viewBox="-8 -8 16 16" width="14" height="14" aria-hidden="true" focusable="false"><g transform="rotate(${deg.toFixed(1)})"><line x1="0" y1="-6.5" x2="0" y2="2.5"${dash}/><polygon points="0,7 -3.6,1.8 3.6,1.8"/></g></svg>` +
    `<span>${esc(L.wind.label)}</span></div>`
  );
}

/** Dot radius, css px (× `u`, view units per css px). */
const dotR = (b: LaneBoat): number => (b.role === 'me' ? 5 : b.role === 'group' ? 4 : 3.2);

/**
 * Boat `b` at `ppu` css px per metre as the hull (its direction, and its size to draw, metres: to scale, or at
 * least BOAT_SHAPE_PX long, the selected boat BOAT_SHAPE_ON_PX), or null: a dot (ui/boatShape.ts's rule).
 */
export function laneShape(L: Pick<LaneScrub, 'dims'>, b: Pick<LaneBoat, 'dir' | 'hold' | 'sog'> & { role?: LaneBoat['role'] }, ppu: number): { dir: Vec; dims: ClassDims } | null {
  const s = boatShapeOr({ dir: b.dir, hold: b.hold, sog: b.sog, dims: L.dims, pxPerM: ppu, minPx: b.role === 'me' ? BOAT_SHAPE_ON_PX : BOAT_SHAPE_PX });
  return 'shape' in s ? { dir: s.shape, dims: s.dims } : null;
}

/** What a boat takes up around its position, view units: the dot's radius, or half the hull's length. */
const reachOf = (L: LaneScrub, b: LaneBoat, u: number): number => {
  const r = dotR(b) * u;
  const hull = laneShape(L, b, 1 / u);
  return hull ? Math.max(r, hull.dims.loaM / 2) : r;
};

interface LabelAt {
  x: number;
  y: number;
  fs: number;
}

/**
 * Sail-number labels that don't overlap: the selected boat's first, then its group's, then (nothing selected, a
 * small fleet) everyone's; each beside its boat where it clears the other boats and labels and stays in the frame,
 * else left out (its boat's title still names it). Beside a hull, HULL_LABEL_GAP_PX off it abeam (clear of its own
 * track), else off the bow or stern (boatShape.ts hullLabelBox); beside a dot, just right, left, above or below it.
 * The gaps are css px, so a label stays as close to its boat at every zoom.
 */
function placeLabels(
  boats: readonly LaneBoat[],
  want: (b: LaneBoat) => boolean,
  u: number,
  view: Box,
  reach: (b: LaneBoat) => number,
  hullOf: (b: LaneBoat) => { dir: Vec; dims: ClassDims } | null,
): Map<string, LabelAt> {
  const out = new Map<string, LabelAt>();
  // Every other boat is in the way of a label (as are the labels placed); a label is placed clear of its own.
  const taken: (Rect & { id?: string })[] = boats
    .filter((b) => b.pos)
    .map((b) => {
      const r = reach(b);
      return { id: b.id, x0: b.pos![0] - r, y0: b.pos![1] - r, x1: b.pos![0] + r, y1: b.pos![1] + r };
    });
  const hit = (q: Rect, id: string): boolean => taken.some((t) => t.id !== id && q.x0 < t.x1 && q.x1 > t.x0 && q.y0 < t.y1 && q.y1 > t.y0);
  const order = { me: 0, group: 1, other: 2 } as const;
  for (const b of [...boats].filter((x) => x.pos && want(x)).sort((p, q) => order[p.role] - order[q.role])) {
    const [x, y] = b.pos!;
    const fs = (b.role === 'me' ? LABEL_PX.me : LABEL_PX.other) * u;
    const w = textWidth(b.sail, fs);
    // The text's box: its baseline 0.85 of the font size below the top.
    const label = (box: Rect): { box: Rect; label: LabelAt } => ({ box, label: { x: box.x0, y: box.y0 + 0.85 * fs, fs } });
    const hull = hullOf(b);
    let all: { box: Rect; label: LabelAt }[];
    if (hull) all = HULL_LABEL_SIDES.map((side) => label(hullLabelBox(b.pos!, hull.dir, hull.dims, w, 1.1 * fs, HULL_LABEL_GAP_PX * u, side)));
    else {
      // Right of the dot, left, above, below (the text's baseline at y).
      const r = dotR(b) * u;
      all = (['right', 'left', 'above', 'below'] as const).map((side) => {
        const x0 = side === 'right' ? x + r + 2.5 * u : side === 'left' ? x - r - 2.5 * u - w : x - w / 2;
        const yb = side === 'above' ? y - r - 3 * u : side === 'below' ? y + r + 0.9 * fs : y - r;
        return { box: { x0, y0: yb - 0.85 * fs, x1: x0 + w, y1: yb + 0.25 * fs }, label: { x: x0, y: yb, fs } };
      });
    }
    const inside = (q: Rect): boolean => q.x0 >= view.x0 && q.x1 <= view.x1 && q.y0 >= view.y0 && q.y1 <= view.y1;
    const cands = all.filter((c) => inside(c.box));
    // The selected boat is always labelled: on a clear side, else the first that fits the frame.
    const pick = cands.find((c) => !hit(c.box, b.id)) ?? (b.role === 'me' ? (cands[0] ?? all[0]) : null);
    if (!pick) continue;
    taken.push(pick.box);
    out.set(b.id, pick.label);
  }
  return out;
}

/** "+26 s" (from the gun). */
const plusS = (ms: number, gun: number): string => {
  const s = Math.round((ms - gun) / 1000);
  return `${s < 0 ? '−' : '+'}${Math.abs(s)} s`;
};

/**
 * One boat's trail and its hull (or dot), coloured for the selected boat and its group, the rest faded; over
 * early, its track over the line and back as the track map's replay draws it (never faded), said in the boat's
 * title ("USA 019, over early (OCS), cleared +35 s").
 */
function boatSvg(L: LaneScrub, b: LaneBoat, colour: string, faded: boolean, label: LabelAt | null, u: number, gun: number): { trail: string; ocs: string; dot: string; flag: string } {
  const cls = `lane-${b.role}${faded ? ' dim' : ''}`;
  const sw = b.role === 'me' ? 2.4 : b.role === 'group' ? 1.6 : 1.1;
  const trail = b.trail
    .map((seg) => `<polyline class="lane-trail ${cls}" points="${seg.map(xy).join(' ')}" stroke="${faded ? 'var(--ink-3)' : colour}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>`)
    .join('');
  const o = b.ocs ? ocsSvg(b.ocs, { unit: u, nonScaling: true }) : { tracks: '', marks: '' };
  if (!b.pos) return { trail, ocs: o.tracks, dot: '', flag: o.marks };
  const [x, y] = [b.pos[0].toFixed(1), b.pos[1].toFixed(1)];
  const r = dotR(b) * u;
  const ink = faded ? 'var(--ink-3)' : colour;
  const fill = b.hold ? `fill="var(--surface)" stroke="${ink}"` : `fill="${ink}"`;
  const state = b.over === 'over' ? ', over early (OCS)' : b.over === 'cleared' ? `, over early (OCS), cleared ${plusS(b.clearedMs!, gun)}` : '';
  const text = label
    ? `<text class="lane-lbl${b.role === 'me' ? ' on' : ''}" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" font-size="${label.fs.toFixed(2)}" stroke-width="${(2.5 * u).toFixed(2)}">${esc(b.sail)}</text>`
    : '';
  const hull = laneShape(L, b, 1 / u);
  const mark = hull
    ? `<path class="lane-dot lane-hull" d="${hullPathAt(b.pos, hull.dir, hull.dims)}" ${fill} stroke-width="${b.role === 'me' ? 1.4 : 1}" vector-effect="non-scaling-stroke"/>`
      : `<circle class="lane-dot${b.hold ? ' hold' : ''}" cx="${x}" cy="${y}" r="${r.toFixed(2)}" ${fill} stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  const dot = `<g class="lane-boat ${cls}" data-id="${esc(b.id)}"><title>${esc(b.sail)}${b.hold ? ' (last fix, in a gap)' : ''}${state}</title>${mark}${text}</g>`;
  return { trail, ocs: o.tracks, dot, flag: o.marks };
}

/**
 * The frame: its SVG (the fit box at `zoom`, `ppu` css px per unit at Fit) and caption (the time and the selected
 * boat's place), the wind badge over its corner.
 */
function frameHtml(a: RaceAnalysis, L: LaneScrub, f: LaneFrame, ppu: number, zoom?: View): string {
  const v = laneVisible(L.view, zoom);
  const w = v.x1 - v.x0;
  const h = v.y1 - v.y0;
  // Zoomed in k×, a view unit is k× the css px.
  const k = (L.view.x1 - L.view.x0) / w || 1;
  const u = pxToUnits(1, ppu * k);
  const fleet = a.boats.length;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const sel = L.me != null && f.boats.some((b) => b.id === L.me);
  // The track map's rule: a fleet within the colour slots has every boat labelled, in its own colour.
  const small = fleet <= DOT_LABEL_MAX;
  const labels = placeLabels(f.boats, (b) => b.role !== 'other' || (!sel && small), u, v, (b) => reachOf(L, b, u), (b) => laneShape(L, b, 1 / u));
  // A small fleet in the boats' own colours; a big one (the colours run out): the selected boat ink, its group accent.
  const colourOf = (b: LaneBoat): string => {
    const r = byId.get(b.id);
    if (small && r) return boatColor(r, fleet);
    return b.role === 'me' ? 'var(--ink)' : b.role === 'group' ? 'var(--accent)' : 'var(--ink-2)';
  };
  const drawn = f.boats.map((b) => ({ b, ...boatSvg(L, b, colourOf(b), sel && b.role === 'other', labels.get(b.id) ?? null, u, a.meta.gunMs) }));
  // The faded boats first, then the group, the selected boat on top.
  const order = { other: 0, group: 1, me: 2 } as const;
  drawn.sort((p, q) => order[p.b.role] - order[q.b.role]);
  const empty = f.empty
    ? `<text class="lane-empty" x="${(v.x0 + w / 2).toFixed(1)}" y="${(v.y0 + h / 2).toFixed(1)}" font-size="${(13 * u).toFixed(2)}" text-anchor="middle">No tracks</text>`
    : '';
  const svg =
    `<svg class="chart lane-svg" viewBox="${v.x0.toFixed(1)} ${v.y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(f.label)}">` +
    `<title>${esc(f.label)}</title>${lineSvg(L, u)}` +
    `<g class="lane-trails">${drawn.map((d) => d.trail).join('')}</g><g class="lane-ocs">${drawn.map((d) => d.ocs).join('')}</g>` +
    `<g class="lane-dots">${drawn.map((d) => d.dot).join('')}</g><g class="lane-flags">${drawn.map((d) => d.flag).join('')}</g>${empty}</svg>`;
  return `<figure class="lane-frame${f.empty ? ' empty' : ''}" data-s="${f.s}"><figcaption><b class="lane-time">${esc(f.title)}</b> <span class="lane-cap">${esc(f.caption)}</span></figcaption><div class="lane-map">${svg}${windBadgeHtml(L)}</div></figure>`;
}

/** Shift + ← / →: this many seconds. */
export const LANE_SHIFT_STEP_S = 10;
/** Play: one second of the race every this many ms (10× real time); it stops at the end. */
export const LANE_PLAY_MS = 100;
/** The screen-reader summary is said this long after the last change (polite; not every second while dragging). */
export const LANE_SAY_MS = 700;

/** Second `s` stepped by `d`, clamped to `start` … `end` (no wrap). */
export const stepLaneSecond = (s: number, d: number, end: number, start = LANE_START_S): number => laneSecond(s + d, end, start);

/** The second a key moves `s` to while focus is in the section (← → 1 s, with Shift LANE_SHIFT_STEP_S; Home / End: the ends), clamped; null: not ours. */
export function laneKeyTarget(key: string, shift: boolean, s: number, end: number, start = LANE_START_S): number | null {
  const by = shift ? LANE_SHIFT_STEP_S : 1;
  if (key === 'ArrowLeft') return stepLaneSecond(s, -by, end, start);
  if (key === 'ArrowRight') return stepLaneSecond(s, by, end, start);
  if (key === 'Home') return start;
  if (key === 'End') return end;
  return null;
}

const PLAY_ICONS =
  '<svg class="i-play" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 2.5v11l9-5.5z"/></svg>' +
  '<svg class="i-pause" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';

/** The controls: ‹, play / pause, the slider (start … end, 1 s; its spoken value the time), ›. `‹` is disabled at the start, `›` at the end. */
function laneControlsHtml(L: LaneScrub, s: number, playing: boolean): string {
  const title = L.frame(s).title;
  const step = (d: -1 | 1): string =>
    `<button type="button" class="lane-step" data-lane-step="${d}" aria-label="${d < 0 ? 'Back' : 'Forward'} 1 second"${stepLaneSecond(s, d, L.end, L.start) === s ? ' disabled' : ''}>${d < 0 ? '‹' : '›'}</button>`;
  return (
    `<div class="lane-ctl">${step(-1)}` +
    `<button type="button" class="lane-play" data-lane-play aria-pressed="${playing}" aria-label="${playing ? 'Pause' : 'Play'}">${PLAY_ICONS}</button>` +
    `<input type="range" class="lane-range" min="${L.start}" max="${L.end}" step="1" value="${s}" aria-label="Seconds from the gun" aria-valuetext="${esc(title)}" aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight Home End"/>` +
    `${step(1)}</div>`
  );
}

/** The zoom presets (the track map's: Fit / 2× / 4× / 8×), the one matching `zoom` pressed. */
function laneZoomHtml(L: LaneScrub, zoom: View): string {
  const btn = (z: number): string => `<button type="button" data-zoom="${z}" aria-pressed="${presetActive(L.view, zoom, z)}">${z === 1 ? 'Fit' : `${z}×`}</button>`;
  return `<div class="zoom lane-zoom" role="group" aria-label="Around the gun map zoom">${LANE_ZOOMS.map(btn).join('')}</div>`;
}

/**
 * The section's body: the controls, the zoom presets, the frame at second `s` (in the fit box at `zoom`, default
 * Fit) in the pan / zoom stage, a polite live region (filled by the mount after scrubbing) and a key line (who is
 * highlighted, the wind's source; the over-early legend when a boat was over early). `ppu`: css px per view unit
 * at Fit as measured (default: the frame at LANE_DEFAULT_W_PX).
 */
export function laneScrubHtml(a: RaceAnalysis, L: LaneScrub, groupText?: string, s = 0, ppu = lanePxPerUnit(L.view), playing = false, zoom: View = fitView(L.view)): string {
  const me = L.me != null ? a.boats.find((b) => b.id === L.me) : undefined;
  const key = [me ? `${me.sail} highlighted${groupText ? `, with ${groupText}` : ''}; the rest faded.` : 'Pick a boat to highlight it and its group.', L.note];
  const on = laneSecond(s, L.end, L.start);
  const z = clampView(L.view, zoom);
  return (
    `${laneControlsHtml(L, on, playing)}${laneZoomHtml(L, z)}` +
    `<div class="lane-stage panzoom${z.k > 1 ? ' zoomed' : ''}" tabindex="0" role="group" aria-label="Around the gun map. Arrow keys pan when zoomed, plus and minus zoom, 0 resets.">${frameHtml(a, L, L.frame(on), ppu, z)}</div>` +
    `<p class="lane-live" aria-live="polite"></p>` +
    `<p class="lane-key muted">${key.map(esc).join(' ')}${L.anyOver ? ocsLegend() : ''}</p>`
  );
}

/**
 * What the presets and + / − centre on at frame `f`: the selected boat where it is placed, else the middle of
 * the placed fleet, else null (the map's centre).
 */
export const laneZoomTarget = (f: Pick<LaneFrame, 'boats'>, me: string | null): [number, number] | null => boatsZoomTarget(f.boats, me, (b) => b.pos);

/**
 * The follow camera's input (follow.ts) for boat `me` at second `s`: its position, its course each second over the
 * FOLLOW_COURSE_S before (none before the slider's start), and the wind (none when only assumed from the line); null:
 * not placed at `s`.
 */
export function laneFollowInput(L: Pick<LaneScrub, 'frame' | 'start' | 'wind'>, me: string, s: number): FollowInput | null {
  const pos = L.frame(s).boats.find((b) => b.id === me)?.pos;
  if (!pos) return null;
  const dirs: (Vec | null)[] = [];
  for (let i = 0; i < FOLLOW_COURSE_S; i++) dirs.push(s - i >= L.start ? (L.frame(s - i).boats.find((b) => b.id === me)?.dir ?? null) : null);
  return { t: s, pos, dirs, down: L.wind && !L.wind.assumed ? L.wind.down : null };
}

/**
 * What the presets and + / − center on at zoom `k`: the selected boat placed at second `s` with the follow camera's
 * look-ahead for a view that size; else laneZoomTarget (the fleet's middle, or null).
 */
export function laneFollowTarget(L: Pick<LaneScrub, 'frame' | 'start' | 'wind' | 'view' | 'me'>, s: number, k: number): [number, number] | null {
  const input = L.me != null ? laneFollowInput(L, L.me, s) : null;
  if (!input) return laneZoomTarget(L.frame(s), L.me);
  const vb = viewBox(L.view, { cx: 0, cy: 0, k: Math.max(1, k) });
  return followTarget(input.pos, input.dirs, input.down, vb.w, vb.h);
}

/** The Coach group, as the key line names it. */
const GROUP_TEXT: Record<Group['kind'], string> = { leaders: 'the top 3 (Coach group)', near: 'the boats near it (Coach group)', fleet: 'the whole fleet', custom: 'its Coach group' };

export interface LaneState {
  a: RaceAnalysis | null;
  me: string | null;
  group: Group;
}

/** Where "Replay start → <sail>" cues the slider: 5 s before the boat's track went over (from the slider's start), but never later than 10 s before the gun. */
export const LANE_CUE_PRE_S = 5;
export const LANE_CUE_GUN_S = -10;
export function laneCueSecond(r: Pick<StartReplay, 'over' | 'gunMs'>, start = LANE_START_S): number {
  const over = r.over ? Math.floor((r.over[0] - r.gunMs) / 1000) - LANE_CUE_PRE_S : LANE_CUE_GUN_S;
  return Math.max(start, Math.min(LANE_CUE_GUN_S, over));
}

export interface LaneMount {
  refresh: () => void;
  second: () => number;
  playing: () => boolean;
  scrub: () => LaneScrub | null;
  /** The map's zoom (the fit box's View; k 1 = Fit). */
  zoom: () => View;
  /** Set the zoom (clamped), redrawing the map only; as a pan by hand, it ends the follow. */
  setZoom: (v: View) => void;
  /** The look-ahead follow is on (a preset, + / −, Fit or a boat selected since the map was last panned by hand). */
  following: () => boolean;
  /** Open the section on second `s` (clamped; drawn from the current state), and `play` it from there. */
  cue: (s: number, play: boolean) => void;
}

/**
 * Wire the `<details>` section `root` (its body: `.lane-body`): drawn when opened and on `refresh()` while
 * open and `shown()` (its tab on screen), from `state()`; the over-early facts from `replaysOf` (the worker),
 * asked once per analysis. The per-second frames are worked out once per race, selection and replays (a refresh
 * with none of those changed reuses them). The second on show (the gun at first) is kept across redraws for the
 * session, as is the zoom (back to Fit for another race); the slider, ‹ ›, the keys and play move the second,
 * redrawing just the map (and the controls' state); pinch, drag, the wheel (Ctrl / ⌘, or plain with the map focused),
 * + / − / 0 and the presets zoom it.
 */
export function mountLaneSnapshots(
  root: HTMLDetailsElement,
  state: () => LaneState,
  replaysOf: (a: RaceAnalysis) => Promise<StartReplay[] | null>,
  shown: () => boolean = () => true,
): LaneMount {
  const body = root.querySelector<HTMLElement>('.lane-body')!;
  const asked = new WeakMap<RaceAnalysis, StartReplay[] | null>();
  let sec = 0;
  let last: { a: RaceAnalysis; L: LaneScrub; groupText?: string; key: string; replays: StartReplay[] | null } | null = null;
  /** The map's measured css px per unit at Fit (null: not measured yet: the default width). */
  let ppu: number | null = null;
  /** The map's zoom on the fit box (Fit until zoomed; never moved by the slider). */
  let zoom: View = { cx: 0, cy: 0, k: 1 };
  /** The look-ahead follow (follow.ts): on from the presets, + / −, Fit and a boat selected; off once the map is panned by hand. */
  let follow = true;
  const cam = followCam();
  /** The boat the follow was last turned on for. */
  let followFor: string | null = null;
  const target = (k: number = zoom.k): [number, number] | null => (last ? laneFollowTarget(last.L, sec, k) : null);
  /** Zoomed in and following: one camera step for the second on show. */
  const applyFollow = (): void => {
    const input = follow && zoom.k > 1 && last?.L.me != null ? laneFollowInput(last.L, last.L.me, sec) : null;
    if (input) zoom = followStep(cam, last!.L.view, zoom, input, reducedMotion());
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let say: ReturnType<typeof setTimeout> | null = null;
  /** The stage pan / zoom is attached to (the body's, repainted with it), and its detach. */
  let stage: { el: HTMLElement; detach: () => void } | null = null;
  const q = <T extends Element>(sel: string): T | null => body.querySelector?.<T>(sel) ?? null;
  const ppuNow = (): number => ppu ?? (last ? lanePxPerUnit(last.L.view) : 1);
  /** Pan / zoom on the stage now in the body (the track map's, ui/panzoom.ts), once per stage element. */
  const wire = (): void => {
    const el = q<HTMLElement>('.lane-stage');
    if (!el || el === stage?.el || typeof el.addEventListener !== 'function') return;
    stage?.detach();
    stage = {
      el,
      detach: attachPanZoom(el, {
        getBox: () => last?.L.view ?? null,
        getView: () => zoom,
        setView: setZoom,
        getRect: () => (el.querySelector('svg') ?? el).getBoundingClientRect(),
        getTarget: target,
        follow: (on) => (follow = on),
      }),
    };
  };
  const paint = (): void => {
    if (!last) return;
    body.innerHTML = laneScrubHtml(last.a, last.L, last.groupText, sec, ppuNow(), timer != null, zoom);
    wire();
  };
  /** Measure the map on show; a scale off by over 2% from the one drawn: repaint (text, dots stay their css px). */
  const fit = (): void => {
    if (!last) return;
    const svg = q<SVGSVGElement>('.lane-frame svg.lane-svg');
    if (!svg?.clientWidth || !svg.clientHeight) return;
    // The SVG keeps the fit box's aspect at any zoom, so its size gives the scale at Fit.
    const now = lanePxPerUnit(last.L.view, svg.clientWidth, svg.clientHeight);
    const drawn = ppuNow();
    ppu = now;
    if (Math.abs(now - drawn) > 0.02 * drawn) paint();
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(body);
  const stop = (): void => {
    if (timer != null) clearInterval(timer);
    timer = null;
    q<HTMLButtonElement>('.lane-play')?.setAttribute('aria-pressed', 'false');
    q<HTMLButtonElement>('.lane-play')?.setAttribute('aria-label', 'Play');
  };
  /** Just the map, at the second and zoom on show (a full paint when the body isn't ours yet). */
  const drawStage = (): boolean => {
    if (!last) return false;
    const el = q<HTMLElement>('.lane-stage');
    if (!el) {
      paint();
      return false;
    }
    el.innerHTML = frameHtml(last.a, last.L, last.L.frame(sec), ppuNow(), zoom);
    return true;
  };
  /** The frame at the second on show: the map, the slider and the ‹ › state. */
  const show = (): void => {
    if (!last) return;
    const f = last.L.frame(sec);
    // Zoomed in: the look-ahead camera on the selected boat.
    applyFollow();
    if (!drawStage()) return;
    const range = q<HTMLInputElement>('.lane-range');
    if (range) {
      range.value = String(sec);
      range.setAttribute('aria-valuetext', f.title);
    }
    for (const d of [-1, 1]) {
      const b = q<HTMLButtonElement>(`[data-lane-step="${d}"]`);
      if (!b) continue;
      const off = stepLaneSecond(sec, d, last.L.end, last.L.start) === sec;
      // A button disabled under focus would drop it: focus goes to the slider.
      if (off && typeof document !== 'undefined' && document.activeElement === b) range?.focus();
      b.disabled = off;
    }
    // Said once the scrubbing settles (polite), not every second.
    if (say != null) clearTimeout(say);
    say = setTimeout(() => {
      say = null;
      const live = q<HTMLElement>('.lane-live');
      if (live && last) live.textContent = last.L.frame(sec).label;
    }, LANE_SAY_MS);
  };
  /** The zoom (clamped to the fit box), the presets' state and the stage's touch-action; the map redrawn at the same second. */
  function setZoom(v: View): void {
    if (!last) return;
    zoom = clampView(last.L.view, v);
    const z = q<HTMLElement>('.lane-zoom');
    for (const b of z?.querySelectorAll?.('button[data-zoom]') ?? []) b.setAttribute('aria-pressed', String(presetActive(last.L.view, zoom, Number(b.getAttribute('data-zoom')))));
    q<HTMLElement>('.lane-stage')?.classList?.toggle('zoomed', zoom.k > 1);
    drawStage();
  }
  /** Go to second `s` (clamped); `user`: a scrub, a step or a key, which stops play. */
  const go = (s: number, user = true): void => {
    if (!last) return;
    if (user) stop();
    const next = laneSecond(s, last.L.end, last.L.start);
    if (next === sec) return;
    sec = next;
    show();
  };
  const play = (): void => {
    if (!last) return;
    if (timer != null) return stop();
    // From the end: start again at the slider's start.
    if (sec >= last.L.end) go(last.L.start, false);
    timer = setInterval(() => {
      if (!last || !root.open || !shown() || sec >= last.L.end) return stop();
      go(sec + 1, false);
      if (sec >= last.L.end) stop();
    }, LANE_PLAY_MS);
    q<HTMLButtonElement>('.lane-play')?.setAttribute('aria-pressed', 'true');
    q<HTMLButtonElement>('.lane-play')?.setAttribute('aria-label', 'Pause');
  };
  const draw = (): void => {
    if (!root.open || !shown()) return stop();
    const { a, me, group } = state();
    if (!a) {
      stop();
      last = null;
      body.innerHTML = '';
      return;
    }
    if (!asked.has(a)) {
      asked.set(a, null);
      void replaysOf(a).then((list) => {
        asked.set(a, list ?? []);
        if (state().a === a) draw();
      });
    }
    const id = me != null && a.boats.some((b) => b.id === me) ? me : null;
    const ids = id ? groupIds(a.boats, id, group) : [];
    const replays = asked.get(a) ?? null;
    const key = `${id ?? ''}|${ids.join(',')}`;
    // Worked out once per race, selection and replays; otherwise the same frames are drawn again.
    const same = last != null && last.a === a && last.key === key && last.replays === replays;
    if (last?.a !== a) stop();
    const L = same ? last!.L : laneScrub(a, { me: id, group: ids, replays });
    // A new view (another race): its scale is measured afresh, and it opens at Fit.
    if (last?.L.view.x0 !== L.view.x0 || last.L.view.x1 !== L.view.x1 || last.L.view.y0 !== L.view.y0 || last.L.view.y1 !== L.view.y1) {
      ppu = null;
      zoom = fitView(L.view);
    }
    last = { a, L, groupText: id ? GROUP_TEXT[group.kind] : undefined, key, replays };
    // A boat selected (here or anywhere): follow it, snapping to it once zoomed in.
    if (id !== followFor) {
      followFor = id;
      if (id != null) {
        follow = followAfter(follow, 'select');
        resetFollow(cam);
        applyFollow();
      }
    }
    paint();
    fit();
  };
  root.addEventListener('toggle', draw);
  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest?.<HTMLElement>('[data-lane-step], [data-lane-play], button[data-zoom]');
    if (!el || !last) return;
    if (el.dataset.laneStep != null) go(sec + Number(el.dataset.laneStep));
    else if (el.dataset.zoom != null) {
      // The presets centre on the selected boat (else the fleet) at the second on show and follow it; Fit (the
      // default extent) resets it, as on the track map.
      const z = Number(el.dataset.zoom);
      if (Number.isFinite(z) && z > 0) {
        follow = followAfter(follow, 'preset');
        setZoom(zoomPreset(last.L.view, z, target(z)));
      }
    } else play();
  });
  root.addEventListener('input', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.classList?.contains('lane-range')) go(Number(el.value));
  });
  root.addEventListener('keydown', (ev) => {
    // Panned already (the map zoomed in, its arrows): not a step.
    if (!last || !root.open || ev.defaultPrevented) return;
    const to = laneKeyTarget(ev.key, ev.shiftKey, sec, last.L.end, last.L.start);
    if (to == null) return;
    // Ours, on the slider too (its own arrows would step 1 s, without Shift).
    ev.preventDefault();
    go(to);
  });
  const cue = (s: number, andPlay: boolean): void => {
    stop();
    root.open = true;
    draw();
    if (!last) return;
    sec = laneSecond(s, last.L.end, last.L.start);
    show();
    if (andPlay) play();
  };
  const setZoomByHand = (v: View): void => {
    follow = followAfter(follow, 'pan');
    setZoom(v);
  };
  return { refresh: draw, second: () => sec, playing: () => timer != null, scrub: () => last?.L ?? null, zoom: () => zoom, setZoom: setZoomByHand, following: () => follow, cue };
}
