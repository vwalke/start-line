/**
 * Plain SVG graphics in local metres, rotated so the estimated wind blows
 * from the top of the page. Boats use fixed categorical colour slots by
 * sail order (≤ 8 boats); larger fleets fall back to neutral ink plus
 * direct sail-number labels.
 */
import { primaryDtlM } from '../analysis/findings';
import type { Vec } from '../analysis/geo';
import { awayFromLineThresholdM, lineBias } from '../analysis/line';
import { shownLateS } from '../analysis/validity';
import { PRE_LEG, type BoatDrawing, type BoatResult, type ExcludedBoat, type RaceAnalysis } from '../analysis/types';
import { bowAheadM, raceClass, type ClassDims } from '../data/classes';
import { BOAT_SHAPE_ON_PX, BOAT_SHAPE_PX, boatMark, BOATS_NOT_TO_SCALE, HULL_LABEL_GAP_PX, hullCenterFromBow, hullEnlarged, hullLabelBox, hullOutline, hullPathAt, hullPathD } from './boatShape';
import { esc, f1, f2 } from './format';
import { placeLabels, textWidth, type LabelReq, type Rect, type StartNames } from './labels';
import { mapPoints, mapPointsOf, type MapPoints } from './mapPoints';
import { drawingPieces, rotTrack, rotator, filledRanges, boatAt, endHoldBefore, timeRange, type BoatAt, type FullRateSet, type MapPiece, type PieceOptions, type SrcTrack } from './mapPieces';
import { fillRuleOf, fillTrack } from './gapFill';
import {
  addSogTrack,
  emptySogPaths,
  legRangeList,
  segmentSogRange,
  sogFill,
  sogKnColor,
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
import { FOLLOW_COURSE_S, type FollowInput } from './follow';
import { ocsStretch, ocsSvg } from './ocsStyle';
import { replayLabel } from './replay';
import { Rects, rungDraws, rungsAt, toDrawnBows, type RungDraw } from './rungs';
import type { LadderNow } from '../analysis/coach/ladderNow';
import { visibleExtent, type MapScreen } from './mapExtent';
import { windLabel, WIND_LABEL_WIDEST } from './windArrow';
import { trailPaths, type TrailStretch } from './trail';
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

export { rotator, hullOutline, hullPathD };

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

/**
 * Where "Boats not to scale" sits in view `box`: the bottom right corner, level with the scale bar, or a line above
 * it where the view is too narrow for both side by side; with its box (what the rungs' labels keep clear of).
 */
function scaleNoteAt(box: Box, unit: number, k: number): { x: number; y: number; fs: number; r: Rect } {
  const fs = 11 * k;
  const w = textWidth(BOATS_NOT_TO_SCALE, fs);
  const x = box.x1 - 8 * unit;
  const barEnd = box.x0 + 8 * unit + niceStep((box.x1 - box.x0) / 1.5);
  const y = x - w - 8 * unit < barEnd ? box.y1 - 20 * unit - fs : box.y1 - 8 * unit;
  return { x, y, fs, r: { x0: x - w - 2 * unit, y0: y - fs, x1: x + 2 * unit, y1: y + 0.3 * fs } };
}

function scaleNote(box: Box, unit: number, k: number): string {
  const { x, y, fs } = scaleNoteAt(box, unit, k);
  return `<text class="scale-note" x="${x}" y="${y}" font-size="${fs}" text-anchor="end" stroke-width="${3 * k}">${BOATS_NOT_TO_SCALE}</text>`;
}

/**
 * Whether the boats at the scrubber's time (dotsSvg) are drawn bigger than scale at map scale `unit`: the class's
 * hull shorter on screen than the symbol (the selected boat's, the bigger, when there is one). Zoom only, not per frame.
 */
const boatsEnlarged = (dims: ClassDims | null, highlight: string | null, unit: number): boolean =>
  hullEnlarged(dims, 1 / unit, highlight ? BOAT_SHAPE_ON_PX : BOAT_SHAPE_PX);

/**
 * The wind arrow's label ends this far left of the arrow, screen units: on the Race Viewer clear of it turned to any
 * angle (ui/windArrow.ts: the label's bottom right corner outside the circle the arrow sweeps); on the Start chart,
 * where it never turns, just beside it.
 */
const WIND_LABEL_GAP = 15;
const WIND_LABEL_GAP_FIXED = 6;
/** The arrow's length, screen units, and the room it takes turned to any angle: a circle about its middle. */
const WIND_ARROW_L = 34;
const WIND_ARROW_R = WIND_ARROW_L / 2 + 1;

/**
 * The wind arrow in view `box`'s top right corner: pointing down the wind `twdDeg` blows with (the gun's, at the
 * top of a map drawn wind-up), its label upright beside it, `gap` screen units left of it, with the wind's direction
 * ("wind 272° (est.)", ui/windArrow.ts windLabel). The line and head are their own group (`g.wind-dir`, with their
 * middle in data-cx / data-cy), which the Race Viewer's replay turns to the wind of the moment, the label with it.
 */
function windArrow(box: Box, unit: number, k: number, twdDeg: number, gap: number): string {
  const x = box.x1 - 14 * unit;
  const y = box.y0 + 10 * unit;
  const L = WIND_ARROW_L * unit;
  return `<g class="wind"><g class="wind-dir" data-cx="${x.toFixed(1)}" data-cy="${(y + L / 2).toFixed(1)}"><line x1="${x}" y1="${y}" x2="${x}" y2="${y + L}" stroke-width="${2 * k}"/>
    <path d="M${x - 5 * unit},${y + L - 8 * unit} L${x},${y + L} L${x + 5 * unit},${y + L - 8 * unit}" fill="none" stroke-width="${2 * k}"/></g>
    <text x="${x - gap * unit}" y="${y + 3 * unit}" font-size="${11 * k}" text-anchor="end">${esc(windLabel(twdDeg))}</text></g>`;
}

/** Hulls shorter than this on screen are drawn as the fixed-size marker instead. */
const MIN_HULL_PX = 6;

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
export const startClass = (a: RaceAnalysis): { name: string; dims: ClassDims } | null => raceClass(a.meta);

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
    // As the map draws it: every hole (in the feed's own fixes) filled in (ui/gapFill.ts).
    const trail = fillTrack(d.trail, fillRuleOf(d));
    if (range && !isNc) {
      const n = trail.x.length;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) [x[i], y[i]] = rot([trail.x[i], trail.y[i]]);
      addSogTrack(highlight && highlight !== d.id ? sogTrails.dim : sogTrails.on, x, y, trail.sog, range, (i) => inBox([x[i], y[i]]));
    } else {
      // Only the parts inside the fit box; a trail that leaves and re-enters is drawn as separate runs.
      const runs: Vec[][] = [[]];
      for (let i = 0; i < trail.x.length; i++) {
        const p = rot([trail.x[i], trail.y[i]]);
        const cur = runs[runs.length - 1];
        if (inBox(p)) cur.push(p);
        else if (cur.length) runs.push([]);
      }
      const dest = isNc ? ncTrails : trails;
      for (const run of runs) {
        if (run.length > 1) dest.push(`<polyline class="trail${dim}" points="${pts(run)}" stroke="${col}" stroke-width="${1.5 * k}"${dash}/>`);
      }
    }
    if (!d.bow || d.courseAtGun == null || !b.start) continue;
    const [x, y] = rot(d.bow);
    const st = b.start;
    // Speed: the hull is the biggest thing at the line, so it carries SOG at the gun (the table's Speed @gun),
    // outlined in ink so it reads against the trails. A non-competitor stays hollow grey.
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
    // The ranked figure (Vakaros, else ours), else ours interpolated across a hole, shown like any other.
    const dtlM = primaryDtlM(st) ?? st.dtlM;
    const dtl = dtlM != null ? `${f1(dtlM)} m` : '—';
    boats.push({
      id: b.id,
      cls: `boat${minCls}${dim}`,
      head: `<title>#${esc(b.sail)}${isNc ? ' (not racing)' : ''}: ${f1(dtlM)} m behind (${st.rank?.source === 'vakaros' ? `Vakaros; ours ${f1(st.dtlM)} m` : 'our track check'})${shownLateS(st) != null ? `, ${f1(shownLateS(st))} s late` : ''}, SOG ${f1(st.speedKn)} kn at the gun</title>
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
      const body = sogPathsSvg(acc);
      return body ? `<g class="trail sog${dim}" stroke-width="${(2 * k).toFixed(2)}">${body}</g>` : '';
    };
    trails.push(g(sogTrails.dim, ' dim'), g(sogTrails.on, ''));
  }
  trails.push(...ncTrails);
  const label = range
    ? `Boats relative to the start line at the gun (Vakaros timing); trails and hulls colored by speed over ground, ${f1(range.lo)} to ${f1(range.hi)} kn: blue slowest, through green and yellow, to red fastest`
    : 'Boats relative to the start line at the gun (Vakaros timing)';

  return `<svg viewBox="${view.x0} ${view.y0} ${w} ${h}" class="chart start" role="img"
    shape-rendering="geometricPrecision"
    aria-label="${esc(label)}">
    ${bias.ext}${trails.join('')}${lineSvg}${bias.label}${boatSvg.join('')}
    ${windArrow(view, unit, k, a.wind.twdAtGunDeg, WIND_LABEL_GAP_FIXED)}${scaleBar(view, unit, k)}</svg>`;
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
   * elapsed-time rank (ui/speed.ts). 'sog': trimmed turbo by each boat's own SOG (ui/sog.ts).
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
   * Scrubbing: draw the static map only (lines, marks, wind, scale) with four empty layers for the tracks, the
   * boats' fading trails, a replay's over-the-line tracks (over the trails) and the boats (`g.scrub-trk`,
   * `g.scrub-trails`, `g.scrub-ocs`, `g.scrub-dots`), filled each frame from `scrubFrame`.
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
const rotSeg = (twd: number, seg: SrcTrack): { x: Float64Array; y: Float64Array } => rotTrack(twd, seg);

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

/**
 * A segment as the map draws it in Leg and Rank (holes already filled in: mapPieces.ts filledRanges): runs of two or
 * more points, only near `clip`.
 */
export function segRuns(x: ArrayLike<number>, y: ArrayLike<number>, clip: Box | null = null): Vec[][] {
  const near = nearClip(x, y, clip);
  const runs: Vec[][] = [];
  let cur: Vec[] = [];
  const flush = (): void => {
    if (cur.length > 1) runs.push(cur);
    cur = [];
  };
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (near(i)) cur.push([x[i], y[i]]);
    else flush();
  }
  flush();
  return runs;
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
    for (const pc of piecesOf(d)) {
      let acc = byBoat.get(d.id);
      if (!acc) byBoat.set(d.id, (acc = emptySogPaths()));
      const x = pc.rx.subarray(pc.i0, pc.i1);
      const y = pc.ry.subarray(pc.i0, pc.i1);
      const range = segmentSogRange(a, pc.leg, leg, scale) ?? { lo: 0, hi: 1 };
      addSogTrack(acc, x, y, pc.src.sog.subarray(pc.i0, pc.i1), range, nearClip(x, y, clip));
    }
  }
  const out: string[] = [];
  let sel = '';
  for (const [id, acc] of byBoat) {
    const on = highlight === id;
    const w = on ? SOG_W_ON : SOG_W;
    const body = sogPathsSvg(acc);
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

/** The map's point details lookup (every drawn point of leg `leg`, or all, in map coordinates): ui/mapPoints.ts. */
export function trackPoints(a: RaceAnalysis, leg: number | null): MapPoints {
  return mapPoints(a, leg, (seg) => rotSeg(a.wind.twdAtGunDeg, seg));
}

/**
 * The track map's fit box for leg `leg` (or all), and the rectangle its viewBox shows for `v` (default Fit). Sizes
 * (mapScale) follow only the rectangle's size, i.e. the zoom level: a pan at the same zoom moves just the viewBox,
 * with the wind arrow and scale bar (`g.map-hud`, in the view's corners) shifted along (ui/mapPaint.ts).
 */
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

/**
 * The map's window and its sizes: map units per on-screen unit (`unit`), and the stroke/font scale `k`; and what is
 * visible of it on screen `scr` (ui/mapExtent.ts: with the bands either side), the window itself with no screen.
 * `vis` is a scratch box, refilled by the next mapScale: read it before then.
 */
interface MapScale {
  box: Box;
  unit: number;
  k: number;
  vis: Box;
}

function mapScale(box: Box, scr?: MapScreen | null): MapScale {
  const unit = Math.max(box.x1 - box.x0, box.y1 - box.y0) / 600;
  return { box, unit, k: unit, vis: visibleExtent(box, scr, visScratch) };
}
const visScratch: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** The tracks as drawn: the tracks, the selected boat's on top, Rank's labels; and the pieces drawn. */
interface TrackLayer {
  paths: string;
  hi: string;
  labels: string;
  pieces: MapPiece[];
}

/** Track before the gun (no leg) in Leg and Rank: neutral ink, thin. */
const PRE_COLOR = 'var(--ink-3)';

/**
 * The map's tracks for pieces `po` (the whole race, or the scrubber's window), coloured by leg, rank or
 * boat speed, every hole filled in (ui/gapFill.ts) and drawn as the rest. Track before the gun is neutral in Leg
 * and Rank, by SOG in Boat speed.
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
  const hi: string[] = [];
  /** Rank mode: [draw order, svg]; unranked first, then slowest → fastest, the selection last. */
  const ordered: [number, string][] = [];
  /** Rank mode: where the picked boat's segments outside the top N end, and its rank there. */
  const pickLabels: { at: Vec; leg: number; rank: number }[] = [];
  // Boat speed draws its own layer (above); the per-segment polylines are for Leg
  // and Rank. A picked non-competitor is still a grey dashed polyline in every mode.
  for (const d of opts.colour === 'sog' ? (nc ? [nc.drawing] : []) : drawings) {
    const isNc = d === nc?.drawing;
    for (const grp of pieceGroups(piecesOf(d))) {
      const runs: Vec[][] = [];
      for (const pc of grp.pieces) runs.push(...segRuns(pc.rx.subarray(pc.i0, pc.i1), pc.ry.subarray(pc.i0, pc.i1), clip));
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
      const cls0 = ['trk spd', st.kind === 'picked-out' ? 'picked' : st.t == null ? st.kind : st.tier, on ? 'on' : ''].filter(Boolean).join(' ');
      for (const run of runs) {
        const p = pts(run);
        const cls = cls0;
        const op = `stroke-opacity="${st.opacity.toFixed(2)}"`;
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
  return { paths: paths.join(''), hi: hi.join(''), labels, pieces: drawn };
}

interface MarkLabel {
  m: RaceAnalysis['marks'][number];
  /** The mark's points, map units. */
  ps: Vec[];
  /** The label's anchor, its text and its box (anchor + text width, a font-size high, padded). */
  at: Vec;
  name: string;
  box: Rect;
  /** False where it would overlap a label before it (skipped). */
  shown: boolean;
}

/** The marks and their labels as trackMap draws them at map scale `unit`, `k`: right of each mark's rightmost point, a label that would overlap one before it skipped. */
function markLabels(a: RaceAnalysis, unit: number, k: number): MarkLabel[] {
  const rot = rotator(a.wind.twdAtGunDeg);
  const labelPad = 3 * unit;
  const taken: Rect[] = [];
  return a.marks.map((m) => {
    const ps = m.xy.map(rot);
    const top = ps.reduce((x, y) => (y[0] > x[0] ? y : x));
    const name = m.estimated ? `${m.name.replace(/ mark$/i, '')} (est.)` : m.name;
    const at: Vec = [top[0] + 9 * unit, top[1] + 4 * unit];
    const fs = 12 * k;
    const box: Rect = { x0: at[0] - labelPad, y0: at[1] - fs - labelPad, x1: at[0] + textWidth(name, fs) + labelPad, y1: at[1] + labelPad };
    const shown = !taken.some((q) => box.x0 < q.x1 && q.x0 < box.x1 && box.y0 < q.y1 && q.y0 < box.y1);
    if (shown) taken.push(box);
    return { m, ps, at, name, box, shown };
  });
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
  const marks = markLabels(a, unit, k)
    .map(({ m, ps, at, name, shown }) => {
      // Turns placed from the tracks (no tracker): hollow, dashed, labelled "(est.)".
      const cls = m.estimated ? 'mark est' : 'mark';
      const dash = m.estimated ? ` stroke-dasharray="${(3 * k).toFixed(2)} ${(2 * k).toFixed(2)}"` : '';
      // A mark shown by its role ("Reach mark") keeps the feed's own name as its tooltip.
      const tip = m.title ? `<title>${esc(m.title)}</title>` : '';
      const c = ps.map((p) => `<circle class="${cls}" cx="${p[0]}" cy="${p[1]}" r="${5.5 * unit}" stroke-width="${1.5 * k}"${dash}${tip ? `>${tip}</circle>` : '/>'}`).join('');
      if (!shown) return c;
      return `${c}<text x="${at[0]}" y="${at[1]}" font-size="${12 * k}" class="lbl${m.estimated ? ' est' : ''}">${tip}${esc(name)}</text>`;
    })
    .join('');
  const fl = a.finishLine;
  // An estimated finish shares the committee-boat end with the start line: always drawn, dashed, labelled "(est.)".
  const finish =
    fl && (a.finishLineEstimated || Math.hypot(fl.left[0] - a.line.left[0], fl.left[1] - a.line.left[1]) + Math.hypot(fl.right[0] - a.line.right[0], fl.right[1] - a.line.right[1]) > 20)
      ? (() => {
          const [p, q] = [rot(fl.left), rot(fl.right)];
          const right = q[0] >= p[0];
          const at: Vec = [q[0] + (right ? 6 : -6) * unit, q[1] + 4 * unit];
          if (!a.finishLineEstimated) {
            return (
              `<line class="finishline" x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke-width="${2 * k}"/>` +
              `<text x="${at[0]}" y="${at[1]}" font-size="${12 * k}" class="lbl" text-anchor="${right ? 'start' : 'end'}">Finish</text>`
            );
          }
          const dash = ` stroke-dasharray="${(3 * k).toFixed(2)} ${(2 * k).toFixed(2)}"`;
          return (
            `<line class="finishline est" x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke-width="${1.5 * k}"${dash}/>` +
            `<text x="${at[0]}" y="${at[1]}" font-size="${12 * k}" class="lbl est" text-anchor="${right ? 'start' : 'end'}">Finish (est.)</text>`
          );
        })()
      : '';

  const legRanges = perLeg ? legRangeList(a) : '';
  const sogLabel =
    opts.colour !== 'sog'
      ? ''
      : perLeg
        ? `colored by boat speed (SOG), scaled within each leg${legRanges ? ` (${legRanges})` : ''}: blue slowest on that leg, through green and yellow, to red fastest`
        : `colored by boat speed (SOG)${sog ? `, ${f1(sog.lo)} to ${f1(sog.hi)} kn` : ''}: blue slowest, through green and yellow, to red fastest`;
  const label =
    leg == null
      ? speed
        ? `Race Viewer, tracks colored by speed, ${speed.overall ? 'race time' : 'rank on each leg'}: yellow and boldest fastest`
        : sogLabel
          ? `Race Viewer, tracks ${sogLabel}`
          : 'Race Viewer, tracks colored by leg'
      : `Race Viewer on ${a.legs[leg]?.name ?? 'one leg'}${speed ? ', tracks colored by speed on the leg: yellow and boldest fastest' : sogLabel ? `, tracks ${sogLabel}` : ''}`;
  const note = opts.scrub && boatsEnlarged(startDims(a), highlight, unit) ? scaleNote(box, unit, k) : '';
  const tracks = layer ? `${layer.paths}${layer.hi}` : '<g class="scrub-trk"></g><g class="scrub-trails"></g><g class="scrub-ocs"></g><g class="scrub-rungs"></g>';
  const top = layer ? layer.labels : '<g class="scrub-dots"></g>';
  return `<svg viewBox="${box.x0} ${box.y0} ${w} ${h}" class="chart map${opts.scrub ? ' scrub' : ''}" role="img" aria-label="${esc(opts.scrub ? `${label}; boats at the scrubber's time` : label)}">
    ${tracks}
    <line class="startline" x1="${L[0]}" y1="${L[1]}" x2="${R[0]}" y2="${R[1]}" stroke-width="${2.5 * k}"/>${finish}${marks}${top}
    <g class="map-hud">${windArrow(box, unit, k, a.wind.twdAtGunDeg, WIND_LABEL_GAP)}${scaleBar(box, unit, k)}${note}</g></svg>`;
}

// ---- race-time scrubber (Map B) ---------------------------------------------------

/**
 * The scrubber's moment: time `t`, the trail drawn ([t − trail, t]), and full-rate tracks when zoomed in tight.
 * `trailMs` (a short trail: 30 s, or the default BOAT_TRAIL_MS): each boat's own fading trail of that length
 * (ui/trail.ts) instead of the map's tracks over `win`; null (All, a card's window): the tracks.
 */
export interface ScrubAt {
  t: number;
  win: [number, number];
  full?: FullRateSet | null;
  trailMs?: number | null;
  /** The fleet up the wind ladder at `t` (coach/ladderNow.ts), for the ladder rungs (ui/rungs.ts); null or absent: none drawn. */
  ladder?: LadderNow | null;
  /** The map on screen (ui/mapExtent.ts), so the rungs reach the card's edges; absent: the view drawn's. */
  screen?: MapScreen | null;
}

/** One boat's fading trail: path data per fade slice (ui/trail.ts TRAIL_FADE); its color (`cd`: by night), class and width (map units). */
export interface BoatTrail {
  id: string;
  stroke: string;
  cd?: string;
  cls: string;
  w: number;
  d: string[];
}

/**
 * One scrubber frame: the tracks (into `g.scrub-trk`), the boats' fading trails (into `g.scrub-trails`, by
 * ui/trailLayer.ts, which reuses their paths), a replay's over-the-line tracks (into `g.scrub-ocs`, over the
 * trails), the ladder rungs (into `g.scrub-rungs`, by ui/rungs.ts paintRungs, which reuses their elements), the
 * boats and labels (into `g.scrub-dots`), and what they were drawn from.
 */
export interface ScrubFrame {
  tracks: string;
  trails: BoatTrail[];
  ocs: string;
  /** Kept and refilled frame to frame (ui/rungs.ts rungDraws). */
  rungs: readonly RungDraw[];
  dots: string;
  pieces: MapPiece[];
  boats: BoatAt[];
}

/** Until when boat `id` is held past its final fix (mapPieces.ts endHoldBefore): before its finish, if it has one. */
const endHoldOf = (a: RaceAnalysis, id: string): number => endHoldBefore(a.boats.find((b) => b.id === id)?.finishMs);

/** Every drawn boat (and a picked one not racing) at time `t`: mapPieces.ts boatAt, from the full-rate track when there is one. */
export function boatsAt(a: RaceAnalysis, highlight: string | null, t: number, full?: FullRateSet | null): BoatAt[] {
  const nc = pickedExcluded(a, highlight);
  const out: BoatAt[] = [];
  for (const d of nc ? [...a.drawings, nc.drawing] : a.drawings) {
    const b = boatAt(d.id, filledRanges(d, true, full?.get(d.id)), t, a.wind.twdAtGunDeg, endHoldOf(a, d.id));
    if (b) out.push(b);
  }
  return out;
}

/**
 * The follow camera's input (follow.ts) for boat `id` at `t` (ms) on the track map: where boatAt has it, its course
 * each second over the FOLLOW_COURSE_S before (none while held past its final fix), and the wind (straight down: the map is
 * drawn wind-up); null: not placed at `t`.
 */
export function mapFollowInput(a: RaceAnalysis, id: string, t: number, full?: FullRateSet | null): FollowInput | null {
  const nc = pickedExcluded(a, id);
  const d = a.drawings.find((x) => x.id === id) ?? nc?.drawing;
  if (!d) return null;
  const ranges = filledRanges(d, true, full?.get(d.id));
  const twd = a.wind.twdAtGunDeg;
  const endHold = endHoldOf(a, d.id);
  const at = (ms: number): BoatAt | null => boatAt(d.id, ranges, ms, twd, endHold);
  const now = at(t);
  if (!now) return null;
  const dirs: (Vec | null)[] = [];
  for (let i = 0; i < FOLLOW_COURSE_S; i++) {
    const b = i ? at(t - i * 1000) : now;
    dirs.push(b && !b.hold ? b.dir : null);
  }
  return { t: t / 1000, pos: [now.mx, now.my], dirs, down: Number.isFinite(twd) ? [0, 1] : null };
}

/** Up to this many boats, every dot is labelled with its sail number; a bigger fleet labels only the selected boat. */
export const DOT_LABEL_MAX = SLOTS;

/** A dot's colour by the map's colouring: day, and night where it differs. */
function dotColour(a: RaceAnalysis, b: BoatAt, leg: number | null, opts: TrackMapOptions, speed: ReturnType<typeof speedRanking> | null, highlight: string | null): { c: string; cd?: string } {
  if (pickedExcluded(a, highlight)?.result.id === b.id) return { c: NC_COLOR };
  if (opts.colour === 'sog') {
    const r = segmentSogRange(a, b.leg, leg, opts.sogScale ?? 'leg');
    if (!r || !Number.isFinite(b.sog)) return { c: PRE_COLOR };
    return { c: sogKnColor(b.sog, r), cd: sogKnColor(b.sog, r, 'dark') };
  }
  if (b.leg === PRE_LEG) return { c: PRE_COLOR };
  if (!speed) return { c: legColor(b.leg) };
  const st = speedStyle(speed.at(b.id, b.leg), opts.top ?? 'all', highlight === b.id ? 'this' : 'none');
  if (st.kind === 'picked-out') return { c: 'var(--ink)' };
  return st.t == null ? { c: PRE_COLOR } : { c: speedColor(st.t), cd: speedColor(st.t, 'dark') };
}

/**
 * The boats at the scrubber's time: coloured as the map is (the leg the boat is on, its rank there, or its SOG),
 * each the start chart's hull (ui/boatShape.ts boatMark: to scale, or a fixed-size symbol at any zoom that trackMap
 * notes as "Boats not to scale"; along its course over ground, or its last heading known while held past its final
 * fix or slow) drawn from its bow (data/classes.ts bowAheadM ahead of the tracker; a fixed-size symbol reaches further
 * aft) where it can be, else a dot with a short tick along its course; filled while its data is fresh, hollow (same
 * color, a heavier outline) once it is lost; the selected
 * boat bigger, on top and labelled (every boat labelled in a small fleet); boats off a leg shown, faint. Each boat's
 * box and its label's go into `taken` (what the ladder rungs' labels keep clear of), and its bow as drawn into
 * drawnBows (the ladder rungs meet it).
 */
function dotsSvg(a: RaceAnalysis, highlight: string | null, leg: number | null, opts: TrackMapOptions, boats: readonly BoatAt[], sc: MapScale, taken?: Rects): string {
  const { unit, k } = sc;
  const speed = opts.colour === 'rank' ? speedRanking(a, leg, opts.rankBy ?? 'leg') : null;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const nc = pickedExcluded(a, highlight);
  if (nc) byId.set(nc.result.id, nc.result);
  const labelAll = a.boats.length <= DOT_LABEL_MAX;
  const vs = new Set(opts.vs ?? []);
  const dims = startDims(a);
  const out: string[] = [];
  const vsOut: string[] = [];
  let sel = '';
  bowStamp++;
  for (const b of boats) {
    const on = highlight === b.id;
    const cmp = !on && vs.has(b.id);
    const { c, cd } = dotColour(a, b, leg, opts, speed, highlight);
    const style = cd ? ` style="--cd:${cd}"` : '';
    const shape = boatMark({ dir: b.dir, lastDir: b.lastDir, hold: b.hold, stale: b.stale, sog: b.sog, dims, pxPerM: 1 / unit, minPx: on ? BOAT_SHAPE_ON_PX : BOAT_SHAPE_PX });
    const hollow = shape.hollow;
    // A hull's half-length, or the dot's radius: what the label and the comparison ring keep clear of.
    const r = 'shape' in shape ? Math.max(shape.dims.loaM / 2, (on ? 6 : 4.2) * unit) : (on ? 6 : 4.2) * unit;
    // A hull from its bow (its middle `mid`), a dot on the tracker.
    const who = byId.get(b.id);
    const bowM = 'shape' in shape ? bowAheadM(who?.bowOffsetM, dims) : 0;
    const mid: Vec = 'shape' in shape ? hullCenterFromBow([b.mx, b.my], shape.shape, bowM, shape.dims) : [b.mx, b.my];
    keepBow(b.id, 'shape' in shape ? b.mx + shape.shape[0] * bowM : b.mx, 'shape' in shape ? b.my + shape.shape[1] * bowM : b.my);
    const cls = ['dot', 'shape' in shape ? 'hull' : '', b.hold ? 'hold' : '', hollow ? 'lost' : '', on ? 'on' : cmp ? 'vs' : highlight ? 'dim' : '', leg != null && b.leg !== leg ? 'off' : ''].filter(Boolean).join(' ');
    const [x, y] = [b.mx.toFixed(1), b.my.toFixed(1)];
    const tick =
      'dot' in shape && b.dir && !b.hold && !hollow
        ? `<line class="dot-hdg" x1="${x}" y1="${y}" x2="${(b.mx + b.dir[0] * (r + 6 * unit)).toFixed(1)}" y2="${(b.my + b.dir[1] * (r + 6 * unit)).toFixed(1)}" stroke-width="${((on ? 2 : 1.4) * k).toFixed(2)}"/>`
        : '';
    // Hollow: the outline in the boat's color (`--c`, and `--cd` by night: style.css), a little heavier so it reads.
    const fill = hollow ? `fill="var(--surface)" style="--c:${c}${cd ? `;--cd:${cd}` : ''}"` : `fill="${c}"${style}`;
    const ring =
      'shape' in shape
        ? `<path class="${cls}" data-id="${esc(b.id)}" d="${hullPathAt(mid, shape.shape, shape.dims)}" ${fill} stroke-width="${((hollow ? (on ? 2.2 : 1.5) : on ? 1.4 : 0.8) * k).toFixed(2)}"/>`
        : `<circle class="${cls}" data-id="${esc(b.id)}" cx="${x}" cy="${y}" r="${r.toFixed(2)}" ${fill} stroke-width="${((hollow ? (on ? 2.2 : 1.6) : on ? 1.8 : 1) * k).toFixed(2)}"/>`;
    const vsRing = cmp ? `<circle class="dot-vs" cx="${mid[0].toFixed(1)}" cy="${mid[1].toFixed(1)}" r="${(r + 2.6 * unit).toFixed(2)}" stroke-width="${(1.6 * k).toFixed(2)}"/>` : '';
    const sail = who ? who.sail : b.id;
    const fs = (on ? 12 : 10.5) * k;
    // Beside a hull: HULL_LABEL_GAP_PX off it abeam (clear of its track), at any zoom; beside a dot: up and right of it.
    const lbl = 'shape' in shape ? hullLabelBox(mid, shape.shape, shape.dims, textWidth(sail, fs), 1.1 * fs, HULL_LABEL_GAP_PX * unit) : null;
    const [lx, ly] = lbl ? [lbl.x0, lbl.y0 + 0.85 * fs] : [b.mx + r + 3 * unit, b.my - r];
    const labelled = on || cmp || labelAll;
    if (taken) {
      taken.add(mid[0] - r, mid[1] - r, mid[0] + r, mid[1] + r);
      if (labelled && lbl) taken.add(lbl.x0, lbl.y0, lbl.x1, lbl.y1);
      else if (labelled) taken.add(lx, ly - fs, lx + textWidth(sail, fs), ly + 0.3 * fs);
    }
    const text =
      labelled
        ? `<text class="dot-lbl${on ? ' on' : cmp ? ' vs' : ''}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="${fs}" stroke-width="${(3 * k).toFixed(2)}">${esc(sail)}</text>`
        : '';
    const svg = `<g class="boat-at${on ? ' on' : cmp ? ' vs' : highlight ? ' dim' : ''}">${vsRing}${tick}${ring}${text}</g>`;
    if (on) sel = svg;
    else (cmp ? vsOut : out).push(svg);
  }
  // The comparison boats over the rest, the selected boat on top.
  return out.join('') + vsOut.join('') + sel;
}

/**
 * One scrubber frame for time `s.t`: the boats there, and behind them either their fading trails (`s.trailMs`) or
 * the map's tracks over `s.win` (pre-gun track included).
 */
export function scrubFrame(a: RaceAnalysis, highlight: string | null, leg: number | null, opts: TrackMapOptions, s: ScrubAt): ScrubFrame {
  const { view: box, k: zoom } = trackMapView(a, leg, opts.view);
  const sc = mapScale(box, s.screen);
  const clip = mapClip(box, zoom);
  const po: PieceOptions = { leg, win: s.win, clip, pre: true, full: s.full };
  const layer = s.trailMs ? null : trackLayer(a, highlight, leg, opts, po, sc);
  const boats = boatsAt(a, highlight, s.t, s.full);
  // What the rungs' labels keep clear of: the boats and their labels (dotsSvg), the marks and the corners' wind arrow and scale bar.
  rungTaken.clear();
  const dots = dotsSvg(a, highlight, leg, opts, boats, sc, s.ladder ? rungTaken : undefined);
  rungBoats = rungTaken.n;
  const r = opts.replay && opts.replay.boat === highlight && leg == null ? replaySvg(a, opts.replay, s, sc) : null;
  // Short trails: the pieces over the window too (the point details and a card's comparison casing read them).
  const nc = pickedExcluded(a, highlight);
  const pieces = layer ? layer.pieces : (nc ? [...a.drawings, nc.drawing] : a.drawings).flatMap((d) => drawingPieces(a.wind.twdAtGunDeg, d, po));
  const tracks = layer ? `${vsCasing(pieces, opts.vs, highlight, sc)}${layer.paths}${layer.hi}` : vsCasing(pieces, opts.vs, highlight, sc);
  return {
    tracks,
    ocs: r?.tracks ?? '',
    trails: s.trailMs ? boatTrails(a, highlight, leg, opts, boats, s.t, s.trailMs, s.full, clip, sc) : [],
    rungs: s.ladder ? mapRungs(a, highlight, s.ladder, sc, rungTaken) : noRungs,
    dots: (r?.marks ?? '') + (layer?.labels ?? '') + dots + (r?.label ?? ''),
    pieces,
    boats,
  };
}

const noRungs: readonly RungDraw[] = [];

/** Each boat's bow as dotsSvg last drew it, map units, and the frame it was drawn in (bowStamp): kept frame to frame. */
const drawnBows = new Map<string, Float64Array>();
let bowStamp = 0;
function keepBow(id: string, x: number, y: number): void {
  let p = drawnBows.get(id);
  if (!p) drawnBows.set(id, (p = new Float64Array(3)));
  p[0] = x;
  p[1] = y;
  p[2] = bowStamp;
}
/** Boat `id`'s bow as the last frame drew it; null when it wasn't drawn then. */
export const drawnBow = (id: string): Float64Array | null => {
  const p = drawnBows.get(id);
  return p && p[2] === bowStamp ? p : null;
};
/** The boxes the rungs' labels keep clear of, kept frame to frame (scrubFrame fills it). */
const rungTaken = new Rects();
/** How many of them are the boats' (the rest, the marks, corners and labels, are added again for each view). */
let rungBoats = 0;

/** The marks' boxes (each point and its label, and the finish line's label) at map scale `unit`, kept per race and scale. */
const markBoxes = new WeakMap<RaceAnalysis, { unit: number; boxes: Rect[] }>();
function markBoxesAt(a: RaceAnalysis, unit: number, k: number): Rect[] {
  const hit = markBoxes.get(a);
  if (hit && hit.unit === unit) return hit.boxes;
  const boxes: Rect[] = [];
  const r = 7 * unit;
  for (const l of markLabels(a, unit, k)) {
    for (const [x, y] of l.ps) boxes.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
    if (l.shown) boxes.push(l.box);
  }
  const fl = a.finishLine;
  if (fl) {
    const rot = rotator(a.wind.twdAtGunDeg);
    const [p, q] = [rot(fl.left), rot(fl.right)];
    const right = q[0] >= p[0];
    const fs = 12 * k;
    const w = textWidth(a.finishLineEstimated ? 'Finish (est.)' : 'Finish', fs);
    const x = q[0] + (right ? 6 : -6) * unit;
    const y = q[1] + 4 * unit;
    boxes.push({ x0: right ? x : x - w, y0: y - fs, x1: right ? x + w : x, y1: y + 0.3 * fs });
  }
  markBoxes.set(a, { unit, boxes });
  return boxes;
}

/**
 * The wind arrow's and the scale bar's boxes in view `box` (windArrow, scaleBar: the top right and bottom left
 * corners), the arrow's turned to any angle; and the bottom right's "Boats not to scale" when it is drawn (`note`).
 */
function hudBoxes(box: Box, unit: number, k: number, taken: Rects, note: boolean): void {
  const x = box.x1 - 14 * unit;
  const y = box.y0 + 10 * unit;
  const cy = y + (WIND_ARROW_L / 2) * unit;
  const r = WIND_ARROW_R * unit;
  taken.add(x - r, cy - r, x + r, cy + r);
  taken.add(x - WIND_LABEL_GAP * unit - textWidth(WIND_LABEL_WIDEST, 11 * k), y + 3 * unit - 11 * k, x - WIND_LABEL_GAP * unit, y + 3 * unit + 2 * k);
  const step = niceStep((box.x1 - box.x0) / 1.5);
  const sx = box.x0 + 8 * unit;
  const sy = box.y1 - 8 * unit;
  taken.add(sx - 2 * unit, sy - 4 * unit - 11 * k, sx + step + 2 * unit, sy + 2 * k);
  if (!note) return;
  const { r: n } = scaleNoteAt(box, unit, k);
  taken.add(n.x0, n.y0, n.x1, n.y1);
}

/**
 * The ladder rungs at the scrubber's moment (ui/rungs.ts) in the view drawn `sc`: the leader's and the selected
 * boat's, on a beat or a run, square to the wind then, edge to edge across what is visible (`sc.vis`); labelled "Leader" and with the
 * selected boat's sail number and distance behind it, clear of `taken` (the boats and their labels) and the marks, wind
 * arrow, scale bar and "Boats not to scale".
 * Kept and refilled frame to frame.
 */
function mapRungs(a: RaceAnalysis, highlight: string | null, now: LadderNow, sc: MapScale, taken: Rects): readonly RungDraw[] {
  const mapTwdDeg = a.wind.twdAtGunDeg;
  const rungs = rungsAt({ now, selected: highlight, mapTwdDeg });
  if (!rungs.length) return noRungs;
  toDrawnBows(rungs, drawnBow);
  taken.n = rungBoats;
  const marks = markBoxesAt(a, sc.unit, sc.k);
  for (let i = 0; i < marks.length; i++) taken.add(marks[i].x0, marks[i].y0, marks[i].x1, marks[i].y1);
  hudBoxes(sc.box, sc.unit, sc.k, taken, boatsEnlarged(rungText(a).dims, highlight, sc.unit));
  return rungDraws(rungs, sc, rungText(a), taken);
}

const rungTexts = new WeakMap<RaceAnalysis, { sail: (id: string) => string; dims: ClassDims | null }>();
/** What the rungs' labels say for race `a`: sail numbers, and lengths for a known class. */
function rungText(a: RaceAnalysis): { sail: (id: string) => string; dims: ClassDims | null } {
  let t = rungTexts.get(a);
  if (!t) {
    const sails = new Map(a.boats.map((b) => [b.id, b.sail]));
    rungTexts.set(a, (t = { sail: (id) => sails.get(id) ?? id, dims: startDims(a) }));
  }
  return t;
}

/**
 * The ladder rungs alone for a view moved without a redraw (ui/app.ts: a slow gesture's viewBox moves): the frame's
 * boats are where they were, so their boxes (kept from the last scrubFrame) still hold; the lines and labels follow the view.
 */
export function scrubRungs(a: RaceAnalysis, highlight: string | null, leg: number | null, opts: TrackMapOptions, now: LadderNow | null, screen?: MapScreen | null): readonly RungDraw[] {
  if (!now) return noRungs;
  const { view: box } = trackMapView(a, leg, opts.view);
  return mapRungs(a, highlight, now, mapScale(box, screen), rungTaken);
}

/**
 * Each placed boat's fading trail over the last `lenMs` before `t` (ui/trail.ts): in the boat's color now (as its
 * hull: leg, rank or SOG, a picked boat not racing grey), dimmed with it when another boat is selected and faint
 * off the leg shown; through every hole, filled in (ui/gapFill.ts); from the full-rate track when zoomed in tight;
 * near `clip` only. The comparison boats over the
 * rest, the selected boat last (on top).
 */
function boatTrails(
  a: RaceAnalysis,
  highlight: string | null,
  leg: number | null,
  opts: TrackMapOptions,
  boats: readonly BoatAt[],
  t: number,
  lenMs: number,
  full: FullRateSet | null | undefined,
  clip: Box | null,
  sc: MapScale,
): BoatTrail[] {
  const twd = a.wind.twdAtGunDeg;
  const speed = opts.colour === 'rank' ? speedRanking(a, leg, opts.rankBy ?? 'leg') : null;
  const nc = pickedExcluded(a, highlight);
  const byId = new Map((nc ? [...a.drawings, nc.drawing] : a.drawings).map((d) => [d.id, d]));
  const vs = new Set(opts.vs ?? []);
  const out: BoatTrail[] = [];
  const vsOut: BoatTrail[] = [];
  let sel: BoatTrail | null = null;
  for (const b of boats) {
    const d = byId.get(b.id);
    if (!d) continue;
    const stretches: TrailStretch[] = [];
    for (const r of filledRanges(d, leg == null, full?.get(d.id))) {
      if (leg != null && r.leg !== leg) continue;
      const [i0, i1] = timeRange(r.src.t, t - lenMs, t, r.lo, r.hi);
      if (i1 <= i0) continue;
      const { x, y } = rotTrack(twd, r.src);
      stretches.push({ t: r.src.t, x, y, i0, i1 });
    }
    // The trail runs up to the boat (not while it is held at its last fix, nor from another leg than the one shown).
    const head: Vec | null = !b.hold && (leg == null || b.leg === leg) ? [b.mx, b.my] : null;
    const paths = trailPaths(stretches, t, lenMs, head, clip);
    if (!paths.some(Boolean)) continue;
    const on = highlight === b.id;
    const cmp = !on && vs.has(b.id);
    const { c, cd } = dotColour(a, b, leg, opts, speed, highlight);
    const cls = ['btrail', on ? 'on' : cmp ? 'vs' : highlight ? 'dim' : '', leg != null && b.leg !== leg ? 'off' : ''].filter(Boolean).join(' ');
    const tr: BoatTrail = { id: b.id, stroke: c, ...(cd ? { cd } : {}), cls, w: +((on ? 2.6 : 1.6) * sc.k).toFixed(2), d: paths };
    if (on) sel = tr;
    else (cmp ? vsOut : out).push(tr);
  }
  return [...out, ...vsOut, ...(sel ? [sel] : [])];
}

/** The comparison boats' trails (Map D): an ink casing under their own lines, from the pieces the frame drew. */
function vsCasing(pieces: readonly MapPiece[], vs: readonly string[] | null | undefined, highlight: string | null, sc: MapScale): string {
  if (!vs?.length) return '';
  const ids = new Set(vs.filter((id) => id !== highlight));
  let out = '';
  for (const pc of pieces) {
    if (!ids.has(pc.id)) continue;
    for (const run of segRuns(pc.rx.subarray(pc.i0, pc.i1), pc.ry.subarray(pc.i0, pc.i1))) out += `<polyline class="trk-vs" data-id="${esc(pc.id)}" points="${pts(run)}" stroke-width="${(3.4 * sc.k).toFixed(2)}"/>`;
  }
  return out;
}

/**
 * A replay's highlight at the scrubber's moment: the boat's track over the line (warning red) and its dip back
 * (red dashed), each only as far as `s.t` and within the trail, read from the source the map draws (the
 * full-rate track when there is one) and cut at the facts' times on it;
 * a ring where it went back and a dot where it recrossed, once reached; the label just off the line on the
 * pre-start side, kept inside the view.
 */
function replaySvg(a: RaceAnalysis, r: StartReplay, s: ScrubAt, sc: MapScale): { tracks: string; marks: string; label: string } {
  const { box, unit, k } = sc;
  const twd = a.wind.twdAtGunDeg;
  const d = a.drawings.find((x) => x.id === r.boat);
  if (!d) return { tracks: '', marks: '', label: '' };
  // Drawn as the Start tab's "Start Playback" view draws it (ui/ocsStyle.ts), from the source the map draws.
  const { tracks, marks } = ocsSvg(ocsStretch(r, filledRanges(d, true, s.full?.get(d.id)), twd, s.t, s.win), { unit });
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

/** The point details lookup for what a scrubber frame drew: its windowed points, and its boats' dots. */
export function scrubPoints(f: Pick<ScrubFrame, 'pieces' | 'boats'>): MapPoints {
  return mapPointsOf(f.pieces, f.boats);
}

/** The point details lookup for the full-race map zoomed in tight on full-rate tracks: the fixes near view `v`. */
export function trackPointsFull(a: RaceAnalysis, leg: number | null, v: View, full: FullRateSet): MapPoints {
  const { view: box, k } = trackMapView(a, leg, v);
  const clip = mapClip(box, k);
  const pieces = a.drawings.flatMap((d) => drawingPieces(a.wind.twdAtGunDeg, d, { leg, clip, full }));
  return mapPointsOf(pieces);
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
