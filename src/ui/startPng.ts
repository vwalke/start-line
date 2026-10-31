/**
 * The Start view as a picture to share: the whole line at the gun, a zoomed inset round the selected boat (as a coach
 * crops the screen by hand) with its gun readout, and a caption (event, division, race, sail number, its distance to
 * the line). Drawn client-side: the two charts are the Start view's own SVG (charts.ts startSnapshot), nested in one
 * SVG with the page's light-theme colors and the charts' style rules inlined (an SVG drawn to a canvas sees no page
 * CSS), then painted to a canvas and saved as PNG. No dependencies.
 */
import type { RaceAnalysis } from '../analysis/types';
import { gunReadout, shownDtlM } from '../analysis/startSummary';
import { startFitBox, startSnapshot } from './charts';
import { esc, f1 } from './format';
import { gunReadoutCells } from './gunReadout';
import { rotator } from './mapPieces';
import { easternStamp } from './races';
import type { StartColour } from './sog';
import { clampView, type View } from './view';

/** The picture's width, px (drawn at PNG_SCALE× for a sharp image). */
export const PNG_W = 1200;
export const PNG_SCALE = 2;
/** The inset shows about this many metres across round the boat (more when the Fit is already that close). */
export const INSET_SPAN_M = 90;

const PAD = 24;
/** The main panel's hulls are at least this long, px: the whole line is ~1 px a metre, too small for the usual size. */
export const MAIN_HULL_PX = 22;
/** The readout beside the inset: first label's baseline, the step between cells, label to value baseline, value's descent. */
const READOUT_TOP = 28;
const READOUT_ROW = 46;
const READOUT_VALUE = 22;
const READOUT_DESC = 8;
const CAPTION_H = 58;
const INSET_W = 560;

/** The zoomed view round boat `id`'s bow at the gun on the start chart's Fit box; null when it has no bow there. */
export function insetView(a: RaceAnalysis, id: string, widthPx = INSET_W): View | null {
  const d = a.drawings.find((x) => x.id === id);
  if (!d?.bow) return null;
  const box = startFitBox(a, widthPx);
  const [cx, cy] = rotator(a.wind.twdAtGunDeg)(d.bow);
  const k = Math.max(2, Math.min(8, (box.x1 - box.x0) / INSET_SPAN_M));
  return clampView(box, { cx, cy, k });
}

/** Boat `id`'s hull in a startSnapshot (its group's first `path.hull`) marked `data-sel`, for the picture's accent fill. */
export function markSelectedHull(svg: string, id: string): string {
  const g = svg.indexOf(`data-id="${esc(id)}"`);
  if (g < 0) return svg;
  const h = svg.indexOf('<path class="hull"', g);
  const end = svg.indexOf('</g>', g);
  return h < 0 || (end >= 0 && h > end) ? svg : `${svg.slice(0, h)}<path data-sel=""${svg.slice(h + 5)}`;
}

/** The ring round the selected boat on the whole-line panel: stroke, px; opacity; radius past the hull's half-length, px, and at least. */
export const SEL_RING_STROKE_PX = 1.75;
export const SEL_RING_OPACITY = 0.55;
const SEL_RING_PAD_PX = 10;
const SEL_RING_MIN_PX = 20;

/** The numbers in `s`, in order (a regex of its own each call: no lastIndex shared between calls). */
const numbers = (s: string): number[] => [...s.matchAll(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)].map((m) => Number(m[0]));

/**
 * Where boat `id`'s group starts in a startSnapshot (`<g class="boat…" data-id="id">`), and its markup up to its own
 * `</g>` (groups nested in it, as an arrow's, counted); null when it isn't drawn.
 */
function boatGroup(svg: string, id: string): { at: number; body: string } | null {
  const m = new RegExp(`<g class="boat[^"]*" data-id="${esc(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`).exec(svg);
  if (!m) return null;
  const tag = /<g[\s>]|<\/g>/g;
  tag.lastIndex = m.index + m[0].length;
  let depth = 1;
  for (let t = tag.exec(svg); t; t = tag.exec(svg)) {
    depth += t[0] === '</g>' ? -1 : 1;
    if (!depth) return { at: m.index, body: svg.slice(m.index, t.index) };
  }
  return { at: m.index, body: svg.slice(m.index) };
}

type Pt = [number, number];

/** The point at `t` on the cubic from `p0` through controls `c1`, `c2` to `p1`. */
function cubicAt(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [w[0] * p0[0] + w[1] * c1[0] + w[2] * c2[0] + w[3] * p1[0], w[0] * p0[1] + w[1] * c1[1] + w[2] * c2[1] + w[3] * p1[1]];
}

/**
 * A hull's path data (boatShape.ts hullPathD: `M` at the bow tip, cubics down one side, `L` across the transom, cubics
 * back): its bow tip, its transom's two ends, and points on the outline itself (each cubic's ends and points along
 * it, never its control points). Null when it isn't one.
 */
function hullPathPoints(d: string): { bow: Pt; transom: [Pt, Pt]; outline: Pt[] } | null {
  const ops = [...d.matchAll(/([MCLZ])([^MCLZ]*)/gi)].map((m) => ({ op: m[1].toUpperCase(), n: numbers(m[2]) }));
  if (ops[0]?.op !== 'M' || ops[0].n.length < 2) return null;
  const bow: Pt = [ops[0].n[0], ops[0].n[1]];
  let cur = bow;
  const outline: Pt[] = [bow];
  let transom: [Pt, Pt] | null = null;
  for (const { op, n } of ops.slice(1)) {
    if (op === 'L' && n.length >= 2) {
      const to: Pt = [n[0], n[1]];
      transom ??= [cur, to];
      outline.push(to);
      cur = to;
    } else if (op === 'C') {
      for (let i = 0; i + 5 < n.length; i += 6) {
        const to: Pt = [n[i + 4], n[i + 5]];
        for (let s = 1; s <= 8; s++) outline.push(cubicAt(cur, [n[i], n[i + 1]], [n[i + 2], n[i + 3]], to, s / 8));
        cur = to;
      }
    }
  }
  return transom ? { bow, transom, outline } : null;
}

/**
 * Boat `id`'s hull as drawn in a startSnapshot, chart units: its middle (halfway from the bow tip to the middle of
 * the transom: the hull runs aft from the bow, stretched to the panel's smallest size) and the farthest its outline
 * gets from there; an arrow (no class dimensions), its point and half its size. Null when the boat has no hull at the gun.
 */
export function drawnHull(svg: string, id: string): { cx: number; cy: number; half: number } | null {
  const g = boatGroup(svg, id);
  if (!g) return null;
  // markSelectedHull puts `data-sel` before the class.
  const d = /<path[^>]* class="hull[^"]*" d="([^"]+)"/.exec(g.body);
  if (d) {
    const h = hullPathPoints(d[1]);
    if (!h) return null;
    const [[ax, ay], [bx, by]] = h.transom;
    const cx = (h.bow[0] + (ax + bx) / 2) / 2;
    const cy = (h.bow[1] + (ay + by) / 2) / 2;
    return { cx, cy, half: Math.max(...h.outline.map(([x, y]) => Math.hypot(x - cx, y - cy))) };
  }
  const t = /<g transform="translate\(([-\d.e]+),([-\d.e]+)\)"><g transform="rotate\([^)]*\)"><polygon[^>]*\spoints="([^"]+)"/.exec(g.body);
  if (!t) return null;
  const p = numbers(t[3]).map(Math.abs);
  return { cx: Number(t[1]), cy: Number(t[2]), half: p.length ? Math.max(...p) : 0 };
}

/**
 * A startSnapshot with a light ring round boat `id`'s hull as drawn (drawnHull), under it and its name; `pxPerUnit`:
 * the panel's px per chart unit, so the ring's stroke and size are in px. Unchanged when the boat has no hull at the gun.
 */
export function withSelectedRing(svg: string, id: string, pxPerUnit: number): string {
  const h = drawnHull(svg, id);
  const g = boatGroup(svg, id);
  if (!h || !g || !(pxPerUnit > 0)) return svg;
  const r = Math.max(SEL_RING_MIN_PX, h.half * pxPerUnit + SEL_RING_PAD_PX) / pxPerUnit;
  const ring = `<circle class="png-sel-ring" cx="${h.cx.toFixed(2)}" cy="${h.cy.toFixed(2)}" r="${r.toFixed(2)}" fill="var(--accent)" fill-opacity="0.08" stroke="var(--accent)" stroke-width="${(SEL_RING_STROKE_PX / pxPerUnit).toFixed(3)}" opacity="${SEL_RING_OPACITY}" pointer-events="none"/>`;
  return `${svg.slice(0, g.at)}${ring}${svg.slice(g.at)}`;
}

/** An SVG from startSnapshot's viewBox size, chart units. */
function viewSize(svg: string): { vw: number; vh: number } {
  const m = /viewBox="([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)"/.exec(svg);
  return { vw: m ? Number(m[3]) : 1, vh: m ? Number(m[4]) : 1 };
}

/** The size an SVG from startSnapshot asks for at `w` px wide (its viewBox's aspect). */
function heightAt(svg: string, w: number): number {
  const { vw, vh } = viewSize(svg);
  return Math.round((w * vh) / vw);
}

/** `svg` (a chart's root element) placed at x, y, w × h inside another SVG. */
const placed = (svg: string, x: number, y: number, w: number, h: number): string =>
  // The size in an inline style too: the page's rules for charts (width 100%, a max height) must not resize it.
  svg.replace(/^<svg\b/, `<svg x="${x}" y="${y}" width="${w}" height="${h}" style="width:${w}px;height:${h}px;max-height:none" preserveAspectRatio="xMidYMid meet"`);

export interface StartPngCaption {
  /** "J/70 North Americans". */
  event: string;
  division: string;
  /** "Race 6" (the race menu's name). */
  race: string;
}

/**
 * The picture as one SVG document `width` × `height` px: caption, the whole line at the gun, the inset round boat
 * `id` beside its gun readout. `css`: the style rules and light-theme colors the charts need (pageCss), inlined.
 */
export function startPngSvg(a: RaceAnalysis, id: string, colour: StartColour, cap: StartPngCaption, css: string): { svg: string; width: number; height: number } {
  const b = a.boats.find((x) => x.id === id);
  const mainW = PNG_W - 2 * PAD;
  // Every boat's hull at the gun, big enough to see across the whole line (the inset draws them as the Start view does).
  const snap = markSelectedHull(startSnapshot(a, id, undefined, colour, { names: 'auto', widthPx: mainW, minHullPx: MAIN_HULL_PX }), id);
  const mainH = Math.min(heightAt(snap, mainW), 640);
  // The selected boat ringed, on this panel only (the hulls are small across the whole line): the panel's px per unit as placed (meet).
  const { vw, vh } = viewSize(snap);
  const main = withSelectedRing(snap, id, Math.min(mainW / vw, mainH / vh));
  const iv = insetView(a, id);
  const inset = iv ? markSelectedHull(startSnapshot(a, id, iv, colour, { names: 'auto', widthPx: INSET_W }), id) : '';
  const insetH = inset ? Math.min(heightAt(inset, INSET_W), 420) : 0;
  const top = PAD + CAPTION_H;
  const insetY = top + mainH + 16;

  const st = b?.start;
  const dtl = st ? shownDtlM(st) : null;
  const sail = b ? `#${b.sail}` : '';
  const line1 = [cap.event, cap.division, cap.race].filter(Boolean).join(' · ');
  const line2 = [`${sail} at the gun`, dtl != null && Number.isFinite(dtl) ? `${f1(dtl)} m to line` : null, easternStamp(a.meta.gunMs)]
    .filter(Boolean)
    .join(' · ');

  const r = b ? gunReadout(b) : null;
  const cells = r ? gunReadoutCells(r) : [];
  const readX = PAD + INSET_W + 28;
  // The canvas holds the taller of the inset and the readout beside it (each cell a label and a value), padded.
  const readoutH = cells.length ? READOUT_TOP + (cells.length - 1) * READOUT_ROW + READOUT_VALUE + READOUT_DESC : 0;
  const height = inset ? insetY + Math.max(insetH, readoutH) + PAD : top + mainH + PAD;
  const readout = cells
    .map((c, i) => {
      const y = insetY + READOUT_TOP + i * READOUT_ROW;
      return `<text x="${readX}" y="${y}" class="png-k">${esc(c.label.toUpperCase())}</text><text x="${readX}" y="${y + READOUT_VALUE}" class="png-v">${esc(c.value)}</text>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="png-doc" width="${PNG_W}" height="${height}" viewBox="0 0 ${PNG_W} ${height}">
  <style><![CDATA[${css.replace(/]]>/g, '')}
    .png-bg { fill: var(--page); }
    .png-card { fill: var(--surface); stroke: var(--rule); }
    .png-t1 { font: 700 20px var(--sans); fill: var(--ink); }
    .png-t2 { font: 500 14px var(--sans); fill: var(--ink-2); }
    .png-k { font: 600 11px var(--sans); letter-spacing: 0.04em; fill: var(--ink-3); }
    .png-v { font: 700 18px var(--sans); fill: var(--ink); }
    .png-brand { font: 600 12px var(--sans); fill: var(--ink-3); }
    svg.chart { font-family: var(--sans); overflow: hidden; }
    svg.png-doc g.boat.dim { opacity: 0.55; }
    svg.png-doc path.hull[data-sel] { fill: var(--accent); stroke: var(--ink); }
  ]]></style>
  <rect class="png-bg" width="${PNG_W}" height="${height}"/>
  <text x="${PAD}" y="${PAD + 18}" class="png-t1">${esc(line1)}</text>
  <text x="${PAD}" y="${PAD + 42}" class="png-t2">${esc(line2)}</text>
  <text x="${PNG_W - PAD}" y="${PAD + 18}" class="png-brand" text-anchor="end">Recall</text>
  <rect class="png-card" x="${PAD - 1}" y="${top - 1}" width="${mainW + 2}" height="${mainH + 2}" rx="6"/>
  ${placed(main, PAD, top, mainW, mainH)}
  ${inset ? `<rect class="png-card" x="${PAD - 1}" y="${insetY - 1}" width="${INSET_W + 2}" height="${insetH + 2}" rx="6"/>${placed(inset, PAD, insetY, INSET_W, insetH)}${readout}` : ''}
</svg>`;
  return { svg, width: PNG_W, height };
}

/** "recall-j70-north-americans-r6-1513-start.png". */
export function startPngName(event: string, raceNumber: number, sail: string): string {
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  return `recall-${slug(event) || 'event'}-r${raceNumber}-${slug(sail) || 'boat'}-start.png`;
}

/**
 * The page's light-theme custom properties (the first `:root` rule) and every rule styling chart SVG, as CSS text to
 * inline: the charts read `var(--ink)` and their classes, which an image drawn to a canvas can't see.
 */
export function pageCss(doc: Document): string {
  const out: string[] = [];
  let root = false;
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const sel = rule.selectorText;
      if (!root && sel === ':root') {
        // The light theme's colors on the picture's own root.
        out.push(rule.cssText.replace(/^:root/, 'svg'));
        root = true;
      } else if (/(^|,\s*)svg\b/.test(sel)) out.push(rule.cssText);
    }
  }
  return out.join('\n');
}

/** Paint `svg` (width × height px) to a canvas at PNG_SCALE× and save it as `name`. */
export async function downloadSvgAsPng(svg: string, width: number, height: number, name: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("couldn't draw the picture"));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * PNG_SCALE;
    canvas.height = height * PNG_SCALE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.scale(PNG_SCALE, PNG_SCALE);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error("couldn't make the PNG");
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
