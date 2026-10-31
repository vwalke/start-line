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

/** The size an SVG from startSnapshot asks for at `w` px wide (its viewBox's aspect). */
function heightAt(svg: string, w: number): number {
  const m = /viewBox="([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)"/.exec(svg);
  const vw = m ? Number(m[3]) : 1;
  const vh = m ? Number(m[4]) : 1;
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
  const main = markSelectedHull(startSnapshot(a, id, undefined, colour, { names: 'auto', widthPx: mainW, minHullPx: MAIN_HULL_PX }), id);
  const mainH = Math.min(heightAt(main, mainW), 640);
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
