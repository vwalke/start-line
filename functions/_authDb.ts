/**
 * The paywall's D1 queries (database bound as AUTH_DB; schema in migrations/0001_paywall.sql).
 *
 * The SQL keeps to a small subset on purpose (single-table SELECT / INSERT [OR IGNORE] / UPDATE /
 * DELETE; WHERE of ANDed comparisons, IS [NOT] NULL and IN; ORDER BY one column; LIMIT), so the
 * tests run these same statements on an in-memory engine that enforces the migration's keys
 * (tests/d1mem.ts). Idempotency comes from the schema's UNIQUE keys plus INSERT OR IGNORE.
 */
import type { Entitlement, Scope } from './_entitlements';

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
/** Signed-in browsers per user; a new sign-in revokes the oldest beyond this. */
export const MAX_SESSIONS = 3;
export const LOGIN_TOKEN_TTL_MS = 15 * 60_000;

export const newId = (): string => crypto.randomUUID();

// ---- users

export interface UserRow {
  id: string;
  email: string;
  google_sub: string | null;
  stripe_customer_id: string | null;
  created_at: number;
}

const USER_COLS = 'id, email, google_sub, stripe_customer_id, created_at';

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

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

/** Store a new session, then revoke the user's expired ones and the oldest beyond MAX_SESSIONS. */
export async function createSession(db: D1Like, s: { tokenHash: string; userId: string; now: number; userAgent?: string | null }): Promise<void> {
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(s.tokenHash, s.userId, s.now, s.now + SESSION_TTL_MS, (s.userAgent ?? '').slice(0, 200) || null)
    .run();
  const { results } = await db.prepare('SELECT token_hash, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC').bind(s.userId).all<{ token_hash: string; expires_at: number }>();
  const live = results.filter((r) => r.expires_at > s.now);
  const drop = [...results.filter((r) => r.expires_at <= s.now), ...live.slice(MAX_SESSIONS)].map((r) => r.token_hash).filter((h) => h !== s.tokenHash);
  for (const h of drop) await deleteSession(db, h);
}

/** The user id of a live session, or null (unknown or expired): one primary-key lookup. */
export async function sessionUserId(db: D1Like, tokenHash: string, now: number): Promise<string | null> {
  const s = await db.prepare('SELECT token_hash, user_id, created_at, expires_at FROM sessions WHERE token_hash = ?').bind(tokenHash).first<SessionRow>();
  return s && s.expires_at > now ? s.user_id : null;
}

/** The signed-in user of a session, or null (unknown or expired). */
export async function sessionUser(db: D1Like, tokenHash: string, now: number): Promise<UserRow | null> {
  const id = await sessionUserId(db, tokenHash, now);
  return id ? userById(db, id) : null;
}

export const deleteSession = (db: D1Like, tokenHash: string): Promise<unknown> => db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();

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
