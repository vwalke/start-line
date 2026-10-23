/**
 * Shared bits for the paywall tests: an in-memory D1 (tests/d1mem.ts), a Map-backed edge cache,
 * signed-in sessions, passes, Stripe-signed webhook requests, and the Benelux fixture's regatta.
 * Every secret here is an obvious fake.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSession, ensureUser, grant, type UserRow } from '../functions/_authDb';
import { clearFreeCache, randomToken, tokenHash, type PaywallEnv } from '../functions/_paywall';
import { stripeHmac } from '../functions/_stripe';
import type { RegattaResponse } from '../src/data/racesense/types';
import { MemD1 } from './d1mem';
import { loadFixture } from './helpers';

export const ORIGIN = 'https://recall.walkeforward.com';
export const WEBHOOK_SECRET = 'whsec_test_fake';
export const NOW = Date.parse('2026-10-22T12:00:00Z');
/** Benelux Sailing League Act III (J70, races 1–9). */
export const EVENT = 'fDHdPcEOM6mcMRkdXNnj';

export class FakeCache {
  readonly store = new Map<string, Response>();
  async match(req: Request): Promise<Response | undefined> {
    return this.store.get(req.url)?.clone();
  }
  async put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, res.clone());
  }
  async delete(req: Request): Promise<boolean> {
    return this.store.delete(req.url);
  }
}

export function paywallEnv(db: MemD1 | undefined, over: Partial<PaywallEnv> = {}): PaywallEnv {
  return {
    PAYWALL_ENABLED: 'true',
    AUTH_DB: db,
    EMAIL_PROVIDER: 'log',
    EMAIL_FROM: 'recall@walkeforward.example',
    AUTH_SECRET: 'auth_secret_test_fake',
    GOOGLE_CLIENT_ID: 'google-client-id-test-fake.apps.example',
    GOOGLE_CLIENT_SECRET: 'google_secret_test_fake',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    // No STRIPE_PRICE_SEASON: the Season Pass is no longer sold, and nothing needs it.
    STRIPE_PRICE_REGATTA: 'price_test_regatta',
    ...over,
  };
}

/** The module-level cache (race 1 windows) starts empty in every test. */
export function resetPaywallCaches(): void {
  clearFreeCache();
}

/** A signed-in user: their row and the Cookie header value. */
export async function signIn(db: MemD1, email: string, now = NOW): Promise<{ user: UserRow; cookie: string }> {
  const user = await ensureUser(db, email, now);
  const token = randomToken();
  await createSession(db, { tokenHash: await tokenHash('session', token), userId: user.id, now });
  return { user, cookie: `wf_session=${token}` };
}

export const giveRegatta = (db: MemD1, userId: string, eventId = EVENT, now = NOW): Promise<unknown> =>
  grant(db, { userId, scope: 'regatta', eventId, startsAt: now - 1000, expiresAt: null, purchaseId: null, subscriptionId: null });

export const giveSeason = (db: MemD1, userId: string, expiresAt: number, now = NOW): Promise<unknown> =>
  grant(db, { userId, scope: 'season', eventId: null, startsAt: now - 1000, expiresAt, purchaseId: null, subscriptionId: `sub_test_${userId.slice(0, 8)}` });

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/stripe/${name}.json`, import.meta.url)), 'utf8')) as Record<string, unknown>;
}

/** A webhook POST signed as Stripe signs it (t = `tSec`). */
export async function signedWebhook(body: string, o: { secret?: string; tSec?: number; extraV1?: string[] } = {}): Promise<Request> {
  const t = o.tSec ?? Math.floor(NOW / 1000);
  const v1 = await stripeHmac(o.secret ?? WEBHOOK_SECRET, `${t}.${body}`);
  const sig = [`t=${t}`, ...(o.extraV1 ?? []).map((x) => `v1=${x}`), `v1=${v1}`, 'v0=00'].join(',');
  return new Request(`${ORIGIN}/api/billing/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': sig } });
}

export const beneluxRegatta = (): RegattaResponse => loadFixture().regatta;

/** The upstream for the proxy tests: the regatta document, telemetry pages, anything else 404. Counts calls. */
export function mockUpstream(regatta: RegattaResponse = beneluxRegatta()): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith('https://racesense.vakaros.com/api/regatta')) return new Response(JSON.stringify(regatta), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://teleapi.regatta.app/telemetry/event/')) return new Response(JSON.stringify({ Fields: ['ts'], Rows: [[Number(new URL(url).searchParams.get('after'))]] }), { headers: { 'content-type': 'application/json' } });
    return new Response('nope', { status: 404 });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}
