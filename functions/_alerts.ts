/**
 * Race emails ("Email me when races are posted"): the handler behind functions/api/alerts/ (kept in a `_`
 * file so tests call it directly), and what the recall-race-alerts Worker shares with it (workers/race-alerts).
 * Schema: migrations/0005_race_alerts.sql. README "Race emails".
 *
 *   GET    /api/alerts                    { alerts: [{ eventId, title, startMs, endMs, createdAt }] } (signed in)
 *   POST   /api/alerts         { eventId } subscribe → { ok, alerts }
 *   DELETE /api/alerts         { eventId } (or ?event=) unsubscribe → { ok, alerts }
 *   GET    /api/alerts/unsubscribe?t=     the email's link: a small page with a button (changes nothing, so a
 *                                         mail scanner's prefetch can't unsubscribe anyone)
 *   POST   /api/alerts/unsubscribe?t=     its button, or a mail client's RFC 8058 one-click POST: unsubscribes
 *
 * The session routes answer the proxy's 404 with PAYWALL_ENABLED off, 401 sign_in_required signed out, and
 * want an Origin from this site (or walkeforward.com) on a POST / DELETE, which count against hourly limits
 * per user and per IP (429 rate_limited). The unsubscribe routes work with the flag on or off (an email
 * already sent must always be able to stop the next one): the signed token is the authority, so they take
 * no cookie and no Origin, and no IP limit (one-click POSTs come from the mail providers' own servers).
 *
 * The token names the user and, per event, the subscription's version (its created_at): it turns off only
 * that subscription, so an old email can't turn off emails the user turned back on since.
 *
 * A posted race: in the race list Recall builds from the RaceSense document (src/data/raceList.ts), not
 * practice, with a gun at or before now and at least one finish, or an end time, or a gun POSTED_AFTER_GUN_MS
 * ago (a race with no finishes yet is still listed once it's over). Its key is `<division>|<RaceSense race
 * number>`: stable while the shown number (official, ordinal or RaceSense) can still change.
 */
import { countRateHit, pruneRateLimits, sessionUserId, type D1Like } from './_authDb';
import { b64url, fromB64url, hmac, originRefused } from './_auth';
import { jsonOut, notFound, paywallOn, readCookie, sameText, SESSION_COOKIE, TOKEN_RE, tokenHash, SIGN_IN_REQUIRED, type PaywallDeps, type PaywallEnv } from './_paywall';
import { MAX_UPSTREAM_BYTES, UA, UPSTREAM, looksLikeJson } from './_lib';
import { methodNotAllowed, readCapped } from './_vkx';
import { ipHash } from './_feedback';
import { buildRaceList } from '../src/data/raceList';
import { currentDoc, tzOffsetMs } from '../src/data/racesense/adapter';
import type { RegattaDoc, RegattaResponse } from '../src/data/racesense/types';
import { EVENT_ID_RE } from '../src/data/vkx/validate';

export const DAY_MS = 86_400_000;
/** Race emails per user at a time. */
export const MAX_SUBS = 50;
/** A race with no finishes counts as posted this long after its gun. */
export const POSTED_AFTER_GUN_MS = 4 * 3_600_000;
/** The Worker looks at an event from a day before its first day to two days after its last. */
export const WINDOW_BEFORE_MS = DAY_MS;
export const WINDOW_AFTER_MS = 2 * DAY_MS;
export const UNSUB_PURPOSE = 'race-alert-unsub';
export const UNSUB_PATH = '/api/alerts/unsubscribe';
const MAX_BODY_BYTES = 2_000;
/** Turning emails on or off, per hour: per user, and per IP. */
export const ALERTS_USER_LIMIT = 30;
export const ALERTS_IP_LIMIT = 60;
const PRUNE_CHANCE = 0.01;
/** The longest token taken (a List-Unsubscribe header stays under 2,000 bytes). */
export const MAX_TOKEN_CHARS = 1_800;

export type AlertsEnv = PaywallEnv;

// ---- posted races

export interface PostedRace {
  key: string;
  division: string;
  /** RaceSense's race number (the app's `race=`). */
  rsNumber: number;
  /** The number Recall shows (as the picker does without official results). */
  number: number;
  gunMs: number;
  tzOffsetMs: number;
}

export const raceKey = (division: string, rsNumber: number): string => `${division}|${rsNumber}`;

/** The document's posted races, oldest first. */
export function postedRaces(doc: RegattaDoc, now: number): PostedRace[] {
  const out: PostedRace[] = [];
  for (const r of buildRaceList(doc).races) {
    if (r.practice || r.rsNumber == null || !(r.gunMs > 0) || r.gunMs > now) continue;
    const race = doc.divisions.find((d) => d.name === r.division)?.races.find((x) => x.raceNumber === r.rsNumber);
    const ended = !!race?.endTime && Date.parse(race.endTime) <= now;
    if (!(r.finishers > 0 || r.finished || ended || now - r.gunMs >= POSTED_AFTER_GUN_MS)) continue;
    out.push({ key: raceKey(r.division, r.rsNumber), division: r.division, rsNumber: r.rsNumber, number: r.number ?? r.rsNumber, gunMs: r.gunMs, tzOffsetMs: tzOffsetMs(race?.timezoneOffset) });
  }
  return out.sort((a, b) => a.gunMs - b.gunMs);
}

/** The event's title and dates, as stored (a document with no dates: the day it was first looked at; `dated` false). */
export function eventFacts(eventId: string, doc: RegattaDoc, now: number): { title: string; startMs: number; endMs: number; dated: boolean } {
  const dated = Number.isFinite(doc.startDate) && doc.startDate! > 0;
  const startMs = dated ? doc.startDate! : now;
  const endMs = Number.isFinite(doc.endDate) && doc.endDate! >= startMs ? doc.endDate! : startMs;
  return { title: cleanTitle(doc.name) || eventId, startMs, endMs, dated };
}

/** One line, no control characters, at most 120 characters (it goes into a subject line). */
// eslint-disable-next-line no-control-regex
export const cleanTitle = (s: unknown): string => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '');

export type DocResult = { kind: 'ok'; doc: RegattaDoc } | { kind: 'missing' } | { kind: 'error' };

/** The event's RaceSense document, from the upstream the Pages proxy uses. */
export async function fetchRegattaDoc(eventId: string, doFetch: typeof fetch = fetch): Promise<DocResult> {
  let res: Response;
  try {
    res = await doFetch(`${UPSTREAM}regatta?${new URLSearchParams({ event: eventId })}`, { headers: { accept: 'application/json', 'user-agent': UA } });
  } catch {
    return { kind: 'error' };
  }
  if (res.status === 404) return { kind: 'missing' };
  if (!res.ok) return { kind: 'error' };
  const text = await res.text();
  if (text.length > MAX_UPSTREAM_BYTES || !looksLikeJson(text)) return { kind: 'error' };
  try {
    const doc = currentDoc(JSON.parse(text) as RegattaResponse);
    return doc && typeof doc === 'object' ? { kind: 'ok', doc: { ...doc, divisions: Array.isArray(doc.divisions) ? doc.divisions : [] } } : { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  }
}

// ---- the unsubscribe token: `payload.signature`, both base64url; payload {p, u, s: [[eventId, version], ...]};
// HMAC-SHA256 under AUTH_SECRET of `race-alert-unsub:` + payload. One event for an email's per-event link,
// every event in the email for a combined email's List-Unsubscribe header.

/** A subscription as a token names it: the event and the subscription's created_at. */
export interface SubVersion {
  eventId: string;
  version: number;
}

export async function signUnsub(secret: string, userId: string, subs: readonly SubVersion[]): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ p: UNSUB_PURPOSE, u: userId, s: subs.map((x) => [x.eventId, x.version]) })));
  return `${payload}.${await hmac(secret, `${UNSUB_PURPOSE}:${payload}`)}`;
}

/** The token's user and subscriptions, if it is ours (right secret, right purpose); it doesn't expire. */
export async function readUnsub(secret: string | undefined, raw: unknown): Promise<{ userId: string; subs: SubVersion[] } | null> {
  if (!secret || typeof raw !== 'string' || raw.length > MAX_TOKEN_CHARS) return null;
  const [payload, sig, extra] = raw.split('.');
  if (!payload || !sig || extra !== undefined || !sameText(sig, await hmac(secret, `${UNSUB_PURPOSE}:${payload}`))) return null;
  try {
    const o = JSON.parse(fromB64url(payload)) as { p?: unknown; u?: unknown; s?: unknown };
    if (o.p !== UNSUB_PURPOSE || typeof o.u !== 'string' || !o.u || o.u.length > 64 || !Array.isArray(o.s) || !o.s.length || o.s.length > MAX_SUBS) return null;
    const subs: SubVersion[] = [];
    for (const x of o.s as unknown[]) {
      if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string' || !EVENT_ID_RE.test(x[0]) || !Number.isSafeInteger(x[1])) return null;
      subs.push({ eventId: x[0], version: x[1] as number });
    }
    return { userId: o.u, subs };
  } catch {
    return null;
  }
}

// ---- D1

export interface AlertView {
  eventId: string;
  title: string;
  startMs: number;
  endMs: number;
  createdAt: number;
}

interface EventRow {
  event_id: string;
  title: string;
  start_ms: number;
  end_ms: number;
}

const subsOf = async (db: D1Like, userId: string): Promise<{ event_id: string; created_at: number }[]> =>
  (await db.prepare(`SELECT event_id, created_at FROM race_alert_subs WHERE user_id = ? LIMIT ${MAX_SUBS + 10}`).bind(userId).all<{ event_id: string; created_at: number }>()).results;

/** The user's race emails, soonest event first. */
export async function alertsOf(db: D1Like, userId: string): Promise<AlertView[]> {
  const subs = await subsOf(db, userId);
  if (!subs.length) return [];
  const rows = (
    await db
      .prepare(`SELECT event_id, title, start_ms, end_ms FROM race_alert_events WHERE event_id IN (${subs.map(() => '?').join(', ')})`)
      .bind(...subs.map((s) => s.event_id))
      .all<EventRow>()
  ).results;
  const by = new Map(rows.map((r) => [r.event_id, r]));
  return subs
    .map((s): AlertView => {
      const e = by.get(s.event_id);
      return { eventId: s.event_id, title: e?.title ?? s.event_id, startMs: e?.start_ms ?? 0, endMs: e?.end_ms ?? 0, createdAt: s.created_at };
    })
    .sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
}

export const eventRow = (db: D1Like, eventId: string): Promise<EventRow | null> =>
  db.prepare('SELECT event_id, title, start_ms, end_ms FROM race_alert_events WHERE event_id = ?').bind(eventId).first<EventRow>();

/**
 * Record the event (title and dates fresh from `doc`) and its posted races as seen now. One transaction.
 * Races already seen keep their first time. `worker`: the Worker's read, which also sets synced_at, and
 * baselined_at when `baseline` (its silent pass: what it records then is never mailed).
 */
export async function recordEvent(
  db: D1Like,
  eventId: string,
  doc: RegattaDoc,
  now: number,
  races = postedRaces(doc, now),
  worker: { baseline: boolean } | null = null,
): Promise<void> {
  const f = eventFacts(eventId, doc, now);
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO race_alert_events (event_id, title, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?)').bind(eventId, f.title, f.startMs, f.endMs, now),
    f.dated
      ? db.prepare('UPDATE race_alert_events SET title = ?, start_ms = ?, end_ms = ? WHERE event_id = ?').bind(f.title, f.startMs, f.endMs, eventId)
      : db.prepare('UPDATE race_alert_events SET title = ? WHERE event_id = ?').bind(f.title, eventId),
    ...races.map((r) => db.prepare('INSERT OR IGNORE INTO race_alert_seen (event_id, race_key, first_seen_at) VALUES (?, ?, ?)').bind(eventId, r.key, now)),
    ...(worker
      ? [
          worker.baseline
            ? db.prepare('UPDATE race_alert_events SET synced_at = ?, baselined_at = ? WHERE event_id = ?').bind(now, now, eventId)
            : db.prepare('UPDATE race_alert_events SET synced_at = ? WHERE event_id = ?').bind(now, eventId),
        ]
      : []),
  ]);
}

/** Over: past the Worker's window (two days after the last day). */
export const eventOver = (endMs: number, now: number): boolean => endMs + WINDOW_AFTER_MS < now;

// ---- the session routes

export interface AlertsCtx {
  request: Request;
  env: AlertsEnv;
  waitUntil?(p: Promise<unknown>): void;
}

export interface AlertsDeps extends PaywallDeps {
  /** Hourly limits (tests); null: none. */
  alertLimits?: { user: number; ip: number } | null;
  /** The chance of pruning old counters (tests). */
  random?: () => number;
}

const fail = (status: number, error: string, message: string): Response => jsonOut(status, { error, message });

async function sessionUser(req: Request, db: D1Like, now: number): Promise<string | null> {
  const token = readCookie(req, SESSION_COOKIE);
  return token && TOKEN_RE.test(token) ? sessionUserId(db, await tokenHash('session', token), now) : null;
}

async function readEventId(req: Request): Promise<unknown> {
  const q = new URL(req.url).searchParams.get('event');
  if (q != null) return q;
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (!raw?.length) return null;
  try {
    return (JSON.parse(new TextDecoder().decode(raw)) as { eventId?: unknown } | null)?.eventId ?? null;
  } catch {
    return null;
  }
}

const SIGN_IN_MESSAGE = 'Sign in to get race emails.';

/**
 * Count this change against the user's and the IP's hourly counters (auth_rate_limits, as feedback and
 * sign-in do); true when either is over its limit. Every attempt counts, refused or not.
 */
async function overLimit(ctx: AlertsCtx, db: D1Like, userId: string, deps: AlertsDeps, now: number): Promise<boolean> {
  const lim = deps.alertLimits === undefined ? { user: ALERTS_USER_LIMIT, ip: ALERTS_IP_LIMIT } : deps.alertLimits;
  if (!lim) return false;
  const ip = await ipHash(ctx.request.headers.get('cf-connecting-ip') ?? 'local', ctx.env.AUTH_SECRET);
  const [u, i] = await Promise.all([countRateHit(db, `alerts-user:${userId}`, now), countRateHit(db, `alerts-ip:${ip}`, now)]);
  if ((deps.random ?? Math.random)() < PRUNE_CHANCE) {
    const prune = pruneRateLimits(db, now).catch(() => undefined);
    if (ctx.waitUntil) ctx.waitUntil(prune);
    else await prune;
  }
  return u > lim.user || i > lim.ip;
}

export async function handleAlerts(ctx: AlertsCtx, deps: AlertsDeps = {}): Promise<Response> {
  const { request: req, env } = ctx;
  if (!paywallOn(env)) return notFound();
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return methodNotAllowed('GET, POST, DELETE');
  if (method !== 'GET' && originRefused(req)) return fail(403, 'forbidden', "That didn't come from this site. Reload the page and try again.");
  const db = env.AUTH_DB;
  if (!db) return fail(503, 'not_configured', 'Race emails are not set up on this site yet.');
  const now = (deps.now ?? Date.now)();
  try {
    const userId = await sessionUser(req, db, now);
    if (!userId) return fail(401, SIGN_IN_REQUIRED, SIGN_IN_MESSAGE);
    if (method === 'GET') return jsonOut(200, { alerts: await alertsOf(db, userId) });
    if (await overLimit(ctx, db, userId, deps, now)) return fail(429, 'rate_limited', "That's a lot of changes in one hour. Try again later.");
    const eventId = await readEventId(req);
    if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) return fail(400, 'bad_event', "That regatta couldn't be found.");
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM race_alert_subs WHERE user_id = ? AND event_id = ?').bind(userId, eventId).run();
      return jsonOut(200, { ok: true, alerts: await alertsOf(db, userId) });
    }
    const subs = await subsOf(db, userId);
    if (subs.some((s) => s.event_id === eventId)) return jsonOut(200, { ok: true, alerts: await alertsOf(db, userId) });
    if (subs.length >= MAX_SUBS) return fail(409, 'too_many', `Race emails are on for ${MAX_SUBS} regattas already. Turn some off in your account first.`);
    // The document, to know the event and record the races already posted: those are never mailed.
    const got = await fetchRegattaDoc(eventId, deps.fetch);
    let ev = await eventRow(db, eventId);
    if (got.kind === 'missing' && !ev) return fail(404, 'unknown_event', "That regatta couldn't be found.");
    if (got.kind === 'ok') {
      await recordEvent(db, eventId, got.doc, now);
      ev = await eventRow(db, eventId);
    }
    // Upstream down: only for an event already known (the Worker's first read of it mails nothing).
    if (!ev) return fail(502, 'upstream', "Couldn't reach RaceSense just now. Try again in a minute.");
    if (eventOver(ev.end_ms, now)) return fail(409, 'event_over', 'This regatta is over.');
    await db.prepare('INSERT OR IGNORE INTO race_alert_subs (user_id, event_id, created_at) VALUES (?, ?, ?)').bind(userId, eventId, now).run();
    return jsonOut(200, { ok: true, alerts: await alertsOf(db, userId) });
  } catch {
    return fail(503, 'auth_unavailable', 'Race emails are unavailable right now. Try again in a minute.');
  }
}

// ---- the email's unsubscribe link

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

export const UNSUB_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const page = (status: number, body: string): Response =>
  new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Race emails · Recall</title>
<style>body{font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:48px 20px;color:#131922;background:#f5f7fa}main{max-width:440px;margin:0 auto}h1{font-size:22px;margin:0 0 12px}button{font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;border:0;background:#1f6bc4;color:#fff;cursor:pointer}a{color:#1f6bc4}@media (prefers-color-scheme:dark){body{background:#16181c;color:#f2f4f7}a{color:#8ab8f0}}</style>
</head><body><main>${body}<p><a href="/regattas">Open Recall</a></p></main></body></html>`,
    {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': UNSUB_PAGE_CSP },
    },
  );

const badLink = (): Response => page(400, "<h1>Race emails</h1><p>This link isn't valid. You can turn race emails off from your account in Recall.</p>");

/** "A", "A and B", "A, B and C": the events' titles, escaped and bold ('this regatta' for one not known). */
async function titlesHtml(db: D1Like, eventIds: readonly string[]): Promise<string> {
  const titles = await Promise.all(eventIds.map(async (id) => `<strong>${escHtml((await eventRow(db, id).catch(() => null))?.title || 'this regatta')}</strong>`));
  return titles.length < 2 ? titles.join('') : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

const UNAVAILABLE = '<h1>Race emails</h1><p>This is unavailable right now. Try again in a minute.</p>';

export async function handleUnsubscribe(ctx: AlertsCtx): Promise<Response> {
  const { request: req, env } = ctx;
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') return methodNotAllowed('GET, POST');
  const db = env.AUTH_DB;
  if (!db) return page(503, UNAVAILABLE);
  const raw = new URL(req.url).searchParams.get('t');
  const t = await readUnsub(env.AUTH_SECRET, raw);
  if (!t) return badLink();
  try {
    const ids = t.subs.map((x) => x.eventId);
    const current = new Map(
      (
        await db
          .prepare(`SELECT event_id, created_at FROM race_alert_subs WHERE user_id = ? AND event_id IN (${ids.map(() => '?').join(', ')})`)
          .bind(t.userId, ...ids)
          .all<{ event_id: string; created_at: number }>()
      ).results.map((r) => [r.event_id, r.created_at]),
    );
    // Still the subscription the email was sent for; or turned back on since (a newer one, left alone).
    const live = t.subs.filter((x) => current.get(x.eventId) === x.version);
    const newer = t.subs.filter((x) => current.has(x.eventId) && current.get(x.eventId) !== x.version);
    if (method === 'GET' && live.length) {
      return page(
        200,
        `<h1>Turn off race emails?</h1><p>You get an email when races are posted for ${await titlesHtml(db, live.map((x) => x.eventId))}.</p>
<form method="post" action="${escHtml(`${UNSUB_PATH}?t=${encodeURIComponent(raw!)}`)}"><button type="submit">Turn off race emails</button></form>`,
      );
    }
    const off: string[] = [];
    if (method === 'POST') {
      for (const x of live) {
        const r = await db.prepare('DELETE FROM race_alert_subs WHERE user_id = ? AND event_id = ? AND created_at = ?').bind(t.userId, x.eventId, x.version).run();
        if (r.meta?.changes) off.push(x.eventId);
      }
    }
    if (off.length) return page(200, `<h1>Race emails are off</h1><p>You won't get any more race emails for ${await titlesHtml(db, off)}.</p>`);
    if (newer.length) {
      return page(
        200,
        `<h1>Race emails are still on</h1><p>This link is from an older email. You turned race emails back on for ${await titlesHtml(db, newer.map((x) => x.eventId))} after it was sent, so nothing changed. To turn them off, use the link in your latest race email or your account in Recall.</p>`,
      );
    }
    return page(200, `<h1>Race emails are already off</h1><p>You won't get any more race emails for ${await titlesHtml(db, ids)}.</p>`);
  } catch {
    return page(503, UNAVAILABLE);
  }
}
