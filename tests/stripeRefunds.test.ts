import { beforeEach, describe, expect, it } from 'vitest';
import { ENDED, fullyRefunded, handleBilling, type BillingCtx } from '../functions/_stripe';
import { entitlementsOf, recordPurchase, grant } from '../functions/_authDb';
import { allowed } from '../functions/_entitlements';
import { handleAuth } from '../functions/_auth';
import type { PaywallDeps, PaywallEnv } from '../functions/_paywall';
import { MemD1 } from './d1mem';
import { EVENT, FREE_PASS_VIEWS, NOW, ORIGIN, fixture, paywallEnv, resetPaywallCaches, signIn, signedWebhook } from './paywallHelpers';

type Ev = { id: string; data: { object: Record<string, unknown> } };

const ctx = (request: Request, env: PaywallEnv, path: string): BillingCtx => ({ request, env, params: { path: path.split('/') } });
const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
const deps = (over: PaywallDeps = {}): PaywallDeps => ({ now: () => NOW, cache: null, ...over });
const ev = (name: string, edit: (o: Record<string, unknown>, e: Ev) => void = () => undefined): Ev => {
  const e = fixture(name) as unknown as Ev;
  edit(e.data.object, e);
  return e;
};

async function deliver(db: MemD1, e: unknown, at = NOW): Promise<Record<string, unknown>> {
  const res = await handleBilling(ctx(await signedWebhook(JSON.stringify(e), { tSec: Math.floor(at / 1000) }), paywallEnv(db), 'webhook'), deps({ now: () => at }));
  expect(res.status).toBe(200);
  return json(res);
}

/** May this user open race 2+ of EVENT now (the gate's own check, on D1 as it stands)? */
const opens = async (db: MemD1, userId: string, at = NOW): Promise<boolean> => allowed(await entitlementsOf(db, userId), userId, { eventId: EVENT, free: false, now: at });

/** A signed-in buyer of a Regatta Pass for EVENT (Checkout's metadata and client_reference_id name them). */
async function regattaBuyer(db: MemD1): Promise<{ id: string; cookie: string }> {
  const { user, cookie } = await signIn(db, 'buyer@example.com');
  expect(await deliver(db, ev('checkout_regatta', (o) => ((o.client_reference_id = user.id), ((o.metadata as Record<string, unknown>).user_id = user.id))))).toMatchObject({ outcome: 'granted' });
  expect(await opens(db, user.id)).toBe(true);
  return { id: user.id, cookie };
}

const refundOf = (name: string, userId: string): Ev => ev(name, (o) => ((o.metadata as Record<string, unknown>).user_id = userId));

beforeEach(resetPaywallCaches);

describe('charge.refunded', () => {
  it('a full refund of a Regatta Pass revokes it at once (gate and /api/auth/me alike)', async () => {
    const db = new MemD1();
    const { id, cookie } = await regattaBuyer(db);
    expect(await deliver(db, refundOf('charge_refunded_regatta', id), NOW + 1000)).toEqual({ received: true, outcome: 'revoked' });
    expect(db.rows('entitlements')[0].revoked_at).toBe(NOW + 1000);
    expect(await opens(db, id, NOW + 2000)).toBe(false);
    const me = await handleAuth({ request: new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie } }), env: paywallEnv(db), params: { path: ['me'] } }, { now: () => NOW + 2000 });
    // Only the free regattas' passes, which every signed-in user has.
    expect((await json(me)).entitlements).toEqual(FREE_PASS_VIEWS);
    expect(db.rows('stripe_events').map((e) => [e.id, e.type])).toContainEqual(['evt_test_ChRefundRegatta0001', 'charge.refunded']);
    // The purchase stays on record (what was paid); only the pass is revoked.
    expect(db.rows('purchases')).toHaveLength(1);
  });

  it('a partial refund keeps the pass', async () => {
    const db = new MemD1();
    const { id } = await regattaBuyer(db);
    expect(fullyRefunded({ amount: 5000, amount_refunded: 4999, refunded: false })).toBe(false);
    expect(fullyRefunded({ amount: 5000, amount_refunded: 5000 })).toBe(true);
    expect(fullyRefunded({ refunded: true })).toBe(true);
    expect(await deliver(db, refundOf('charge_refunded_partial', id))).toEqual({ received: true, outcome: 'ignored' });
    expect(db.rows('entitlements')[0].revoked_at).toBeNull();
    expect(await opens(db, id)).toBe(true);
  });

  it('is idempotent: a replay is a duplicate, a second refund event for the charge keeps the first revocation time', async () => {
    const db = new MemD1();
    const { id } = await regattaBuyer(db);
    const refund = refundOf('charge_refunded_regatta', id);
    expect(await deliver(db, refund, NOW + 1000)).toMatchObject({ outcome: 'revoked' });
    expect(await deliver(db, refund, NOW + 5000)).toEqual({ received: true, outcome: 'duplicate' });
    const again = { ...refund, id: 'evt_test_ChRefundRegatta0002' };
    expect(await deliver(db, again, NOW + 9000)).toMatchObject({ outcome: 'revoked' });
    expect(db.rows('entitlements')[0].revoked_at).toBe(NOW + 1000);
    expect(db.rows('entitlements')).toHaveLength(1);
  });

  it('an unknown charge (another product, no metadata, no invoice) is ignored and recorded', async () => {
    const db = new MemD1();
    const { id } = await regattaBuyer(db);
    expect(await deliver(db, fixture('charge_refunded_unknown'))).toEqual({ received: true, outcome: 'ignored' });
    // Metadata for another event, or another user, or a malformed event id: nothing of this buyer's goes.
    for (const [k, v] of [['event_id', 'someOtherEvent1'], ['user_id', 'not-a-user'], ['event_id', '../x']]) {
      const e = ev('charge_refunded_regatta', (o, x) => {
        (o.metadata as Record<string, unknown>).user_id = id;
        (o.metadata as Record<string, unknown>)[k] = v;
        x.id = `evt_test_ChRefund_${k}_${v.length}`;
      });
      expect(await deliver(db, e)).toMatchObject({ outcome: 'ignored' });
    }
    expect(await opens(db, id)).toBe(true);
    expect(db.rows('stripe_events').map((e) => e.id)).toContain('evt_test_ChRefundOther0001');
  });

  it('never revokes a gift pass for the same event', async () => {
    const db = new MemD1();
    const { user } = await signIn(db, 'friend@example.com');
    await db.prepare("INSERT INTO purchases (id, user_id, provider, provider_ref, product, amount, status, email, created_at) VALUES ('gift_0123456789abcdef01234567', ?, 'gift', 'gift:0123456789abcdef01234567', 'regatta', 0, 'gift', 'friend@example.com', ?)").bind(user.id, NOW).run();
    await grant(db, { userId: user.id, scope: 'regatta', eventId: EVENT, startsAt: NOW - 1, expiresAt: null, purchaseId: 'gift_0123456789abcdef01234567', subscriptionId: null });
    expect(await deliver(db, refundOf('charge_refunded_regatta', user.id))).toMatchObject({ outcome: 'ignored' });
    expect(await opens(db, user.id)).toBe(true);
  });

  it('a full refund of the Season Pass’s first invoice ends it (the customer’s only season, for that amount)', async () => {
    const db = new MemD1();
    await deliver(db, fixture('checkout_season'));
    const userId = db.rows('users')[0].id as string;
    expect(await opens(db, userId)).toBe(true);
    // A refund for another amount on the same customer (some other product) is not this pass.
    expect(await deliver(db, ev('charge_refunded_season', (o, e) => ((o.amount = 900), (o.amount_refunded = 900), (e.id = 'evt_test_ChRefundSeasonOther'))))).toMatchObject({ outcome: 'ignored' });
    expect(await opens(db, userId)).toBe(true);
    expect(await deliver(db, fixture('charge_refunded_season'), NOW + 1000)).toEqual({ received: true, outcome: 'revoked' });
    expect(db.rows('entitlements')[0]).toMatchObject({ scope: 'season', revoked_at: NOW + 1000 });
    expect(await opens(db, userId, NOW + 2000)).toBe(false);
    // A later renewal or subscription update moves the expiry but never lifts the revocation.
    await deliver(db, fixture('invoice_paid'), 1824206500_000);
    expect(await opens(db, userId, 1824206600_000)).toBe(false);
  });

  it('a refunded renewal (recorded as an in_… purchase) and an expanded invoice both find the season', async () => {
    const db = new MemD1();
    await deliver(db, fixture('checkout_season'));
    await deliver(db, fixture('invoice_paid'), 1824206500_000);
    const userId = db.rows('users')[0].id as string;
    const renewal = ev('charge_refunded_season', (o, e) => ((o.invoice = 'in_test_Renewal0001'), (o.amount = 15900), (o.amount_refunded = 15900), (e.id = 'evt_test_ChRefundRenewal')));
    expect(await deliver(db, renewal, 1824206600_000)).toMatchObject({ outcome: 'revoked' });
    expect(await opens(db, userId, 1824206700_000)).toBe(false);

    const db2 = new MemD1();
    await deliver(db2, fixture('checkout_season'));
    const expanded = ev('charge_refunded_season', (o) => (o.invoice = { id: 'in_test_SeasonFirst0001', parent: { subscription_details: { subscription: 'sub_test_Season0001' } } }));
    expect(await deliver(db2, expanded)).toMatchObject({ outcome: 'revoked' });
    expect(db2.rows('entitlements')[0].revoked_at).toBe(NOW);
  });

  it('a season charge with no invoice on it (newer API versions) is ignored: cancelling the subscription ends access', async () => {
    const db = new MemD1();
    await deliver(db, fixture('checkout_season'));
    expect(await deliver(db, ev('charge_refunded_season', (o) => delete o.invoice))).toMatchObject({ outcome: 'ignored' });
    expect(db.rows('entitlements')[0].revoked_at).toBeNull();
    expect(await deliver(db, fixture('subscription_deleted'), 1810000000_000)).toMatchObject({ outcome: 'ended' });
  });

  it('two Stripe season passes on one customer: the first-invoice refund can’t tell which, so it is ignored', async () => {
    const db = new MemD1();
    await deliver(db, fixture('checkout_season'));
    const userId = db.rows('users')[0].id as string;
    const p = await recordPurchase(db, { userId, providerRef: 'cs_test_second', product: 'season', amount: 14900, currency: 'usd', email: null, now: NOW });
    await grant(db, { userId, scope: 'season', eventId: null, startsAt: NOW, expiresAt: NOW + 1e10, purchaseId: p, subscriptionId: 'sub_test_second' });
    expect(await deliver(db, fixture('charge_refunded_season'))).toMatchObject({ outcome: 'ignored' });
  });

  it('charge.dispute.created is not handled (no metadata on a dispute): 200, ignored', async () => {
    const db = new MemD1();
    const { id } = await regattaBuyer(db);
    const dispute = { id: 'evt_test_Dispute0001', object: 'event', type: 'charge.dispute.created', data: { object: { id: 'dp_test_0001', object: 'dispute', charge: 'ch_test_Regatta0001', payment_intent: 'pi_test_Regatta0001', amount: 5000, metadata: {} } } };
    expect(await deliver(db, dispute)).toEqual({ received: true, outcome: 'ignored' });
    expect(await opens(db, id)).toBe(true);
  });
});

describe('customer.subscription.updated: paused', () => {
  it('paused ends access now; resumed (active) runs to the period end again', async () => {
    expect(ENDED.has('paused')).toBe(true);
    const db = new MemD1();
    await deliver(db, fixture('checkout_season'));
    const userId = db.rows('users')[0].id as string;
    const at = 1795000000_000;
    expect(await deliver(db, fixture('subscription_paused'), at)).toEqual({ received: true, outcome: 'ended' });
    expect(db.rows('entitlements')[0].expires_at).toBe(at);
    expect(await opens(db, userId, at + 1)).toBe(false);
    const resumed = ev('subscription_paused', (o, e) => ((o.status = 'active'), (e.id = 'evt_test_SubResumed0001')));
    expect(await deliver(db, resumed, at + 60_000)).toMatchObject({ outcome: 'updated' });
    expect(await opens(db, userId, at + 120_000)).toBe(true);
  });
});

describe('Checkout: Origin as strict as the portal', () => {
  const post = (cookie: string, origin: string | null): Request =>
    new Request(`${ORIGIN}/api/billing/checkout`, {
      method: 'POST',
      body: JSON.stringify({ product: 'regatta', eventId: EVENT, returnTo: '/' }),
      headers: { 'content-type': 'application/json', cookie, ...(origin ? { origin } : {}) },
    });
  const stripe = (async () => new Response(JSON.stringify({ id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('refuses a missing, null or cross-site Origin (403) before anything else; this site and https walkeforward.com pass', async () => {
    const db = new MemD1();
    const { cookie } = await signIn(db, 'a@example.com');
    for (const origin of [null, 'null', 'https://evil.example', 'http://walkeforward.com', 'https://walkeforward.com:8443', 'https://walkeforward.com.evil.example', 'http://recall.walkeforward.com']) {
      const res = await handleBilling(ctx(post(cookie, origin), paywallEnv(db), 'checkout'), deps({ fetch: stripe }));
      expect(res.status, String(origin)).toBe(403);
    }
    // Refused even with no D1 (the Origin comes first).
    expect((await handleBilling(ctx(post(cookie, null), paywallEnv(undefined), 'checkout'), deps({ fetch: stripe }))).status).toBe(403);
    for (const origin of [ORIGIN, 'https://walkeforward.com', 'https://www.walkeforward.com']) {
      const res = await handleBilling(ctx(post(cookie, origin), paywallEnv(db), 'checkout'), deps({ fetch: stripe }));
      expect(res.status, origin).toBe(200);
    }
  });
});
