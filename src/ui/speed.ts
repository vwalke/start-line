/**
 * "Colour: Rank" for the track map: a reversed plasma scale, the rank-based
 * emphasis (opacity and width), the saved viewing preferences, and the controls
 * + key beside the leg legend. Fastest = bright yellow, through orange, red and
 * magenta, to slowest = deep purple.
 *
 * Plasma, not viridis: its hue sweeps further, so the fast end no longer melts
 * into a green-teal middle; and its lightness still rises monotonically (unlike
 * turbo or jet), so it reads in greyscale and for colour-blind viewers.
 *
 * The chart sits on white by day and #171d26 by night, and no single slice of
 * plasma reads on both: its yellow end vanishes on white (1.15:1), its purple
 * end on #171d26 (1.13:1). So each scheme gets its own slice, and the SVG
 * carries both (`stroke` = day, `--cd` = night; style.css picks):
 * - day 0.00–0.85: fastest #fcba2e golden yellow-orange (≈1.7:1 on white, so
 *   strokes under 3:1, the bright quarter, get a thin dark casing), slowest
 *   #0d0887 (≈15:1);
 * - night 0.36–1.00: fastest #f0f921 (≈14.7:1), slowest ≈#a41f98 magenta-purple
 *   (≈2.6:1 at full opacity; the slow end is also the faint end, so no deeper).
 *
 * On top of the colour, rank sets each stroke's opacity and width
 * (`speedEmphasis`): the top 3 bold, the rest of the top quartile strong, then
 * a steep fall-off so the slower half is a faint backdrop. "Highlight: Top 3 /
 * Top 10" greys out everyone else and stretches the colours over just those.
 */
import { legRanks, overallRanks, raceLegRanks, type SpeedRank } from '../analysis/speedRank';
import type { RaceAnalysis } from '../analysis/types';
import { boatLabel, duration, esc } from './format';

/** Plasma at 0, 0.1, … 1 (matplotlib). */
const PLASMA = [
  [0x0d, 0x08, 0x87],
  [0x41, 0x04, 0x9d],
  [0x6a, 0x00, 0xa8],
  [0x8f, 0x0d, 0xa4],
  [0xb1, 0x2a, 0x90],
  [0xcc, 0x47, 0x78],
  [0xe1, 0x64, 0x62],
  [0xf2, 0x84, 0x4b],
  [0xfc, 0xa6, 0x36],
  [0xfc, 0xce, 0x25],
  [0xf0, 0xf9, 0x21],
] as const;

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');

/** Plasma at `v` in [0, 1] (clamped; NaN → 0), linear in RGB between stops, as #rrggbb. */
export function plasma(v: number): string {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) * (PLASMA.length - 1) : 0;
  const i = Math.min(PLASMA.length - 2, Math.floor(x));
  const f = x - i;
  const [p, q] = [PLASMA[i], PLASMA[i + 1]];
  return `#${hex2(p[0] + (q[0] - p[0]) * f)}${hex2(p[1] + (q[1] - p[1]) * f)}${hex2(p[2] + (q[2] - p[2]) * f)}`;
}

/** WCAG relative luminance of #rrggbb. */
export function luminance(hex: string): number {
  const lin = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

/** WCAG contrast ratio of two #rrggbb colours (1–21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** The chart background in each scheme (style.css `--surface`). */
export const SPEED_BG = { light: '#ffffff', dark: '#171d26' } as const;

/** The slice of plasma each colour scheme uses: [slowest, fastest]. */
export const SPEED_RANGE = { light: [0, 0.85], dark: [0.36, 1] } as const;

/** Colour for rank position `t` (0 = fastest … 1 = slowest, clamped) in a scheme. */
export function speedColor(t: number, scheme: 'light' | 'dark' = 'light'): string {
  const [lo, hi] = SPEED_RANGE[scheme];
  const c = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1;
  return plasma(hi - c * (hi - lo));
}

/** By day, a stroke this pale against white (under 3:1) gets a thin dark casing. */
export const casedByDay = (t: number): boolean => contrast(speedColor(t), SPEED_BG.light) < 3;

// ---- emphasis ---------------------------------------------------------------

export type Tier = 'top' | 'strong' | 'rest';

export interface Emphasis {
  tier: Tier;
  /** stroke-opacity, 0–1. */
  opacity: number;
  /** Stroke width in map units (the map scales them). */
  width: number;
}

const TOP: Emphasis = { tier: 'top', opacity: 1, width: 3 };
const STRONG: Emphasis = { tier: 'strong', opacity: 0.88, width: 2 };

/**
 * How loud rank `rank` of `n` is drawn: the top 3 at full opacity and thickest;
 * the rest of the top quartile strong; then, from the quartile to the middle of
 * the fleet, a quadratic fall (fast at first) to `half`, and across the slower
 * half a linear fade from `half` to `floor`. For big fleets that's 0.30 → 0.15;
 * small fleets get a higher floor so everyone stays visible.
 * Non-increasing in rank for a given n.
 */
export function speedEmphasis(rank: number, n: number): Emphasis {
  const N = Math.max(1, Math.floor(n));
  const k = Math.min(N, Math.max(1, Math.floor(Number.isFinite(rank) ? rank : N)));
  if (k <= 3) return TOP;
  const q = Math.max(3, Math.ceil(N / 4));
  if (k <= q) return STRONG;
  const floor = 0.15 + 0.25 * Math.min(1, Math.max(0, (16 - N) / 12));
  const half = floor + 0.15;
  /** First rank of the slower half (or just past the quartile in a small fleet). */
  const h = Math.max(q, Math.floor(N / 2)) + 1;
  if (k < h) {
    const s = (1 - (k - q) / (h - q)) ** 2;
    return { tier: 'rest', opacity: half + (0.85 - half) * s, width: 1 + 0.85 * s };
  }
  const f = N > h ? (k - h) / (N - h) : 0;
  return { tier: 'rest', opacity: half - (half - floor) * f, width: 1 - 0.1 * f };
}

// ---- Highlight: Top N -------------------------------------------------------

export type SpeedTop = 3 | 10 | 'all';

/** The effective N for a ranking of `of` boats, or null when Top N covers everyone (= All). */
export const topLimit = (top: SpeedTop, of: number): number | null => (top !== 'all' && top < of ? top : null);

/** Who the map is drawing, as far as emphasis goes: no selection, this boat, or another. */
export type Selection = 'none' | 'this' | 'other';

export interface SpeedStyle {
  /** 'picked-out': the selected boat, ranked but outside the top N (drawn neutral, never a rank colour). */
  kind: 'ranked' | 'out' | 'unranked' | 'picked-out';
  /** Position on the colour scale (0 fastest … 1); null = grey. */
  t: number | null;
  tier: Tier | null;
  opacity: number;
  width: number;
  selected: boolean;
}

/** Everyone else, while a boat is selected, is dimmed by this. */
export const SELECTION_DIM = 0.6;

/**
 * Colour position, opacity and width for one boat's stroke. Under Top N, ranks
 * past N are faint grey and the scale spans ranks 1..N (so the N use the full
 * yellow → purple range). A selected boat is always full-opacity and thick: in
 * its own colour within N, past N 'picked-out' with no colour (so only the N
 * ever carry rank colours); everyone else is dimmed.
 */
export function speedStyle(r: SpeedRank | undefined, top: SpeedTop, sel: Selection): SpeedStyle {
  const dim = sel === 'other' ? SELECTION_DIM : 1;
  const selected = sel === 'this';
  if (!r) return { kind: 'unranked', t: null, tier: null, opacity: selected ? 1 : 0.25 * dim, width: selected ? 2.4 : 0.9, selected };
  const n = topLimit(top, r.of);
  const out = n != null && r.rank > n;
  const t = n == null ? r.t : Math.min(1, (r.rank - 1) / (n - 1));
  if (selected && out) return { kind: 'picked-out', t: null, tier: null, opacity: 1, width: 3.2, selected };
  if (selected) return { kind: 'ranked', t, tier: speedEmphasis(r.rank, r.of).tier, opacity: 1, width: 3.2, selected };
  if (out) return { kind: 'out', t: null, tier: null, opacity: 0.2 * dim, width: 0.8, selected };
  const e = speedEmphasis(r.rank, r.of);
  // Under Top N, everyone in it keeps at least the strong tier.
  const shown = n != null && e.tier === 'rest' ? STRONG : e;
  return { kind: 'ranked', t, tier: shown.tier, opacity: shown.opacity * dim, width: shown.width, selected };
}

// ---- preference -------------------------------------------------------------

/** 'leg': one colour per leg. 'rank': this module (elapsed-time rank). 'sog': boat speed (ui/sog.ts). 'vmg': VMG (ui/vmg.ts). */
export type TrackColour = 'leg' | 'rank' | 'sog' | 'vmg';

/** Colorings read from the Coach's model (its wind and ladder), which may arrive after the map's first paint. */
export const needsCoach = (c: TrackColour): boolean => c === 'vmg';
export type RankBy = 'leg' | 'overall';

/** Whole race in Boat speed: colour each leg on its own range (ui/sog.ts), or every leg on the race's. */
export type SogScale = 'leg' | 'race';

export const COLOUR_KEY = 'recall.trackColour';
export const RANK_KEY = 'recall.rankBy';
export const TOP_KEY = 'recall.speedTop';
export const SOG_SCALE_KEY = 'recall.sogScale';

/** The stored value; 'speed' is what rank colouring was saved as before Boat speed existed. */
export const parseTrackColour = (raw: string | null | undefined): TrackColour =>
  raw === 'rank' || raw === 'speed' ? 'rank' : raw === 'sog' || raw === 'vmg' ? raw : 'leg';
export const parseRankBy = (raw: string | null | undefined): RankBy => (raw === 'overall' ? 'overall' : 'leg');
export const parseSpeedTop = (raw: string | null | undefined): SpeedTop => (raw === '3' ? 3 : raw === '10' ? 10 : 'all');
export const parseSogScale = (raw: string | null | undefined): SogScale => (raw === 'race' ? 'race' : 'leg');

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

export function removePref(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // blocked storage: nothing was kept anyway
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

/**
 * "Colour: Leg | Rank | Boat speed | VMG"; in Rank, "Rank by: Each leg | Overall"
 * for the whole race and "Highlight: Top 3 | Top 10 | All"; in Boat speed or VMG
 * for the whole race, "Scale: Per leg | Whole race".
 */
export function colourControls(
  colour: TrackColour,
  rankBy: RankBy,
  leg: number | null,
  top: SpeedTop = 'all',
  sogScale: SogScale = 'leg',
): string {
  const c = seg('Color tracks by', 'Color', 'data-colour', colour, [
    ['leg', 'Leg'],
    ['rank', 'Rank'],
    ['sog', 'Boat speed'],
    ['vmg', 'VMG'],
  ]);
  if (colour === 'sog' || colour === 'vmg') {
    return leg == null
      ? c +
          seg(colour === 'sog' ? 'Scale boat speed colors' : 'Scale VMG colors', 'Scale', 'data-sog-scale', sogScale, [
            ['leg', 'Per leg'],
            ['race', 'Whole race'],
          ])
      : c;
  }
  if (colour !== 'rank') return c;
  const rank =
    leg == null
      ? seg('Rank by', 'Rank by', 'data-rank', rankBy, [
          ['leg', 'Each leg'],
          ['overall', 'Overall'],
        ])
      : '';
  return (
    c +
    rank +
    seg('Highlight the fastest', 'Highlight', 'data-top', String(top), [
      ['3', 'Top 3'],
      ['10', 'Top 10'],
      ['all', 'All'],
    ])
  );
}

const gradient = (scheme: 'light' | 'dark'): string =>
  `linear-gradient(to right, ${[0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((t) => speedColor(t, scheme)).join(', ')})`;

/**
 * Under Top N, the tie straddling the cut in one ranking (competition ranks,
 * 1, 2, 2, 4): more than `n` boats at rank ≤ n because the last rank in is
 * shared. Ties stay in (it's fair); the key says so. Null when exactly ≤ n are in.
 */
export function tieAtCut(ranks: number[], n: number): { rank: number; count: number } | null {
  const inN = ranks.filter((r) => r <= n);
  if (inN.length <= n) return null;
  const rank = Math.max(...inN);
  return { rank, count: inN.filter((r) => r === rank).length };
}

/**
 * The key under the legend in Rank mode: the gradient, what it spans, the grey
 * notes, any tie at the Top N cut, and the picked boat `highlight` when it's
 * drawn outside the top N (with its rank, per leg when ranking each leg).
 */
export function speedKey(a: RaceAnalysis, leg: number | null, rankBy: RankBy, top: SpeedTop = 'all', highlight: string | null = null): string {
  const r = speedRanking(a, leg, rankBy);
  const legs = leg == null ? a.legs.map((l) => l.index) : [leg];
  const eachLeg = leg == null && !r.overall;
  const legName = (i: number): string => a.legs[i]?.name ?? `Leg ${i + 1}`;
  const shown: SpeedRank[] = [];
  /** Under Top N, each ranking's (each leg's, or the one overall) ranks within N, one per boat. */
  const cut = new Map<number, { n: number; ranks: Map<string, number> }>();
  /** The picked boat's ranks where it's outside the top N, one per leg (one in all for Overall). */
  const picked = new Map<number, number>();
  let unranked = false;
  let out = false;
  for (const d of a.drawings) {
    for (const s of d.segments) {
      if (!legs.includes(s.leg) || s.x.length < 2) continue;
      const k = r.at(d.id, s.leg);
      const g = r.overall ? -1 : s.leg;
      if (k && d.id === highlight && speedStyle(k, top, 'this').kind === 'picked-out') picked.set(g, k.rank);
      if (!k) unranked = true;
      else if (speedStyle(k, top, 'none').kind === 'out') out = true;
      else {
        shown.push(k);
        const n = topLimit(top, k.of);
        if (n == null) continue;
        if (!cut.has(g)) cut.set(g, { n, ranks: new Map() });
        cut.get(g)!.ranks.set(d.id, k.rank);
      }
    }
  }
  const times = shown.map((k) => k.timeS).filter(Number.isFinite);
  const slowest = shown.length ? Math.max(...shown.map((k) => k.rank)) : 0;
  let span = '';
  if (leg != null || r.overall) {
    if (times.length) span = `${duration(Math.min(...times))} → ${duration(Math.max(...times))}`;
  } else if (shown.length) {
    span = `#1 → #${slowest}`;
  }
  const end = out ? `#${top}` : 'slowest';
  const what = leg == null && !r.overall ? `fastest → ${end} on each leg` : r.overall ? `fastest → ${end} race time` : `fastest → ${end} on this leg`;
  const others = out ? ` · <span class="spd-out" aria-hidden="true"></span> others gray` : '';
  const none = unranked ? ` · <span class="spd-none" aria-hidden="true"></span> ${r.overall ? "didn't finish" : 'no leg time'}` : '';
  const ties = [...cut]
    .sort(([x], [y]) => x - y)
    .flatMap(([l, c]) => {
      const tie = tieAtCut([...c.ranks.values()], c.n);
      return tie ? [` · <span class="spd-tie">${tie.count} tied at #${tie.rank}${eachLeg ? ` on ${esc(legName(l))}` : ''}</span>`] : [];
    })
    .join('');
  let pick = '';
  if (highlight != null && picked.size) {
    const who = esc(boatLabel(a.boats.find((b) => b.id === highlight), highlight));
    const ranks = [...picked].sort(([x], [y]) => x - y);
    const where = eachLeg
      ? `, ${ranks.map(([l, k]) => `#${k} ${esc(legName(l))}`).join(' · ')}`
      : ` #${ranks[0][1]} ${r.overall ? 'race time' : 'on this leg'}`;
    pick = ` · <span class="spd-picked"><span class="spd-pick" aria-hidden="true"></span> picked: ${who}${where}</span>`;
  }
  return `<span class="spd-bar" style="--g:${gradient('light')};--gd:${gradient('dark')}" aria-hidden="true"></span>
    <span>${what}</span>${span ? ` <span class="muted">${span}</span>` : ''}${ties}${others}${pick}${none}`;
}
