/**
 * The Start tab's "After the gun" section: under the start chart (open by default, collapsible; a view of its
 * own, apart from the chart), it draws ui/laneSnapshots.ts's fleet at one second from the gun to gun +3:00,
 * full width, in one fixed view. A time slider (0 … 180 s, 1 s steps), ‹ › (∓1 s), ← → (1 s; with Shift
 * LANE_SHIFT_STEP_S), Home / End and a play / pause button move it, clamped at the ends. Thin: SVG strings from
 * the frames, and the section's wiring (worked out only while open and on show, once per race and selection;
 * the over-early facts asked of the worker once per race; the second picked kept for the session; scrubbing
 * redraws just the map).
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
import { laneScrub, laneSecond, type LaneBoat, type LaneFrame, type LaneScrub } from './laneSnapshots';
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

/** The frame: its SVG (the fixed view, `ppu` css px per unit) and caption (the time and the selected boat's place), the wind badge over its corner. */
function frameHtml(a: RaceAnalysis, L: LaneScrub, f: LaneFrame, ppu: number): string {
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
  return `<figure class="lane-frame${f.empty ? ' empty' : ''}" data-s="${f.s}"><figcaption><b class="lane-time">${esc(f.title)}</b> <span class="lane-cap">${esc(f.caption)}</span></figcaption><div class="lane-map">${svg}${windBadgeHtml(L)}</div></figure>`;
}

/** Shift + ← / →: this many seconds. */
export const LANE_SHIFT_STEP_S = 10;
/** Play: one second of the race every this many ms (10× real time); it stops at the end. */
export const LANE_PLAY_MS = 100;
/** The screen-reader summary is said this long after the last change (polite; not every second while dragging). */
export const LANE_SAY_MS = 700;

/** Second `s` stepped by `d`, clamped to 0 … `end` (no wrap). */
export const stepLaneSecond = (s: number, d: number, end: number): number => laneSecond(s + d, end);

/** The second a key moves `s` to while focus is in the section (← → 1 s, with Shift LANE_SHIFT_STEP_S; Home / End: the ends), clamped; null: not ours. */
export function laneKeyTarget(key: string, shift: boolean, s: number, end: number): number | null {
  const by = shift ? LANE_SHIFT_STEP_S : 1;
  if (key === 'ArrowLeft') return stepLaneSecond(s, -by, end);
  if (key === 'ArrowRight') return stepLaneSecond(s, by, end);
  if (key === 'Home') return 0;
  if (key === 'End') return end;
  return null;
}

const PLAY_ICONS =
  '<svg class="i-play" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 2.5v11l9-5.5z"/></svg>' +
  '<svg class="i-pause" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';

/** The controls: ‹, play / pause, the slider (0 … end, 1 s; its spoken value the time), ›. `‹` is disabled at the gun, `›` at the end. */
function laneControlsHtml(L: LaneScrub, s: number, playing: boolean): string {
  const title = L.frame(s).title;
  const step = (d: -1 | 1): string =>
    `<button type="button" class="lane-step" data-lane-step="${d}" aria-label="${d < 0 ? 'Back' : 'Forward'} 1 second"${stepLaneSecond(s, d, L.end) === s ? ' disabled' : ''}>${d < 0 ? '‹' : '›'}</button>`;
  return (
    `<div class="lane-ctl">${step(-1)}` +
    `<button type="button" class="lane-play" data-lane-play aria-pressed="${playing}" aria-label="Play">${PLAY_ICONS}</button>` +
    `<input type="range" class="lane-range" min="0" max="${L.end}" step="1" value="${s}" aria-label="Seconds after the gun" aria-valuetext="${esc(title)}" aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight Home End"/>` +
    `${step(1)}</div>`
  );
}

/**
 * The section's body: the controls, the frame at second `s` (in the fixed view), a polite live region (filled by
 * the mount after scrubbing) and a key line (who is highlighted, the wind's source; the rings' legend when a boat
 * was over early). `ppu`: css px per view unit as measured (default: the frame at LANE_DEFAULT_W_PX).
 */
export function laneScrubHtml(a: RaceAnalysis, L: LaneScrub, groupText?: string, s = 0, ppu = lanePxPerUnit(L.view), playing = false): string {
  const me = L.me != null ? a.boats.find((b) => b.id === L.me) : undefined;
  const key = [me ? `${me.sail} highlighted${groupText ? `, with ${groupText}` : ''}; the rest faded.` : 'Pick a boat to highlight it and its group.', L.note];
  const on = laneSecond(s, L.end);
  return (
    `${laneControlsHtml(L, on, playing)}<div class="lane-stage">${frameHtml(a, L, L.frame(on), ppu)}</div>` +
    `<p class="lane-live" aria-live="polite"></p>` +
    `<p class="lane-key muted">${key.map(esc).join(' ')}${L.anyOver ? ringLegend() : ''}</p>`
  );
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
 * asked once per analysis. The per-second frames are worked out once per race, selection and replays (a refresh
 * with none of those changed reuses them). The second on show (the gun at first) is kept across redraws for the
 * session; the slider, ‹ ›, the keys and play move it, redrawing just the map (and the controls' state).
 */
export function mountLaneSnapshots(
  root: HTMLDetailsElement,
  state: () => LaneState,
  replaysOf: (a: RaceAnalysis) => Promise<StartReplay[] | null>,
  shown: () => boolean = () => true,
): { refresh: () => void; second: () => number; playing: () => boolean; scrub: () => LaneScrub | null } {
  const body = root.querySelector<HTMLElement>('.lane-body')!;
  const asked = new WeakMap<RaceAnalysis, StartReplay[] | null>();
  let sec = 0;
  let last: { a: RaceAnalysis; L: LaneScrub; groupText?: string; key: string; replays: StartReplay[] | null } | null = null;
  /** The map's measured css px per unit (null: not measured yet: the default width). */
  let ppu: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let say: ReturnType<typeof setTimeout> | null = null;
  const q = <T extends Element>(sel: string): T | null => body.querySelector?.<T>(sel) ?? null;
  const paint = (): void => {
    if (last) body.innerHTML = laneScrubHtml(last.a, last.L, last.groupText, sec, ppu ?? lanePxPerUnit(last.L.view), timer != null);
  };
  /** Measure the map on show; a scale off by over 2% from the one drawn: repaint (text, dots stay their css px). */
  const fit = (): void => {
    if (!last) return;
    const svg = q<SVGSVGElement>('.lane-frame svg.lane-svg');
    if (!svg?.clientWidth || !svg.clientHeight) return;
    const now = lanePxPerUnit(last.L.view, svg.clientWidth, svg.clientHeight);
    const drawn = ppu ?? lanePxPerUnit(last.L.view);
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
  /** The frame at the second on show: just the map, the slider and the ‹ › state (a full paint when the body isn't ours yet). */
  const show = (): void => {
    if (!last) return;
    const stage = q<HTMLElement>('.lane-stage');
    if (!stage) return paint();
    const f = last.L.frame(sec);
    stage.innerHTML = frameHtml(last.a, last.L, f, ppu ?? lanePxPerUnit(last.L.view));
    const range = q<HTMLInputElement>('.lane-range');
    if (range) {
      range.value = String(sec);
      range.setAttribute('aria-valuetext', f.title);
    }
    for (const d of [-1, 1]) {
      const b = q<HTMLButtonElement>(`[data-lane-step="${d}"]`);
      if (!b) continue;
      const off = stepLaneSecond(sec, d, last.L.end) === sec;
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
  /** Go to second `s` (clamped); `user`: a scrub, a step or a key, which stops play. */
  const go = (s: number, user = true): void => {
    if (!last) return;
    if (user) stop();
    const next = laneSecond(s, last.L.end);
    if (next === sec) return;
    sec = next;
    show();
  };
  const play = (): void => {
    if (!last) return;
    if (timer != null) return stop();
    // From the end: start again at the gun.
    if (sec >= last.L.end) go(0, false);
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
    // A new view (another race): its scale is measured afresh.
    if (last?.L.view.x0 !== L.view.x0 || last.L.view.x1 !== L.view.x1 || last.L.view.y0 !== L.view.y0 || last.L.view.y1 !== L.view.y1) ppu = null;
    last = { a, L, groupText: id ? GROUP_TEXT[group.kind] : undefined, key, replays };
    paint();
    fit();
  };
  root.addEventListener('toggle', draw);
  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest?.<HTMLElement>('[data-lane-step], [data-lane-play]');
    if (!el || !last) return;
    if (el.dataset.laneStep != null) go(sec + Number(el.dataset.laneStep));
    else play();
  });
  root.addEventListener('input', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.classList?.contains('lane-range')) go(Number(el.value));
  });
  root.addEventListener('keydown', (ev) => {
    if (!last || !root.open) return;
    const to = laneKeyTarget(ev.key, ev.shiftKey, sec, last.L.end);
    if (to == null) return;
    // Ours, on the slider too (its own arrows would step 1 s, without Shift).
    ev.preventDefault();
    go(to);
  });
  return { refresh: draw, second: () => sec, playing: () => timer != null, scrub: () => last?.L ?? null };
}
