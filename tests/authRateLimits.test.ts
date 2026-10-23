import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMAIL_RATE_MAX, IP_RATE_MAX, RATE_WINDOW_MS, handleAuth, rateKeys, type AuthCtx, type AuthDeps } from '../functions/_auth';
import { countRateHit, pruneRateLimits } from '../functions/_authDb';
import type { PaywallEnv } from '../functions/_paywall';
import { MemD1 } from './d1mem';
import { NOW, ORIGIN, TURNSTILE_TOKEN, paywallEnv, resetPaywallCaches, withTurnstile } from './paywallHelpers';

const ctx = (request: Request, env: PaywallEnv): AuthCtx => ({ request, env, params: { path: ['email'] } });
const HOUR = RATE_WINDOW_MS;
/** NOW's window starts on the hour (12:00Z). */
const WINDOW = Math.floor(NOW / HOUR) * HOUR;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const deps = (now = NOW, o: Partial<AuthDeps> = {}): AuthDeps => ({ now: () => now, cache: null, fetch: withTurnstile(), log: () => undefined, random: () => 0.5, ...o });
const send = (env: PaywallEnv, email: string, ip: string, at = NOW, o: Partial<AuthDeps> = {}): Promise<Response> =>
  handleAuth(
    ctx(new Request(`${ORIGIN}/api/auth/email`, { method: 'POST', body: JSON.stringify({ email, turnstileToken: TURNSTILE_TOKEN }), headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': ip } }), env),
    deps(at, o),
  );

beforeEach(resetPaywallCaches);

describe('sign-in rate limits in D1 (shared by every isolate)', () => {
  it(`${EMAIL_RATE_MAX} links per address per hour, whatever the IP; then the usual 429`, async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    for (let i = 0; i < EMAIL_RATE_MAX; i++) expect((await send(env, 'Racer@Example.com', `198.51.100.${i}`)).status).toBe(200);
    const over = await send(env, 'racer@example.com ', '198.51.100.99');
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'rate_limited', message: 'Too many sign-in emails. Try again in an hour.' });
    // Another address from the same IPs is fine.
    expect((await send(env, 'other@example.com', '198.51.100.1')).status).toBe(200);
  });

  it(`${IP_RATE_MAX} links per IP per hour, whatever the address`, async () => {
    const env = paywallEnv(new MemD1());
    for (let i = 0; i < IP_RATE_MAX; i++) expect((await send(env, `sailor${i}@example.com`, '203.0.113.7')).status).toBe(200);
    expect((await send(env, 'one-more@example.com', '203.0.113.7')).status).toBe(429);
    expect((await send(env, 'one-more@example.com', '203.0.113.8')).status).toBe(200);
  });

  it('counts survive across isolates: the count lives in D1, not in the handler', async () => {
    const db = new MemD1();
    // Each call stands for a different isolate: nothing is shared but the database.
    for (let i = 0; i < EMAIL_RATE_MAX; i++) expect((await send(paywallEnv(db), 'iso@example.com', `192.0.2.${i}`)).status).toBe(200);
    expect((await send(paywallEnv(db), 'iso@example.com', '192.0.2.200')).status).toBe(429);
  });

  it('fixed one-hour windows: the next hour starts again from 1', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    for (let i = 0; i < EMAIL_RATE_MAX; i++) await send(env, 'roll@example.com', `192.0.2.${i}`, WINDOW + 59 * 60_000);
    expect((await send(env, 'roll@example.com', '192.0.2.50', WINDOW + 59 * 60_000 + 59_000)).status).toBe(429);
    expect((await send(env, 'roll@example.com', '192.0.2.51', WINDOW + HOUR)).status).toBe(200);
    const row = db.rows('auth_rate_limits').find((r) => r.key === `email:${sha('roll@example.com')}`);
    expect(row).toEqual({ key: `email:${sha('roll@example.com')}`, window_start: WINDOW + HOUR, count: 1 });
  });

  it('stores hashes only: never the address or the IP', async () => {
    const db = new MemD1();
    await send(paywallEnv(db), 'Private@Example.com', '203.0.113.42');
    const rows = db.rows('auth_rate_limits');
    expect(rows.map((r) => r.key).sort()).toEqual([`email:${sha('private@example.com')}`, `ip:${sha('203.0.113.42')}`].sort());
    expect(JSON.stringify(rows)).not.toMatch(/private|example|203\.0\.113/i);
    expect(await rateKeys(' Private@Example.com', '203.0.113.42')).toEqual({ email: `email:${sha('private@example.com')}`, ip: `ip:${sha('203.0.113.42')}` });
  });

  it('one atomic upsert per key, the count returned', async () => {
    const db = new MemD1();
    expect(await countRateHit(db, 'ip:abc', WINDOW + 10)).toBe(1);
    expect(await countRateHit(db, 'ip:abc', WINDOW + 20)).toBe(2);
    expect(await countRateHit(db, 'ip:abc', WINDOW + HOUR)).toBe(1);
    expect(db.log.filter((s) => s.includes('auth_rate_limits'))).toEqual(Array(3).fill(expect.stringMatching(/^INSERT INTO auth_rate_limits .* ON CONFLICT \(key\) DO UPDATE SET .* RETURNING count$/)));
  });

  it('now and then (about 1 call in 100) drops counters older than 2 hours', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    await send(env, 'old@example.com', '192.0.2.1', WINDOW - 3 * HOUR);
    await send(env, 'recent@example.com', '192.0.2.2', WINDOW - HOUR);
    expect(db.rows('auth_rate_limits')).toHaveLength(4);
    await send(env, 'now@example.com', '192.0.2.3', WINDOW, { random: () => 0.5 });
    expect(db.rows('auth_rate_limits')).toHaveLength(6);
    await send(env, 'now@example.com', '192.0.2.3', WINDOW, { random: () => 0.001 });
    expect(db.rows('auth_rate_limits').map((r) => r.window_start).sort()).toEqual([WINDOW - HOUR, WINDOW - HOUR, WINDOW, WINDOW]);
    await pruneRateLimits(db, WINDOW + 3 * HOUR);
    expect(db.rows('auth_rate_limits')).toEqual([]);
  });

  it('limits: null skips them (no rows)', async () => {
    const db = new MemD1();
    for (let i = 0; i < EMAIL_RATE_MAX + 2; i++) expect((await send(paywallEnv(db), 'free@example.com', '192.0.2.9', NOW, { limits: null })).status).toBe(200);
    expect(db.rows('auth_rate_limits')).toEqual([]);
  });
});
