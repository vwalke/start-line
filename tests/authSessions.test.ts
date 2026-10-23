import { beforeEach, describe, expect, it } from 'vitest';
import { handleAuth, type AuthCtx, type AuthDeps } from '../functions/_auth';
import { BUMPED_SHOWN_MS, DEFAULT_MAX_SESSIONS, LAST_SEEN_EVERY_MS, REVOKED_KEEP_MS, SESSION_TTL_MS, sessionCap } from '../functions/_authDb';
import { telemetryGate, viewerOf, type PaywallEnv } from '../functions/_paywall';
import { MemD1 } from './d1mem';
import { EVENT, NOW, ORIGIN, mockUpstream, paywallEnv, resetPaywallCaches, signIn } from './paywallHelpers';

const ctx = (request: Request, env: PaywallEnv, path: string): AuthCtx => ({ request, env, params: { path: path.split('/') } });
const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
const deps = (now = NOW): AuthDeps => ({ now: () => now, cache: null, log: () => undefined });
const MIN = 60_000;
const HOUR = 3_600_000;

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};

const meOf = async (db: MemD1, cookie: string, at = NOW): Promise<Response> => handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie } }), paywallEnv(db), 'me'), deps(at));
const postAs = (db: MemD1, path: string, cookie: string, body: unknown = {}, at = NOW, headers: Record<string, string> = { origin: ORIGIN }): Promise<Response> =>
  handleAuth(ctx(new Request(`${ORIGIN}/api/auth/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie, ...headers } }), paywallEnv(db), path), deps(at));
const who = async (db: MemD1, cookie: string, at = NOW): Promise<string | null> => (await viewerOf(new Request(ORIGIN, { headers: { cookie } }), paywallEnv(db), at)).user?.email ?? null;

/** Four sign-ins on four devices, a minute apart: the iPhone (oldest) is the one the fourth bumps, unless used since. */
async function fourDevices(db: MemD1, email = 'sailor@example.com') {
  const iphone = await signIn(db, email, NOW, { userAgent: UA.iphone, method: 'email' });
  const mac = await signIn(db, email, NOW + MIN, { userAgent: UA.mac, method: 'google' });
  const windows = await signIn(db, email, NOW + 2 * MIN, { userAgent: UA.windows, method: 'email' });
  return { iphone, mac, windows, fourth: () => signIn(db, email, NOW + 3 * MIN, { userAgent: UA.android, method: 'email' }) };
}

beforeEach(resetPaywallCaches);

describe('the device cap', () => {
  it('a 4th sign-in revokes the least recently used device (kept, marked device_limit, by the new session)', async () => {
    const db = new MemD1();
    const d = await fourDevices(db);
    const android = await d.fourth();
    expect(android.bumped).toEqual([{ label: 'Safari on iPhone', lastSeenAt: NOW }]);
    const iphoneRow = db.rows('sessions').find((r) => r.public_id === d.iphone.publicId)!;
    expect(iphoneRow).toMatchObject({ revoked_at: NOW + 3 * MIN, revoked_reason: 'device_limit', revoked_by: android.publicId });
    expect(db.rows('sessions')).toHaveLength(4);
    expect(await who(db, d.iphone.cookie, NOW + 4 * MIN)).toBeNull();
    for (const c of [d.mac.cookie, d.windows.cookie, android.cookie]) expect(await who(db, c, NOW + 4 * MIN)).toBe('sailor@example.com');
  });

  it('least recently used, not oldest: a device used since keeps its place', async () => {
    const db = new MemD1();
    const d = await fourDevices(db);
    // The iPhone is used two hours later (its last_seen_at is written), then the 4th device signs in.
    expect(await who(db, d.iphone.cookie, NOW + 2 * HOUR)).toBe('sailor@example.com');
    const android = await signIn(db, 'sailor@example.com', NOW + 2 * HOUR + MIN, { userAgent: UA.android });
    expect(android.bumped).toEqual([{ label: 'Chrome on Mac', lastSeenAt: NOW + MIN }]);
    expect(await who(db, d.iphone.cookie, NOW + 2 * HOUR + 2 * MIN)).toBe('sailor@example.com');
    expect(await who(db, d.mac.cookie, NOW + 2 * HOUR + 2 * MIN)).toBeNull();
  });

  it('a per-user cap (the admin’s users.max_sessions) replaces the default, clamped to 1..20', async () => {
    expect([sessionCap(null), sessionCap(undefined), sessionCap(5), sessionCap(0), sessionCap(-3), sessionCap(99), sessionCap(2.5), sessionCap('4')]).toEqual([3, 3, 5, 1, 1, 20, 3, 3]);
    expect(DEFAULT_MAX_SESSIONS).toBe(3);
    const db = new MemD1();
    const a = await signIn(db, 'crew@example.com', NOW, { userAgent: UA.iphone });
    await db.prepare('UPDATE users SET max_sessions = ? WHERE email = ?').bind(5, 'crew@example.com').run();
    const more = [];
    for (let i = 1; i <= 4; i++) more.push(await signIn(db, 'crew@example.com', NOW + i * MIN, { userAgent: UA.mac }));
    expect(more.every((s) => s.bumped.length === 0)).toBe(true);
    expect(db.rows('sessions').filter((r) => r.revoked_at == null)).toHaveLength(5);
    const sixth = await signIn(db, 'crew@example.com', NOW + 5 * MIN, { userAgent: UA.windows });
    expect(sixth.bumped).toEqual([{ label: 'Safari on iPhone', lastSeenAt: NOW }]);
    expect(await who(db, a.cookie, NOW + 6 * MIN)).toBeNull();
    // A cap of 1: each sign-in signs out the one before.
    await db.prepare('UPDATE users SET max_sessions = ? WHERE email = ?').bind(1, 'crew@example.com').run();
    const solo = await signIn(db, 'crew@example.com', NOW + 7 * MIN);
    expect(solo.bumped).toHaveLength(5);
    expect(db.rows('sessions').filter((r) => r.revoked_at == null).map((r) => r.public_id)).toEqual([solo.publicId]);
  });

  it('caps are per user: another account’s sessions are never touched', async () => {
    const db = new MemD1();
    const other = await signIn(db, 'other@example.com', NOW - HOUR);
    const d = await fourDevices(db);
    await d.fourth();
    expect(await who(db, other.cookie, NOW + 4 * MIN)).toBe('other@example.com');
  });

  it('stores the public id, method and last use; deletes expired rows and rows revoked over 30 days ago', async () => {
    const db = new MemD1();
    const old = await signIn(db, 'tidy@example.com', NOW - SESSION_TTL_MS - HOUR);
    const a = await signIn(db, 'tidy@example.com', NOW, { method: 'google', userAgent: UA.mac });
    expect(db.rows('sessions').map((r) => r.public_id)).not.toContain(old.publicId);
    const row = db.rows('sessions').find((r) => r.public_id === a.publicId)!;
    expect(row).toMatchObject({ method: 'google', last_seen_at: NOW, created_at: NOW, revoked_at: null });
    expect(a.publicId).toMatch(/^[0-9a-f]{24}$/);
    // A revoked row stays for 30 days (for the note), then goes at the next sign-in.
    await db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE public_id = ?').bind(NOW + MIN, 'remote', a.publicId).run();
    await signIn(db, 'tidy@example.com', NOW + 2 * MIN);
    expect(db.rows('sessions').map((r) => r.public_id)).toContain(a.publicId);
    await signIn(db, 'tidy@example.com', NOW + MIN + REVOKED_KEEP_MS + 1);
    expect(db.rows('sessions').map((r) => r.public_id)).not.toContain(a.publicId);
  });
});

describe('a revoked session is signed out everywhere', () => {
  it('/me: signed out with the reason, and the cookie cleared; the next /me is a plain signed-out', async () => {
    const db = new MemD1();
    const d = await fourDevices(db);
    await d.fourth();
    const res = await meOf(db, d.iphone.cookie, NOW + 4 * MIN);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBe('wf_session=; Domain=.walkeforward.com; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax');
    const b = await json(res);
    expect(b).toMatchObject({ paywall: true, user: null, entitlements: [], signedOutReason: 'device_limit' });
    expect(b.devices).toBeUndefined();
    const after = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`), paywallEnv(db), 'me'), deps(NOW + 4 * MIN));
    expect((await json(after)).signedOutReason).toBeUndefined();
    expect(after.headers.get('set-cookie')).toBeNull();
  });

  it('remote and admin reasons come through as such; an unknown cookie or an expired session says nothing', async () => {
    const db = new MemD1();
    const a = await signIn(db, 'r@example.com');
    const b = await signIn(db, 'r@example.com', NOW + MIN);
    await db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE public_id = ?').bind(NOW + 2 * MIN, 'remote', a.publicId).run();
    await db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE public_id = ?').bind(NOW + 2 * MIN, 'admin', b.publicId).run();
    expect((await json(await meOf(db, a.cookie, NOW + 3 * MIN))).signedOutReason).toBe('remote');
    expect((await json(await meOf(db, b.cookie, NOW + 3 * MIN))).signedOutReason).toBe('admin');
    const nobody = await meOf(db, `wf_session=${'A'.repeat(43)}`);
    expect((await json(nobody)).signedOutReason).toBeUndefined();
    expect(nobody.headers.get('set-cookie')).toBeNull();
    const c = await signIn(db, 'r@example.com', NOW + 4 * MIN);
    expect((await json(await meOf(db, c.cookie, NOW + 4 * MIN + SESSION_TTL_MS))).signedOutReason).toBeUndefined();
  });

  it('the data gate and checkout treat it as signed out too', async () => {
    const db = new MemD1();
    const a = await signIn(db, 'g@example.com');
    await db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE public_id = ?').bind(NOW + MIN, 'remote', a.publicId).run();
    const env = paywallEnv(db);
    const qs = new URLSearchParams({ after: String(NOW - 10 * HOUR), before: String(NOW + HOUR) });
    const g = await telemetryGate(new Request(`${ORIGIN}/api/telemetry/event/${EVENT}?${qs}`, { headers: { cookie: a.cookie } }), env, EVENT, qs, { fetch: mockUpstream(), now: () => NOW + 2 * MIN, cache: null });
    expect(g.kind).toBe('deny');
    expect(g.kind === 'deny' && g.response.status).toBe(401);
  });
});

describe('last_seen_at', () => {
  it('is written at most once an hour per session (a normal request adds no write)', async () => {
    const db = new MemD1();
    const a = await signIn(db, 'busy@example.com');
    const writes = (): number => db.log.filter((s) => s.startsWith('UPDATE sessions SET last_seen_at')).length;
    for (const t of [NOW + MIN, NOW + 30 * MIN, NOW + LAST_SEEN_EVERY_MS - 1]) await who(db, a.cookie, t);
    expect(writes()).toBe(0);
    await who(db, a.cookie, NOW + LAST_SEEN_EVERY_MS);
    expect(writes()).toBe(1);
    expect(db.rows('sessions')[0].last_seen_at).toBe(NOW + LAST_SEEN_EVERY_MS);
    for (const t of [NOW + LAST_SEEN_EVERY_MS + MIN, NOW + LAST_SEEN_EVERY_MS + 59 * MIN]) await who(db, a.cookie, t);
    expect(writes()).toBe(1);
    await meOf(db, a.cookie, NOW + 2 * LAST_SEEN_EVERY_MS + 1);
    expect(writes()).toBe(2);
  });
});

describe('/me devices and bumped', () => {
  it('lists the live devices (this one first, then by last use) with the cap; never a token or hash', async () => {
    const db = new MemD1();
    const d = await fourDevices(db);
    const b = await json(await meOf(db, d.mac.cookie, NOW + 3 * MIN));
    expect(b.devices).toEqual({
      max: 3,
      list: [
        { id: d.mac.publicId, label: 'Chrome on Mac', method: 'google', createdAt: NOW + MIN, lastSeenAt: NOW + MIN, current: true },
        { id: d.windows.publicId, label: 'Firefox on Windows', method: 'email', createdAt: NOW + 2 * MIN, lastSeenAt: NOW + 2 * MIN, current: false },
        { id: d.iphone.publicId, label: 'Safari on iPhone', method: 'email', createdAt: NOW, lastSeenAt: NOW, current: false },
      ],
    });
    expect(b.bumped).toEqual([]);
    const text = JSON.stringify(b);
    for (const r of db.rows('sessions')) expect(text).not.toContain(String(r.token_hash));
    expect(text).not.toMatch(/token|hash/i);
  });

  it('the new device says what it signed out, for 10 minutes', async () => {
    const db = new MemD1();
    const d = await fourDevices(db);
    const android = await d.fourth();
    const b = await json(await meOf(db, android.cookie, NOW + 4 * MIN));
    expect(b.bumped).toEqual([{ label: 'Safari on iPhone', lastSeenAt: NOW }]);
    expect((b.devices as { list: { label: string }[] }).list.map((x) => x.label)).toEqual(['Chrome on Android', 'Firefox on Windows', 'Chrome on Mac']);
    expect((await json(await meOf(db, android.cookie, NOW + 3 * MIN + BUMPED_SHOWN_MS + 1))).bumped).toEqual([]);
    // Only its own: the Mac's sign-in bumped nothing.
    expect((await json(await meOf(db, d.mac.cookie, NOW + 4 * MIN))).bumped).toEqual([]);
  });
});

describe('signing other devices out', () => {
  it('revoke: one other device of the same user, reason remote; answers the updated list', async () => {
    const db = new MemD1();
    const d = await fourDevices(db);
    const res = await postAs(db, 'sessions/revoke', d.mac.cookie, { id: d.iphone.publicId }, NOW + 3 * MIN);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const b = await json(res);
    expect(b.ok).toBe(true);
    expect((b.devices as { list: { id: string }[] }).list.map((x) => x.id)).toEqual([d.mac.publicId, d.windows.publicId]);
    expect(db.rows('sessions').find((r) => r.public_id === d.iphone.publicId)).toMatchObject({ revoked_reason: 'remote', revoked_at: NOW + 3 * MIN, revoked_by: null });
    expect((await json(await meOf(db, d.iphone.cookie, NOW + 4 * MIN))).signedOutReason).toBe('remote');
    // Already signed out: 404.
    expect((await postAs(db, 'sessions/revoke', d.mac.cookie, { id: d.iphone.publicId }, NOW + 4 * MIN)).status).toBe(404);
  });

  it('never this session, nor another user’s; bad ids, no session or a cross-site POST are refused', async () => {
    const db = new MemD1();
    const d = await fourDevices(db);
    const stranger = await signIn(db, 'stranger@example.com', NOW, { userAgent: UA.windows });
    const current = await postAs(db, 'sessions/revoke', d.mac.cookie, { id: d.mac.publicId }, NOW + 3 * MIN);
    expect(current.status).toBe(400);
    expect((await json(current)).error).toBe('current_session');
    const theirs = await postAs(db, 'sessions/revoke', d.mac.cookie, { id: stranger.publicId }, NOW + 3 * MIN);
    expect(theirs.status).toBe(404);
    expect(await who(db, stranger.cookie, NOW + 4 * MIN)).toBe('stranger@example.com');
    for (const id of [undefined, '', 'nothex', d.iphone.publicId.toUpperCase(), `${d.iphone.publicId}0`]) expect((await postAs(db, 'sessions/revoke', d.mac.cookie, { id }, NOW + 3 * MIN)).status).toBe(400);
    expect((await postAs(db, 'sessions/revoke', '', { id: d.iphone.publicId }, NOW + 3 * MIN)).status).toBe(401);
    expect((await postAs(db, 'sessions/revoke', d.mac.cookie, { id: d.iphone.publicId }, NOW + 3 * MIN, { origin: 'https://evil.example' })).status).toBe(403);
    expect(db.rows('sessions').filter((r) => r.revoked_at != null)).toEqual([]);
    expect((await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/sessions/revoke`), paywallEnv(db), 'sessions/revoke'), deps())).status).toBe(405);
  });

  it('a revoked session can’t revoke others', async () => {
    const db = new MemD1();
    const d = await fourDevices(db);
    await d.fourth();
    expect((await postAs(db, 'sessions/revoke-others', d.iphone.cookie, {}, NOW + 4 * MIN)).status).toBe(401);
    expect(db.rows('sessions').filter((r) => r.revoked_at != null)).toHaveLength(1);
  });

  it('revoke-others: every other live session of the user, reason remote; this one and other users stay', async () => {
    const db = new MemD1();
    const d = await fourDevices(db);
    const stranger = await signIn(db, 'stranger@example.com');
    const res = await postAs(db, 'sessions/revoke-others', d.windows.cookie, {}, NOW + 3 * MIN);
    expect(res.status).toBe(200);
    expect((await json(res)).devices).toEqual({ max: 3, list: [expect.objectContaining({ id: d.windows.publicId, current: true })] });
    for (const s of [d.iphone, d.mac]) expect(db.rows('sessions').find((r) => r.public_id === s.publicId)).toMatchObject({ revoked_reason: 'remote' });
    expect(await who(db, d.windows.cookie, NOW + 4 * MIN)).toBe('sailor@example.com');
    expect(await who(db, stranger.cookie, NOW + 4 * MIN)).toBe('stranger@example.com');
  });

  it('own sign-out still deletes the row', async () => {
    const db = new MemD1();
    const a = await signIn(db, 'bye@example.com');
    const b = await signIn(db, 'bye@example.com', NOW + MIN);
    expect((await postAs(db, 'logout', a.cookie)).status).toBe(200);
    expect(db.rows('sessions').map((r) => r.public_id)).toEqual([b.publicId]);
  });

  it('flag off: the device routes are the proxy’s 404 and touch nothing', async () => {
    const db = new MemD1();
    for (const path of ['sessions/revoke', 'sessions/revoke-others']) {
      const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/${path}`, { method: 'POST', body: '{}', headers: { origin: ORIGIN } }), paywallEnv(db, { PAYWALL_ENABLED: undefined }), path), deps());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Unknown endpoint' });
    }
    expect(db.log).toEqual([]);
  });
});

describe('sign-in method', () => {
  it('the magic link records email, Google records google', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    const m: string[] = [];
    const d: AuthDeps = { ...deps(), log: (l) => m.push(l), limits: null, fetch: (async () => Response.json({ success: true, hostname: 'recall.walkeforward.com' })) as unknown as typeof fetch };
    await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/email`, { method: 'POST', body: JSON.stringify({ email: 'm@example.com', turnstileToken: 't' }), headers: { 'content-type': 'application/json', origin: ORIGIN } }), env, 'email'), d);
    const token = /token=([A-Za-z0-9_-]{43})/.exec(m[0])![1];
    const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/verify`, { method: 'POST', body: new URLSearchParams({ token }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'user-agent': UA.iphone } }), env, 'verify'), d);
    expect(res.status).toBe(303);
    expect(db.rows('sessions')[0]).toMatchObject({ method: 'email', user_agent: UA.iphone, last_seen_at: NOW });
  });
});
