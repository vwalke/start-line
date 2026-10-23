/**
 * The bump chart: each boat's place at the start, every mark and the finish
 * (analysis/places.ts). Place 1 at the top; one line per boat in its colour
 * (slots repeat past eight boats so the lines stay apart; the labels name
 * them), a dot per place, the final place and name at the right. A DNF line
 * stops at the last mark reached, labelled there. A stretch across a mark
 * where the boat has no rounding time is dashed grey, never a guessed place.
 * The selected boat is drawn last, thicker and labelled bold; the rest fade.
 */
import { placeChanges, type BoatPlaces, type PlaceChanges } from '../analysis/places';
import type { BoatResult, RaceAnalysis } from '../analysis/types';
import { boatColor } from './charts';
import { warnChip, type Chip, type KeyLine } from './info';
import { boatLabel, esc, ordinal } from './format';
import { textWidth } from './labels';

const SLOTS = 8;
/** Below this width the right-hand labels are sail numbers only. */
export const PLACES_NARROW_PX = 520;
/** Reach for a pointer on a place-chart dot, chart px (the drawn radius is 3.5–4.5). */
export const PLACE_TIP_MOUSE_REACH = 16;
/** Finger slop: a tap often lands on the 14 px hit-stroke, not the circle. */
export const PLACE_TIP_TOUCH_REACH = 28;

/** A place-chart dot's chart position and readout (from the SVG, or a test stand-in). */
export interface PlaceDot {
  cx: number;
  cy: number;
  tip: string;
}

/** The nearest dot within `reach`, or null. Ties go to the later (on-top) boat. */
export function nearestPlaceDot<T extends PlaceDot>(dots: readonly T[], x: number, y: number, reach: number): T | null {
  let best: T | null = null;
  let bestD = reach;
  for (const d of dots) {
    const dist = Math.hypot(d.cx - x, d.cy - y);
    if (dist <= bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

/** The boat's line colour: its usual colour, or its slot cycled when the fleet is too big for one each. */
export const placeColor = (b: BoatResult, fleet: number): string => (fleet <= SLOTS ? boatColor(b, fleet) : `var(--s${(b.colorSlot % SLOTS) + 1})`);

/** "+2", "−1", "±0". */
export const gainLabel = (g: number): string => (g > 0 ? `+${g}` : g < 0 ? `−${-g}` : '±0');

/** Hover / tap text for one dot: "#GER42 · Gate: 3rd (+2)", naming the column a gain is from when it isn't the previous one. */
export function placeTip(pc: PlaceChanges, bp: BoatPlaces, b: BoatResult, k: number): string {
  const p = bp.places[k]!;
  const g = bp.gains[k];
  const from = bp.since[k];
  const gain = g == null ? '' : ` (${gainLabel(g)}${from != null && from !== k - 1 ? ` since ${pc.columns[from].label}` : ''})`;
  const dnf = k === bp.lastCol && bp.dnf ? ' · DNF' : '';
  return `${boatLabel(b, b.id)} · ${pc.columns[k].label}: ${ordinal(p)}${gain}${dnf}`;
}

/** The right-hand name: sail number when narrow or the boat has no name, else the name cut to `max` characters. */
export function shortName(b: BoatResult, narrow: boolean, max = 16): string {
  if (narrow || b.name === `#${b.sail}`) return `#${b.sail}`;
  return b.name.length > max ? `${b.name.slice(0, max - 1).trimEnd()}…` : b.name;
}

/** The chart's key line: ⚠ who has no rounding time where (with the dashed swatch); the counting rules in the ⓘ. */
export function placesKey(a: RaceAnalysis, pc: PlaceChanges = placeChanges(a)): KeyLine {
  const gaps = pc.columns.map((c, k) => (pc.missing[k] ? `${c.label} (${pc.missing[k]})` : '')).filter(Boolean);
  // One or two marks stay named; more would overflow a 390 px chip row, so the count goes on the chip and the names in the title.
  const chips: Chip[] = gaps.length
    ? [
        warnChip(
          gaps.length <= 2 ? `no time at ${gaps.join(', ')}` : `no time at ${gaps.length} marks`,
          `Boats with no rounding time at ${gaps.join(', ')}; the others close up`,
        ),
        { text: 'no rounding time', swatch: 'gap' },
      ]
    : [];
  const marks = pc.columns.length > 2;
  return {
    chips,
    bullets: [
      'Start: place among clean starters (OCS or no start figure: no point).',
      marks ? `Marks: rounding order, ${a.legSource === 'fleet' ? 'placed from where the fleet turned' : 'from the leg splits'}.` : 'One leg: Start → Finish only.',
      ...(marks ? ['Gray dashed: no rounding time there; the others close up.'] : []),
      'Finish: the finish order. A DNF line stops at the last mark reached.',
      'Hover or tap a dot for place and gain; tap a line to select.',
    ],
  };
}

export interface PlacesOptions {
  /** The chart's width on screen, px (labels and spacing are sized for it). */
  widthPx?: number;
  /**
   * Full screen: the height to fit, px. The rows shrink (or grow, to PLACES_FIT_MAX_ROW) to fill it
   * when that leaves each at least PLACES_FIT_MIN_ROW; else the usual rows, and the overlay scrolls.
   */
  heightPx?: number;
}

/** Full screen: the smallest row the chart shrinks to (names stay readable), and the largest it grows to. */
export const PLACES_FIT_MIN_ROW = 12;
export const PLACES_FIT_MAX_ROW = 32;

/** The bump chart as SVG, sized in screen pixels. */
export function placesChart(a: RaceAnalysis, highlight: string | null, opts: PlacesOptions = {}): string {
  const pc = placeChanges(a);
  const W = Math.max(300, Math.round(opts.widthPx ?? 720));
  const narrow = W < PLACES_NARROW_PX;
  const rows = pc.maxPlace;
  // Room for the plot when fitting a height (the mark names below take up to ~60 px turned; settled below).
  const fitRow = opts.heightPx ? (opts.heightPx - 10 - 60) / rows : 0;
  // Names a size under the row height when the rows are fitted tight, never under 10 px.
  const fs = Math.max(10, Math.min(narrow ? 11 : 12, fitRow >= PLACES_FIT_MIN_ROW ? Math.floor(fitRow) - 1 : 12));
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const finalLabel = (bp: BoatPlaces): string => {
    const b = byId.get(bp.id)!;
    const name = shortName(b, narrow);
    return bp.dnf ? `DNF ${name}` : `${bp.places[bp.lastCol]} ${name}`;
  };
  const drawn = pc.boats.filter((bp) => bp.lastCol >= 0);
  // Room for the longest finisher's label at the right (DNF labels sit on the plot).
  const labelW = Math.min(narrow ? 76 : 180, Math.max(40, ...drawn.filter((bp) => !bp.dnf).map((bp) => textWidth(finalLabel(bp), fs) + 4)));
  const nCol = pc.columns.length;
  const padL = 26;
  const padR = labelW + 10;
  const plotW = W - padL - padR;
  const step = nCol > 1 ? plotW / (nCol - 1) : plotW;
  // Mark names turn 30° when the longest won't fit its column (room below for the turned text).
  const headW = Math.max(...pc.columns.map((c) => textWidth(c.label, fs)));
  const rotate = headW > step - 8;
  const padT = 10;
  const padB = rotate ? Math.round(18 + headW * 0.5) : 24;
  const fitH = opts.heightPx ? (opts.heightPx - padT - padB) / rows : 0;
  const rowH = fitH >= PLACES_FIT_MIN_ROW ? Math.min(PLACES_FIT_MAX_ROW, fitH) : Math.max(14, Math.min(26, 520 / rows));
  const H = Math.round(padT + rows * rowH + padB);
  const x = (k: number): number => (nCol > 1 ? padL + 8 + (k * (plotW - 16)) / (nCol - 1) : padL + plotW / 2);
  const y = (p: number): number => padT + (p - 0.5) * rowH;
  const r1 = (v: number): string => v.toFixed(1);

  const grid: string[] = [];
  for (let p = 1; p <= rows; p++) {
    grid.push(`<line class="pc-grid" x1="${padL}" x2="${W - padR}" y1="${r1(y(p))}" y2="${r1(y(p))}"/>`);
    grid.push(`<text class="pc-axis" x="${padL - 5}" y="${r1(y(p) + fs * 0.35)}" font-size="${fs}" text-anchor="end">${p}</text>`);
  }
  pc.columns.forEach((c, k) => {
    const cx = r1(x(k));
    const by = padT + rows * rowH;
    grid.push(`<line class="pc-col" x1="${cx}" x2="${cx}" y1="${padT}" y2="${r1(by)}"/>`);
    const label = esc(c.label);
    grid.push(
      rotate
        ? `<text class="pc-head" x="${cx}" y="${r1(by + 12)}" font-size="${fs}" text-anchor="end" transform="rotate(-30 ${cx} ${r1(by + 12)})">${label}</text>`
        : `<text class="pc-head" x="${cx}" y="${r1(by + 16)}" font-size="${fs}" text-anchor="middle">${label}</text>`,
    );
  });

  const lineW = rows > 20 ? 1.6 : 2.2;
  // A selected boat that isn't drawn (one set aside as not racing) fades nobody.
  const sel = drawn.some((bp) => bp.id === highlight) ? highlight : null;
  const boatSvg = (bp: BoatPlaces): string => {
    const b = byId.get(bp.id)!;
    const col = placeColor(b, a.boats.length);
    const on = sel === bp.id;
    const cls = `pc-boat${sel ? (on ? ' on' : ' dim') : ''}`;
    const pts = bp.places.map((p, k) => (p == null ? null : ([x(k), y(p)] as const)));
    let solid = '';
    let gaps = '';
    let all = '';
    let prev = -1;
    pts.forEach((pt, k) => {
      if (!pt) return;
      const xy = `${r1(pt[0])} ${r1(pt[1])}`;
      if (prev < 0) {
        solid += `M${xy}`;
        all += `M${xy}`;
      } else {
        all += `L${xy}`;
        if (k - prev > 1) {
          gaps += `M${r1(pts[prev]![0])} ${r1(pts[prev]![1])}L${xy}`;
          solid += `M${xy}`;
        } else solid += `L${xy}`;
      }
      prev = k;
    });
    const w = on ? lineW + 1.6 : lineW;
    const dots = pts
      .map((pt, k) => {
        if (!pt) return '';
        const tip = esc(placeTip(pc, bp, b, k));
        return `<circle class="pc-dot" cx="${r1(pt[0])}" cy="${r1(pt[1])}" r="${on ? 4.5 : 3.5}" fill="${col}" data-tip="${tip}"><title>${tip}</title></circle>`;
      })
      .join('');
    const last = pts[bp.lastCol]!;
    const lbl = esc(finalLabel(bp));
    const full = esc(boatLabel(b, b.id));
    const label = bp.dnf
      ? `<text class="pc-lbl dnf" x="${r1(last[0] + 7)}" y="${r1(last[1] - 6)}" font-size="${fs - 1}" fill="${col}"><title>${full}: did not finish</title>${lbl}</text>`
      : `<text class="pc-lbl" x="${r1(W - padR + 8)}" y="${r1(last[1] + fs * 0.35)}" font-size="${fs}" fill="${col}"><title>${full}</title>${lbl}</text>`;
    return `<g class="${cls}" data-id="${esc(bp.id)}">
      <path class="pc-hit" d="${all}"/>${gaps ? `<path class="pc-gap" d="${gaps}" stroke-width="${r1(Math.max(1.2, w - 0.8))}"/>` : ''}
      <path class="pc-line" d="${solid}" stroke="${col}" stroke-width="${r1(w)}"/>${dots}${label}</g>`;
  };
  // The selected boat last, on top.
  const order = [...drawn].sort((p, q) => Number(p.id === sel) - Number(q.id === sel));
  const aria = `Place changes: each boat's place at ${pc.columns.map((c) => c.label).join(', ')}.`;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chart places${narrow ? ' narrow' : ''}" role="img" aria-label="${esc(aria)}">
    <g class="pc-grid-g">${grid.join('')}</g>${order.map(boatSvg).join('')}</svg>`;
}
