/**
 * Who may see what (pure: no D1, no clock of its own). Race 1 of every regatta is free; races 2+
 * need one of:
 *   regatta  a Regatta Pass for that event id (one-off; no expiry unless one is set)
 *   season   a Season Pass: starts_at ≤ now < expires_at
 *   coach    a Coach plan (data model only for now): its owner, or one of its first `seats`
 *            members, while the plan runs
 * A revoked entitlement allows nothing. Also used by the page (the lock card) on the entitlements
 * /api/auth/me returns, so both sides decide alike.
 */

export type Scope = 'regatta' | 'season' | 'coach';

export interface Entitlement {
  id: string;
  /** The buyer (for a Coach plan, its owner). */
  userId: string;
  scope: Scope;
  /** Regatta pass only. */
  eventId: string | null;
  startsAt: number;
  /** null: no end (a regatta pass). */
  expiresAt: number | null;
  /** Coach plan seats, owner excluded. */
  seats: number | null;
  revokedAt: number | null;
  /** A gift pass (scripts/grant-gift.mjs), not a purchase. */
  gift?: boolean;
  /** Coach plan: member user ids, in the order they joined. */
  members?: string[];
}

/** Running at `now`: started, not ended, not revoked. */
export const isActive = (e: Pick<Entitlement, 'startsAt' | 'expiresAt' | 'revokedAt'>, now: number): boolean =>
  e.revokedAt == null && e.startsAt <= now && (e.expiresAt == null || now < e.expiresAt);

/** Does a Coach plan cover `userId` (owner, or within the seats by join order)? */
export function coachCovers(e: Entitlement, userId: string): boolean {
  if (e.userId === userId) return true;
  const seats = Math.max(0, e.seats ?? 0);
  return (e.members ?? []).slice(0, seats).includes(userId);
}

/** Does `e` unlock `eventId` for `userId` at `now`? A null event id (a request naming none) needs an all-regattas plan. */
export function unlocks(e: Entitlement, userId: string, eventId: string | null, now: number): boolean {
  if (!isActive(e, now)) return false;
  if (e.scope === 'regatta') return eventId != null && e.eventId === eventId && e.userId === userId;
  if (e.scope === 'season') return e.userId === userId;
  return coachCovers(e, userId);
}

export interface AccessQuery {
  eventId: string | null;
  /** The request is race 1's (or otherwise free). */
  free: boolean;
  now: number;
}

/** May this user (null: signed out) see it? */
export function allowed(ents: readonly Entitlement[], userId: string | null, q: AccessQuery): boolean {
  if (q.free) return true;
  if (!userId) return false;
  return ents.some((e) => unlocks(e, userId, q.eventId, q.now));
}

/** The client's view of an entitlement (what /api/auth/me lists). */
export interface PassView {
  scope: Scope;
  eventId: string | null;
  startsAt: number;
  expiresAt: number | null;
  seats: number | null;
  /** The user owns it (false: a seat on someone's Coach plan). */
  owner: boolean;
  /** A gift pass (nothing to manage in Stripe). */
  gift?: true;
}

/** The entitlements worth listing: active now, newest first. */
export function passViews(ents: readonly Entitlement[], userId: string, now: number): PassView[] {
  return ents
    .filter((e) => isActive(e, now) && (e.scope !== 'coach' || coachCovers(e, userId)))
    .sort((a, b) => b.startsAt - a.startsAt)
    .map((e) => ({ scope: e.scope, eventId: e.eventId, startsAt: e.startsAt, expiresAt: e.expiresAt, seats: e.seats, owner: e.userId === userId, ...(e.gift ? { gift: true as const } : {}) }));
}

/** The page's check on /api/auth/me's list (the passes there are the user's own, already filtered). */
export function passesUnlock(passes: readonly PassView[], eventId: string | null, now: number): boolean {
  return passes.some((p) => p.startsAt <= now && (p.expiresAt == null || now < p.expiresAt) && (p.scope !== 'regatta' || (eventId != null && p.eventId === eventId)));
}
