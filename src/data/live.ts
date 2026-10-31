/**
 * A race in progress. Its gun within the last LIVE_SPAN_MS: the regatta document carrying it (its finishes,
 * stop reason and end time) is cached short here and at the edge (functions/_lib.ts), so a refresh each minute
 * sees what has changed.
 */

/** A race is followed live at most this long after its gun. */
export const LIVE_SPAN_MS = 6 * 3_600_000;
/** A live regatta document's freshness, ms (client) — the edge's is LIVE_TTL_S. */
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
