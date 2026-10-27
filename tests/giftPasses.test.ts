import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMAIL_RE as SCRIPT_EMAIL_RE, EVENT_ID_RE as SCRIPT_EVENT_ID_RE, checkEmail, expiryMs, giftId, grantSql, listSql, parseArgs, revokeSql, sqlFor, sqlString, wranglerArgs } from '../scripts/grant-gift.mjs';
import { EMAIL_RE, entitlementsOf, userByEmail } from '../functions/_authDb';
import { allowed, passViews, type PassView } from '../functions/_entitlements';
import { handleAuth, type AuthCtx } from '../functions/_auth';
import type { PaywallEnv } from '../functions/_paywall';
import { EVENT_ID_RE } from '../src/data/vkx/validate';
import { passLine, sheetHtml } from '../src/ui/paywall';
import { MemD1 } from './d1mem';
import { EVENT, FREE_PASS_VIEWS, NOW, ORIGIN, TURNSTILE_TOKEN, mailbox, paywallEnv, resetPaywallCaches, signIn, tokenOf } from './paywallHelpers';

const DAY = 86_400_000;
const OTHER_EVENT = 'someOtherEvent1';
const SCRIPT = fileURLToPath(new URL('../scripts/grant-gift.mjs', import.meta.url));
/** The script itself, run as an admin would (only ever with --print or --help here: nothing reaches wrangler). */
const cli = (...argv: string[]): { status: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const ctx = (request: Request, env: PaywallEnv, path: string): AuthCtx => ({ request, env, params: { path: path.split('/') } });
const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;

/** Run the script's SQL as wrangler would: one statement per line (the in-memory engine takes them without the `;`). */
async function run(db: MemD1, sql: string): Promise<void> {
  for (const stmt of sql.split('\n')) await db.prepare(stmt.replace(/;$/, '')).run();
}
const grantCmd = (db: MemD1, argv: string[], at = NOW): Promise<void> => {
  const p = parseArgs(argv, at);
  if (p.cmd === 'help') throw new Error('help');
  return run(db, sqlFor(p, at));
};

/** A magic-link sign-in, end to end (the link proves the address): the session cookie. */
async function magicLink(db: MemD1, typed: string, at = NOW): Promise<string> {
  const env = paywallEnv(db);
  const m = mailbox(at);
  const req = new Request(`${ORIGIN}/api/auth/email`, { method: 'POST', body: JSON.stringify({ email: typed, returnTo: '/', turnstileToken: TURNSTILE_TOKEN }), headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' } });
  expect((await handleAuth(ctx(req, env, 'email'), m)).status).toBe(200);
  const token = tokenOf(m.links()[0]);
  const confirm = new Request(`${ORIGIN}/api/auth/verify`, { method: 'POST', body: new URLSearchParams({ token }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } });
  const res = await handleAuth(ctx(confirm, env, 'verify'), m);
  expect(res.status).toBe(303);
  return res.headers.get('set-cookie')!.split(';')[0];
}

/** /api/auth/me's passes for a cookie, less the free regattas' (checked here, listed for anyone signed in). */
async function passes(db: MemD1, cookie: string, at = NOW): Promise<PassView[]> {
  const res = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie } }), paywallEnv(db), 'me'), { now: () => at });
  const all = (await json(res)).entitlements as PassView[];
  // Signed out: nothing at all.
  const n = all.length ? FREE_PASS_VIEWS.length : 0;
  expect(all.slice(all.length - n)).toEqual(FREE_PASS_VIEWS.slice(0, n));
  return all.slice(0, all.length - n);
}

const opens = async (db: MemD1, email: string, eventId: string, at = NOW): Promise<boolean> => {
  const u = await userByEmail(db, email);
  return !!u && allowed(await entitlementsOf(db, u.id), u.id, { eventId, free: false, now: at });
};

beforeEach(resetPaywallCaches);

describe('scripts/grant-gift.mjs: arguments and SQL', () => {
  it('validates as the server does (same email and event id patterns)', () => {
    expect(SCRIPT_EMAIL_RE.source).toBe(EMAIL_RE.source);
    expect(SCRIPT_EVENT_ID_RE.source).toBe(EVENT_ID_RE.source);
    expect(checkEmail('  Bob@Example.COM ')).toBe('bob@example.com');
    for (const bad of ['', 'bob', 'bob@', 'a b@example.com', 'bob@example', "x'@example.com; DROP TABLE users", 'a\n@b.com', `${'a'.repeat(250)}@example.com`]) expect(() => checkEmail(bad), bad).toThrow();
  });

  it('parses grant, revoke and list strictly', () => {
    expect(parseArgs(['grant', 'season', '--email', 'Bob@Example.com'], NOW)).toMatchObject({ cmd: 'grant', scope: 'season', email: 'bob@example.com', eventId: null, expiresAt: null, db: 'recall-auth', target: 'remote', print: false });
    expect(parseArgs(['grant', 'regatta', '--event', EVENT, '--email', 'a@example.com', '--expires', '2026-12-31', '--note', 'race\ncommittee', '--local', '--db', 'recall-auth-dev', '--print'], NOW)).toMatchObject({
      cmd: 'grant',
      scope: 'regatta',
      eventId: EVENT,
      expiresAt: Date.UTC(2027, 0, 1),
      note: 'race committee',
      target: 'local',
      db: 'recall-auth-dev',
      print: true,
    });
    expect(parseArgs(['revoke', 'season', '--email', 'a@example.com'], NOW)).toMatchObject({ cmd: 'revoke', id: giftId('a@example.com', 'season', null) });
    expect(parseArgs(['revoke', '--id', giftId('a@example.com', 'season', null)], NOW)).toMatchObject({ cmd: 'revoke', id: giftId('a@example.com', 'season', null) });
    expect(parseArgs(['list'], NOW)).toMatchObject({ cmd: 'list', email: null });
    expect(parseArgs(['--help'], NOW)).toEqual({ cmd: 'help' });
    const bad: string[][] = [
      [],
      ['give', 'season', '--email', 'a@example.com'],
      ['grant', '--email', 'a@example.com'],
      ['grant', 'coach', '--email', 'a@example.com'],
      ['grant', 'season'],
      ['grant', 'season', '--email'],
      ['grant', 'season', '--email', 'a@example.com', '--email', 'b@example.com'],
      ['grant', 'season', '--email', 'a@example.com', '--event', EVENT],
      ['grant', 'regatta', '--email', 'a@example.com'],
      ['grant', 'regatta', '--event', '../x', '--email', 'a@example.com'],
      ['grant', 'regatta', '--event', "abc'; --", '--email', 'a@example.com'],
      ['grant', 'season', '--email', 'a@example.com', '--expires', '2026-02-30'],
      ['grant', 'season', '--email', 'a@example.com', '--expires', '31/12/2026'],
      ['grant', 'season', '--email', 'a@example.com', '--expires', '2026-10-21'],
      ['grant', 'season', '--email', 'a@example.com', '--remote', '--local'],
      ['grant', 'season', '--email', 'a@example.com', '--db', 'x; rm -rf /'],
      ['grant', 'season', '--email', 'a@example.com', '--id', 'gift_0'],
      ['grant', 'season', '--email', 'a@example.com', '--force'],
      ['grant', 'season', 'extra', '--email', 'a@example.com'],
      ['revoke', '--id', 'gift_nothex'],
      ['revoke', 'season', '--id', giftId('a@example.com', 'season', null)],
      ['revoke', 'season', '--email', 'a@example.com', '--expires', '2027-01-01'],
      ['list', 'season'],
      ['list', '--note', 'x'],
    ];
    for (const argv of bad) expect(() => parseArgs(argv, NOW), argv.join(' ')).toThrow();
  });

  it('`all` is the all-regattas pass (stored as scope season): the same gift, the same id', () => {
    const viaAll = parseArgs(['grant', 'all', '--email', 'a@example.com', '--expires', '2027-10-22'], NOW);
    const viaSeason = parseArgs(['grant', 'season', '--email', 'a@example.com', '--expires', '2027-10-22'], NOW);
    expect(viaAll).toEqual(viaSeason);
    expect(viaAll).toMatchObject({ cmd: 'grant', scope: 'season', eventId: null, expiresAt: Date.UTC(2027, 9, 23), id: giftId('a@example.com', 'season', null) });
    expect(parseArgs(['revoke', 'all', '--email', 'a@example.com'], NOW)).toMatchObject({ cmd: 'revoke', id: giftId('a@example.com', 'season', null) });
    for (const argv of [['grant', 'all', '--email', 'a@example.com', '--event', EVENT], ['grant', 'ALL', '--email', 'a@example.com'], ['grant', 'every', '--email', 'a@example.com'], ['grant', 'toString', '--email', 'a@example.com']]) {
      expect(() => parseArgs(argv, NOW), argv.join(' ')).toThrow();
    }
  });

  it('the SQL of a 1-year all-regattas gift and of a per-regatta gift', () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const year = parseArgs(['grant', 'all', '--email', 'Crew@Example.com', '--expires', '2027-10-22'], NOW);
    const yid = giftId('crew@example.com', 'season', null);
    expect(sqlFor(year as Exclude<typeof year, { cmd: 'help' }>, NOW, userId).split('\n')).toEqual([
      `INSERT OR IGNORE INTO users (id, email, created_at) VALUES ('${userId}', 'crew@example.com', ${NOW});`,
      `INSERT OR IGNORE INTO purchases (id, user_id, provider, provider_ref, product, amount, currency, status, email, created_at) SELECT '${yid}', id, 'gift', 'gift:${yid.slice(5)}', 'season', 0, NULL, 'gift', 'crew@example.com', ${NOW} FROM users WHERE email = 'crew@example.com';`,
      `INSERT OR IGNORE INTO entitlements (id, user_id, scope, event_id, starts_at, expires_at, purchase_id) SELECT '${yid}', user_id, 'season', NULL, ${NOW}, ${Date.UTC(2027, 9, 23)}, id FROM purchases WHERE id = '${yid}';`,
      `UPDATE entitlements SET expires_at = ${Date.UTC(2027, 9, 23)}, revoked_at = NULL WHERE id = '${yid}';`,
    ]);
    const one = parseArgs(['grant', 'regatta', '--event', EVENT, '--email', 'crew@example.com'], NOW);
    const rid = giftId('crew@example.com', 'regatta', EVENT);
    expect(sqlFor(one as Exclude<typeof one, { cmd: 'help' }>, NOW, userId).split('\n')).toEqual([
      `INSERT OR IGNORE INTO users (id, email, created_at) VALUES ('${userId}', 'crew@example.com', ${NOW});`,
      `INSERT OR IGNORE INTO purchases (id, user_id, provider, provider_ref, product, amount, currency, status, email, created_at) SELECT '${rid}', id, 'gift', 'gift:${rid.slice(5)}', 'regatta', 0, NULL, 'gift', 'crew@example.com', ${NOW} FROM users WHERE email = 'crew@example.com';`,
      `INSERT OR IGNORE INTO entitlements (id, user_id, scope, event_id, starts_at, expires_at, purchase_id) SELECT '${rid}', user_id, 'regatta', '${EVENT}', ${NOW}, NULL, id FROM purchases WHERE id = '${rid}';`,
      `UPDATE entitlements SET expires_at = NULL, revoked_at = NULL WHERE id = '${rid}';`,
    ]);
    expect(rid).not.toBe(yid);
  });

  it('the command line: help calls it an all-regattas pass; --print shows the SQL and runs nothing', () => {
    const help = cli('--help');
    expect(help.status).toBe(0);
    expect(help.out).toContain('grant all --email <email> [--expires YYYY-MM-DD]');
    expect(help.out).toContain('grant regatta --event <event id> --email <email>');
    expect(help.out).toMatch(/all \(or season\): an all-regattas pass/);
    expect(help.out).not.toMatch(/Season Pass/);
    const year = cli('grant', 'all', '--email', 'crew@example.com', '--expires', '2099-10-22', '--print');
    expect(year.status).toBe(0);
    expect(year.err).toContain('Grant an all-regattas pass to crew@example.com, through 2099-10-22 (UTC)');
    expect(year.out).toContain(`'season', NULL,`);
    expect(year.out).toContain(`${Date.UTC(2099, 9, 23)}`);
    const one = cli('grant', 'regatta', '--event', EVENT, '--email', 'crew@example.com', '--print');
    expect(one.status).toBe(0);
    expect(one.err).toContain(`Grant a Regatta Pass for event ${EVENT} to crew@example.com, no expiry`);
    expect(one.out).toContain(`'regatta', '${EVENT}',`);
    const revoke = cli('revoke', 'all', '--email', 'crew@example.com', '--print');
    expect(revoke.err).toContain('Revoke an all-regattas pass of crew@example.com');
    expect(revoke.out.trim()).toMatch(new RegExp(`^UPDATE entitlements SET revoked_at = \\d+ WHERE id = '${giftId('crew@example.com', 'season', null)}' AND revoked_at IS NULL;$`));
    const list = cli('list', '--print');
    expect(list.status).toBe(0);
    expect(list.out).toContain("WHERE p.provider = 'gift'");
    expect(cli('grant', 'all', '--email', 'crew@example.com', '--event', EVENT, '--print')).toMatchObject({ status: 2 });
  });

  it('builds safe SQL: quotes doubled, control characters refused, ids derived (same gift, same id)', () => {
    expect(sqlString("o'brien@example.com")).toBe("'o''brien@example.com'");
    expect(() => sqlString('a\nb')).toThrow();
    expect(giftId('a@example.com', 'season', null)).toBe(giftId('a@example.com', 'season', null));
    expect(new Set([giftId('a@example.com', 'season', null), giftId('b@example.com', 'season', null), giftId('a@example.com', 'regatta', EVENT), giftId('a@example.com', 'regatta', OTHER_EVENT)]).size).toBe(4);
    const sql = grantSql({ email: "O'Brien@Example.com", scope: 'regatta', eventId: EVENT, expiresAt: expiryMs('2027-01-31', NOW), now: NOW, userId: '00000000-0000-4000-8000-000000000001' });
    expect(sql.split('\n')).toHaveLength(4);
    expect(sql).toContain("'o''brien@example.com'");
    expect(sql).toContain(`'gift:${giftId("o'brien@example.com", 'regatta', EVENT).slice(5)}'`);
    expect(sql).not.toMatch(/O'Brien/);
    expect(revokeSql({ id: giftId('a@example.com', 'season', null), now: NOW })).toBe(`UPDATE entitlements SET revoked_at = ${NOW} WHERE id = '${giftId('a@example.com', 'season', null)}' AND revoked_at IS NULL;`);
    expect(() => revokeSql({ id: "gift_x' OR 1=1 --", now: NOW })).toThrow();
    expect(listSql({ email: "O'Brien@example.com" })).toContain("p.provider = 'gift' AND p.email = 'o''brien@example.com'");
    expect(wranglerArgs({ db: 'recall-auth', target: 'remote' }, 'SELECT 1;')).toEqual(['wrangler', 'd1', 'execute', 'recall-auth', '--remote', '--command', 'SELECT 1;']);
    expect(wranglerArgs({ db: 'recall-auth', target: 'local' }, 'SELECT 1;')[4]).toBe('--local');
  });

  it('touches only the tables of migrations/0001_paywall.sql (no new table, no migration)', async () => {
    const db = new MemD1();
    await grantCmd(db, ['grant', 'season', '--email', 'a@example.com']);
    expect(db.log.every((s) => /\b(users|purchases|entitlements)\b/.test(s))).toBe(true);
    expect(db.rows('purchases')).toEqual([
      expect.objectContaining({ id: giftId('a@example.com', 'season', null), provider: 'gift', provider_ref: `gift:${giftId('a@example.com', 'season', null).slice(5)}`, product: 'season', amount: 0, status: 'gift', email: 'a@example.com' }),
    ]);
  });
});

describe('gift passes, end to end', () => {
  it('a season gift unlocks once its address signs in by magic link (any case), and only that address', async () => {
    const db = new MemD1();
    await grantCmd(db, ['grant', 'season', '--email', 'Gifted@Example.com']);
    const cookie = await magicLink(db, 'GIFTED@example.COM');
    expect(await passes(db, cookie)).toEqual([{ scope: 'season', eventId: null, startsAt: NOW, expiresAt: null, seats: null, owner: true, gift: true }]);
    expect(await opens(db, 'gifted@example.com', EVENT)).toBe(true);
    const other = await magicLink(db, 'gifted@example.org');
    expect(await passes(db, other)).toEqual([]);
    const near = await magicLink(db, 'gifted+1@example.com');
    expect(await passes(db, near)).toEqual([]);
  });

  it('Google: linked only with a verified email', async () => {
    const db = new MemD1();
    await grantCmd(db, ['grant', 'season', '--email', 'skipper@example.com']);
    const env = paywallEnv(db);
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const google = async (verified: boolean): Promise<Response> => {
      const start = await handleAuth(ctx(new Request(`${ORIGIN}/api/auth/google/start`), env, 'google/start'), mailbox());
      const loc = new URL(start.headers.get('location')!);
      const cookie = start.headers.get('set-cookie')!.split(';')[0];
      const claims = { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, exp: NOW / 1000 + 600, sub: 'g-gift', email: 'Skipper@Example.com', email_verified: verified, nonce: loc.searchParams.get('nonce') };
      const tokenEndpoint = (async () => new Response(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc(claims)}.sig` }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
      return handleAuth(ctx(new Request(`${ORIGIN}/api/auth/google/callback?code=c&state=${loc.searchParams.get('state')}`, { headers: { cookie } }), env, 'google/callback'), { ...mailbox(), fetch: tokenEndpoint });
    };
    const refused = await google(false);
    expect(refused.headers.get('location')).toBe('/regattas?signin=failed&via=google');
    expect(db.rows('sessions')).toEqual([]);
    const ok = await google(true);
    const session = ok.headers.get('set-cookie')!.split(';')[0];
    expect((await passes(db, session)).map((p) => [p.scope, p.gift])).toEqual([['season', true]]);
  });

  it('is idempotent: granting twice, signing in twice, never duplicates', async () => {
    const db = new MemD1();
    await grantCmd(db, ['grant', 'regatta', '--event', EVENT, '--email', 'a@example.com']);
    await grantCmd(db, ['grant', 'regatta', '--event', EVENT, '--email', ' A@example.com '], NOW + 1000);
    await magicLink(db, 'a@example.com');
    const cookie = await magicLink(db, 'a@example.com', NOW + 2000);
    expect(db.rows('users')).toHaveLength(1);
    expect(db.rows('purchases')).toHaveLength(1);
    expect(db.rows('entitlements')).toHaveLength(1);
    expect(db.rows('entitlements')[0].starts_at).toBe(NOW);
    expect(await passes(db, cookie, NOW + 3000)).toHaveLength(1);
  });

  it('an existing, signed-in user gets it on their next request (no sign-out needed)', async () => {
    const db = new MemD1();
    const { user, cookie } = await signIn(db, 'member@example.com');
    expect(await passes(db, cookie)).toEqual([]);
    await grantCmd(db, ['grant', 'season', '--email', 'Member@Example.com']);
    expect(db.rows('users')).toEqual([expect.objectContaining({ id: user.id })]);
    expect((await passes(db, cookie)).map((p) => p.scope)).toEqual(['season']);
  });

  it('a regatta gift unlocks that event only', async () => {
    const db = new MemD1();
    await grantCmd(db, ['grant', 'regatta', '--event', EVENT, '--email', 'a@example.com']);
    expect(await opens(db, 'a@example.com', EVENT)).toBe(true);
    expect(await opens(db, 'a@example.com', OTHER_EVENT)).toBe(false);
    expect(await opens(db, 'a@example.com', null as unknown as string)).toBe(false);
  });

  it('a 1-year all-regattas gift (grant all --expires a year out) opens every regatta for that year, then stops', async () => {
    const db = new MemD1();
    await grantCmd(db, ['grant', 'all', '--email', 'crew@example.com', '--expires', '2027-10-22']);
    const cookie = await magicLink(db, 'crew@example.com');
    expect(await passes(db, cookie)).toEqual([{ scope: 'season', eventId: null, startsAt: NOW, expiresAt: Date.UTC(2027, 9, 23), seats: null, owner: true, gift: true }]);
    for (const ev of [EVENT, OTHER_EVENT]) {
      expect(await opens(db, 'crew@example.com', ev)).toBe(true);
      expect(await opens(db, 'crew@example.com', ev, Date.UTC(2027, 9, 23) - 1)).toBe(true);
      expect(await opens(db, 'crew@example.com', ev, Date.UTC(2027, 9, 23))).toBe(false);
    }
    // The page shows it as held (no offer to buy one, no Manage subscription for a gift).
    const [p] = await passes(db, cookie);
    expect(passLine(p, (id) => id)).toMatch(/^All-regattas pass \(gift\) · every regatta · until 2[23] Oct 2027$/); // the local date of the UTC end
    await grantCmd(db, ['revoke', 'all', '--email', 'crew@example.com'], NOW + 1);
    expect(await opens(db, 'crew@example.com', EVENT, NOW + 2)).toBe(false);
  });

  it('a season gift with an expiry runs through that day (UTC), then stops; without one it doesn’t end', async () => {
    const db = new MemD1();
    await grantCmd(db, ['grant', 'season', '--email', 'until@example.com', '--expires', '2026-11-30']);
    await grantCmd(db, ['grant', 'season', '--email', 'always@example.com']);
    const end = Date.UTC(2026, 11, 1);
    expect(await opens(db, 'until@example.com', EVENT, end - 1)).toBe(true);
    expect(await opens(db, 'until@example.com', EVENT, end)).toBe(false);
    expect(await opens(db, 'always@example.com', EVENT, NOW + 3650 * DAY)).toBe(true);
    // Granting again with another expiry moves it.
    await grantCmd(db, ['grant', 'season', '--email', 'until@example.com', '--expires', '2027-01-31']);
    expect(await opens(db, 'until@example.com', EVENT, end + DAY)).toBe(true);
  });

  it('revoke before sign-in: nothing unlocks; after: it stops at once; twice: no-op; granted again: back', async () => {
    const db = new MemD1();
    await grantCmd(db, ['grant', 'season', '--email', 'before@example.com']);
    await grantCmd(db, ['revoke', 'season', '--email', 'before@example.com'], NOW + 1);
    const c1 = await magicLink(db, 'before@example.com', NOW + 2);
    expect(await passes(db, c1, NOW + 3)).toEqual([]);

    await grantCmd(db, ['grant', 'regatta', '--event', EVENT, '--email', 'after@example.com']);
    const c2 = await magicLink(db, 'after@example.com');
    expect(await passes(db, c2)).toHaveLength(1);
    await grantCmd(db, ['revoke', '--id', giftId('after@example.com', 'regatta', EVENT)], NOW + 10);
    expect(await passes(db, c2, NOW + 11)).toEqual([]);
    expect(await opens(db, 'after@example.com', EVENT, NOW + 11)).toBe(false);
    await grantCmd(db, ['revoke', 'regatta', '--event', EVENT, '--email', 'after@example.com'], NOW + 20);
    expect(db.rows('entitlements').find((e) => e.id === giftId('after@example.com', 'regatta', EVENT))!.revoked_at).toBe(NOW + 10);
    await grantCmd(db, ['grant', 'regatta', '--event', EVENT, '--email', 'after@example.com'], NOW + 30);
    expect(await passes(db, c2, NOW + 31)).toHaveLength(1);
  });

  it('shows as a gift on the page, with no "Manage subscription"', () => {
    const [p] = passViews([{ id: 'gift_x', userId: 'u', scope: 'season', eventId: null, startsAt: NOW - 1, expiresAt: null, seats: null, revokedAt: null, gift: true }], 'u', NOW);
    expect(passLine(p, (id) => id)).toBe('All-regattas pass (gift) · every regatta');
    const me = { paywall: true as const, user: { email: 'a@example.com' }, entitlements: [p], signIn: { email: true, google: false } };
    expect(sheetHtml(me, { mode: 'account' }, (id) => id)).not.toContain('Manage subscription');
    const bought = { ...p, gift: undefined };
    expect(sheetHtml({ ...me, entitlements: [bought] }, { mode: 'account' }, (id) => id)).toContain('Manage subscription');
  });
});
