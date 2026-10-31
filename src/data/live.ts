/**
 * A race in progress. Its gun within the last LIVE_SPAN_MS: the regatta document carrying it (its finishes,
 * stop reason and end time) is cached short here and at the edge (functions/_lib.ts), so a refresh each minute
 * sees what has changed.
 */

/** A race is followed live at most this long after its gun. */
export const LIVE_SPAN_MS = 6 * 3_600_000;
/** A live regatta document's freshness, ms (client); the edge's is functions/_lib.ts LIVE_TTL. */
export const LIVE_REGATTA_TTL_MS = 30_000;

export interface GunDoc {
  divisions?: readonly { races?: readonly { starts?: readonly { startTime?: number | null }[] | null }[] | null }[] | null;
}

/** Whether any race of the document had its gun within the last LIVE_SPAN_MS of `now`. */
export function hasLiveGun(doc: GunDoc | null | undefined, now: number): boolean {
  for (const d of doc?.divisions ?? []) {
    for (const r of d.races ?? []) {
      for (const s of r.starts ?? []) {
        const t = s?.startTime;
        if (typeof t === 'number' && now >= t && now - t < LIVE_SPAN_MS) return true;
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
 * In progress: its gun within the last LIVE_SPAN_MS of an event not over, and not yet complete (over in the feed,
 * every boat racing with a finish or a code, and its official results in when its division has them).
 */
export function raceLive(f: RaceLiveFacts, now: number): boolean {
  if (f.eventOver || !(now >= f.gunMs && now - f.gunMs < LIVE_SPAN_MS)) return false;
  const complete = f.feedFinished && f.unaccounted === 0 && (!f.officialWanted || f.officialIn);
  return !complete;
}

/** Boats racing (not set aside) with neither a finish time nor an official code. */
export const unaccountedBoats = (boats: readonly { colorSlot: number; finishMs: number | null; finishCode?: string }[]): number =>
  boats.filter((b) => b.colorSlot >= 0 && b.finishMs == null && !b.finishCode).length;
