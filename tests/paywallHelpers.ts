/**
 * Shared bits for the paywall tests: an in-memory D1 (tests/d1mem.ts), a Map-backed edge cache,
 * signed-in sessions, passes, Stripe-signed webhook requests, and the Benelux fixture's regatta.
 * Every secret here is an obvious fake.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSession, ensureUser, grant, type BumpedDevice, type UserRow } from '../functions/_authDb';
import type { AuthDeps } from '../functions/_auth';
import type { PassView } from '../functions/_entitlements';
import { FREE_EVENTS } from '../src/data/freeEvents';
import { clearFreeCache, randomToken, tokenHash, type EmailBindingLike, type PaywallEnv } from '../functions/_paywall';
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

/** Every email the default env's EMAIL binding was handed (one line each, as the log provider writes it). */
export const outbox: string[] = [];
const outboxBinding: EmailBindingLike = { send: async (m) => void outbox.push(`[recall auth] email to ${m.to}: ${m.subject}\n${m.text}`) };

export function paywallEnv(db: MemD1 | undefined, over: Partial<PaywallEnv> = {}): PaywallEnv {
  return {
    PAYWALL_ENABLED: 'true',
    AUTH_DB: db,
    // The Workers binding (the `log` provider works on localhost only).
    EMAIL_PROVIDER: 'cloudflare',
    EMAIL_FROM: 'recall@walkeforward.example',
    EMAIL: outboxBinding,
    AUTH_SECRET: 'auth_secret_test_fake',
    GOOGLE_CLIENT_ID: 'google-client-id-test-fake.apps.example',
    GOOGLE_CLIENT_SECRET: 'google_secret_test_fake',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    // No STRIPE_PRICE_SEASON: the Season Pass is no longer sold, and nothing needs it.
    STRIPE_PRICE_REGATTA: 'price_test_regatta',
    TURNSTILE_SITE_KEY: 'turnstile_site_test_fake',
    TURNSTILE_SECRET_KEY: 'turnstile_secret_test_fake',
    ...over,
  };
}

/** What the page's Turnstile widget hands the email forms; withTurnstile's siteverify accepts it. */
export const TURNSTILE_TOKEN = 'turnstile_token_test_fake';
export const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * A fetch whose Turnstile siteverify passes TURNSTILE_TOKEN as solved on `hostname` (default the
 * ORIGIN's) and fails any other token; everything else goes to `next` (else a 404). `calls` keeps
 * each siteverify form.
 */
export function withTurnstile(next?: typeof fetch, hostname = new URL(ORIGIN).hostname): typeof fetch & { calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input) !== TURNSTILE_VERIFY) return next ? next(input, init) : new Response('nope', { status: 404 });
    const form = new URLSearchParams(String(init.body));
    calls.push(form);
    const ok = form.get('response') === TURNSTILE_TOKEN && form.get('secret') === 'turnstile_secret_test_fake';
    return new Response(JSON.stringify(ok ? { success: true, hostname, action: 'signin' } : { success: false, 'error-codes': ['invalid-input-response'] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch & { calls: URLSearchParams[] };
  f.calls = calls;
  return f;
}

/**
 * Deps with Cloudflare's siteverify faked (withTurnstile) and a mailbox: `sent` is every email sent
 * from here on, through the default env's binding or (on localhost) the log provider.
 */
export function mailbox(now = NOW, f: typeof fetch = withTurnstile()): AuthDeps & { readonly sent: string[]; links: () => string[] } {
  const start = outbox.length;
  const logged: string[] = [];
  const sent = (): string[] => [...logged, ...outbox.slice(start)];
  return {
    now: () => now,
    cache: null,
    fetch: f,
    log: (line) => logged.push(line),
    get sent() {
      return sent();
    },
    links: () => sent().flatMap((s) => s.match(/https?:\/\/\S+\/api\/auth\/verify[?#]token=[A-Za-z0-9_-]+/g) ?? []),
  };
}

/** The token in an emailed link: in the fragment (`#token=`, new links) or the query (`?token=`, links sent before). */
export const tokenOf = (link: string): string => {
  const u = new URL(link);
  return new URLSearchParams(u.hash.slice(1)).get('token') ?? u.searchParams.get('token') ?? '';
};

/** The old link shape (`?token=`), for the links sent before the token moved to the fragment. */
export const queryLink = (link: string): string => {
  const u = new URL(link);
  return `${u.origin}${u.pathname}?token=${tokenOf(link)}`;
};

/** The module-level cache (race 1 windows) and the outbox start empty in every test. */
export function resetPaywallCaches(): void {
  clearFreeCache();
  outbox.length = 0;
}

/** A signed-in user: their row, the Cookie header value, the session's public id and the devices its sign-in bumped. */
export async function signIn(
  db: MemD1,
  email: string,
  now = NOW,
  o: { userAgent?: string; method?: 'email' | 'google' } = {},
): Promise<{ user: UserRow; cookie: string; publicId: string; bumped: BumpedDevice[] }> {
  const user = await ensureUser(db, email, now);
  const token = randomToken();
  const { publicId, bumped } = await createSession(db, { tokenHash: await tokenHash('session', token), userId: user.id, now, userAgent: o.userAgent, method: o.method });
  return { user, cookie: `wf_session=${token}`, publicId, bumped };
}

/** What /api/auth/me also lists for anyone signed in, last: the free regattas' passes (src/data/freeEvents.ts). */
export const FREE_PASS_VIEWS: PassView[] = FREE_EVENTS.map((f) => ({ scope: 'regatta', eventId: f.id, startsAt: 0, expiresAt: f.until ?? null, seats: null, owner: true, free: true }));

export const giveRegatta =(db: MemD1, userId: string, eventId = EVENT, now = NOW): Promise<unknown> =>
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
