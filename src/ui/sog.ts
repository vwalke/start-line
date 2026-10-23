/**
 * "Colour: Boat speed" for the track map and "Colour: Speed" for the start
 * chart: every stretch of track shaded by that boat's own SOG at the time
 * (smoothed over 4 s in the analysis, analysis/smooth.ts), so you can see
 * where on a leg boats were quick, and who hit the line at speed.
 *
 * Viridis, not plasma: rank (ui/speed.ts) already owns plasma's
 * purple → magenta → orange → yellow, and the two must not read alike. Viridis
 * runs purple → blue → teal → green → yellow-green, with no magenta or
 * orange, so the map looks plainly different; it is perceptually uniform,
 * rises monotonically in lightness (reads in greyscale and for colour-blind
 * viewers), and has no grey middle (cividis does) to confuse with the grey
 * dashed telemetry gaps. Slow = dark, fast = bright, as in Rank.
 *
 * As with plasma, no one slice reads on both backgrounds, so each scheme gets
 * its own (`stroke` = day, `--cd` = night; style.css picks):
 * - day 0.00–0.80: slowest #440154 (≈15:1 on white), fastest #7ad151 (≈1.9:1;
 *   bins under 3:1, the fast quarter, get one thin dark casing path per boat);
 * - night 0.30–1.00: slowest #355f8d (≈2.6:1 on #171d26), fastest #fde725 (≈13:1).
 *
 * Drawing: SOG is quantised to SOG_BINS colours and each boat gets one <path>
 * per bin present (runs of same-bin steps as M…L…), one dashed grey path for
 * its telemetry gaps and, by day, one casing path: bounded per boat however
 * long the race, never one element per fix.
 */
import { SOG_GAP_MS } from '../analysis/smooth';
import type { RaceAnalysis } from '../analysis/types';
import { esc, f1 } from './format';
import { contrast, SPEED_BG, type SogScale } from './speed';

/** Viridis at 0, 0.1, … 1 (matplotlib). */
const VIRIDIS = [
  [0x44, 0x01, 0x54],
  [0x48, 0x24, 0x75],
  [0x41, 0x44, 0x87],
  [0x35, 0x5f, 0x8d],
  [0x2a, 0x78, 0x8e],
  [0x21, 0x91, 0x8c],
  [0x22, 0xa8, 0x84],
  [0x44, 0xbf, 0x70],
  [0x7a, 0xd1, 0x51],
  [0xbd, 0xdf, 0x26],
  [0xfd, 0xe7, 0x25],
] as const;

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');

/** Viridis at `v` in [0, 1] (clamped; NaN → 0), linear in RGB between stops, as #rrggbb. */
export function viridis(v: number): string {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) * (VIRIDIS.length - 1) : 0;
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const [p, q] = [VIRIDIS[i], VIRIDIS[i + 1]];
  return `#${hex2(p[0] + (q[0] - p[0]) * f)}${hex2(p[1] + (q[1] - p[1]) * f)}${hex2(p[2] + (q[2] - p[2]) * f)}`;
}

/** The slice of viridis each colour scheme uses: [slowest, fastest]. */
export const SOG_SLICE = { light: [0, 0.8], dark: [0.3, 1] } as const;

/** Colour for scale position `s` (0 = slowest … 1 = fastest, clamped) in a scheme. */
export function sogColor(s: number, scheme: 'light' | 'dark' = 'light'): string {
  const [lo, hi] = SOG_SLICE[scheme];
  const c = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0;
  return viridis(lo + c * (hi - lo));
}

// ---- range and bins ---------------------------------------------------------

/** The knots the colour scale spans; SOG outside it clamps to the ends. */
export interface SogRange {
  lo: number;
  hi: number;
}

/** Colours on the scale; enough to read as smooth, few enough to batch. */
export const SOG_BINS = 20;

/** Narrowest range shown: a nearly constant fleet speed still gets a readable key. */
const MIN_SPAN_KN = 1;

/** `p` in [0, 1] of ascending `xs`, linear between ranks. */
export function percentile(xs: ArrayLike<number>, p: number): number {
  const n = xs.length;
  if (!n) return NaN;
  const r = Math.min(1, Math.max(0, p)) * (n - 1);
  const i = Math.floor(r);
  return i + 1 < n ? xs[i] + (xs[i + 1] - xs[i]) * (r - i) : xs[n - 1];
}

/**
 * The 5th–95th percentile of the finite, non-negative values, widened to
 * whole 0.5 kn and to at least MIN_SPAN_KN; null when there are none.
 */
export function sogRange(values: Iterable<number>): SogRange | null {
  const xs: number[] = [];
  for (const v of values) if (Number.isFinite(v) && v >= 0) xs.push(v);
  if (!xs.length) return null;
  const sorted = Float64Array.from(xs).sort();
  let lo = Math.floor(percentile(sorted, 0.05) * 2) / 2;
  let hi = Math.ceil(percentile(sorted, 0.95) * 2) / 2;
  if (hi - lo < MIN_SPAN_KN) {
    const mid = (lo + hi) / 2;
    lo = Math.max(0, Math.floor((mid - MIN_SPAN_KN / 2) * 2) / 2);
    hi = lo + MIN_SPAN_KN;
  }
  return { lo, hi };
}

/** Bin of `kn` on `r`: 0 slowest … bins-1 fastest, clamped (non-finite → 0). */
export function sogBin(kn: number, r: SogRange, bins = SOG_BINS): number {
  if (!Number.isFinite(kn)) return 0;
  const b = Math.floor(((kn - r.lo) / (r.hi - r.lo)) * bins);
  return Math.min(bins - 1, Math.max(0, b));
}

/** Scale position of bin `b`'s colour: its centre. */
export const binPos = (b: number, bins = SOG_BINS): number => (b + 0.5) / bins;

/** By day, a bin this pale against white (under 3:1) is drawn over a thin dark casing. */
export const sogCasedByDay = (b: number, bins = SOG_BINS): boolean => contrast(sogColor(binPos(b, bins)), SPEED_BG.light) < 3;

/** stroke (day) + --cd (night) for bin `b`, as SVG attributes. */
export const sogStroke = (b: number, bins = SOG_BINS): string =>
  `stroke="${sogColor(binPos(b, bins))}" style="--cd:${sogColor(binPos(b, bins), 'dark')}"`;

/** fill (day) + --cd (night) for a knot value on `r` (start hulls). */
export const sogFill = (kn: number, r: SogRange): string => {
  const s = (kn - r.lo) / (r.hi - r.lo);
  return `fill="${sogColor(s)}" style="--cd:${sogColor(s, 'dark')}"`;
};

const ranges = new WeakMap<RaceAnalysis, Map<string, SogRange | null>>();
function cached(a: RaceAnalysis, key: string, make: () => SogRange | null): SogRange | null {
  let m = ranges.get(a);
  if (!m) ranges.set(a, (m = new Map()));
  if (!m.has(key)) m.set(key, make());
  return m.get(key)!;
}

/** The track map's range: the racing fleet's SOG over leg `leg`, or the whole race (excluded boats are not in `drawings`). */
export function trackSogRange(a: RaceAnalysis, leg: number | null): SogRange | null {
  return cached(a, `leg:${leg}`, () =>
    sogRange(
      (function* () {
        for (const d of a.drawings) for (const s of d.segments) if (leg == null || s.leg === leg) yield* s.sog;
      })(),
    ),
  );
}

// ---- per-leg scale ----------------------------------------------------------
//
// Whole race, "Scale: Per leg": a planing class does 13 kn downwind and 6 up,
// so one race-wide range leaves every beat in the bottom bins. Instead each
// segment is binned on its own leg's fleet range (trackSogRange(a, leg)), so a
// bin means "this far between the leg's 5th and 95th percentile". The bins
// stay shared, so a path per bin per boat still covers every leg.

/** The leg whose range colours a segment of leg `leg`: anything before leg 1 borrows leg 1's. */
export const scaleLeg = (leg: number): number => Math.max(0, leg);

/** The range a segment of leg `segLeg` is binned on, for the map showing `view` (one leg, or all) under `scale`. */
export function segmentSogRange(a: RaceAnalysis, segLeg: number, view: number | null, scale: SogScale): SogRange | null {
  if (view != null) return trackSogRange(a, view);
  if (scale === 'race') return trackSogRange(a, null);
  return trackSogRange(a, scaleLeg(segLeg)) ?? trackSogRange(a, null);
}

/** Each leg's fleet range, in leg order (null where the leg has no speed data). */
export const legSogRanges = (a: RaceAnalysis): { name: string; range: SogRange | null }[] =>
  a.legs.map((l) => ({ name: l.name, range: trackSogRange(a, l.index) }));

const legName = (a: RaceAnalysis, leg: number): string => a.legs[leg]?.name ?? (leg < 0 ? 'Before leg 1' : `Leg ${leg + 1}`);
const span = (r: SogRange): string => `${f1(r.lo)}–${f1(r.hi)}`;

/** "Beat 1 5.0–7.0 · Run 1 6.0–13.5 · … kn": every leg's range, for the key and the map's label. */
export function legRangeList(a: RaceAnalysis): string {
  const parts = legSogRanges(a)
    .filter((l) => l.range)
    .map((l) => `${l.name} ${span(l.range!)}`);
  return parts.length ? `${parts.join(' · ')} kn` : '';
}

/** The hover's leg line: "Beat 2 · range 4.5–7.0 kn" when scaled per leg, else just the leg. */
export function sogHoverLeg(a: RaceAnalysis, leg: number, view: number | null, scale: SogScale): string {
  const r = view == null && scale === 'leg' ? segmentSogRange(a, leg, null, 'leg') : null;
  return `${legName(a, leg)}${r ? ` · range ${span(r)} kn` : ''}`;
}

/** The start chart's range: racing boats' trail SOG over the START_TRAIL_MS before the gun. */
export function startSogRange(a: RaceAnalysis): SogRange | null {
  return cached(a, 'start', () =>
    sogRange(
      (function* () {
        for (const d of a.drawings) yield* d.trail.sog;
      })(),
    ),
  );
}

/** Whether any of these fix-time series has a step over `gapMs` (drawn grey dashed). */
export function hasGaps(series: Iterable<ArrayLike<number>>, gapMs = SOG_GAP_MS): boolean {
  for (const t of series) for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > gapMs) return true;
  return false;
}

/** The map's segments for leg `leg` (or all): their fix times, for `hasGaps`. */
export function* segmentTimes(a: RaceAnalysis, leg: number | null): Generator<Float64Array> {
  for (const d of a.drawings) for (const s of d.segments) if (leg == null || s.leg === leg) yield s.t;
}

// ---- batched paths ----------------------------------------------------------

/** One boat's (or a group's) path data: per bin, the casing for pale bins, the gaps. */
export interface SogPaths {
  bins: string[];
  casing: string;
  gap: string;
}

export const emptySogPaths = (bins = SOG_BINS): SogPaths => ({ bins: Array<string>(bins).fill(''), casing: '', gap: '' });

const xy = (x: number, y: number): string => `${x.toFixed(1)},${y.toFixed(1)}`;

/**
 * Append one run of track to `acc`. Each step i → i+1 takes the bin of its
 * mean SOG; consecutive same-bin steps extend one "M…L…" run, and a new run
 * starts on the shared point, so the line stays continuous. Steps longer than
 * `gapMs` go to the gap path instead; steps with an end outside `inside` are skipped.
 */
export function addSogTrack(
  acc: SogPaths,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  t: ArrayLike<number>,
  sog: ArrayLike<number>,
  r: SogRange,
  inside: (i: number) => boolean = () => true,
  gapMs = SOG_GAP_MS,
): void {
  const bins = acc.bins.length;
  let cur = -1;
  let cased = false;
  const n = Math.min(x.length, y.length, t.length, sog.length);
  for (let i = 0; i + 1 < n; i++) {
    if (!inside(i) || !inside(i + 1)) {
      cur = -1;
      cased = false;
      continue;
    }
    const p = xy(x[i], y[i]);
    const q = xy(x[i + 1], y[i + 1]);
    if (t[i + 1] - t[i] > gapMs) {
      acc.gap += `M${p}L${q}`;
      cur = -1;
      cased = false;
      continue;
    }
    const b = sogBin((sog[i] + sog[i + 1]) / 2, r, bins);
    if (b === cur) acc.bins[b] += `L${q}`;
    else acc.bins[b] += `M${p}L${q}`;
    if (sogCasedByDay(b, bins)) {
      acc.casing += cased ? `L${q}` : `M${p}L${q}`;
      cased = true;
    } else cased = false;
    cur = b;
  }
}

/**
 * The SVG for `acc`: casing (by day), one path per bin present, the gaps
 * dashed grey. `w` is the stroke width in map units, `k` the map's unit.
 */
export function sogPathsSvg(acc: SogPaths, w: number, k: number): string {
  let s = acc.casing ? `<path class="sog-case" d="${acc.casing}" stroke-width="${((w + 1) * k).toFixed(2)}"/>` : '';
  acc.bins.forEach((d, b) => {
    if (d) s += `<path class="sog" data-bin="${b}" d="${d}" ${sogStroke(b, acc.bins.length)}/>`;
  });
  if (acc.gap) s += `<path class="sog-gap" d="${acc.gap}" stroke-dasharray="${(3 * k).toFixed(2)} ${(2.5 * k).toFixed(2)}"/>`;
  return s;
}

// ---- hover lookup -----------------------------------------------------------

/** Every drawn fix, in chart coordinates, for the hover readout. */
export interface SogIndex {
  x: Float64Array;
  y: Float64Array;
  t: Float64Array;
  sog: Float32Array;
  /** The leg each fix was drawn in (TrackSegment.leg). */
  leg: Int16Array;
  /** Index into `ids`, per fix. */
  boat: Uint16Array;
  ids: string[];
  /** Per boat: [first, end) in the arrays above. */
  span: [number, number][];
  /** A uniform grid: cell size, origin, columns, and a linked list of fixes per cell. */
  cell: number;
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  head: Int32Array;
  next: Int32Array;
}

export interface IndexedTrack {
  id: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  t: ArrayLike<number>;
  sog: ArrayLike<number>;
  leg: number;
}

/** Build the lookup over `tracks` (already in chart coordinates); a boat's tracks must be consecutive. */
export function sogIndex(tracks: IndexedTrack[], cell: number): SogIndex {
  const n = tracks.reduce((s, tk) => s + Math.min(tk.x.length, tk.y.length, tk.t.length, tk.sog.length), 0);
  const ix: SogIndex = {
    x: new Float64Array(n),
    y: new Float64Array(n),
    t: new Float64Array(n),
    sog: new Float32Array(n),
    leg: new Int16Array(n),
    boat: new Uint16Array(n),
    ids: [],
    span: [],
    cell: cell > 0 ? cell : 1,
    x0: Infinity,
    y0: Infinity,
    cols: 1,
    rows: 1,
    head: new Int32Array(0),
    next: new Int32Array(n).fill(-1),
  };
  let j = 0;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const tk of tracks) {
    if (ix.ids[ix.ids.length - 1] !== tk.id) {
      ix.ids.push(tk.id);
      ix.span.push([j, j]);
    }
    const b = ix.ids.length - 1;
    const m = Math.min(tk.x.length, tk.y.length, tk.t.length, tk.sog.length);
    for (let i = 0; i < m; i++, j++) {
      ix.x[j] = tk.x[i];
      ix.y[j] = tk.y[i];
      ix.t[j] = tk.t[i];
      ix.sog[j] = tk.sog[i];
      ix.leg[j] = tk.leg;
      ix.boat[j] = b;
      ix.x0 = Math.min(ix.x0, tk.x[i]);
      ix.y0 = Math.min(ix.y0, tk.y[i]);
      x1 = Math.max(x1, tk.x[i]);
      y1 = Math.max(y1, tk.y[i]);
    }
    ix.span[b][1] = j;
  }
  if (!n) return ix;
  // Coarsen the grid if the area is huge for the cell size (keeps it a few MB at most).
  while (((x1 - ix.x0) / ix.cell + 1) * ((y1 - ix.y0) / ix.cell + 1) > 1 << 20) ix.cell *= 2;
  ix.cols = Math.floor((x1 - ix.x0) / ix.cell) + 1;
  ix.rows = Math.floor((y1 - ix.y0) / ix.cell) + 1;
  ix.head = new Int32Array(ix.cols * ix.rows).fill(-1);
  for (let i = 0; i < n; i++) {
    const c = Math.floor((ix.y[i] - ix.y0) / ix.cell) * ix.cols + Math.floor((ix.x[i] - ix.x0) / ix.cell);
    ix.next[i] = ix.head[c];
    ix.head[c] = i;
  }
  return ix;
}

/**
 * The fix nearest (x, y) within `r` chart units, or -1: only boat `only`'s
 * fixes when given (a linear scan of its span), else any boat's (the grid).
 */
export function nearestSample(ix: SogIndex, x: number, y: number, r: number, only: string | null = null): number {
  let best = -1;
  let bestD = r * r;
  const test = (i: number): void => {
    const d = (ix.x[i] - x) ** 2 + (ix.y[i] - y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  };
  if (only != null) {
    const b = ix.ids.indexOf(only);
    if (b < 0) return -1;
    for (let i = ix.span[b][0]; i < ix.span[b][1]; i++) test(i);
    return best;
  }
  if (!ix.head.length) return -1;
  const c0 = Math.max(0, Math.floor((x - r - ix.x0) / ix.cell));
  const c1 = Math.min(ix.cols - 1, Math.floor((x + r - ix.x0) / ix.cell));
  const r0 = Math.max(0, Math.floor((y - r - ix.y0) / ix.cell));
  const r1 = Math.min(ix.rows - 1, Math.floor((y + r - ix.y0) / ix.cell));
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      for (let i = ix.head[row * ix.cols + col]; i >= 0; i = ix.next[i]) test(i);
    }
  }
  return best;
}

// ---- start chart preference, controls and keys ------------------------------

export type StartColour = 'boat' | 'speed';
export const START_COLOUR_KEY = 'recall.startColour';
export const parseStartColour = (raw: string | null | undefined): StartColour => (raw === 'speed' ? 'speed' : 'boat');

/** "Colour: Boat | Speed" beside the start chart's zoom presets. */
export function startColourControls(colour: StartColour): string {
  const btns = (
    [
      ['boat', 'Boat'],
      ['speed', 'Speed'],
    ] as const
  )
    .map(([v, text]) => `<button type="button" data-start-colour="${v}" aria-pressed="${v === colour}">${text}</button>`)
    .join('');
  return `<div class="seg" role="group" aria-label="Color start trails by"><span class="seg-lbl" aria-hidden="true">Color</span>${btns}</div>`;
}

const gradient = (scheme: 'light' | 'dark'): string =>
  `linear-gradient(to right, ${[0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((s) => sogColor(s, scheme)).join(', ')})`;

const bar = (lo: string, hi: string): string =>
  `<span class="sog-lo">${lo}</span><span class="spd-bar sog-bar" style="--g:${gradient('light')};--gd:${gradient('dark')}" aria-hidden="true"></span><span class="sog-hi">${hi}</span>`;
/** A legend swatch and its label as one flex item (speed-key wraps), e.g. the dashed grey "no data". */
export const keySwatch = (cls: string, label: string, title = ''): string =>
  `<span class="key-sw"${title ? ` title="${esc(title)}"` : ''}><span class="${cls}" aria-hidden="true"></span> ${esc(label)}</span>`;

const SOG_GAP_TITLE = `Telemetry gap: fixes over ${SOG_GAP_MS / 1000} s apart`;
const gapNote = (gaps: boolean, title = SOG_GAP_TITLE): string => (gaps ? keySwatch('spd-none', 'no data', title) : '');

/** "4.0 kn [bar] 8.0 kn", "SOG · what it spans", and the "no data" swatch when the drawing has gaps (the method is in the ⓘ). */
export function sogKey(r: SogRange | null, what: string, gaps = false, gapTitle?: string): string {
  if (!r) return `<span class="muted">No speed data to color by.</span>`;
  return `${bar(`${f1(r.lo)} kn`, `${f1(r.hi)} kn`)}
    <span class="muted">SOG · ${esc(what)}</span>${gapNote(gaps, gapTitle)}`;
}

/**
 * Whole race, Per leg: one bar with no knots on it (its ends mean something
 * different on each leg), "slow → fast within each leg", then each leg's range.
 * The gap swatch stays on the first line with the description; .sog-legs wraps
 * below (flex-basis: 100%).
 */
export function sogLegKey(a: RaceAnalysis, gaps = false, gapTitle?: string): string {
  const list = legRangeList(a);
  if (!list) return `<span class="muted">No speed data to color by.</span>`;
  return `${bar('slow', 'fast')}
    <span>slow → fast within each leg</span>${gapNote(gaps, gapTitle)}<span class="sog-legs">${esc(list)}</span>`;
}
