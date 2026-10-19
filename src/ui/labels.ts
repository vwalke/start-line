/**
 * Start chart boat names: the `Names: Auto | All | Off` preference and a
 * greedy placement that keeps labels from piling up where boats bunch.
 */
import type { Vec } from '../analysis/geo';

export type StartNames = 'auto' | 'all' | 'off';
export const START_NAMES_KEY = 'recall.startNames';
export const parseStartNames = (raw: string | null | undefined): StartNames => (raw === 'all' ? 'all' : raw === 'off' ? 'off' : 'auto');

/** "Names: Auto | All | Off" beside the start chart's Colour switch. */
export function startNamesControls(names: StartNames): string {
  const btns = (
    [
      ['auto', 'Auto'],
      ['all', 'All'],
      ['off', 'Off'],
    ] as const
  )
    .map(([v, text]) => `<button type="button" data-start-names="${v}" aria-pressed="${v === names}">${text}</button>`)
    .join('');
  return `<div class="seg" role="group" aria-label="Boat names on the start chart"><span class="seg-lbl" aria-hidden="true">Names</span>${btns}</div>`;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Rough text width in the font's units: ~0.6 em a character (sail numbers are mostly digits and capitals). */
export const textWidth = (s: string, fontSize: number): number => s.length * 0.6 * fontSize;

export interface LabelReq {
  id: string;
  /** The bow, chart units (y down). */
  at: Vec;
  /** Unit vector along the boat's heading on screen. */
  fwd: Vec;
  /** Label box size, chart units. */
  w: number;
  h: number;
  /** How far the boat's shape reaches from `at` ahead, to each side and behind, chart units. */
  reach: { ahead: number; side: number; behind: number };
}

export interface PlaceOptions {
  /** Clear water between the boat's shape and its label, chart units. */
  pad: number;
  /** Boxes already taken (end and favoured-end labels). */
  taken?: Rect[];
  /** Segments a label must not cross (the start line). */
  segments?: [Vec, Vec][];
  /** Boxes a label should rather not cover (other boats' hulls), by boat id: avoided when a candidate allows. */
  soft?: { id: string; box: Rect }[];
  /** Labels must sit wholly inside this (the visible view). */
  bounds?: Rect;
  /** false: every label at its first candidate, overlaps and all (Names: All). Default true. */
  cull?: boolean;
  /** Placed at its first in-bounds candidate even when that collides (the selected boat). */
  force?: string | null;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (a: Rect, b: Rect): boolean => a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;

/** Does segment p→q touch the rectangle? (Liang–Barsky clip.) */
export function segmentHitsRect(p: Vec, q: Vec, r: Rect): boolean {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  let t0 = 0;
  let t1 = 1;
  for (const [den, num] of [
    [-dx, p[0] - r.x0],
    [dx, r.x1 - p[0]],
    [-dy, p[1] - r.y0],
    [dy, r.y1 - p[1]],
  ]) {
    if (den === 0) {
      if (num < 0) return false;
    } else {
      const t = num / den;
      if (den < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** Candidate boxes for one label: ahead, right, left, then behind the boat, each clear of its shape by `pad`. */
export function labelCandidates(q: LabelReq, pad: number): Rect[] {
  const [fx, fy] = q.fwd;
  const right: Vec = [-fy, fx]; // clockwise on screen (y down)
  const dirs: [Vec, number][] = [
    [q.fwd, q.reach.ahead],
    [right, q.reach.side],
    [[-right[0], -right[1]], q.reach.side],
    [[-fx, -fy], q.reach.behind],
  ];
  return dirs.map(([d, reach]) => {
    // Push the box's centre out until its near edge clears the shape along d.
    const off = reach + pad + (Math.abs(d[0]) * q.w) / 2 + (Math.abs(d[1]) * q.h) / 2;
    const cx = q.at[0] + d[0] * off;
    const cy = q.at[1] + d[1] * off;
    return { x0: cx - q.w / 2, y0: cy - q.h / 2, x1: cx + q.w / 2, y1: cy + q.h / 2 };
  });
}

/**
 * Greedy placement in `reqs` order (highest priority first): each label takes
 * its first candidate that is in bounds and clear of the line and of every
 * label already placed, preferring one that also keeps off other boats; with
 * none, it's skipped (the boat keeps its hull and hover title). Returns the
 * placed boxes by id.
 */
export function placeLabels(reqs: LabelReq[], opts: PlaceOptions): Map<string, Rect> {
  const taken = [...(opts.taken ?? [])];
  const out = new Map<string, Rect>();
  for (const q of reqs) {
    const cands = labelCandidates(q, opts.pad);
    const fits = opts.bounds ? cands.filter((c) => inside(c, opts.bounds!)) : cands;
    const free = (c: Rect): boolean => !taken.some((t) => overlaps(c, t)) && !(opts.segments ?? []).some(([p, s]) => segmentHitsRect(p, s, c));
    const clear = (c: Rect): boolean => !(opts.soft ?? []).some((o) => o.id !== q.id && overlaps(c, o.box));
    const pick =
      opts.cull === false
        ? cands[0]
        : (fits.find((c) => free(c) && clear(c)) ?? fits.find(free) ?? (q.id === opts.force ? (fits[0] ?? cands[0]) : undefined));
    if (!pick) continue;
    out.set(q.id, pick);
    taken.push(pick);
  }
  return out;
}
