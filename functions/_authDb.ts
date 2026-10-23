/**
 * The paywall's D1 queries (database bound as AUTH_DB; schema in migrations/0001_paywall.sql and
 * 0002_signin_phase1.sql).
 *
 * The SQL keeps to a small subset on purpose (single-table SELECT / INSERT [OR IGNORE] / UPDATE /
 * DELETE; WHERE of ANDed comparisons, IS [NOT] NULL and IN; ORDER BY one column; LIMIT; and the
 * one rate-limit upsert), so the tests run these same statements on an in-memory engine that
 * enforces the migrations' keys (tests/d1mem.ts). Idempotency comes from the schema's UNIQUE keys
 * plus INSERT OR IGNORE. Sorting by more than one column (a session's last use) is done here.
 */
import type { Entitlement, Scope } from './_entitlements';
import { deviceLabel } from './_deviceLabel';

// ---- the D1 surface we use (structurally what Workers' D1Database provides)

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
}

// ---- limits

export const SESSION_TTL_MS = 30 * 86_400_000;
/** Signed-in devices per user unless the admin set users.max_sessions; a new sign-in revokes the least recently used beyond it. */
export const DEFAULT_MAX_SESSIONS = 3;
export const MAX_SESSIONS_LIMIT = 20;
/** last_seen_at is written at most this often per session, so a normal request adds no write. */
export const LAST_SEEN_EVERY_MS = 3_600_000;
/** Revoked rows are kept this long (the bumped device's note, the admin's list), then deleted. */
export const REVOKED_KEEP_MS = 30 * 86_400_000;
/** How long a new sign-in can still say which devices it signed out. */
export const BUMPED_SHOWN_MS = 10 * 60_000;
export const LOGIN_TOKEN_TTL_MS = 15 * 60_000;

export const newId = (): string => crypto.randomUUID();

// ---- users

export interface UserRow {
  id: string;
  email: string;
  google_sub: string | null;
  stripe_customer_id: string | null;
  created_at: number;
  /** The admin's device cap for this user (scripts/sessions.mjs); null: DEFAULT_MAX_SESSIONS. */
  max_sessions: number | null;
}

const USER_COLS = 'id, email, google_sub, stripe_customer_id, created_at, max_sessions';

/** The user's device cap: users.max_sessions when it is a whole number (clamped to 1..20), else 3. */
export const sessionCap = (raw: unknown): number =>
  typeof raw === 'number' && Number.isInteger(raw) ? Math.min(MAX_SESSIONS_LIMIT, Math.max(1, raw)) : DEFAULT_MAX_SESSIONS;

export const normEmail = (email: string): string => email.trim().toLowerCase();

/** A plausible address (the mail provider has the last word), ≤ 254 characters. */
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const validEmail = (email: string): boolean => email.length <= 254 && EMAIL_RE.test(email);

export const userById = (db: D1Like, id: string): Promise<UserRow | null> => db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first<UserRow>();
export const userByEmail = (db: D1Like, email: string): Promise<UserRow | null> =>
  db.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`).bind(normEmail(email)).first<UserRow>();
export const userByGoogleSub = (db: D1Like, sub: string): Promise<UserRow | null> =>
  db.prepare(`SELECT ${USER_COLS} FROM users WHERE google_sub = ?`).bind(sub).first<UserRow>();
export const userByStripeCustomer = (db: D1Like, customer: string): Promise<UserRow | null> =>
  db.prepare(`SELECT ${USER_COLS} FROM users WHERE stripe_customer_id = ? LIMIT 1`).bind(customer).first<UserRow>();

/** The user with this email, created if new (a concurrent create of the same email is absorbed by the UNIQUE key). */
export async function ensureUser(db: D1Like, email: string, now: number): Promise<UserRow> {
  const e = normEmail(email);
  const found = await userByEmail(db, e);
  if (found) return found;
  await db.prepare('INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(newId(), e, now).run();
  const made = await userByEmail(db, e);
  if (!made) throw new Error('user insert failed');
  return made;
}

export const setGoogleSub = (db: D1Like, userId: string, sub: string): Promise<unknown> =>
  db.prepare('UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL').bind(sub, userId).run();

/** Remember the user's Stripe customer (the first one seen is kept). */
export const setStripeCustomer = (db: D1Like, userId: string, customer: string): Promise<unknown> =>
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL').bind(customer, userId).run();

// ---- sessions

export type SignInMethod = 'email' | 'google';
export type RevokedReason = 'device_limit' | 'remote' | 'admin';
export const REVOKED_REASONS: readonly RevokedReason[] = ['device_limit', 'remote', 'admin'];

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  user_agent: string | null;
  public_id: string | null;
  last_seen_at: number | null;
  method: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  revoked_by: string | null;
}

const SESSION_COLS = 'token_hash, user_id, created_at, expires_at, user_agent, public_id, last_seen_at, method, revoked_at, revoked_reason, revoked_by';

/** A device signed out by a newer sign-in: its name and when it was last used. */
export interface BumpedDevice {
  label: string;
  lastSeenAt: number;
}

/** When a session was last used (a row from before migration 0002 may lack last_seen_at). */
export const lastUsed = (r: Pick<SessionRow, 'last_seen_at' | 'created_at'>): number => r.last_seen_at ?? r.created_at;

/** 12 random bytes, hex: what names a session in the device list (never its token or hash). */
export const newPublicId = (): string => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const PUBLIC_ID_RE = /^[0-9a-f]{24}$/;

/** The user's live sessions (unexpired, not revoked), most recently used first. */
export async function liveSessions(db: D1Like, userId: string, now: number): Promise<SessionRow[]> {
  const { results } = await db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`).bind(userId, now).all<SessionRow>();
  return results.sort((a, b) => lastUsed(b) - lastUsed(a));
}

/**
 * Store a new session, then keep the user's `cap` most recently used live sessions (the new one
 * always among them) and revoke the rest (reason device_limit, revoked_by the new session's public
 * id) rather than deleting them, so the bumped device can be told why. Expired rows and rows revoked
 * over 30 days ago are deleted. Answers the new public id and the devices it bumped.
 */
export async function createSession(
  db: D1Like,
  s: { tokenHash: string; userId: string; now: number; userAgent?: string | null; method?: SignInMethod | null },
): Promise<{ publicId: string; bumped: BumpedDevice[] }> {
  const publicId = newPublicId();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, public_id, last_seen_at, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(s.tokenHash, s.userId, s.now, s.now + SESSION_TTL_MS, (s.userAgent ?? '').slice(0, 200) || null, publicId, s.now, s.method ?? null)
    .run();
  const cap = sessionCap((await userById(db, s.userId))?.max_sessions);
  const others = (await liveSessions(db, s.userId, s.now)).filter((r) => r.token_hash !== s.tokenHash);
  const bumped: BumpedDevice[] = [];
  for (const r of others.slice(cap - 1)) {
    const done = await db
      .prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ?, revoked_by = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .bind(s.now, 'device_limit', publicId, r.token_hash)
      .run();
    if ((done.meta?.changes ?? 0) > 0) bumped.push({ label: deviceLabel(r.user_agent), lastSeenAt: lastUsed(r) });
  }
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(s.userId, s.now).run();
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND revoked_at < ?').bind(s.userId, s.now - REVOKED_KEEP_MS).run();
  return { publicId, bumped };
}

/** A session's row by its token hash, as stored (expired or revoked included), or null. */
export const sessionRow = (db: D1Like, tokenHash: string): Promise<SessionRow | null> =>
  db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE token_hash = ?`).bind(tokenHash).first<SessionRow>();

export const isLive = (s: SessionRow, now: number): boolean => s.expires_at > now && s.revoked_at == null;

/** Why a revoked session ended (an unknown or missing reason reads as the admin's); null when it wasn't revoked. */
export const revokedReason = (s: SessionRow): RevokedReason | null =>
  s.revoked_at == null ? null : REVOKED_REASONS.includes(s.revoked_reason as RevokedReason) ? (s.revoked_reason as RevokedReason) : 'admin';

/** Note the session's use, at most once an hour (best effort: a failed write never fails the request). */
export async function touchSession(db: D1Like, s: SessionRow, now: number): Promise<void> {
  if (lastUsed(s) > now - LAST_SEEN_EVERY_MS) return;
  await db
    .prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
    .bind(now, s.token_hash)
    .run()
    .catch(() => undefined);
  s.last_seen_at = now;
}

/** The live session for a token hash (unknown, expired or revoked: null): one primary-key lookup, plus the hourly last_seen_at write. */
export async function liveSession(db: D1Like, tokenHash: string, now: number): Promise<SessionRow | null> {
  const s = await sessionRow(db, tokenHash);
  if (!s || !isLive(s, now)) return null;
  await touchSession(db, s, now);
  return s;
}

/** The user id of a live session, or null (unknown, expired or revoked). */
export async function sessionUserId(db: D1Like, tokenHash: string, now: number): Promise<string | null> {
  return (await liveSession(db, tokenHash, now))?.user_id ?? null;
}

/** The signed-in user of a session, or null (unknown, expired or revoked). */
export async function sessionUser(db: D1Like, tokenHash: string, now: number): Promise<UserRow | null> {
  const id = await sessionUserId(db, tokenHash, now);
  return id ? userById(db, id) : null;
}

export const deleteSession = (db: D1Like, tokenHash: string): Promise<unknown> => db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();

/** Sign out one of the user's devices by its public id: true when a live session of theirs was revoked. */
export async function revokeSessionById(db: D1Like, o: { userId: string; publicId: string; now: number; reason: RevokedReason }): Promise<boolean> {
  const r = await db
    .prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE public_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?')
    .bind(o.now, o.reason, o.publicId, o.userId, o.now)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Sign out every live session of the user but this one; how many. */
export async function revokeOtherSessions(db: D1Like, o: { userId: string; keepTokenHash: string; now: number; reason: RevokedReason }): Promise<number> {
  const r = await db
    .prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND token_hash != ? AND revoked_at IS NULL AND expires_at > ?')
    .bind(o.now, o.reason, o.userId, o.keepTokenHash, o.now)
    .run();
  return r.meta?.changes ?? 0;
}

/** The devices this session's sign-in signed out in the last 10 minutes (its "Signing in here signed out …" note). */
export async function bumpedBy(db: D1Like, publicId: string, now: number): Promise<BumpedDevice[]> {
  const { results } = await db
    .prepare('SELECT user_agent, created_at, last_seen_at FROM sessions WHERE revoked_by = ? AND revoked_at > ?')
    .bind(publicId, now - BUMPED_SHOWN_MS)
    .all<Pick<SessionRow, 'user_agent' | 'created_at' | 'last_seen_at'>>();
  return results.map((r) => ({ label: deviceLabel(r.user_agent), lastSeenAt: lastUsed(r) })).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

// ---- sign-in rate limits (shared by every isolate)

export const RATE_WINDOW_MS = 3_600_000;

/** The fixed one-hour window `now` falls in. */
export const rateWindow = (now: number): number => Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;

/**
 * Count one sign-in email against `key` (email:<sha256 hex> or ip:<sha256 hex>) in the current
 * window, atomically (one upsert): the count in this window so far, this one included.
 */
export async function countRateHit(db: D1Like, key: string, now: number): Promise<number> {
  const row = await db
    .prepare(
      'INSERT INTO auth_rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start RETURNING count',
    )
    .bind(key, rateWindow(now))
    .first<{ count: number }>();
  return row?.count ?? 1;
}

/** Drop counters whose window began over 2 hours ago (best effort, now and then). */
export const pruneRateLimits = (db: D1Like, now: number): Promise<unknown> =>
  db.prepare('DELETE FROM auth_rate_limits WHERE window_start < ?').bind(rateWindow(now) - 2 * RATE_WINDOW_MS).run();

// ---- magic-link tokens

export const createLoginToken = (db: D1Like, t: { tokenHash: string; email: string; now: number; returnTo: string }): Promise<unknown> =>
  db
    .prepare('INSERT INTO login_tokens (token_hash, email, expires_at, return_to) VALUES (?, ?, ?, ?)')
    .bind(t.tokenHash, normEmail(t.email), t.now + LOGIN_TOKEN_TTL_MS, t.returnTo)
    .run();

/** Use a token once: its email and returnTo, or null when unknown, used or expired. */
export async function consumeLoginToken(db: D1Like, tokenHash: string, now: number): Promise<{ email: string; returnTo: string | null } | null> {
  const r = await db.prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').bind(now, tokenHash, now).run();
  if ((r.meta?.changes ?? 0) !== 1) return null;
  const row = await db.prepare('SELECT email, return_to FROM login_tokens WHERE token_hash = ?').bind(tokenHash).first<{ email: string; return_to: string | null }>();
  return row ? { email: row.email, returnTo: row.return_to } : null;
}

/** Drop tokens that ended a day ago (best effort, on each new token). */
export const pruneLoginTokens = (db: D1Like, now: number): Promise<unknown> => db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').bind(now - 86_400_000).run();

// ---- purchases and entitlements

export interface PurchaseInput {
  userId: string;
  providerRef: string;
  product: Scope;
  amount: number | null;
  currency: string | null;
  email: string | null;
  now: number;
}

/** Record a purchase once per provider_ref; its id (the existing one on a replay). */
export async function recordPurchase(db: D1Like, p: PurchaseInput): Promise<string> {
  await db
    .prepare('INSERT OR IGNORE INTO purchases (id, user_id, provider, provider_ref, product, amount, currency, status, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), p.userId, 'stripe', p.providerRef, p.product, p.amount, p.currency, 'paid', p.email ? normEmail(p.email) : null, p.now)
    .run();
  const row = await db.prepare('SELECT id FROM purchases WHERE provider_ref = ?').bind(p.providerRef).first<{ id: string }>();
  if (!row) throw new Error('purchase insert failed');
  return row.id;
}

export interface PurchaseRow {
  id: string;
  user_id: string;
  provider: string;
  provider_ref: string;
  product: Scope;
  amount: number | null;
  currency: string | null;
}

const PURCHASE_COLS = 'id, user_id, provider, provider_ref, product, amount, currency';

export const purchaseById = (db: D1Like, id: string): Promise<PurchaseRow | null> => db.prepare(`SELECT ${PURCHASE_COLS} FROM purchases WHERE id = ?`).bind(id).first<PurchaseRow>();
export const purchaseByRef = (db: D1Like, providerRef: string): Promise<PurchaseRow | null> =>
  db.prepare(`SELECT ${PURCHASE_COLS} FROM purchases WHERE provider_ref = ?`).bind(providerRef).first<PurchaseRow>();

export const hasPurchases = async (db: D1Like, email: string): Promise<boolean> =>
  !!(await db.prepare('SELECT id FROM purchases WHERE email = ? LIMIT 1').bind(normEmail(email)).first());

export interface EntitlementRow {
  id: string;
  user_id: string;
  scope: Scope;
  event_id: string | null;
  starts_at: number;
  expires_at: number | null;
  purchase_id: string | null;
  subscription_id: string | null;
  seats: number | null;
  revoked_at: number | null;
}

const ENT_COLS = 'id, user_id, scope, event_id, starts_at, expires_at, purchase_id, subscription_id, seats, revoked_at';

export interface GrantInput {
  userId: string;
  scope: Scope;
  eventId: string | null;
  startsAt: number;
  expiresAt: number | null;
  purchaseId: string | null;
  subscriptionId: string | null;
  seats?: number | null;
}

/** Grant once: a second grant for the same purchase or subscription is ignored (UNIQUE keys). */
export const grant = (db: D1Like, g: GrantInput): Promise<unknown> =>
  db
    .prepare('INSERT OR IGNORE INTO entitlements (id, user_id, scope, event_id, starts_at, expires_at, purchase_id, subscription_id, seats) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), g.userId, g.scope, g.eventId, g.startsAt, g.expiresAt, g.purchaseId, g.subscriptionId, g.seats ?? null)
    .run();

export const entitlementBySubscription = (db: D1Like, subscriptionId: string): Promise<EntitlementRow | null> =>
  db.prepare(`SELECT ${ENT_COLS} FROM entitlements WHERE subscription_id = ?`).bind(subscriptionId).first<EntitlementRow>();

export const setExpiry = (db: D1Like, id: string, expiresAt: number): Promise<unknown> =>
  db.prepare('UPDATE entitlements SET expires_at = ? WHERE id = ?').bind(expiresAt, id).run();

/** The user's own entitlement rows, as stored. */
export const entitlementRowsOf = async (db: D1Like, userId: string): Promise<EntitlementRow[]> =>
  (await db.prepare(`SELECT ${ENT_COLS} FROM entitlements WHERE user_id = ?`).bind(userId).all<EntitlementRow>()).results;

/** Revoke once: the first revocation's time stands (a second is a no-op). */
export const revokeEntitlement = (db: D1Like, id: string, now: number): Promise<unknown> =>
  db.prepare('UPDATE entitlements SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now, id).run();

/** Gift passes (scripts/grant-gift.mjs) use these ids for their purchase and entitlement rows. */
export const GIFT_ID_PREFIX = 'gift_';
export const isGiftRow = (r: Pick<EntitlementRow, 'purchase_id'>): boolean => !!r.purchase_id?.startsWith(GIFT_ID_PREFIX);

const toEntitlement = (r: EntitlementRow, members?: string[]): Entitlement => ({
  id: r.id,
  userId: r.user_id,
  scope: r.scope,
  eventId: r.event_id,
  startsAt: r.starts_at,
  expiresAt: r.expires_at,
  seats: r.seats,
  revokedAt: r.revoked_at,
  ...(isGiftRow(r) ? { gift: true } : {}),
  ...(members ? { members } : {}),
});

/** The user's own entitlements and the Coach plans they hold a seat on (with each plan's members). */
export async function entitlementsOf(db: D1Like, userId: string): Promise<Entitlement[]> {
  // Both indexed by user (entitlements_user, team_members_user), read side by side.
  const [ownRows, teamRows] = await Promise.all([
    db.prepare(`SELECT ${ENT_COLS} FROM entitlements WHERE user_id = ?`).bind(userId).all<EntitlementRow>(),
    db.prepare('SELECT team_id FROM team_members WHERE user_id = ?').bind(userId).all<{ team_id: string }>(),
  ]);
  const own = ownRows.results;
  const teams = teamRows.results.map((t) => t.team_id);
  const ids = teams.filter((t) => !own.some((e) => e.id === t)).slice(0, 20);
  const joined = ids.length ? (await db.prepare(`SELECT ${ENT_COLS} FROM entitlements WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all<EntitlementRow>()).results : [];
  const out: Entitlement[] = [];
  for (const r of [...own, ...joined]) {
    if (r.scope !== 'coach') {
      out.push(toEntitlement(r));
      continue;
    }
    const m = (await db.prepare("SELECT user_id FROM team_members WHERE team_id = ? AND role = 'member' ORDER BY joined_at ASC").bind(r.id).all<{ user_id: string }>()).results;
    out.push(toEntitlement(r, m.map((x) => x.user_id)));
  }
  return out;
}

// ---- Stripe event idempotency

export const eventSeen = async (db: D1Like, id: string): Promise<boolean> => !!(await db.prepare('SELECT id FROM stripe_events WHERE id = ?').bind(id).first());
export const markEvent = (db: D1Like, id: string, type: string, now: number): Promise<unknown> =>
  db.prepare('INSERT OR IGNORE INTO stripe_events (id, type, processed_at) VALUES (?, ?, ?)').bind(id, type, now).run();
