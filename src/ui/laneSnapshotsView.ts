/**
 * The Start tab's "Lane snapshots": a section under the start chart (open by default, collapsible) that draws
 * ui/laneSnapshots.ts's three frames one at a time, full width, in one shared view: a segmented control
 * (+1:00 | +2:00 | +3:00), ‹ › and the ← → keys step between them (clamped at the ends). Thin: SVG strings from
 * the frames, and the section's wiring (worked out only while open and on show; the over-early facts asked of
 * the worker once per race; the frame picked kept for the session).
 *
 * Sizes stay constant on screen whatever the frame's rendered size: strokes are non-scaling (css px), and text,
 * dots and label offsets are given in view units from the measured css px per unit (lanePxPerUnit). The true
 * wind is a small badge over the map's top-right corner (HTML, outside the map's extent).
 */
import { groupIds, type Group } from '../analysis/coach/groups';
import type { Vec } from '../analysis/geo';
import type { StartReplay } from '../analysis/startReplay';
import type { RaceAnalysis } from '../analysis/types';
import { boatColor, DOT_LABEL_MAX } from './charts';
import { esc } from './format';
import { textWidth, type Rect } from './labels';
import { laneSnapshots, type LaneBoat, type LaneFrame, type LaneSnapshots } from './laneSnapshots';
import type { Box } from './view';

/** The frame's width when it can't be measured (tests, before layout), css px. */
export const LANE_DEFAULT_W_PX = 640;
/** The map's rendered height cap, css px (the CSS also caps it at 60vh). */
export const LANE_MAX_H_PX = 560;

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

/** Label sizes, css px. */
const LABEL_PX = { me: 13, other: 12 } as const;

const xy = (p: Vec): string => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/** The line and its ends (`u`: view units per css px; strokes in css px, non-scaling). */
function lineSvg(L: LaneSnapshots, u: number): string {
  const [p, r] = L.line;
  const line = `<line class="startline" x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${r[0].toFixed(1)}" y2="${r[1].toFixed(1)}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`;
  const ends = `<circle class="lane-pin" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(4 * u).toFixed(2)}" stroke-width="1" vector-effect="non-scaling-stroke"/><rect class="lane-rc" x="${(r[0] - 3.5 * u).toFixed(1)}" y="${(r[1] - 3.5 * u).toFixed(1)}" width="${(7 * u).toFixed(2)}" height="${(7 * u).toFixed(2)}"/>`;
  return line + ends;
}

/**
 * The true wind as a small badge over the map's top-right corner (HTML, so it takes no map space): an arrow
 * pointing downwind (turned as the map is; dashed when assumed ⟂ the line) and "TWD ~18° est."; its title says it in full.
 */
export function windBadgeHtml(L: Pick<LaneSnapshots, 'wind'>): string {
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

interface LabelAt {
  x: number;
  y: number;
  fs: number;
}

/**
 * Sail-number labels that don't overlap: the selected boat's first, then its group's, then (nothing selected, a
 * small fleet) everyone's; each beside its dot where it clears the dots and labels and stays in the frame, else
 * left out (its dot's title still names it).
 */
function placeLabels(boats: readonly LaneBoat[], want: (b: LaneBoat) => boolean, u: number, view: Box): Map<string, LabelAt> {
  const out = new Map<string, LabelAt>();
  // Every dot is in the way of a label (as are the labels placed).
  const taken: Rect[] = boats
    .filter((b) => b.pos)
    .map((b) => {
      const r = dotR(b) * u;
      return { x0: b.pos![0] - r, y0: b.pos![1] - r, x1: b.pos![0] + r, y1: b.pos![1] + r };
    });
  const hit = (q: Rect): boolean => taken.some((t) => q.x0 < t.x1 && q.x1 > t.x0 && q.y0 < t.y1 && q.y1 > t.y0);
  const order = { me: 0, group: 1, other: 2 } as const;
  for (const b of [...boats].filter((x) => x.pos && want(x)).sort((p, q) => order[p.role] - order[q.role])) {
    const [x, y] = b.pos!;
    const r = dotR(b) * u;
    const fs = (b.role === 'me' ? LABEL_PX.me : LABEL_PX.other) * u;
    const w = textWidth(b.sail, fs);
    // Right of the dot, left, above, below (the text's baseline at y); inside the frame.
    const at = (side: 'right' | 'left' | 'above' | 'below'): { box: Rect; label: LabelAt } => {
      const x0 = side === 'right' ? x + r + 2.5 * u : side === 'left' ? x - r - 2.5 * u - w : x - w / 2;
      const yb = side === 'above' ? y - r - 3 * u : side === 'below' ? y + r + 0.9 * fs : y - r;
      return { box: { x0, y0: yb - 0.85 * fs, x1: x0 + w, y1: yb + 0.25 * fs }, label: { x: x0, y: yb, fs } };
    };
    const inside = (q: Rect): boolean => q.x0 >= view.x0 && q.x1 <= view.x1 && q.y0 >= view.y0 && q.y1 <= view.y1;
    const cands = (['right', 'left', 'above', 'below'] as const).map(at).filter((c) => inside(c.box));
    // The selected boat is always labelled: on a clear side, else the first that fits the frame.
    const pick = cands.find((c) => !hit(c.box)) ?? (b.role === 'me' ? (cands[0] ?? at('right')) : null);
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
 * The over-early ring around a dot of radius `r` (solid while over, dashed once cleared); the key's swatches use
 * it too. On the map (`ns`) its stroke is non-scaling (css px); in a swatch it's in the swatch's own units.
 */
const ringSvg = (over: 'over' | 'cleared', cx: string, cy: string, r: number, u: number, ns = false): string => {
  const k = ns ? 1 : u;
  return `<circle class="lane-${over}" cx="${cx}" cy="${cy}" r="${(r + 2.5 * u).toFixed(2)}" stroke-width="${(1.3 * k).toFixed(2)}"${over === 'over' ? '' : ` stroke-dasharray="${(2.5 * k).toFixed(2)} ${(2 * k).toFixed(2)}"`}${ns ? ' vector-effect="non-scaling-stroke"' : ''}/>`;
};

/** The key's legend for the rings, both kinds (shown when any boat was over early): a swatch (aria-hidden) and its words. */
function ringLegend(): string {
  const item = (over: 'over' | 'cleared', text: string): string =>
    `<span class="lane-legend-item"><svg class="lane-swatch" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">${ringSvg(over, '7', '7', 3.2, 1)}</svg>${text}</span>`;
  return `<span class="lane-legend">${item('over', 'OCS')}${item('cleared', 'OCS, cleared')}</span>`;
}

/**
 * One boat's trail and dot, coloured for the selected boat and its group, the rest faded; a small ring when over
 * early (solid while over, dashed once cleared), said in the dot's title ("USA 019, over early (OCS), cleared +35 s").
 */
function boatSvg(b: LaneBoat, colour: string, faded: boolean, label: LabelAt | null, u: number, gun: number): { trail: string; dot: string; flag: string } {
  const cls = `lane-${b.role}${faded ? ' dim' : ''}`;
  const sw = b.role === 'me' ? 2.4 : b.role === 'group' ? 1.6 : 1.1;
  const trail = b.trail
    .map((seg) => `<polyline class="lane-trail ${cls}" points="${seg.map(xy).join(' ')}" stroke="${faded ? 'var(--ink-3)' : colour}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>`)
    .join('');
  if (!b.pos) return { trail, dot: '', flag: '' };
  const [x, y] = [b.pos[0].toFixed(1), b.pos[1].toFixed(1)];
  const r = dotR(b) * u;
  const fill = b.hold ? `fill="var(--surface)" stroke="${faded ? 'var(--ink-3)' : colour}"` : `fill="${faded ? 'var(--ink-3)' : colour}"`;
  const state = b.over === 'over' ? ', over early (OCS)' : b.over === 'cleared' ? `, over early (OCS), cleared ${plusS(b.clearedMs!, gun)}` : '';
  const ring = b.over ? ringSvg(b.over, x, y, r, u, true) : '';
  const text = label
    ? `<text class="lane-lbl${b.role === 'me' ? ' on' : ''}" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" font-size="${label.fs.toFixed(2)}" stroke-width="${(2.5 * u).toFixed(2)}">${esc(b.sail)}</text>`
    : '';
  const dot = `<g class="lane-boat ${cls}" data-id="${esc(b.id)}"><title>${esc(b.sail)}${b.hold ? ' (last fix, in a gap)' : ''}${state}</title><circle class="lane-dot${b.hold ? ' hold' : ''}" cx="${x}" cy="${y}" r="${r.toFixed(2)}" ${fill} stroke-width="1" vector-effect="non-scaling-stroke"/>${text}</g>`;
  // Over / cleared: never faded with the boat.
  return { trail, dot, flag: ring };
}

/** One frame: its SVG (shared view, `ppu` css px per unit) and caption, the wind badge over its corner; `hidden` (from screen readers too) unless it is the one on show. */
function frameHtml(a: RaceAnalysis, L: LaneSnapshots, f: LaneFrame, shown: boolean, ppu: number): string {
  const v = L.view;
  const w = v.x1 - v.x0;
  const h = v.y1 - v.y0;
  const u = pxToUnits(1, ppu);
  const fleet = a.boats.length;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const sel = L.me != null && f.boats.some((b) => b.id === L.me);
  // The track map's rule: a fleet within the colour slots has every dot labelled, in its own colour.
  const small = fleet <= DOT_LABEL_MAX;
  const labels = placeLabels(f.boats, (b) => b.role !== 'other' || (!sel && small), u, v);
  // A small fleet in the boats' own colours; a big one (the colours run out): the selected boat ink, its group accent.
  const colourOf = (b: LaneBoat): string => {
    const r = byId.get(b.id);
    if (small && r) return boatColor(r, fleet);
    return b.role === 'me' ? 'var(--ink)' : b.role === 'group' ? 'var(--accent)' : 'var(--ink-2)';
  };
  const drawn = f.boats.map((b) => ({ b, ...boatSvg(b, colourOf(b), sel && b.role === 'other', labels.get(b.id) ?? null, u, a.meta.gunMs) }));
  // The faded boats first, then the group, the selected boat on top.
  const order = { other: 0, group: 1, me: 2 } as const;
  drawn.sort((p, q) => order[p.b.role] - order[q.b.role]);
  const empty = f.empty
    ? `<text class="lane-empty" x="${(v.x0 + w / 2).toFixed(1)}" y="${(v.y0 + h / 2).toFixed(1)}" font-size="${(13 * u).toFixed(2)}" text-anchor="middle">No tracks</text>`
    : '';
  const svg =
    `<svg class="chart lane-svg" viewBox="${v.x0.toFixed(1)} ${v.y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(f.label)}">` +
    `<title>${esc(f.label)}</title>${lineSvg(L, u)}` +
    `<g class="lane-trails">${drawn.map((d) => d.trail).join('')}</g><g class="lane-dots">${drawn.map((d) => d.dot).join('')}</g><g class="lane-flags">${drawn.map((d) => d.flag).join('')}</g>${empty}</svg>`;
  return `<figure class="lane-frame${f.empty ? ' empty' : ''}" data-s="${f.s}"${shown ? '' : ' hidden'}><figcaption><b>${esc(f.title)}</b> <span class="lane-cap">${esc(f.caption)}</span></figcaption><div class="lane-map">${svg}${windBadgeHtml(L)}</div></figure>`;
}

/** Frame `i` stepped by `d`, clamped to the `n` frames (no wrap: ‹ at the first and › at the last are disabled). */
export const stepLaneFrame = (i: number, d: number, n: number): number => Math.max(0, Math.min(n - 1, i + d));

/** The step for a key while focus is in the section: ← back, → on, else 0. */
export const laneKeyStep = (key: string): -1 | 0 | 1 => (key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0);

/** The frame picker: ‹, one aria-pressed button per frame (`+1:00`), ›. */
function laneNavHtml(L: LaneSnapshots, sel: number): string {
  const n = L.frames.length;
  const seg = L.frames
    .map((f, i) => `<button type="button" data-lane-frame="${i}" aria-pressed="${i === sel}" aria-label="${esc(f.title)}">${esc(f.title.replace(/^gun /, ''))}</button>`)
    .join('');
  const step = (d: -1 | 1): string =>
    `<button type="button" class="lane-step" data-lane-step="${d}" aria-label="${d < 0 ? 'Previous' : 'Next'} snapshot"${stepLaneFrame(sel, d, n) === sel ? ' disabled' : ''}>${d < 0 ? '‹' : '›'}</button>`;
  return `<div class="lane-nav">${step(-1)}<div class="seg" role="group" aria-label="Snapshot time">${seg}</div>${step(1)}</div>`;
}

/**
 * The section's body: the frame picker, the three frames (only frame `sel` on show) and a key line (who is
 * highlighted, the wind's source; the rings' legend when a boat was over early). `ppu`: css px per view unit
 * as measured (default: the frame at LANE_DEFAULT_W_PX).
 */
export function laneSnapshotsHtml(a: RaceAnalysis, L: LaneSnapshots, groupText?: string, sel = 0, ppu = lanePxPerUnit(L.view)): string {
  const me = L.me != null ? a.boats.find((b) => b.id === L.me) : undefined;
  const key = [me ? `${me.sail} highlighted${groupText ? `, with ${groupText}` : ''}; the rest faded.` : 'Pick a boat to highlight it and its group.', L.note];
  const anyOver = L.frames.some((f) => f.boats.some((b) => b.over));
  const on = stepLaneFrame(sel, 0, L.frames.length);
  return `${laneNavHtml(L, on)}<div class="lane-frames">${L.frames.map((f, i) => frameHtml(a, L, f, i === on, ppu)).join('')}</div><p class="lane-key muted">${key.map(esc).join(' ')}${anyOver ? ringLegend() : ''}</p>`;
}

/** The Coach group, as the key line names it. */
const GROUP_TEXT: Record<Group['kind'], string> = { leaders: 'the top 3 (Coach group)', near: 'the boats near it (Coach group)', fleet: 'the whole fleet', custom: 'its Coach group' };

export interface LaneState {
  a: RaceAnalysis | null;
  me: string | null;
  group: Group;
}

/**
 * Wire the `<details>` section `root` (its body: `.lane-body`): drawn when opened and on `refresh()` while
 * open and `shown()` (its tab on screen), from `state()`; the over-early facts from `replaysOf` (the worker),
 * asked once per analysis. The frame on show (+1:00 at first) is kept across redraws for the session; picking
 * one (its button, ‹ ›, or ← → with focus in the section) repaints from the last drawing, with no new work.
 */
export function mountLaneSnapshots(
  root: HTMLDetailsElement,
  state: () => LaneState,
  replaysOf: (a: RaceAnalysis) => Promise<StartReplay[] | null>,
  shown: () => boolean = () => true,
): { refresh: () => void; frame: () => number } {
  const body = root.querySelector<HTMLElement>('.lane-body')!;
  const asked = new WeakMap<RaceAnalysis, StartReplay[] | null>();
  let frame = 0;
  let last: { a: RaceAnalysis; L: LaneSnapshots; groupText?: string } | null = null;
  /** The map's measured css px per unit (null: not measured yet: the default width). */
  let ppu: number | null = null;
  const paint = (): void => {
    if (last) body.innerHTML = laneSnapshotsHtml(last.a, last.L, last.groupText, frame, ppu ?? lanePxPerUnit(last.L.view));
  };
  /** Measure the map on show; a scale off by over 2% from the one drawn: repaint (text, dots stay their css px). */
  const fit = (): void => {
    if (!last) return;
    const svg = body.querySelector?.<SVGSVGElement>('.lane-frame:not([hidden]) svg.lane-svg');
    if (!svg?.clientWidth || !svg.clientHeight) return;
    const now = lanePxPerUnit(last.L.view, svg.clientWidth, svg.clientHeight);
    const drawn = ppu ?? lanePxPerUnit(last.L.view);
    ppu = now;
    if (Math.abs(now - drawn) > 0.02 * drawn) paint();
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(body);
  const draw = (): void => {
    if (!root.open || !shown()) return;
    const { a, me, group } = state();
    if (!a) {
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
    const L = laneSnapshots(a, { me: id, group: id ? groupIds(a.boats, id, group) : [], replays: asked.get(a) ?? null });
    // A new view (another race): its scale is measured afresh.
    if (last?.L.view.x0 !== L.view.x0 || last.L.view.x1 !== L.view.x1 || last.L.view.y0 !== L.view.y0 || last.L.view.y1 !== L.view.y1) ppu = null;
    last = { a, L, groupText: id ? GROUP_TEXT[group.kind] : undefined };
    paint();
    fit();
  };
  /** Show frame `i`; focus goes back to the control that was used (its button is redrawn), else the frame's button. */
  const pick = (i: number, focus?: string): void => {
    if (!last) return;
    const next = stepLaneFrame(i, 0, last.L.frames.length);
    if (next === frame) return;
    frame = next;
    paint();
    if (focus) {
      const el = body.querySelector?.<HTMLButtonElement>(focus);
      (el && !el.disabled ? el : body.querySelector?.<HTMLElement>(`[data-lane-frame="${frame}"]`))?.focus();
    }
  };
  root.addEventListener('toggle', draw);
  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest?.<HTMLElement>('[data-lane-frame], [data-lane-step]');
    if (!el) return;
    if (el.dataset.laneFrame != null) pick(Number(el.dataset.laneFrame), `[data-lane-frame="${el.dataset.laneFrame}"]`);
    else pick(frame + Number(el.dataset.laneStep), `[data-lane-step="${el.dataset.laneStep}"]`);
  });
  root.addEventListener('keydown', (ev) => {
    const d = laneKeyStep(ev.key);
    if (!d || !last || !root.open) return;
    ev.preventDefault();
    // From a picker button (redrawn): focus the new frame's button; from the summary, focus stays put.
    const inBody = (ev.target as HTMLElement).closest?.('.lane-body') != null;
    pick(frame + d, inBody ? `[data-lane-frame="${stepLaneFrame(frame, d, last.L.frames.length)}"]` : undefined);
  });
  return { refresh: draw, frame: () => frame };
}
