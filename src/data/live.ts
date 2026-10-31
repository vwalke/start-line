/**
 * A race in progress. Its gun within the live window (gunLive: from PRE_GUN_MS before it to LIVE_SPAN_MS after it): the
 * regatta document carrying it (its gun, finishes, stop reason and end time) is cached short here and at the edge
 * (functions/_lib.ts), so a refresh each minute sees what has changed.
 */

/** A race is followed live at most this long after its gun. */
export const LIVE_SPAN_MS = 6 * 3_600_000;
/** …and from this long before it (its start sequence, a postponement): opened then, it picks up the gun and goes on live. */
export const PRE_GUN_MS = 3 * 3_600_000;

/** The one live window, used by the page, the worker and both caches: from PRE_GUN_MS before the gun to LIVE_SPAN_MS after it. */
export const gunLive = (gunMs: number, now: number): boolean => gunMs - now <= PRE_GUN_MS && now - gunMs < LIVE_SPAN_MS;
/** A live regatta document's freshness, ms (client); the edge's is functions/_lib.ts LIVE_TTL. */
export const LIVE_REGATTA_TTL_MS = 30_000;

export interface GunDoc {
  divisions?: readonly { races?: readonly { starts?: readonly { startTime?: number | null }[] | null }[] | null }[] | null;
}

/** Whether any race of the document has its gun in the live window (gunLive) at `now`. */
export function hasLiveGun(doc: GunDoc | null | undefined, now: number): boolean {
  for (const d of doc?.divisions ?? []) {
    for (const r of d.races ?? []) {
      for (const s of r.starts ?? []) {
        const t = s?.startTime;
        if (typeof t === 'number' && gunLive(t, now)) return true;
      }
    }
  }
  return false;
}

/** What decides whether the race on screen is still to be refreshed (ui/live.ts). */
export interface RaceLiveFacts {
  gunMs: number;
  /** The feed has the race over (listRaces `finished`: finishes, and stopped or ended). */
  feedFinished: boolean;
  /** The event ended over a day ago (recovery.ts eventFinished). */
  eventOver: boolean;
  /** Boats racing with neither a finish time nor an official code yet. */
  unaccounted: number;
  /** The division is linked to official results: the race's are waited for. */
  officialWanted: boolean;
  /** The race's official results are in. */
  officialIn: boolean;
}

/**
 * In progress: its gun in the live window (gunLive: before it, the start sequence) of an event not over, and not yet
 * complete (over in the feed, every boat racing with a finish or a code, and its official results in when its division
 * has them).
 */
export function raceLive(f: RaceLiveFacts, now: number): boolean {
  if (f.eventOver || !gunLive(f.gunMs, now)) return false;
  const complete = f.feedFinished && f.unaccounted === 0 && (!f.officialWanted || f.officialIn);
  return !complete;
}

/** What decides a race title's "Live" tag (liveTag). */
export interface LiveTagFacts {
  gunMs: number;
  /** The event ended over a day ago (recovery.ts eventFinished). */
  eventOver: boolean;
  /** The race's official results are in. */
  officialIn: boolean;
  /** The division is linked to official results (they're expected for this race). */
  officialWanted: boolean;
}

/**
 * A race title's "Live" tag: until the race's official results are in, while it's current. Its division linked to
 * official results: from PRE_GUN_MS before its gun the whole time the event is on (results still to come). Not linked
 * (no Yachtscoring, or linking still under way): only in its live window (gunLive). Never once the event is over,
 * results or not.
 */
export function liveTag(f: LiveTagFacts, now: number): boolean {
  if (f.officialIn || f.eventOver || f.gunMs - now > PRE_GUN_MS) return false;
  return f.officialWanted || gunLive(f.gunMs, now);
}

/** Boats racing (not set aside) with neither a finish time nor an official code. */
export const unaccountedBoats = (boats: readonly { colorSlot: number; finishMs: number | null; finishCode?: string }[]): number =>
  boats.filter((b) => b.colorSlot >= 0 && b.finishMs == null && !b.finishCode).length;
