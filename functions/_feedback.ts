/**
 * Feedback: the handler behind functions/api/feedback.ts (kept in a `_` file so tests call it directly).
 * It works with the paywall on or off; it needs the AUTH_DB binding (503 without it).
 *
 *   GET  /api/feedback   { ok, ready, signedIn, turnstileSiteKey }   what the sheet needs (no-store)
 *   POST /api/feedback   { type, message, email?, context, image?, map?, turnstileToken? } → { ok, id }
 *
 * The page sends what it saw (context: URL, view, device, recent errors; src/feedback/context.ts) and up
 * to two images (base64: the upload and the course map). The server checks and caps all of it, then
 * adds what the page can't be trusted with: the signed-in user, their email and session (from the
 * cookie only), a salted SHA-256 of the IP, Cloudflare's country and colo, the time and user agent.
 * Rate limits share auth_rate_limits: 10 an hour per IP, 10 per signed-in user. Turnstile is checked
 * when both its keys are set. One row in `feedback` (migrations/0004_feedback.sql); images go to
 * VKX_BUCKET under feedback/<id>/ when it is bound (else the row says why they were left out). Each
 * address in FEEDBACK_TO gets an email through the sign-in mailer; a failed email never fails the
 * submission (emailed_at / email_error record how it went).
 */
import { countRateHit, newId, normEmail, pruneRateLimits, liveSession, userById, validEmail, type D1Like, type SessionRow, type UserRow } from './_authDb';
import { crossSite, sendEmail, turnstileReady, verifyTurnstile, type AuthDeps, type Mail } from './_auth';
import { jsonOut, readCookie, SESSION_COOKIE, TOKEN_RE, tokenHash, type PaywallEnv } from './_paywall';
import { readCapped, type R2BucketLike } from './_vkx';
import { sha256Hex } from '../src/data/vkx/compact';

export interface FeedbackEnv extends PaywallEnv {
  VKX_BUCKET?: R2BucketLike;
  /** Where each submission is emailed: a comma-separated list (bad entries are skipped; none: no email). */
  FEEDBACK_TO?: string;
}

export interface FeedbackCtx {
  request: Request;
  env: FeedbackEnv;
  waitUntil?(p: Promise<unknown>): void;
}

export interface FeedbackDeps extends AuthDeps {
  /** Per hour; null skips the limits. */
  feedbackLimits?: { ip: number; user: number } | null;
}

export const FEEDBACK_TYPES = ['bug', 'idea', 'data', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export const TYPE_LABEL: Record<FeedbackType, string> = { bug: 'Bug', idea: 'Idea', data: 'Data looks wrong', other: 'Other' };

export const MESSAGE_MAX = 4_000;
export const CONTEXT_MAX_BYTES = 32_768;
export const IMAGE_MAX_BYTES = 2_500_000;
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/** Two base64 images (4/3 of their bytes), the context and the message, with room to spare. */
export const BODY_MAX_BYTES = Math.ceil((IMAGE_MAX_BYTES * 2 * 4) / 3) + CONTEXT_MAX_BYTES + 64_000;
export const IP_LIMIT = 10;
export const USER_LIMIT = 10;
const PRUNE_CHANCE = 0.01;

const fail = (status: number, error: string, message: string): Response => jsonOut(status, { ok: false, error, message });

// ---- input

/** FEEDBACK_TO as a list of checked, lower-cased, distinct addresses. */
export function feedbackRecipients(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const e = normEmail(part);
    if (e && validEmail(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export interface ImageIn {
  type: string;
  bytes: Uint8Array;
}

/** `{ type, data }` (base64) → the bytes, or a reason it can't be taken. */
export function readImage(v: unknown): ImageIn | string | null {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'That image could not be read.';
  const { type, data } = v as { type?: unknown; data?: unknown };
  if (typeof type !== 'string' || !(type in IMAGE_TYPES)) return 'Images can be PNG, JPEG or WebP.';
  if (typeof data !== 'string' || !data || data.length > Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 4) return 'That image is too big (2.5 MB at most).';
  let bin: string;
  try {
    bin = atob(data);
  } catch {
    return 'That image could not be read.';
  }
  if (bin.length > IMAGE_MAX_BYTES) return 'That image is too big (2.5 MB at most).';
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!sniff(bytes, type)) return "That file doesn't look like the image it says it is.";
  return { type, bytes };
}

/** The bytes start like the type they claim. */
function sniff(b: Uint8Array, type: string): boolean {
  const at = (i: number, ...xs: number[]): boolean => xs.every((x, j) => b[i + j] === x);
  if (type === 'image/png') return at(0, 0x89, 0x50, 0x4e, 0x47);
  if (type === 'image/jpeg') return at(0, 0xff, 0xd8, 0xff);
  return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
}

export interface FeedbackIn {
  type: FeedbackType;
  message: string;
  email: string | null;
  context: Record<string, unknown>;
  contextJson: string;
  image: ImageIn | null;
  map: ImageIn | null;
  turnstileToken: string | null;
}

/** The checked submission, or the 4xx to answer. */
export function parseFeedback(body: Record<string, unknown> | null): FeedbackIn | Response {
  if (!body) return fail(400, 'bad_request', "That didn't come through right. Try again.");
  const type = body.type;
  if (typeof type !== 'string' || !(FEEDBACK_TYPES as readonly string[]).includes(type)) return fail(400, 'bad_type', 'Pick what the feedback is about.');
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return fail(400, 'no_message', 'Write a few words first.');
  if (message.length > MESSAGE_MAX) return fail(400, 'too_long', `That's over ${MESSAGE_MAX.toLocaleString('en-US')} characters. Shorten it a little.`);
  let email: string | null = null;
  if (body.email != null && body.email !== '') {
    email = typeof body.email === 'string' ? normEmail(body.email) : '';
    if (!validEmail(email)) return fail(400, 'bad_email', 'That email address doesn’t look right.');
  }
  const ctx = body.context ?? {};
  if (typeof ctx !== 'object' || Array.isArray(ctx) || ctx === null) return fail(400, 'bad_context', "That didn't come through right. Try again.");
  const contextJson = JSON.stringify(ctx);
  if (new TextEncoder().encode(contextJson).length > CONTEXT_MAX_BYTES) return fail(413, 'context_too_big', "That didn't come through right. Try again.");
  const image = readImage(body.image);
  if (typeof image === 'string') return fail(400, 'bad_image', image);
  const map = readImage(body.map);
  if (typeof map === 'string') return fail(400, 'bad_image', `The map: ${map}`);
  const t = body.turnstileToken;
  return {
    type: type as FeedbackType,
    message,
    email,
    context: ctx as Record<string, unknown>,
    contextJson,
    image,
    map,
    turnstileToken: typeof t === 'string' && t && t.length <= 2048 ? t : null,
  };
}

// ---- who and where (the server's own word, never the page's)

interface Who {
  user: UserRow | null;
  session: SessionRow | null;
}

async function whoIs(req: Request, db: D1Like, now: number): Promise<Who> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !TOKEN_RE.test(token)) return { user: null, session: null };
  try {
    const session = await liveSession(db, await tokenHash('session', token), now);
    const user = session ? await userById(db, session.user_id) : null;
    return user ? { user, session } : { user: null, session: null };
  } catch {
    return { user: null, session: null };
  }
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** SHA-256 of the IP, salted with a hash of AUTH_SECRET when there is one (plain SHA-256 otherwise). */
export async function ipHash(ip: string, secret: string | undefined): Promise<string> {
  const s = secret?.trim();
  return sha256Hex(enc(s ? `recall-feedback-ip:${await sha256Hex(enc(`salt:${s}`))}:${ip}` : ip));
}

interface CfProps {
  country?: unknown;
  colo?: unknown;
}

const cfOf = (req: Request): { country: string | null; colo: string | null } => {
  const cf = (req as Request & { cf?: CfProps }).cf;
  const code = (v: unknown, n: number): string | null => (typeof v === 'string' && /^[A-Za-z0-9]{2,8}$/.test(v) ? v.slice(0, n) : null);
  return { country: code(cf?.country, 2), colo: code(cf?.colo, 8) };
};

// ---- email

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** One line, no control characters (for a subject or a header-ish line). */
const oneLine = (s: string, max: number): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const get = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
const text = (v: unknown, max = 300): string => (typeof v === 'string' ? oneLine(v, max) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

export interface StoredFeedback {
  id: string;
  type: FeedbackType;
  message: string;
  email: string | null;
  userId: string | null;
  url: string | null;
  context: Record<string, unknown>;
  appCommit: string | null;
  country: string | null;
  userAgent: string | null;
  images: { what: string; key: string | null; type: string; bytes: number; note?: string }[];
}

/** The page URL as a link, only when it is an http(s) URL. */
const safeHref = (u: string | null): string | null => {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch {
    return null;
  }
};

/** The email for one submission: plain text and simple HTML, everything the page sent escaped. */
export function feedbackMail(to: string, f: StoredFeedback): Mail {
  const title = text(get(f.context, 'where', 'eventTitle'), 80) || text(get(f.context, 'where', 'path'), 80) || (f.url ? oneLine(f.url, 80) : 'Recall');
  const subject = `Recall feedback: ${TYPE_LABEL[f.type]} · ${title}`;
  const who = f.email ? (f.userId ? `${f.email} (user ${f.userId})` : `${f.email} (signed out)`) : f.userId ? `user ${f.userId}` : 'signed out';
  const d = (k: string): string => text(get(f.context, 'device', k), 200);
  const device = [d('platform'), d('viewport') && `viewport ${d('viewport')}`, d('screen') && `screen ${d('screen')}`, d('dpr') && `@${d('dpr')}x`, d('touch') === 'true' ? 'touch' : '', d('language'), d('timeZone')]
    .filter(Boolean)
    .join(' · ');
  const theme = [text(get(f.context, 'theme', 'resolved'), 20), text(get(f.context, 'theme', 'source'), 20)].filter(Boolean).join(', ') || 'unknown';
  const w = (k: string): string => text(get(f.context, 'where', k), 120);
  const where = [w('eventId') && `event ${w('eventId')}`, w('division') && `division ${w('division')}`, w('race') && `race ${w('race')}`, w('tab') && `tab ${w('tab')}`]
    .filter(Boolean)
    .join(' · ');
  const problems = Array.isArray(get(f.context, 'problems')) ? (get(f.context, 'problems') as unknown[]).slice(-20) : [];
  const problemLines = problems.map((p) => [text(get(p, 'at'), 30), text(get(p, 'kind'), 20), text(get(p, 'text'), 300)].filter(Boolean).join(' '));
  const href = safeHref(f.url);
  const imgs = f.images.map((i) => (i.key ? `${i.what}: ${i.type}, ${i.bytes.toLocaleString('en-US')} bytes, R2 key ${i.key}` : `${i.what}: not stored (${i.note ?? 'no bucket'})`));
  const rows: [string, string][] = [
    ['Type', TYPE_LABEL[f.type]],
    ['From', who],
    ['Where', where || '—'],
    ['Device', device || '—'],
    ['Browser', f.userAgent ? oneLine(f.userAgent, 300) : '—'],
    ['Theme', theme],
    ['App', f.appCommit ?? 'unknown'],
    ['Country', f.country ?? '—'],
    ['Feedback id', f.id],
  ];
  const lines = [
    `${TYPE_LABEL[f.type]} from ${who}`,
    '',
    f.message,
    '',
    `Page: ${f.url ?? '—'}`,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(imgs.length ? ['', 'Attached:', ...imgs.map((i) => `  ${i}`)] : []),
    '',
    problemLines.length ? 'Recent problems:' : 'Recent problems: none',
    ...problemLines.map((l) => `  ${l}`),
    '',
    `Full context: node scripts/feedback.mjs show ${f.id}`,
  ];
  const cell = 'padding:2px 12px 2px 0;vertical-align:top;';
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#131922;">
<p><strong>${esc(TYPE_LABEL[f.type])}</strong> from ${esc(who)}</p>
<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #1f6bc4;white-space:pre-wrap;">${esc(f.message)}</blockquote>
<p>Page: ${href ? `<a href="${esc(href)}">${esc(href)}</a>` : esc(f.url ?? '—')}</p>
<table style="border-collapse:collapse;">${rows.map(([k, v]) => `<tr><td style="${cell}color:#5b6675;">${esc(k)}</td><td style="${cell}">${esc(v)}</td></tr>`).join('')}</table>
${imgs.length ? `<p>Attached (in R2, no public link):</p><ul>${imgs.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
<p>${problemLines.length ? 'Recent problems:' : 'Recent problems: none'}</p>${problemLines.length ? `<pre style="font-size:12px;white-space:pre-wrap;">${esc(problemLines.join('\n'))}</pre>` : ''}
<p style="color:#5b6675;">Full context: <code>node scripts/feedback.mjs show ${esc(f.id)}</code></p>
</body></html>`;
  return { to, subject: oneLine(subject, 200), text: lines.join('\n'), html, ...(f.email ? { replyTo: f.email } : {}) };
}

// ---- routes

/** GET: whether the sheet can send, who is asking (signed in or not: the email field), and Turnstile's site key. */
export async function handleFeedbackInfo(ctx: FeedbackCtx, deps: FeedbackDeps = {}): Promise<Response> {
  const db = ctx.env.AUTH_DB;
  const now = (deps.now ?? Date.now)();
  const who = db ? await whoIs(ctx.request, db, now) : { user: null };
  return jsonOut(200, { ok: true, ready: !!db, signedIn: !!who.user, turnstileSiteKey: turnstileReady(ctx.env) ? ctx.env.TURNSTILE_SITE_KEY!.trim() : null });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null | 'too_big'> {
  const raw = await readCapped(req, BODY_MAX_BYTES);
  if (!raw) return 'too_big';
  try {
    const b = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function overLimit(ctx: FeedbackCtx, db: D1Like, ipKey: string, userId: string | null, deps: FeedbackDeps, now: number): Promise<boolean> {
  const lim = deps.feedbackLimits === undefined ? { ip: IP_LIMIT, user: USER_LIMIT } : deps.feedbackLimits;
  if (!lim) return false;
  const [byIp, byUser] = await Promise.all([countRateHit(db, `feedback-ip:${ipKey}`, now), userId ? countRateHit(db, `feedback-user:${userId}`, now) : 0]);
  if ((deps.random ?? Math.random)() < PRUNE_CHANCE) {
    const prune = pruneRateLimits(db, now).catch(() => undefined);
    if (ctx.waitUntil) ctx.waitUntil(prune);
    else await prune;
  }
  return byIp > lim.ip || byUser > lim.user;
}

const ctxStr = (c: Record<string, unknown>, key: string, max: number): string | null => str(get(c, 'where', key), max);

export async function handleFeedback(ctx: FeedbackCtx, deps: FeedbackDeps = {}): Promise<Response> {
  const env = ctx.env;
  const req = ctx.request;
  const db = env.AUTH_DB;
  if (!db) return fail(503, 'not_configured', "Feedback isn't set up on this site yet. Email us instead.");
  if (crossSite(req)) return fail(403, 'forbidden', "That didn't come from this site.");
  const body = await readJson(req);
  if (body === 'too_big') return fail(413, 'too_big', 'That was too big to send. Try a smaller image, or leave it out.');
  const f = parseFeedback(body);
  if (f instanceof Response) return f;

  if (turnstileReady(env)) {
    if (!f.turnstileToken) return fail(400, 'turnstile_failed', 'Please complete the check and try again.');
    const t = await verifyTurnstile(env, f.turnstileToken, req, deps);
    if (t === 'unavailable') return fail(503, 'turnstile_unavailable', "Couldn't check that you're human just now. Try again in a minute.");
    if (t === 'failed') return fail(400, 'turnstile_failed', 'Please complete the check and try again.');
  }

  const now = (deps.now ?? Date.now)();
  const who = await whoIs(req, db, now);
  const ip = await ipHash(req.headers.get('cf-connecting-ip') ?? 'local', env.AUTH_SECRET);
  try {
    if (await overLimit(ctx, db, ip, who.user?.id ?? null, deps, now)) return fail(429, 'rate_limited', "That's a lot of feedback in one hour. Try again later.");
  } catch {
    return fail(503, 'unavailable', "Couldn't save that just now. Try again in a minute.");
  }

  const id = newId();
  const { country, colo } = cfOf(req);
  const userAgent = str(req.headers.get('user-agent'), 400);
  // A signed-in sender is who their session says, whatever the page sent.
  const email = who.user ? normEmail(who.user.email) : f.email;
  const url = str(get(f.context, 'where', 'url'), 2_000);
  const appCommit = str(get(f.context, 'app', 'commit'), 40);

  // Images first (R2), so the row can say where they are.
  const bucket = env.VKX_BUCKET;
  const images: StoredFeedback['images'] = [];
  for (const [what, name, img] of [
    ['Image', 'image', f.image],
    ['Map', 'map', f.map],
  ] as const) {
    if (!img) continue;
    const key = `feedback/${id}/${name}.${IMAGE_TYPES[img.type]}`;
    if (!bucket) {
      images.push({ what, key: null, type: img.type, bytes: img.bytes.length, note: 'no R2 bucket bound here' });
      continue;
    }
    try {
      await bucket.put(key, img.bytes, { httpMetadata: { contentType: img.type }, customMetadata: { feedback: id } });
      images.push({ what, key, type: img.type, bytes: img.bytes.length });
    } catch {
      images.push({ what, key: null, type: img.type, bytes: img.bytes.length, note: "couldn't store it" });
    }
  }
  const upload = images.find((i) => i.what === 'Image');
  const map = images.find((i) => i.what === 'Map');
  const imageNote = images
    .filter((i) => !i.key)
    .map((i) => `${i.what.toLowerCase()} not stored: ${i.note}`)
    .join('; ');

  try {
    await db
      .prepare(
        'INSERT INTO feedback (id, created_at, type, message, email, user_id, session_public_id, ip_hash, country, colo, user_agent, url, event_id, division, race, app_commit, context_json, image_key, image_type, image_bytes, map_key, image_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        now,
        f.type,
        f.message,
        email,
        who.user?.id ?? null,
        who.session?.public_id ?? null,
        ip,
        country,
        colo,
        userAgent,
        url,
        ctxStr(f.context, 'eventId', 64),
        ctxStr(f.context, 'division', 120),
        ctxStr(f.context, 'race', 40),
        appCommit,
        f.contextJson,
        upload?.key ?? null,
        upload?.type ?? null,
        upload?.bytes ?? null,
        map?.key ?? null,
        imageNote || null,
      )
      .run();
  } catch {
    console.error('[recall feedback] insert failed');
    return fail(503, 'unavailable', "Couldn't save that just now. Try again in a minute.");
  }

  const to = feedbackRecipients(env.FEEDBACK_TO);
  if (to.length) {
    const stored: StoredFeedback = { id, type: f.type, message: f.message, email, userId: who.user?.id ?? null, url, context: f.context, appCommit, country, userAgent, images };
    const host = new URL(req.url).host;
    const errors: string[] = [];
    for (const addr of to) {
      try {
        const r = await sendEmail(env, host, feedbackMail(addr, stored), deps);
        if (!r.ok) errors.push(`${addr}: ${r.error}`);
      } catch {
        errors.push(`${addr}: send threw`);
      }
    }
    const sentAll = errors.length === 0;
    try {
      await db
        .prepare('UPDATE feedback SET emailed_at = ?, email_error = ? WHERE id = ?')
        .bind(errors.length < to.length ? now : null, sentAll ? null : errors.join('; ').slice(0, 1_000), id)
        .run();
    } catch {
      /* the row is saved; how the email went is best effort */
    }
    if (!sentAll) console.error(`[recall feedback] email failed for ${errors.length} of ${to.length} recipients`);
  }
  return jsonOut(200, { ok: true, id });
}
