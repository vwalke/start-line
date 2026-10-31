/**
 * The race on screen, while in progress (data/live.ts raceLive), refreshed about each minute: its regatta document,
 * official results and telemetry's new end, applied keeping the view (app.ts refreshLive). The poller pauses while the
 * page is hidden and refreshes at once when it shows again; failures back off quietly (the race on screen stays).
 */
import { PRE_GUN_MS } from '../data/live';
import { localTime } from './format';
import { clampView, fitView, presetActive, type Box, type View } from './view';

/** How often a live race is refreshed, ms. */
export const LIVE_EVERY_MS = 60_000;
/** The longest wait after failures, ms. */
export const LIVE_MAX_BACKOFF_MS = 5 * 60_000;
/** Shown again sooner than this after the last refresh: the next one waits its turn instead, ms. */
export const LIVE_VISIBLE_GAP_MS = 10_000;
/** The scrubber this close to a live race's end (or past it) follows the new end, ms. */
export const LIVE_END_SLACK_MS = 15_000;

/** setTimeout's longest wait, ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A race opened before its live window (its gun over PRE_GUN_MS away): the wait until that window opens, when the page
 * starts trying it each minute (app.ts waitForTracks: picking up the gun, then on live); null when the gun is that close
 * or past. A wait longer than a timer allows is waited again.
 */
export function liveArmDelay(gunMs: number, now: number): number | null {
  const wait = gunMs - PRE_GUN_MS - now;
  return wait > 0 ? Math.min(wait + 1, MAX_TIMER_MS) : null;
}

/** The wait before the next refresh after `failures` failures in a row: 1, 2, 4, then 5 minutes. */
export function liveDelay(failures: number, every = LIVE_EVERY_MS, max = LIVE_MAX_BACKOFF_MS): number {
  return Math.min(max, every * 2 ** Math.max(0, failures));
}

/** 'more': still live; 'done': complete (or no longer the race on screen), the poller stops. */
export type LiveTick = 'more' | 'done';

export interface LivePollerDeps {
  tick: () => Promise<LiveTick>;
  hidden: () => boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibility: (cb: () => void) => () => void;
  now?: () => number;
  every?: number;
  max?: number;
}

export interface LivePoller {
  stop(): void;
  stopped(): boolean;
}

/** Refresh every `every` ms (the first one `every` after the start), as above. */
export function startLivePoller(d: LivePollerDeps): LivePoller {
  const now = d.now ?? Date.now;
  const every = d.every ?? LIVE_EVERY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let busy = false;
  let failures = 0;
  let lastRun = now();

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (ms: number): void => {
    clear();
    if (done || d.hidden()) return;
    timer = setTimeout(() => void run(), Math.max(0, ms));
  };
  async function run(): Promise<void> {
    timer = undefined;
    if (done || busy) return;
    busy = true;
    try {
      const r = await d.tick();
      failures = 0;
      if (r === 'done') stop();
    } catch {
      failures++;
    } finally {
      busy = false;
      lastRun = now();
    }
    schedule(liveDelay(failures, every, d.max));
  }
  const unsubscribe = d.onVisibility(() => {
    if (done) return;
    if (d.hidden()) return clear();
    if (busy) return;
    const since = now() - lastRun;
    if (since >= LIVE_VISIBLE_GAP_MS) {
      clear();
      void run();
    } else schedule(liveDelay(failures, every, d.max) - since);
  });
  function stop(): void {
    if (done) return;
    done = true;
    clear();
    unsubscribe();
  }
  schedule(every);
  return { stop, stopped: () => done };
}

/**
 * A race opened before any boat's track is in (before its gun, mostly): what the notice says while the page waits to try
 * it again (app.ts waitForTracks).
 */
export function waitingNotice(name: string, gunMs: number, tzOffsetMs: number, now: number): string {
  const at = localTime(gunMs, tzOffsetMs).slice(0, 5);
  return now < gunMs
    ? `${name}'s gun is at ${at}. It opens here by itself once its boats are out on the course.`
    : `${name} started at ${at}. It opens here by itself once its boats' tracks come in.`;
}

/** "updated 11:32" (next to the title's Live tag), the time in the race's local time as the gun line shows it. */
export const liveLabel = (updatedMs: number, tzOffsetMs: number): string => `updated ${localTime(updatedMs, tzOffsetMs).slice(0, 5)}`;

/**
 * The scrubber after a refresh: off (the full race) stays off; at the old end (within LIVE_END_SLACK_MS) it follows
 * the new end; else it keeps its time.
 */
export function liveScrubT(t: number | null, oldEnd: number, newWin: { t0: number; t1: number }): number | null {
  if (t == null) return null;
  if (t >= oldEnd - LIVE_END_SLACK_MS) return newWin.t1;
  return Math.min(newWin.t1, Math.max(newWin.t0, t));
}

/**
 * A map view carried onto a refreshed race's fit box (grown with the new fixes): Fit stays Fit; a zoom keeps its
 * centre and the width it shows.
 */
export function liveView(from: Box | null, v: View, to: Box): View {
  if (!from || presetActive(from, v, 1)) return fitView(to);
  const s = (to.x1 - to.x0) / (from.x1 - from.x0);
  return clampView(to, { ...v, k: v.k * (Number.isFinite(s) && s > 0 ? s : 1) });
}
