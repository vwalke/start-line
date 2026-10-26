/**
 * How a boat over early is drawn, one way for the track map's "Replay start" (Map C) and the Start tab's
 * "Start Playback" view: its track over the line (warning red, on a surface casing) and its dip back (red
 * dashed), each up to the moment shown and within the trail, cut at the facts' times (ui/replay.ts replaySpans,
 * from analysis/startReplay.ts); a hollow red ring where it went back and a red
 * dot where it recrossed (cleared), once reached. Pure: the stretches, and their SVG at either view's sizes.
 */
import type { Vec } from '../analysis/geo';
import type { StartReplay } from '../analysis/startReplay';
import { boatAt, rotTrack, timeRange, type LegRange } from './mapPieces';
import { replaySpans } from './replay';

/** What of an over-early start is drawn at one moment, map coordinates. */
export interface OcsStretch {
  /** Over the line: polylines. */
  over: Vec[][];
  /** Going back (the dip, back → recrossed): polylines. */
  dip: Vec[][];
  /** Where it went back / recrossed, once reached within the trail; else null. */
  back: Vec | null;
  clear: Vec | null;
}

/**
 * Over-early start `r` as drawn at time `now` with the trail `win` ([from, to], ms): boat `r.boat`'s track
 * (`ranges`, its leg ranges in time order, as the view draws them) over each span, its ends at
 * the span's times (the scrubber's position there), the fixes between.
 */
export function ocsStretch(r: StartReplay, ranges: readonly LegRange[], twd: number, now: number, win: [number, number]): OcsStretch {
  const at = (t: number): Vec | null => {
    const b = boatAt(r.boat, ranges, t, twd);
    return b && !b.hold ? [b.mx, b.my] : null;
  };
  const stretch = (span: [number, number] | null): Vec[][] => {
    if (!span) return [];
    const from = Math.max(span[0], win[0]);
    const to = Math.min(span[1], now, win[1]);
    if (!(to > from)) return [];
    const pts: { t: number; p: Vec }[] = [];
    const push = (p: Vec | null, t: number): void => {
      if (p && (!pts.length || t > pts[pts.length - 1].t)) pts.push({ t, p });
    };
    push(at(from), from);
    for (const g of ranges) {
      const rot = rotTrack(twd, g.src);
      const [i0, i1] = timeRange(g.src.t, from, to, g.lo, g.hi);
      for (let i = i0; i < i1; i++) if (g.src.t[i] > from && g.src.t[i] < to) push([rot.x[i], rot.y[i]], g.src.t[i]);
    }
    push(at(to), to);
    return pts.length > 1 ? [pts.map((q) => q.p)] : [];
  };
  const mark = (t: number | null): Vec | null => (t == null || t > now || t < win[0] ? null : at(t));
  const { over, dip } = replaySpans(r);
  return { over: stretch(over), dip: stretch(dip), back: mark(r.wentBackMs), clear: mark(r.clearedMs) };
}

/** Sizes: `unit` map units per css px; strokes in map units (× `unit`), or with `nonScaling` in css px (vector-effect). */
export interface OcsSize {
  unit: number;
  nonScaling?: boolean;
}

const pts = (ps: readonly Vec[]): string => ps.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** The stretch's SVG: `tracks` (over the boat's own track) and `marks` (over the boats), classed `ocs-*` (style.css). */
export function ocsSvg(s: OcsStretch, size: OcsSize): { tracks: string; marks: string } {
  const k = size.nonScaling ? 1 : size.unit;
  const ns = size.nonScaling ? ' vector-effect="non-scaling-stroke"' : '';
  const sw = (w: number): string => `stroke-width="${(w * k).toFixed(2)}"${ns}`;
  let tracks = '';
  for (const run of s.over) tracks += `<polyline class="ocs-case" points="${pts(run)}" ${sw(5.4)}/><polyline class="ocs-over" points="${pts(run)}" ${sw(3.2)}/>`;
  const dash = `stroke-dasharray="${(5 * k).toFixed(2)} ${(3.5 * k).toFixed(2)}"`;
  for (const run of s.dip) tracks += `<polyline class="ocs-case" points="${pts(run)}" ${sw(4.6)}/><polyline class="ocs-dip" points="${pts(run)}" ${sw(2.4)} ${dash}/>`;
  const mark = (cls: string, p: Vec | null): string =>
    p ? `<circle class="ocs-mark ${cls}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(4.2 * size.unit).toFixed(2)}" ${sw(1.8)}/>` : '';
  return { tracks, marks: mark('back', s.back) + mark('clear', s.clear) };
}

/**
 * The key's legend for it (aria-hidden swatches drawn as the maps draw them, in the swatch's own units): over the
 * line, going back, went back, recrossed.
 */
export function ocsLegend(): string {
  const sw = (body: string): string => `<svg class="ocs-swatch" viewBox="0 0 20 12" width="20" height="12" aria-hidden="true" focusable="false">${body}</svg>`;
  const line = (cls: string, w: number, dash = ''): string =>
    `<polyline class="ocs-case" points="2,6 18,6" stroke-width="${(w + 2.2).toFixed(1)}"/><polyline class="${cls}" points="2,6 18,6" stroke-width="${w}"${dash}/>`;
  const item = (svg: string, text: string): string => `<span class="ocs-legend-item">${sw(svg)}${text}</span>`;
  return (
    `<span class="ocs-legend">` +
    item(line('ocs-over', 3.2), 'Over early') +
    item(line('ocs-dip', 2.4, ' stroke-dasharray="5 3.5"'), 'Going back') +
    item('<circle class="ocs-mark back" cx="10" cy="6" r="4" stroke-width="1.8"/>', 'Back') +
    item('<circle class="ocs-mark clear" cx="10" cy="6" r="4" stroke-width="1.8"/>', 'Cleared') +
    `</span>`
  );
}
