#!/usr/bin/env node
/**
 * Signed-in devices (admin only): list a user's sessions, set their device cap, or sign sessions out,
 * in the paywall's D1 database (README "Admin: signed-in devices"). There is deliberately no API or UI
 * for the cap override: this script is the only way to change it. No dependencies; the SQL runs
 * through `npx wrangler d1 execute <db> --remote|--local --command …`, or is printed with --print.
 *
 *   node scripts/sessions.mjs list --email a@example.com
 *   node scripts/sessions.mjs set-cap --email a@example.com 5        (1 to 20)
 *   node scripts/sessions.mjs set-cap --email a@example.com default  (back to 3)
 *   node scripts/sessions.mjs revoke --email a@example.com [--id <public id>]
 *   common: --db recall-auth (default) · --remote (default) | --local · --print (show the SQL, run nothing)
 *
 * The cap is users.max_sessions (NULL: the default, 3; the server clamps it to 1..20). A lower cap
 * takes effect at the user's next sign-in, which signs out the least recently used devices beyond
 * it. `revoke` signs out one live session (by the public id `list` shows) or all of them, with the
 * reason 'admin': the device is told "You were signed out. Sign in again to keep going." Token
 * hashes are never shown. Needs migrations/0002_signin_phase1.sql.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** As functions/_authDb.ts EMAIL_RE and PUBLIC_ID_RE (tests/sessionsScript.test.ts keeps them equal). */
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const PUBLIC_ID_RE = /^[0-9a-f]{24}$/;
export const DB_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const DEFAULT_DB = 'recall-auth';
export const MIN_CAP = 1;
export const MAX_CAP = 20;

const USAGE = `Usage:
  node scripts/sessions.mjs list --email <email>
  node scripts/sessions.mjs set-cap --email <email> <1-${MAX_CAP}>|default
  node scripts/sessions.mjs revoke --email <email> [--id <public id>]
list: the user's device cap and sessions (public id, method, device, created, last used, expires, revoked and why).
set-cap: the most devices signed in at once for this user (default: 3); applies from their next sign-in.
revoke: sign out one session (--id, from list) or every live one, with the reason 'admin'.
Options: --db <name> (default ${DEFAULT_DB}), --remote (default) or --local, --print (show the SQL only)`;

export const normEmail = (e) => e.trim().toLowerCase();

/** A checked email (lower-cased, trimmed), else an error. */
export function checkEmail(raw) {
  const e = normEmail(String(raw ?? ''));
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new Error(`Not an email address: ${JSON.stringify(raw)}`);
  return e;
}

/** `default` (null: the server's default) or a whole number from 1 to 20. */
export function checkCap(raw) {
  const s = String(raw ?? '');
  if (s === 'default') return null;
  if (!/^\d{1,2}$/.test(s) || Number(s) < MIN_CAP || Number(s) > MAX_CAP) throw new Error(`The cap is a whole number from ${MIN_CAP} to ${MAX_CAP}, or default, not ${JSON.stringify(raw)}`);
  return Number(s);
}

/** A SQL string literal (single quotes doubled); control characters are refused, not escaped. */
export function sqlString(s) {
  const v = String(s);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error('Control characters are not allowed');
  return `'${v.replace(/'/g, "''")}'`;
}
const sqlInt = (n) => {
  if (!Number.isSafeInteger(n)) throw new Error(`Not an integer: ${n}`);
  return String(n);
};

const userOf = (email) => `(SELECT id FROM users WHERE email = ${sqlString(checkEmail(email))})`;

/** The user's cap, then their sessions, most recently used first (no token hashes). */
export function listSql({ email }) {
  const em = sqlString(checkEmail(email));
  const t = (col) => `datetime(${col} / 1000, 'unixepoch')`;
  return [
    `SELECT email, COALESCE(max_sessions, 'default (3)') AS device_cap FROM users WHERE email = ${em};`,
    `SELECT public_id, method, user_agent, ${t('created_at')} AS created, ${t('COALESCE(last_seen_at, created_at)')} AS last_used, ${t('expires_at')} AS expires, ` +
      `${t('revoked_at')} AS revoked, revoked_reason FROM sessions WHERE user_id IN ${userOf(email)} ORDER BY COALESCE(last_seen_at, created_at) DESC;`,
  ].join('\n');
}

/** Set (or with null, clear) the user's device cap; then show it. */
export function setCapSql({ email, cap }) {
  const em = sqlString(checkEmail(email));
  if (cap !== null && (!Number.isInteger(cap) || cap < MIN_CAP || cap > MAX_CAP)) throw new Error(`Bad cap: ${cap}`);
  return [`UPDATE users SET max_sessions = ${cap === null ? 'NULL' : sqlInt(cap)} WHERE email = ${em};`, `SELECT email, max_sessions FROM users WHERE email = ${em};`].join('\n');
}

/** Sign out the user's live sessions (or the one with this public id), reason 'admin'; the first revocation's time stands. */
export function revokeSql({ email, id = null, now }) {
  if (id != null && !PUBLIC_ID_RE.test(String(id))) throw new Error(`Not a session id: ${JSON.stringify(id)}`);
  const t = sqlInt(now);
  return `UPDATE sessions SET revoked_at = ${t}, revoked_reason = 'admin' WHERE user_id IN ${userOf(email)}${id != null ? ` AND public_id = ${sqlString(id)}` : ''} AND revoked_at IS NULL AND expires_at > ${t};`;
}

const FLAGS_WITH_VALUE = new Set(['--email', '--id', '--db']);
const BARE_FLAGS = new Set(['--remote', '--local', '--print', '--help']);

/** The command line, strictly: unknown, repeated or empty options are errors. */
export function parseArgs(argv) {
  const pos = [];
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = argv[++i];
      if (v == null || v === '' || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a in o) throw new Error(`${a} given twice`);
      o[a] = v;
    } else if (BARE_FLAGS.has(a)) {
      if (a in o) throw new Error(`${a} given twice`);
      o[a] = true;
    } else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
    else pos.push(a);
  }
  if (o['--help']) return { cmd: 'help' };
  if (o['--remote'] && o['--local']) throw new Error('Pick one of --remote and --local');
  const db = o['--db'] ?? DEFAULT_DB;
  if (!DB_RE.test(db)) throw new Error(`Not a database name: ${JSON.stringify(db)}`);
  const common = { db, target: o['--local'] ? 'local' : 'remote', print: !!o['--print'] };
  const [cmd, ...rest] = pos;
  const allow = (...names) => {
    for (const k of Object.keys(o)) if (!['--db', '--remote', '--local', '--print', ...names].includes(k)) throw new Error(`${k} doesn't go with ${cmd}`);
  };
  if (cmd !== 'list' && cmd !== 'set-cap' && cmd !== 'revoke') throw new Error(cmd ? `Unknown command ${cmd}` : 'No command');
  if (o['--email'] == null) throw new Error(`${cmd} needs --email`);
  const email = checkEmail(o['--email']);
  if (cmd === 'set-cap') {
    allow('--email');
    if (rest.length !== 1) throw new Error(rest.length ? `Unexpected ${rest[1]}` : `set-cap needs a number from ${MIN_CAP} to ${MAX_CAP}, or default`);
    return { ...common, cmd, email, cap: checkCap(rest[0]) };
  }
  if (rest.length) throw new Error(`Unexpected ${rest[0]}`);
  if (cmd === 'list') {
    allow('--email');
    return { ...common, cmd, email };
  }
  allow('--email', '--id');
  const id = o['--id'] ?? null;
  if (id != null && !PUBLIC_ID_RE.test(id)) throw new Error(`Not a session id: ${JSON.stringify(id)}`);
  return { ...common, cmd, email, id };
}

/** The SQL for a parsed command. */
export function sqlFor(p, now = Date.now()) {
  if (p.cmd === 'list') return listSql({ email: p.email });
  if (p.cmd === 'set-cap') return setCapSql({ email: p.email, cap: p.cap });
  return revokeSql({ email: p.email, id: p.id, now });
}

/** wrangler's arguments (run without a shell, so nothing here is ever shell-parsed). */
export const wranglerArgs = (p, sql) => ['wrangler', 'd1', 'execute', p.db, p.target === 'local' ? '--local' : '--remote', '--command', sql];

function describe(p) {
  const what =
    p.cmd === 'list'
      ? `List sessions of ${p.email}`
      : p.cmd === 'set-cap'
        ? `Set the device cap of ${p.email} to ${p.cap === null ? 'the default (3)' : p.cap}`
        : p.id
          ? `Sign out session ${p.id} of ${p.email}`
          : `Sign out every live session of ${p.email}`;
  return `${what} on ${p.db} (${p.target})`;
}

function main(argv) {
  let p;
  try {
    p = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (p.cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  const sql = sqlFor(p);
  console.error(describe(p));
  if (p.print) {
    console.log(sql);
    return 0;
  }
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', wranglerArgs(p, sql), { stdio: 'inherit' });
  if (r.error) console.error(`Couldn't run wrangler (${r.error.message}). Use --print and run the SQL yourself.`);
  return r.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
