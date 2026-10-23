#!/usr/bin/env node
/**
 * Gift passes (admin only): a free Season Pass, or a Regatta Pass for one event id, locked to an email
 * address, in the paywall's D1 database (README "Admin: gift passes"). No dependencies; the SQL runs
 * through `npx wrangler d1 execute <db> --remote|--local --command …`, or is printed with --print.
 *
 *   node scripts/grant-gift.mjs grant season --email a@example.com [--expires 2027-10-31] [--note "…"]
 *   node scripts/grant-gift.mjs grant regatta --event <event id> --email a@example.com [--expires …]
 *   node scripts/grant-gift.mjs revoke season --email a@example.com
 *   node scripts/grant-gift.mjs revoke regatta --event <event id> --email a@example.com
 *   node scripts/grant-gift.mjs revoke --id gift_…
 *   node scripts/grant-gift.mjs list [--email a@example.com]
 *   common: --db recall-auth (default) · --remote (default) | --local · --print (show the SQL, run nothing)
 *
 * A gift is a purchases row (provider 'gift', provider_ref 'gift:<key>', amount 0) and its entitlement,
 * both with the id `gift_<key>`, where <key> comes from the email, the scope and the event id: granting
 * the same gift again changes nothing but its expiry (and lifts a revocation); revoking twice is a
 * no-op. They belong to the user with that email, created if new (as a Stripe webhook does), so they
 * unlock nothing until someone signs in as that address: a magic link proves it, Google only with a
 * verified email. Migration-free: only the tables of migrations/0001_paywall.sql. The note is shown
 * here only (no column for it).
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** As functions/_authDb.ts EMAIL_RE and src/data/vkx/validate.ts EVENT_ID_RE (tests/giftScript.test.ts keeps them equal). */
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const EVENT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
export const DB_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const GIFT_ID_RE = /^gift_[0-9a-f]{24}$/;
export const DEFAULT_DB = 'recall-auth';

const USAGE = `Usage:
  node scripts/grant-gift.mjs grant season --email <email> [--expires YYYY-MM-DD] [--note <text>]
  node scripts/grant-gift.mjs grant regatta --event <event id> --email <email> [--expires YYYY-MM-DD] [--note <text>]
  node scripts/grant-gift.mjs revoke season --email <email>
  node scripts/grant-gift.mjs revoke regatta --event <event id> --email <email>
  node scripts/grant-gift.mjs revoke --id gift_<24 hex>
  node scripts/grant-gift.mjs list [--email <email>]
Options: --db <name> (default ${DEFAULT_DB}), --remote (default) or --local, --print (show the SQL only)`;

export const normEmail = (e) => e.trim().toLowerCase();

/** A checked email (lower-cased, trimmed), else an error. */
export function checkEmail(raw) {
  const e = normEmail(String(raw ?? ''));
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new Error(`Not an email address: ${JSON.stringify(raw)}`);
  return e;
}

/** --expires YYYY-MM-DD: the pass runs through that day (UTC), so it ends at the next midnight UTC (ms). */
export function expiryMs(raw, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? ''));
  if (!m) throw new Error(`--expires wants YYYY-MM-DD, not ${JSON.stringify(raw)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new Error(`No such date: ${raw}`);
  const end = Date.UTC(y, mo - 1, d + 1);
  if (end <= now) throw new Error(`--expires ${raw} is already past`);
  return end;
}

/** The gift's key: the same email, scope and event always give the same id. */
export const giftKey = (email, scope, eventId) => createHash('sha256').update(`recall-gift:${email}|${scope}|${eventId ?? ''}`).digest('hex').slice(0, 24);
export const giftId = (email, scope, eventId) => `gift_${giftKey(email, scope, eventId)}`;

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
const sqlNullable = (n) => (n == null ? 'NULL' : sqlInt(n));

/** The statements of a grant, one per line (idempotent: INSERT OR IGNORE on the gift's ids, then its expiry). */
export function grantSql({ email, scope, eventId = null, expiresAt = null, now, userId = randomUUID() }) {
  const e = checkEmail(email);
  if (scope !== 'season' && scope !== 'regatta') throw new Error(`Scope must be season or regatta, not ${JSON.stringify(scope)}`);
  if (scope === 'regatta' ? !EVENT_ID_RE.test(String(eventId ?? '')) : eventId != null) throw new Error(scope === 'regatta' ? `Not an event id: ${JSON.stringify(eventId)}` : 'A Season Pass takes no event id');
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('Bad user id');
  const key = giftKey(e, scope, eventId);
  const id = sqlString(`gift_${key}`);
  const em = sqlString(e);
  const t = sqlInt(now);
  const exp = sqlNullable(expiresAt);
  return [
    `INSERT OR IGNORE INTO users (id, email, created_at) VALUES (${sqlString(userId)}, ${em}, ${t});`,
    `INSERT OR IGNORE INTO purchases (id, user_id, provider, provider_ref, product, amount, currency, status, email, created_at) SELECT ${id}, id, 'gift', ${sqlString(`gift:${key}`)}, ${sqlString(scope)}, 0, NULL, 'gift', ${em}, ${t} FROM users WHERE email = ${em};`,
    `INSERT OR IGNORE INTO entitlements (id, user_id, scope, event_id, starts_at, expires_at, purchase_id) SELECT ${id}, user_id, ${sqlString(scope)}, ${eventId == null ? 'NULL' : sqlString(eventId)}, ${t}, ${exp}, id FROM purchases WHERE id = ${id};`,
    `UPDATE entitlements SET expires_at = ${exp}, revoked_at = NULL WHERE id = ${id};`,
  ].join('\n');
}

/** Revoke a gift (signed in yet or not): its entitlement stops unlocking; the first revocation's time stands. */
export function revokeSql({ id, now }) {
  if (!GIFT_ID_RE.test(String(id))) throw new Error(`Not a gift id: ${JSON.stringify(id)}`);
  return `UPDATE entitlements SET revoked_at = ${sqlInt(now)} WHERE id = ${sqlString(id)} AND revoked_at IS NULL;`;
}

/** Every gift (or one address's), oldest first; `signed_in`: the address has a session now. */
export function listSql({ email = null } = {}) {
  const where = email == null ? '' : ` AND p.email = ${sqlString(checkEmail(email))}`;
  return (
    "SELECT e.id, p.email, e.scope, e.event_id, datetime(e.starts_at / 1000, 'unixepoch') AS starts, datetime(e.expires_at / 1000, 'unixepoch') AS expires, " +
    "datetime(e.revoked_at / 1000, 'unixepoch') AS revoked, EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = e.user_id) AS signed_in " +
    `FROM entitlements e JOIN purchases p ON p.id = e.purchase_id WHERE p.provider = 'gift'${where} ORDER BY p.created_at;`
  );
}

const FLAGS_WITH_VALUE = new Set(['--email', '--event', '--expires', '--note', '--db', '--id']);
const BARE_FLAGS = new Set(['--remote', '--local', '--print', '--help']);

/** The command line, strictly: unknown, repeated or empty options are errors. */
export function parseArgs(argv, now = Date.now()) {
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
  const allow = (...names) => {
    for (const k of Object.keys(o)) if (!['--db', '--remote', '--local', '--print', ...names].includes(k)) throw new Error(`${k} doesn't go with ${pos[0]}`);
  };
  const [cmd, scope, ...rest] = pos;
  if (cmd === 'list') {
    if (pos.length > 1) throw new Error(`Unexpected ${pos[1]}`);
    allow('--email');
    return { ...common, cmd, email: o['--email'] != null ? checkEmail(o['--email']) : null };
  }
  if (cmd !== 'grant' && cmd !== 'revoke') throw new Error(cmd ? `Unknown command ${cmd}` : 'No command');
  if (rest.length) throw new Error(`Unexpected ${rest[0]}`);
  if (cmd === 'revoke' && o['--id'] != null) {
    if (scope) throw new Error('Give either --id or a scope with --email, not both');
    allow('--id');
    if (!GIFT_ID_RE.test(o['--id'])) throw new Error(`Not a gift id: ${JSON.stringify(o['--id'])}`);
    return { ...common, cmd, id: o['--id'] };
  }
  if (scope !== 'season' && scope !== 'regatta') throw new Error(`${cmd} needs season or regatta`);
  if (scope === 'regatta' && o['--event'] == null) throw new Error('A Regatta Pass needs --event <event id>');
  if (scope === 'season' && o['--event'] != null) throw new Error('A Season Pass takes no --event');
  if (o['--email'] == null) throw new Error(`${cmd} needs --email`);
  const email = checkEmail(o['--email']);
  const eventId = scope === 'regatta' ? o['--event'] : null;
  if (eventId != null && !EVENT_ID_RE.test(eventId)) throw new Error(`Not an event id: ${JSON.stringify(eventId)}`);
  if (cmd === 'revoke') {
    allow('--email', '--event');
    return { ...common, cmd, id: giftId(email, scope, eventId), email, scope, eventId };
  }
  allow('--email', '--event', '--expires', '--note');
  // eslint-disable-next-line no-control-regex
  const note = o['--note'] != null ? o['--note'].replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : null;
  return { ...common, cmd, email, scope, eventId, expiresAt: o['--expires'] != null ? expiryMs(o['--expires'], now) : null, note, id: giftId(email, scope, eventId) };
}

/** The SQL for a parsed command. */
export function sqlFor(p, now = Date.now(), userId) {
  if (p.cmd === 'list') return listSql({ email: p.email });
  if (p.cmd === 'revoke') return revokeSql({ id: p.id, now });
  return grantSql({ email: p.email, scope: p.scope, eventId: p.eventId, expiresAt: p.expiresAt, now, ...(userId ? { userId } : {}) });
}

/** wrangler's arguments (run without a shell, so nothing here is ever shell-parsed). */
export const wranglerArgs = (p, sql) => ['wrangler', 'd1', 'execute', p.db, p.target === 'local' ? '--local' : '--remote', '--command', sql];

function describe(p) {
  const what = p.cmd === 'list' ? `List gifts${p.email ? ` for ${p.email}` : ''}` : p.scope ? `${p.cmd === 'grant' ? 'Grant' : 'Revoke'} a ${p.scope === 'season' ? 'Season Pass' : `Regatta Pass for event ${p.eventId}`} ${p.cmd === 'grant' ? 'to' : 'of'} ${p.email}` : `Revoke gift ${p.id}`;
  const exp = p.cmd === 'grant' ? (p.expiresAt != null ? `, through ${new Date(p.expiresAt - 1).toISOString().slice(0, 10)} (UTC)` : ', no expiry') : '';
  return `${what}${exp}${p.id && p.cmd !== 'list' ? ` [${p.id}]` : ''}${p.note ? ` (note: ${p.note})` : ''} on ${p.db} (${p.target})`;
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
