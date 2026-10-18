/**
 * "Colour: Speed" for the track map: a viridis scale (perceptual, colour-blind
 * safe), the saved viewing preference, and the controls + key beside the leg
 * legend. Fastest = the bright (yellow) end, slowest = the dark (purple) end.
 *
 * The chart sits on white by day and near-black by night, and no single slice
 * of viridis reads on both: the yellow end vanishes on white, the purple end on
 * #171d26. So each scheme gets its own slice — day 0.00–0.88 (and the bright
 * half of strokes gets a thin dark casing), night 0.25–1.00 — and the SVG
 * carries both (`stroke` = day, `--cd` = night; style.css picks).
 */
import { legRanks, overallRanks, raceLegRanks, type SpeedRank } from '../analysis/speedRank';
import type { RaceAnalysis } from '../analysis/types';
import { duration, esc } from './format';

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
export const SPEED_RANGE = { light: [0, 0.88], dark: [0.25, 1] } as const;

/** Colour for rank position `t` (0 = fastest … 1 = slowest, clamped) in a scheme. */
export function speedColor(t: number, scheme: 'light' | 'dark' = 'light'): string {
  const [lo, hi] = SPEED_RANGE[scheme];
  const c = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1;
  return viridis(hi - c * (hi - lo));
}

/** Strokes this close to the fastest end get a thin dark casing by day (pale yellow-green on white). */
export const CASED_BELOW_T = 0.5;

// ---- preference -------------------------------------------------------------

export type TrackColour = 'leg' | 'speed';
export type RankBy = 'leg' | 'overall';

export const COLOUR_KEY = 'recall.trackColour';
export const RANK_KEY = 'recall.rankBy';

export const parseTrackColour = (raw: string | null | undefined): TrackColour => (raw === 'speed' ? 'speed' : 'leg');
export const parseRankBy = (raw: string | null | undefined): RankBy => (raw === 'overall' ? 'overall' : 'leg');

/** localStorage, or null where it's unavailable or throws (private mode, blocked storage). */
export function readPref(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // a viewing preference; fine to lose
  }
}

// ---- ranking for the map ----------------------------------------------------

/** What the map is coloured by: one ranking per leg, or the overall one for every leg. */
export interface SpeedRanking {
  overall: boolean;
  /** rank for a boat on a leg's segment; undefined = unranked there. */
  at(id: string, leg: number): SpeedRank | undefined;
}

export function speedRanking(a: RaceAnalysis, leg: number | null, rankBy: RankBy): SpeedRanking {
  if (leg == null && rankBy === 'overall') {
    const o = overallRanks(a.boats);
    return { overall: true, at: (id) => o.get(id) };
  }
  if (leg != null) {
    const r = legRanks(a.boats, leg);
    return { overall: false, at: (id, l) => (l === leg ? r.get(id) : undefined) };
  }
  const per = raceLegRanks(a.boats, a.legs.length);
  return { overall: false, at: (id, l) => per[l]?.get(id) };
}

// ---- controls and key -------------------------------------------------------

function seg(label: string, short: string, attr: string, value: string, opts: [string, string][]): string {
  const btns = opts
    .map(([v, text]) => `<button type="button" ${attr}="${v}" aria-pressed="${v === value}">${text}</button>`)
    .join('');
  return `<div class="seg" role="group" aria-label="${esc(label)}"><span class="seg-lbl" aria-hidden="true">${esc(short)}</span>${btns}</div>`;
}

/** "Colour: Leg | Speed", plus "Rank by: Each leg | Overall" for the whole race in Speed. */
export function colourControls(colour: TrackColour, rankBy: RankBy, leg: number | null): string {
  const c = seg('Colour tracks by', 'Colour', 'data-colour', colour, [
    ['leg', 'Leg'],
    ['speed', 'Speed'],
  ]);
  if (colour !== 'speed' || leg != null) return c;
  return (
    c +
    seg('Rank by', 'Rank by', 'data-rank', rankBy, [
      ['leg', 'Each leg'],
      ['overall', 'Overall'],
    ])
  );
}

const gradient = (scheme: 'light' | 'dark'): string =>
  `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((t) => speedColor(t, scheme)).join(', ')})`;

/** The key under the legend in Speed mode: the gradient, what it spans, and the dashed-grey note. */
export function speedKey(a: RaceAnalysis, leg: number | null, rankBy: RankBy): string {
  const r = speedRanking(a, leg, rankBy);
  const legs = leg == null ? a.legs.map((l) => l.index) : [leg];
  const ranked: SpeedRank[] = [];
  let unranked = false;
  for (const d of a.drawings) {
    for (const s of d.segments) {
      if (!legs.includes(s.leg) || s.x.length < 2) continue;
      const k = r.at(d.id, s.leg);
      if (k) ranked.push(k);
      else unranked = true;
    }
  }
  const times = ranked.map((k) => k.timeS).filter(Number.isFinite);
  let span = '';
  if (leg != null || r.overall) {
    if (times.length) span = `${duration(Math.min(...times))} → ${duration(Math.max(...times))}`;
  } else if (ranked.length) {
    span = `#1 → #${Math.max(...ranked.map((k) => k.of))}`;
  }
  const what = leg == null && !r.overall ? 'fastest → slowest on each leg' : r.overall ? 'fastest → slowest race time' : 'fastest → slowest on this leg';
  const none = unranked ? ` · <span class="spd-none" aria-hidden="true"></span> grey dashed = ${r.overall ? "didn't finish" : "didn't complete the leg"}` : '';
  return `<span class="spd-bar" style="--g:${gradient('light')};--gd:${gradient('dark')}" aria-hidden="true"></span>
    <span>${what}</span>${span ? ` <span class="muted">${span}</span>` : ''}${none}`;
}
