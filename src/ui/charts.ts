/**
 * Plain SVG graphics in local metres, rotated so the estimated wind blows
 * from the top of the page. Boats use fixed categorical colour slots by
 * sail order (≤ 8 boats); larger fleets fall back to neutral ink plus
 * direct sail-number labels.
 */
import { primaryDtlM } from '../analysis/findings';
import { add, bearingVec, dot, median, scale, sub, type Vec } from '../analysis/geo';
import type { BoatResult, RaceAnalysis } from '../analysis/types';
import { classDims, type ClassDims } from '../data/classes';
import { esc, f1 } from './format';

const SLOTS = 8;

export const boatColor = (b: BoatResult, fleet: number): string =>
  fleet <= SLOTS ? `var(--s${b.colorSlot + 1})` : 'var(--ink-2)';
export const legColor = (i: number): string => `var(--s${(i % SLOTS) + 1})`;

/** Rotation that puts the wind direction (FROM) at the top; y flipped for SVG. */
export function rotator(twdDeg: number): (p: Vec) => Vec {
  const th = (twdDeg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return ([x, y]) => [x * c - y * s, -(x * s + y * c)];
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
 * Centre for a zoomed start view (screen coords, zw × zh view): the focused
 * boat's bow if any; else halfway between the fleet's median bow and its
 * foot-point on line L–R when both fit in the view, else the median bow.
 */
export function zoomCentre(bows: Vec[], L: Vec, R: Vec, focus: Vec | null, zw: number, zh: number): Vec {
  if (focus) return focus;
  if (!bows.length) return scale(add(L, R), 0.5);
  const m: Vec = [median(bows.map((p) => p[0])), median(bows.map((p) => p[1]))];
  const lr = sub(R, L);
  const t = Math.max(0, Math.min(1, dot(sub(m, L), lr) / Math.max(dot(lr, lr), 1e-9)));
  const foot = add(L, scale(lr, t));
  // Both points sit ±half their separation from the midpoint; keep a 10% margin.
  const fits = Math.abs(m[0] - foot[0]) <= 0.9 * zw && Math.abs(m[1] - foot[1]) <= 0.9 * zh;
  return fits ? scale(add(m, foot), 0.5) : m;
}

function startView(a: RaceAnalysis, zoom: number, focusId: string | null = null) {
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
  // Zoom shrinks the view around the selected boat or the fleet, keeping the aspect.
  const zw = (box.x1 - box.x0) / zoom;
  const zh = (box.y1 - box.y0) / zoom;
  let view = box;
  if (zoom !== 1) {
    const bows = a.drawings.filter((d) => d.bow).map((d) => rot(d.bow!));
    const focus = a.drawings.find((d) => d.id === focusId)?.bow;
    const c = zoomCentre(bows, L, R, focus ? rot(focus) : null, zw, zh);
    view = { x0: c[0] - zw / 2, x1: c[0] + zw / 2, y0: c[1] - zh / 2, y1: c[1] + zh / 2 };
  }
  return { rot, L, R, box, view, unit: zw / 600 }; // unit: ~1 css px at 600 px wide
}

function startDims(a: RaceAnalysis): ClassDims | null {
  return classDims(a.meta.boatClass) ?? classDims(a.meta.division);
}

/** The class dims when hulls are drawn to scale at this zoom, else null (markers). */
export function startHullScale(a: RaceAnalysis, zoom = 1): ClassDims | null {
  const dims = startDims(a);
  return dims && dims.loaM / startView(a, zoom).unit >= MIN_HULL_PX ? dims : null;
}

/** Boats vs the line at the gun: to-scale hulls (or markers) at the bow, 30 s trails. */
export function startSnapshot(a: RaceAnalysis, highlight: string | null, zoom = 1): string {
  const { rot, L, R, box, view, unit } = startView(a, zoom, highlight);
  const fleet = a.boats.length;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const w = view.x1 - view.x0;
  const h = view.y1 - view.y0;
  const k = unit;
  const dims = startHullScale(a, zoom);
  const minCls = startDims(a) && !dims ? ' boat-min' : '';

  const trails: string[] = [];
  const boats: string[] = [];
  for (const d of a.drawings) {
    const b = byId.get(d.id)!;
    const col = boatColor(b, fleet);
    const dim = highlight && highlight !== d.id ? ' dim' : '';
    const tr: Vec[] = [];
    for (let i = 0; i < d.trail.x.length; i++) {
      const p = rot([d.trail.x[i], d.trail.y[i]]);
      if (p[0] > box.x0 && p[0] < box.x1 && p[1] > box.y0 && p[1] < box.y1) tr.push(p);
    }
    if (tr.length > 1) trails.push(`<polyline class="trail${dim}" points="${pts(tr)}" stroke="${col}" stroke-width="${1.5 * k}"/>`);
    if (!d.bow || d.courseAtGun == null || !b.start) continue;
    const [x, y] = rot(d.bow);
    const st = b.start;
    let shape: string;
    if (dims && d.headingAtSample != null) {
      // True scale, along heading (not COG): the bow tip is the DTL bow point.
      const hull = hullOutline(d.bow, d.headingAtSample, dims).map(rot);
      shape = `<path class="hull" d="${hullPathD(hull)}" fill="${col}" stroke="var(--surface)" stroke-width="${0.75 * k}"/>`;
    } else {
      const ang = d.courseAtGun - a.wind.twdAtGunDeg; // screen angle, 0 = up the page (into the wind)
      const s = 10 * unit;
      const tip = `0,${-s * 1.3}`;
      const tri = `<polygon points="${tip} ${s * 0.7},${s * 0.9} 0,${s * 0.4} ${-s * 0.7},${s * 0.9}" fill="${col}" stroke="var(--surface)" stroke-width="${1.5 * k}"/>`;
      const ring = minCls ? `<circle class="min-ring" r="${13 * unit}" stroke="${col}" stroke-width="${k}" stroke-dasharray="${2 * k} ${2 * k}"/>` : '';
      shape = `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">${ring}<g transform="rotate(${ang.toFixed(1)})">${tri}</g></g>`;
    }
    boats.push(`<g class="boat${minCls}${dim}" data-id="${esc(b.id)}">
      <title>#${esc(b.sail)}: ${f1(primaryDtlM(st))} m behind${st.rcDtlM != null ? ` (ours ${f1(st.dtlM)} m)` : ''}, ${f1(st.secsLate)} s late, ${f1(st.speedKn)} kn</title>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${16 * unit}" fill="transparent"/>
      ${shape}
      <g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <text x="${11 * unit}" y="${-2 * unit}" font-size="${13 * k}" class="lbl">${esc(b.sail)}</text>
      <text x="${11 * unit}" y="${11 * unit}" font-size="${11 * k}" class="sub">${f1(primaryDtlM(st))} m</text></g></g>`);
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

/** Whole-race tracks, coloured by leg. */
export function trackMap(a: RaceAnalysis, highlight: string | null): string {
  const rot = rotator(a.wind.twdAtGunDeg);
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  grow(box, rot(a.line.left));
  grow(box, rot(a.line.right));
  for (const m of a.marks) for (const p of m.xy) grow(box, rot(p));
  const paths: string[] = [];
  const hi: string[] = [];
  for (const d of a.drawings) {
    for (const seg of d.segments) {
      const ps: Vec[] = [];
      for (let i = 0; i < seg.x.length; i++) {
        const p = rot([seg.x[i], seg.y[i]]);
        grow(box, p);
        ps.push(p);
      }
      if (ps.length < 2) continue;
      const cls = highlight ? (highlight === d.id ? 'trk on' : 'trk dim') : 'trk';
      const svg = `<polyline class="${cls}" points="${pts(ps)}" stroke="${legColor(seg.leg)}" STROKE/>`;
      (highlight === d.id ? hi : paths).push(svg);
    }
  }
  const pad = 0.06 * Math.max(box.x1 - box.x0, box.y1 - box.y0);
  box.x0 -= pad;
  box.x1 += pad;
  box.y0 -= pad;
  box.y1 += pad;
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const unit = Math.max(w, h) / 600;
  const k = unit;
  const stroke = (s: string, width: number): string => s.replace('STROKE', `stroke-width="${(width * k).toFixed(2)}"`);

  const L = rot(a.line.left);
  const R = rot(a.line.right);
  const marks = a.marks
    .map((m) => {
      const ps = m.xy.map(rot);
      const c = ps.map((p) => `<circle class="mark" cx="${p[0]}" cy="${p[1]}" r="${5.5 * unit}" stroke-width="${1.5 * k}"/>`).join('');
      const top = ps.reduce((x, y) => (y[0] > x[0] ? y : x));
      return `${c}<text x="${top[0] + 9 * unit}" y="${top[1] + 4 * unit}" font-size="${12 * k}" class="lbl">${esc(m.name)}</text>`;
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

  return `<svg viewBox="${box.x0} ${box.y0} ${w} ${h}" class="chart map" role="img" aria-label="Tracks coloured by leg">
    ${paths.map((s) => stroke(s, 1.2)).join('')}${hi.map((s) => stroke(s, 2.6)).join('')}
    <line class="startline" x1="${L[0]}" y1="${L[1]}" x2="${R[0]}" y2="${R[1]}" stroke-width="${2.5 * k}"/>${finish}${marks}
    ${windArrow(box, unit, k, 'wind (est.)')}${scaleBar(box, unit, k)}</svg>`;
}

export function legLegend(a: RaceAnalysis): string {
  return a.legs
    .map((l) => `<span class="key"><i style="background:${legColor(l.index)}"></i>${esc(l.name)}${l.index === a.legs.length - 1 ? ' → finish' : ''}</span>`)
    .join('');
}
