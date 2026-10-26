/**
 * Start Speed Control: SOG against seconds from the gun for every racing
 * boat (analysis/startSog.ts), drawn at the card's pixel width, one line per
 * boat through all its fixes; a dot marks each boat's line crossing. The selected boat is drawn last and thicker; the rest fade.
 * A boat far over the fleet (a tracker glitch, see startSogHi) is drawn along
 * the top edge over the axis, a caret where its line leaves it; the key then
 * shows "▲ off scale".
 * "Window: 30 s | 60 s | 120 s" sets how far before the gun it starts
 * (recall.startSogWindow); it always runs to +20 s.
 */
import { SOG_SMOOTH_MS } from '../analysis/smooth';
import { sogAt, startSogSeries, START_SOG_WINDOWS, type StartSogBoat, type StartSogSeries, type StartSogWindow } from '../analysis/startSog';
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
  /** Clamped to [lo, hi]. */
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
  // Clamped to the axis: a speed over its top (see startSogHi) is drawn along the top edge.
  const y = (kn: number): number => padT + (1 - (Math.min(hi, Math.max(lo, kn)) - lo) / (hi - lo)) * ph;
  const tAt = (px: number): number => Math.min(s.t1, Math.max(s.t0, s.t0 + ((px - padL) / pw) * (s.t1 - s.t0)));
  return { W, H, padL, padR, padT, padB, t0: s.t0, t1: s.t1, lo, hi, kStep, x, y, tAt };
}

/** Pixel x of each place a boat's line leaves the top of the axis (where it crosses `hi`, or a run's start above it). */
export function startSogClips(b: Pick<StartSogBoat, 'runs'>, L: StartSogLayout): number[] {
  const out: number[] = [];
  for (const r of b.runs) {
    for (let i = 0; i < r.t.length; i++) {
      if (r.sog[i] <= L.hi) continue;
      if (i === 0) out.push(L.x(r.t[0]));
      else if (r.sog[i - 1] <= L.hi) out.push(L.x(r.t[i - 1] + ((L.hi - r.sog[i - 1]) / (r.sog[i] - r.sog[i - 1])) * (r.t[i] - r.t[i - 1])));
    }
  }
  return out;
}

/**
 * The readout for a pointer at (px, py) on the chart: the selected boat's speed
 * at that time when there is a selection, else the boat whose line is nearest
 * vertically (within `reachPx`). Null off every line.
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

/** The key line: the window shown (⚠ when the tracks start later than asked), the dot swatch, the caret when a speed is off the top; the method in the ⓘ. */
export function startSogKey(s: StartSogSeries, w: StartSogWindow): KeyLine {
  const chips: Chip[] = [s.clamped ? warnChip(`data from ${secsLabel(s.t0)} only`) : { text: `${secsLabel(s.t0)} → ${secsLabel(s.t1)}` }];
  chips.push({ text: 'crossed the line', swatch: 'dot' });
  const L = startSogLayout(s);
  if (s.boats.some((b) => startSogClips(b, L).length)) chips.push({ text: '▲ off scale', title: 'Speed above the top of the chart (a tracker glitch)' });
  return {
    chips,
    bullets: [
      `Speed over ground (${SOG_SMOOTH_MS / 1000} s mean) around the gun.`,
      ...(s.clamped ? [`The tracks only go back to ${secsLabel(s.t0)} here, so the ${w} s window starts there.`] : []),
      "Dot: where the boat crossed the line (the table's Late), and its speed.",
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
    const cross = sb.cross
      ? (() => {
          const t = `${who}: crossed ${secsLabel(sb.cross.tS)} at ${f1(sb.cross.sogKn)} kn`;
          return `<circle class="ss-cross" cx="${r1(L.x(sb.cross.tS))}" cy="${r1(L.y(sb.cross.sogKn))}" r="${on ? 4.5 : 3.5}" fill="${col}"><title>${t}</title></circle>`;
        })()
      : '';
    // A caret on the top edge where the line goes off the axis.
    const clips = startSogClips(sb, L)
      .map((cx) => `<path class="ss-clip-mark" d="M${r1(cx - 4)} ${r1(L.padT + 6)}L${r1(cx)} ${r1(L.padT)}L${r1(cx + 4)} ${r1(L.padT + 6)}Z" fill="${col}"><title>${who}: over ${L.hi} kn</title></path>`)
      .join('');
    return `<g class="${cls}" data-id="${esc(sb.id)}"><path class="ss-hit" d="${runs}"><title>${who}</title></path><path class="ss-line" d="${runs}" stroke="${col}" stroke-width="${on ? 3 : 1.6}"/>${clips}${cross}</g>`;
  };
  const order = [...drawn].sort((p, q) => Number(p.id === sel) - Number(q.id === sel));
  const aria = `Speed over ground of each boat from ${secsLabel(s.t0)} to ${secsLabel(s.t1)} around the gun.`;
  return `<svg viewBox="0 0 ${L.W} ${L.H}" width="${L.W}" height="${L.H}" class="chart start-sog" role="img" aria-label="${esc(aria)}">
    <g>${grid.join('')}</g>${order.map(boatSvg).join('')}<line class="ss-hair" x1="0" x2="0" y1="${L.padT}" y2="${L.H - L.padB}" visibility="hidden"/></svg>`;
}
