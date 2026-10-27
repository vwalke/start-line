/**
 * One run of the recall-race-alerts Worker (README "Race emails"; the cron in ../wrangler.toml). Every
 * run, within the bounds (RunLimits, deps.bounds):
 *
 *  1. The subscribed events whose dates are in the window (a day before the first day to two days after
 *     the last), least recently checked first.
 *  2. For each one with subscribers, its RaceSense document (the Pages proxy's upstream) and its posted
 *     races (functions/_alerts.ts postedRaces). New ones go into race_alert_seen (first_seen_at = now).
 *  3. An event not read in the last STALE_MS (never, or it just came into its window, or after an outage):
 *     its races are recorded and nobody is mailed (baselined_at = now). Otherwise a subscriber is due each
 *     race first seen after the baseline and after they subscribed, whose gun was after they subscribed
 *     too, within MAX_LATE_MS. So nobody gets a pile of races that were posted before the Worker watched.
 *  4. One email per user per run: every race due to them, across all the events they follow, grouped by
 *     event (combinedMail). Emails count against limits.emails; the rest go next run.
 *  5. De-dup: each race is claimed for the user in race_alert_sent (INSERT OR IGNORE, 'pending') before the
 *     send, and the email lists only the races this run claimed; then 'sent' or 'failed'. A failed send is
 *     claimed again by a later run (up to MAX_ATTEMPTS, while within MAX_LATE_MS); a 'pending' row (a crash
 *     between claim and send) is never retried, so nothing is mailed twice.
 *
 * Mail goes out through the sign-in mailer (functions/_auth.ts sendEmail: EMAIL_PROVIDER and friends).
 * The email names no one and no boats: the events, divisions, race numbers, gun times and links.
 */
import { sendEmail, type AuthDeps, type Mail } from '../../../functions/_auth';
import { userById, type D1Like, type UserRow } from '../../../functions/_authDb';
import {
  DAY_MS,
  UNSUB_PATH,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  escHtml,
  fetchRegattaDoc,
  postedRaces,
  recordEvent,
  signUnsub,
  type PostedRace,
} from '../../../functions/_alerts';
import { paywallOn, type PaywallEnv } from '../../../functions/_paywall';

export interface AlertsWorkerEnv extends PaywallEnv {
  /** Where the email's links point (default https://recall.walkeforward.com). */
  APP_ORIGIN?: string;
}

export interface RunLimits {
  /** Events fetched per run. */
  events: number;
  /** Emails sent per run (one per user). */
  emails: number;
  /** Stop starting new work after this long, ms. */
  ms: number;
}

export const DEFAULT_LIMITS: RunLimits = { events: 25, emails: 200, ms: 25_000 };
/** A race first seen longer ago than this is no longer mailed (after an outage, say). */
export const MAX_LATE_MS = DAY_MS;
/** An event not read for this long is read again silently (its races recorded, nobody mailed). */
export const STALE_MS = 3_600_000;
/** Sends tried per user and race before giving up (a bad address, say). */
export const MAX_ATTEMPTS = 3;
/** The List-Unsubscribe header's longest value (bytes); a longer one is left out. */
export const MAX_UNSUB_HEADER = 2_000;
export const DEFAULT_ORIGIN = 'https://recall.walkeforward.com';
/** Candidate events read per run (some may have no subscribers left). */
const EVENT_ROWS = 200;

export interface RunDeps extends AuthDeps {
  bounds?: Partial<RunLimits>;
  /** The time budget's clock (default Date.now); `now` stays the run's single timestamp. */
  clock?: () => number;
}

export interface RunReport {
  skipped?: 'off' | 'not_configured';
  events: number;
  baselined: number;
  /** Emails sent, and failed. */
  sent: number;
  failed: number;
  /** Races in the emails sent. */
  races: number;
  stopped?: 'events' | 'emails' | 'time';
}

interface EventRow {
  event_id: string;
  title: string;
  baselined_at: number | null;
  synced_at: number | null;
}

/** One event's part of a user's email. */
export interface MailEvent {
  eventId: string;
  title: string;
  /** More than one division: each race names its own. */
  multiDivision: boolean;
  races: PostedRace[];
  /** This event's "Turn off emails for this regatta" link. */
  unsubUrl: string;
}

interface Due {
  eventId: string;
  title: string;
  multiDivision: boolean;
  /** The subscription's created_at: the unsubscribe token's version. */
  version: number;
  races: PostedRace[];
}

const originOf = (env: AlertsWorkerEnv): string => {
  try {
    const u = new URL(env.APP_ORIGIN?.trim() || DEFAULT_ORIGIN);
    return u.protocol === 'https:' || u.hostname === 'localhost' ? u.origin : DEFAULT_ORIGIN;
  } catch {
    return DEFAULT_ORIGIN;
  }
};

/** "Wed, Oct 28, 11:05 AM" on the venue's clock. */
export const venueTime = (ms: number, tzOffsetMs: number): string =>
  new Date(ms + tzOffsetMs).toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const raceLink = (origin: string, eventId: string, r: Pick<PostedRace, 'division' | 'rsNumber'>): string =>
  `${origin}/?${new URLSearchParams({ event: eventId, div: r.division, race: String(r.rsNumber) })}`;

export const unsubLink = (origin: string, token: string): string => `${origin}${UNSUB_PATH}?t=${encodeURIComponent(token)}`;

/** "Race 3", or "Race 3 (J70)" when the event has more than one division. */
const raceName = (r: Pick<PostedRace, 'division' | 'number'>, multiDivision: boolean): string => `Race ${r.number}${multiDivision ? ` (${r.division})` : ''}`;

/**
 * The subject. One race: "Race 3 is up: <event>". Several in one event: "Races 4 and 5 are up: <event>",
 * "Races 3–5 are up: <event>" for a run, else "3 new races: <event>". Several events: "5 new races: <first
 * event> and 1 more".
 */
export function mailSubject(events: readonly Pick<MailEvent, 'title' | 'multiDivision' | 'races'>[]): string {
  const total = events.reduce((n, e) => n + e.races.length, 0);
  const [first] = events;
  if (events.length > 1) return `${total} new races: ${first.title} and ${events.length - 1} more`;
  if (total === 1) return `${raceName(first.races[0], first.multiDivision)} is up: ${first.title}`;
  const nums = first.races.map((r) => r.number).sort((a, b) => a - b);
  if (!first.multiDivision && new Set(nums).size === nums.length) {
    if (nums.length === 2) return `Races ${nums[0]} and ${nums[1]} are up: ${first.title}`;
    if (nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)) return `Races ${nums[0]}–${nums[nums.length - 1]} are up: ${first.title}`;
  }
  return `${total} new races: ${first.title}`;
}

/** A race's line: "Race 4 · Gun Wed, Oct 28, 11:05 AM local time" (the division first when there are several). */
const raceLine = (r: PostedRace, multiDivision: boolean): string => `${multiDivision ? `${r.division} · ` : ''}Race ${r.number} · Gun ${venueTime(r.gunMs, r.tzOffsetMs)} local time`;

/**
 * The email: every race due to one user, grouped by event (each event's races in gun order, a link each, and
 * the event's own unsubscribe link). Plain text and simple HTML, every value escaped. `listUnsubUrl`: the
 * List-Unsubscribe link (RFC 8058): the event's own for one event, one for all of them for several; left
 * out when it would be too long for the header.
 */
export function combinedMail(o: { to: string; origin: string; events: readonly MailEvent[]; listUnsubUrl: string }): Mail {
  const events = [...o.events].map((e) => ({ ...e, races: [...e.races].sort((a, b) => a.gunMs - b.gunMs) }));
  const subject = mailSubject(events);
  const total = events.reduce((n, e) => n + e.races.length, 0);
  const lead = total === 1 ? `${raceName(events[0].races[0], events[0].multiDivision)} is up.` : `${total} new races are up.`;
  const why = `You asked Recall to email you when races are posted for ${events.length === 1 ? 'this regatta' : 'these regattas'}.`;
  const OFF = 'Turn off emails for this regatta';
  const text = `${lead}\n\n${events
    .map((e) => `${e.title}\n\n${e.races.map((r) => `${raceLine(r, e.multiDivision)}\n${raceLink(o.origin, e.eventId, r)}\n`).join('\n')}\n${OFF}:\n${e.unsubUrl}\n`)
    .join('\n')}\n${why}\n`;
  const a = (href: string, label: string, style = 'color:#1f6bc4'): string => `<a href="${escHtml(href)}" style="${style}">${escHtml(label)}</a>`;
  const sections = events
    .map(
      (e) => `<h2 style="margin:20px 0 8px;font-size:17px">${escHtml(e.title)}</h2>
<ul style="margin:0 0 8px;padding:0;list-style:none">${e.races
        .map((r) => `<li style="margin:0 0 8px;font-size:15px">${escHtml(raceLine(r, e.multiDivision))}<br>${a(raceLink(o.origin, e.eventId, r), 'Open it in Recall')}</li>`)
        .join('')}</ul>
<p style="margin:0 0 4px;font-size:13px">${a(e.unsubUrl, OFF, 'color:#5b6675')}</p>`,
    )
    .join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f7fa;font-family:Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#131922">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde3ea;border-radius:8px;padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#5b6675">Recall</p>
<h1 style="margin:0 0 4px;font-size:22px">${escHtml(lead)}</h1>
${sections}
<p style="margin:20px 0 0;font-size:13px;color:#5b6675">${escHtml(why)}</p>
</div></body></html>`;
  const header = `<${o.listUnsubUrl}>`;
  const headers = new TextEncoder().encode(header).length <= MAX_UNSUB_HEADER ? { 'List-Unsubscribe': header, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined;
  return { to: o.to, subject, text, html, ...(headers ? { headers } : {}) };
}

/**
 * Claim `race` for the user before the send: a new 'pending' row, or a failed one with attempts to spare
 * (compare-and-swap on its attempts). False: someone else has it, it went, or it gave up.
 */
async function claim(db: D1Like, userId: string, eventId: string, raceKey: string, now: number): Promise<boolean> {
  const fresh = await db
    .prepare('INSERT OR IGNORE INTO race_alert_sent (user_id, event_id, race_key, sent_at, status, attempts) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, eventId, raceKey, now, 'pending', 1)
    .run();
  if (fresh.meta?.changes) return true;
  const row = await db
    .prepare('SELECT status, attempts FROM race_alert_sent WHERE user_id = ? AND event_id = ? AND race_key = ?')
    .bind(userId, eventId, raceKey)
    .first<{ status: string; attempts: number }>();
  if (!row || row.status !== 'failed' || row.attempts >= MAX_ATTEMPTS) return false;
  const again = await db
    .prepare('UPDATE race_alert_sent SET status = ?, attempts = ?, sent_at = ?, error = ? WHERE user_id = ? AND event_id = ? AND race_key = ? AND status = ? AND attempts = ?')
    .bind('pending', row.attempts + 1, now, null, userId, eventId, raceKey, 'failed', row.attempts)
    .run();
  return !!again.meta?.changes;
}

export async function runRaceAlerts(env: AlertsWorkerEnv, deps: RunDeps = {}): Promise<RunReport> {
  const report: RunReport = { events: 0, baselined: 0, sent: 0, failed: 0, races: 0 };
  if (!paywallOn(env)) return { ...report, skipped: 'off' };
  const db = env.AUTH_DB;
  const secret = env.AUTH_SECRET?.trim();
  if (!db || !secret) return { ...report, skipped: 'not_configured' };
  const limits = { ...DEFAULT_LIMITS, ...deps.bounds };
  const now = (deps.now ?? Date.now)();
  const clock = deps.clock ?? Date.now;
  const t0 = clock();
  const outOfTime = (): boolean => clock() - t0 >= limits.ms;
  const origin = originOf(env);
  const host = new URL(origin).host;
  /** Per user, what each event owes them this run, in the order found. */
  const due = new Map<string, Due[]>();

  const rows = (
    await db
      .prepare(`SELECT event_id, title, baselined_at, synced_at FROM race_alert_events WHERE end_ms >= ? AND start_ms <= ? ORDER BY checked_at LIMIT ${EVENT_ROWS}`)
      .bind(now - WINDOW_AFTER_MS, now + WINDOW_BEFORE_MS)
      .all<EventRow>()
  ).results;

  for (const ev of rows) {
    const subs = (await db.prepare('SELECT user_id, created_at FROM race_alert_subs WHERE event_id = ?').bind(ev.event_id).all<{ user_id: string; created_at: number }>()).results;
    if (!subs.length) continue;
    if (report.events >= limits.events) {
      report.stopped = 'events';
      break;
    }
    if (outOfTime()) {
      report.stopped = 'time';
      break;
    }
    report.events++;
    await db.prepare('UPDATE race_alert_events SET checked_at = ? WHERE event_id = ?').bind(now, ev.event_id).run();
    const got = await fetchRegattaDoc(ev.event_id, deps.fetch);
    if (got.kind !== 'ok') continue;
    const races = postedRaces(got.doc, now);
    // Not read lately: what's posted now may have been posted while nobody watched. Record it, mail nothing.
    const baseline = ev.synced_at == null || now - ev.synced_at > STALE_MS;
    await recordEvent(db, ev.event_id, got.doc, now, races, { baseline });
    if (baseline) {
      report.baselined++;
      continue;
    }
    const seen = new Map(
      (await db.prepare('SELECT race_key, first_seen_at FROM race_alert_seen WHERE event_id = ?').bind(ev.event_id).all<{ race_key: string; first_seen_at: number }>()).results.map((r) => [r.race_key, r.first_seen_at]),
    );
    const fresh = races.filter((r) => {
      const first = seen.get(r.key);
      return first != null && (ev.baselined_at == null || first > ev.baselined_at) && now - first <= MAX_LATE_MS;
    });
    if (!fresh.length) continue;
    // Done with: sent, claimed by a run that may still be sending (or crashed), or failed too often.
    const done = new Set(
      (await db.prepare('SELECT user_id, race_key, status, attempts FROM race_alert_sent WHERE event_id = ?').bind(ev.event_id).all<{ user_id: string; race_key: string; status: string; attempts: number }>()).results
        .filter((r) => r.status !== 'failed' || r.attempts >= MAX_ATTEMPTS)
        .map((r) => `${r.user_id} ${r.race_key}`),
    );
    const title = (await db.prepare('SELECT title FROM race_alert_events WHERE event_id = ?').bind(ev.event_id).first<{ title: string }>())?.title || ev.title;
    const multiDivision = new Set(got.doc.divisions.map((d) => d.name)).size > 1;
    for (const sub of subs) {
      // Only races that started and first showed up after they subscribed.
      const mine = fresh.filter((r) => seen.get(r.key)! > sub.created_at && r.gunMs > sub.created_at && !done.has(`${sub.user_id} ${r.key}`));
      if (!mine.length) continue;
      const list = due.get(sub.user_id) ?? [];
      list.push({ eventId: ev.event_id, title, multiDivision, version: sub.created_at, races: mine });
      due.set(sub.user_id, list);
    }
  }

  for (const [userId, owed] of due) {
    if (report.sent + report.failed >= limits.emails) {
      report.stopped = 'emails';
      break;
    }
    if (outOfTime()) {
      report.stopped = 'time';
      break;
    }
    const user: UserRow | null = await userById(db, userId);
    if (!user) continue;
    // Claimed before the send: a race another run already has stays out of this email.
    const events: Due[] = [];
    for (const d of owed) {
      const mine: PostedRace[] = [];
      for (const r of d.races) if (await claim(db, userId, d.eventId, r.key, now)) mine.push(r);
      if (mine.length) events.push({ ...d, races: mine });
    }
    if (!events.length) continue;
    events.sort((a, b) => Math.min(...a.races.map((r) => r.gunMs)) - Math.min(...b.races.map((r) => r.gunMs)));
    const mailEvents: MailEvent[] = [];
    for (const d of events) {
      const token = await signUnsub(secret, userId, [{ eventId: d.eventId, version: d.version }]);
      mailEvents.push({ eventId: d.eventId, title: d.title, multiDivision: d.multiDivision, races: d.races, unsubUrl: unsubLink(origin, token) });
    }
    const listUnsubUrl =
      events.length === 1 ? mailEvents[0].unsubUrl : unsubLink(origin, await signUnsub(secret, userId, events.map((d) => ({ eventId: d.eventId, version: d.version }))));
    const mail = combinedMail({ to: user.email, origin, events: mailEvents, listUnsubUrl });
    const r = await sendEmail(env, host, mail, deps);
    const count = events.reduce((n, d) => n + d.races.length, 0);
    if (r.ok) {
      report.sent++;
      report.races += count;
    } else report.failed++;
    await db.batch(
      events.flatMap((d) =>
        d.races.map((race) =>
          db
            .prepare('UPDATE race_alert_sent SET status = ?, error = ? WHERE user_id = ? AND event_id = ? AND race_key = ?')
            .bind(r.ok ? 'sent' : 'failed', r.ok ? null : r.error.slice(0, 200), userId, d.eventId, race.key),
        ),
      ),
    );
  }
  return report;
}
