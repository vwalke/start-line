import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DB, EMAIL_RE as SCRIPT_EMAIL_RE, PUBLIC_ID_RE as SCRIPT_PUBLIC_ID_RE, checkCap, checkEmail, listSql, parseArgs, revokeSql, setCapSql, sqlFor, wranglerArgs } from '../scripts/sessions.mjs';
import { EMAIL_RE, PUBLIC_ID_RE } from '../functions/_authDb';
import { handleAuth } from '../functions/_auth';
import { MemD1 } from './d1mem';
import { NOW, ORIGIN, paywallEnv, signIn } from './paywallHelpers';

const SCRIPT = fileURLToPath(new URL('../scripts/sessions.mjs', import.meta.url));
/** The script itself, run as the admin would (only ever with --print or --help here: nothing reaches wrangler). */
const cli = (...argv: string[]): { status: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
/** Run the script's SQL as wrangler would, one statement per line (the in-memory engine takes them without the `;`). */
async function run(db: MemD1, sql: string): Promise<void> {
  for (const stmt of sql.split('\n')) await db.prepare(stmt.replace(/;$/, '')).run();
}
const cmd = (db: MemD1, argv: string[], at = NOW): Promise<void> => {
  const p = parseArgs(argv);
  if (p.cmd === 'help') throw new Error('help');
  return run(db, sqlFor(p, at));
};

describe('scripts/sessions.mjs: arguments and SQL', () => {
  it('validates as the server does', () => {
    expect(SCRIPT_EMAIL_RE.source).toBe(EMAIL_RE.source);
    expect(SCRIPT_PUBLIC_ID_RE.source).toBe(PUBLIC_ID_RE.source);
    expect(checkEmail(' Bob@Example.COM ')).toBe('bob@example.com');
    expect([checkCap('1'), checkCap('5'), checkCap('20'), checkCap('default')]).toEqual([1, 5, 20, null]);
    for (const bad of ['0', '21', '-1', '2.5', '05x', '', 'DEFAULT', '100']) expect(() => checkCap(bad), bad).toThrow();
  });

  it('parses list, set-cap and revoke strictly', () => {
    expect(parseArgs(['list', '--email', 'A@Example.com'])).toEqual({ cmd: 'list', email: 'a@example.com', db: DEFAULT_DB, target: 'remote', print: false });
    expect(parseArgs(['set-cap', '--email', 'a@example.com', '5', '--local', '--db', 'recall-auth-dev', '--print'])).toEqual({ cmd: 'set-cap', email: 'a@example.com', cap: 5, db: 'recall-auth-dev', target: 'local', print: true });
    expect(parseArgs(['set-cap', 'default', '--email', 'a@example.com'])).toMatchObject({ cmd: 'set-cap', cap: null });
    expect(parseArgs(['revoke', '--email', 'a@example.com'])).toMatchObject({ cmd: 'revoke', id: null });
    expect(parseArgs(['revoke', '--email', 'a@example.com', '--id', 'a'.repeat(24)])).toMatchObject({ cmd: 'revoke', id: 'a'.repeat(24) });
    expect(parseArgs(['--help'])).toEqual({ cmd: 'help' });
    const bad: string[][] = [
      [],
      ['grant', '--email', 'a@example.com'],
      ['list'],
      ['list', '--email', 'nope'],
      ['list', '--email', 'a@example.com', 'extra'],
      ['list', '--email', 'a@example.com', '--id', 'a'.repeat(24)],
      ['set-cap', '--email', 'a@example.com'],
      ['set-cap', '--email', 'a@example.com', '0'],
      ['set-cap', '--email', 'a@example.com', '21'],
      ['set-cap', '--email', 'a@example.com', '3', '4'],
      ['set-cap', '--email', 'a@example.com', "3; DROP TABLE users"],
      ['revoke', '--email', 'a@example.com', '--id', 'xyz'],
      ['revoke', '--email', 'a@example.com', '--id', "'; DELETE FROM sessions; --"],
      ['revoke', '--email', 'a@example.com', '--email', 'b@example.com'],
      ['revoke', '--email', 'a@example.com', '--remote', '--local'],
      ['revoke', '--email', 'a@example.com', '--db', 'x; rm -rf /'],
      ['revoke', '--email', 'a@example.com', '--force'],
      ['revoke', '--email'],
    ];
    for (const argv of bad) expect(() => parseArgs(argv), argv.join(' ')).toThrow();
  });

  it('builds quoted SQL with no token hashes, and wrangler arguments with no shell', () => {
    const list = listSql({ email: "o'brien@example.com" });
    expect(list).toContain("email = 'o''brien@example.com'");
    expect(list).toMatch(/public_id, method, user_agent/);
    expect(list).toContain('revoked_reason');
    expect(list).not.toContain('token_hash');
    expect(setCapSql({ email: 'a@example.com', cap: null })).toMatch(/^UPDATE users SET max_sessions = NULL WHERE email = 'a@example.com';/);
    expect(setCapSql({ email: 'a@example.com', cap: 7 })).toMatch(/max_sessions = 7 /);
    expect(() => setCapSql({ email: 'a@example.com', cap: 0 })).toThrow();
    expect(revokeSql({ email: 'a@example.com', now: NOW })).toBe(
      `UPDATE sessions SET revoked_at = ${NOW}, revoked_reason = 'admin' WHERE user_id IN (SELECT id FROM users WHERE email = 'a@example.com') AND revoked_at IS NULL AND expires_at > ${NOW};`,
    );
    expect(() => revokeSql({ email: 'a@example.com', id: 'nope', now: NOW })).toThrow();
    expect(wranglerArgs({ db: 'recall-auth', target: 'remote' }, 'SELECT 1;')).toEqual(['wrangler', 'd1', 'execute', 'recall-auth', '--remote', '--command', 'SELECT 1;']);
    expect(wranglerArgs({ db: 'recall-auth', target: 'local' }, 'SELECT 1;')[4]).toBe('--local');
  });
});

describe('scripts/sessions.mjs on the database', () => {
  it('set-cap changes the cap the next sign-in uses; default puts it back', async () => {
    const db = new MemD1();
    await signIn(db, 'crew@example.com');
    await cmd(db, ['set-cap', '--email', 'crew@example.com', '1']);
    expect(db.rows('users')[0].max_sessions).toBe(1);
    const second = await signIn(db, 'crew@example.com', NOW + 1000);
    expect(second.bumped).toHaveLength(1);
    await cmd(db, ['set-cap', '--email', 'crew@example.com', 'default']);
    expect(db.rows('users')[0].max_sessions).toBeNull();
    // Nobody else's cap moves; an unknown address changes nothing.
    await cmd(db, ['set-cap', '--email', 'nobody@example.com', '4']);
    expect(db.rows('users').map((u) => u.max_sessions)).toEqual([null]);
  });

  it('revoke signs out one session by public id, or every live one, with the reason admin', async () => {
    const db = new MemD1();
    const a = await signIn(db, 'a@example.com');
    const b = await signIn(db, 'a@example.com', NOW + 1000);
    const other = await signIn(db, 'other@example.com');
    await cmd(db, ['revoke', '--email', 'a@example.com', '--id', a.publicId], NOW + 2000);
    expect(db.rows('sessions').filter((r) => r.revoked_at != null).map((r) => [r.public_id, r.revoked_reason])).toEqual([[a.publicId, 'admin']]);
    // Someone else's session id with this address: nothing.
    await cmd(db, ['revoke', '--email', 'a@example.com', '--id', other.publicId], NOW + 3000);
    expect(db.rows('sessions').find((r) => r.public_id === other.publicId)!.revoked_at).toBeNull();
    await cmd(db, ['revoke', '--email', 'a@example.com'], NOW + 4000);
    expect(db.rows('sessions').filter((r) => r.revoked_at != null).map((r) => r.public_id).sort()).toEqual([a.publicId, b.publicId].sort());
    // The first revocation's time stands.
    expect(db.rows('sessions').find((r) => r.public_id === a.publicId)!.revoked_at).toBe(NOW + 2000);
    // The device is told: signed out by the admin.
    const me = await handleAuth({ request: new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie: b.cookie } }), env: paywallEnv(db), params: { path: ['me'] } }, { now: () => NOW + 5000 });
    expect(((await me.json()) as Record<string, unknown>).signedOutReason).toBe('admin');
  });

  it('the command line: --print shows the SQL and runs nothing; bad input exits 2 with the usage', () => {
    const p = cli('revoke', '--email', 'a@example.com', '--print');
    expect(p.status).toBe(0);
    expect(p.out).toMatch(/^UPDATE sessions SET revoked_at = \d+, revoked_reason = 'admin' WHERE user_id IN \(SELECT id FROM users WHERE email = 'a@example.com'\)/);
    expect(p.err).toContain('Sign out every live session of a@example.com on recall-auth (remote)');
    const cap = cli('set-cap', '--email', 'a@example.com', 'default', '--print', '--local');
    expect(cap.err).toContain('Set the device cap of a@example.com to the default (3) on recall-auth (local)');
    const help = cli('--help');
    expect(help.status).toBe(0);
    expect(help.out).toContain('set-cap --email <email> <1-20>|default');
    const bad = cli('set-cap', '--email', 'a@example.com', '50');
    expect(bad.status).toBe(2);
    expect(bad.err).toContain('Usage:');
  });
});
