#!/usr/bin/env node
/**
 * Feedback (admin only): list what the Feedback sheet sent, or show one in full, from the paywall's D1
 * database (README "Feedback"). No dependencies; the SQL runs through
 * `npx wrangler d1 execute <db> --remote|--local --json --command …`, or is printed with --print.
 *
 *   node scripts/feedback.mjs list [--limit 50] [--since 2026-10-01] [--type bug]
 *   node scripts/feedback.mjs show <id>
 *   common: --db recall-auth (default) · --remote (default) | --local · --print (show the SQL, run nothing)
 *
 * `list` is newest first: id, when, type, who, where and the message's start. `show` prints every
 * column, the context laid out (where, device, theme, app, data, recent problems) and the R2 keys of
 * any images (fetch them with `npx wrangler r2 object get <bucket>/<key>`). Needs migrations/0004_feedback.sql.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DB_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** As functions/_feedback.ts FEEDBACK_TYPES (tests/feedbackScript.test.ts keeps them equal). */
export const TYPES = ['bug', 'idea', 'data', 'other'];
export const DEFAULT_DB = 'recall-auth';
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;

const USAGE = `Usage:
  node scripts/feedback.mjs list [--limit <1-${MAX_LIMIT}>] [--since YYYY-MM-DD] [--type ${TYPES.join('|')}]
  node scripts/feedback.mjs show <id>
list: newest first (default ${DEFAULT_LIMIT}): id, when (UTC), type, who, where, the message's start.
show: one submission in full, with its context laid out.
Options: --db <name> (default ${DEFAULT_DB}), --remote (default) or --local, --print (show the SQL only)`;

const sqlInt = (n) => {
  if (!Number.isSafeInteger(n)) throw new Error(`Not an integer: ${n}`);
  return String(n);
};

/** Midnight UTC of a YYYY-MM-DD, in ms; an error for anything else. */
export function sinceMs(raw) {
  const s = String(raw ?? '');
  const t = DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new Error(`Not a date (YYYY-MM-DD): ${JSON.stringify(raw)}`);
  return t;
}

export function listSql({ limit = DEFAULT_LIMIT, since = null, type = null }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`Bad limit: ${limit}`);
  if (type != null && !TYPES.includes(type)) throw new Error(`Bad type: ${type}`);
  const where = [...(since != null ? [`created_at >= ${sqlInt(since)}`] : []), ...(type != null ? [`type = '${type}'`] : [])];
  return (
    `SELECT id, datetime(created_at / 1000, 'unixepoch') AS created, type, COALESCE(email, user_id, 'signed out') AS who, ` +
    `COALESCE(event_id || ' ' || COALESCE(division, '') || ' ' || COALESCE(race, ''), url) AS place, substr(replace(message, char(10), ' '), 1, 80) AS message, ` +
    `CASE WHEN image_key IS NOT NULL OR map_key IS NOT NULL THEN 'yes' ELSE '' END AS image, CASE WHEN email_error IS NOT NULL THEN 'failed' WHEN emailed_at IS NOT NULL THEN 'sent' ELSE '' END AS mailed ` +
    `FROM feedback${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${sqlInt(limit)};`
  );
}

export function showSql({ id }) {
  if (!ID_RE.test(String(id))) throw new Error(`Not a feedback id: ${JSON.stringify(id)}`);
  return `SELECT * FROM feedback WHERE id = '${id}';`;
}

const FLAGS_WITH_VALUE = new Set(['--limit', '--since', '--type', '--db']);
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
  if (cmd === 'list') {
    if (rest.length) throw new Error(`Unexpected ${rest[0]}`);
    const lim = o['--limit'] ?? String(DEFAULT_LIMIT);
    if (!/^\d{1,4}$/.test(lim) || Number(lim) < 1 || Number(lim) > MAX_LIMIT) throw new Error(`--limit is a whole number from 1 to ${MAX_LIMIT}, not ${JSON.stringify(lim)}`);
    const type = o['--type'] ?? null;
    if (type != null && !TYPES.includes(type)) throw new Error(`--type is one of ${TYPES.join(', ')}, not ${JSON.stringify(type)}`);
    return { ...common, cmd, limit: Number(lim), since: o['--since'] != null ? sinceMs(o['--since']) : null, type };
  }
  if (cmd === 'show') {
    for (const k of ['--limit', '--since', '--type']) if (k in o) throw new Error(`${k} doesn't go with show`);
    if (rest.length !== 1) throw new Error(rest.length ? `Unexpected ${rest[1]}` : 'show needs a feedback id');
    if (!ID_RE.test(rest[0])) throw new Error(`Not a feedback id: ${JSON.stringify(rest[0])}`);
    return { ...common, cmd, id: rest[0] };
  }
  throw new Error(cmd ? `Unknown command ${cmd}` : 'No command');
}

export const sqlFor = (p) => (p.cmd === 'list' ? listSql(p) : showSql(p));

/** wrangler's arguments (run without a shell, so nothing here is ever shell-parsed). */
export const wranglerArgs = (p, sql) => ['wrangler', 'd1', 'execute', p.db, p.target === 'local' ? '--local' : '--remote', '--json', '--command', sql];

/** The rows in wrangler's --json output (an array of { results }). */
export function rowsOf(stdout) {
  const parsed = JSON.parse(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return Array.isArray(first?.results) ? first.results : [];
}

const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().replace('.000Z', 'Z') : '—');
const get = (o, ...path) => path.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
const val = (v) => (v == null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** One row, laid out for reading. */
export function formatShow(row) {
  if (!row) return 'No feedback with that id.';
  let ctx = null;
  try {
    ctx = JSON.parse(row.context_json ?? 'null');
  } catch {
    /* shown raw below */
  }
  const out = [];
  const line = (k, v) => out.push(`${k.padEnd(14)} ${val(v)}`);
  const section = (title) => out.push('', title);
  line('id', row.id);
  line('created', iso(row.created_at));
  line('type', row.type);
  line('from', row.email ? `${row.email}${row.user_id ? ` (user ${row.user_id})` : ' (signed out)'}` : row.user_id ? `user ${row.user_id}` : 'signed out');
  line('session', row.session_public_id);
  line('country', [row.country, row.colo].filter(Boolean).join(' / '));
  line('ip hash', row.ip_hash ? `${String(row.ip_hash).slice(0, 16)}…` : null);
  line('emailed', row.emailed_at ? iso(row.emailed_at) : null);
  if (row.email_error) line('email error', row.email_error);
  section('Message');
  out.push(...String(row.message ?? '').split('\n').map((l) => `  ${l}`));
  section('Where');
  line('url', row.url);
  if (ctx?.where) for (const [k, v] of Object.entries(ctx.where)) if (!['url', 'query'].includes(k)) line(k, v);
  if (ctx) {
    section('Device');
    for (const [k, v] of Object.entries(ctx.device ?? {})) line(k, v);
    line('user agent', row.user_agent);
    section('Theme, app, data');
    line('theme', [get(ctx, 'theme', 'resolved'), get(ctx, 'theme', 'source')].filter(Boolean).join(', '));
    line('app', [row.app_commit ?? get(ctx, 'app', 'commit'), get(ctx, 'app', 'builtAt') && `built ${get(ctx, 'app', 'builtAt')}`].filter(Boolean).join(', '));
    for (const [k, v] of Object.entries(ctx.data ?? {})) line(k, v);
    line('time on page', typeof ctx.timeOnPageS === 'number' ? `${ctx.timeOnPageS} s` : null);
    if (ctx.mapNote) line('map', `not included: ${ctx.mapNote}`);
    const probs = Array.isArray(ctx.problems) ? ctx.problems : [];
    section(`Recent problems (${probs.length})`);
    for (const p of probs) out.push(`  ${val(p?.at)} ${val(p?.kind)} ${val(p?.text)}`);
  } else {
    section('Context (raw)');
    out.push(String(row.context_json ?? ''));
  }
  section('Images');
  if (row.image_key) line('image', `${row.image_key} (${row.image_type}, ${row.image_bytes} bytes)`);
  if (row.map_key) line('map', row.map_key);
  if (row.image_note) line('note', row.image_note);
  if (!row.image_key && !row.map_key && !row.image_note) out.push('  none');
  return out.join('\n');
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
  console.error(`${p.cmd === 'list' ? 'List feedback' : `Show feedback ${p.id}`} on ${p.db} (${p.target})`);
  if (p.print) {
    console.log(sql);
    return 0;
  }
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', wranglerArgs(p, sql), { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    console.error(`Couldn't run wrangler (${r.error.message}). Use --print and run the SQL yourself.`);
    return 1;
  }
  if (r.status !== 0) {
    process.stdout.write(r.stdout ?? '');
    return r.status ?? 1;
  }
  let rows;
  try {
    rows = rowsOf(r.stdout);
  } catch {
    process.stdout.write(r.stdout ?? '');
    return 0;
  }
  if (p.cmd === 'show') console.log(formatShow(rows[0]));
  else if (!rows.length) console.log('No feedback.');
  else console.table(rows);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
