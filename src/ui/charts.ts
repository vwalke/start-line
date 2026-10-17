/**
 * Plain SVG graphics in local metres, rotated so the estimated wind blows
 * from the top of the page. Boats use fixed categorical colour slots by
 * sail order (≤ 8 boats); larger fleets fall back to neutral ink plus
 * direct sail-number labels.
 */
import type { Vec } from '../analysis/geo';
import type { BoatResult, RaceAnalysis } from '../analysis/types';
import { esc, f1 } from './format';

const SLOTS = 8;

export const boatColor = (b: BoatResult, fleet: number): string =>
  fleet <= SLOTS ? `var(--s${b.colorSlot + 1})` : 'var(--ink-2)';
export const legColor = (i: number): string => `var(--s${(i % SLOTS) + 1})`;

/** Rotation that puts the wind direction (FROM) at the top; y flipped for SVG. */
function rotator(twdDeg: number): (p: Vec) => Vec {
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

/** Boats vs the line at the gun: bow positions, heading arrows, 30 s trails. */
export function startSnapshot(a: RaceAnalysis, highlight: string | null): string {
  const rot = rotator(a.wind.twdAtGunDeg);
  const L = rot(a.line.left);
  const R = rot(a.line.right);
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  grow(box, L);
  grow(box, R);
  const fleet = a.boats.length;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
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
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const unit = w / 600; // ~1 css px at 600 px wide
  const k = unit;

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
    if (!d.bow || d.headingAtGun == null || !b.start) continue;
    const [x, y] = rot(d.bow);
    const ang = d.headingAtGun - a.wind.twdAtGunDeg; // screen angle, 0 = up
    const s = 10 * unit;
    const tip = `0,${-s * 1.3}`;
    const tri = `<polygon points="${tip} ${s * 0.7},${s * 0.9} 0,${s * 0.4} ${-s * 0.7},${s * 0.9}" fill="${col}" stroke="var(--surface)" stroke-width="${1.5 * k}"/>`;
    const st = b.start;
    boats.push(`<g class="boat${dim}" data-id="${esc(b.id)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <title>#${esc(b.sail)}: ${f1(st.dtlM)} m behind, ${f1(st.secsLate)} s late, ${f1(st.speedKn)} kn</title>
      <circle r="${16 * unit}" fill="transparent"/>
      <g transform="rotate(${ang.toFixed(1)})">${tri}</g>
      <text x="${11 * unit}" y="${-2 * unit}" font-size="${13 * k}" class="lbl">${esc(b.sail)}</text>
      <text x="${11 * unit}" y="${11 * unit}" font-size="${11 * k}" class="sub">${f1(st.dtlM)} m</text></g>`);
  }

  const lineSvg = `<line class="startline" x1="${L[0]}" y1="${L[1]}" x2="${R[0]}" y2="${R[1]}" stroke-width="${2.5 * k}"/>
    <circle class="pin" cx="${L[0]}" cy="${L[1]}" r="${6 * unit}"/>
    <rect class="rc" x="${R[0] - 6 * unit}" y="${R[1] - 6 * unit}" width="${12 * unit}" height="${12 * unit}"/>
    <text x="${L[0]}" y="${L[1] - 11 * unit}" font-size="${11 * k}" text-anchor="middle" class="endlbl">PIN</text>
    <text x="${R[0]}" y="${R[1] - 11 * unit}" font-size="${11 * k}" text-anchor="middle" class="endlbl">RC</text>`;

  return `<svg viewBox="${box.x0} ${box.y0} ${w} ${h}" class="chart start" role="img"
    aria-label="Boats relative to the start line at the gun">
    ${trails.join('')}${lineSvg}${boats.join('')}
    ${windArrow(box, unit, k, 'wind (est.)')}${scaleBar(box, unit, k)}</svg>`;
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
