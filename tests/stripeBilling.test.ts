import { beforeEach, describe, expect, it } from 'vitest';
import { checkoutForm, handleBilling, invoiceSubscription, managedOn, managedPaymentsParams, periodEndMs, stripeHmac, verifyStripeSignature, type BillingCtx } from '../functions/_stripe';
import { userByEmail } from '../functions/_authDb';
import type { PaywallDeps, PaywallEnv } from '../functions/_paywall';
import { onRequest as billingRoute } from '../functions/api/billing/[[path]]';
import { jsonError } from '../functions/_lib';
import { MemD1 } from './d1mem';
import { EVENT, NOW, ORIGIN, WEBHOOK_SECRET, fixture, giveRegatta, paywallEnv, resetPaywallCaches, signIn, signedWebhook } from './paywallHelpers';

const ctx = (request: Request, env: PaywallEnv, path: string): BillingCtx => ({ request, env, params: { path: path.split('/') } });
const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
const deps = (over: PaywallDeps = {}): PaywallDeps => ({ now: () => NOW, cache: null, ...over });

async function deliver(db: MemD1, ev: Record<string, unknown>, env: PaywallEnv = paywallEnv(db), at = NOW): Promise<Response> {
  return handleBilling(ctx(await signedWebhook(JSON.stringify(ev), { tSec: Math.floor(at / 1000) }), env, 'webhook'), deps({ now: () => at }));
}

beforeEach(resetPaywallCaches);

describe('Stripe webhook signature', () => {
  const body = JSON.stringify(fixture('unknown_event'));
  const t = Math.floor(NOW / 1000);

  it('accepts a good v1, among several, and refuses the rest', async () => {
    const good = await stripeHmac(WEBHOOK_SECRET, `${t}.${body}`);
    expect(await verifyStripeSignature(body, `t=${t},v1=${good}`, WEBHOOK_SECRET, NOW)).toBe(true);
    expect(await verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)},v1=${good},v0=abc`, WEBHOOK_SECRET, NOW)).toBe(true);
    expect(await verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)}`, WEBHOOK_SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${t},v1=${good}`, 'whsec_test_other_fake', NOW)).toBe(false);
    expect(await verifyStripeSignature(`${body} `, `t=${t},v1=${good}`, WEBHOOK_SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(body, `v1=${good}`, WEBHOOK_SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(body, null, WEBHOOK_SECRET, NOW)).toBe(false);
  });

  it('refuses a stale (or far-future) timestamp beyond 5 minutes', async () => {
    const sig = async (ts: number): Promise<string> => `t=${ts},v1=${await stripeHmac(WEBHOOK_SECRET, `${ts}.${body}`)}`;
    expect(await verifyStripeSignature(body, await sig(t - 300), WEBHOOK_SECRET, NOW)).toBe(true);
    expect(await verifyStripeSignature(body, await sig(t - 301), WEBHOOK_SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(body, await sig(t + 301), WEBHOOK_SECRET, NOW)).toBe(false);
  });

  it('answers 400 to a bad signature and records nothing', async () => {
    const db = new MemD1();
    const req = await signedWebhook(JSON.stringify(fixture('checkout_regatta')), { secret: 'whsec_test_wrong_fake' });
    const res = await handleBilling(ctx(req, paywallEnv(db), 'webhook'), deps());
    expect(res.status).toBe(400);
    expect(db.rows('purchases')).toEqual([]);
    expect(db.rows('stripe_events')).toEqual([]);
  });
});

describe('Stripe webhook events', () => {
  it('checkout (payment): creates the user by email, a purchase and a regatta pass', async () => {
    const db = new MemD1();
    const res = await deliver(db, fixture('checkout_regatta'));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ received: true, outcome: 'granted' });
    const user = await userByEmail(db, 'sailor@example.com');
    expect(user).toMatchObject({ email: 'sailor@example.com', stripe_customer_id: 'cus_test_Regatta0001' });
    expect(db.rows('purchases')).toEqual([
      expect.objectContaining({ user_id: user!.id, provider: 'stripe', provider_ref: 'cs_test_a1RegattaPass0001', product: 'regatta', amount: 5000, currency: 'usd', status: 'paid', email: 'sailor@example.com' }),
    ]);
    expect(db.rows('entitlements')).toEqual([expect.objectContaining({ user_id: user!.id, scope: 'regatta', event_id: EVENT, expires_at: null, revoked_at: null })]);
  });

  it('checkout: the signed-in buyer (client_reference_id) gets it, whatever email they paid with', async () => {
    const db = new MemD1();
    const { user } = await signIn(db, 'owner@example.com');
    const ev = fixture('checkout_regatta') as { data: { object: Record<string, unknown> } };
    ev.data.object.client_reference_id = user.id;
    await deliver(db, ev);
    expect(db.rows('users')).toHaveLength(1);
    expect(db.rows('entitlements')[0]).toMatchObject({ user_id: user.id, event_id: EVENT });
  });

  it('is idempotent: the same event twice, and the same session through another event, grant once', async () => {
    const db = new MemD1();
    await deliver(db, fixture('checkout_regatta'));
    const again = await deliver(db, fixture('checkout_regatta'));
    expect(await json(again)).toEqual({ received: true, outcome: 'duplicate' });
    const async = await deliver(db, fixture('checkout_regatta_async'));
    expect(async.status).toBe(200);
    expect(db.rows('purchases')).toHaveLength(1);
    expect(db.rows('entitlements')).toHaveLength(1);
    expect(db.rows('stripe_events').map((e) => e.id)).toEqual(['evt_test_CsRegatta0001', 'evt_test_CsRegattaAsync01']);
  });

  it('grants nothing for an unpaid session (async payment still pending)', async () => {
    const db = new MemD1();
    const res = await deliver(db, fixture('checkout_regatta_unpaid'));
    expect(await json(res)).toEqual({ received: true, outcome: 'ignored' });
    expect(db.rows('entitlements')).toEqual([]);
    expect(db.rows('users')).toEqual([]);
  });

  it('season (existing subscriptions, no longer sold): a year by default, extended by invoice.paid, kept to period end when cancelled, ended on delete', async () => {
    const db = new MemD1();
    await deliver(db, fixture('checkout_season'));
    const [e] = db.rows('entitlements');
    expect(e).toMatchObject({ scope: 'season', subscription_id: 'sub_test_Season0001', starts_at: NOW, expires_at: NOW + 365 * 86_400_000 });
    expect(db.rows('users')[0]).toMatchObject({ email: 'crew@example.com', stripe_customer_id: 'cus_test_Season0001' });

    const renewal = await deliver(db, fixture('invoice_paid'), undefined, 1824206500_000);
    expect(await json(renewal)).toEqual({ received: true, outcome: 'extended' });
    expect(db.rows('entitlements')[0].expires_at).toBe(1855742400_000);
    expect(db.rows('purchases').map((p) => [p.provider_ref, p.amount])).toEqual([
      ['cs_test_b2SeasonPass0001', 14900],
      ['in_test_Renewal0001', 14900],
    ]);

    // Cancelled at period end: access runs to the (Stripe) period end.
    const cancelled = await deliver(db, fixture('subscription_updated'), undefined, 1800000000_000);
    expect(await json(cancelled)).toEqual({ received: true, outcome: 'updated' });
    expect(db.rows('entitlements')[0].expires_at).toBe(1824206400_000);

    const deleted = await deliver(db, fixture('subscription_deleted'), undefined, 1810000000_000);
    expect(await json(deleted)).toEqual({ received: true, outcome: 'ended' });
    expect(db.rows('entitlements')[0].expires_at).toBe(1810000000_000);
  });

  it('season: a paused subscription ends access now; resumed (active again) runs to the period end', async () => {
    const db = new MemD1();
    await deliver(db, fixture('checkout_season'));
    expect(await json(await deliver(db, fixture('subscription_paused'), undefined, 1805000000_000))).toMatchObject({ outcome: 'ended' });
    const ended = db.rows('entitlements')[0].expires_at as number;
    expect(ended).toBeLessThanOrEqual(1805000000_000);
    const resumed = fixture('subscription_updated') as { id: string; data: { object: Record<string, unknown> } };
    resumed.id = 'evt_test_SubResumed0001';
    resumed.data.object.cancel_at_period_end = false;
    expect(await json(await deliver(db, resumed, undefined, 1806000000_000))).toMatchObject({ outcome: 'updated' });
    expect(db.rows('entitlements')[0].expires_at).toBe(1824206400_000);
  });

  it('takes the period end from the event when the subscription is expanded', async () => {
    const db = new MemD1();
    const ev = fixture('checkout_season') as { data: { object: Record<string, unknown> } };
    ev.data.object.subscription = { id: 'sub_test_Season0001', items: { data: [{ current_period_end: 1824206400 }] } };
    await deliver(db, ev);
    expect(db.rows('entitlements')[0].expires_at).toBe(1824206400_000);
  });

  it('ignores invoice.paid for a subscription it has not granted yet, and unknown events (200)', async () => {
    const db = new MemD1();
    expect(await json(await deliver(db, fixture('invoice_paid')))).toEqual({ received: true, outcome: 'ignored' });
    const unknown = await deliver(db, fixture('unknown_event'));
    expect(unknown.status).toBe(200);
    expect(await json(unknown)).toEqual({ received: true, outcome: 'ignored' });
    expect(db.rows('entitlements')).toEqual([]);
  });

  it('answers 500 (so Stripe retries) when D1 fails, and has marked nothing', async () => {
    const db = new MemD1();
    db.fail = true;
    const res = await deliver(db, fixture('checkout_regatta'));
    expect(res.status).toBe(500);
    db.fail = false;
    expect(db.rows('stripe_events')).toEqual([]);
  });

  it('reads both invoice shapes and both period-end shapes', () => {
    expect(invoiceSubscription({ subscription: 'sub_test_a' })).toBe('sub_test_a');
    expect(invoiceSubscription({ parent: { subscription_details: { subscription: 'sub_test_b' } } })).toBe('sub_test_b');
    expect(invoiceSubscription({ lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_test_c' } } }] } })).toBe('sub_test_c');
    expect(invoiceSubscription({})).toBeNull();
    expect(periodEndMs({ current_period_end: 10 })).toBe(10_000);
    expect(periodEndMs({ items: { data: [{ current_period_end: 10 }, { current_period_end: 12 }] } })).toBe(12_000);
    expect(periodEndMs({})).toBeNull();
  });

  it('with the flag off: the proxy’s 404 even when signed correctly with D1 and the secret set; D1 never touched', async () => {
    const db = new MemD1();
    const proxy404 = jsonError(404, 'Unknown endpoint');
    for (const flag of [undefined, 'false', 'off', 'yes']) {
      const res = await billingRoute({ request: await signedWebhook(JSON.stringify(fixture('checkout_regatta'))), env: paywallEnv(db, { PAYWALL_ENABLED: flag }), params: { path: ['webhook'] } });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(await proxy404.clone().text());
      expect([...res.headers]).toEqual([...proxy404.headers]);
    }
    expect(db.log).toEqual([]);
    // GET with the flag off is the same 404; with it on, 405 (POST only).
    expect((await handleBilling(ctx(new Request(`${ORIGIN}/api/billing/webhook`), paywallEnv(db, { PAYWALL_ENABLED: undefined }), 'webhook'), deps())).status).toBe(404);
    expect((await handleBilling(ctx(new Request(`${ORIGIN}/api/billing/webhook`), paywallEnv(db), 'webhook'), deps())).status).toBe(405);
  });
});

describe('Checkout', () => {
  const post = (body: unknown, cookie?: string): Request =>
    new Request(`${ORIGIN}/api/billing/checkout`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) } });

  function stripeMock(): typeof fetch & { calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch & { calls: { url: string; init: RequestInit }[] };
    f.calls = calls;
    return f;
  }

  it('builds the regatta session: payment, price, metadata, the buyer, managed payments, back to the race', async () => {
    const db = new MemD1();
    const { user, cookie } = await signIn(db, 'buyer@example.com');
    const f = stripeMock();
    const res = await handleBilling(ctx(post({ product: 'regatta', eventId: EVENT, returnTo: `/?event=${EVENT}&div=J70&race=3` }, cookie), paywallEnv(db, { STRIPE_API_VERSION: '2025-09-30.clover' }), 'checkout'), deps({ fetch: f }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk_test_fake', 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2025-09-30.clover' });
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    expect(form).toMatchObject({
      mode: 'payment',
      'line_items[0][price]': 'price_test_regatta',
      'line_items[0][quantity]': '1',
      client_reference_id: user.id,
      customer_email: 'buyer@example.com',
      'metadata[product]': 'regatta',
      'metadata[event_id]': EVENT,
      'metadata[user_id]': user.id,
      'payment_intent_data[metadata][event_id]': EVENT,
      'managed_payments[enabled]': 'true',
      success_url: `${ORIGIN}/?event=${EVENT}&div=J70&race=3&checkout=success`,
      cancel_url: `${ORIGIN}/?event=${EVENT}&div=J70&race=3&checkout=cancel`,
    });
  });

  it('builds the session on the known customer, always a one-off payment; managed payments optional', () => {
    const form = Object.fromEntries(
      checkoutForm({ product: 'regatta', price: 'price_test_regatta', user: { id: 'u1', email: 'a@example.com', stripe_customer_id: 'cus_test_1' }, eventId: EVENT, successUrl: 's', cancelUrl: 'c', managed: false }),
    );
    expect(form).toMatchObject({ mode: 'payment', customer: 'cus_test_1', 'payment_intent_data[metadata][product]': 'regatta', 'payment_intent_data[metadata][user_id]': 'u1' });
    expect(Object.keys(form).some((k) => k.startsWith('subscription_data'))).toBe(false);
    expect(form.customer_email).toBeUndefined();
    expect(form['managed_payments[enabled]']).toBeUndefined();
    expect(managedOn(undefined)).toBe(true);
    expect(managedOn('off')).toBe(false);
    expect(managedPaymentsParams(true)).toEqual({ 'managed_payments[enabled]': 'true' });
  });

  it('needs a session (401), a known product and event, and refuses a pass already held (409)', async () => {
    const db = new MemD1();
    const f = stripeMock();
    const env = paywallEnv(db);
    const anon = await handleBilling(ctx(post({ product: 'regatta', eventId: EVENT }), env, 'checkout'), deps({ fetch: f }));
    expect(anon.status).toBe(401);
    expect(await json(anon)).toMatchObject({ error: 'sign_in_required' });
    const { user, cookie } = await signIn(db, 'buyer@example.com');
    expect((await handleBilling(ctx(post({ product: 'coach' }, cookie), env, 'checkout'), deps({ fetch: f }))).status).toBe(400);
    expect((await handleBilling(ctx(post({ product: 'regatta', eventId: '../x' }, cookie), env, 'checkout'), deps({ fetch: f }))).status).toBe(400);
    await giveRegatta(db, user.id);
    resetPaywallCaches();
    expect((await handleBilling(ctx(post({ product: 'regatta', eventId: EVENT }, cookie), env, 'checkout'), deps({ fetch: f }))).status).toBe(409);
    expect(f.calls).toHaveLength(0);
    // Unconfigured price: 503, no call out.
    const noPrice = paywallEnv(db, { STRIPE_PRICE_REGATTA: undefined });
    expect((await handleBilling(ctx(post({ product: 'regatta', eventId: 'someOtherEvent1' }, cookie), noPrice, 'checkout'), deps({ fetch: f }))).status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses the Season Pass (no longer sold): 400 not_available, no Stripe call, whatever is configured', async () => {
    const db = new MemD1();
    const f = stripeMock();
    const { cookie } = await signIn(db, 'buyer@example.com');
    for (const env of [paywallEnv(db), paywallEnv(db, { STRIPE_PRICE_SEASON: 'price_test_season' } as Partial<PaywallEnv>)]) {
      for (const body of [{ product: 'season' }, { product: 'season', eventId: EVENT, returnTo: '/' }]) {
        const res = await handleBilling(ctx(post(body, cookie), env, 'checkout'), deps({ fetch: f }));
        expect(res.status).toBe(400);
        const out = await json(res);
        expect(out).toMatchObject({ error: 'not_available' });
        expect(String(out.message)).toMatch(/no longer sold/);
        expect(String(out.message)).toContain('$50');
      }
    }
    expect(f.calls).toHaveLength(0);
    // The regatta pass still opens Stripe without any STRIPE_PRICE_SEASON.
    expect((await handleBilling(ctx(post({ product: 'regatta', eventId: EVENT }, cookie), paywallEnv(db), 'checkout'), deps({ fetch: f }))).status).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect(new URLSearchParams(String(f.calls[0].init.body)).get('line_items[0][price]')).toBe('price_test_regatta');
  });

  it('an existing Season Pass subscriber: every regatta already held (409, no Stripe call), and Manage subscription opens their portal', async () => {
    const db = new MemD1();
    await deliver(db, fixture('checkout_season'));
    const { cookie } = await signIn(db, 'crew@example.com');
    resetPaywallCaches();
    const f = stripeMock();
    for (const eventId of [EVENT, 'someOtherEvent1']) {
      const res = await handleBilling(ctx(post({ product: 'regatta', eventId }, cookie), paywallEnv(db), 'checkout'), deps({ fetch: f }));
      expect(res.status, eventId).toBe(409);
    }
    expect(f.calls).toHaveLength(0);
    const portal = await handleBilling(ctx(portalPost(cookie), paywallEnv(db), 'portal'), deps({ fetch: f }));
    expect(portal.status).toBe(200);
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.stripe.com/v1/billing_portal/sessions']);
    expect(new URLSearchParams(String(f.calls[0].init.body)).get('customer')).toBe('cus_test_Season0001');
  });

  it('is the proxy’s 404 with the flag off (route file included)', async () => {
    const db = new MemD1();
    const { cookie } = await signIn(db, 'buyer@example.com');
    for (const env of [paywallEnv(db, { PAYWALL_ENABLED: 'false' }), paywallEnv(db, { PAYWALL_ENABLED: undefined }), paywallEnv(db, { PAYWALL_ENABLED: 'yes' })]) {
      const res = await billingRoute({ request: post({ product: 'regatta', eventId: EVENT }, cookie), env, params: { path: ['checkout'] } });
      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({ error: 'Unknown endpoint' });
    }
  });

  const portalPost = (cookie?: string, origin: string | null = ORIGIN): Request =>
    new Request(`${ORIGIN}/api/billing/portal`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) } });

  it('portal: POST only; 401 signed out, 404 with no customer, else { url } of Stripe’s portal (no redirect)', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    expect((await handleBilling(ctx(portalPost(), env, 'portal'), deps())).status).toBe(401);
    const { user, cookie } = await signIn(db, 'buyer@example.com');
    expect((await handleBilling(ctx(portalPost(cookie), env, 'portal'), deps())).status).toBe(404);
    await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').bind('cus_test_1', user.id).run();
    const calls: string[] = [];
    const f = (async (u: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(`${String(u)} ${String(init.body)}`);
      return new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session/test_fake' }));
    }) as unknown as typeof fetch;
    const res = await handleBilling(ctx(portalPost(cookie), env, 'portal'), deps({ fetch: f }));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await json(res)).toEqual({ url: 'https://billing.stripe.com/p/session/test_fake' });
    expect(calls).toEqual([`https://api.stripe.com/v1/billing_portal/sessions customer=cus_test_1&return_url=${encodeURIComponent(`${ORIGIN}/regattas`)}`]);
    // A walkeforward.com page may ask too.
    expect((await handleBilling(ctx(portalPost(cookie, 'https://walkeforward.com'), env, 'portal'), deps({ fetch: f }))).status).toBe(200);
    // GET: 405 with the flag on (it used to redirect).
    const get = await handleBilling(ctx(new Request(`${ORIGIN}/api/billing/portal`, { headers: { cookie } }), env, 'portal'), deps({ fetch: f }));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(calls).toHaveLength(2);
  });

  it('portal: refuses a missing or cross-site Origin before anything else; 404 with the flag off', async () => {
    const db = new MemD1();
    const { user, cookie } = await signIn(db, 'buyer@example.com');
    await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').bind('cus_test_1', user.id).run();
    let called = 0;
    const f = (async () => {
      called++;
      return new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session/test_fake' }));
    }) as unknown as typeof fetch;
    for (const origin of [null, 'https://evil.example', 'null', 'http://walkeforward.com', 'https://walkeforward.com.evil.example']) {
      const res = await handleBilling(ctx(portalPost(cookie, origin), paywallEnv(db), 'portal'), deps({ fetch: f }));
      expect(res.status, String(origin)).toBe(403);
      expect(await json(res)).toEqual({ error: 'forbidden' });
    }
    expect(called).toBe(0);
    for (const request of [portalPost(cookie), new Request(`${ORIGIN}/api/billing/portal`, { headers: { cookie } })]) {
      const off = await billingRoute({ request, env: paywallEnv(db, { PAYWALL_ENABLED: undefined }), params: { path: ['portal'] } });
      expect(off.status).toBe(404);
      expect(await json(off)).toEqual({ error: 'Unknown endpoint' });
    }
    expect(called).toBe(0);
  });
});
