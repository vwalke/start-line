/**
 * The track map's race-time scrubber, as pure pieces: its window (MAP_PRE_MS
 * before the gun to the end of the drawn tracks), the time labels, the trail
 * lengths, playback steps, and the `t=` / `trail=` URL parameters.
 *
 * `t=` is gun-relative whole seconds (negative before the gun: `t=-45`); no
 * `t=` is the full-race view (Map A). Coach can link to a moment on the map
 * with `mapTimeSearch`.
 */
import { MAP_PRE_MS, type RaceAnalysis } from '../analysis/types';
import { duration, localTime } from './format';
import { BOAT_TRAIL_MS } from './trail';

export const T_PARAM = 't';
export const TRAIL_PARAM = 'trail';

/** The scrubber's race-time window, ms. */
export interface ScrubWindow {
  t0: number;
  t1: number;
}

/** MAP_PRE_MS before the gun to the last drawn fix of any racing boat (the last finisher, or the end of the tracks). */
export function scrubWindow(a: Pick<RaceAnalysis, 'drawings' | 'meta'>): ScrubWindow {
  const gun = a.meta.gunMs;
  let end = gun;
  for (const d of a.drawings) {
    const s = d.segments.at(-1);
    if (s?.t.length) end = Math.max(end, s.t[s.t.length - 1]);
  }
  return { t0: gun - MAP_PRE_MS, t1: end };
}

export const clampTime = (t: number, w: ScrubWindow): number => Math.min(w.t1, Math.max(w.t0, t));

// ---- labels --------------------------------------------------------------------

/** "gun +1:30", "gun −0:45", "gun +0:00" (whole seconds). */
export function gunRel(t: number, gunMs: number): string {
  const s = Math.round((t - gunMs) / 1000);
  return `gun ${s < 0 ? '−' : '+'}${duration(Math.abs(s))}`;
}

/** "10:06:31 · gun +1:30" (local time at the race's offset). */
export const scrubLabel = (t: number, a: Pick<RaceAnalysis, 'meta'>): string => `${localTime(t, a.meta.tzOffsetMs)} · ${gunRel(t, a.meta.gunMs)}`;

// ---- trail ---------------------------------------------------------------------

/**
 * '30' / '120': the last 30 s / BOAT_TRAIL_MS (2 min, the default), each boat's own fading trail (ui/trail.ts);
 * 'all': the map's tracks from the window's start; 'win' (Map D, a Coach card's window open on the map): the tracks
 * from the card window's start (`trailWindow`'s `from`), so the whole window shows and nothing before it.
 */
export type Trail = '30' | '120' | 'all' | 'win';
/** The trail of a Coach card's window (only with one open; its button shows only then). */
export const WINDOW_TRAIL: Trail = 'win';
/** The trails always offered. */
export const TRAILS: readonly [Trail, string][] = [
  ['30', '30 s'],
  ['120', '2 min'],
  ['all', 'All'],
];
export const DEFAULT_TRAIL: Trail = '120';
export const parseTrail = (raw: string | null | undefined): Trail => (raw === '30' || raw === 'all' || raw === 'win' ? raw : raw === '120' ? '120' : DEFAULT_TRAIL);

/** A short trail's length, ms, drawn as each boat's fading trail; null: All or a card's window (the map's tracks). */
export const fadingTrailMs = (trail: Trail): number | null => (trail === '30' ? 30_000 : trail === '120' ? BOAT_TRAIL_MS : null);

/**
 * The time window a trail draws at `t`: [t − trail, t], or from the window's start for All. 'win' draws from `from`
 * (a card window's start): [from, t]; before `from`, as the default trail; with no `from`, as All.
 */
export function trailWindow(t: number, trail: Trail, w: ScrubWindow, from?: number | null): [number, number] {
  if (trail === 'win') return from == null ? trailWindow(t, 'all', w) : t < from ? trailWindow(t, DEFAULT_TRAIL, w) : [Math.max(w.t0, from), t];
  return [trail === 'all' ? w.t0 : Math.max(w.t0, t - fadingTrailMs(trail)!), t];
}

// ---- playback --------------------------------------------------------------------

export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];
export const parseSpeed = (raw: string | null | undefined): Speed => (raw === '4' ? 4 : raw === '16' ? 16 : 1);

/** One playback step: `elapsedMs` of real time at `speed`×, stopping at the window's end. */
export function playStep(t: number, elapsedMs: number, speed: number, w: ScrubWindow): { t: number; done: boolean } {
  const next = t + Math.max(0, elapsedMs) * speed;
  return next >= w.t1 ? { t: w.t1, done: true } : { t: Math.max(w.t0, next), done: false };
}

/** Where Play starts from: the time shown, or the window's start when off (null) or at the end. */
export const playFrom = (t: number | null, w: ScrubWindow): number => (t == null || t >= w.t1 ? w.t0 : clampTime(t, w));

// ---- URL ---------------------------------------------------------------------------

/** `t=` → gun-relative whole seconds (a leading "-" or "−" before the gun); null when missing or malformed. */
export function parseTParam(raw: string | null | undefined): number | null {
  const m = /^\s*([-−+]?)(\d{1,6})\s*$/.exec(raw ?? '');
  if (!m) return null;
  const s = Number(m[2]);
  return m[1] === '-' || m[1] === '−' ? -s : s;
}

/** Gun-relative seconds → the `t=` value: whole seconds, ASCII minus. */
export const formatTParam = (s: number): string => String(Math.round(s) || 0);

/** `t=` seconds → a race time, clamped to the window. */
export const timeOfParam = (s: number, gunMs: number, w: ScrubWindow): number => clampTime(gunMs + s * 1000, w);

/** A race time → its `t=` seconds. */
export const paramOfTime = (t: number, gunMs: number): number => Math.round((t - gunMs) / 1000);

/** The URL parameters for a scrubber state: `t=` (null: full race, removed) and `trail=` (only when not the default, and only with `t=`). */
export function scrubParams(t: number | null, gunMs: number, trail: Trail): Record<string, string | null> {
  if (t == null) return { [T_PARAM]: null, [TRAIL_PARAM]: null };
  return { [T_PARAM]: formatTParam(paramOfTime(t, gunMs)), [TRAIL_PARAM]: trail === DEFAULT_TRAIL ? null : trail };
}

/** `search` with the map set to gun-relative second `s` (null: full race) and `trail` (for deep links, e.g. Coach "show on map"). */
export function mapTimeSearch(search: string, s: number | null, trail: Trail = DEFAULT_TRAIL): string {
  const p = new URLSearchParams(search);
  for (const [k, v] of Object.entries(scrubParams(s == null ? null : s * 1000, 0, trail))) {
    if (v == null) p.delete(k);
    else p.set(k, v);
  }
  const q = p.toString();
  return q ? `?${q}` : '';
}
