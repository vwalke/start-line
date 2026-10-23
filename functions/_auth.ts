/**
 * Sign-in for the paywall: the handler behind functions/api/auth/[[path]].ts (kept in a `_` file so
 * tests call it directly). Every route, `GET me` included, answers the proxy's own 404 while
 * PAYWALL_ENABLED is off (the page reads that as "off" and shows nothing new).
 *
 *   GET  /api/auth/me               { paywall, user, entitlements, … } (no-store; reads D1 afresh)
 *   POST /api/auth/email            { email, returnTo } → a magic link by email (same answer whoever asks)
 *   GET  /api/auth/verify?token=    the link's page: a "Sign in to Recall" button (uses nothing, so a
 *                                   mail scanner's prefetch can't spend the link)
 *   POST /api/auth/verify           token (form, same origin only) → use it once: session cookie, 303 to returnTo
 *   GET  /api/auth/google/start     → Google (state, nonce and PKCE in a signed 10-minute cookie)
 *   GET  /api/auth/google/callback  code → Google's token endpoint → session cookie
 *   POST /api/auth/logout           end this browser's session
 *   POST /api/auth/restore          { email } → a magic link, if that email bought anything
 *
 * Sessions: a random 32-byte token in the `wf_session` cookie (Domain=AUTH_COOKIE_DOMAIN, default
 * .walkeforward.com, left off on localhost / *.pages.dev), its SHA-256 in D1, 30 days, at most
 * MAX_SESSIONS per user. Magic links: 32 random bytes, SHA-256 stored, 15 minutes, single use.
 * Email goes out through EMAIL_PROVIDER: resend | cloudflare | log (log is the default on
 * localhost only; elsewhere an unset provider is a 503, never a silently logged link).
 */
import { passViews, unlocks, type Entitlement } from './_entitlements';
import { EVENT_ID_RE } from '../src/data/vkx/validate';
import {
  consumeLoginToken,
  createLoginToken,
  createSession,
  deleteSession,
  ensureUser,
  entitlementsOf,
  hasPurchases,
  normEmail,
  pruneLoginTokens,
  SESSION_TTL_MS,
  setGoogleSub,
  userByEmail,
  userByGoogleSub,
  validEmail,
  type D1Like,
  type UserRow,
} from './_authDb';
import {
  SESSION_COOKIE,
  cookieHeader,
  jsonOut,
  notFound,
  paywallOn,
  randomToken,
  readCookie,
  sameText,
  sessionCookie,
  tokenHash,
  viewerOf,
  type PaywallDeps,
  type PaywallEnv,
} from './_paywall';
import { RateLimiter, readCapped } from './_vkx';
import { endpointPath } from './_lib';

export interface AuthCtx {
  request: Request;
  env: PaywallEnv;
  params?: { path?: string | string[] };
  waitUntil?(p: Promise<unknown>): void;
}

export interface AuthDeps extends PaywallDeps {
  /** Magic-link limiters (per email, per IP); null skips them. */
  limits?: { email: RateLimiter; ip: RateLimiter } | null;
  /** Where the `log` provider writes. */
  log?: (line: string) => void;
}

/**
 * Magic links per email address, and per client IP, per hour. Per isolate, in memory: each Workers
 * isolate counts on its own, so the effective limit grows with the number of isolates serving the
 * site. A later step could keep the counts in D1 or use a Rate Limiting binding (README "Paywall").
 */
export const EMAIL_RATE_MAX = 5;
export const IP_RATE_MAX = 20;
export const RATE_WINDOW_MS = 3_600_000;
export const MAX_BODY_BYTES = 4_000;
export const OAUTH_COOKIE = 'wf_oauth';
export const OAUTH_TTL_S = 600;
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const RESEND_URL = 'https://api.resend.com/emails';

let limiters: { email: RateLimiter; ip: RateLimiter } | undefined;
const isolateLimits = (): { email: RateLimiter; ip: RateLimiter } =>
  (limiters ??= { email: new RateLimiter(EMAIL_RATE_MAX, RATE_WINDOW_MS), ip: new RateLimiter(IP_RATE_MAX, RATE_WINDOW_MS) });

// ---- small helpers

const isLocalHost = (host: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);

/** Where a server redirect lands by default: the app's regatta list (bare `/` is the landing page, src/landing/route.ts). */
export const DEFAULT_RETURN_TO = '/regattas';

/**
 * Where to send the browser back to: a path on this site, or an https page on walkeforward.com or one
 * of its subdomains (or this very origin, for previews and dev). Anything else is DEFAULT_RETURN_TO: never an
 * open redirect.
 */
export function safeReturnTo(raw: unknown, origin: string): string {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return DEFAULT_RETURN_TO;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return DEFAULT_RETURN_TO;
  try {
    if (raw.startsWith('/')) {
      if (raw.startsWith('//')) return DEFAULT_RETURN_TO;
      const u = new URL(raw, origin);
      return u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : DEFAULT_RETURN_TO;
    }
    const u = new URL(raw);
    if (u.username || u.password) return DEFAULT_RETURN_TO;
    if (u.origin === origin) return `${u.pathname}${u.search}${u.hash}`;
    const h = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && !u.port && (h === 'walkeforward.com' || h.endsWith('.walkeforward.com'))) return u.href;
  } catch {
    /* not a URL */
  }
  return DEFAULT_RETURN_TO;
}

/** The browser's own origin for this request; a POST from elsewhere is refused. */
export const crossSite = (req: Request): boolean => {
  const o = req.headers.get('origin');
  return !!o && o !== new URL(req.url).origin;
};

/** This site, or an https page on walkeforward.com or one of its subdomains (no port). */
export function trustedOrigin(origin: string, self: string): boolean {
  if (origin === self) return true;
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    return u.origin === origin && u.protocol === 'https:' && !u.port && (h === 'walkeforward.com' || h.endsWith('.walkeforward.com'));
  } catch {
    return false;
  }
}

/** Stricter than crossSite, for a POST that acts on the account (the billing portal): an Origin header is required and must be trusted. */
export const originRefused = (req: Request): boolean => {
  const o = req.headers.get('origin');
  return !o || !trustedOrigin(o, new URL(req.url).origin);
};

/**
 * The magic link's form POST: this very origin only. Browsers send Origin on a form POST, but as
 * "null" when the page's referrer policy is no-referrer (the confirm page's is), so a missing or
 * "null" Origin passes only with `Sec-Fetch-Site: same-origin` (set by the browser, never by a page).
 */
export const notSameOrigin = (req: Request): boolean => {
  const o = req.headers.get('origin');
  if (o && o !== 'null') return o !== new URL(req.url).origin;
  return req.headers.get('sec-fetch-site') !== 'same-origin';
};

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (!raw) return null;
  try {
    const b = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function redirect(to: string, cookies: string[] = [], status = 302): Response {
  const h = new Headers({ location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status, headers: h });
}

/** `to` with one query parameter set (paths and absolute URLs alike). */
export function withParam(to: string, k: string, v: string): string {
  const abs = /^https?:/i.test(to);
  const u = new URL(to, 'https://x.invalid');
  u.searchParams.set(k, v);
  return abs ? u.href : `${u.pathname}${u.search}${u.hash}`;
}

const notConfigured = (what: string): Response => jsonOut(503, { error: 'not_configured', message: `${what} is not set up on this site yet.` });

// ---- email

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type SendResult = { ok: true } | { ok: false; status: number; error: string };

/** The provider to use: EMAIL_PROVIDER, else `log` on localhost only (null: none, fail closed). */
export function emailProvider(env: PaywallEnv, host: string): 'resend' | 'cloudflare' | 'log' | null {
  const p = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  if (p === 'resend' || p === 'cloudflare' || p === 'log') return p;
  return !p && isLocalHost(host) ? 'log' : null;
}

/** RFC 5322 text for the `cloudflare` provider (plain text body; the link is all that matters). */
export function mimeOf(from: string, m: Mail, now: number): string {
  return [
    `From: Recall <${from}>`,
    `To: <${m.to}>`,
    `Subject: ${m.subject}`,
    `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: <${randomToken(12)}@${from.split('@')[1] ?? 'walkeforward.com'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    m.text,
  ].join('\r\n');
}

/**
 * The `cloudflare` provider's message: the documented send_email shape (EmailMessage: from, to and
 * the raw MIME). Isolated here: if the binding wants a real `EmailMessage` from "cloudflare:email",
 * build one from these three fields instead (README "Paywall": confirm against Cloudflare's docs).
 */
export const cloudflareMessage = (from: string, to: string, raw: string): { from: string; to: string; raw: string } => ({ from, to, raw });

export async function sendEmail(env: PaywallEnv, host: string, m: Mail, deps: AuthDeps): Promise<SendResult> {
  const provider = emailProvider(env, host);
  if (!provider) return { ok: false, status: 503, error: 'Email sign-in is not set up on this site yet (EMAIL_PROVIDER).' };
  if (provider === 'log') {
    (deps.log ?? console.log)(`[recall auth] email to ${m.to}: ${m.subject}\n${m.text}`);
    return { ok: true };
  }
  const from = env.EMAIL_FROM?.trim();
  if (!from) return { ok: false, status: 503, error: 'Email sign-in is not set up on this site yet (EMAIL_FROM).' };
  try {
    if (provider === 'resend') {
      const key = env.RESEND_API_KEY?.trim();
      if (!key) return { ok: false, status: 503, error: 'Email sign-in is not set up on this site yet (RESEND_API_KEY).' };
      const res = await (deps.fetch ?? fetch)(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: `Recall <${from}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      });
      await res.body?.cancel().catch(() => undefined);
      return res.ok ? { ok: true } : { ok: false, status: 502, error: "Couldn't send the email just now. Try again in a minute." };
    }
    if (!env.EMAIL) return { ok: false, status: 503, error: 'Email sign-in is not set up on this site yet (EMAIL binding).' };
    await env.EMAIL.send(cloudflareMessage(from, m.to, mimeOf(from, m, (deps.now ?? Date.now)())));
    return { ok: true };
  } catch {
    return { ok: false, status: 502, error: "Couldn't send the email just now. Try again in a minute." };
  }
}

export function signInMail(to: string, link: string): Mail {
  const text = `Sign in to Recall:\n\n${link}\n\nThe link works once, for 15 minutes. If you didn't ask for it, ignore this email.\n\nRecall · walkeforward.com`;
  const safe = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = `<p>Sign in to Recall:</p><p><a href="${safe}">Sign in</a></p><p>The link works once, for 15 minutes. If you didn't ask for it, ignore this email.</p><p>Recall · walkeforward.com</p>`;
  return { to, subject: 'Your Recall sign-in link', text, html };
}

// ---- sessions

async function startSession(db: D1Like, user: UserRow, req: Request, env: PaywallEnv, now: number): Promise<string> {
  const token = randomToken();
  await createSession(db, { tokenHash: await tokenHash('session', token), userId: user.id, now, userAgent: req.headers.get('user-agent') });
  return sessionCookie(token, req, env, SESSION_TTL_MS / 1000);
}

// ---- routes

async function me(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const env = ctx.env;
  const now = (deps.now ?? Date.now)();
  const v = await viewerOf(ctx.request, env, now);
  return jsonOut(200, {
    paywall: true,
    user: v.user ? { email: v.user.email } : null,
    entitlements: v.user ? passViews(v.entitlements, v.user.id, now) : [],
    signIn: { email: !!env.AUTH_DB && !!emailProvider(env, new URL(ctx.request.url).host), google: !!env.AUTH_DB && !!env.GOOGLE_CLIENT_ID && !!env.AUTH_SECRET },
  });
}

/** Make, store and email one magic link. */
async function sendLink(ctx: AuthCtx, db: D1Like, email: string, returnTo: string, deps: AuthDeps): Promise<SendResult> {
  const now = (deps.now ?? Date.now)();
  const url = new URL(ctx.request.url);
  const token = randomToken();
  await createLoginToken(db, { tokenHash: await tokenHash('login', token), email, now, returnTo });
  const prune = pruneLoginTokens(db, now).catch(() => undefined);
  ctx.waitUntil?.(prune);
  return sendEmail(ctx.env, url.host, signInMail(email, `${url.origin}/api/auth/verify?token=${token}`), deps);
}

/** Shared by email and restore: checks, limits, then `send` (or not) — the answer never says which. */
async function linkRequest(ctx: AuthCtx, deps: AuthDeps, send: (db: D1Like, email: string, returnTo: string, body: Record<string, unknown> | null) => Promise<SendResult>): Promise<Response> {
  const db = ctx.env.AUTH_DB;
  if (!db) return notConfigured('Sign-in');
  const req = ctx.request;
  if (crossSite(req)) return jsonOut(403, { error: 'forbidden' });
  const host = new URL(req.url).host;
  if (!emailProvider(ctx.env, host)) return notConfigured('Email sign-in');
  const body = await readJson(req);
  const email = typeof body?.email === 'string' ? normEmail(body.email) : '';
  if (!validEmail(email)) return jsonOut(400, { error: 'bad_email', message: 'That email address doesn’t look right.' });
  const now = (deps.now ?? Date.now)();
  const lim = deps.limits === undefined ? isolateLimits() : deps.limits;
  if (lim) {
    const ip = req.headers.get('cf-connecting-ip') ?? 'local';
    const [byEmail, byIp] = await Promise.all([lim.email.allow(email, now), lim.ip.allow(ip, now)]);
    if (!byEmail || !byIp) return jsonOut(429, { error: 'rate_limited', message: 'Too many sign-in emails. Try again in an hour.' });
  }
  const returnTo = safeReturnTo(body?.returnTo, new URL(req.url).origin);
  const r = await send(db, email, returnTo, body);
  if (!r.ok) return jsonOut(r.status, { error: 'email_failed', message: r.error });
  return jsonOut(200, { ok: true });
}

function emailRoute(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  // A pass clicked while signed out rides along in the stored return_to (server-side, single use, 15 minutes).
  return linkRequest(ctx, deps, (db, email, returnTo, body) => {
    const buy = body?.buy && typeof body.buy === 'object' ? (body.buy as Record<string, unknown>) : null;
    return sendLink(ctx, db, email, linkReturnTo(returnTo, buy ? parseIntent(buy.product, buy.eventId) : null), deps);
  });
}

/** Restore access: a link only for an email with purchases (or a user with passes); the same answer either way. */
function restoreRoute(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  return linkRequest(ctx, deps, async (db, email, returnTo) => {
    let bought = await hasPurchases(db, email);
    if (!bought) {
      const u = await userByEmail(db, email);
      bought = !!u && (await entitlementsOf(db, u.id)).length > 0;
    }
    return bought ? sendLink(ctx, db, email, linkReturnTo(returnTo, null), deps) : { ok: true };
  });
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The confirm page's CSP: nothing loads, no script; the form posts here, and its 303 may go on to walkeforward.com (form-action covers redirects). */
export const VERIFY_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://walkeforward.com https://*.walkeforward.com; base-uri 'none'; frame-ancestors 'none'";

/** The magic link's page: one button that POSTs the token back here. Self-contained (no external assets), every value escaped. */
export function verifyPageHtml(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Sign in to Recall</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1b1f24}main{max-width:22rem;padding:2rem;text-align:center}button{font:inherit;font-weight:600;padding:.7rem 1.4rem;border:0;border-radius:8px;background:#0b5cad;color:#fff;cursor:pointer}p{color:#555}@media (prefers-color-scheme:dark){body{background:#14171b;color:#e8eaed}p{color:#aab}}</style>
</head><body><main>
<h1>Recall</h1>
<form method="post" action="/api/auth/verify"><input type="hidden" name="token" value="${escHtml(token)}"><button type="submit">Sign in to Recall</button></form>
<p>The link works once, for 15 minutes.</p>
</main></body></html>`;
}

const LOGIN_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** GET: the confirm page. Uses nothing (link scanners that prefetch it can't spend the token). */
function verifyPage(ctx: AuthCtx): Response {
  if (!ctx.env.AUTH_DB) return notConfigured('Sign-in');
  const token = new URL(ctx.request.url).searchParams.get('token') ?? '';
  if (!LOGIN_TOKEN_RE.test(token)) return redirect('/?signin=expired');
  return new Response(verifyPageHtml(token), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': VERIFY_PAGE_CSP,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });
}

/** POST (the page's form, same origin only): use the token once, start a session, 303 to returnTo. */
async function verifyRoute(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const db = ctx.env.AUTH_DB;
  if (!db) return notConfigured('Sign-in');
  const req = ctx.request;
  if (notSameOrigin(req)) return jsonOut(403, { error: 'forbidden' });
  const raw = await readCapped(req, MAX_BODY_BYTES);
  const token = raw ? (new URLSearchParams(new TextDecoder().decode(raw)).get('token') ?? '') : '';
  const now = (deps.now ?? Date.now)();
  const used = LOGIN_TOKEN_RE.test(token) ? await consumeLoginToken(db, await tokenHash('login', token), now) : null;
  if (!used) return redirect('/?signin=expired', [], 303);
  const user = await ensureUser(db, used.email, now);
  const cookie = await startSession(db, user, req, ctx.env, now);
  const { returnTo, buy } = splitLinkReturnTo(safeReturnTo(used.returnTo, new URL(req.url).origin));
  return redirect(await afterSignIn(db, ctx.env, user, returnTo, buy, now), [cookie], 303);
}

async function logoutRoute(ctx: AuthCtx): Promise<Response> {
  const req = ctx.request;
  if (crossSite(req)) return jsonOut(403, { error: 'forbidden' });
  const token = readCookie(req, SESSION_COOKIE);
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token) && ctx.env.AUTH_DB) {
    await deleteSession(ctx.env.AUTH_DB, await tokenHash('session', token));
  }
  return jsonOut(200, { ok: true }, { 'set-cookie': sessionCookie('', req, ctx.env, 0) });
}

// ---- Google

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string): string => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

export interface OAuthState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
  /** What the sailor was buying when they were asked to sign in (validated before it is signed in here). */
  buy?: BuyIntent;
}

// ---- purchase intent, carried through sign-in

/** The pass a signed-out sailor clicked: checked against the product list and EVENT_ID_RE, else none. */
export interface BuyIntent {
  product: 'regatta';
  eventId: string;
}

/** Only the Regatta Pass is sold: a `season` intent (no longer on sale, or an old marker) is none. */
export function parseIntent(product: unknown, eventId: unknown): BuyIntent | null {
  if (product === 'regatta' && typeof eventId === 'string' && EVENT_ID_RE.test(eventId)) return { product, eventId };
  return null;
}

/** The marker's query parameter (one-time, for the page) and its life. */
export const BUY_PARAM = 'buy';
export const BUY_TTL_MS = 10 * 60_000;

/**
 * `payload.signature` (base64url JSON, HMAC-SHA256 under AUTH_SECRET with a purpose prefix): the
 * intent, the user it was signed for, and its expiry. The page hands it back to /api/billing/checkout,
 * which accepts it only for that user, unexpired, for the same product and event.
 */
export async function signBuy(secret: string, b: BuyIntent & { userId: string; exp: number }): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ p: b.product, e: b.eventId, u: b.userId, x: b.exp })));
  return `${payload}.${await hmac(secret, `recall-buy:${payload}`)}`;
}

export async function readBuy(secret: string, raw: unknown, userId: string, now: number): Promise<BuyIntent | null> {
  if (typeof raw !== 'string' || raw.length > 600 || !secret) return null;
  const [payload, sig, extra] = raw.split('.');
  if (!payload || !sig || extra !== undefined || !sameText(sig, await hmac(secret, `recall-buy:${payload}`))) return null;
  try {
    const o = JSON.parse(fromB64url(payload)) as { p?: unknown; e?: unknown; u?: unknown; x?: unknown };
    if (o.u !== userId || typeof o.x !== 'number' || now >= o.x) return null;
    return parseIntent(o.p, o.e);
  } catch {
    return null;
  }
}

/** Does the user already hold what the intent would buy (any pass that opens that event: its own, or an all-regattas one)? */
export const intentHeld = (ents: readonly Entitlement[], userId: string, b: BuyIntent, now: number): boolean => ents.some((e) => unlocks(e, userId, b.eventId, now));

/** A return path without any buy marker (the server adds its own, signed). */
const withoutBuy = (to: string): string => {
  const abs = /^https?:/i.test(to);
  const u = new URL(to, 'https://x.invalid');
  u.searchParams.delete(BUY_PARAM);
  return abs ? u.href : `${u.pathname}${u.search}${u.hash}`;
};

/**
 * Where a fresh sign-in goes: returnTo, plus a signed one-time buy marker when there was an intent, the
 * user doesn't hold that pass already (then the race just opens), and AUTH_SECRET can sign it.
 */
async function afterSignIn(db: D1Like, env: PaywallEnv, user: UserRow, returnTo: string, buy: BuyIntent | null, now: number): Promise<string> {
  const to = withoutBuy(returnTo);
  if (!buy || !env.AUTH_SECRET) return to;
  if (intentHeld(await entitlementsOf(db, user.id), user.id, buy, now)) return to;
  return withParam(to, BUY_PARAM, await signBuy(env.AUTH_SECRET, { ...buy, userId: user.id, exp: now + BUY_TTL_MS }));
}

/** The magic link's stored return_to carries the intent server-side (D1, written only here) as this parameter. */
const LINK_BUY_PARAM = 'pw_buy';
const linkReturnTo = (returnTo: string, buy: BuyIntent | null): string => {
  const to = withoutBuy(returnTo);
  const u = new URL(to, 'https://x.invalid');
  u.searchParams.delete(LINK_BUY_PARAM);
  if (buy) u.searchParams.set(LINK_BUY_PARAM, `regatta.${buy.eventId}`);
  return /^https?:/i.test(to) ? u.href : `${u.pathname}${u.search}${u.hash}`;
};
const splitLinkReturnTo = (stored: string): { returnTo: string; buy: BuyIntent | null } => {
  const abs = /^https?:/i.test(stored);
  const u = new URL(stored, 'https://x.invalid');
  const raw = u.searchParams.get(LINK_BUY_PARAM) ?? '';
  u.searchParams.delete(LINK_BUY_PARAM);
  const [product, eventId] = raw.split('.');
  return { returnTo: abs ? u.href : `${u.pathname}${u.search}${u.hash}`, buy: parseIntent(product, eventId) };
};

/** `payload.signature`, both base64url; the signature is an HMAC-SHA256 under AUTH_SECRET. */
export async function signState(secret: string, s: OAuthState): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(s)));
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function readState(secret: string, raw: string | null, now: number): Promise<OAuthState | null> {
  const [payload, sig] = (raw ?? '').split('.');
  if (!payload || !sig || !sameText(sig, await hmac(secret, payload))) return null;
  try {
    const s = JSON.parse(fromB64url(payload)) as OAuthState;
    return typeof s.exp === 'number' && now < s.exp && typeof s.state === 'string' && typeof s.verifier === 'string' ? s : null;
  } catch {
    return null;
  }
}

const googleReady = (env: PaywallEnv): boolean => !!(env.AUTH_DB && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.AUTH_SECRET);
const redirectUri = (req: Request): string => `${new URL(req.url).origin}/api/auth/google/callback`;
const oauthCookie = (value: string, maxAgeS: number): string => cookieHeader(OAUTH_COOKIE, value, { domain: null, maxAgeS, path: '/api/auth/google' });

async function googleStart(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const env = ctx.env;
  if (!googleReady(env)) return notConfigured('Google sign-in');
  const req = ctx.request;
  const url = new URL(req.url);
  const now = (deps.now ?? Date.now)();
  const buy = parseIntent(url.searchParams.get(BUY_PARAM), url.searchParams.get('event'));
  const s: OAuthState = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(),
    returnTo: safeReturnTo(url.searchParams.get('returnTo'), url.origin),
    exp: now + OAUTH_TTL_S * 1000,
    ...(buy ? { buy } : {}),
  };
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.verifier))));
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email',
    state: s.state,
    nonce: s.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return redirect(`${GOOGLE_AUTH_URL}?${q}`, [oauthCookie(await signState(env.AUTH_SECRET!, s), OAUTH_TTL_S)]);
}

export interface GoogleClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  nonce?: unknown;
}

/** The ID token's claims, checked: Google's issuer, our client id, unexpired, a verified email, our nonce. */
export function checkClaims(c: GoogleClaims, clientId: string, nonce: string, now: number): { sub: string; email: string } | null {
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') return null;
  if (!aud.includes(clientId)) return null;
  if (typeof c.exp !== 'number' || c.exp * 1000 <= now) return null;
  if (c.email_verified !== true && c.email_verified !== 'true') return null;
  if (typeof c.nonce !== 'string' || !sameText(c.nonce, nonce)) return null;
  if (typeof c.sub !== 'string' || !c.sub || typeof c.email !== 'string' || !validEmail(normEmail(c.email))) return null;
  return { sub: c.sub, email: normEmail(c.email) };
}

export function decodeJwtPayload(jwt: string): GoogleClaims | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const json = new TextDecoder().decode(Uint8Array.from(fromB64url(part), (ch) => ch.charCodeAt(0)));
    const c = JSON.parse(json) as unknown;
    return c && typeof c === 'object' ? (c as GoogleClaims) : null;
  } catch {
    return null;
  }
}

async function googleCallback(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const env = ctx.env;
  if (!googleReady(env)) return notConfigured('Google sign-in');
  const req = ctx.request;
  const url = new URL(req.url);
  const now = (deps.now ?? Date.now)();
  const clear = oauthCookie('', 0);
  const s = await readState(env.AUTH_SECRET!, readCookie(req, OAUTH_COOKIE), now);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (!s || !code || !sameText(state, s.state)) return redirect('/?signin=failed', [clear]);
  const failed = redirect(withParam(s.returnTo, 'signin', 'failed'), [clear]);
  let idToken: unknown;
  try {
    const res = await (deps.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code',
        code_verifier: s.verifier,
      }),
    });
    if (!res.ok) return failed;
    idToken = ((await res.json()) as { id_token?: unknown }).id_token;
  } catch {
    return failed;
  }
  // The ID token came straight from Google's token endpoint over TLS in exchange for our code (and
  // our client secret and PKCE verifier): its signature need not be checked against Google's keys
  // (OpenID Connect Core 3.1.3.7). Its claims still are.
  const claims = typeof idToken === 'string' ? decodeJwtPayload(idToken) : null;
  const who = claims ? checkClaims(claims, env.GOOGLE_CLIENT_ID!, s.nonce, now) : null;
  if (!who) return failed;
  const db = env.AUTH_DB!;
  let user = await userByGoogleSub(db, who.sub);
  if (!user) {
    // Linked by verified email: the same person as a magic-link sign-in (or a purchase) with that address.
    user = await ensureUser(db, who.email, now);
    await setGoogleSub(db, user.id, who.sub);
  }
  const cookie = await startSession(db, user, req, env, now);
  // The signed state carried the intent (if any): re-checked before the marker is signed for this user.
  const buy = s.buy ? parseIntent(s.buy.product, s.buy.eventId) : null;
  return redirect(await afterSignIn(db, env, user, safeReturnTo(s.returnTo, url.origin), buy, now), [cookie, clear]);
}

// ---- the router

/** /api/auth/<path>: 404 (as the proxy's) unless PAYWALL_ENABLED, `GET me` included. */
export async function handleAuth(ctx: AuthCtx, deps: AuthDeps = {}): Promise<Response> {
  const path = endpointPath(ctx.params?.path);
  const method = ctx.request.method.toUpperCase();
  if (!paywallOn(ctx.env)) return notFound();
  const routes: Record<string, Partial<Record<string, () => Promise<Response>>>> = {
    me: { GET: () => me(ctx, deps) },
    email: { POST: () => emailRoute(ctx, deps) },
    restore: { POST: () => restoreRoute(ctx, deps) },
    verify: { GET: async () => verifyPage(ctx), POST: () => verifyRoute(ctx, deps) },
    logout: { POST: () => logoutRoute(ctx) },
    'google/start': { GET: () => googleStart(ctx, deps) },
    'google/callback': { GET: () => googleCallback(ctx, deps) },
  };
  const r = routes[path];
  if (!r) return notFound();
  const run = r[method];
  if (!run) return jsonOut(405, { error: 'Method not allowed' }, { allow: Object.keys(r).join(', ') });
  try {
    return await run();
  } catch {
    return unavailable();
  }
}

/** D1 (or another dependency) failed mid-request. */
export const unavailable = (): Response => jsonOut(503, { error: 'unavailable', message: 'Sign-in is unavailable right now. Try again in a minute.' });
