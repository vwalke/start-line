/**
 * One run of the recall-race-alerts Worker (README "Race emails"; the cron in ../wrangler.toml). Every
 * run, within the bounds (RunLimits, deps.bounds):
 *
 *  1. The subscribed events whose dates are in the window (a day before the first day to two days after
 *     the last), least recently checked first.
 *  2. For each one with subscribers, its RaceSense document (the Pages proxy's upstream) and its posted
 *     races (functions/_alerts.ts postedRaces). New ones go into race_alert_seen (first_seen_at = now).
 *  3. An event never baselined: its races are recorded and nobody is mailed (they were posted before
 *     anyone asked). Otherwise each subscriber gets one email per race first seen after the baseline
 *     and after they subscribed (and within MAX_LATE_MS), oldest race first.
 *  4. De-dup: a race_alert_sent row is claimed (INSERT OR IGNORE, 'pending') before the send, then marked
 *     'sent' or 'failed'. A second run, a retry or a crash between claim and send never mails twice; a
 *     claimed email whose send failed or never happened is not retried (at most once, by design).
 *
 * Mail goes out through the sign-in mailer (functions/_auth.ts sendEmail: EMAIL_PROVIDER and friends).
 * The email names no one: the event, division, race number, gun time and two links.
 */
import { sendEmail, type AuthDeps, type Mail } from '../../../functions/_auth';
import { userById, type UserRow } from '../../../functions/_authDb';
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
  /** Emails sent per run. */
  emails: number;
  /** Stop starting new work after this long, ms. */
  ms: number;
}

export const DEFAULT_LIMITS: RunLimits = { events: 25, emails: 200, ms: 25_000 };
/** A race first seen longer ago than this is no longer mailed (after an outage, say). */
export const MAX_LATE_MS = DAY_MS;
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
  sent: number;
  failed: number;
  stopped?: 'events' | 'emails' | 'time';
}

interface EventRow {
  event_id: string;
  title: string;
  baselined_at: number | null;
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

/** "Race 3 is up: 2026 J/70 North Americans" (the division too when the event has more than one). */
export function raceSubject(title: string, r: Pick<PostedRace, 'division' | 'number'>, multiDivision: boolean): string {
  return `Race ${r.number}${multiDivision ? ` (${r.division})` : ''} is up: ${title}`;
}

/** The email: plain text and simple HTML, every value escaped, with List-Unsubscribe headers (RFC 8058). */
export function raceMail(o: { to: string; title: string; eventId: string; race: PostedRace; multiDivision: boolean; origin: string; unsubUrl: string }): Mail {
  const { race: r } = o;
  const subject = raceSubject(o.title, r, o.multiDivision);
  const link = raceLink(o.origin, o.eventId, r);
  const line = `${r.division} · Race ${r.number} · Gun ${venueTime(r.gunMs, r.tzOffsetMs)} local time`;
  const why = 'You asked Recall to email you when races are posted for this regatta.';
  const text = `Race ${r.number} is up.\n\n${o.title}\n${line}\n\nOpen it in Recall:\n${link}\n\n${why}\nTurn these emails off: ${o.unsubUrl}\n`;
  const a = (href: string, label: string): string => `<a href="${escHtml(href)}" style="color:#1f6bc4">${escHtml(label)}</a>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f7fa;font-family:Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#131922">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde3ea;border-radius:8px;padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#5b6675">Recall</p>
<h1 style="margin:0 0 12px;font-size:22px">Race ${escHtml(String(r.number))} is up</h1>
<p style="margin:0 0 4px;font-size:16px"><strong>${escHtml(o.title)}</strong></p>
<p style="margin:0 0 20px;font-size:15px">${escHtml(line)}</p>
<p style="margin:0 0 24px"><a href="${escHtml(link)}" style="display:inline-block;background:#1f6bc4;color:#ffffff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:8px">Open it in Recall</a></p>
<p style="margin:0;font-size:13px;color:#5b6675">${escHtml(why)} ${a(o.unsubUrl, 'Turn these emails off')}.</p>
</div></body></html>`;
  return { to: o.to, subject, text, html, headers: { 'List-Unsubscribe': `<${o.unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

export async function runRaceAlerts(env: AlertsWorkerEnv, deps: RunDeps = {}): Promise<RunReport> {
  const report: RunReport = { events: 0, baselined: 0, sent: 0, failed: 0 };
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
  const users = new Map<string, UserRow | null>();
  const userOf = async (id: string): Promise<UserRow | null> => {
    if (!users.has(id)) users.set(id, await userById(db, id));
    return users.get(id)!;
  };

  const rows = (
    await db
      .prepare(`SELECT event_id, title, baselined_at FROM race_alert_events WHERE end_ms >= ? AND start_ms <= ? ORDER BY checked_at LIMIT ${EVENT_ROWS}`)
      .bind(now - WINDOW_AFTER_MS, now + WINDOW_BEFORE_MS)
      .all<EventRow>()
  ).results;

  for (const ev of rows) {
    if (report.stopped) break;
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
    await recordEvent(db, ev.event_id, got.doc, now, races);
    // Never baselined: what's posted now was posted before anyone could be told.
    if (ev.baselined_at == null) {
      report.baselined++;
      continue;
    }
    const seen = new Map(
      (await db.prepare('SELECT race_key, first_seen_at FROM race_alert_seen WHERE event_id = ?').bind(ev.event_id).all<{ race_key: string; first_seen_at: number }>()).results.map((r) => [r.race_key, r.first_seen_at]),
    );
    const sent = new Set(
      (await db.prepare('SELECT user_id, race_key FROM race_alert_sent WHERE event_id = ?').bind(ev.event_id).all<{ user_id: string; race_key: string }>()).results.map((r) => `${r.user_id} ${r.race_key}`),
    );
    const title = (await db.prepare('SELECT title FROM race_alert_events WHERE event_id = ?').bind(ev.event_id).first<{ title: string }>())?.title || ev.title;
    const multiDivision = new Set(got.doc.divisions.map((d) => d.name)).size > 1;
    for (const race of races) {
      const first = seen.get(race.key);
      // Recorded by the baseline (first seen at baselined_at): posted before anyone could be told.
      if (first == null || first <= ev.baselined_at || now - first > MAX_LATE_MS) continue;
      for (const sub of subs) {
        if (first <= sub.created_at || sent.has(`${sub.user_id} ${race.key}`)) continue;
        if (report.sent + report.failed >= limits.emails) {
          report.stopped = 'emails';
          break;
        }
        if (outOfTime()) {
          report.stopped = 'time';
          break;
        }
        const user = await userOf(sub.user_id);
        if (!user) continue;
        // Claimed before the send: if this row was already there, someone else has it.
        const claim = await db
          .prepare("INSERT OR IGNORE INTO race_alert_sent (user_id, event_id, race_key, sent_at, status) VALUES (?, ?, ?, ?, 'pending')")
          .bind(sub.user_id, ev.event_id, race.key, now)
          .run();
        if (!claim.meta?.changes) continue;
        const token = await signUnsub(secret, sub.user_id, ev.event_id);
        const mail = raceMail({ to: user.email, title, eventId: ev.event_id, race, multiDivision, origin, unsubUrl: unsubLink(origin, token) });
        const r = await sendEmail(env, host, mail, deps);
        if (r.ok) report.sent++;
        else report.failed++;
        await db
          .prepare('UPDATE race_alert_sent SET status = ?, error = ? WHERE user_id = ? AND event_id = ? AND race_key = ?')
          .bind(r.ok ? 'sent' : 'failed', r.ok ? null : r.error.slice(0, 200), sub.user_id, ev.event_id, race.key)
          .run();
      }
      if (report.stopped) break;
    }
  }
  return report;
}
