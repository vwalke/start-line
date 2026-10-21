/**
 * The Start tab's "Lane snapshots": a collapsed section under the start chart that, once opened, draws
 * ui/laneSnapshots.ts's three frames side by side (stacked on a phone). Thin: SVG strings from the frames,
 * and the section's wiring (worked out only while open; the over-early facts asked of the worker once per race).
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

/** A frame is drawn about this wide, css px: strokes and text are sized for it (the SVG scales). */
const FRAME_PX = 300;

const xy = (p: Vec): string => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/** The line and its ends. */
function lineSvg(L: LaneSnapshots, u: number): string {
  const [p, r] = L.line;
  const line = `<line class="startline" x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${r[0].toFixed(1)}" y2="${r[1].toFixed(1)}" stroke-width="${(2.2 * u).toFixed(2)}"/>`;
  const ends = `<circle class="lane-pin" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(3.2 * u).toFixed(2)}" stroke-width="${(0.8 * u).toFixed(2)}"/><rect class="lane-rc" x="${(r[0] - 3 * u).toFixed(1)}" y="${(r[1] - 3 * u).toFixed(1)}" width="${(6 * u).toFixed(2)}" height="${(6 * u).toFixed(2)}"/>`;
  return line + ends;
}

/** The true-wind arrow in the top-right corner (the room laneView keeps), pointing downwind, its label to its left; dashed when assumed. */
function windSvg(L: LaneSnapshots, u: number): string {
  if (!L.wind) return '';
  const v = L.view;
  const d = L.wind.down;
  const c: Vec = [v.x1 - 24 * u, v.y0 + 24 * u];
  const tail: Vec = [c[0] - d[0] * 15 * u, c[1] - d[1] * 15 * u];
  const head: Vec = [c[0] + d[0] * 15 * u, c[1] + d[1] * 15 * u];
  const n: Vec = [-d[1], d[0]];
  const a1: Vec = [head[0] - d[0] * 7 * u + n[0] * 4 * u, head[1] - d[1] * 7 * u + n[1] * 4 * u];
  const a2: Vec = [head[0] - d[0] * 7 * u - n[0] * 4 * u, head[1] - d[1] * 7 * u - n[1] * 4 * u];
  return (
    `<g class="lane-wind${L.wind.assumed ? ' assumed' : ''}"><title>${esc(L.wind.title)}</title>` +
    `<line x1="${tail[0].toFixed(1)}" y1="${tail[1].toFixed(1)}" x2="${head[0].toFixed(1)}" y2="${head[1].toFixed(1)}" stroke-width="${(1.8 * u).toFixed(2)}"${L.wind.assumed ? ` stroke-dasharray="${(3 * u).toFixed(2)} ${(2 * u).toFixed(2)}"` : ''}/>` +
    `<polygon points="${xy(head)} ${xy(a1)} ${xy(a2)}"/>` +
    `<text x="${(c[0] - 20 * u).toFixed(1)}" y="${(c[1] + 3.5 * u).toFixed(1)}" font-size="${(10 * u).toFixed(2)}" stroke-width="${(2.5 * u).toFixed(2)}" text-anchor="end">${esc(L.wind.label)}</text></g>`
  );
}

/** Dot radius, css px (× unit). */
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
    const fs = (b.role === 'me' ? 11 : 9.5) * u;
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

/** The over-early ring around a dot of radius `r` (solid while over, dashed once cleared); the key's swatches use it too. */
const ringSvg = (over: 'over' | 'cleared', cx: string, cy: string, r: number, u: number): string =>
  `<circle class="lane-${over}" cx="${cx}" cy="${cy}" r="${(r + 2.5 * u).toFixed(2)}" stroke-width="${(1.3 * u).toFixed(2)}"${over === 'over' ? '' : ` stroke-dasharray="${(2.5 * u).toFixed(2)} ${(2 * u).toFixed(2)}"`}/>`;

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
  const sw = (b.role === 'me' ? 2.4 : b.role === 'group' ? 1.6 : 1.1) * u;
  const trail = b.trail
    .map((seg) => `<polyline class="lane-trail ${cls}" points="${seg.map(xy).join(' ')}" stroke="${faded ? 'var(--ink-3)' : colour}" stroke-width="${sw.toFixed(2)}"/>`)
    .join('');
  if (!b.pos) return { trail, dot: '', flag: '' };
  const [x, y] = [b.pos[0].toFixed(1), b.pos[1].toFixed(1)];
  const r = dotR(b) * u;
  const fill = b.hold ? `fill="var(--surface)" stroke="${faded ? 'var(--ink-3)' : colour}"` : `fill="${faded ? 'var(--ink-3)' : colour}"`;
  const state = b.over === 'over' ? ', over early (OCS)' : b.over === 'cleared' ? `, over early (OCS), cleared ${plusS(b.clearedMs!, gun)}` : '';
  const ring = b.over ? ringSvg(b.over, x, y, r, u) : '';
  const text = label
    ? `<text class="lane-lbl${b.role === 'me' ? ' on' : ''}" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" font-size="${label.fs.toFixed(2)}" stroke-width="${(2.5 * u).toFixed(2)}">${esc(b.sail)}</text>`
    : '';
  const dot = `<g class="lane-boat ${cls}" data-id="${esc(b.id)}"><title>${esc(b.sail)}${b.hold ? ' (last fix, in a gap)' : ''}${state}</title><circle class="lane-dot${b.hold ? ' hold' : ''}" cx="${x}" cy="${y}" r="${r.toFixed(2)}" ${fill} stroke-width="${(1 * u).toFixed(2)}"/>${text}</g>`;
  // Over / cleared: never faded with the boat.
  return { trail, dot, flag: ring };
}

/** One frame: its SVG (shared view) and caption. */
function frameHtml(a: RaceAnalysis, L: LaneSnapshots, f: LaneFrame): string {
  const v = L.view;
  const w = v.x1 - v.x0;
  const h = v.y1 - v.y0;
  const u = Math.max(w, h) / FRAME_PX;
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
    `<svg class="chart lane-svg" viewBox="${v.x0.toFixed(1)} ${v.y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" role="img" aria-label="${esc(f.label)}">` +
    `<title>${esc(f.label)}</title>${lineSvg(L, u)}${windSvg(L, u)}` +
    `<g class="lane-trails">${drawn.map((d) => d.trail).join('')}</g><g class="lane-dots">${drawn.map((d) => d.dot).join('')}</g><g class="lane-flags">${drawn.map((d) => d.flag).join('')}</g>${empty}</svg>`;
  return `<figure class="lane-frame${f.empty ? ' empty' : ''}" data-s="${f.s}"><figcaption><b>${esc(f.title)}</b> <span class="lane-cap">${esc(f.caption)}</span></figcaption>${svg}</figure>`;
}

/** The section's body: the three frames and a key line (who is highlighted, the wind's source; the rings' legend when a boat was over early). */
export function laneSnapshotsHtml(a: RaceAnalysis, L: LaneSnapshots, groupText?: string): string {
  const me = L.me != null ? a.boats.find((b) => b.id === L.me) : undefined;
  const key = [me ? `${me.sail} highlighted${groupText ? `, with ${groupText}` : ''}; the rest faded.` : 'Pick a boat to highlight it and its group.', L.note];
  const anyOver = L.frames.some((f) => f.boats.some((b) => b.over));
  return `<div class="lane-frames">${L.frames.map((f) => frameHtml(a, L, f)).join('')}</div><p class="lane-key muted">${key.map(esc).join(' ')}${anyOver ? ringLegend() : ''}</p>`;
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
 * open, from `state()`; the over-early facts from `replaysOf` (the worker), asked once per analysis.
 */
export function mountLaneSnapshots(root: HTMLDetailsElement, state: () => LaneState, replaysOf: (a: RaceAnalysis) => Promise<StartReplay[] | null>): { refresh: () => void } {
  const body = root.querySelector<HTMLElement>('.lane-body')!;
  const asked = new WeakMap<RaceAnalysis, StartReplay[] | null>();
  const draw = (): void => {
    if (!root.open) return;
    const { a, me, group } = state();
    if (!a) {
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
    body.innerHTML = laneSnapshotsHtml(a, L, id ? GROUP_TEXT[group.kind] : undefined);
  };
  root.addEventListener('toggle', draw);
  return { refresh: draw };
}
