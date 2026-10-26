/**
 * Paints the boats' fading trails (charts.ts scrubFrame `trails`) into the track map's `g.scrub-trails` every frame
 * without rebuilding it: one `<g>` per boat (its color, class and width) holding one `<path>` per fade slice (its
 * opacity, ui/trail.ts TRAIL_FADE), created once and kept while the boat has a trail; a frame only sets the `d` (and
 * any attribute) that changed, and re-appends the groups only when their order changes (the selected boat on top).
 * The map's full redraw replaces the layer, and with it this state.
 */
import type { BoatTrail } from './charts';
import { TRAIL_FADE } from './trail';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface Slot {
  g: Element;
  paths: Element[];
  /** What its group's attributes were last set from, and each path's `d`. */
  attrs: string;
  d: string[];
}

interface LayerState {
  slots: Map<string, Slot>;
  order: string;
}

const states = new WeakMap<Element, LayerState>();

/** What paintTrails did to the DOM (tests: a frame of a steady fleet creates nothing). */
export interface TrailPaint {
  created: number;
  removed: number;
  dSet: number;
}

/** A slice's path in group `g`, at its fade opacity. */
function path(g: Element, op: number): Element {
  const p = g.ownerDocument.createElementNS(SVG_NS, 'path');
  p.setAttribute('stroke-opacity', String(op));
  g.appendChild(p);
  return p;
}

/** Set `layer`'s trails to `trails` (in drawing order), reusing each boat's group and paths. */
export function paintTrails(layer: Element, trails: readonly BoatTrail[]): TrailPaint {
  let st = states.get(layer);
  if (!st) states.set(layer, (st = { slots: new Map(), order: '' }));
  const doc = layer.ownerDocument;
  const done: TrailPaint = { created: 0, removed: 0, dSet: 0 };
  const seen = new Set<string>();
  for (const tr of trails) {
    seen.add(tr.id);
    let s = st.slots.get(tr.id);
    if (!s) {
      const g = doc.createElementNS(SVG_NS, 'g');
      const paths = TRAIL_FADE.map((op) => path(g, op));
      st.slots.set(tr.id, (s = { g, paths, attrs: '', d: paths.map(() => '') }));
      done.created++;
    }
    const attrs = `${tr.cls}|${tr.stroke}|${tr.cd ?? ''}|${tr.w}`;
    if (attrs !== s.attrs) {
      s.attrs = attrs;
      s.g.setAttribute('class', tr.cls);
      s.g.setAttribute('stroke', tr.stroke);
      s.g.setAttribute('stroke-width', String(tr.w));
      if (tr.cd) s.g.setAttribute('style', `--cd:${tr.cd}`);
      else s.g.removeAttribute('style');
    }
    for (let i = 0; i < s.paths.length; i++) {
      const d = tr.d[i] ?? '';
      if (d === s.d[i]) continue;
      s.d[i] = d;
      s.paths[i].setAttribute('d', d);
      done.dSet++;
    }
  }
  for (const [id, s] of st.slots) {
    if (seen.has(id)) continue;
    s.g.remove();
    st.slots.delete(id);
    done.removed++;
  }
  const order = trails.map((t) => t.id).join('\n');
  if (order !== st.order) {
    st.order = order;
    for (const tr of trails) layer.appendChild(st.slots.get(tr.id)!.g);
  }
  return done;
}
