#!/usr/bin/env node
/**
 * Usage report (read-only): one day of the page's usage events (POST /api/track → Workers Analytics Engine,
 * dataset recall_events; the schema is functions/_trackSchema.ts), from the Analytics Engine SQL API.
 * No dependencies. README "Usage tracking" has the setup.
 *
 *   CF_ACCOUNT_ID=… CF_ANALYTICS_TOKEN=… node scripts/usage-report.mjs            (yesterday, Eastern)
 *   node scripts/usage-report.mjs --day 2026-10-28 [--tz America/New_York | --tz UTC] [--dataset recall_events]
 *   node scripts/usage-report.mjs --sql                                             (print the queries, call nothing)
 *
 * The day runs midnight to midnight in --tz (default America/New_York, as the app's race times). The token
 * needs Account · Account Analytics · Read and nothing else; it is sent only in the Authorization header and
 * never printed. Analytics Engine samples busy datasets (by index1, the event name), so event counts are
 * SUM(_sample_interval): an estimate, exact at low volume. Sessions are COUNT(DISTINCT blob11), the session id,
 * over the rows kept: exact at low volume, a floor once sampling starts. Bounce rate and the funnel group the
 * kept rows by session (blob11); a session that kept exactly one event counts as a bounce.
 */
import { pathToFileURL } from 'node:url';

export const DEFAULT_DATASET = 'recall_events';
export const DEFAULT_TZ = 'America/New_York';
export const DATASET_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The funnel's steps, in order (each counts the sessions that reached it and every step before). */
export const FUNNEL = ['landing_view', 'race_open', 'signin_start', 'signin_done'];
export const TOP = 15;
/** The most session × event rows read back (a day of Recall is far below it). */
export const SESSION_ROWS_MAX = 10_000;

const USAGE = `Usage: node scripts/usage-report.mjs [--day YYYY-MM-DD] [--tz America/New_York|UTC|<IANA zone>] [--dataset ${DEFAULT_DATASET}] [--sql]
Reads CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN (Account Analytics: Read). --sql prints the queries and calls nothing.
Default: yesterday in ${DEFAULT_TZ}.`;

export function parseArgs(argv) {
  const o = { day: null, tz: DEFAULT_TZ, dataset: DEFAULT_DATASET, sql: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--day') o.day = val();
    else if (a === '--tz') o.tz = val();
    else if (a === '--dataset') o.dataset = val();
    else if (a === '--sql') o.sql = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (o.day != null && !validDay(o.day)) throw new Error(`--day is a date, YYYY-MM-DD, not ${JSON.stringify(o.day)}`);
  if (!DATASET_RE.test(o.dataset)) throw new Error(`Not a dataset name: ${JSON.stringify(o.dataset)}`);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: o.tz });
  } catch {
    throw new Error(`Not a time zone: ${JSON.stringify(o.tz)}`);
  }
  return o;
}

function validDay(s) {
  if (!DAY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** The zone's offset from UTC at `ms`, in ms (Eastern in October: -4 h). */
export function zoneOffsetMs(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of local midnight on `day` in `tz`. */
function midnight(day, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - zoneOffsetMs(guess, tz);
  // Across a clock change the offset at midnight itself is the one that counts.
  return guess - zoneOffsetMs(first, tz);
}

const nextDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** The date in `tz` at `now`, less one day. */
export function yesterday(now, tz) {
  const off = zoneOffsetMs(now, tz);
  const local = new Date(now + off);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - 1)).toISOString().slice(0, 10);
}

/** `ms` as Analytics Engine's toDateTime wants it (UTC, 'YYYY-MM-DD HH:MM:SS'). */
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** The day's span as UTC times for SQL: [from, to). */
export function dayRange(day, tz) {
  if (!validDay(day)) throw new Error(`Not a day: ${day}`);
  return { from: sqlTime(midnight(day, tz)), to: sqlTime(midnight(nextDay(day), tz)) };
}

const checkDataset = (ds) => {
  if (!DATASET_RE.test(ds)) throw new Error(`Not a dataset name: ${ds}`);
  return ds;
};
const whereDay = (r) => `timestamp >= toDateTime('${r.from}') AND timestamp < toDateTime('${r.to}')`;

/**
 * The report's queries for a day. Columns (functions/_trackSchema.ts): index1 event name (the sampling key),
 * blob1 event, blob2 path, blob3 event id, blob4 race, blob5 signed in, blob6 device, blob7 referrer host,
 * blob8 theme, blob9 detail, blob10 country, blob11 session.
 */
export function reportSql({ day, tz = DEFAULT_TZ, dataset = DEFAULT_DATASET }) {
  const ds = checkDataset(dataset);
  const r = dayRange(day, tz);
  const w = whereDay(r);
  return {
    sessionCount: `SELECT COUNT(DISTINCT blob11) AS sessions FROM ${ds} WHERE ${w} AND blob11 != '' FORMAT JSON`,
    sessions:
      `SELECT blob11 AS session, blob1 AS event, blob6 AS device, blob7 AS referrer, count() AS kept, SUM(_sample_interval) AS n FROM ${ds} ` +
      `WHERE ${w} AND blob11 != '' GROUP BY blob11, blob1, blob6, blob7 LIMIT ${SESSION_ROWS_MAX} FORMAT JSON`,
    events: `SELECT blob1 AS event, blob9 AS detail, SUM(_sample_interval) AS n FROM ${ds} WHERE ${w} GROUP BY blob1, blob9 ORDER BY n DESC LIMIT 200 FORMAT JSON`,
    races:
      `SELECT blob3 AS event_id, blob4 AS race, SUM(_sample_interval) AS n FROM ${ds} ` +
      `WHERE ${w} AND blob1 = 'race_open' GROUP BY blob3, blob4 ORDER BY n DESC LIMIT ${TOP} FORMAT JSON`,
    regattas:
      `SELECT blob3 AS event_id, SUM(_sample_interval) AS n FROM ${ds} ` +
      `WHERE ${w} AND blob1 = 'regatta_open' GROUP BY blob3 ORDER BY n DESC LIMIT ${TOP} FORMAT JSON`,
    signedIn: `SELECT blob5 AS signed_in, SUM(_sample_interval) AS n FROM ${ds} WHERE ${w} GROUP BY blob5 ORDER BY n DESC FORMAT JSON`,
  };
}

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Sessions, bounces, the funnel, device mix and referrers, from the session × event rows (blob11 × blob1).
 * `distinct` is the sessionCount query's answer (else the sessions the rows name). A bounce is a session
 * that kept one row (`kept`; `n` where a row has no `kept`).
 */
export function summarize(rows, distinct) {
  const by = new Map();
  for (const row of rows) {
    const id = String(row.session ?? '');
    if (!id) continue;
    let s = by.get(id);
    if (!s) by.set(id, (s = { events: new Map(), total: 0, device: '', referrer: '' }));
    const n = num(row.n);
    s.total += row.kept != null ? num(row.kept) : n;
    s.events.set(row.event, (s.events.get(row.event) ?? 0) + n);
    if (!s.device && row.device) s.device = String(row.device);
    if (!s.referrer && row.referrer) s.referrer = String(row.referrer);
  }
  const all = [...by.values()];
  const d = distinct == null ? NaN : num(distinct);
  const sessions = d > 0 ? d : all.length;
  const bounced = all.filter((s) => s.total === 1).length;
  let reached = all;
  const funnel = FUNNEL.map((step) => {
    reached = reached.filter((s) => s.events.has(step));
    return { step, sessions: reached.length, any: all.filter((s) => s.events.has(step)).length };
  });
  const tally = (key) => {
    const m = new Map();
    for (const s of all) if (s[key]) m.set(s[key], (m.get(s[key]) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  return { sessions, bounced, bounceRate: all.length ? bounced / all.length : 0, funnel, devices: tally('device'), referrers: tally('referrer').slice(0, TOP) };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);

/** The report as text. */
export function formatReport({ day, tz, summary: s, events, races, regattas, signedIn }) {
  const out = [`Recall usage, ${day} (${tz})`, ''];
  out.push(`Sessions: ${s.sessions}`, `Bounce rate: ${pct(s.bounceRate)} (${s.bounced} sessions with one event)`);
  out.push('Sessions, bounces and the funnel count the events Analytics Engine kept: exact on a quiet day, estimates on a busy one.', '');
  out.push('Funnel (sessions reaching each step and every step before; any order within the day):');
  for (const f of s.funnel) out.push(`  ${pad(f.step, 16)} ${pad(f.sessions, 6)} (${f.any} sessions in all)`);
  out.push('', 'Devices (sessions):');
  for (const [k, v] of s.devices) out.push(`  ${pad(k, 10)} ${v}`);
  out.push('', 'Referrers (first event of a session):');
  if (!s.referrers.length) out.push('  none recorded');
  for (const [k, v] of s.referrers) out.push(`  ${pad(k, 32)} ${v}`);
  out.push('', 'Top regattas (opens):');
  for (const r of regattas) out.push(`  ${pad(r.event_id, 32)} ${num(r.n)}`);
  out.push('', 'Top races (opens):');
  for (const r of races) out.push(`  ${pad(`${r.event_id} · ${String(r.race).replace('|', ' race ')}`, 48)} ${num(r.n)}`);
  out.push('', 'Signed in (events):');
  for (const r of signedIn) out.push(`  ${pad(r.signed_in || 'unknown', 10)} ${num(r.n)}`);
  out.push('', 'Events by type:');
  for (const r of events) out.push(`  ${pad(r.detail ? `${r.event} · ${r.detail}` : r.event, 36)} ${num(r.n)}`);
  return out.join('\n');
}

/** POST one query to the SQL API; the rows of its JSON answer. */
export async function query(sql, { accountId, token, fetchImpl = fetch }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`;
  const res = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`Analytics Engine SQL API answered ${res.status}: ${text.slice(0, 400)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Analytics Engine SQL API sent something other than JSON: ${text.slice(0, 200)}`);
  }
  return Array.isArray(body?.data) ? body.data : [];
}

export async function main(argv, env = process.env, o = {}) {
  const log = o.log ?? console.log;
  const a = parseArgs(argv);
  if (a.help) return log(USAGE);
  const day = a.day ?? yesterday(o.now ?? Date.now(), a.tz);
  const sql = reportSql({ day, tz: a.tz, dataset: a.dataset });
  if (a.sql) {
    log(`-- ${day} in ${a.tz}: ${JSON.stringify(dayRange(day, a.tz))}`);
    for (const [k, q] of Object.entries(sql)) log(`-- ${k}\n${q};`);
    return;
  }
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const token = env.CF_ANALYTICS_TOKEN?.trim();
  if (!accountId || !token) throw new Error('Set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN (an API token with Account Analytics: Read), or use --sql.');
  const q = (s) => query(s, { accountId, token, fetchImpl: o.fetchImpl });
  const [count, sessions, events, races, regattas, signedIn] = await Promise.all([q(sql.sessionCount), q(sql.sessions), q(sql.events), q(sql.races), q(sql.regattas), q(sql.signedIn)]);
  log(formatReport({ day, tz: a.tz, summary: summarize(sessions, count[0]?.sessions), events, races, regattas, signedIn }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
