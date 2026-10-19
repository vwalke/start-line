/**
 * Plain SVG graphics in local metres, rotated so the estimated wind blows
 * from the top of the page. Boats use fixed categorical colour slots by
 * sail order (≤ 8 boats); larger fleets fall back to neutral ink plus
 * direct sail-number labels.
 */
import { primaryDtlM } from '../analysis/findings';
import { add, bearingVec, scale, type Vec } from '../analysis/geo';
import { lineBias } from '../analysis/line';
import type { BoatDrawing, BoatResult, ExcludedBoat, RaceAnalysis } from '../analysis/types';
import { matchClass, type ClassDims } from '../data/classes';
import type { SpeedRank } from '../analysis/speedRank';
import { boatLabel, duration, esc, f1, f2 } from './format';
import { placeLabels, textWidth, type LabelReq, type Rect, type StartNames } from './labels';
import {
  addSogTrack,
  emptySogPaths,
  legRangeList,
  segmentSogRange,
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

/** Rotation that puts the wind direction (FROM) at the top; y flipped for SVG. */
export function rotator(twdDeg: number): (p: Vec) => Vec {
  const th = (twdDeg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return ([x, y]) => [x * c - y * s, -(x * s + y * c)];
}

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

function startFrame(a: RaceAnalysis, widthPx?: number) {
  const rot = rotator(a.wind.twdAtGunDeg);
  const L = rot(a.line.left);
  const R = rot(a.line.right);
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  grow(box, L);
  grow(box, R);
  for (const d of a.drawings) if (d.bow) grow(box, rot(d.bow));
  // Room for the trails, but don't let one boat far from the line shrink everyone else.
  const mid = rot([(a.line.left[0] + a.line.right[0]) / 2, (a.line.left[1] + a.line.right[1]) / 2]);
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

function startView(a: RaceAnalysis, v?: View, widthPx?: number) {
  const { rot, L, R, box } = startFrame(a, widthPx);
  // A window onto the fit box with the same aspect.
  const vb = viewBox(box, clampView(box, v ?? fitView(box)));
  const view: Box = { x0: vb.x0, y0: vb.y0, x1: vb.x0 + vb.w, y1: vb.y0 + vb.h };
  return { rot, L, R, box, view, unit: vb.w / 600 }; // unit: ~1 css px at 600 px wide
}

/** The class the hulls are sized from: the division's boat class, then its name, then the event's class label; with the name that matched. */
export const startClass = (a: RaceAnalysis): { name: string; dims: ClassDims } | null =>
  matchClass([a.meta.boatClass, a.meta.division, a.meta.classLabel]);

const startDims = (a: RaceAnalysis): ClassDims | null => startClass(a)?.dims ?? null;

/** The class dims when hulls are drawn to scale in this view (default Fit), else null (markers). */
export function startHullScale(a: RaceAnalysis, v?: View, widthPx?: number): ClassDims | null {
  const dims = startDims(a);
  return dims && dims.loaM / startView(a, v, widthPx).unit >= MIN_HULL_PX ? dims : null;
}

/** The start caption's scale note: hulls to scale (class, LOA), markers at this zoom, or no dimensions for the class. */
export function startScaleCaption(a: RaceAnalysis, v?: View, widthPx?: number): string {
  const cls = startClass(a);
  if (!cls) return `Hulls not to scale: no dimensions for class "${a.meta.boatClass}". Arrows follow course over ground.`;
  const spec = `${cls.name}, ${f2(cls.dims.loaM)} m`;
  return startHullScale(a, v, widthPx)
    ? `Hulls to scale (${spec}); they point along heading.`
    : `Markers not to scale at this zoom (${spec} hulls would be under ${MIN_HULL_PX} px; zoom in to draw them). Arrows follow course over ground.`;
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
}

/**
 * Boats vs the line at the gun: to-scale hulls (or markers) at the bow, START_TRAIL_MS trails.
 * `colour` 'speed': trails shaded by SOG (ui/sog.ts, range fitted to the trails) and each hull
 * filled by its SOG at the gun; 'boat' (default): the boat's own colour. The line is continued
 * dashed past each end with the favoured end labelled (ui/startLine.ts); names per `opts.names`.
 */
export function startSnapshot(a: RaceAnalysis, highlight: string | null, v?: View, colour: StartColour = 'boat', opts: StartOptions = {}): string {
  const { rot, L, R, box, view, unit } = startView(a, v, opts.widthPx);
  const fleet = a.boats.length;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const w = view.x1 - view.x0;
  const h = view.y1 - view.y0;
  const k = unit;
  const names = opts.names ?? 'auto';
  const tk = k * (opts.widthPx ? Math.max(1, NAME_MIN_W / opts.widthPx) : 1);
  const nameFs = NAME_FS * tk;
  const dtlFs = DTL_FS * tk;
  const dims = startHullScale(a, v, opts.widthPx);
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

/** The fixed points a leg runs between: the line or previous mark, and its own mark or the finish. */
function legEnds(a: RaceAnalysis, leg: number): Vec[] {
  const out: Vec[] = [];
  if (leg === 0) out.push(a.line.left, a.line.right);
  if (leg === a.legs.length - 1 && a.finishLine) out.push(a.finishLine.left, a.finishLine.right);
  const names = new Set([a.legs[leg - 1]?.to, leg < a.legs.length - 1 ? a.legs[leg].to : undefined]);
  for (const m of a.marks) if (names.has(m.name)) out.push(...m.xy);
  return out;
}

/** The track map's view: everything, or one leg's segments plus its marks; padded. */
export function mapBox(a: RaceAnalysis, leg: number | null = null): Box {
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
}

/** Tooltip for a speed-coloured segment. */
function speedTitle(who: string, legName: string, r: SpeedRank | undefined, overall: boolean): string {
  if (!r) return `${who} · ${legName} · ${overall ? 'did not finish' : 'did not complete'}`;
  const time = Number.isFinite(r.timeS) ? ` · ${r.gapS != null ? `~${duration(r.timeS)} (telemetry gap ${Math.round(r.gapS)} s)` : duration(r.timeS)}` : '';
  return `${who} · ${legName} · ${overall ? 'overall ' : ''}#${r.rank} of ${r.of}${time}`;
}

/** Each boat's drawn segments (leg `leg`, or all) in map coordinates, as the map draws them. */
function mapTracks(a: RaceAnalysis, leg: number | null): IndexedTrack[] {
  const rot = rotator(a.wind.twdAtGunDeg);
  const out: IndexedTrack[] = [];
  for (const d of a.drawings) {
    for (const seg of d.segments) {
      if (leg != null && seg.leg !== leg) continue;
      const n = seg.x.length;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) [x[i], y[i]] = rot([seg.x[i], seg.y[i]]);
      out.push({ id: d.id, x, y, t: seg.t, sog: seg.sog, leg: seg.leg });
    }
  }
  return out;
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
function sogLayer(a: RaceAnalysis, highlight: string | null, leg: number | null, k: number, scale: SogScale): string {
  const byBoat = new Map<string, SogPaths>();
  for (const tk of mapTracks(a, leg)) {
    let acc = byBoat.get(tk.id);
    if (!acc) byBoat.set(tk.id, (acc = emptySogPaths()));
    addSogTrack(acc, tk.x, tk.y, tk.t, tk.sog, segmentSogRange(a, tk.leg, leg, scale) ?? { lo: 0, hi: 1 });
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

/** Whole-race tracks coloured by leg (or by speed rank, or boat speed), or only leg `leg` (fitted to it). */
export function trackMap(a: RaceAnalysis, highlight: string | null, leg: number | null = null, opts: TrackMapOptions = {}): string {
  const rot = rotator(a.wind.twdAtGunDeg);
  const box = mapBox(a, leg);
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const unit = Math.max(w, h) / 600;
  const k = unit;
  const sw = (width: number): string => `stroke-width="${(width * k).toFixed(2)}"`;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const legName = (i: number): string => a.legs[i]?.name ?? `Leg ${i + 1}`;
  const speed = opts.colour === 'rank' ? speedRanking(a, leg, opts.rankBy ?? 'leg') : null;
  const sogScale = opts.sogScale ?? 'leg';
  const perLeg = opts.colour === 'sog' && leg == null && sogScale === 'leg';
  const sog = opts.colour === 'sog' ? trackSogRange(a, leg) : null;
  // A picked boat that isn't racing: grey and dashed on top, split at the fleet's
  // leg times. It never moves the fit, and Rank / Boat speed never colour it.
  const nc = pickedExcluded(a, highlight);
  if (nc) byId.set(nc.result.id, nc.result);
  const drawings = nc ? [...a.drawings, nc.drawing] : a.drawings;

  const paths: string[] = opts.colour === 'sog' ? [sogLayer(a, highlight, leg, k, sogScale)] : [];
  const hi: string[] = [];
  /** Rank mode: [draw order, svg]; unranked first, then slowest → fastest, the selection last. */
  const ordered: [number, string][] = [];
  /** Rank mode: where the picked boat's segments outside the top N end, and its rank there. */
  const pickLabels: { at: Vec; leg: number; rank: number }[] = [];
  // Boat speed draws its own layer (above); the per-segment polylines are for Leg
  // and Rank. A picked non-competitor is still a grey dashed polyline in every mode.
  for (const d of opts.colour === 'sog' ? (nc ? [nc.drawing] : []) : drawings) {
    const isNc = d === nc?.drawing;
    const who = esc(boatLabel(byId.get(d.id), d.id));
    for (const seg of d.segments) {
      if (leg != null && seg.leg !== leg) continue;
      const ps: Vec[] = [];
      for (let i = 0; i < seg.x.length; i++) ps.push(rot([seg.x[i], seg.y[i]]));
      if (ps.length < 2) continue;
      const p = pts(ps);
      if (isNc) {
        const dash = `stroke-dasharray="${(5 * k).toFixed(2)} ${(4 * k).toFixed(2)}"`;
        const title = `<title>${who} · ${esc(legName(seg.leg))} · not racing</title>`;
        const svg = `<polyline class="trk on nc" data-leg="${seg.leg}" data-id="${esc(d.id)}" points="${p}" stroke="${NC_COLOR}" ${dash} ${sw(2.6)}>${title}</polyline>`;
        if (speed) ordered.push([2, svg]);
        else hi.push(svg);
        continue;
      }
      if (!speed) {
        const cls = highlight ? (highlight === d.id ? 'trk on' : 'trk dim') : 'trk';
        const width = highlight === d.id ? 2.6 : 1.2;
        const svg = `<polyline class="${cls}" data-leg="${seg.leg}" points="${p}" stroke="${legColor(seg.leg)}" ${sw(width)}><title>${who} · ${esc(legName(seg.leg))}</title></polyline>`;
        (highlight === d.id ? hi : paths).push(svg);
        continue;
      }
      const r = speed.at(d.id, seg.leg);
      const on = highlight === d.id;
      const st = speedStyle(r, opts.top ?? 'all', on ? 'this' : highlight ? 'other' : 'none');
      const title = `<title>${esc(speedTitle(boatLabel(byId.get(d.id), d.id), legName(seg.leg), r, speed.overall))}</title>`;
      const attrs = `data-leg="${seg.leg}" data-id="${esc(d.id)}" points="${p}"`;
      // Grey strokes are classed by why (unranked / out of the top N), coloured ones by tier, a picked boat past N 'picked'.
      const cls = ['trk spd', st.kind === 'picked-out' ? 'picked' : st.t == null ? st.kind : st.tier, on ? 'on' : ''].filter(Boolean).join(' ');
      const op = `stroke-opacity="${st.opacity.toFixed(2)}"`;
      let svg: string;
      if (st.kind === 'picked-out' && r) {
        // Ink over a surface casing: no rank colour, so it can't pass for one of the top N; its rank is labelled instead.
        svg = `<polyline class="spd-pick-case" points="${p}" ${sw(st.width + 2.4)}/><polyline class="${cls}" ${attrs} ${sw(st.width)} ${op}>${title}</polyline>`;
        const end = ps[ps.length - 1];
        // Overall: one label, at the end of the track; each leg: one per segment.
        if (!speed.overall) pickLabels.push({ at: end, leg: seg.leg, rank: r.rank });
        else if (!pickLabels[0] || seg.leg >= pickLabels[0].leg) pickLabels[0] = { at: end, leg: seg.leg, rank: r.rank };
      } else if (st.t == null) {
        const dash = st.kind === 'unranked' ? ` stroke-dasharray="${(3 * k).toFixed(2)} ${(2.5 * k).toFixed(2)}"` : '';
        svg = `<polyline class="${cls}" ${attrs} ${sw(st.width)} ${op}${dash}>${title}</polyline>`;
      } else {
        // Selection: an ink outline under the boat's own colour. Otherwise, by day, a thin dark casing under the pale fast end, as faint as its stroke.
        const casing = on
          ? `<polyline class="spd-sel" points="${p}" ${sw(st.width + 2.4)}/>`
          : casedByDay(st.t)
            ? `<polyline class="spd-case" points="${p}" ${sw(st.width + 1)} stroke-opacity="${(0.55 * st.opacity).toFixed(2)}"/>`
            : '';
        svg = `${casing}<polyline class="${cls}" ${attrs} stroke="${speedColor(st.t)}" style="--cd:${speedColor(st.t, 'dark')}" ${sw(st.width)} ${op}>${title}</polyline>`;
      }
      ordered.push([on ? 2 : r ? 1 - r.t : -1, svg]);
    }
  }
  if (speed) {
    ordered.sort((x, y) => x[0] - y[0]);
    paths.push(...ordered.map(([, s]) => s));
  }

  // Beside the end point, on the side with more room.
  const rankLabels = pickLabels
    .map(({ at: [x, y], rank }) => {
      const right = x < (box.x0 + box.x1) / 2;
      return `<text class="spd-pick-lbl" x="${(x + (right ? 7 : -7) * unit).toFixed(1)}" y="${(y + 4 * unit).toFixed(1)}" font-size="${12 * k}" stroke-width="${(3 * k).toFixed(2)}" text-anchor="${right ? 'start' : 'end'}">#${rank}</text>`;
    })
    .join('');

  const L = rot(a.line.left);
  const R = rot(a.line.right);
  const marks = a.marks
    .map((m) => {
      const ps = m.xy.map(rot);
      // Turns placed from the tracks (no tracker): hollow, dashed, labelled "(est.)".
      const cls = m.estimated ? 'mark est' : 'mark';
      const dash = m.estimated ? ` stroke-dasharray="${(3 * k).toFixed(2)} ${(2 * k).toFixed(2)}"` : '';
      const c = ps.map((p) => `<circle class="${cls}" cx="${p[0]}" cy="${p[1]}" r="${5.5 * unit}" stroke-width="${1.5 * k}"${dash}/>`).join('');
      const top = ps.reduce((x, y) => (y[0] > x[0] ? y : x));
      const name = m.estimated ? `${m.name.replace(/ mark$/i, '')} (est.)` : m.name;
      return `${c}<text x="${top[0] + 9 * unit}" y="${top[1] + 4 * unit}" font-size="${12 * k}" class="lbl${m.estimated ? ' est' : ''}">${esc(name)}</text>`;
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
  return `<svg viewBox="${box.x0} ${box.y0} ${w} ${h}" class="chart map" role="img" aria-label="${esc(label)}">
    ${paths.join('')}${hi.join('')}
    <line class="startline" x1="${L[0]}" y1="${L[1]}" x2="${R[0]}" y2="${R[1]}" stroke-width="${2.5 * k}"/>${finish}${marks}${rankLabels}
    ${windArrow(box, unit, k, 'wind (est.)')}${scaleBar(box, unit, k)}</svg>`;
}

/** How the map's legs were split, for its caption. */
export function legSplitCaption(a: RaceAnalysis): string {
  switch (a.legSource) {
    case 'fleet':
      return `Legs split where each boat turned at the top and bottom of the course (snapped to the mark trackers where present)${a.marks.some((m) => m.estimated) ? '; hollow marks are estimated from the tracks' : ''}.`;
    case 'none':
      return 'One leg: no mark trackers or turns to split the race at.';
    default:
      return "Legs split at each boat's closest approach to the mark trackers.";
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
