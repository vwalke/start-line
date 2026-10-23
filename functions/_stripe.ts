/**
 * Payments for the paywall: the handler behind functions/api/billing/[[path]].ts (kept in a `_` file
 * so tests call it directly). Stripe's REST API with plain `fetch` (form-encoded), no SDK; the
 * webhook's signature is checked with WebCrypto.
 *
 *   POST /api/billing/checkout  { product: 'regatta', eventId, returnTo } → { url } (a Checkout Session); an
 *                               Origin header from this site (or https walkeforward.com) is required, as for the portal
 *   POST /api/billing/webhook   Stripe's events (signed): purchases and entitlements, idempotently; a full refund revokes
 *   POST /api/billing/portal    → { url } of Stripe's Billing Portal for the signed-in customer (Manage
 *                               subscription); an Origin header from this site (or https walkeforward.com) is required
 *
 * Product: the Regatta Pass (STRIPE_PRICE_REGATTA, one-off, mode=payment) unlocks one event id, the
 * only thing on sale. The Season Pass (a yearly subscription, every regatta) is no longer sold: checkout
 * refuses it and STRIPE_PRICE_SEASON is unused, but existing subscriptions keep working here (their
 * webhooks: renewals, updates, cancellation, refunds) and in the portal. The Coach plan exists in the
 * data model only (no checkout yet). Stripe Managed Payments (Stripe
 * as merchant of record) is asked for on every session unless STRIPE_MANAGED_PAYMENTS is off (see
 * managedPaymentsParams). STRIPE_API_VERSION, when set, goes out as the Stripe-Version header.
 *
 * With PAYWALL_ENABLED off every route here, the webhook included, is the proxy's 404 and D1 is never
 * touched (try purchases end to end on a Preview deployment with the flag on).
 */
import type { Scope } from './_entitlements';
import {
  ensureUser,
  entitlementBySubscription,
  entitlementRowsOf,
  eventSeen,
  grant,
  isGiftRow,
  markEvent,
  purchaseById,
  purchaseByRef,
  recordPurchase,
  revokeEntitlement,
  setExpiry,
  setStripeCustomer,
  userById,
  userByStripeCustomer,
  type D1Like,
  type EntitlementRow,
  type UserRow,
} from './_authDb';
import { intentHeld, originRefused, readBuy, safeReturnTo, unavailable, withParam } from './_auth';
import { jsonOut, notFound, paywallOn, viewerOf, type PaywallDeps, type PaywallEnv } from './_paywall';
import { readCapped } from './_vkx';
import { endpointPath } from './_lib';
import { EVENT_ID_RE } from '../src/data/vkx/validate';

export interface BillingCtx {
  request: Request;
  env: PaywallEnv;
  params?: { path?: string | string[] };
  waitUntil?(p: Promise<unknown>): void;
}

export const STRIPE_API = 'https://api.stripe.com';
/** Signed webhooks older (or newer) than this are refused. */
export const SIGNATURE_TOLERANCE_S = 300;
export const MAX_WEBHOOK_BYTES = 1_000_000;
const YEAR_MS = 365 * 86_400_000;

// ---- signatures

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function stripeHmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}

/**
 * Stripe-Signature `t=<unix s>,v1=<hex>[,v1=…][,v0=…]`: valid when some v1 is the HMAC-SHA256 of
 * `${t}.${rawBody}` under the endpoint's secret (compared in constant time) and t is within the tolerance.
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowMs: number, toleranceS = SIGNATURE_TOLERANCE_S): Promise<boolean> {
  if (!header || !secret) return false;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (t == null || !v1.length || Math.abs(nowMs / 1000 - t) > toleranceS) return false;
  const want = await stripeHmac(secret, `${t}.${rawBody}`);
  let ok = false;
  for (const s of v1) ok = sameHex(s, want) || ok;
  return ok;
}

// ---- checkout

/**
 * Managed Payments (Stripe as merchant of record) on a Checkout Session. The parameter is from
 * Stripe's Managed Payments preview docs as we know them: confirm its exact name (and whether a
 * preview Stripe-Version is needed, via STRIPE_API_VERSION) once the account is approved. It lives
 * here only.
 */
export const managedPaymentsParams = (on: boolean): Record<string, string> => (on ? { 'managed_payments[enabled]': 'true' } : {});

/** STRIPE_MANAGED_PAYMENTS: on unless "0", "false" or "off". */
export const managedOn = (raw: string | undefined): boolean => !/^(0|false|off)$/i.test((raw ?? '').trim());

export type Product = Extract<Scope, 'regatta'>;

export interface CheckoutInput {
  product: Product;
  price: string;
  user: Pick<UserRow, 'id' | 'email' | 'stripe_customer_id'>;
  eventId: string | null;
  successUrl: string;
  cancelUrl: string;
  managed: boolean;
}

/** The Checkout Session's form body. */
export function checkoutForm(c: CheckoutInput): URLSearchParams {
  const f = new URLSearchParams();
  f.set('mode', 'payment');
  f.set('line_items[0][price]', c.price);
  f.set('line_items[0][quantity]', '1');
  f.set('success_url', c.successUrl);
  f.set('cancel_url', c.cancelUrl);
  f.set('client_reference_id', c.user.id);
  if (c.user.stripe_customer_id) f.set('customer', c.user.stripe_customer_id);
  else f.set('customer_email', c.user.email);
  const meta: Record<string, string> = { product: c.product, user_id: c.user.id, ...(c.eventId ? { event_id: c.eventId } : {}) };
  for (const [k, v] of Object.entries(meta)) f.set(`metadata[${k}]`, v);
  for (const [k, v] of Object.entries(meta)) f.set(`payment_intent_data[metadata][${k}]`, v);
  for (const [k, v] of Object.entries(managedPaymentsParams(c.managed))) f.set(k, v);
  return f;
}

const stripeHeaders = (env: PaywallEnv): Record<string, string> => ({
  authorization: `Bearer ${env.STRIPE_SECRET_KEY!.trim()}`,
  'content-type': 'application/x-www-form-urlencoded',
  ...(env.STRIPE_API_VERSION?.trim() ? { 'stripe-version': env.STRIPE_API_VERSION.trim() } : {}),
});

const signInFirst = (): Response => jsonOut(401, { error: 'sign_in_required', message: 'Sign in first, then unlock: your pass is kept with your email.' });

async function checkout(ctx: BillingCtx, deps: PaywallDeps): Promise<Response> {
  const env = ctx.env;
  const req = ctx.request;
  // As strict as the portal: an Origin header (every browser sends one on a fetch POST) from this site or walkeforward.com.
  if (originRefused(req)) return jsonOut(403, { error: 'forbidden' });
  if (!env.AUTH_DB) return jsonOut(503, { error: 'not_configured', message: 'Sign-in is not set up on this site yet.' });
  const now = (deps.now ?? Date.now)();
  const v = await viewerOf(req, env, now);
  if (!v.user) return signInFirst();
  const raw = await readCapped(req, 4_000);
  let body: Record<string, unknown> = {};
  try {
    body = raw ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>) : {};
  } catch {
    return jsonOut(400, { error: 'bad_request' });
  }
  const product = body?.product;
  if (product === 'coach') return jsonOut(400, { error: 'not_available', message: 'The Coach plan is not on sale yet.' });
  if (product === 'season') return jsonOut(400, { error: 'not_available', message: 'The Season Pass is no longer sold: race 1 of every regatta is free, and you can unlock the rest of a regatta for $50.' });
  if (product !== 'regatta') return jsonOut(400, { error: 'bad_product' });
  const eventId = typeof body.eventId === 'string' && EVENT_ID_RE.test(body.eventId) ? body.eventId : null;
  if (!eventId) return jsonOut(400, { error: 'bad_event' });
  // The page's automatic checkout after sign-in sends the server's signed marker: it must be this user's,
  // unexpired, for this very product and event (a stale or forged one starts nothing).
  if (body.intent !== undefined) {
    const b = await readBuy(env.AUTH_SECRET?.trim() ?? '', body.intent, v.user.id, now);
    if (!b || b.product !== product || b.eventId !== eventId) return jsonOut(400, { error: 'bad_intent' });
  }
  const price = env.STRIPE_PRICE_REGATTA?.trim();
  if (!env.STRIPE_SECRET_KEY?.trim() || !price) return jsonOut(503, { error: 'not_configured', message: 'Payments are not set up on this site yet.' });
  const user = v.user;
  const has = intentHeld(v.entitlements, user.id, { product, eventId }, now);
  if (has) return jsonOut(409, { error: 'already_entitled', message: 'This regatta is already unlocked for you.' });
  const origin = new URL(req.url).origin;
  const back = new URL(safeReturnTo(body.returnTo, origin), origin).href;
  const form = checkoutForm({
    product,
    price,
    user,
    eventId,
    successUrl: withParam(back, 'checkout', 'success'),
    cancelUrl: withParam(back, 'checkout', 'cancel'),
    managed: managedOn(env.STRIPE_MANAGED_PAYMENTS),
  });
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${STRIPE_API}/v1/checkout/sessions`, { method: 'POST', headers: stripeHeaders(env), body: form });
  } catch {
    return jsonOut(502, { error: 'checkout_failed', message: "Couldn't reach the payment page. Try again in a minute." });
  }
  const out = (await res.json().catch(() => ({}))) as { url?: unknown };
  if (!res.ok || typeof out.url !== 'string') return jsonOut(502, { error: 'checkout_failed', message: "Couldn't open the payment page. Try again in a minute." });
  return jsonOut(200, { url: out.url });
}

/** A POST from this site (Origin required): `{ url }` for the page to go to, never a redirect a cross-site form could follow. */
async function portal(ctx: BillingCtx, deps: PaywallDeps): Promise<Response> {
  const env = ctx.env;
  if (originRefused(ctx.request)) return jsonOut(403, { error: 'forbidden' });
  if (!env.AUTH_DB || !env.STRIPE_SECRET_KEY?.trim()) return jsonOut(503, { error: 'not_configured', message: 'Payments are not set up on this site yet.' });
  const v = await viewerOf(ctx.request, env, (deps.now ?? Date.now)());
  if (!v.user) return signInFirst();
  const customer = v.user.stripe_customer_id;
  if (!customer) return jsonOut(404, { error: 'no_customer', message: 'No payments on this account yet.' });
  const origin = new URL(ctx.request.url).origin;
  const form = new URLSearchParams({ customer, return_url: `${origin}/` });
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${STRIPE_API}/v1/billing_portal/sessions`, { method: 'POST', headers: stripeHeaders(env), body: form });
  } catch {
    return jsonOut(502, { error: 'portal_failed' });
  }
  const out = (await res.json().catch(() => ({}))) as { url?: unknown };
  if (!res.ok || typeof out.url !== 'string') return jsonOut(502, { error: 'portal_failed' });
  return jsonOut(200, { url: out.url });
}

// ---- webhook (Season Pass subscriptions are no longer sold, but existing ones still renew, change, end and refund here)

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const idOf = (x: unknown): string | null => str(x) ?? str(obj(x).id);

/** A subscription's current period end, ms (top level in older API versions, per item in newer ones). */
export function periodEndMs(sub: Obj): number | null {
  const top = num(sub.current_period_end);
  if (top != null) return top * 1000;
  const items = (obj(sub.items).data as unknown[] | undefined) ?? [];
  const ends = items.map((i) => num(obj(i).current_period_end)).filter((x): x is number => x != null);
  return ends.length ? Math.max(...ends) * 1000 : null;
}

/** The subscription an invoice pays for (older and newer API shapes). */
export function invoiceSubscription(inv: Obj): string | null {
  const direct = idOf(inv.subscription) ?? str(obj(obj(inv.parent).subscription_details).subscription);
  if (direct) return direct;
  for (const l of (obj(inv.lines).data as unknown[] | undefined) ?? []) {
    const s = idOf(obj(l).subscription) ?? str(obj(obj(obj(l).parent).subscription_item_details).subscription);
    if (s) return s;
  }
  return null;
}

export type WebhookOutcome = 'granted' | 'extended' | 'updated' | 'ended' | 'revoked' | 'ignored' | 'duplicate';

async function findBuyer(db: D1Like, s: Obj, now: number): Promise<UserRow | null> {
  const meta = obj(s.metadata);
  for (const id of [str(s.client_reference_id), str(meta.user_id)]) {
    const u = id ? await userById(db, id) : null;
    if (u) return u;
  }
  const customer = idOf(s.customer);
  const byCustomer = customer ? await userByStripeCustomer(db, customer) : null;
  if (byCustomer) return byCustomer;
  // Entitlements follow the email: a buyer with no user yet gets one (signing in with that email finds it).
  const email = str(obj(s.customer_details).email) ?? str(s.customer_email);
  return email ? ensureUser(db, email, now) : null;
}

async function onCheckoutPaid(db: D1Like, s: Obj, now: number): Promise<WebhookOutcome> {
  const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
  if (!paid || !str(s.id)) return 'ignored';
  const meta = obj(s.metadata);
  const product = str(meta.product) ?? (s.mode === 'subscription' ? 'season' : s.mode === 'payment' ? 'regatta' : null);
  if (product !== 'regatta' && product !== 'season') return 'ignored';
  const eventId = str(meta.event_id);
  if (product === 'regatta' && !(eventId && EVENT_ID_RE.test(eventId))) return 'ignored';
  const subscriptionId = product === 'season' ? idOf(s.subscription) : null;
  if (product === 'season' && !subscriptionId) return 'ignored';
  const user = await findBuyer(db, s, now);
  if (!user) return 'ignored';
  const customer = idOf(s.customer);
  if (customer) await setStripeCustomer(db, user.id, customer);
  const email = str(obj(s.customer_details).email) ?? str(s.customer_email) ?? user.email;
  const purchaseId = await recordPurchase(db, { userId: user.id, providerRef: str(s.id)!, product, amount: num(s.amount_total), currency: str(s.currency), email, now });
  if (product === 'regatta') {
    await grant(db, { userId: user.id, scope: 'regatta', eventId, startsAt: now, expiresAt: null, purchaseId, subscriptionId: null });
  } else {
    const end = periodEndMs(obj(s.subscription)) ?? now + YEAR_MS;
    await grant(db, { userId: user.id, scope: 'season', eventId: null, startsAt: now, expiresAt: end, purchaseId, subscriptionId });
  }
  return 'granted';
}

async function onInvoicePaid(db: D1Like, inv: Obj, now: number): Promise<WebhookOutcome> {
  const sub = invoiceSubscription(inv);
  const ent = sub ? await entitlementBySubscription(db, sub) : null;
  // Not granted yet (the checkout event comes later): that grant takes a year, the next invoice the true end.
  if (!ent) return 'ignored';
  const ends = ((obj(inv.lines).data as unknown[] | undefined) ?? []).map((l) => num(obj(obj(l).period).end)).filter((x): x is number => x != null);
  const end = ends.length ? Math.max(...ends) * 1000 : null;
  if (end == null) return 'ignored';
  if (end > (ent.expires_at ?? 0)) await setExpiry(db, ent.id, end);
  // Renewals are purchases too (the first invoice is the checkout's own).
  const amount = num(inv.amount_paid);
  if (str(inv.id) && inv.billing_reason !== 'subscription_create' && amount) {
    await recordPurchase(db, { userId: ent.user_id, providerRef: str(inv.id)!, product: ent.scope, amount, currency: str(inv.currency), email: str(inv.customer_email), now });
  }
  return 'extended';
}

/** Statuses that end access now (`paused`: a trial ended without a payment method; resuming makes it active again). */
export const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']);

async function onSubscriptionChange(db: D1Like, sub: Obj, deleted: boolean, now: number): Promise<WebhookOutcome> {
  const id = str(sub.id);
  const ent = id ? await entitlementBySubscription(db, id) : null;
  if (!ent) return 'ignored';
  if (deleted || ENDED.has(String(sub.status))) {
    const at = num(sub.ended_at) ?? (deleted ? null : num(sub.canceled_at));
    const end = at != null ? at * 1000 : now;
    await setExpiry(db, ent.id, ent.expires_at == null ? end : Math.min(ent.expires_at, end));
    return 'ended';
  }
  // Active, trialing, past due, or cancelled at period end: access runs to the period's end.
  const end = periodEndMs(sub);
  if (end == null) return 'ignored';
  await setExpiry(db, ent.id, end);
  return 'updated';
}

/** Fully refunded (`refunded`, or the whole amount back); a partial refund keeps the pass. */
export function fullyRefunded(ch: Obj): boolean {
  if (ch.refunded === true) return true;
  const amount = num(ch.amount);
  const back = num(ch.amount_refunded);
  return amount != null && back != null && amount > 0 && back >= amount;
}

/**
 * The Stripe-bought entitlements a charge paid for, from what the charge carries and D1 already
 * holds (no Stripe API call, no schema change); none when it can't be tied (another product on the
 * account, or an API version whose charges name no invoice: README "Paywall", Refunds):
 *  - a Regatta Pass: the charge's metadata (product, user_id, event_id), which Stripe copies onto the
 *    charge from the PaymentIntent, where Checkout put payment_intent_data[metadata]; the user's
 *    regatta entitlement for that event that a Stripe purchase granted (never a gift);
 *  - a Season Pass invoice: the charge's `invoice`. Its subscription when the invoice is expanded;
 *    else a renewal recorded as a purchase (provider_ref in_…) names the user; else (the first
 *    invoice, the checkout's own) the charge's customer, when that user holds exactly one Stripe
 *    season entitlement and its purchase was for this very amount.
 */
async function chargeEntitlements(db: D1Like, ch: Obj): Promise<EntitlementRow[]> {
  const meta = obj(ch.metadata);
  const userId = str(meta.user_id);
  if (meta.product === 'regatta' && userId) {
    const eventId = str(meta.event_id);
    if (!eventId || !EVENT_ID_RE.test(eventId)) return [];
    const rows = (await entitlementRowsOf(db, userId)).filter((e) => e.scope === 'regatta' && e.event_id === eventId && e.purchase_id && !isGiftRow(e));
    const out: EntitlementRow[] = [];
    for (const e of rows) if ((await purchaseById(db, e.purchase_id!))?.provider === 'stripe') out.push(e);
    return out;
  }
  const invoiceId = idOf(ch.invoice);
  if (!invoiceId) return [];
  const sub = invoiceSubscription(obj(ch.invoice));
  if (sub) {
    const ent = await entitlementBySubscription(db, sub);
    return ent ? [ent] : [];
  }
  const renewal = await purchaseByRef(db, invoiceId);
  const customer = idOf(ch.customer);
  const owner = renewal?.provider === 'stripe' ? renewal.user_id : customer ? ((await userByStripeCustomer(db, customer))?.id ?? null) : null;
  if (!owner) return [];
  const seasons = (await entitlementRowsOf(db, owner)).filter((e) => e.scope !== 'regatta' && e.subscription_id && e.revoked_at == null && !isGiftRow(e));
  if (seasons.length !== 1) return [];
  if (renewal?.provider === 'stripe') return seasons;
  const bought = seasons[0].purchase_id ? await purchaseById(db, seasons[0].purchase_id) : null;
  const amount = num(ch.amount);
  return bought && bought.amount != null && bought.amount === amount ? seasons : [];
}

/** charge.refunded: a full refund revokes what the charge paid for (idempotently: the first revocation stands). */
async function onChargeRefunded(db: D1Like, ch: Obj, now: number): Promise<WebhookOutcome> {
  if (!fullyRefunded(ch)) return 'ignored';
  const ents = await chargeEntitlements(db, ch);
  if (!ents.length) return 'ignored';
  for (const e of ents) await revokeEntitlement(db, e.id, now);
  return 'revoked';
}

/** Apply one verified event; replays (same event id) do nothing. */
export async function applyEvent(db: D1Like, ev: Obj, now: number): Promise<WebhookOutcome> {
  const id = str(ev.id);
  const type = str(ev.type) ?? '';
  if (!id) return 'ignored';
  if (await eventSeen(db, id)) return 'duplicate';
  const o = obj(obj(ev.data).object);
  let out: WebhookOutcome = 'ignored';
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') out = await onCheckoutPaid(db, o, now);
  else if (type === 'invoice.paid') out = await onInvoicePaid(db, o, now);
  else if (type === 'customer.subscription.updated') out = await onSubscriptionChange(db, o, false, now);
  else if (type === 'customer.subscription.deleted') out = await onSubscriptionChange(db, o, true, now);
  else if (type === 'charge.refunded') out = await onChargeRefunded(db, o, now);
  // charge.dispute.created is not handled: a dispute names its charge and PaymentIntent by id only (no
  // metadata), so tying it to a pass needs a Stripe API call or a stored charge id (README "Paywall").
  // Recorded after it is applied: a failure part-way is retried by Stripe, and every write above is idempotent.
  await markEvent(db, id, type, now);
  return out;
}

async function webhook(ctx: BillingCtx, deps: PaywallDeps): Promise<Response> {
  const env = ctx.env;
  const db = env.AUTH_DB;
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!db || !secret) return jsonOut(503, { error: 'not_configured' });
  const raw = await readCapped(ctx.request, MAX_WEBHOOK_BYTES);
  if (!raw) return jsonOut(413, { error: 'too_large' });
  const text = new TextDecoder().decode(raw);
  const now = (deps.now ?? Date.now)();
  if (!(await verifyStripeSignature(text, ctx.request.headers.get('stripe-signature'), secret, now))) return jsonOut(400, { error: 'bad_signature' });
  let ev: Obj;
  try {
    ev = obj(JSON.parse(text));
  } catch {
    return jsonOut(400, { error: 'bad_json' });
  }
  try {
    const outcome = await applyEvent(db, ev, now);
    return jsonOut(200, { received: true, outcome });
  } catch {
    // Stripe retries a 5xx: nothing was marked handled.
    return jsonOut(500, { error: 'not_recorded' });
  }
}

// ---- the router

/** /api/billing/<path>: 404 (as the proxy's) unless PAYWALL_ENABLED, the webhook included; every route is POST only. */
export async function handleBilling(ctx: BillingCtx, deps: PaywallDeps = {}): Promise<Response> {
  const path = endpointPath(ctx.params?.path);
  const method = ctx.request.method.toUpperCase();
  if (!paywallOn(ctx.env)) return notFound();
  const routes: Record<string, (ctx: BillingCtx, deps: PaywallDeps) => Promise<Response>> = { checkout, portal, webhook };
  const run = Object.prototype.hasOwnProperty.call(routes, path) ? routes[path] : undefined;
  if (!run) return notFound();
  if (method !== 'POST') return jsonOut(405, { error: 'Method not allowed' }, { allow: 'POST' });
  // The webhook answers for itself (a 500 on a D1 failure, so Stripe retries).
  if (run === webhook) return webhook(ctx, deps);
  try {
    return await run(ctx, deps);
  } catch {
    return unavailable();
  }
}
