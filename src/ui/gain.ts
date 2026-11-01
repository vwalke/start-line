/**
 * "Color: Gain/loss" for the track map: every stretch of track shaded by how fast the boat was gaining on (green) or
 * losing to (red) the fleet's median boat up the ladder of its leg (analysis/coach/gainLoss.ts, m/min over 30 s), on
 * a diverging scale through a muted gray (about even).
 *
 * - Bins: GAIN_BINS, an odd number, so the middle bin (± a ninth of the range around 0) is the gray. Drawn as Boat
 *   speed is (ui/sog.ts batched paths, `stroke` = day, `--cd` = night).
 * - Range: symmetric, ± the fleet's 90th percentile of |gain| over the leg shown (or the race), up to whole 5 m/min,
 *   clamped to GAIN_MIN–GAIN_MAX; beyond it clamps to the ends.
 * - Colors: one explicit color per bin and scheme, picked in OKLCH (red hue 27°, green 145°): only the middle bin is
 *   gray; the bins beside it are already clearly red or green (chroma ≥ 0.15), stepping to the strongest at the ends.
 *   The red is darker than the green in both schemes (OKLab L: day 0.40–0.52 vs 0.56–0.62, night 0.60–0.66 vs
 *   0.80–0.86), so they read apart for red-green color-blind viewers; every bin ≥ 3:1 on its chart (the day gray is
 *   a shade darker than sog.ts NEUTRAL_DAY for that).
 * - No reading (before the gun, after a boat's finish, off any leg) draws gray, like even; the wind still on its way,
 *   or the rates still being worked out (gainSeriesSoon), every track gray (charts.ts NEUTRAL_PAINT).
 */
import type { CoachModel } from '../analysis/coach';
import { GAIN_SLICE_MS, gainAt, gainFill, gainSeries, gainSeriesReady, type GainSeries } from '../analysis/coach/gainLoss';
import type { RaceAnalysis } from '../analysis/types';
import type { SrcTrack } from './mapPieces';
import { binPos, NEUTRAL_NIGHT, percentile, sogBin, sogKeyPending, valueScaleHtml, type SogRange, type SogScheme } from './sog';
import { esc } from './format';

/** Colors on the scale (odd: the middle one is gray). */
export const GAIN_BINS = 9;
/** The range's half-width, m/min: at least, at most. */
export const GAIN_MIN = 5;
export const GAIN_MAX = 100;

/** The day scale's middle bin: a muted gray, ≥ 3:1 on white. */
export const GAIN_NEUTRAL_DAY = '#868d96';

/** Each bin's color, losing fastest → even → gaining fastest: by day and by night (above). */
export const GAIN_COLORS: Record<SogScheme, readonly string[]> = {
  light: ['#8a020b', '#9e020f', '#b00c15', '#b6322d', GAIN_NEUTRAL_DAY, '#409d48', '#279936', '#089428', '#008d24'],
  dark: ['#e62c2c', '#ea3d38', '#e5554c', '#df695e', NEUTRAL_NIGHT, '#7bd77f', '#6fe276', '#5fed6c', '#54f667'],
};

/** The color at scale position `s` (0 = losing fastest, 0.5 = even, 1 = gaining fastest; clamped, NaN → even): its bin's, as #rrggbb. */
export function gainColor(s: number, scheme: SogScheme = 'light'): string {
  const x = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0.5;
  return GAIN_COLORS[scheme][Math.min(GAIN_BINS - 1, Math.floor(x * GAIN_BINS))];
}

/** Bin `b`'s stroke: the day color, and the night one as `--cd`. */
export const gainStroke = (b: number, bins = GAIN_BINS): string => `stroke="${gainColor(binPos(b, bins))}" style="--cd:${gainColor(binPos(b, bins), 'dark')}"`;

/** The color a rate on `r` is drawn in (its bin's, as on the tracks and the key's bar); no reading: gray. */
export const gainRateColor = (v: number, r: SogRange, scheme: SogScheme = 'light'): string =>
  gainColor(binPos(sogBin(Number.isFinite(v) ? v : 0, r, GAIN_BINS), GAIN_BINS), scheme);

/** The model's gain rates (gainLoss.ts), for race `a`. */
export const gainSeriesOf = (a: RaceAnalysis, m: CoachModel): GainSeries => gainSeries(a, m);

/** Runs `run` when the page is idle (or soon, if it never is); a timer where there's no requestIdleCallback. */
export type Later = (run: () => void) => void;
const whenIdle: Later = (run) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 200 });
  else setTimeout(run, 0);
};

/** The model whose fill is being stepped, and what to call when it's in. */
let wanted: CoachModel | null = null;
let onIn: (() => void) | null = null;

/**
 * The model's gain rates if worked out; else null, and they're worked out in GAIN_SLICE_MS slices when the page is idle
 * (gainLoss.ts gainFill), `done` called once they're in (the latest caller's). Asking for another model stops this
 * one's slices (its fill kept, to resume if asked again), so a race switch never paints with another race's.
 */
export function gainSeriesSoon(a: RaceAnalysis, m: CoachModel, done: () => void, later: Later = whenIdle): GainSeries | null {
  const s = gainSeriesReady(m);
  if (s) return s;
  onIn = done;
  if (wanted === m) return null;
  wanted = m;
  const f = gainFill(a, m);
  const tick = (): void => {
    if (wanted !== m) return;
    if (!f.step(performance.now() + GAIN_SLICE_MS)) return later(tick);
    wanted = null;
    const cb = onIn;
    onIn = null;
    cb?.();
  };
  later(tick);
  return null;
}

/** ± the fleet's 90th percentile of |gain| (above) over the samples of `leg` (or every leg), as a range. */
export function gainRangeOf(s: GainSeries, leg: number | null): SogRange {
  const xs: number[] = [];
  for (let i = 0; i < s.rate.length; i++) {
    const v = s.rate[i];
    if (Number.isFinite(v) && (leg == null ? s.leg[i] >= 0 : s.leg[i] === leg)) xs.push(Math.abs(v));
  }
  const p = xs.length ? percentile(Float64Array.from(xs).sort(), 0.9) : 0;
  const R = Math.min(GAIN_MAX, Math.max(GAIN_MIN, Math.ceil(p / 5) * 5));
  return { lo: -R, hi: R };
}

const ranges = new WeakMap<GainSeries, Map<number | null, SogRange>>();
/** The track map's range for leg `leg` (or all), once per model. */
export function trackGainRange(a: RaceAnalysis, m: CoachModel, leg: number | null): SogRange {
  const s = gainSeriesOf(a, m);
  let byLeg = ranges.get(s);
  if (!byLeg) ranges.set(s, (byLeg = new Map()));
  if (!byLeg.has(leg)) byLeg.set(leg, gainRangeOf(s, leg));
  return byLeg.get(leg)!;
}

interface SrcGain {
  v: Float32Array;
  done: Uint8Array;
}
const perSeries = new WeakMap<GainSeries, WeakMap<SrcTrack, SrcGain>>();

/**
 * Boat `id`'s gain rate at each fix of `src` (m/min; no reading → 0, drawn gray), indexed as `src`, fixes [i0, i1)
 * worked out once per model and source.
 */
export function gainValues(s: GainSeries, src: SrcTrack, id: string, i0 = 0, i1 = src.t.length): Float32Array {
  let bySrc = perSeries.get(s);
  if (!bySrc) perSeries.set(s, (bySrc = new WeakMap()));
  let g = bySrc.get(src);
  if (!g) bySrc.set(src, (g = { v: new Float32Array(src.t.length), done: new Uint8Array(src.t.length) }));
  const hi = Math.min(i1, src.t.length);
  for (let i = Math.max(0, i0); i < hi; i++) {
    if (g.done[i]) continue;
    const v = gainAt(s, id, src.t[i]);
    g.v[i] = Number.isFinite(v) ? v : 0;
    g.done[i] = 1;
  }
  return g.v;
}

/** "+12", "−3", "0": a rate with its sign. */
export const signedRate = (v: number): string => {
  const r = Math.round(v);
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : '0';
};

/** The tooltip's line: "+12 m/min vs fleet" (null where there's no reading). */
export function gainTipLine(a: RaceAnalysis, m: CoachModel, id: string, t: number): string | null {
  const v = gainAt(gainSeriesOf(a, m), id, t);
  return Number.isFinite(v) ? `${signedRate(v)} m/min vs fleet` : null;
}

const bands = (scheme: SogScheme): string => {
  const pct = (b: number): string => `${+((b / GAIN_BINS) * 100).toFixed(2)}%`;
  return `linear-gradient(to right, ${Array.from({ length: GAIN_BINS }, (_, b) => `${gainColor(binPos(b, GAIN_BINS), scheme)} ${pct(b)} ${pct(b + 1)}`).join(', ')})`;
};
const gainBarStyle = (): string => `--g:${bands('light')};--gd:${bands('dark')}`;

export const GAIN_KEY_TEXT = 'Gain/loss vs fleet · m/min';

/**
 * The key: the red–gray–green bar with − / 0 / + ticks in m/min, "Gain/loss vs fleet · m/min". `m` undefined: the
 * wind is still on its way (the bar alone); null: none for this race.
 */
export function gainKey(a: RaceAnalysis, m: CoachModel | null | undefined, leg: number | null): string {
  if (m === undefined) return sogKeyPending('Gain/loss vs fleet', 'm/min', gainBarStyle());
  if (!m) return `<span class="muted">Gain/loss colors aren't available for this race.</span>`;
  // The title carries the unit: the ticks don't (a "m/min" past the bar's end ran into it).
  return `${valueScaleHtml(trackGainRange(a, m, leg), 'm/min', gainBarStyle(), signedRate, false)}
    <span class="muted">${esc(GAIN_KEY_TEXT)}</span>`;
}
