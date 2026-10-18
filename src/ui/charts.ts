/**
 * Plain SVG graphics in local metres, rotated so the estimated wind blows
 * from the top of the page. Boats use fixed categorical colour slots by
 * sail order (≤ 8 boats); larger fleets fall back to neutral ink plus
 * direct sail-number labels.
 */
import { primaryDtlM } from '../analysis/findings';
import { add, bearingVec, scale, type Vec } from '../analysis/geo';
import type { BoatDrawing, BoatResult, ExcludedBoat, RaceAnalysis } from '../analysis/types';
import { classDims, type ClassDims } from '../data/classes';
import type { SpeedRank } from '../analysis/speedRank';
import { duration, esc, f1 } from './format';
import { casedByDay, speedColor, speedRanking, speedStyle, type RankBy, type SpeedTop, type TrackColour } from './speed';
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

/** The start chart's Fit box: the line, bows and nearby trails, padded. */
export function startFitBox(a: RaceAnalysis): Box {
  return startFrame(a).box;
}

function startFrame(a: RaceAnalysis) {
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
  return { rot, L, R, box };
}

function startView(a: RaceAnalysis, v?: View) {
  const { rot, L, R, box } = startFrame(a);
  // A window onto the fit box with the same aspect.
  const vb = viewBox(box, clampView(box, v ?? fitView(box)));
  const view: Box = { x0: vb.x0, y0: vb.y0, x1: vb.x0 + vb.w, y1: vb.y0 + vb.h };
  return { rot, L, R, box, view, unit: vb.w / 600 }; // unit: ~1 css px at 600 px wide
}

function startDims(a: RaceAnalysis): ClassDims | null {
  return classDims(a.meta.boatClass) ?? classDims(a.meta.division);
}

/** The class dims when hulls are drawn to scale in this view (default Fit), else null (markers). */
export function startHullScale(a: RaceAnalysis, v?: View): ClassDims | null {
  const dims = startDims(a);
  return dims && dims.loaM / startView(a, v).unit >= MIN_HULL_PX ? dims : null;
}

/** Boats vs the line at the gun: to-scale hulls (or markers) at the bow, START_TRAIL_MS trails. */
export function startSnapshot(a: RaceAnalysis, highlight: string | null, v?: View): string {
  const { rot, L, R, box, view, unit } = startView(a, v);
  const fleet = a.boats.length;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const w = view.x1 - view.x0;
  const h = view.y1 - view.y0;
  const k = unit;
  const dims = startHullScale(a, v);
  const minCls = startDims(a) && !dims ? ' boat-min' : '';

  const trails: string[] = [];
  const boats: string[] = [];
  // A picked boat that isn't racing is drawn on top, grey and dashed; otherwise it isn't drawn at all.
  const nc = pickedExcluded(a, highlight);
  const items: { d: BoatDrawing; b: BoatResult; nc: boolean }[] = a.drawings.map((d) => ({ d, b: byId.get(d.id)!, nc: false }));
  if (nc) items.push({ d: nc.drawing, b: nc.result, nc: true });
  for (const { d, b, nc: isNc } of items) {
    const col = boatColor(b, fleet);
    const dim = (highlight && highlight !== d.id ? ' dim' : '') + (isNc ? ' nc' : '');
    const dash = isNc ? ` stroke-dasharray="${(4 * k).toFixed(2)} ${(3 * k).toFixed(2)}"` : '';
    // Only the parts inside the fit box; a trail that leaves and re-enters is drawn as separate runs.
    const runs: Vec[][] = [[]];
    for (let i = 0; i < d.trail.x.length; i++) {
      const p = rot([d.trail.x[i], d.trail.y[i]]);
      if (p[0] > box.x0 && p[0] < box.x1 && p[1] > box.y0 && p[1] < box.y1) runs[runs.length - 1].push(p);
      else if (runs[runs.length - 1].length) runs.push([]);
    }
    for (const tr of runs) {
      if (tr.length > 1) trails.push(`<polyline class="trail${dim}" points="${pts(tr)}" stroke="${col}" stroke-width="${1.5 * k}"${dash}/>`);
    }
    if (!d.bow || d.courseAtGun == null || !b.start) continue;
    const [x, y] = rot(d.bow);
    const st = b.start;
    let shape: string;
    if (dims && d.headingAtSample != null) {
      // True scale, along heading (not COG): the bow tip is the DTL bow point.
      const hull = hullOutline(d.bow, d.headingAtSample, dims).map(rot);
      shape = isNc
        ? `<path class="hull" d="${hullPathD(hull)}" fill="none" stroke="${col}" stroke-width="${1.2 * k}"${dash}/>`
        : `<path class="hull" d="${hullPathD(hull)}" fill="${col}" stroke="var(--surface)" stroke-width="${0.75 * k}"/>`;
    } else {
      const ang = d.courseAtGun - a.wind.twdAtGunDeg; // screen angle, 0 = up the page (into the wind)
      const s = 10 * unit;
      const tip = `0,${-s * 1.3}`;
      const tri = `<polygon points="${tip} ${s * 0.7},${s * 0.9} 0,${s * 0.4} ${-s * 0.7},${s * 0.9}" ${
        isNc ? `fill="none" stroke="${col}"${dash}` : `fill="${col}" stroke="var(--surface)"`
      } stroke-width="${1.5 * k}"/>`;
      const ring = minCls ? `<circle class="min-ring" r="${13 * unit}" stroke="${col}" stroke-width="${k}" stroke-dasharray="${2 * k} ${2 * k}"/>` : '';
      shape = `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">${ring}<g transform="rotate(${ang.toFixed(1)})">${tri}</g></g>`;
    }
    boats.push(`<g class="boat${minCls}${dim}" data-id="${esc(b.id)}">
      <title>#${esc(b.sail)}${isNc ? ' (not racing)' : ''}: ${st.rank ? `${f1(st.rank.m)} m behind (${st.rank.source === 'vakaros' ? `Vakaros; ours ${st.dtlGapS != null ? '~' : ''}${f1(st.dtlM)} m` : 'our track check'})` : `no reliable distance (ours ~${f1(st.dtlM)} m)`}${st.lateS != null ? `, ${f1(st.lateS)} s late` : ''}, ${f1(st.speedKn)} kn</title>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${16 * unit}" fill="transparent"/>
      ${shape}
      <g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <text x="${11 * unit}" y="${-2 * unit}" font-size="${13 * k}" class="lbl">${esc(b.sail)}</text>
      <text x="${11 * unit}" y="${11 * unit}" font-size="${11 * k}" class="sub">${primaryDtlM(st) != null ? `${f1(primaryDtlM(st))} m` : st.dtlGapS != null ? `~${f1(st.dtlM)} m` : '—'}</text></g></g>`);
  }

  const lineSvg = `<line class="startline" x1="${L[0]}" y1="${L[1]}" x2="${R[0]}" y2="${R[1]}" stroke-width="${2.5 * k}"/>
    <circle class="pin" cx="${L[0]}" cy="${L[1]}" r="${6 * unit}"/>
    <rect class="rc" x="${R[0] - 6 * unit}" y="${R[1] - 6 * unit}" width="${12 * unit}" height="${12 * unit}"/>
    <text x="${L[0]}" y="${L[1] - 11 * unit}" font-size="${11 * k}" text-anchor="middle" class="endlbl">PIN</text>
    <text x="${R[0]}" y="${R[1] - 11 * unit}" font-size="${11 * k}" text-anchor="middle" class="endlbl">RC</text>`;

  return `<svg viewBox="${view.x0} ${view.y0} ${w} ${h}" class="chart start" role="img"
    shape-rendering="geometricPrecision"
    aria-label="Boats relative to the start line at the gun (Vakaros timing)">
    ${trails.join('')}${lineSvg}${boats.join('')}
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
  /** 'leg' (default): one colour per leg. 'speed': plasma and emphasis by elapsed-time rank (ui/speed.ts). */
  colour?: TrackColour;
  /** Whole race in Speed: rank each leg's segment on that leg, or the whole track by race time. */
  rankBy?: RankBy;
  /** Speed: colour only the top N (per leg when ranking each leg); the rest faint grey. Default all. */
  top?: SpeedTop;
}

/** "#851 Name", as the boat list labels boats. */
const boatLabel = (b: BoatResult | undefined, id: string): string =>
  b ? `#${b.sail}${b.name !== `#${b.sail}` ? ` ${b.name}` : ''}` : id;

/** Tooltip for a speed-coloured segment. */
function speedTitle(who: string, legName: string, r: SpeedRank | undefined, overall: boolean): string {
  if (!r) return `${who} · ${legName} · ${overall ? 'did not finish' : 'did not complete'}`;
  const time = Number.isFinite(r.timeS) ? ` · ${r.gapS != null ? `~${duration(r.timeS)} (telemetry gap ${Math.round(r.gapS)} s)` : duration(r.timeS)}` : '';
  return `${who} · ${legName} · ${overall ? 'overall ' : ''}#${r.rank} of ${r.of}${time}`;
}

/** Whole-race tracks coloured by leg (or by speed rank), or only leg `leg` (fitted to it). */
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
  const speed = opts.colour === 'speed' ? speedRanking(a, leg, opts.rankBy ?? 'leg') : null;
  // A picked boat that isn't racing: grey and dashed on top, split at the fleet's
  // leg times. It never moves the fit, and Speed never ranks it.
  const nc = pickedExcluded(a, highlight);
  if (nc) byId.set(nc.result.id, nc.result);
  const drawings = nc ? [...a.drawings, nc.drawing] : a.drawings;

  const paths: string[] = [];
  const hi: string[] = [];
  /** Speed mode: [draw order, svg]; unranked first, then slowest → fastest, the selection last. */
  const ordered: [number, string][] = [];
  for (const d of drawings) {
    const isNc = d === nc?.drawing;
    const who = esc(boatLabel(byId.get(d.id), d.id));
    for (const seg of d.segments) {
      if (leg != null && seg.leg !== leg) continue;
      const ps: Vec[] = [];
      for (let i = 0; i < seg.x.length; i++) ps.push(rot([seg.x[i], seg.y[i]]));
      if (ps.length < 2) continue;
      const p = pts(ps);
      if (isNc) {
        const dash = ` stroke-dasharray="${(5 * k).toFixed(2)} ${(4 * k).toFixed(2)}"`;
        const title = `<title>${who} · ${esc(legName(seg.leg))} · not racing</title>`;
        const svg = `<polyline class="trk on nc" data-leg="${seg.leg}" data-id="${esc(d.id)}" points="${p}" stroke="${NC_COLOR}" ${sw(2.6)}${dash}>${title}</polyline>`;
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
      // Grey strokes are classed by why (unranked / out of the top N), coloured ones by tier.
      const cls = ['trk spd', st.t == null ? st.kind : st.tier, on ? 'on' : ''].filter(Boolean).join(' ');
      const op = `stroke-opacity="${st.opacity.toFixed(2)}"`;
      let svg: string;
      if (st.t == null) {
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

  const label =
    leg == null
      ? speed
        ? `Tracks coloured by speed, ${speed.overall ? 'race time' : 'rank on each leg'}: yellow and boldest fastest`
        : 'Tracks coloured by leg'
      : `Tracks on ${a.legs[leg]?.name ?? 'one leg'}${speed ? ', coloured by speed on the leg: yellow and boldest fastest' : ''}`;
  return `<svg viewBox="${box.x0} ${box.y0} ${w} ${h}" class="chart map" role="img" aria-label="${esc(label)}">
    ${paths.join('')}${hi.join('')}
    <line class="startline" x1="${L[0]}" y1="${L[1]}" x2="${R[0]}" y2="${R[1]}" stroke-width="${2.5 * k}"/>${finish}${marks}
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
