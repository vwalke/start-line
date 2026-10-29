/**
 * Ladder rungs on the track map's scrubber (Map B): on a beat or a run, a thin line square to that leg's wind
 * through the race leader (coach/progress.ts progressAt: the boat furthest along the course), and one through the
 * selected boat, labelled with how far it is behind the leader up (or down) the wind. Each rung lies on its own
 * boat's leg's wind; the distance is only given when both boats are on the same leg.
 *
 * - The wind on a leg: Recall's estimate for that beat (WindInfo.estimates), else the wind (wind.ts makeTwdAt)
 *   at the middle of the fleet's time on the leg. One wind per leg, so the rungs don't swing within a leg.
 * - None before the gun, on a reach, once the boat has finished, or held at its last fix past the end of its track.
 * - A rung spans the course (the marks and lines, padded), never the whole plane.
 *
 * The geometry and the choice of rungs are pure (tests); paintRungs keeps one line and one label per rung in the
 * map's `g.scrub-rungs`, setting only the attributes that change.
 */
import { bearingVec, dot, median, type Vec } from '../analysis/geo';
import { PRE_LEG, type LegKind, type RaceAnalysis } from '../analysis/types';
import { makeTwdAt, windPoints } from '../analysis/wind';
import type { ClassDims } from '../data/classes';
import { rotator } from './mapPieces';
import type { Box } from './view';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A leg's wind in map coordinates: `up` (unit) points into the wind, `across` (unit) along the rungs. */
export interface RungAxis {
  kind: Exclude<LegKind, 'reach'>;
  twdDeg: number;
  up: Vec;
  across: Vec;
}

/** The axis of a leg of kind `kind` with wind `twdDeg`, on a map drawn with `mapTwdDeg` at the top; null on a reach. */
export function rungAxis(kind: LegKind, twdDeg: number, mapTwdDeg: number): RungAxis | null {
  if (kind === 'reach' || !Number.isFinite(twdDeg)) return null;
  const rot = rotator(mapTwdDeg);
  const up = rot(bearingVec(twdDeg));
  return { kind, twdDeg, up, across: [-up[1], up[0]] };
}

/** The middle of the fleet's time on leg `li` (the median of the boats' leg mid-times), ms; null when nobody sailed it. */
function legMidMs(a: Pick<RaceAnalysis, 'boats'>, li: number): number | null {
  const mids = a.boats.map((b) => b.legs[li]).flatMap((l) => (l ? [(l.startMs + l.endMs) / 2] : []));
  return mids.length ? median(mids) : null;
}

const axesCache = new WeakMap<RaceAnalysis, (RungAxis | null)[]>();

/** Each leg's rung axis (null on a reach), worked out once per race. */
export function legAxes(a: RaceAnalysis): (RungAxis | null)[] {
  let axes = axesCache.get(a);
  if (axes) return axes;
  const twdAt = makeTwdAt(windPoints(a.wind), a.wind.twdAtGunDeg);
  axes = a.legs.map((leg, li) => {
    const est = a.wind.estimates.find((e) => e.legIndex === li);
    const twd = est ? est.twdDeg : twdAt(legMidMs(a, li) ?? a.meta.gunMs);
    return rungAxis(leg.kind, twd, a.wind.twdAtGunDeg);
  });
  axesCache.set(a, axes);
  return axes;
}

/** The course's box is padded by this share of its size each way… */
export const RUNG_PAD = 0.15;
/** …and at least this much, m. */
export const RUNG_PAD_M = 60;

/** The course's box in map coordinates: the marks, the start and finish lines and the leg ends, padded (RUNG_PAD). */
export function courseBox(pts: readonly Vec[]): Box | null {
  if (!pts.length) return null;
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of pts) [box.x0, box.y0, box.x1, box.y1] = [Math.min(box.x0, x), Math.min(box.y0, y), Math.max(box.x1, x), Math.max(box.y1, y)];
  const pad = Math.max(RUNG_PAD_M, RUNG_PAD * Math.max(box.x1 - box.x0, box.y1 - box.y0));
  return { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
}

const boxCache = new WeakMap<RaceAnalysis, Box | null>();

/** The race's course box (courseBox), worked out once per race. */
export function raceCourseBox(a: RaceAnalysis): Box | null {
  if (boxCache.has(a)) return boxCache.get(a)!;
  const rot = rotator(a.wind.twdAtGunDeg);
  const fl = a.finishLine;
  const pts = [a.line.left, a.line.right, ...(fl ? [fl.left, fl.right] : []), ...a.marks.flatMap((m) => m.xy), ...(a.legPts ?? [])].map(rot);
  const box = courseBox(pts);
  boxCache.set(a, box);
  return box;
}

/**
 * The part of the line through `p` along `dir` inside `box` (grown to hold `p` and `pad` round it, so a boat
 * outside the course still gets its rung), ends in order along `dir`; null for a zero direction.
 */
export function rungSegment(p: Vec, dir: Vec, box: Box, pad = 0): [Vec, Vec] | null {
  const b = { x0: Math.min(box.x0, p[0] - pad), y0: Math.min(box.y0, p[1] - pad), x1: Math.max(box.x1, p[0] + pad), y1: Math.max(box.y1, p[1] + pad) };
  return clipLine(p, dir, b, -Infinity, Infinity);
}

/** Liang–Barsky: the part of p + s·dir (s in [s0, s1]) inside `box`; null when none, or for a zero direction. */
export function clipLine(p: Vec, dir: Vec, box: Box, s0 = -Infinity, s1 = Infinity): [Vec, Vec] | null {
  if (!(Math.hypot(dir[0], dir[1]) > 0)) return null;
  let lo = s0;
  let hi = s1;
  const sides: [number, number][] = [
    [-dir[0], p[0] - box.x0],
    [dir[0], box.x1 - p[0]],
    [-dir[1], p[1] - box.y0],
    [dir[1], box.y1 - p[1]],
  ];
  for (const [q, r] of sides) {
    if (q === 0) {
      if (r < 0) return null;
      continue;
    }
    const s = r / q;
    if (q < 0) lo = Math.max(lo, s);
    else hi = Math.min(hi, s);
  }
  if (!(lo <= hi) || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [
    [p[0] + lo * dir[0], p[1] + lo * dir[1]],
    [p[0] + hi * dir[0], p[1] + hi * dir[1]],
  ];
}

/**
 * How far `p` is behind `leader` along the leg's wind, m (map units are metres): + = behind (downwind of the
 * leader on a beat, upwind of it on a run), − = ahead.
 */
export function ladderBehindM(p: Vec, leader: Vec, axis: Pick<RungAxis, 'kind' | 'up'>): number {
  const d = dot([leader[0] - p[0], leader[1] - p[1]], axis.up);
  return axis.kind === 'upwind' ? d : -d;
}

/** The leader among fleet places (coach/progress.ts progressAt `byId`): the boat in first place; null with none. */
export function leaderOf(byId: ReadonlyMap<string, { place: number }>): string | null {
  for (const [id, r] of byId) if (r.place === 1) return id;
  return null;
}

/** A boat as the rungs need it (charts.ts BoatAt). */
export interface RungBoat {
  id: string;
  leg: number;
  mx: number;
  my: number;
  hold: boolean;
}

export interface Rung {
  role: 'leader' | 'sel';
  id: string;
  leg: number;
  axis: RungAxis;
  at: Vec;
  /** The selected boat's distance behind the leader along the wind, m; null when it isn't a fair comparison. */
  behindM: number | null;
}

/** What decides the rungs at one moment. */
export interface RungInput {
  t: number;
  boats: readonly RungBoat[];
  /** The race leader now; null while not known. */
  leader: string | null;
  selected: string | null;
  axes: readonly (RungAxis | null)[];
  /** When each boat finished (absent or null: not finished). */
  finishMs: ReadonlyMap<string, number | null>;
  /** The competitors (a selected boat not racing gets no rung). */
  racing: ReadonlySet<string>;
}

/** Boat `b`'s rung axis now, or null: before the gun, on a reach, finished, or held at its last fix. */
export function rungAxisFor(b: RungBoat, t: number, axes: readonly (RungAxis | null)[], finishMs: number | null | undefined): RungAxis | null {
  if (b.leg === PRE_LEG || b.hold) return null;
  if (finishMs != null && t >= finishMs) return null;
  return axes[b.leg] ?? null;
}

/** The rungs at a moment: the leader's, then the selected boat's (when it isn't the leader); none until the leader is known. */
export function rungsAt(o: RungInput): Rung[] {
  if (o.leader == null) return [];
  const byId = new Map(o.boats.map((b) => [b.id, b]));
  const out: Rung[] = [];
  const of = (role: Rung['role'], id: string): Rung | null => {
    const b = byId.get(id);
    const axis = b && rungAxisFor(b, o.t, o.axes, o.finishMs.get(id));
    return b && axis ? { role, id, leg: b.leg, axis, at: [b.mx, b.my], behindM: null } : null;
  };
  const lead = of('leader', o.leader);
  if (lead) out.push(lead);
  if (o.selected != null && o.selected !== o.leader && o.racing.has(o.selected)) {
    const sel = of('sel', o.selected);
    if (sel) {
      if (lead && lead.leg === sel.leg) sel.behindM = ladderBehindM(sel.at, lead.at, sel.axis);
      out.push(sel);
    }
  }
  return out;
}

/** Closer than this, m (or this share of a boat length), the selected boat reads as level with the leader. */
const LEVEL_M = 1;
const LEVEL_LENGTHS = 0.5;

/** "120 m behind", "6 lengths behind", "1 length ahead", "level"; in lengths when the class's length is known. */
export function ladderText(behindM: number, dims: Pick<ClassDims, 'loaM'> | null): string {
  const side = behindM >= 0 ? 'behind' : 'ahead';
  const m = Math.abs(behindM);
  if (dims && dims.loaM > 0) {
    const n = m / dims.loaM;
    if (n < LEVEL_LENGTHS) return 'level';
    const r = n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
    return `${r} ${r === 1 ? 'length' : 'lengths'} ${side}`;
  }
  if (m < LEVEL_M) return 'level';
  return `${Math.round(m).toLocaleString('en-US')} m ${side}`;
}

/** A rung's label: "Leader", or the selected boat's sail number and, when it compares, its distance ("USA 11 · 120 m behind"). */
export function rungLabel(r: Pick<Rung, 'role' | 'behindM'>, sail: string, dims: Pick<ClassDims, 'loaM'> | null): string {
  if (r.role === 'leader') return 'Leader';
  return r.behindM == null ? sail : `${sail} · ${ladderText(r.behindM, dims)}`;
}

// ---- drawing ------------------------------------------------------------------

/** One rung as drawn, map units: its line, and its label (none when the rung is out of view). */
export interface RungDraw {
  role: Rung['role'];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  dash: string;
  label: { x: number; y: number; anchor: 'start' | 'end'; text: string; fs: number; sw: number } | null;
}

/** Map scale (charts.ts mapScale): the window shown, map units per screen unit and the stroke/font scale. */
export interface RungScale {
  box: Box;
  unit: number;
  k: number;
}

/**
 * The rungs as drawn in view `sc.box`: each line across the course box; its label just above it, inside the view,
 * at the right-hand end for the leader and the left-hand end for the selected boat (so the two never sit on top
 * of each other).
 */
export function rungDraws(rungs: readonly Rung[], course: Box, sc: RungScale, label: (r: Rung) => string): RungDraw[] {
  const { box, unit, k } = sc;
  const out: RungDraw[] = [];
  const inset = 8 * unit;
  const view: Box = { x0: box.x0 + inset, y0: box.y0 + inset, x1: box.x1 - inset, y1: box.y1 - inset };
  for (const r of rungs) {
    // Left to right on the map.
    const dir: Vec = r.axis.across[0] < 0 ? [-r.axis.across[0], -r.axis.across[1]] : r.axis.across;
    const seg = rungSegment(r.at, dir, course, 40 * unit);
    if (!seg) continue;
    const [p, q] = seg;
    const lead = r.role === 'leader';
    const shown = view.x1 > view.x0 && view.y1 > view.y0 ? clipLine(p, dir, view, 0, Math.hypot(q[0] - p[0], q[1] - p[1])) : null;
    const fs = 10.5 * k;
    const end = shown ? (lead ? shown[1] : shown[0]) : null;
    out.push({
      role: r.role,
      x1: p[0],
      y1: p[1],
      x2: q[0],
      y2: q[1],
      w: +(1.1 * k).toFixed(2),
      dash: lead ? `${(5 * k).toFixed(2)} ${(3.5 * k).toFixed(2)}` : '',
      label: end ? { x: end[0], y: end[1] - 4 * unit, anchor: lead ? 'end' : 'start', text: label(r), fs: +fs.toFixed(2), sw: +(3 * k).toFixed(2) } : null,
    });
  }
  return out;
}

interface RungSlot {
  g: Element;
  line: Element;
  text: Element;
  /** What the line, the label's place and its text were last set from. */
  lineKey: string;
  textKey: string;
  str: string;
  shown: boolean;
}

const layers = new WeakMap<Element, Map<RungDraw['role'], RungSlot>>();

/** What paintRungs did to the DOM (tests: a steady frame creates nothing). */
export interface RungPaint {
  created: number;
  set: number;
}

const f1 = (v: number): string => v.toFixed(1);

/** Set `layer`'s rungs to `draws`, reusing one group (line and label) per role; a role not drawn is hidden, not removed. */
export function paintRungs(layer: Element, draws: readonly RungDraw[]): RungPaint {
  let slots = layers.get(layer);
  if (!slots) layers.set(layer, (slots = new Map()));
  const doc = layer.ownerDocument;
  const done: RungPaint = { created: 0, set: 0 };
  const want = new Map(draws.map((d) => [d.role, d]));
  for (const role of ['leader', 'sel'] as const) {
    const d = want.get(role);
    let s = slots.get(role);
    if (!d) {
      if (s?.shown) {
        s.g.setAttribute('display', 'none');
        s.shown = false;
        done.set++;
      }
      continue;
    }
    if (!s) {
      const g = doc.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', `rung ${role}`);
      const line = doc.createElementNS(SVG_NS, 'line');
      const text = doc.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'rung-lbl');
      g.appendChild(line);
      g.appendChild(text);
      layer.appendChild(g);
      slots.set(role, (s = { g, line, text, lineKey: '', textKey: '', str: '', shown: true }));
      done.created++;
    }
    if (!s.shown) {
      s.g.removeAttribute('display');
      s.shown = true;
      done.set++;
    }
    const lineKey = `${f1(d.x1)} ${f1(d.y1)} ${f1(d.x2)} ${f1(d.y2)} ${d.w} ${d.dash}`;
    if (lineKey !== s.lineKey) {
      s.lineKey = lineKey;
      s.line.setAttribute('x1', f1(d.x1));
      s.line.setAttribute('y1', f1(d.y1));
      s.line.setAttribute('x2', f1(d.x2));
      s.line.setAttribute('y2', f1(d.y2));
      s.line.setAttribute('stroke-width', String(d.w));
      if (d.dash) s.line.setAttribute('stroke-dasharray', d.dash);
      else s.line.removeAttribute('stroke-dasharray');
      done.set++;
    }
    const l = d.label;
    const textKey = l ? `${f1(l.x)} ${f1(l.y)} ${l.anchor} ${l.fs} ${l.sw}` : 'none';
    if (textKey !== s.textKey) {
      s.textKey = textKey;
      if (l) {
        s.text.removeAttribute('display');
        s.text.setAttribute('x', f1(l.x));
        s.text.setAttribute('y', f1(l.y));
        s.text.setAttribute('text-anchor', l.anchor);
        s.text.setAttribute('font-size', String(l.fs));
        s.text.setAttribute('stroke-width', String(l.sw));
      } else s.text.setAttribute('display', 'none');
      done.set++;
    }
    const str = l?.text ?? '';
    if (str !== s.str) {
      s.str = str;
      s.text.textContent = str;
      done.set++;
    }
  }
  return done;
}
