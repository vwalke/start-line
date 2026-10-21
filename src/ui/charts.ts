/**
 * Plain SVG graphics in local metres, rotated so the estimated wind blows
 * from the top of the page. Boats use fixed categorical colour slots by
 * sail order (≤ 8 boats); larger fleets fall back to neutral ink plus
 * direct sail-number labels.
 */
import { primaryDtlM } from '../analysis/findings';
import { add, bearingVec, scale, type Vec } from '../analysis/geo';
import { awayFromLineThresholdM, lineBias } from '../analysis/line';
import { PRE_LEG, type BoatDrawing, type BoatResult, type ExcludedBoat, type RaceAnalysis, type TrackSegment } from '../analysis/types';
import { matchClass, type ClassDims } from '../data/classes';
import { esc, f1, f2 } from './format';
import { placeLabels, textWidth, type LabelReq, type Rect, type StartNames } from './labels';
import { MAP_GAP_S, drawingGapMs, mapPoints, mapPointsOf, type MapPoints } from './mapPoints';
import { drawingPieces, rotTrack, rotator, legRanges, boatAt, timeRange, type BoatAt, type FullRateSet, type MapPiece, type PieceOptions } from './mapPieces';
import {
  addSogTrack,
  emptySogPaths,
  legRangeList,
  segmentSogRange,
  sogColor,
  sogFill,
  sogIndex,
  sogPathsSvg,
  startSogRange,
  trackSogRange,
  type IndexedTrack,
  type SogIndex,
  type SogPaths,
  type StartColour,
} from './sog';
import { casedByDay, speedColor, speedRanking, speedStyle, type RankBy, type SogScale, type SpeedTop, type TrackColour } from './speed';
import { FAV_GAP_PX, favouredTexts, lineBiasSvg } from './startLine';
import { replayLabel, replaySpans } from './replay';
import type { StartReplay } from '../analysis/startReplay';
import { clampView, fitView, viewBox, type Box, type View } from './view';

const SLOTS = 8;

/** Boats set aside as not racing are always neutral grey (colorSlot -1). */
export const NC_COLOR = 'var(--ink-3)';

export const boatColor = (b: BoatResult, fleet: number): string =>
  b.colorSlot < 0 ? NC_COLOR : fleet <= SLOTS ? `var(--s${b.colorSlot + 1})` : 'var(--ink-2)';

/** The picked boat when it is one set aside as not racing (drawn only then), else null. */
export function pickedExcluded(a: RaceAnalysis, highlight: string | null): ExcludedBoat | null {
  return (highlight != null && a.excluded.find((e) => e.result.id === highlight)) || null;
}
export const legColor = (i: number): string => `var(--s${(i % SLOTS) + 1})`;

export { rotator };

function grow(b: Box, p: Vec): void {
  b.x0 = Math.min(b.x0, p[0]);
  b.x1 = Math.max(b.x1, p[0]);
  b.y0 = Math.min(b.y0, p[1]);
  b.y1 = Math.max(b.y1, p[1]);
}

const pts = (ps: Vec[]): string => ps.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

function niceStep(span: number): number {
  const raw = span / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw) ?? raw;
}

function scaleBar(box: Box, unit: number, k: number): string {
  const step = niceStep((box.x1 - box.x0) / 1.5);
  const x = box.x0 + 8 * unit;
  const y = box.y1 - 8 * unit;
  return `<g class="scalebar"><line x1="${x}" y1="${y}" x2="${x + step}" y2="${y}" stroke-width="${2 * k}"/>
    <text x="${x + step / 2}" y="${y - 4 * unit}" font-size="${11 * k}" text-anchor="middle">${step} m</text></g>`;
}

function windArrow(box: Box, unit: number, k: number, label: string): string {
  const x = box.x1 - 14 * unit;
  const y = box.y0 + 10 * unit;
  const L = 34 * unit;
  return `<g class="wind"><line x1="${x}" y1="${y}" x2="${x}" y2="${y + L}" stroke-width="${2 * k}"/>
    <path d="M${x - 5 * unit},${y + L - 8 * unit} L${x},${y + L} L${x + 5 * unit},${y + L - 8 * unit}" fill="none" stroke-width="${2 * k}"/>
    <text x="${x - 6 * unit}" y="${y + 3 * unit}" font-size="${11 * k}" text-anchor="end">${esc(label)}</text></g>`;
}

/**
 * Stylized hull in hull coordinates: x across (±0.5 beam), y aft (bow 0,
 * transom 1). Pointed bow, fullest aft of midships, flat transom. Bow first.
 * Control points for a Catmull-Rom along each side; the transom stays straight.
 */
const HULL: Vec[] = [
  [0, 0],
  [0.12, 0.06],
  [0.24, 0.15],
  [0.36, 0.28],
  [0.45, 0.45],
  [0.5, 0.65],
  [0.49, 0.85],
  [0.46, 1],
  [-0.46, 1],
  [-0.49, 0.85],
  [-0.5, 0.65],
  [-0.45, 0.45],
  [-0.36, 0.28],
  [-0.24, 0.15],
  [-0.12, 0.06],
];

const fmt = (p: Vec): string => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;

/** Open Catmull-Rom as SVG cubics from pts[0] (already the current point) through pts[n-1]. */
function crCubics(pts: Vec[]): string {
  if (pts.length < 2) return '';
  let d = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += `C${fmt([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6])} ${fmt([
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
    ])} ${fmt(p2)}`;
  }
  return d;
}

/**
 * Smooth closed hull path: cubic spline along each side, straight transom.
 * `pts` is `hullOutline` order (bow, starboard, transom corners, port).
 */
export function hullPathD(pts: Vec[]): string {
  const t = pts.length >> 1;
  const stbd = pts.slice(0, t + 1);
  const port = [...pts.slice(t + 1), pts[0]];
  return `M${fmt(pts[0])}${crCubics(stbd)}L${fmt(pts[t + 1])}${crCubics(port)}Z`;
}

/** Hulls shorter than this on screen are drawn as the fixed-size marker instead. */
const MIN_HULL_PX = 6;

/** Hull outline in local metres: bow tip on `bow`, extending aft along `headingDeg`. */
export function hullOutline(bow: Vec, headingDeg: number, dims: ClassDims): Vec[] {
  const fwd = bearingVec(headingDeg);
  const stbd = bearingVec(headingDeg + 90);
  return HULL.map(([x, y]) => add(bow, add(scale(fwd, -y * dims.loaM), scale(stbd, x * dims.beamM))));
}

/**
 * The start chart's Fit box: the line, bows and nearby trails, padded, with room for the
 * favoured-end label. `widthPx` (the chart's width on screen) only matters below NAME_MIN_W,
 * where the text is larger: the box is then sized for a FIT_NARROW_PX phone, so it changes
 * only when the chart crosses that width, not with every resize.
 */
export function startFitBox(a: RaceAnalysis, widthPx?: number): Box {
  return startFrame(a, widthPx).box;
}

/** Whether a chart this wide gets the narrow (larger-text) layout. */
export const isNarrowStart = (widthPx?: number): boolean => widthPx != null && widthPx > 0 && widthPx < NAME_MIN_W;

/** |DTL| this large leaves a bow out of the Fit (same rule as analysis). */
function startReach(a: RaceAnalysis): number {
  const away = new Set(a.boats.filter((b) => b.start?.awayFromLine).map((b) => b.id));
  const near = a.boats.filter((b) => b.start && !away.has(b.id)).map((b) => Math.abs(b.start!.dtlM));
  const fleet = near.length >= 3 ? near : a.boats.filter((b) => b.start).map((b) => Math.abs(b.start!.dtlM));
  return awayFromLineThresholdM(fleet);
}

function perpToLine(p: Vec, L: Vec, R: Vec): number {
  const vx = R[0] - L[0];
  const vy = R[1] - L[1];
  const n = Math.hypot(vx, vy) || 1;
  return Math.abs((p[0] - L[0]) * (-vy / n) + (p[1] - L[1]) * (vx / n));
}

function startFrame(a: RaceAnalysis, widthPx?: number) {
  const { rot, L, R } = startGeom(a);
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  grow(box, L);
  grow(box, R);
  // Room for the bows and nearby trails; a boat kilometres out must not shrink everyone else.
  const mid = rot([(a.line.left[0] + a.line.right[0]) / 2, (a.line.left[1] + a.line.right[1]) / 2]);
  const away = new Set(a.boats.filter((b) => b.start?.awayFromLine).map((b) => b.id));
  const bowReach = startReach(a);
  for (const d of a.drawings) {
    if (!d.bow || away.has(d.id)) continue;
    const p = rot(d.bow);
    if (perpToLine(p, L, R) <= bowReach) grow(box, p);
  }
  const reach = Math.max(40, 0.8 * a.line.lengthM);
  for (const d of a.drawings) {
    for (let i = 0; i < d.trail.x.length; i++) {
      const p = rot([d.trail.x[i], d.trail.y[i]]);
      if (Math.hypot(p[0] - mid[0], p[1] - mid[1]) < reach) grow(box, p);
    }
  }
  const pad = Math.max(12, 0.08 * Math.max(box.x1 - box.x0, box.y1 - box.y0));
  box.x0 -= pad;
  box.x1 += pad;
  box.y0 -= pad * 1.4;
  box.y1 += pad;
  roomForFavLabel(a, L, R, box, isNarrowStart(widthPx));
  return { rot, L, R, box };
}

/** The Fit frame may grow at most this share of its width to fit the favoured-end label on its extension (more on a phone). */
const FAV_ROOM_MAX = 0.25;
const FAV_ROOM_MAX_NARROW = 0.35;
/** The phone width the narrow Fit frame is sized for (the label's text is largest there). */
const FIT_NARROW_PX = 360;

/** The label's font size in chart px (×unit), as `startSnapshot` sizes it: 85% of a boat name, larger when narrow. */
const favFs = (narrow: boolean): number => 0.85 * NAME_FS * (narrow ? NAME_MIN_W / FIT_NARROW_PX : 1);

/**
 * Grow `box` past the favoured end so the extension there holds a wording
 * with the metres at Fit: "Pin favoured 7° · 18 m"; on a narrow chart, the
 * longest of that, "Pin fav. 7° · 18 m" and "Pin 7° · 18 m" that fits within
 * the larger cap. The label's size in chart units follows the frame's width
 * (~600 css px across, as `startView`'s unit). When none fits, the box is
 * left alone and the label runs along the line instead.
 */
function roomForFavLabel(a: RaceAnalysis, L: Vec, R: Vec, box: Box, narrow: boolean): void {
  const fav = lineBias(a.line, a.wind.twdAtGunDeg).favored;
  if (fav === 'square') return;
  const [end, other] = fav === 'left' ? [L, R] : [R, L];
  const len = Math.hypot(end[0] - other[0], end[1] - other[1]);
  if (!(len > 0)) return;
  const u: Vec = [(end[0] - other[0]) / len, (end[1] - other[1]) / len];
  const withMetres = favouredTexts(a, startDims(a)).filter((t) => /· \d+ m$/.test(t));
  const fs = favFs(narrow);
  const cap = 1 + (narrow ? FAV_ROOM_MAX_NARROW : FAV_ROOM_MAX);
  const w0 = box.x1 - box.x0;
  for (const text of narrow ? withMetres : withMetres.slice(0, 1)) {
    const needPx = FAV_GAP_PX + textWidth(text, fs) + 6;
    const b = { ...box };
    // The unit grows with the box, so settle it in a few passes.
    let ok = true;
    for (let pass = 0; pass < 4 && ok; pass++) {
      const unit = (b.x1 - b.x0) / 600;
      const tip: Vec = [end[0] + u[0] * needPx * unit, end[1] + u[1] * needPx * unit];
      Object.assign(b, { x0: Math.min(b.x0, tip[0]), y0: Math.min(b.y0, tip[1]), x1: Math.max(b.x1, tip[0]), y1: Math.max(b.y1, tip[1]) });
      ok = b.x1 - b.x0 <= w0 * cap;
    }
    if (ok) {
      Object.assign(box, b);
      return;
    }
  }
}

/**
 * A start chart frame other than the inline Fit (full screen): its fit box, and the
 * screen width its unit is relative to (the unit is ~1 css px at `refPx` wide).
 */
export interface StartFrame {
  box: Box;
  refPx: number;
}

/** Full screen: margins round the line and bows, css px (names, the PIN/RC labels and the wind arrow above). */
const FULL_PAD_PX = 30;
const FULL_PAD_TOP_PX = 52;
/** Full screen: the favoured-end label may take at most this share of the width past its end. */
const FULL_FAV_MAX = 0.22;
/** Full screen in portrait: line + fleet framed this much wider than tall gets the rotate hint. */
export const ROTATE_ASPECT = 1.6;

/**
 * The start chart's full-screen Fit for a `widthPx` × `heightPx` chart: the line and the
 * bows at the gun with px margins (and room for the favoured-end label on its extension),
 * grown to the chart's own aspect so the fleet fills the width (or height). Spare height
 * always goes below the line, to the trails (the line sits near the top, under its margin
 * for names, PIN/RC and the wind arrow). Spare width is centred on line, fleet and trails. Trails
 * show only as far as they fit. The unit is ~1 css px (`refPx` is the width, at least the
 * narrow-text width), so names stay ~10 px at any size. `trails`: line, bows and the trails
 * near the line. `rotate`: portrait, and line + fleet much wider than tall (landscape would
 * draw it bigger).
 */
export function startFullFrame(a: RaceAnalysis, widthPx: number, heightPx: number): StartFrame & { core: Box; trails: Box; rotate: boolean } {
  const { rot, L, R } = startGeom(a);
  const core: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  grow(core, L);
  grow(core, R);
  const mid: Vec = [(L[0] + R[0]) / 2, (L[1] + R[1]) / 2];
  const away = new Set(a.boats.filter((b) => b.start?.awayFromLine).map((b) => b.id));
  const bowReach = startReach(a);
  for (const d of a.drawings) {
    if (!d.bow || away.has(d.id)) continue;
    const p = rot(d.bow);
    if (perpToLine(p, L, R) <= bowReach) grow(core, p);
  }
  if (!(widthPx > 0 && heightPx > 0)) return { box: startFrame(a).box, refPx: 600, core, trails: core, rotate: false };
  const refPx = Math.max(widthPx, NAME_MIN_W);
  const unitPx = widthPx / refPx;
  const trails = { ...core };
  const reach = Math.max(40, 0.8 * a.line.lengthM);
  for (const d of a.drawings) {
    for (let i = 0; i < d.trail.x.length; i++) {
      const p = rot([d.trail.x[i], d.trail.y[i]]);
      if (Math.hypot(p[0] - mid[0], p[1] - mid[1]) < reach) grow(trails, p);
    }
  }
  // The favoured-end label's length along its extension, css px (its font as `startSnapshot` sizes it).
  const fav = lineBias(a.line, a.wind.twdAtGunDeg).favored;
  // The longest wording with the metres that takes at most FULL_FAV_MAX of the width; else none (it runs along the line).
  const favFsUnits = 0.85 * NAME_FS * Math.max(1, NAME_MIN_W / widthPx);
  const favPx =
    fav === 'square'
      ? 0
      : (favouredTexts(a, startDims(a))
          .filter((t) => /· \d+ m$/.test(t))
          .map((t) => (FAV_GAP_PX + 6 + textWidth(t, favFsUnits)) * unitPx)
          .find((px) => px <= FULL_FAV_MAX * widthPx) ?? 0);
  const [end, other] = fav === 'left' ? [L, R] : [R, L];
  const len = Math.hypot(end[0] - other[0], end[1] - other[1]) || 1;
  const u: Vec = [(end[0] - other[0]) / len, (end[1] - other[1]) / len];
  const aspect = widthPx / heightPx;
  // Metres per css px; the margins and the label are in px, so settle it in a few passes.
  let mpp = Math.max(core.x1 - core.x0, 1) / Math.max(widthPx - 2 * FULL_PAD_PX, 1);
  let b: Box = core;
  let W = 0;
  let H = 0;
  for (let pass = 0; pass < 5; pass++) {
    b = { x0: core.x0 - FULL_PAD_PX * mpp, x1: core.x1 + FULL_PAD_PX * mpp, y0: core.y0 - FULL_PAD_TOP_PX * mpp, y1: core.y1 + FULL_PAD_PX * mpp };
    if (favPx) {
      const t = (favPx + 8) * mpp;
      grow(b, [end[0] + u[0] * t, end[1] + u[1] * t]);
    }
    W = b.x1 - b.x0;
    H = b.y1 - b.y0;
    if (W / H > aspect) H = W / aspect;
    else W = H * aspect;
    mpp = W / widthPx;
  }
  // The window holds `b`; across, as near the middle of line, fleet and trails as it can be. Down the
  // page, spare height always goes to the trails (downwind, below the line): the top stays at `b`'s
  // (just the top margin for names, PIN/RC and the wind arrow).
  const clamp = (c: number, lo: number, hi: number): number => Math.min(Math.max(c, lo), hi);
  const cx = clamp((Math.min(b.x0, trails.x0) + Math.max(b.x1, trails.x1)) / 2, b.x1 - W / 2, b.x0 + W / 2);
  const cy = clamp(b.y0 + H / 2, b.y1 - H / 2, b.y0 + H / 2);
  const box: Box = { x0: cx - W / 2, x1: cx + W / 2, y0: cy - H / 2, y1: cy + H / 2 };
  const rotate = heightPx > widthPx && (b.x1 - b.x0) / (b.y1 - b.y0) > ROTATE_ASPECT;
  return { box, refPx, core, trails, rotate };
}

/** The line ends in chart coordinates (wind at the top) and the rotation that put them there. */
function startGeom(a: RaceAnalysis) {
  const rot = rotator(a.wind.twdAtGunDeg);
  return { rot, L: rot(a.line.left), R: rot(a.line.right) };
}

function startView(a: RaceAnalysis, v?: View, widthPx?: number, frame?: StartFrame) {
  const { rot, L, R } = startGeom(a);
  const box = frame?.box ?? startFrame(a, widthPx).box;
  // A window onto the fit box with the same aspect.
  const vb = viewBox(box, clampView(box, v ?? fitView(box)));
  const view: Box = { x0: vb.x0, y0: vb.y0, x1: vb.x0 + vb.w, y1: vb.y0 + vb.h };
  return { rot, L, R, box, view, unit: vb.w / (frame?.refPx ?? 600) }; // unit: ~1 css px at 600 (or refPx) wide
}

/** The class the hulls are sized from: the division's boat class, then its name, then the event's class label; with the name that matched. */
export const startClass = (a: RaceAnalysis): { name: string; dims: ClassDims } | null =>
  matchClass([a.meta.boatClass, a.meta.division, a.meta.classLabel]);

const startDims = (a: RaceAnalysis): ClassDims | null => startClass(a)?.dims ?? null;

/** The class dims when hulls are drawn to scale in this view (default Fit), else null (markers). */
export function startHullScale(a: RaceAnalysis, v?: View, widthPx?: number, frame?: StartFrame): ClassDims | null {
  const dims = startDims(a);
  return dims && dims.loaM / startView(a, v, widthPx, frame).unit >= MIN_HULL_PX ? dims : null;
}

/** The start chart's scale: a chip (hulls to scale, markers at this zoom, or not to scale) and its ⓘ detail (class, LOA, what the shapes point along). */
export function startScale(a: RaceAnalysis, v?: View, widthPx?: number, frame?: StartFrame): { chip: string; info: string } {
  const cls = startClass(a);
  if (!cls) return { chip: 'hulls not to scale', info: `No dimensions for class "${a.meta.boatClass}"; arrows follow course over ground.` };
  const spec = `${cls.name}, ${f2(cls.dims.loaM)} m`;
  return startHullScale(a, v, widthPx, frame)
    ? { chip: 'hulls to scale', info: `Hulls to scale (${spec}), pointing along heading.` }
    : { chip: 'markers at this zoom', info: `${spec} hulls would be under ${MIN_HULL_PX} px: zoom in to draw them.` };
}

/** Name font sizes in chart units (~css px at 600 px wide); below 480 px wide they're scaled up to stay legible. */
const NAME_FS = 10;
const DTL_FS = 8.5;
const NAME_MIN_W = 480;

export interface StartOptions {
  /** Boat names: Auto (no overlaps; default), All, or Off (the selected boat only). */
  names?: StartNames;
  /** The chart's width on screen, px; narrow charts get larger text. */
  widthPx?: number;
  /** Full screen: draw in this frame (`startFullFrame`) instead of the inline Fit. */
  frame?: StartFrame;
}

/**
 * Boats vs the line at the gun: to-scale hulls (or markers) at the bow, START_TRAIL_MS trails.
 * `colour` 'speed': trails shaded by SOG (ui/sog.ts, range fitted to the trails) and each hull
 * filled by its SOG at the gun; 'boat' (default): the boat's own colour. The line is continued
 * dashed past each end with the favoured end labelled (ui/startLine.ts); names per `opts.names`.
 */
export function startSnapshot(a: RaceAnalysis, highlight: string | null, v?: View, colour: StartColour = 'boat', opts: StartOptions = {}): string {
  const { rot, L, R, box, view, unit } = startView(a, v, opts.widthPx, opts.frame);
  const fleet = a.boats.length;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const w = view.x1 - view.x0;
  const h = view.y1 - view.y0;
  const k = unit;
  const names = opts.names ?? 'auto';
  const tk = k * (opts.widthPx ? Math.max(1, NAME_MIN_W / opts.widthPx) : 1);
  const nameFs = NAME_FS * tk;
  const dtlFs = DTL_FS * tk;
  const dims = startHullScale(a, v, opts.widthPx, opts.frame);
  const minCls = startDims(a) && !dims ? ' boat-min' : '';
  const range = colour === 'speed' ? (startSogRange(a) ?? { lo: 0, hi: 1 }) : null;
  /** Speed: the whole fleet's trails batched by bin, the dimmed boats in their own group. */
  const sogTrails = { on: emptySogPaths(), dim: emptySogPaths() };
  const inBox = (p: Vec): boolean => p[0] > box.x0 && p[0] < box.x1 && p[1] > box.y0 && p[1] < box.y1;

  const trails: string[] = [];
  /** Each boat's group, split around its label so the label can be placed once every boat is known. */
  const boats: { id: string; cls: string; head: string; sail: string; dtl: string }[] = [];
  const reqs: LabelReq[] = [];
  const shapes: { id: string; box: Rect }[] = [];
  // A picked boat that isn't racing is drawn on top, grey and dashed; otherwise it isn't drawn at all.
  const nc = pickedExcluded(a, highlight);
  const items: { d: BoatDrawing; b: BoatResult; nc: boolean }[] = a.drawings.map((d) => ({ d, b: byId.get(d.id)!, nc: false }));
  if (nc) items.push({ d: nc.drawing, b: nc.result, nc: true });
  // Speed trails are batched; a picked non-competitor stays a grey dashed polyline on top.
  const ncTrails: string[] = [];
  for (const { d, b, nc: isNc } of items) {
    const col = boatColor(b, fleet);
    const dim = (highlight && highlight !== d.id ? ' dim' : '') + (isNc ? ' nc' : '');
    const dash = isNc ? ` stroke-dasharray="${(4 * k).toFixed(2)} ${(3 * k).toFixed(2)}"` : '';
    if (range && !isNc) {
      const n = d.trail.x.length;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) [x[i], y[i]] = rot([d.trail.x[i], d.trail.y[i]]);
      addSogTrack(highlight && highlight !== d.id ? sogTrails.dim : sogTrails.on, x, y, d.trail.t, d.trail.sog, range, (i) => inBox([x[i], y[i]]));
    } else {
      // Only the parts inside the fit box; a trail that leaves and re-enters is drawn as separate runs.
      const runs: Vec[][] = [[]];
      for (let i = 0; i < d.trail.x.length; i++) {
        const p = rot([d.trail.x[i], d.trail.y[i]]);
        if (inBox(p)) runs[runs.length - 1].push(p);
        else if (runs[runs.length - 1].length) runs.push([]);
      }
      const dest = isNc ? ncTrails : trails;
      for (const tr of runs) {
        if (tr.length > 1) dest.push(`<polyline class="trail${dim}" points="${pts(tr)}" stroke="${col}" stroke-width="${1.5 * k}"${dash}/>`);
      }
    }
    if (!d.bow || d.courseAtGun == null || !b.start) continue;
    const [x, y] = rot(d.bow);
    const st = b.start;
    // Speed: the hull is the biggest thing at the line, so it carries SOG at the gun (the table's Speed @gun),
    // outlined in ink so the pale fast end still reads by day. A non-competitor stays hollow grey.
    const paint = range && !isNc ? `${sogFill(st.speedKn, range)} stroke="var(--ink)"` : `fill="${col}" stroke="var(--surface)"`;
    const sogCls = range && !isNc ? ' sog-fill' : '';
    let shape: string;
    const hullDrawn = !!dims && d.headingAtSample != null;
    // Screen angle of the way the shape points (0 = up the page), for placing its name.
    const fwdAng = ((hullDrawn ? d.headingAtSample! : d.courseAtGun) - a.wind.twdAtGunDeg) * (Math.PI / 180);
    // What other boats' names should keep off: the hull's extent, or the marker's.
    const m = 13 * unit;
    let extent: Rect = { x0: x - m, y0: y - m, x1: x + m, y1: y + m };
    if (dims && d.headingAtSample != null) {
      // True scale, along heading (not COG): the bow tip is the DTL bow point.
      const hull = hullOutline(d.bow, d.headingAtSample, dims).map(rot);
      extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const p of hull) grow(extent, p);
      shape = isNc
        ? `<path class="hull" d="${hullPathD(hull)}" fill="none" stroke="${col}" stroke-width="${1.2 * k}"${dash}/>`
        : `<path class="hull${sogCls}" d="${hullPathD(hull)}" ${paint} stroke-width="${((range ? 0.5 : 0.75) * k).toFixed(2)}"/>`;
    } else {
      const ang = d.courseAtGun - a.wind.twdAtGunDeg; // screen angle, 0 = up the page (into the wind)
      const s = 10 * unit;
      const tip = `0,${-s * 1.3}`;
      const tri = isNc
        ? `<polygon points="${tip} ${s * 0.7},${s * 0.9} 0,${s * 0.4} ${-s * 0.7},${s * 0.9}" fill="none" stroke="${col}"${dash} stroke-width="${1.5 * k}"/>`
        : `<polygon${range ? ' class="sog-fill"' : ''} points="${tip} ${s * 0.7},${s * 0.9} 0,${s * 0.4} ${-s * 0.7},${s * 0.9}" ${paint} stroke-width="${((range ? 1 : 1.5) * k).toFixed(2)}"/>`;
      const ring = minCls ? `<circle class="min-ring" r="${13 * unit}" stroke="${col}" stroke-width="${k}" stroke-dasharray="${2 * k} ${2 * k}"/>` : '';
      shape = `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">${ring}<g transform="rotate(${ang.toFixed(1)})">${tri}</g></g>`;
    }
    const sail = b.sail;
    const dtl = primaryDtlM(st) != null ? `${f1(primaryDtlM(st))} m` : st.dtlGapS != null ? `~${f1(st.dtlM)} m` : '—';
    boats.push({
      id: b.id,
      cls: `boat${minCls}${dim}`,
      head: `<title>#${esc(b.sail)}${isNc ? ' (not racing)' : ''}: ${st.rank ? `${f1(st.rank.m)} m behind (${st.rank.source === 'vakaros' ? `Vakaros; ours ${st.dtlGapS != null ? '~' : ''}${f1(st.dtlM)} m` : 'our track check'})` : `no reliable distance (ours ~${f1(st.dtlM)} m)`}${st.lateS != null ? `, ${f1(st.lateS)} s late` : ''}, SOG ${f1(st.speedKn)} kn at the gun</title>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${16 * unit}" fill="transparent"/>
      ${shape}`,
      sail,
      dtl,
    });
    shapes.push({ id: b.id, box: extent });
    // Off: only the selected boat is named.
    if (names === 'off' && highlight !== d.id) continue;
    const ring = minCls ? 13 * unit : 0;
    reqs.push({
      id: b.id,
      at: [x, y],
      fwd: [Math.sin(fwdAng), -Math.cos(fwdAng)],
      w: Math.max(textWidth(sail, nameFs), textWidth(dtl, dtlFs)),
      h: nameFs + dtlFs + unit,
      // A hull runs aft from the bow; a marker sits centred on it.
      reach: hullDrawn ? { ahead: 0, side: dims!.beamM / 2, behind: dims!.loaM } : { ahead: Math.max(13 * unit, ring), side: Math.max(9 * unit, ring), behind: Math.max(9 * unit, ring) },
    });
  }

  const endFs = 11 * k;
  const lineSvg = `<line class="startline" x1="${L[0]}" y1="${L[1]}" x2="${R[0]}" y2="${R[1]}" stroke-width="${2.5 * k}"/>
    <circle class="pin" cx="${L[0]}" cy="${L[1]}" r="${6 * unit}"/>
    <rect class="rc" x="${R[0] - 6 * unit}" y="${R[1] - 6 * unit}" width="${12 * unit}" height="${12 * unit}"/>
    <text x="${L[0]}" y="${L[1] - 11 * unit}" font-size="${endFs}" text-anchor="middle" class="endlbl">PIN</text>
    <text x="${R[0]}" y="${R[1] - 11 * unit}" font-size="${endFs}" text-anchor="middle" class="endlbl">RC</text>`;
  const endBox = (p: Vec, s: string): Rect => {
    const half = textWidth(s, endFs) / 2;
    return { x0: p[0] - half, y0: p[1] - 11 * unit - endFs, x1: p[0] + half, y1: p[1] + 6 * unit };
  };
  // Small text (85% of a boat name), sized as the names are: with the view and up on narrow screens.
  const bias = lineBiasSvg(a, L, R, box, unit, 0.85 * nameFs, startDims(a));

  // Names: the selected boat first, then by start place, then by distance off the line, then the rest.
  const order = (id: string): [number, number, number] => {
    const st = (byId.get(id) ?? (nc?.result.id === id ? nc.result : undefined))?.start;
    return [id === highlight ? 0 : 1, st?.startPlace ?? Infinity, st?.rank ? Math.abs(st.rank.m) : Infinity];
  };
  reqs.sort((p, q) => {
    const [a0, a1, a2] = order(p.id);
    const [b0, b1, b2] = order(q.id);
    return a0 - b0 || a1 - b1 || a2 - b2;
  });
  const placed = placeLabels(reqs, {
    pad: 4 * unit,
    taken: [endBox(L, 'PIN'), endBox(R, 'RC'), bias.box],
    segments: [[L, R]],
    soft: shapes,
    bounds: view,
    cull: names !== 'all',
    force: highlight,
  });
  const boatSvg = boats.map(({ id, cls, head, sail, dtl }) => {
    const r = placed.get(id);
    if (!r) return `<g class="${cls} nolbl" data-id="${esc(id)}">${head}</g>`;
    const cx = ((r.x0 + r.x1) / 2).toFixed(1);
    return `<g class="${cls}" data-id="${esc(id)}">${head}
      <g class="blbl" stroke-width="${(2.5 * k).toFixed(2)}"><text x="${cx}" y="${(r.y0 + 0.8 * nameFs).toFixed(1)}" font-size="${nameFs.toFixed(2)}" text-anchor="middle" class="lbl">${esc(sail)}</text>
      <text x="${cx}" y="${(r.y1 - 0.2 * dtlFs).toFixed(1)}" font-size="${dtlFs.toFixed(2)}" text-anchor="middle" class="sub">${dtl}</text></g></g>`;
  });

  if (range) {
    const g = (acc: SogPaths, dim: string): string => {
      const body = sogPathsSvg(acc, 2, k);
      return body ? `<g class="trail sog${dim}" stroke-width="${(2 * k).toFixed(2)}">${body}</g>` : '';
    };
    trails.push(g(sogTrails.dim, ' dim'), g(sogTrails.on, ''));
  }
  trails.push(...ncTrails);
  const label = range
    ? `Boats relative to the start line at the gun (Vakaros timing); trails and hulls coloured by speed over ground, ${f1(range.lo)} to ${f1(range.hi)} kn: dark purple slowest, yellow-green fastest`
    : 'Boats relative to the start line at the gun (Vakaros timing)';

  return `<svg viewBox="${view.x0} ${view.y0} ${w} ${h}" class="chart start" role="img"
    shape-rendering="geometricPrecision"
    aria-label="${esc(label)}">
    ${bias.ext}${trails.join('')}${lineSvg}${bias.label}${boatSvg.join('')}
    ${windArrow(view, unit, k, 'wind (est.)')}${scaleBar(view, unit, k)}</svg>`;
}

/** Full screen, Colour: Boat: a compact key of each boat's colour (up to eight boats; a bigger fleet is one ink, named on the chart). */
export function startBoatKey(a: RaceAnalysis): string {
  if (a.boats.length > SLOTS) return '';
  return a.boats.map((b) => `<span class="bk"><i style="background:${boatColor(b, a.boats.length)}"></i>${esc(b.sail)}</span>`).join('');
}

/** The fixed points a leg runs between: the line or previous mark, and its own mark or the finish. */
function legEnds(a: RaceAnalysis, leg: number): Vec[] {
  const out: Vec[] = [];
  if (leg === 0) out.push(a.line.left, a.line.right);
  if (leg === a.legs.length - 1 && a.finishLine) out.push(a.finishLine.left, a.finishLine.right);
  const names = new Set([a.legs[leg - 1]?.to, leg < a.legs.length - 1 ? a.legs[leg].to : undefined]);
  for (const m of a.marks) if (names.has(m.name)) out.push(...m.xy);
  return out;
}

const mapBoxes = new WeakMap<RaceAnalysis, Map<number | null, Box>>();

/** The track map's view: everything, or one leg's segments plus its marks; padded. Worked out once per race and leg (pan/zoom redraws ask often). */
export function mapBox(a: RaceAnalysis, leg: number | null = null): Box {
  let byLeg = mapBoxes.get(a);
  if (!byLeg) mapBoxes.set(a, (byLeg = new Map()));
  let box = byLeg.get(leg);
  if (!box) byLeg.set(leg, (box = mapBoxOf(a, leg)));
  return { ...box };
}

function mapBoxOf(a: RaceAnalysis, leg: number | null): Box {
  const rot = rotator(a.wind.twdAtGunDeg);
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const fixed = leg == null ? [a.line.left, a.line.right, ...a.marks.flatMap((m) => m.xy)] : legEnds(a, leg);
  for (const p of fixed) grow(box, rot(p));
  for (const d of a.drawings) {
    for (const seg of d.segments) {
      if (leg != null && seg.leg !== leg) continue;
      for (let i = 0; i < seg.x.length; i++) grow(box, rot([seg.x[i], seg.y[i]]));
    }
  }
  if (!Number.isFinite(box.x0)) return leg == null ? { x0: -100, y0: -100, x1: 100, y1: 100 } : mapBox(a, null);
  const pad = Math.max(10, 0.06 * Math.max(box.x1 - box.x0, box.y1 - box.y0));
  box.x0 -= pad;
  box.x1 += pad;
  box.y0 -= pad;
  box.y1 += pad;
  return box;
}

export interface TrackMapOptions {
  /**
   * 'leg' (default): one colour per leg. 'rank': plasma and emphasis by
   * elapsed-time rank (ui/speed.ts). 'sog': viridis by each boat's own SOG (ui/sog.ts).
   */
  colour?: TrackColour;
  /** Whole race in Rank: rank each leg's segment on that leg, or the whole track by race time. */
  rankBy?: RankBy;
  /** Rank: colour only the top N (per leg when ranking each leg); the rest faint grey. Default all. */
  top?: SpeedTop;
  /** Whole race in Boat speed: bin each leg on its own fleet range (default) or all on the race's. */
  sogScale?: SogScale;
  /** Pan/zoom on the leg's (or race's) `mapBox` (default Fit). */
  view?: View;
  /** Full-rate tracks to draw from instead of the ~1 Hz segments (zoomed in tight: mapPieces.ts useFullRate). */
  full?: FullRateSet | null;
  /**
   * Scrubbing: draw the static map only (lines, marks, wind, scale) with two empty layers for
   * the trails and the boats (`g.scrub-trk`, `g.scrub-dots`), filled each frame from `scrubFrame`.
   */
  scrub?: boolean;
  /**
   * Replaying the selected boat's over-early start (Map C, ui/replay.ts): while scrubbing the whole race, its
   * stretch over the line and its dip back are drawn on top of its track (up to the scrubber's time), with
   * markers where it went back and recrossed, and a label. Ignored for another boat or one leg.
   */
  replay?: StartReplay | null;
  /**
   * Comparison boats (Map D, ui/mapLink.ts: a Coach card's boats on the map): while scrubbing, their trails get
   * an ink casing (`trk-vs`) and their dots a ring (`dot-vs`) and their sail label, whatever the fleet's size.
   */
  vs?: readonly string[] | null;
}

/** A segment's points in map coordinates (wind at the top), worked out once per segment. */
const rotSeg = (twd: number, seg: TrackSegment): { x: Float64Array; y: Float64Array } => rotTrack(twd, seg);

/** Each boat's drawn segments (leg `leg`, or all) in map coordinates, as the map draws them. */
function mapTracks(a: RaceAnalysis, leg: number | null): IndexedTrack[] {
  const out: IndexedTrack[] = [];
  for (const d of a.drawings) {
    for (const seg of d.segments) {
      if (leg != null && seg.leg !== leg) continue;
      const { x, y } = rotSeg(a.wind.twdAtGunDeg, seg);
      out.push({ id: d.id, x, y, t: seg.t, sog: seg.sog, leg: seg.leg });
    }
  }
  return out;
}

/**
 * Zoomed in, only track near the view is drawn: the view grown by half its size
 * each way (a pan between redraws still shows track). Null at Fit (everything).
 */
function mapClip(view: Box, k: number): Box | null {
  if (k <= 1) return null;
  const mx = (view.x1 - view.x0) / 2;
  const my = (view.y1 - view.y0) / 2;
  return { x0: view.x0 - mx, y0: view.y0 - my, x1: view.x1 + mx, y1: view.y1 + my };
}

/** Whether fix `i` is to be drawn: inside `clip`, or next to one that is (so a line leaving the view still reaches its edge). */
function nearClip(x: ArrayLike<number>, y: ArrayLike<number>, clip: Box | null): (i: number) => boolean {
  if (!clip) return () => true;
  const inside = (i: number): boolean => i >= 0 && i < x.length && x[i] >= clip.x0 && x[i] <= clip.x1 && y[i] >= clip.y0 && y[i] <= clip.y1;
  return (i) => inside(i) || inside(i - 1) || inside(i + 1);
}

const xy1 = (x: number, y: number): string => `${x.toFixed(1)},${y.toFixed(1)}`;

/**
 * A segment as the map draws it in Leg and Rank: runs of two or more fixes with
 * no step over the boat's gap threshold (mapPoints.ts), only near `clip`; and
 * each gap as a chord ("M…L…"), drawn faint and dashed (as Boat speed does).
 */
export function segRuns(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  t: ArrayLike<number>,
  gapMs: number,
  clip: Box | null = null,
): { runs: Vec[][]; gaps: string } {
  const near = nearClip(x, y, clip);
  const runs: Vec[][] = [];
  let gaps = '';
  let cur: Vec[] = [];
  const flush = (): void => {
    if (cur.length > 1) runs.push(cur);
    cur = [];
  };
  const n = Math.min(x.length, y.length, t.length);
  for (let i = 0; i < n; i++) {
    if (i > 0 && t[i] - t[i - 1] > gapMs) {
      flush();
      if (near(i - 1) || near(i)) gaps += `M${xy1(x[i - 1], y[i - 1])}L${xy1(x[i], y[i])}`;
    }
    if (near(i)) cur.push([x[i], y[i]]);
    else flush();
  }
  flush();
  return { runs, gaps };
}

/** Stroke widths in Boat speed, map units: everyone, and the selected boat. */
const SOG_W = 1.4;
const SOG_W_ON = 2.6;

/**
 * Colour: Boat speed. Per boat, a group of batched paths (ui/sog.ts), each
 * segment binned on its range (its leg's, or the race's: `segmentSogRange`);
 * with a selection, everyone else dimmed and the selected boat last, thicker,
 * over an ink outline.
 */
function sogLayer(
  a: RaceAnalysis,
  highlight: string | null,
  leg: number | null,
  k: number,
  scale: SogScale,
  clip: Box | null,
  piecesOf: (d: BoatDrawing) => MapPiece[],
): string {
  const byBoat = new Map<string, SogPaths>();
  for (const d of a.drawings) {
    // Gaps by the map's rule (mapPoints.ts), as in Leg and Rank.
    const gapMs = drawingGapMs(d);
    for (const pc of piecesOf(d)) {
      let acc = byBoat.get(d.id);
      if (!acc) byBoat.set(d.id, (acc = emptySogPaths()));
      const x = pc.rx.subarray(pc.i0, pc.i1);
      const y = pc.ry.subarray(pc.i0, pc.i1);
      const range = segmentSogRange(a, pc.leg, leg, scale) ?? { lo: 0, hi: 1 };
      addSogTrack(acc, x, y, pc.src.t.subarray(pc.i0, pc.i1), pc.src.sog.subarray(pc.i0, pc.i1), range, nearClip(x, y, clip), gapMs);
    }
  }
  const out: string[] = [];
  let sel = '';
  for (const [id, acc] of byBoat) {
    const on = highlight === id;
    const w = on ? SOG_W_ON : SOG_W;
    const body = sogPathsSvg(acc, w, k);
    if (!body) continue;
    const cls = highlight ? (on ? 'sog-trk on' : 'sog-trk dim') : 'sog-trk';
    const g = `<g class="${cls}" data-id="${esc(id)}" stroke-width="${(w * k).toFixed(2)}">${body}</g>`;
    if (on) sel = `<path class="sog-sel" d="${acc.bins.join('')}" stroke-width="${((w + 2.4) * k).toFixed(2)}"/>${g}`;
    else out.push(g);
  }
  return out.join('') + sel;
}

/** The hover lookup for the map in Boat speed: every drawn fix of leg `leg` (or all), in map coordinates. */
export function trackSogIndex(a: RaceAnalysis, leg: number | null): SogIndex {
  const box = mapBox(a, leg);
  return sogIndex(mapTracks(a, leg), Math.max(box.x1 - box.x0, box.y1 - box.y0) / 120);
}

/** The map's point details lookup (every drawn fix and gap of leg `leg`, or all, in map coordinates): ui/mapPoints.ts. */
export function trackPoints(a: RaceAnalysis, leg: number | null): MapPoints {
  return mapPoints(a, leg, (seg) => rotSeg(a.wind.twdAtGunDeg, seg));
}

/** The track map's fit box for leg `leg` (or all), and the rectangle its viewBox shows for `v` (default Fit). */
export function trackMapView(a: RaceAnalysis, leg: number | null, v?: View): { box: Box; view: Box; k: number } {
  const box = mapBox(a, leg);
  const cv = clampView(box, v ?? fitView(box));
  const vb = viewBox(box, cv);
  return { box, view: { x0: vb.x0, y0: vb.y0, x1: vb.x0 + vb.w, y1: vb.y0 + vb.h }, k: cv.k };
}

/** A boat's pieces by the leg range they came from (a zoomed view can cut one range into several). */
interface PieceGroup {
  leg: number;
  pieces: MapPiece[];
  /** Map coordinates of the range's last fix in the time window (where Rank labels a picked boat's segment). */
  end: Vec;
}

function pieceGroups(pieces: readonly MapPiece[]): PieceGroup[] {
  const out: PieceGroup[] = [];
  let last: MapPiece | null = null;
  for (const pc of pieces) {
    if (last && last.src === pc.src && last.leg === pc.leg) out[out.length - 1].pieces.push(pc);
    else out.push({ leg: pc.leg, pieces: [pc], end: [pc.rx[pc.end], pc.ry[pc.end]] });
    last = pc;
  }
  return out;
}

/** The map's window and its sizes: map units per on-screen unit (`unit`), and the stroke/font scale `k`. */
interface MapScale {
  box: Box;
  unit: number;
  k: number;
}

function mapScale(box: Box): MapScale {
  const unit = Math.max(box.x1 - box.x0, box.y1 - box.y0) / 600;
  return { box, unit, k: unit };
}

/** The tracks as drawn: gap chords under everything, the tracks, the selected boat's on top, Rank's labels; and the pieces drawn. */
interface TrackLayer {
  gaps: string;
  paths: string;
  hi: string;
  labels: string;
  pieces: MapPiece[];
}

/** Track before the gun (no leg) in Leg and Rank: neutral ink, thin. */
const PRE_COLOR = 'var(--ink-3)';

/**
 * The map's tracks for pieces `po` (the whole race, or the scrubber's window), coloured by leg, rank or
 * boat speed, with each boat's gaps as dashed chords. Track before the gun is neutral in Leg and Rank, by SOG in Boat speed.
 */
function trackLayer(a: RaceAnalysis, highlight: string | null, leg: number | null, opts: TrackMapOptions, po: PieceOptions, sc: MapScale): TrackLayer {
  const { box, unit, k } = sc;
  const twd = a.wind.twdAtGunDeg;
  const clip = po.clip ?? null;
  const sw = (width: number): string => `stroke-width="${(width * k).toFixed(2)}"`;
  const speed = opts.colour === 'rank' ? speedRanking(a, leg, opts.rankBy ?? 'leg') : null;
  const sogScale = opts.sogScale ?? 'leg';
  // A picked boat that isn't racing: grey and dashed on top, split at the fleet's
  // leg times. It never moves the fit, and Rank / Boat speed never colour it.
  const nc = pickedExcluded(a, highlight);
  const drawings = nc ? [...a.drawings, nc.drawing] : a.drawings;
  const drawn: MapPiece[] = [];
  const piecesOf = (d: BoatDrawing): MapPiece[] => {
    const ps = drawingPieces(twd, d, po);
    drawn.push(...ps);
    return ps;
  };

  const paths: string[] = opts.colour === 'sog' ? [sogLayer(a, highlight, leg, k, sogScale, clip, piecesOf)] : [];
  /** Leg and Rank: each boat's gaps, faint dashed chords under the tracks. */
  const gapSvg: string[] = [];
  const hi: string[] = [];
  /** Rank mode: [draw order, svg]; unranked first, then slowest → fastest, the selection last. */
  const ordered: [number, string][] = [];
  /** Rank mode: where the picked boat's segments outside the top N end, and its rank there. */
  const pickLabels: { at: Vec; leg: number; rank: number }[] = [];
  // Boat speed draws its own layer (above); the per-segment polylines are for Leg
  // and Rank. A picked non-competitor is still a grey dashed polyline in every mode.
  for (const d of opts.colour === 'sog' ? (nc ? [nc.drawing] : []) : drawings) {
    const isNc = d === nc?.drawing;
    const gapMs = drawingGapMs(d);
    let gaps = '';
    for (const grp of pieceGroups(piecesOf(d))) {
      // Each run between gaps is its own line; the gaps are drawn apart, below.
      const runs: Vec[][] = [];
      for (const pc of grp.pieces) {
        const r = segRuns(pc.rx.subarray(pc.i0, pc.i1), pc.ry.subarray(pc.i0, pc.i1), pc.src.t.subarray(pc.i0, pc.i1), gapMs, clip);
        runs.push(...r.runs);
        gaps += r.gaps;
      }
      if (!runs.length) continue;
      const segLeg = grp.leg;
      if (isNc) {
        const dash = `stroke-dasharray="${(5 * k).toFixed(2)} ${(4 * k).toFixed(2)}"`;
        for (const run of runs) {
          // No <title>: the map's hover/tap tooltip is the point details; a native tooltip would double up.
          const svg = `<polyline class="trk on nc" data-leg="${segLeg}" data-id="${esc(d.id)}" points="${pts(run)}" stroke="${NC_COLOR}" ${dash} ${sw(2.6)}></polyline>`;
          if (speed) ordered.push([2, svg]);
          else hi.push(svg);
        }
        continue;
      }
      if (segLeg === PRE_LEG) {
        const on = highlight === d.id;
        const cls = highlight ? (on ? 'trk pre on' : 'trk pre dim') : 'trk pre';
        for (const run of runs) {
          const svg = `<polyline class="${cls}" data-leg="${segLeg}" data-id="${esc(d.id)}" points="${pts(run)}" stroke="${PRE_COLOR}" ${sw(on ? 2.2 : 1.1)}></polyline>`;
          (on ? hi : paths).push(svg);
        }
        continue;
      }
      if (!speed) {
        const cls = highlight ? (highlight === d.id ? 'trk on' : 'trk dim') : 'trk';
        const width = highlight === d.id ? 2.6 : 1.2;
        for (const run of runs) {
          const svg = `<polyline class="${cls}" data-leg="${segLeg}" points="${pts(run)}" stroke="${legColor(segLeg)}" ${sw(width)}></polyline>`;
          (highlight === d.id ? hi : paths).push(svg);
        }
        continue;
      }
      const r = speed.at(d.id, segLeg);
      const on = highlight === d.id;
      const st = speedStyle(r, opts.top ?? 'all', on ? 'this' : highlight ? 'other' : 'none');
      // Grey strokes are classed by why (unranked / out of the top N), coloured ones by tier, a picked boat past N 'picked'.
      const cls = ['trk spd', st.kind === 'picked-out' ? 'picked' : st.t == null ? st.kind : st.tier, on ? 'on' : ''].filter(Boolean).join(' ');
      const op = `stroke-opacity="${st.opacity.toFixed(2)}"`;
      for (const run of runs) {
        const p = pts(run);
        const attrs = `data-leg="${segLeg}" data-id="${esc(d.id)}" points="${p}"`;
        let svg: string;
        if (st.kind === 'picked-out' && r) {
          // Ink over a surface casing: no rank colour, so it can't pass for one of the top N; its rank is labelled instead.
          svg = `<polyline class="spd-pick-case" points="${p}" ${sw(st.width + 2.4)}/><polyline class="${cls}" ${attrs} ${sw(st.width)} ${op}></polyline>`;
        } else if (st.t == null) {
          const dash = st.kind === 'unranked' ? ` stroke-dasharray="${(3 * k).toFixed(2)} ${(2.5 * k).toFixed(2)}"` : '';
          svg = `<polyline class="${cls}" ${attrs} ${sw(st.width)} ${op}${dash}></polyline>`;
        } else {
          // Selection: an ink outline under the boat's own colour. Otherwise, by day, a thin dark casing under the pale fast end, as faint as its stroke.
          const casing = on
            ? `<polyline class="spd-sel" points="${p}" ${sw(st.width + 2.4)}/>`
            : casedByDay(st.t)
              ? `<polyline class="spd-case" points="${p}" ${sw(st.width + 1)} stroke-opacity="${(0.55 * st.opacity).toFixed(2)}"/>`
              : '';
          svg = `${casing}<polyline class="${cls}" ${attrs} stroke="${speedColor(st.t)}" style="--cd:${speedColor(st.t, 'dark')}" ${sw(st.width)} ${op}></polyline>`;
        }
        ordered.push([on ? 2 : r ? 1 - r.t : -1, svg]);
      }
      if (st.kind === 'picked-out' && r) {
        // Overall: one label, at the end of the track; each leg: one per segment.
        if (!speed.overall) pickLabels.push({ at: grp.end, leg: segLeg, rank: r.rank });
        else if (!pickLabels[0] || segLeg >= pickLabels[0].leg) pickLabels[0] = { at: grp.end, leg: segLeg, rank: r.rank };
      }
    }
    // A picked non-competitor's holes stay plain holes (its line is dashed already).
    if (gaps && !isNc) {
      const on = highlight === d.id;
      const cls = highlight ? (on ? 'trk-gap on' : 'trk-gap dim') : 'trk-gap';
      gapSvg.push(`<path class="${cls}" data-id="${esc(d.id)}" d="${gaps}" ${sw(on ? 1.6 : 1.2)} stroke-dasharray="${(3 * k).toFixed(2)} ${(2.5 * k).toFixed(2)}"/>`);
    }
  }
  if (speed) {
    ordered.sort((x, y) => x[0] - y[0]);
    paths.push(...ordered.map(([, s]) => s));
  }

  // Beside the end point, on the side with more room.
  const labels = pickLabels
    .map(({ at: [x, y], rank }) => {
      const right = x < (box.x0 + box.x1) / 2;
      return `<text class="spd-pick-lbl" x="${(x + (right ? 7 : -7) * unit).toFixed(1)}" y="${(y + 4 * unit).toFixed(1)}" font-size="${12 * k}" stroke-width="${(3 * k).toFixed(2)}" text-anchor="${right ? 'start' : 'end'}">#${rank}</text>`;
    })
    .join('');
  return { gaps: gapSvg.join(''), paths: paths.join(''), hi: hi.join(''), labels, pieces: drawn };
}

/** Whole-race tracks coloured by leg (or by speed rank, or boat speed), or only leg `leg` (fitted to it); scrubbing, the static map only. */
export function trackMap(a: RaceAnalysis, highlight: string | null, leg: number | null = null, opts: TrackMapOptions = {}): string {
  const rot = rotator(a.wind.twdAtGunDeg);
  // A window onto the fit box (Fit by default): sizes follow the window, so they stay put on screen as it zooms.
  const { view: box, k: zoom } = trackMapView(a, leg, opts.view);
  const clip = mapClip(box, zoom);
  const sc = mapScale(box);
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const { unit, k } = sc;
  const speed = opts.colour === 'rank' ? speedRanking(a, leg, opts.rankBy ?? 'leg') : null;
  const sogScale = opts.sogScale ?? 'leg';
  const perLeg = opts.colour === 'sog' && leg == null && sogScale === 'leg';
  const sog = opts.colour === 'sog' ? trackSogRange(a, leg) : null;
  const layer = opts.scrub ? null : trackLayer(a, highlight, leg, opts, { leg, clip, full: opts.full }, sc);

  const L = rot(a.line.left);
  const R = rot(a.line.right);
  const labelAt: Vec[] = [];
  const labelMin = 22 * unit;
  const marks = a.marks
    .map((m) => {
      const ps = m.xy.map(rot);
      // Turns placed from the tracks (no tracker): hollow, dashed, labelled "(est.)".
      const cls = m.estimated ? 'mark est' : 'mark';
      const dash = m.estimated ? ` stroke-dasharray="${(3 * k).toFixed(2)} ${(2 * k).toFixed(2)}"` : '';
      const c = ps.map((p) => `<circle class="${cls}" cx="${p[0]}" cy="${p[1]}" r="${5.5 * unit}" stroke-width="${1.5 * k}"${dash}/>`).join('');
      const top = ps.reduce((x, y) => (y[0] > x[0] ? y : x));
      const name = m.estimated ? `${m.name.replace(/ mark$/i, '')} (est.)` : m.name;
      const at: Vec = [top[0] + 9 * unit, top[1] + 4 * unit];
      if (labelAt.some((p) => Math.hypot(p[0] - at[0], p[1] - at[1]) < labelMin)) return c;
      labelAt.push(at);
      return `${c}<text x="${at[0]}" y="${at[1]}" font-size="${12 * k}" class="lbl${m.estimated ? ' est' : ''}">${esc(name)}</text>`;
    })
    .join('');
  const fl = a.finishLine;
  const finish =
    fl && Math.hypot(fl.left[0] - a.line.left[0], fl.left[1] - a.line.left[1]) + Math.hypot(fl.right[0] - a.line.right[0], fl.right[1] - a.line.right[1]) > 20
      ? (() => {
          const [p, q] = [rot(fl.left), rot(fl.right)];
          return `<line class="finishline" x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke-width="${2 * k}"/>`;
        })()
      : '';

  const legRanges = perLeg ? legRangeList(a) : '';
  const sogLabel =
    opts.colour !== 'sog'
      ? ''
      : perLeg
        ? `coloured by boat speed (SOG), scaled within each leg${legRanges ? ` (${legRanges})` : ''}: dark purple slowest on that leg, through teal, to yellow-green fastest`
        : `coloured by boat speed (SOG)${sog ? `, ${f1(sog.lo)} to ${f1(sog.hi)} kn` : ''}: dark purple slowest, through teal, to yellow-green fastest`;
  const label =
    leg == null
      ? speed
        ? `Tracks coloured by speed, ${speed.overall ? 'race time' : 'rank on each leg'}: yellow and boldest fastest`
        : sogLabel
          ? `Tracks ${sogLabel}`
          : 'Tracks coloured by leg'
      : `Tracks on ${a.legs[leg]?.name ?? 'one leg'}${speed ? ', coloured by speed on the leg: yellow and boldest fastest' : sogLabel ? `, ${sogLabel}` : ''}`;
  const tracks = layer ? `${layer.gaps}${layer.paths}${layer.hi}` : '<g class="scrub-trk"></g>';
  const top = layer ? layer.labels : '<g class="scrub-dots"></g>';
  return `<svg viewBox="${box.x0} ${box.y0} ${w} ${h}" class="chart map${opts.scrub ? ' scrub' : ''}" role="img" aria-label="${esc(opts.scrub ? `${label}; boats at the scrubber's time` : label)}">
    ${tracks}
    <line class="startline" x1="${L[0]}" y1="${L[1]}" x2="${R[0]}" y2="${R[1]}" stroke-width="${2.5 * k}"/>${finish}${marks}${top}
    ${windArrow(box, unit, k, 'wind (est.)')}${scaleBar(box, unit, k)}</svg>`;
}

// ---- race-time scrubber (Map B) ---------------------------------------------------

/** The scrubber's moment: time `t`, the trail drawn ([t − trail, t]), and full-rate tracks when zoomed in tight. */
export interface ScrubAt {
  t: number;
  win: [number, number];
  full?: FullRateSet | null;
}

/** One scrubber frame: the trails (into `g.scrub-trk`), the boats and labels (into `g.scrub-dots`), and what they were drawn from. */
export interface ScrubFrame {
  tracks: string;
  dots: string;
  pieces: MapPiece[];
  boats: BoatAt[];
}

/** Every drawn boat (and a picked one not racing) at time `t`: mapPieces.ts boatAt, from the full-rate track when there is one. */
export function boatsAt(a: RaceAnalysis, highlight: string | null, t: number, full?: FullRateSet | null): BoatAt[] {
  const nc = pickedExcluded(a, highlight);
  const out: BoatAt[] = [];
  for (const d of nc ? [...a.drawings, nc.drawing] : a.drawings) {
    const b = boatAt(d.id, legRanges(d, true, full?.get(d.id)), t, drawingGapMs(d), a.wind.twdAtGunDeg);
    if (b) out.push(b);
  }
  return out;
}

/** Up to this many boats, every dot is labelled with its sail number; a bigger fleet labels only the selected boat. */
export const DOT_LABEL_MAX = SLOTS;

/** A dot's colour by the map's colouring: day, and night where it differs. */
function dotColour(a: RaceAnalysis, b: BoatAt, leg: number | null, opts: TrackMapOptions, speed: ReturnType<typeof speedRanking> | null, highlight: string | null): { c: string; cd?: string } {
  if (pickedExcluded(a, highlight)?.result.id === b.id) return { c: NC_COLOR };
  if (opts.colour === 'sog') {
    const r = segmentSogRange(a, b.leg, leg, opts.sogScale ?? 'leg');
    if (!r || !Number.isFinite(b.sog)) return { c: PRE_COLOR };
    const s = (b.sog - r.lo) / (r.hi - r.lo);
    return { c: sogColor(s), cd: sogColor(s, 'dark') };
  }
  if (b.leg === PRE_LEG) return { c: PRE_COLOR };
  if (!speed) return { c: legColor(b.leg) };
  const st = speedStyle(speed.at(b.id, b.leg), opts.top ?? 'all', highlight === b.id ? 'this' : 'none');
  if (st.kind === 'picked-out') return { c: 'var(--ink)' };
  return st.t == null ? { c: PRE_COLOR } : { c: speedColor(st.t), cd: speedColor(st.t, 'dark') };
}

/**
 * The boats at the scrubber's time as dots: coloured as the map is (the leg the boat is on, its rank there,
 * or its SOG), a short tick along its course; hollow while holding in a gap;
 * the selected boat bigger, on top and labelled (every boat labelled in a small fleet); boats off a leg shown, faint.
 */
function dotsSvg(a: RaceAnalysis, highlight: string | null, leg: number | null, opts: TrackMapOptions, boats: readonly BoatAt[], sc: MapScale): string {
  const { unit, k } = sc;
  const speed = opts.colour === 'rank' ? speedRanking(a, leg, opts.rankBy ?? 'leg') : null;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const nc = pickedExcluded(a, highlight);
  if (nc) byId.set(nc.result.id, nc.result);
  const labelAll = a.boats.length <= DOT_LABEL_MAX;
  const vs = new Set(opts.vs ?? []);
  const out: string[] = [];
  const vsOut: string[] = [];
  let sel = '';
  for (const b of boats) {
    const on = highlight === b.id;
    const cmp = !on && vs.has(b.id);
    const { c, cd } = dotColour(a, b, leg, opts, speed, highlight);
    const style = cd ? ` style="--cd:${cd}"` : '';
    const r = (on ? 6 : 4.2) * unit;
    const cls = ['dot', b.hold ? 'hold' : '', on ? 'on' : cmp ? 'vs' : highlight ? 'dim' : '', leg != null && b.leg !== leg ? 'off' : ''].filter(Boolean).join(' ');
    const [x, y] = [b.mx.toFixed(1), b.my.toFixed(1)];
    const tick =
      b.dir && !b.hold
        ? `<line class="dot-hdg" x1="${x}" y1="${y}" x2="${(b.mx + b.dir[0] * (r + 6 * unit)).toFixed(1)}" y2="${(b.my + b.dir[1] * (r + 6 * unit)).toFixed(1)}" stroke-width="${((on ? 2 : 1.4) * k).toFixed(2)}"/>`
        : '';
    const fill = b.hold ? `fill="var(--surface)" stroke="${c}"${style}` : `fill="${c}"${style}`;
    const ring = `<circle class="${cls}" data-id="${esc(b.id)}" cx="${x}" cy="${y}" r="${r.toFixed(2)}" ${fill} stroke-width="${((on ? 1.8 : 1) * k).toFixed(2)}"/>`;
    const vsRing = cmp ? `<circle class="dot-vs" cx="${x}" cy="${y}" r="${(r + 2.6 * unit).toFixed(2)}" stroke-width="${(1.6 * k).toFixed(2)}"/>` : '';
    const who = byId.get(b.id);
    const text =
      on || cmp || labelAll
        ? `<text class="dot-lbl${on ? ' on' : cmp ? ' vs' : ''}" x="${(b.mx + r + 3 * unit).toFixed(1)}" y="${(b.my - r).toFixed(1)}" font-size="${(on ? 12 : 10.5) * k}" stroke-width="${(3 * k).toFixed(2)}">${esc(who ? who.sail : b.id)}</text>`
        : '';
    const svg = `<g class="boat-at${on ? ' on' : cmp ? ' vs' : highlight ? ' dim' : ''}">${vsRing}${tick}${ring}${text}</g>`;
    if (on) sel = svg;
    else (cmp ? vsOut : out).push(svg);
  }
  // The comparison boats over the rest, the selected boat on top.
  return out.join('') + vsOut.join('') + sel;
}

/** One scrubber frame for time `s.t`: the trails over `s.win` (pre-gun track included) and the boats there. */
export function scrubFrame(a: RaceAnalysis, highlight: string | null, leg: number | null, opts: TrackMapOptions, s: ScrubAt): ScrubFrame {
  const { view: box, k: zoom } = trackMapView(a, leg, opts.view);
  const sc = mapScale(box);
  const layer = trackLayer(a, highlight, leg, opts, { leg, win: s.win, clip: mapClip(box, zoom), pre: true, full: s.full }, sc);
  const boats = boatsAt(a, highlight, s.t, s.full);
  const r = opts.replay && opts.replay.boat === highlight && leg == null ? replaySvg(a, opts.replay, s, sc) : null;
  return {
    tracks: `${layer.gaps}${vsCasing(a, layer.pieces, opts.vs, highlight, sc)}${layer.paths}${layer.hi}${r?.tracks ?? ''}`,
    dots: (r?.marks ?? '') + layer.labels + dotsSvg(a, highlight, leg, opts, boats, sc) + (r?.label ?? ''),
    pieces: layer.pieces,
    boats,
  };
}

/** The comparison boats' trails (Map D): an ink casing under their own lines, from the pieces the frame drew; broken at gaps as they are. */
function vsCasing(a: RaceAnalysis, pieces: readonly MapPiece[], vs: readonly string[] | null | undefined, highlight: string | null, sc: MapScale): string {
  if (!vs?.length) return '';
  const ids = new Set(vs.filter((id) => id !== highlight));
  const gapOf = gapLookup(a);
  let out = '';
  for (const pc of pieces) {
    if (!ids.has(pc.id)) continue;
    const runs = segRuns(pc.rx.subarray(pc.i0, pc.i1), pc.ry.subarray(pc.i0, pc.i1), pc.src.t.subarray(pc.i0, pc.i1), gapOf(pc.id)).runs;
    for (const run of runs) out += `<polyline class="trk-vs" data-id="${esc(pc.id)}" points="${pts(run)}" stroke-width="${(3.4 * sc.k).toFixed(2)}"/>`;
  }
  return out;
}

/**
 * A replay's highlight at the scrubber's moment: the boat's track over the line (warning red) and its dip back
 * (red dashed), each only as far as `s.t` and within the trail, read from the source the map draws (the
 * full-rate track when there is one) and cut at the facts' times on it, broken at gaps as the track is;
 * a ring where it went back and a dot where it recrossed, once reached; the label just off the line on the
 * pre-start side, kept inside the view.
 */
function replaySvg(a: RaceAnalysis, r: StartReplay, s: ScrubAt, sc: MapScale): { tracks: string; marks: string; label: string } {
  const { box, unit, k } = sc;
  const twd = a.wind.twdAtGunDeg;
  const d = a.drawings.find((x) => x.id === r.boat);
  if (!d) return { tracks: '', marks: '', label: '' };
  const ranges = legRanges(d, true, s.full?.get(d.id));
  const gapMs = drawingGapMs(d);
  const at = (t: number): Vec | null => {
    const b = boatAt(d.id, ranges, t, gapMs, twd);
    return b && !b.hold ? [b.mx, b.my] : null;
  };
  const sw = (width: number): string => `stroke-width="${(width * k).toFixed(2)}"`;
  /** The drawn track over [from, to] ∩ the trail up to now: its ends cut at those times, broken at gaps. */
  const stretch = (span: [number, number] | null): Vec[][] => {
    if (!span) return [];
    const from = Math.max(span[0], s.win[0]);
    const to = Math.min(span[1], s.t, s.win[1]);
    if (!(to > from)) return [];
    const x: number[] = [];
    const y: number[] = [];
    const t: number[] = [];
    const push = (p: Vec | null, tt: number): void => {
      if (!p || (t.length && tt <= t[t.length - 1])) return;
      x.push(p[0]);
      y.push(p[1]);
      t.push(tt);
    };
    push(at(from), from);
    for (const g of ranges) {
      const rot = rotTrack(twd, g.src);
      const [i0, i1] = timeRange(g.src.t, from, to, g.lo, g.hi);
      for (let i = i0; i < i1; i++) if (g.src.t[i] > from && g.src.t[i] < to) push([rot.x[i], rot.y[i]], g.src.t[i]);
    }
    push(at(to), to);
    return segRuns(x, y, t, gapMs).runs;
  };
  const { over, dip } = replaySpans(r);
  let tracks = '';
  for (const run of stretch(over)) tracks += `<polyline class="ocs-case" points="${pts(run)}" ${sw(5.4)}/><polyline class="ocs-over" points="${pts(run)}" ${sw(3.2)}/>`;
  const dash = `stroke-dasharray="${(5 * k).toFixed(2)} ${(3.5 * k).toFixed(2)}"`;
  for (const run of stretch(dip)) tracks += `<polyline class="ocs-case" points="${pts(run)}" ${sw(4.6)}/><polyline class="ocs-dip" points="${pts(run)}" ${sw(2.4)} ${dash}/>`;
  const mark = (cls: string, tMs: number | null): string => {
    if (tMs == null || tMs > s.t || tMs < s.win[0]) return '';
    const p = at(tMs);
    return p ? `<circle class="ocs-mark ${cls}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(4.2 * unit).toFixed(2)}" ${sw(1.8)}/>` : '';
  };
  const marks = mark('back', r.wentBackMs) + mark('clear', r.clearedMs);
  // The label: off the line's middle on the pre-start side (away from the first mark), inside the view.
  const rot = rotator(twd);
  const L = rot(a.line.left);
  const R = rot(a.line.right);
  const mid: Vec = [(L[0] + R[0]) / 2, (L[1] + R[1]) / 2];
  const first = a.legPts?.[1];
  const towards = first ? rot(first) : null;
  let n: Vec = [-(R[1] - L[1]), R[0] - L[0]];
  const nl = Math.hypot(n[0], n[1]) || 1;
  n = [n[0] / nl, n[1] / nl];
  if (towards && (towards[0] - mid[0]) * n[0] + (towards[1] - mid[1]) * n[1] > 0) n = [-n[0], -n[1]];
  const text = replayLabel(r);
  const fs = 12 * k;
  const half = textWidth(text, fs) / 2;
  const edge = 6 * unit;
  const cx = Math.min(box.x1 - edge - half, Math.max(box.x0 + edge + half, mid[0] + n[0] * 26 * unit));
  const cy = Math.min(box.y1 - 24 * unit, Math.max(box.y0 + 16 * unit, mid[1] + n[1] * 26 * unit + 4 * unit));
  const label = `<text class="ocs-lbl" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="${fs}" stroke-width="${(3.5 * k).toFixed(2)}" text-anchor="middle">${esc(text)}</text>`;
  return { tracks, marks, label };
}

/** Each drawn boat's gap threshold by id (racing and set aside). */
function gapLookup(a: RaceAnalysis): (id: string) => number {
  const byId = new Map([...a.drawings, ...a.excluded.map((e) => e.drawing)].map((d) => [d.id, d]));
  return (id) => {
    const d = byId.get(id);
    return d ? drawingGapMs(d) : MAP_GAP_S * 1000;
  };
}

/** The point details lookup for what a scrubber frame drew: its windowed fixes and gaps, and its boats' dots. */
export function scrubPoints(a: RaceAnalysis, f: Pick<ScrubFrame, 'pieces' | 'boats'>): MapPoints {
  return mapPointsOf(f.pieces, gapLookup(a), f.boats);
}

/** The point details lookup for the full-race map zoomed in tight on full-rate tracks: the fixes near view `v`. */
export function trackPointsFull(a: RaceAnalysis, leg: number | null, v: View, full: FullRateSet): MapPoints {
  const { view: box, k } = trackMapView(a, leg, v);
  const clip = mapClip(box, k);
  const pieces = a.drawings.flatMap((d) => drawingPieces(a.wind.twdAtGunDeg, d, { leg, clip, full }));
  return mapPointsOf(pieces, gapLookup(a));
}

/** How the map's legs were split: its chip ("legs: mark trackers") and its ⓘ line. */
export function legSplit(a: RaceAnalysis): { chip: string; info: string } {
  switch (a.legSource) {
    case 'fleet':
      return { chip: 'legs: fleet turns', info: 'Legs split where each boat turned (snapped to mark trackers where present).' };
    case 'none':
      return { chip: 'one leg', info: 'One leg: no mark trackers or turns to split the race at.' };
    default:
      return { chip: 'legs: mark trackers', info: "Legs split at each boat's closest approach to the mark trackers." };
  }
}

/** The map's legend doubles as a leg selector: All, then one toggle per leg. */
export function legLegend(a: RaceAnalysis, selected: number | null = null): string {
  const btn = (key: string, pressed: boolean, body: string): string =>
    `<button type="button" class="key" data-leg="${key}" aria-pressed="${pressed}">${body}</button>`;
  return (
    btn('all', selected == null, 'All') +
    a.legs
      .map((l) =>
        btn(
          String(l.index),
          selected === l.index,
          `<i style="background:${legColor(l.index)}"></i>${esc(l.name)}${l.index === a.legs.length - 1 ? ' → finish' : ''}`,
        ),
      )
      .join('')
  );
}
