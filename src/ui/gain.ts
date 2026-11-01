/**
 * "Color: Gain/loss" for the track map: each leg of a boat's track one color, by the places it gained (green) or lost
 * (red) on that leg (analysis/coach/gainLoss.ts: its place entering the leg less its place at the leg's end; the leg
 * it is on at the replay's time, its change so far), a muted gray where it held its place.
 *
 * - Shades: GAIN_BINS, −3 or more · −2 · −1 · held · +1 · +2 · +3 or more (GAIN_CAP), drawn as Boat speed is (ui/sog.ts
 *   batched paths, `stroke` = day, `--cd` = night). Deeper by day and brighter by night with more places; the red
 *   darker than the green at each step (OKLab L), so they read apart for red-green color-blind viewers; every shade
 *   ≥ 3:1 on its chart.
 * - Before the gun, or no place at one end of the leg: the held gray, and no hover line. The Coach's ladder still on
 *   its way: every track the neutral gray (charts.ts NEUTRAL_PAINT).
 */
import type { CoachModel } from '../analysis/coach';
import { legGainAt, legPlaces } from '../analysis/coach/gainLoss';
import type { RaceAnalysis } from '../analysis/types';
import { esc } from './format';
import type { BinStroke, SogScheme } from './sog';

/** Places gained or lost beyond this shade as this many. */
export const GAIN_CAP = 3;
/** Shades on the scale: −GAIN_CAP … +GAIN_CAP (the middle one gray). */
export const GAIN_BINS = 2 * GAIN_CAP + 1;

/** The held gray, by day. */
export const GAIN_NEUTRAL_DAY = '#868d96';

/** Each shade, lost most → held → gained most: by day and by night. */
export const GAIN_COLORS: Record<SogScheme, readonly string[]> = {
  light: ['#8a020b', '#ab1f1a', '#cc4a40', GAIN_NEUTRAL_DAY, '#4fa257', '#23903c', '#007a26'],
  dark: ['#ff3326', '#e0574c', '#a8645e', '#6e7783', '#6aa870', '#5fd06a', '#6ff57c'],
};

/** The shade for `g` places gained (− lost), capped at GAIN_CAP either way; null: the held gray. */
export const gainBin = (g: number | null): number => (g == null ? GAIN_CAP : Math.min(GAIN_CAP, Math.max(-GAIN_CAP, Math.round(g))) + GAIN_CAP);

/** The color for `g` places gained (above), as #rrggbb. */
export const gainColor = (g: number | null, scheme: SogScheme = 'light'): string => GAIN_COLORS[scheme][gainBin(g)];

/** Shade `b`'s stroke: the day color, and the night one as `--cd`. */
export const gainStroke: BinStroke = (b) => `stroke="${GAIN_COLORS.light[b]}" style="--cd:${GAIN_COLORS.dark[b]}"`;

/** "+2 places on Beat 2", "−1 place on Run 1", "Held place on Beat 1". */
export function placesLine(g: number, legName: string): string {
  if (g === 0) return `Held place on ${legName}`;
  const n = Math.abs(g);
  return `${g > 0 ? '+' : '−'}${n} place${n === 1 ? '' : 's'} on ${legName}`;
}

/**
 * The tooltip's line for a fix of boat `id` on leg `leg`, the map at `now` (ms; Infinity: the whole race): its leg's
 * places (placesLine; the leg under way, so far). Null before the gun or with no place at one end.
 */
export function gainTipLine(a: RaceAnalysis, m: CoachModel, id: string, leg: number, now: number): string | null {
  const g = legGainAt(legPlaces(a, m), id, leg, now);
  return g == null ? null : placesLine(g, a.legs[leg]?.name ?? `Leg ${leg + 1}`);
}

export const GAIN_KEY_TEXT = 'Places gained/lost on the leg';

/** Each shade's label, lost most → gained most: "−3+" … "0" … "+3+". */
export const GAIN_LABELS: readonly string[] = Array.from({ length: GAIN_BINS }, (_, b) => {
  const g = b - GAIN_CAP;
  const s = g > 0 ? `+${g}` : g < 0 ? `−${-g}` : '0';
  return Math.abs(g) === GAIN_CAP ? `${s}+` : s;
});

/** The key: a swatch per shade with its places, and "Places gained/lost on the leg". `m` null: none for this race. */
export function gainKey(m: CoachModel | null | undefined): string {
  if (m === null) return `<span class="muted">Gain/loss colors aren't available for this race.</span>`;
  const sw = GAIN_LABELS.map((l, b) => `<span class="gain-sw" style="--c:${GAIN_COLORS.light[b]};--cd:${GAIN_COLORS.dark[b]}">${l}</span>`).join('');
  return `<span class="gain-key" role="img" aria-label="${esc(`${GAIN_KEY_TEXT}: red lost, gray held, green gained; deeper with more places, up to ${GAIN_CAP} or more`)}">${sw}</span>
    <span class="muted">${esc(GAIN_KEY_TEXT)}</span>`;
}
