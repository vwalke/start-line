/**
 * "Colour: Boat speed" for the track map and "Colour: Speed" for the start
 * chart: every stretch of track shaded by that boat's own SOG at the time
 * (smoothed over 4 s in the analysis, analysis/smooth.ts), so you can see
 * where on a leg boats were quick, and who hit the line at speed.
 *
 * Turbo, trimmed: blue → cyan → green → yellow → orange → red. Its hue sweeps
 * far wider than viridis, so a knot or two reads as a plainly different
 * colour, and its blue-cyan-green stretch keeps it apart from Rank's plasma
 * (purple → magenta → orange → yellow, ui/speed.ts). TURBO below is matplotlib's
 * turbo over 0.12–0.88, resampled to even steps of CIELAB distance, so equal
 * knots look about equally far apart along the whole scale.
 *
 * The trim is what lets one ramp serve both schemes, so a speed is the same
 * colour by day and by night: turbo's own ends (near-black blue, dark red)
 * vanish on #171d26, while 0.12 (#4666dd) and 0.88 (#ce2d04) keep ≥ 3.2:1
 * there and ≥ 4.9:1 on white. The bright middle is pale on white, so by day
 * every bin under 3:1 is drawn over one thin dark casing path per boat.
 *
 * Drawing: SOG is quantised to SOG_BINS colours and each boat gets one <path>
 * per bin present (runs of same-bin steps as M…L…) and, by day, one casing
 * path: bounded per boat however long the race, never one element per fix.
 * The tracks come with every hole filled in (ui/gapFill.ts), drawn as the rest.
 */
import type { RaceAnalysis } from '../analysis/types';
import { esc, f1 } from './format';
import { contrast, SPEED_BG, type SogScale } from './speed';

/** Turbo (matplotlib) over 0.12–0.88, at 13 evenly spaced CIELAB distances: slowest first. */
const TURBO = [
  [0x46, 0x66, 0xdd],
  [0x40, 0x99, 0xff],
  [0x2e, 0xb4, 0xf2],
  [0x20, 0xc7, 0xdf],
  [0x18, 0xdd, 0xc2],
  [0x2a, 0xef, 0xa1],
  [0x52, 0xfa, 0x7a],
  [0x96, 0xfe, 0x44],
  [0xcd, 0xec, 0x34],
  [0xec, 0xd1, 0x3a],
  [0xfd, 0xac, 0x34],
  [0xf9, 0x78, 0x1e],
  [0xce, 0x2d, 0x04],
] as const;

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');

/**
 * The colour for scale position `s` (0 = slowest … 1 = fastest; clamped, NaN → 0),
 * linear in RGB between stops, as #rrggbb. The tracks, hulls, dots and the key's bar
 * all come from here, in both schemes.
 */
export function sogColor(s: number): string {
  const x = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) * (TURBO.length - 1) : 0;
  const i = Math.min(TURBO.length - 2, Math.floor(x));
  const f = x - i;
  const [p, q] = [TURBO[i], TURBO[i + 1]];
  return `#${hex2(p[0] + (q[0] - p[0]) * f)}${hex2(p[1] + (q[1] - p[1]) * f)}${hex2(p[2] + (q[2] - p[2]) * f)}`;
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

/** The stroke for bin `b`, as an SVG attribute (the same in both schemes). */
export const sogStroke = (b: number, bins = SOG_BINS): string => `stroke="${sogColor(binPos(b, bins))}"`;

/** The colour a knot value on `r` is drawn in: its bin's, as on the tracks and the key's bar. */
export const sogKnColor = (kn: number, r: SogRange, bins = SOG_BINS): string => sogColor(binPos(sogBin(kn, r, bins), bins));

/** The fill for a knot value on `r` (start hulls). */
export const sogFill = (kn: number, r: SogRange): string => `fill="${sogKnColor(kn, r)}"`;

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

// ---- batched paths ----------------------------------------------------------

/** One boat's (or a group's) path data: per bin, and the casing for pale bins. */
export interface SogPaths {
  bins: string[];
  casing: string;
}

export const emptySogPaths = (bins = SOG_BINS): SogPaths => ({ bins: Array<string>(bins).fill(''), casing: '' });

const xy = (x: number, y: number): string => `${x.toFixed(1)},${y.toFixed(1)}`;

/**
 * Append one run of track to `acc`. Each step i → i+1 takes the bin of its
 * mean SOG; consecutive same-bin steps extend one "M…L…" run, and a new run
 * starts on the shared point, so the line stays continuous. Steps with an end
 * outside `inside` are skipped.
 */
export function addSogTrack(acc: SogPaths, x: ArrayLike<number>, y: ArrayLike<number>, sog: ArrayLike<number>, r: SogRange, inside: (i: number) => boolean = () => true): void {
  const bins = acc.bins.length;
  let cur = -1;
  let cased = false;
  const n = Math.min(x.length, y.length, sog.length);
  for (let i = 0; i + 1 < n; i++) {
    if (!inside(i) || !inside(i + 1)) {
      cur = -1;
      cased = false;
      continue;
    }
    const p = xy(x[i], y[i]);
    const q = xy(x[i + 1], y[i + 1]);
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

/** The SVG for `acc`: casing (by day), then one path per bin present. `w` is the stroke width in map units, `k` the map's unit. */
export function sogPathsSvg(acc: SogPaths, w: number, k: number): string {
  let s = acc.casing ? `<path class="sog-case" d="${acc.casing}" stroke-width="${((w + 1) * k).toFixed(2)}"/>` : '';
  acc.bins.forEach((d, b) => {
    if (d) s += `<path class="sog" data-bin="${b}" d="${d}" ${sogStroke(b, acc.bins.length)}/>`;
  });
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

/** The key's bar: one hard-edged band per bin, in the bins' own colours, so it matches the tracks exactly. */
export const sogGradient = (bins = SOG_BINS): string => {
  const pct = (b: number): string => `${+((b / bins) * 100).toFixed(2)}%`;
  const bands = Array.from({ length: bins }, (_, b) => `${sogColor(binPos(b, bins))} ${pct(b)} ${pct(b + 1)}`);
  return `linear-gradient(to right, ${bands.join(', ')})`;
};

// ---- the key's ticks --------------------------------------------------------

/** Knot steps between labelled ticks, finest first. */
const TICK_STEPS = [0.5, 1, 2, 5, 10, 20, 50] as const;
/** The unlabelled ticks between labelled ones, per labelled step (none under 0.5 kn). */
const MINOR_STEP: Record<number, number | undefined> = { 1: 0.5, 2: 1, 5: 1, 10: 5, 20: 10, 50: 10 };
/** Estimated width of one label character at the key's size (tabular digits, 0.72rem), and the clear space between labels. */
export const TICK_CHAR_PX = 7;
export const TICK_GAP_PX = 6;
/** Labelled ticks at least this far apart, however short the labels, so the scale reads as steps, not a crowd. */
export const TICK_MIN_PX = 40;
/** Minor ticks closer than this are left out. */
const MINOR_MIN_PX = 6;
/** The key's bar width on a wide screen, and the narrowest it shrinks to (style.css .sog-scale). */
export const SOG_KEY_WIDE_PX = 240;
export const SOG_KEY_NARROW_PX = 150;

export interface SogTick {
  kn: number;
  /** Along the bar, 0–1. */
  pos: number;
  /** Null for a minor tick. */
  label: string | null;
  end?: 'lo' | 'hi';
}

/** "6", "6.5": whole knots without a decimal. */
const knLabel = (kn: number): string => (Number.isInteger(kn) ? String(kn) : kn.toFixed(1));
const near = (x: number, y: number): boolean => Math.abs(x - y) < 1e-6;

/** A tick label's [left, right] in px on a bar `widthPx` wide: the ends sit inside the bar, the rest centred. */
export function tickLabelBox(t: SogTick, widthPx: number): [number, number] {
  const w = (t.label?.length ?? 0) * TICK_CHAR_PX;
  if (t.end === 'lo') return [0, w];
  if (t.end === 'hi') return [widthPx - w, widthPx];
  const x = t.pos * widthPx;
  return [x - w / 2, x + w / 2];
}

/**
 * The key's ticks for `r` on a bar `widthPx` wide, in knot order: the ends,
 * always labelled ("4.5", "8 kn"); labelled ticks at the finest nice step
 * at least TICK_MIN_PX apart whose labels clear each other by TICK_GAP_PX; and unlabelled minor ticks
 * between them where there's room. A labelled tick too close to an end label
 * stays as a minor tick.
 */
export function sogTicks(r: SogRange, widthPx: number): SogTick[] {
  const span = r.hi - r.lo;
  const pos = (kn: number): number => (kn - r.lo) / span;
  const lo: SogTick = { kn: r.lo, pos: 0, label: knLabel(r.lo), end: 'lo' };
  const hi: SogTick = { kn: r.hi, pos: 1, label: `${knLabel(r.hi)} kn`, end: 'hi' };
  const inside = (step: number): number[] => {
    const out: number[] = [];
    for (let k = Math.floor(r.lo / step) + 1; k * step < r.hi - 1e-9; k++) if (k * step > r.lo + 1e-9) out.push(+(k * step).toFixed(6));
    return out;
  };
  const clear = (a: SogTick, b: SogTick): boolean => tickLabelBox(b, widthPx)[0] - tickLabelBox(a, widthPx)[1] >= TICK_GAP_PX;
  let major: SogTick[] = [];
  let step: number | null = null;
  for (const s of TICK_STEPS) {
    const ks = inside(s);
    if (!ks.length) break;
    if ((s / span) * widthPx < TICK_MIN_PX) continue;
    const ts = ks.map((kn) => ({ kn, pos: pos(kn), label: knLabel(kn) }));
    if (ts.every((t, i) => i === 0 || clear(ts[i - 1], t))) {
      major = ts;
      step = s;
      break;
    }
  }
  const minor: SogTick[] = [];
  // Labels crowding an end label lose the label, not the tick.
  while (major.length && !clear(lo, major[0])) minor.push({ ...major.shift()!, label: null });
  while (major.length && !clear(major[major.length - 1], hi)) minor.push({ ...major.pop()!, label: null });
  const m = step == null ? undefined : MINOR_STEP[step];
  if (m != null && (m / span) * widthPx >= MINOR_MIN_PX) {
    for (const kn of inside(m)) if (!near(kn / step!, Math.round(kn / step!))) minor.push({ kn, pos: pos(kn), label: null });
  }
  return [lo, ...major, ...minor, hi].sort((x, y) => x.kn - y.kn);
}

/**
 * The bar with its ticks, laid out for a wide and a narrow bar at once: each
 * tick says whether it shows (w / n) and is labelled (lw / ln) at each, and
 * style.css picks by the bar's own width (a container query).
 */
function scaleHtml(r: SogRange): string {
  const wide = sogTicks(r, SOG_KEY_WIDE_PX);
  const narrow = sogTicks(r, SOG_KEY_NARROW_PX);
  const all = new Map<number, { t: SogTick; cls: string[] }>();
  for (const [set, show, lbl] of [
    [wide, 'w', 'lw'],
    [narrow, 'n', 'ln'],
  ] as const) {
    for (const t of set) {
      const key = Math.round(t.kn * 1e6);
      if (!all.has(key)) all.set(key, { t, cls: [] });
      all.get(key)!.cls.push(show, ...(t.label ? [lbl] : []));
    }
  }
  const ticks = [...all.values()]
    .sort((x, y) => x.t.kn - y.t.kn)
    .map(({ t, cls }) => {
      const label = t.label ?? wide.find((x) => near(x.kn, t.kn))?.label ?? narrow.find((x) => near(x.kn, t.kn))?.label;
      const c = ['tk', ...cls, ...(t.end ? [t.end] : [])].join(' ');
      return `<span class="${c}" style="left:${+(t.pos * 100).toFixed(3)}%">${label ? `<span class="tl">${label}</span>` : ''}</span>`;
    })
    .join('');
  return `<span class="sog-scale" role="img" aria-label="${f1(r.lo)} to ${f1(r.hi)} kn"><span class="sog-bar" style="--g:${sogGradient()}"></span>${ticks}</span>`;
}

const bar = (lo: string, hi: string): string =>
  `<span class="sog-lo">${lo}</span><span class="sog-bar" style="--g:${sogGradient()}" aria-hidden="true"></span><span class="sog-hi">${hi}</span>`;
/** The bar with knots along it ("4.5 · 5 · 6 · 7 · 8 kn") and "SOG · what it spans" (the method is in the ⓘ). */
export function sogKey(r: SogRange | null, what: string): string {
  if (!r) return `<span class="muted">No speed data to color by.</span>`;
  return `${scaleHtml(r)}
    <span class="muted">SOG · ${esc(what)}</span>`;
}

/**
 * Whole race, Per leg: one bar with no knots on it (its ends mean something
 * different on each leg), "slow → fast within each leg", then each leg's range
 * (.sog-legs wraps below: flex-basis: 100%).
 */
export function sogLegKey(a: RaceAnalysis): string {
  const list = legRangeList(a);
  if (!list) return `<span class="muted">No speed data to color by.</span>`;
  return `${bar('slow', 'fast')}
    <span>slow → fast within each leg</span><span class="sog-legs">${esc(list)}</span>`;
}
