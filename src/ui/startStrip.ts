/**
 * The Coach Regatta view's start strip: one small picture of the line at the gun per race for the selected boat (the
 * Start view's line, pin and RC ends and every boat's hull, from analysis/startSummary.ts), with the race, the boat's
 * distance behind the line (as the Start view measures it, from the bow), where along the line it was, and the
 * favored end. Each opens that race's Start view with the boat selected. Static SVG, no pan or zoom: the row wraps on
 * a phone. The boat is the same size as the rest, picked out by its color and an ink outline.
 */
import type { RegattaRace } from '../analysis/coach/regatta';
import type { Vec } from '../analysis/geo';
import { linePart, type LinePart, type StartDigest } from '../analysis/startSummary';
import { boatShapeOr, hullCenterFromBow, hullPathAt, headingDir } from './boatShape';
import { startLineSvg } from './charts';
import { esc, f1 } from './format';
import { textWidth } from './labels';
import { rotator } from './mapPieces';

/** A thumbnail's width as drawn, css px (its height follows THUMB_ASPECT). */
export const THUMB_PX = 168;
export const THUMB_ASPECT = 1.6;
/** Hulls are drawn at least this long, css px: smaller than the Start view's (the pictures are small), every boat alike. */
export const THUMB_HULL_PX = 6;

/** The words for where along the line. */
export const LINE_PART_TEXT: Record<LinePart, string> = { pin: 'Pin end', middle: 'Middle', rc: 'RC end' };

/** "Pin end · 12%" (0 % at the pin, 100 % at the RC). */
export const linePosText = (pct: number): string => `${LINE_PART_TEXT[linePart(pct)]} · ${Math.round(pct)}%`;

/** The favored end as the Start view's label words it, short: "Pin favored 7°", "RC favored 2°", "Square line". */
export const favoredShort = (f: StartDigest['fav']): string => (f.end === 'square' ? 'Square line' : `${f.end === 'pin' ? 'Pin' : 'RC'} favored ${f.deg}°`);

/** "3.7 m to line" (a plain number, as the Start view shows it). */
export const dtlText = (m: number | null): string | null => (m == null ? null : `${f1(m)} m to line`);

interface Frame {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** The picture's frame, wind at the top: the line's ends and every bow, padded, grown to THUMB_ASPECT about its middle. */
export function thumbFrame(s: StartDigest): Frame {
  const rot = rotator(s.twdDeg);
  const pts = [s.pin, s.rc, ...s.boats.map((b) => b.bow)].map(rot);
  let x0 = Math.min(...pts.map((p) => p[0]));
  let x1 = Math.max(...pts.map((p) => p[0]));
  let y0 = Math.min(...pts.map((p) => p[1]));
  let y1 = Math.max(...pts.map((p) => p[1]));
  const pad = Math.max(6, 0.08 * Math.max(x1 - x0, y1 - y0));
  x0 -= pad;
  x1 += pad;
  y0 -= pad;
  y1 += pad;
  let w = x1 - x0;
  let h = y1 - y0;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  if (w / h > THUMB_ASPECT) h = w / THUMB_ASPECT;
  else w = h * THUMB_ASPECT;
  return { x0: cx - w / 2, y0: cy - h / 2, w, h };
}

/** The boat's sail number in a thumbnail, css px. */
export const THUMB_LABEL_PX = 10;

/**
 * The boat's sail number beside its hull (bow at `at`, pointing along `dir`): under its stern, away from the line
 * above, kept inside the picture; haloed so it reads over the fleet.
 */
function thumbLabel(at: Vec, dir: Vec | null, sail: string, unit: number, f: Frame): string {
  const fs = THUMB_LABEL_PX * unit;
  const d = dir ?? [0, -1];
  const aft: Vec = [at[0] - d[0] * THUMB_HULL_PX * unit, at[1] - d[1] * THUMB_HULL_PX * unit];
  const half = textWidth(sail, fs) / 2 + unit;
  const x = Math.min(Math.max((at[0] + aft[0]) / 2, f.x0 + half), f.x0 + f.w - half);
  const y = Math.min(Math.max(at[1], aft[1]) + fs + 2 * unit, f.y0 + f.h - 2 * unit);
  return `<text class="thumb-lbl" x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs.toFixed(2)}" stroke-width="${(2.5 * unit).toFixed(2)}" text-anchor="middle">${esc(sail)}</text>`;
}

/** Boat `sail`'s start (and the fleet's) as a small SVG: hulls from the bow along heading, the boat on top in its color. */
export function startThumbSvg(s: StartDigest, sail: string, widthPx = THUMB_PX): string {
  const rot = rotator(s.twdDeg);
  const f = thumbFrame(s);
  const unit = f.w / widthPx;
  const pxPerM = widthPx / f.w;
  const L = rot(s.pin);
  const R = rot(s.rc);
  const r = (v: number): string => v.toFixed(1);
  const hull = (bow: Vec, hdg: number, on: boolean): string => {
    const dir = headingDir(hdg, s.twdDeg);
    const at = rot(bow);
    const shape = boatShapeOr({ dir, hold: false, sog: NaN, dims: s.dims, pxPerM, minPx: THUMB_HULL_PX });
    const cls = on ? 'hull thumb-on' : 'hull thumb-boat';
    if ('shape' in shape) return `<path class="${cls}" d="${hullPathAt(hullCenterFromBow(at, shape.shape, 0, shape.dims), shape.shape, shape.dims)}" stroke-width="${(on ? 2 : 0.4) * unit}"/>`;
    // No class dimensions: the Start view's arrow, small.
    const d = dir ?? [0, -1];
    const sz = (THUMB_HULL_PX / 2) * unit;
    const tip: Vec = [at[0], at[1]];
    const back: Vec = [at[0] - d[0] * 2 * sz, at[1] - d[1] * 2 * sz];
    const side: Vec = [-d[1] * sz * 0.7, d[0] * sz * 0.7];
    return `<polygon class="${cls}" points="${r(tip[0])},${r(tip[1])} ${r(back[0] + side[0])},${r(back[1] + side[1])} ${r(back[0] - side[0])},${r(back[1] - side[1])}" stroke-width="${(on ? 2 : 0.4) * unit}"/>`;
  };
  const others = s.boats.filter((b) => b.sail !== sail).map((b) => hull(b.bow, b.hdg, false));
  const me = s.boats.find((b) => b.sail === sail);
  return `<svg viewBox="${r(f.x0)} ${r(f.y0)} ${r(f.w)} ${r(f.h)}" class="chart start start-thumb" role="img" aria-hidden="true" focusable="false">
    ${startLineSvg(L, R, unit, unit * 0.8, false)}${others.join('')}${me ? hull(me.bow, me.hdg, true) + thumbLabel(rot(me.bow), headingDir(me.hdg, s.twdDeg), sail, unit, f) : ''}</svg>`;
}

/** The link to race `raceNumber`'s Start view with boat `sail` selected: the page's event, division and options; nothing of the map's. */
export function startViewHref(search: string, raceNumber: number, sail: string): string {
  const cur = new URLSearchParams(search);
  const p = new URLSearchParams();
  for (const k of ['event', 'div', 'nc', 'ys', 'ysc']) {
    const v = cur.get(k);
    if (v != null) p.set(k, v);
  }
  p.set('race', String(raceNumber));
  p.set('boat', sail);
  return `/regattas/start?${p.toString()}#start`;
}

/** The strip: one figure per race with a start picture, in race order; '' when none has one yet. */
export function startStripHtml(rows: readonly Pick<RegattaRace, 'raceNumber' | 'label' | 'name' | 'status' | 'digest'>[], search: string): string {
  const items = rows
    .filter((r) => r.status === 'done' && r.digest?.start)
    .map((r) => {
      const s = r.digest!.start!;
      const sail = r.digest!.sail;
      const me = s.me;
      const facts = [me ? dtlText(me.dtlM) : null, me ? linePosText(me.linePct) : null, favoredShort(s.fav)].filter((x): x is string => !!x);
      // Over early only as race control called it.
      const called = me?.called ? '<span class="ss-ocs">OCS</span>' : '';
      const label = `${r.name}, start: ${facts.join(', ')}${me?.called ? ', called over early' : ''}. Open its Start view.`;
      return `<li><a class="ss-item" href="${esc(startViewHref(search, r.raceNumber, sail))}" data-start-race="${r.raceNumber}" aria-label="${esc(label)}">
        ${startThumbSvg(s, sail)}
        <span class="ss-race"><b>${esc(r.label)}</b>${called}</span>
        ${facts.map((t) => `<span class="ss-fact">${esc(t)}</span>`).join('')}
      </a></li>`;
    });
  if (!items.length) return '';
  return `<h4>Starts</h4><ol class="start-strip" aria-label="Start in each race">${items.join('')}</ol>`;
}
