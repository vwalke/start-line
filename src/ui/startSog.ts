/**
 * Start Speed Control: SOG against seconds from the gun for every racing
 * boat (analysis/startSog.ts), drawn at the card's pixel width. Lines break at
 * telemetry gaps, joined by dashed grey; a dot marks each boat's line
 * crossing. The selected boat is drawn last and thicker; the rest fade.
 * "Window: 30 s | 60 s | 120 s" sets how far before the gun it starts
 * (recall.startSogWindow); it always runs to +20 s.
 */
import { SOG_SMOOTH_MS } from '../analysis/smooth';
import { sogAt, startSogSeries, START_SOG_WINDOWS, type StartSogSeries, type StartSogWindow } from '../analysis/startSog';
import type { RaceAnalysis } from '../analysis/types';
import { boatLabel, esc, f1 } from './format';
import { warnChip, type Chip, type KeyLine } from './info';
import { placeColor } from './places';

export const START_SOG_WINDOW_KEY = 'recall.startSogWindow';

/** A stored window, or 60 s for anything else (missing, old or garbled). */
export const parseStartSogWindow = (raw: string | null | undefined): StartSogWindow =>
  (START_SOG_WINDOWS as readonly number[]).includes(Number(raw)) && /^\d+$/.test(raw ?? '') ? (Number(raw) as StartSogWindow) : 60;

/** "Window: 30 s | 60 s | 120 s" (the span before the gun). */
export function startSogControls(w: StartSogWindow): string {
  const btns = START_SOG_WINDOWS.map((v) => `<button type="button" data-sog-window="${v}" aria-pressed="${v === w}">${v} s</button>`).join('');
  return `<div class="seg" role="group" aria-label="Window before the gun"><span class="seg-lbl" aria-hidden="true">Window</span>${btns}</div>`;
}

/** Signed seconds: "−12.4 s", "+2.6 s", "0.0 s". */
export const secsLabel = (s: number): string => `${s > 0.05 ? '+' : s < -0.05 ? '−' : ''}${f1(Math.abs(s))} s`;

/** The chart's geometry in screen pixels (shared by the drawing and the hover). */
export interface StartSogLayout {
  W: number;
  H: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  t0: number;
  t1: number;
  lo: number;
  hi: number;
  /** Knots between y gridlines. */
  kStep: number;
  x: (s: number) => number;
  y: (kn: number) => number;
  /** Seconds from the gun at pixel x (clamped to the window). */
  tAt: (px: number) => number;
}

export function startSogLayout(s: StartSogSeries, widthPx = 720): StartSogLayout {
  const W = Math.max(300, Math.round(widthPx));
  const H = W < 520 ? 230 : 290;
  const padL = 32;
  const padR = 12;
  const padT = 14;
  const padB = 30;
  let lo = Math.floor(s.lo ?? 0);
  let hi = Math.ceil(s.hi ?? 1);
  if (hi - lo < 2) hi = lo + 2;
  const kStep = hi - lo > 10 ? 2 : 1;
  lo = Math.floor(lo / kStep) * kStep;
  hi = Math.ceil(hi / kStep) * kStep;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const x = (t: number): number => padL + ((t - s.t0) / (s.t1 - s.t0)) * pw;
  const y = (kn: number): number => padT + (1 - (kn - lo) / (hi - lo)) * ph;
  const tAt = (px: number): number => Math.min(s.t1, Math.max(s.t0, s.t0 + ((px - padL) / pw) * (s.t1 - s.t0)));
  return { W, H, padL, padR, padT, padB, t0: s.t0, t1: s.t1, lo, hi, kStep, x, y, tAt };
}

/**
 * The readout for a pointer at (px, py) on the chart: the selected boat's speed
 * at that time when there is a selection, else the boat whose line is nearest
 * vertically (within `reachPx`). Null inside a gap or off every line.
 */
export function startSogHover(
  s: StartSogSeries,
  L: StartSogLayout,
  px: number,
  py: number,
  highlight: string | null,
  reachPx = 16,
): { tS: number; id: string; sogKn: number } | null {
  const tS = L.tAt(px);
  const sel = highlight != null ? s.boats.find((b) => b.id === highlight) : undefined;
  if (sel) {
    const v = sogAt(sel, tS);
    return v == null ? null : { tS, id: sel.id, sogKn: v };
  }
  let best: { tS: number; id: string; sogKn: number } | null = null;
  let bestD = reachPx;
  for (const b of s.boats) {
    const v = sogAt(b, tS);
    if (v == null) continue;
    const d = Math.abs(L.y(v) - py);
    if (d <= bestD) {
      bestD = d;
      best = { tS, id: b.id, sogKn: v };
    }
  }
  return best;
}

/** The key line: the window shown (⚠ when the tracks start later than asked), the dot and gap swatches; the method in the ⓘ. */
export function startSogKey(s: StartSogSeries, w: StartSogWindow): KeyLine {
  const chips: Chip[] = [s.clamped ? warnChip(`data from ${secsLabel(s.t0)} only`) : { text: `${secsLabel(s.t0)} → ${secsLabel(s.t1)}` }];
  chips.push({ text: 'crossed the line', swatch: 'dot' });
  if (s.boats.some((b) => b.gaps.length)) chips.push({ text: 'no data', swatch: 'gap' });
  return {
    chips,
    bullets: [
      `Speed over ground (${SOG_SMOOTH_MS / 1000} s mean) around the gun.`,
      ...(s.clamped ? [`The tracks only go back to ${secsLabel(s.t0)} here, so the ${w} s window starts there.`] : []),
      "Dot: where the boat crossed the line (the table's Late), and its speed.",
      'Gray dashed: fixes over 5 s apart; no speed drawn.',
      'Hover or tap to read a speed; tap a line to select the boat.',
    ],
  };
}

const r1 = (v: number): string => v.toFixed(1);
const pathOf = (pts: [number, number][]): string => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`).join('');

export interface StartSogOptions {
  widthPx?: number;
}

/** The chart as SVG; `series` may be passed when already computed. */
export function startSogChart(a: RaceAnalysis, highlight: string | null, w: StartSogWindow, opts: StartSogOptions = {}, series?: StartSogSeries): string {
  const s = series ?? startSogSeries(a, w);
  const L = startSogLayout(s, opts.widthPx);
  const fs = L.W < 520 ? 11 : 12;
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  const drawn = s.boats.filter((b) => b.runs.length && byId.has(b.id));
  if (!drawn.length) return `<p class="muted">No speed data around the gun.</p>`;
  const sel = drawn.some((b) => b.id === highlight) ? highlight : null;

  const grid: string[] = [];
  for (let k = L.lo; k <= L.hi + 1e-9; k += L.kStep) {
    grid.push(`<line class="ss-grid" x1="${L.padL}" x2="${L.W - L.padR}" y1="${r1(L.y(k))}" y2="${r1(L.y(k))}"/>`);
    grid.push(`<text class="ss-axis" x="${L.padL - 5}" y="${r1(L.y(k) + fs * 0.35)}" font-size="${fs}" text-anchor="end">${k}</text>`);
  }
  const tick = s.t1 - s.t0 <= 55 ? 5 : 10;
  for (let t = Math.ceil(s.t0 / tick) * tick; t <= s.t1 + 1e-9; t += tick) {
    const x = r1(L.x(t));
    grid.push(`<line class="ss-tick" x1="${x}" x2="${x}" y1="${L.padT}" y2="${L.H - L.padB}"/>`);
    grid.push(`<text class="ss-axis" x="${x}" y="${L.H - L.padB + fs + 4}" font-size="${fs}" text-anchor="middle">${t > 0 ? '+' : t < 0 ? '−' : ''}${Math.abs(t)}</text>`);
  }
  const gx = r1(L.x(0));
  grid.push(
    `<line class="ss-gun" x1="${gx}" x2="${gx}" y1="${L.padT - 4}" y2="${L.H - L.padB}"/><text class="ss-gun-lbl" x="${r1(L.x(0) + 4)}" y="${L.padT + fs - 2}" font-size="${fs}">Gun</text>`,
  );
  grid.push(`<text class="ss-unit" x="${L.padL - 5}" y="${L.H - 4}" font-size="${fs - 1}" text-anchor="end">kn</text><text class="ss-unit" x="${L.W - L.padR}" y="${L.H - 4}" font-size="${fs - 1}" text-anchor="end">s from gun</text>`);

  const boatSvg = (sb: (typeof drawn)[number]): string => {
    const b = byId.get(sb.id)!;
    const col = placeColor(b, a.boats.length);
    const on = sel === sb.id;
    const cls = `ss-boat${sel ? (on ? ' on' : ' dim') : ''}`;
    const who = esc(boatLabel(b, b.id));
    const runs = sb.runs.map((r) => pathOf(r.t.map((t, i) => [L.x(t), L.y(r.sog[i])]))).join('');
    const gaps = sb.gaps.map(([p, q]) => pathOf([[L.x(p[0]), L.y(p[1])], [L.x(q[0]), L.y(q[1])]])).join('');
    const cross = sb.cross
      ? (() => {
          const t = `${who}: crossed ${secsLabel(sb.cross.tS)} at ${f1(sb.cross.sogKn)} kn`;
          return `<circle class="ss-cross" cx="${r1(L.x(sb.cross.tS))}" cy="${r1(L.y(sb.cross.sogKn))}" r="${on ? 4.5 : 3.5}" fill="${col}"><title>${t}</title></circle>`;
        })()
      : '';
    return `<g class="${cls}" data-id="${esc(sb.id)}"><path class="ss-hit" d="${runs}${gaps}"><title>${who}</title></path>${gaps ? `<path class="ss-gap" d="${gaps}"/>` : ''}<path class="ss-line" d="${runs}" stroke="${col}" stroke-width="${on ? 3 : 1.6}"/>${cross}</g>`;
  };
  const order = [...drawn].sort((p, q) => Number(p.id === sel) - Number(q.id === sel));
  const aria = `Speed over ground of each boat from ${secsLabel(s.t0)} to ${secsLabel(s.t1)} around the gun.`;
  return `<svg viewBox="0 0 ${L.W} ${L.H}" width="${L.W}" height="${L.H}" class="chart start-sog" role="img" aria-label="${esc(aria)}">
    <g>${grid.join('')}</g>${order.map(boatSvg).join('')}<line class="ss-hair" x1="0" x2="0" y1="${L.padT}" y2="${L.H - L.padB}" visibility="hidden"/></svg>`;
}
