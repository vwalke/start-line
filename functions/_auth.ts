/**
 * Sign-in for the paywall: the handler behind functions/api/auth/[[path]].ts (kept in a `_` file so
 * tests call it directly). Every route, `GET me` included, answers the proxy's own 404 while
 * PAYWALL_ENABLED is off (the page reads that as "off" and shows nothing new).
 *
 *   GET  /api/auth/me               { paywall, user, entitlements, signIn, devices?, bumped?, signedOutReason? }
 *                                   (no-store; reads D1 afresh; a revoked session's cookie is cleared)
 *   POST /api/auth/email            { email, returnTo, turnstileToken } → a magic link by email (same answer whoever asks)
 *   GET  /api/auth/verify#token=    the link's page (also an old `?token=` link): its script POSTs the token
 *                                   at once, a "Sign in" button as the fallback; uses nothing, so a mail
 *                                   scanner's prefetch can't spend the link
 *   POST /api/auth/verify           token (form, same origin only) → use it once: session cookie, 303 to returnTo (+ signin=ok)
 *   GET  /api/auth/google/start     → Google (state, nonce and PKCE in a signed 10-minute cookie)
 *   GET  /api/auth/google/callback  code → Google's token endpoint → session cookie
 *   GET  /api/auth/microsoft/start  → Microsoft (v2.0, tenant common; state, nonce and PKCE in the same kind of cookie)
 *   GET  /api/auth/microsoft/callback  code → Microsoft's token endpoint → ID token checked against its JWKS → session cookie
 *   GET  /api/auth/apple/start      → Apple (response_mode form_post; state and nonce in a SameSite=None cookie)
 *   POST /api/auth/apple/callback   Apple's cross-site form post: code → Apple's token endpoint (ES256 client secret) → session cookie
 *   POST /api/auth/logout           end this browser's session
 *   POST /api/auth/restore          { email, turnstileToken } → a magic link, if that email bought anything
 *   POST /api/auth/sessions/revoke         { id } → sign out another of the user's devices; { ok, devices }
 *   POST /api/auth/sessions/revoke-others  sign out every other device of the user; { ok, devices }
 *
 * Sessions: a random 32-byte token in the `wf_session` cookie (Domain=AUTH_COOKIE_DOMAIN, default
 * .walkeforward.com, left off on localhost / *.pages.dev), its SHA-256 in D1, 30 days, at most
 * DEFAULT_MAX_SESSIONS (3) signed-in devices per user (the admin may set another cap per user,
 * scripts/sessions.mjs): a sign-in beyond it revokes the least recently used, which is then told
 * why. Magic links: 32 random bytes, SHA-256 stored, 15 minutes, single use; asking for one passes
 * Turnstile (when set up) and shared D1 rate limits. Email goes out through EMAIL_PROVIDER:
 * cloudflare-api | resend | cloudflare | log (log is the default on localhost and works there only;
 * elsewhere an unset provider, or log, is a 503, never a silently logged link).
 */
import { passViews, unlocks, type Entitlement } from './_entitlements';
import { EVENT_ID_RE } from '../src/data/vkx/validate';
import {
  bumpedBy,
  consumeLoginToken,
  countRateHit,
  createLoginToken,
  createSession,
  deleteSession,
  ensureUser,
  entitlementsOf,
  hasPurchases,
  lastUsed,
  linkIdentity,
  liveSessions,
  normEmail,
  pruneLoginTokens,
  pruneRateLimits,
  PUBLIC_ID_RE,
  revokeOtherSessions,
  revokeSessionById,
  LOGIN_TOKEN_TTL_MS,
  SESSION_TTL_MS,
  sessionCap,
  setGoogleSub,
  SIGN_IN_METHODS,
  userByEmail,
  userByGoogleSub,
  userByIdentity,
  validEmail,
  type D1Like,
  type IdentityInput,
  type SessionRow,
  type SignInMethod,
  type UserRow,
} from './_authDb';
import { deviceLabel } from './_deviceLabel';
import { sha256Hex } from '../src/data/vkx/compact';
import {
  SESSION_COOKIE,
  cookieHeader,
  entitlementsWithFree,
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
import { readCapped } from './_vkx';
import { endpointPath } from './_lib';
import { THEME_SCRIPT } from './_theme';
import { signEs256, verifyIdToken, type Claims } from './_jwt';

export interface AuthCtx {
  request: Request;
  env: PaywallEnv;
  params?: { path?: string | string[] };
  waitUntil?(p: Promise<unknown>): void;
}

export interface AuthDeps extends PaywallDeps {
  /** Magic links allowed per email and per IP per hour (D1, shared by every isolate); null skips the limits. */
  limits?: { email: number; ip: number } | null;
  /** Where the `log` provider writes. */
  log?: (line: string) => void;
  /** Decides when to prune old rate-limit rows (about 1 call in 100). */
  random?: () => number;
}

/**
 * Magic links per email address, and per client IP, per fixed hour, counted in D1 (auth_rate_limits)
 * so every isolate shares the counts. Keys are SHA-256 hashes: no raw address or IP is stored.
 */
export const EMAIL_RATE_MAX = 5;
export const IP_RATE_MAX = 20;
export { RATE_WINDOW_MS } from './_authDb';
/** The JSON body of email / restore: an address, a returnTo (≤ 2,000) and a Turnstile token (≤ 2,048). */
export const MAX_BODY_BYTES = 8_000;
export const RATE_PRUNE_CHANCE = 0.01;
export const OAUTH_COOKIE = 'wf_oauth';
/** Apple's callback is a cross-site POST, which a Lax cookie doesn't ride along with: its own SameSite=None cookie. */
export const APPLE_OAUTH_COOKIE = 'wf_oauth_apple';
export const OAUTH_TTL_S = 600;
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const MICROSOFT_JWKS_URL = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
/** The tenant of personal Microsoft accounts (Outlook.com, Hotmail, Live). */
export const MICROSOFT_PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_AUTH_URL = 'https://appleid.apple.com/auth/authorize';
export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
export const RESEND_URL = 'https://api.resend.com/emails';
export const cloudflareEmailUrl = (accountId: string): string => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`;
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const notConfigured = (what: string): Response => jsonOut(503, { error: 'not_configured', message: `${what} is not set up on this site yet.` });

// ---- email

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type SendResult = { ok: true } | { ok: false; status: number; error: string };

export type EmailProvider = 'cloudflare-api' | 'resend' | 'cloudflare' | 'log';

/** The provider to use: EMAIL_PROVIDER, else `log` on localhost; `log` (set or not) works on localhost only (null: none, fail closed). */
export function emailProvider(env: PaywallEnv, host: string): EmailProvider | null {
  const p = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  if (p === 'cloudflare-api' || p === 'resend' || p === 'cloudflare') return p;
  return (!p || p === 'log') && isLocalHost(host) ? 'log' : null;
}

/** A sender: the address, and the display name when EMAIL_FROM gives one. */
export interface Sender {
  email: string;
  name?: string;
}

/** EMAIL_FROM as `Recall <signin@walkeforward.com>` or a bare `signin@walkeforward.com`; null when it is neither. */
export function parseFrom(raw: string | undefined): Sender | null {
  const s = (raw ?? '').trim();
  const named = /^(.*?)\s*<([^<>\s]+)>$/.exec(s);
  const email = named ? named[2] : s;
  if (!validEmail(email)) return null;
  const name = named?.[1].replace(/^"(.*)"$/, '$1').trim();
  // eslint-disable-next-line no-control-regex
  if (name && /[\u0000-\u001f\u007f<>"]/.test(name)) return null;
  return name ? { email, name } : { email };
}

const notSetUp = (what: string): SendResult => ({ ok: false, status: 503, error: `Email sign-in is not set up on this site yet (${what}).` });
const SEND_FAILED: SendResult = { ok: false, status: 502, error: "Couldn't send the email just now. Try again in a minute." };

/** Codes and message keys from a Cloudflare API `errors` array, for the log (e.g. `10001 email.sending.error.invalid_request_schema`). */
function cloudflareErrors(body: { errors?: unknown } | null): string {
  if (!body) return 'unparseable body';
  const errs = Array.isArray(body.errors) ? (body.errors as { code?: unknown; message?: unknown }[]) : [];
  const parts = errs.map((e) => `${typeof e?.code === 'number' || typeof e?.code === 'string' ? e.code : '?'} ${typeof e?.message === 'string' ? e.message.slice(0, 120) : '?'}`);
  return parts.length ? parts.join(', ') : 'no errors listed';
}

export async function sendEmail(env: PaywallEnv, host: string, m: Mail, deps: AuthDeps): Promise<SendResult> {
  const provider = emailProvider(env, host);
  if (!provider) return notSetUp('EMAIL_PROVIDER');
  if (provider === 'log') {
    // A second guard: a link (or its token) is never logged off localhost.
    if (!isLocalHost(host)) return notSetUp('EMAIL_PROVIDER');
    (deps.log ?? console.log)(`[recall auth] email to ${m.to}: ${m.subject}\n${m.text}`);
    return { ok: true };
  }
  const sender = parseFrom(env.EMAIL_FROM);
  if (!sender) return notSetUp('EMAIL_FROM');
  // `from` is an address or a named sender: the REST API takes { address, name }, the
  // EMAIL binding { email, name }; Resend takes one string.
  try {
    if (provider === 'cloudflare-api') {
      const account = env.CF_EMAIL_ACCOUNT_ID?.trim();
      if (!account) return notSetUp('CF_EMAIL_ACCOUNT_ID');
      const key = env.CF_EMAIL_API_TOKEN?.trim();
      if (!key) return notSetUp('CF_EMAIL_API_TOKEN');
      const from = sender.name ? { address: sender.email, name: sender.name } : sender.email;
      let res: Response;
      try {
        res = await (deps.fetch ?? fetch)(cloudflareEmailUrl(account), {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ to: m.to, from, subject: m.subject, html: m.html, text: m.text }),
        });
      } catch (e) {
        console.error(`[recall auth] cloudflare email send threw: ${e instanceof Error ? e.name : 'error'}`);
        return SEND_FAILED;
      }
      const body = (await res.json().catch(() => null)) as { success?: unknown; errors?: unknown } | null;
      if (res.ok && body?.success === true) return { ok: true };
      console.error(`[recall auth] cloudflare email send failed: HTTP ${res.status}; ${cloudflareErrors(body)}`);
      return SEND_FAILED;
    }
    if (provider === 'resend') {
      const key = env.RESEND_API_KEY?.trim();
      if (!key) return notSetUp('RESEND_API_KEY');
      const res = await (deps.fetch ?? fetch)(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: `${sender.name ?? 'Recall'} <${sender.email}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      });
      await res.body?.cancel().catch(() => undefined);
      return res.ok ? { ok: true } : SEND_FAILED;
    }
    if (!env.EMAIL) return notSetUp('EMAIL binding');
    const from = sender.name ? { email: sender.email, name: sender.name } : sender.email;
    await env.EMAIL.send({ from, to: m.to, subject: m.subject, html: m.html, text: m.text });
    return { ok: true };
  } catch {
    return SEND_FAILED;
  }
}

export const SIGN_IN_SUBJECT = 'Your Recall sign-in link';
const SIGN_IN_INTRO = "Here's your link to sign in to Recall.";
const RESTORE_INTRO = "Here's your link to get back into Recall and your passes.";
const SITE_NAME = 'recall.walkeforward.com';
const SITE_ORIGIN = `https://${SITE_NAME}`;

/** The email's colors, from src/style.css: the carbon masthead, its text, the gold of the logo, the Day accent, ink and page. */
const MAIL = {
  carbon: '#16181c',
  onCarbon: '#f2f4f7',
  onCarbonMuted: '#aab3bf',
  gold: '#ffc94d',
  accent: '#1f6bc4',
  ink: '#131922',
  ink3: '#5b6675',
  page: '#f5f7fa',
  surface: '#ffffff',
  rule: '#dde3ea',
  font: "Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif",
  display: "Archivo,'Arial Black','Helvetica Neue',Helvetica,Arial,sans-serif",
};

/** Whole minutes a sign-in link lasts (LOGIN_TOKEN_TTL_MS). */
export const linkMinutes = (): number => Math.round(LOGIN_TOKEN_TTL_MS / 60_000);

/** The site the link points at (where the email was asked for), for the footer; the production site if the link isn't a URL. */
const originOf = (link: string): string => {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : SITE_ORIGIN;
  } catch {
    return SITE_ORIGIN;
  }
};

/**
 * The sign-in (or Restore access) email. Plain text, and HTML for Gmail, Outlook and Apple Mail:
 * tables and inline styles only, at most 560px wide, the wordmark as live text on the carbon masthead
 * (no images, so nothing breaks when they're blocked), a bulletproof button (a padded cell, with a
 * VML roundrect for Outlook desktop), the raw link under it, a hidden preheader, and colors that
 * stay readable if a client darkens them. Every value is escaped.
 */
export function signInMail(to: string, link: string, kind: 'signin' | 'restore' = 'signin'): Mail {
  const intro = kind === 'restore' ? RESTORE_INTRO : SIGN_IN_INTRO;
  const hello = 'Hi there,';
  const paste = 'Or paste this link into your browser:';
  const once = `The link works once and expires in ${linkMinutes()} minutes.`;
  const ignore = "If you didn't ask for this, you can ignore it.";
  const button = 'Sign in to Recall';
  const preheader = kind === 'restore' ? 'Your link to get back into Recall.' : 'Your link to sign in to Recall.';
  const origin = originOf(link);
  const text = `${hello}\n\n${intro}\n\n${link}\n\n${once}\n\n${ignore}\n\nRecall\n${origin}\n`;
  const href = escHtml(link);
  const c = MAIL;
  const { p, small } = MAIL_TEXT;
  const body = `<p style="${p}">${escHtml(hello)}</p>
<p style="${p}">${escHtml(intro)}</p>
<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:8px 0 24px">
<tr><td align="center" bgcolor="${c.accent}" style="background:${c.accent};border-radius:8px">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:240px" arcsize="17%" stroke="f" fillcolor="${c.accent}">
<w:anchorlock/>
<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold">${button}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${href}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${c.font};font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;background:${c.accent};border:1px solid ${c.accent}">${button}</a>
<!--<![endif]-->
</td></tr>
</table>
<p style="${small};margin-bottom:4px">${escHtml(paste)}</p>
<p style="${small};margin-bottom:20px;word-break:break-all"><a href="${href}" target="_blank" style="color:${c.accent};text-decoration:underline">${href}</a></p>
<p style="${small}">${escHtml(once)}</p>`;
  return { to, subject: SIGN_IN_SUBJECT, text, html: brandedHtml({ title: SIGN_IN_SUBJECT, preheader, body, origin, footer: ignore }) };
}

/** The body text styles of the branded email: a paragraph, and the smaller muted one. */
const MAIL_TEXT = {
  p: `margin:0 0 16px;font-family:${MAIL.font};font-size:16px;line-height:24px;color:${MAIL.ink}`,
  small: `margin:0 0 12px;font-family:${MAIL.font};font-size:14px;line-height:21px;color:${MAIL.ink3}`,
};

/**
 * The branded email around `body` (HTML, already escaped): the masthead, the white card, and the
 * footer (the site's name linking to `origin`, then `footer` if given). Every other value is escaped.
 */
function brandedHtml(o: { title: string; preheader: string; body: string; origin: string; footer?: string }): string {
  const c = MAIL;
  const { small } = MAIL_TEXT;
  // Zero-width fillers after the preheader, so the inbox preview doesn't run on into the body text.
  const filler = '&#847;&zwnj;&nbsp;'.repeat(40);
  const footer = o.footer ? `\n<p style="${small};margin:0">${escHtml(o.footer)}</p>` : '';
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escHtml(o.title)}</title>
</head>
<body style="margin:0;padding:0;width:100%;background:${c.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${c.page}">${escHtml(o.preheader)}${filler}</div>
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${c.page}" style="background:${c.page}">
<tr><td align="center" style="padding:24px 12px">
<!--[if mso]><table role="presentation" width="560" border="0" cellspacing="0" cellpadding="0" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:560px;border-collapse:separate">
<tr><td bgcolor="${c.carbon}" style="background:${c.carbon};padding:20px 28px 18px;border-radius:10px 10px 0 0;border-bottom:4px solid ${c.gold}">
<p style="margin:0;font-family:${c.display};font-size:24px;line-height:28px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:${c.onCarbon}">Recall</p>
<p style="margin:4px 0 0;font-family:${c.font};font-size:13px;line-height:18px;color:${c.onCarbonMuted}">Replays and debriefs for RaceSense races.</p>
</td></tr>
<tr><td bgcolor="${c.surface}" style="background:${c.surface};padding:28px 28px 20px;border:1px solid ${c.rule};border-top:0;border-radius:0 0 10px 10px">
${o.body}
</td></tr>
<tr><td align="center" style="padding:18px 28px 8px">
<p style="${small};margin-bottom:${o.footer ? '6px' : '0'}"><a href="${escHtml(o.origin)}" target="_blank" style="color:${c.ink3};text-decoration:underline">${SITE_NAME}</a></p>${footer}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

const PROVIDER_NAMES = { microsoft: 'Microsoft', apple: 'Apple' } as const;

/**
 * The notice to an account's address when a Microsoft or Apple sign-in was just linked to it: the
 * branded email with no button, no sign-in link and no token, and nothing inviting a reply (the
 * sender has no inbox). `origin` is the site it happened on, for the footer.
 */
export function linkNoticeMail(to: string, provider: 'microsoft' | 'apple', origin: string): Mail {
  const name = PROVIDER_NAMES[provider];
  const subject = `${name} sign-in was added to your Recall account`;
  const added = `You can now sign in to Recall with ${name}. If you did this, there's nothing else to do.`;
  const notYou = "If it wasn't you, open Recall, go to Account, and use Sign out all other devices. Then sign in again with your email.";
  const why = 'We send this whenever a sign-in method is added to your account.';
  const site = originOf(origin);
  const text = `${added}\n\n${notYou}\n\nRecall\n${site}\n${why}\n`;
  const { p } = MAIL_TEXT;
  const body = `<p style="${p}">${escHtml(added)}</p>
<p style="${p};margin-bottom:0">${escHtml(notYou)}</p>`;
  return { to, subject, text, html: brandedHtml({ title: subject, preheader: added, body, origin: site, footer: why }) };
}

/**
 * Send linkNoticeMail, best effort: it never holds up or fails the sign-in (it runs in waitUntil when
 * there is one), it is skipped when no email provider is set up, and a failure is logged without the
 * address.
 */
async function sendLinkNotice(ctx: AuthCtx, user: UserRow, provider: 'microsoft' | 'apple', deps: AuthDeps): Promise<void> {
  try {
    const url = new URL(ctx.request.url);
    if (!emailProvider(ctx.env, url.host)) return;
    const sent = sendEmail(ctx.env, url.host, linkNoticeMail(user.email, provider, url.origin), deps).then(
      (r) => {
        if (!r.ok) console.error(`[recall auth] ${provider} link notice not sent: ${r.status}`);
      },
      (e: unknown) => console.error(`[recall auth] ${provider} link notice threw: ${e instanceof Error ? e.name : 'error'}`),
    );
    if (ctx.waitUntil) ctx.waitUntil(sent);
    else await sent;
  } catch {
    console.error(`[recall auth] ${provider} link notice failed`);
  }
}

// ---- Turnstile (the email forms)

/** Turnstile is set up: both keys. */
export const turnstileReady = (env: PaywallEnv): boolean => !!(env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim());

/**
 * Email sign-in is offered: a D1 database, an email provider, and Turnstile (on localhost, where the
 * `log` provider works, Turnstile may be absent).
 */
export const emailReady = (env: PaywallEnv, host: string): boolean => !!env.AUTH_DB && !!emailProvider(env, host) && (turnstileReady(env) || isLocalHost(host));

export type TurnstileResult = 'ok' | 'failed' | 'unavailable';

/**
 * Check a Turnstile token with Cloudflare: success, and solved on this very host. Fails closed: a
 * network error or an odd answer is `unavailable` (the caller's 503), never a pass.
 */
export async function verifyTurnstile(env: PaywallEnv, token: string, req: Request, deps: AuthDeps): Promise<TurnstileResult> {
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!.trim(), response: token });
  const ip = req.headers.get('cf-connecting-ip');
  if (ip) form.set('remoteip', ip);
  let body: { success?: unknown; hostname?: unknown };
  try {
    const res = await (deps.fetch ?? fetch)(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
    if (!res.ok) return 'unavailable';
    body = (await res.json()) as typeof body;
  } catch {
    return 'unavailable';
  }
  if (!body || typeof body !== 'object') return 'unavailable';
  return body.success === true && typeof body.hostname === 'string' && body.hostname.toLowerCase() === new URL(req.url).hostname.toLowerCase() ? 'ok' : 'failed';
}

// ---- sessions

async function startSession(db: D1Like, user: UserRow, req: Request, env: PaywallEnv, now: number, method: SignInMethod): Promise<string> {
  const token = randomToken();
  await createSession(db, { tokenHash: await tokenHash('session', token), userId: user.id, now, userAgent: req.headers.get('user-agent'), method });
  return sessionCookie(token, req, env, SESSION_TTL_MS / 1000);
}

/** One row of the device list (no token or hash: `id` is the session's public id). */
export interface DeviceView {
  id: string;
  label: string;
  method: SignInMethod | null;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

/** The user's live devices (this one first, then by last use) and their cap. */
export async function devicesOf(db: D1Like, user: UserRow, current: SessionRow, now: number): Promise<{ max: number; list: DeviceView[] }> {
  const rows = await liveSessions(db, user.id, now);
  const list = rows
    .filter((r) => r.public_id)
    .map((r): DeviceView => ({
      id: r.public_id!,
      label: deviceLabel(r.user_agent),
      method: SIGN_IN_METHODS.includes(r.method as SignInMethod) ? (r.method as SignInMethod) : null,
      createdAt: r.created_at,
      lastSeenAt: r.token_hash === current.token_hash ? Math.max(lastUsed(r), lastUsed(current)) : lastUsed(r),
      current: r.token_hash === current.token_hash,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
  return { max: sessionCap(user.max_sessions), list };
}

// ---- routes

async function me(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const env = ctx.env;
  const req = ctx.request;
  const now = (deps.now ?? Date.now)();
  const v = await viewerOf(req, env, now);
  const signIn = {
    email: emailReady(env, new URL(req.url).host),
    google: !!env.AUTH_DB && !!env.GOOGLE_CLIENT_ID && !!env.AUTH_SECRET,
    microsoft: microsoftReady(env),
    apple: appleReady(env),
    turnstileSiteKey: turnstileReady(env) ? env.TURNSTILE_SITE_KEY!.trim() : null,
  };
  if (!v.user || !v.session) {
    // Signed out from another device (or by the device cap, or the admin): say why, once, and drop the cookie.
    const out = { paywall: true, user: null, entitlements: [], signIn, ...(v.signedOutReason ? { signedOutReason: v.signedOutReason } : {}) };
    return jsonOut(200, out, v.signedOutReason ? { 'set-cookie': sessionCookie('', req, env, 0) } : {});
  }
  const db = env.AUTH_DB!;
  const [devices, bumped] = await Promise.all([devicesOf(db, v.user, v.session, now), v.session.public_id ? bumpedBy(db, v.session.public_id, now) : []]);
  return jsonOut(200, {
    paywall: true,
    user: { email: v.user.email },
    entitlements: passViews(v.entitlements, v.user.id, now),
    signIn,
    devices,
    bumped,
  });
}

/** Make, store and email one magic link. */
async function sendLink(ctx: AuthCtx, db: D1Like, email: string, returnTo: string, deps: AuthDeps, kind: 'signin' | 'restore'): Promise<SendResult> {
  const now = (deps.now ?? Date.now)();
  const url = new URL(ctx.request.url);
  const token = randomToken();
  await createLoginToken(db, { tokenHash: await tokenHash('login', token), email, now, returnTo });
  const prune = pruneLoginTokens(db, now).catch(() => undefined);
  ctx.waitUntil?.(prune);
  // The token rides in the fragment: it never reaches a server, a log or a Referer (the page's script reads it).
  return sendEmail(ctx.env, url.host, signInMail(email, `${url.origin}/api/auth/verify#token=${token}`, kind), deps);
}

const sha256Of = (s: string): Promise<string> => sha256Hex(new TextEncoder().encode(s));

/** The rate-limit keys for an address and an IP: SHA-256 hex only, never the raw values. */
export const rateKeys = async (email: string, ip: string): Promise<{ email: string; ip: string }> => ({
  email: `email:${await sha256Of(normEmail(email))}`,
  ip: `ip:${await sha256Of(ip)}`,
});

/** Count this request against the address and the IP (D1, shared by every isolate): true when either is over its limit. */
async function overLimit(ctx: AuthCtx, db: D1Like, email: string, deps: AuthDeps, now: number): Promise<boolean> {
  const lim = deps.limits === undefined ? { email: EMAIL_RATE_MAX, ip: IP_RATE_MAX } : deps.limits;
  if (!lim) return false;
  const keys = await rateKeys(email, ctx.request.headers.get('cf-connecting-ip') ?? 'local');
  const [byEmail, byIp] = await Promise.all([countRateHit(db, keys.email, now), countRateHit(db, keys.ip, now)]);
  if ((deps.random ?? Math.random)() < RATE_PRUNE_CHANCE) {
    const prune = pruneRateLimits(db, now).catch(() => undefined);
    if (ctx.waitUntil) ctx.waitUntil(prune);
    else await prune;
  }
  return byEmail > lim.email || byIp > lim.ip;
}

const TURNSTILE_FAILED = { error: 'turnstile_failed', message: 'Please complete the check and try again.' };

/**
 * Shared by email and restore, in this order: the body and the address, Turnstile, the rate limits,
 * then `send` (or not): the answer never says which.
 */
async function linkRequest(ctx: AuthCtx, deps: AuthDeps, send: (db: D1Like, email: string, returnTo: string, body: Record<string, unknown> | null) => Promise<SendResult>): Promise<Response> {
  const env = ctx.env;
  const db = env.AUTH_DB;
  if (!db) return notConfigured('Sign-in');
  const req = ctx.request;
  if (crossSite(req)) return jsonOut(403, { error: 'forbidden' });
  const host = new URL(req.url).host;
  if (!emailProvider(env, host)) return notConfigured('Email sign-in');
  // Turnstile guards every address-taking form; only localhost may go without it.
  const checked = turnstileReady(env);
  if (!checked && !isLocalHost(host)) return notConfigured('Email sign-in');
  const body = await readJson(req);
  const email = typeof body?.email === 'string' ? normEmail(body.email) : '';
  if (!validEmail(email)) return jsonOut(400, { error: 'bad_email', message: 'That email address doesn’t look right.' });
  if (checked) {
    const token = body?.turnstileToken;
    if (typeof token !== 'string' || !token || token.length > 2048) return jsonOut(400, TURNSTILE_FAILED);
    const t = await verifyTurnstile(env, token, req, deps);
    if (t === 'unavailable') return jsonOut(503, { error: 'turnstile_unavailable', message: "Couldn't check that you're human just now. Try again in a minute." });
    if (t === 'failed') return jsonOut(400, TURNSTILE_FAILED);
  }
  const now = (deps.now ?? Date.now)();
  if (await overLimit(ctx, db, email, deps, now)) return jsonOut(429, { error: 'rate_limited', message: 'Too many sign-in emails. Try again in an hour.' });
  const returnTo = safeReturnTo(body?.returnTo, new URL(req.url).origin);
  const r = await send(db, email, returnTo, body);
  if (!r.ok) return jsonOut(r.status, { error: 'email_failed', message: r.error });
  return jsonOut(200, { ok: true });
}

function emailRoute(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  // A pass clicked while signed out rides along in the stored return_to (server-side, single use, 15 minutes).
  return linkRequest(ctx, deps, (db, email, returnTo, body) => {
    const buy = body?.buy && typeof body.buy === 'object' ? (body.buy as Record<string, unknown>) : null;
    return sendLink(ctx, db, email, linkReturnTo(returnTo, buy ? parseIntent(buy.product, buy.eventId) : null), deps, 'signin');
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
    return bought ? sendLink(ctx, db, email, linkReturnTo(returnTo, null), deps, 'restore') : { ok: true };
  });
}

// ---- devices

/** The revoke routes' common part: same site, signed in (a live session); then `act`, and the updated device list. */
async function deviceRoute(ctx: AuthCtx, deps: AuthDeps, act: (db: D1Like, user: UserRow, session: SessionRow, body: Record<string, unknown> | null, now: number) => Promise<Response | null>): Promise<Response> {
  const env = ctx.env;
  const db = env.AUTH_DB;
  if (!db) return notConfigured('Sign-in');
  const req = ctx.request;
  if (crossSite(req)) return jsonOut(403, { error: 'forbidden' });
  const now = (deps.now ?? Date.now)();
  const v = await viewerOf(req, env, now);
  if (!v.user || !v.session) return jsonOut(401, { error: 'sign_in_required', message: 'Sign in first.' });
  const refused = await act(db, v.user, v.session, await readJson(req), now);
  if (refused) return refused;
  return jsonOut(200, { ok: true, devices: await devicesOf(db, v.user, v.session, now) });
}

/** Sign out one other device of the user's (never this one: that is Sign out). */
function revokeRoute(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  return deviceRoute(ctx, deps, async (db, user, session, body, now) => {
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!PUBLIC_ID_RE.test(id)) return jsonOut(400, { error: 'bad_id', message: "That device isn't signed in." });
    if (id === session.public_id) return jsonOut(400, { error: 'current_session', message: 'Use Sign out to sign out on this device.' });
    if (!(await revokeSessionById(db, { userId: user.id, publicId: id, now, reason: 'remote' }))) return jsonOut(404, { error: 'not_found', message: "That device isn't signed in." });
    return null;
  });
}

/** Sign out every other device of the user's. */
function revokeOthersRoute(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  return deviceRoute(ctx, deps, async (db, user, session, _body, now) => {
    await revokeOtherSessions(db, { userId: user.id, keepTokenHash: session.token_hash, now, reason: 'remote' });
    return null;
  });
}

/** The auth pages' CSP: nothing loads, no script; the form posts here, and its 303 may go on to walkeforward.com (form-action covers redirects). */
export const VERIFY_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://walkeforward.com https://*.walkeforward.com; base-uri 'none'; frame-ancestors 'none'";

/** Where "Get a new link" goes: the app, which opens the sign-in sheet saying the link had expired (src/ui/paywall.ts arrive). */
export const EXPIRED_LINK_HREF = `${DEFAULT_RETURN_TO}?signin=expired`;

const LOGIN_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The success redirect's marker: the app shows "You're signed in." once and drops it from the URL. */
export const SIGNED_IN_PARAM = 'signin';
export const SIGNED_IN_VALUE = 'ok';

const PAGE_STYLE =
  "body{font:16px/1.5 Archivo,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f7fa;color:#131922}main{max-width:22rem;padding:2rem;text-align:center}h1{font-size:1.4rem;margin:0 0 1rem}[hidden]{display:none!important}button,.btn{display:inline-block;font:inherit;font-weight:600;padding:.7rem 1.6rem;border:0;border-radius:8px;background:#1f6bc4;color:#fff;text-decoration:none;cursor:pointer}a{color:#1f6bc4;font-weight:600}p{color:#46505e}.busy{display:inline-flex;align-items:center;gap:.6rem;color:#46505e}.spin{width:1.1rem;height:1.1rem;border:2px solid #c3ccd7;border-top-color:#1f6bc4;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin{animation:none}}[data-theme=dark] body{background:#10151c;color:#e9eef5}[data-theme=dark] p,[data-theme=dark] .busy{color:#b9c2ce}[data-theme=dark] a{color:#3987e5}[data-theme=dark] .spin{border-color:#3a4756;border-top-color:#3987e5}";

const authPage = (body: string, script = ''): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Sign in to Recall</title>
<script data-theme-script>${THEME_SCRIPT}</script>
<style>${PAGE_STYLE}</style>
</head><body><main>
<h1>Sign in to Recall</h1>
${body}
</main>${script ? `<script>${script}</script>` : ''}</body></html>`;

/**
 * The link page's one script (static, so the CSP allows it by its hash): take the token from the
 * fragment (new links) or the query (links sent before), take it out of the address bar at once,
 * say "Signing you in…" and POST it. No token: the expired message. Anything throws: the button.
 */
export const VERIFY_SCRIPT = `(function () {
  var $ = function (id) { return document.getElementById(id); };
  var only = function (id) { ['manual', 'nojs', 'gone'].forEach(function (x) { var el = $(x); if (el) el.hidden = x !== id; }); };
  var ok = /^[A-Za-z0-9_-]{43}$/;
  var token = '';
  try {
    var h = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    var q = new URLSearchParams(location.search).get('token') || '';
    token = ok.test(h) ? h : ok.test(q) ? q : '';
    history.replaceState(null, '', location.pathname);
  } catch (e) {}
  if (!token) return only('gone');
  $('t').value = token;
  try {
    only('');
    $('busy').hidden = false;
    $('f').submit();
  } catch (e) {
    $('busy').hidden = true;
    only('manual');
  }
})();`;

/** `'sha256-…'` of a script, for a page's script-src. */
const hashOf = (script: string): Promise<string> =>
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(script)).then((d) => {
    let s = '';
    for (const x of new Uint8Array(d)) s += String.fromCharCode(x);
    return `'sha256-${btoa(s)}'`;
  });

let scriptHash: Promise<string> | null = null;
/** `'sha256-…'` of VERIFY_SCRIPT, for the page's script-src. */
export const verifyScriptHash = (): Promise<string> => (scriptHash ??= hashOf(VERIFY_SCRIPT));

let themeHash: Promise<string> | null = null;
/** `'sha256-…'` of THEME_SCRIPT (the pages' color theme before first paint, functions/_theme.ts). */
export const themeScriptHash = (): Promise<string> => (themeHash ??= hashOf(THEME_SCRIPT));

/** The link page's CSP: VERIFY_PAGE_CSP, plus its two scripts by hash. */
export const verifyPageCsp = async (): Promise<string> => `${VERIFY_PAGE_CSP}; script-src ${await verifyScriptHash()} ${await themeScriptHash()}`;

/** The expired page's CSP: VERIFY_PAGE_CSP, plus the theme script by hash. */
export const expiredPageCsp = async (): Promise<string> => `${VERIFY_PAGE_CSP}; script-src ${await themeScriptHash()}`;

const gonePara = `<p>This link has expired or was already used.</p>
<p><a class="btn" href="${EXPIRED_LINK_HREF}">Get a new link</a></p>`;

/**
 * The magic link's page. Its script POSTs the token straight away; the form's "Sign in" button is the
 * fallback, shown from the start for an old `?token=` link (no script needed) and when the script fails.
 * A `#token=` link can't reach the server without the script, so noscript says so. Every value escaped.
 */
export function verifyPageHtml(queryToken = ''): string {
  const q = LOGIN_TOKEN_RE.test(queryToken) ? queryToken : '';
  return authPage(
    `<div id="status" role="status" aria-live="polite"><span id="busy" class="busy" hidden><span class="spin" aria-hidden="true"></span>Signing you in…</span></div>
<form id="f" method="post" action="/api/auth/verify"><input type="hidden" id="t" name="token" value="${escHtml(q)}">
<div id="manual"${q ? '' : ' hidden'}><p>Tap the button to finish signing in.</p><button type="submit">Sign in</button></div></form>
<div id="gone" hidden>${gonePara}</div>
${q ? '' : `<noscript><div id="nojs"><p>Recall needs JavaScript to finish signing in from this link. Turn it on and open the link again.</p><p><a href="${EXPIRED_LINK_HREF}">Get a new link</a></p></div></noscript>`}`,
    VERIFY_SCRIPT,
  );
}

/** After the POST, for a link that was used already or has expired: say so, and open Recall's sign-in sheet for a new one. */
export const expiredPageHtml = (): string => authPage(gonePara);

const pageOut = (html: string, status = 200, csp = VERIFY_PAGE_CSP): Response =>
  new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });

/**
 * GET (with `#token=`, which the server never sees, or an old `?token=`): the page. Uses nothing, so
 * a mail scanner that prefetches it can't spend the token; only the page's POST does.
 */
async function verifyPage(ctx: AuthCtx): Promise<Response> {
  if (!ctx.env.AUTH_DB) return notConfigured('Sign-in');
  const token = new URL(ctx.request.url).searchParams.get('token') ?? '';
  return pageOut(verifyPageHtml(token), 200, await verifyPageCsp());
}

/** POST (the page's form, same origin only): use the token once, start a session, 303 to returnTo with `signin=ok`. */
async function verifyRoute(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const db = ctx.env.AUTH_DB;
  if (!db) return notConfigured('Sign-in');
  const req = ctx.request;
  if (notSameOrigin(req)) return jsonOut(403, { error: 'forbidden' });
  const raw = await readCapped(req, MAX_BODY_BYTES);
  const token = raw ? (new URLSearchParams(new TextDecoder().decode(raw)).get('token') ?? '') : '';
  const now = (deps.now ?? Date.now)();
  const used = LOGIN_TOKEN_RE.test(token) ? await consumeLoginToken(db, await tokenHash('login', token), now) : null;
  if (!used) return pageOut(expiredPageHtml(), 400, await expiredPageCsp());
  const user = await ensureUser(db, used.email, now);
  const cookie = await startSession(db, user, req, ctx.env, now, 'email');
  const { returnTo, buy } = splitLinkReturnTo(safeReturnTo(used.returnTo, new URL(req.url).origin));
  return redirect(signedIn(await afterSignIn(db, ctx.env, user, returnTo, buy, now)), [cookie], 303);
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

// ---- OAuth (Google, Microsoft, Apple): the signed state cookie

const b64url =(bytes: Uint8Array): string => {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string): string => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

/** The sign-in providers; each signs its state with its own name in it, so one's state is no good on another's callback. */
export type OAuthProvider = 'google' | 'microsoft' | 'apple';

export interface OAuthState {
  /** Absent in a state signed before Microsoft and Apple came along: Google's. */
  provider?: OAuthProvider;
  state: string;
  nonce: string;
  /** The PKCE verifier ('' for Apple, which doesn't document PKCE for the web). */
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
  if (intentHeld(await entitlementsWithFree(db, user.id, now), user.id, buy, now)) return to;
  return withParam(to, BUY_PARAM, await signBuy(env.AUTH_SECRET, { ...buy, userId: user.id, exp: now + BUY_TTL_MS }));
}

/** A fresh sign-in's landing page, with the marker for the app's "You're signed in." toast. */
const signedIn = (to: string): string => withParam(to, SIGNED_IN_PARAM, SIGNED_IN_VALUE);

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

/**
 * The state signature's purpose prefix, distinct from the buy marker's (`recall-buy:`), so neither
 * signed value can be passed off as the other. States signed before it (10 minutes) stop working.
 */
const STATE_PURPOSE = 'oauth-state.v1.';

/** `payload.signature`, both base64url; the signature is an HMAC-SHA256 under AUTH_SECRET of STATE_PURPOSE + payload. */
export async function signState(secret: string, s: OAuthState): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(s)));
  return `${payload}.${await hmac(secret, `${STATE_PURPOSE}${payload}`)}`;
}

/** The signed state, if it is ours, unexpired and `provider`'s. */
export async function readState(secret: string, raw: string | null, now: number, provider: OAuthProvider = 'google'): Promise<OAuthState | null> {
  const [payload, sig] = (raw ?? '').split('.');
  if (!payload || !sig || !sameText(sig, await hmac(secret, `${STATE_PURPOSE}${payload}`))) return null;
  try {
    const s = JSON.parse(fromB64url(payload)) as OAuthState;
    if ((s.provider ?? 'google') !== provider) return null;
    return typeof s.exp === 'number' && now < s.exp && typeof s.state === 'string' && typeof s.nonce === 'string' && typeof s.verifier === 'string' && typeof s.returnTo === 'string' ? s : null;
  } catch {
    return null;
  }
}

const has = (v: string | undefined): boolean => !!v?.trim();
const googleReady = (env: PaywallEnv): boolean => !!(env.AUTH_DB && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.AUTH_SECRET);
/** Microsoft is offered (and its routes work) only with D1, AUTH_SECRET and both of its keys. */
export const microsoftReady = (env: PaywallEnv): boolean => !!env.AUTH_DB && has(env.AUTH_SECRET) && has(env.MICROSOFT_CLIENT_ID) && has(env.MICROSOFT_CLIENT_SECRET);
/** Apple likewise, with all four of its settings. */
export const appleReady = (env: PaywallEnv): boolean =>
  !!env.AUTH_DB && has(env.AUTH_SECRET) && has(env.APPLE_SERVICES_ID) && has(env.APPLE_TEAM_ID) && has(env.APPLE_KEY_ID) && has(env.APPLE_PRIVATE_KEY);

/** The callback the provider sends the browser back to: this origin, as registered with each provider. */
const redirectUri = (req: Request, provider: OAuthProvider): string => `${new URL(req.url).origin}/api/auth/${provider}/callback`;

/** The state cookie: host-only, 10 minutes, on the provider's own path; Apple's is SameSite=None (its callback is a cross-site POST). */
const oauthCookie = (provider: OAuthProvider, value: string, maxAgeS: number): string =>
  provider === 'apple'
    ? cookieHeader(APPLE_OAUTH_COOKIE, value, { domain: null, maxAgeS, path: '/api/auth/apple', sameSite: 'None' })
    : cookieHeader(OAUTH_COOKIE, value, { domain: null, maxAgeS, path: `/api/auth/${provider}` });

/** A start route's state: fresh state, nonce and PKCE verifier (none for Apple), the safe returnTo, and the buy intent if valid. */
function newState(url: URL, provider: OAuthProvider, now: number): OAuthState {
  const buy = parseIntent(url.searchParams.get(BUY_PARAM), url.searchParams.get('event'));
  return {
    provider,
    state: randomToken(),
    nonce: randomToken(),
    verifier: provider === 'apple' ? '' : randomToken(),
    returnTo: safeReturnTo(url.searchParams.get('returnTo'), url.origin),
    exp: now + OAUTH_TTL_S * 1000,
    ...(buy ? { buy } : {}),
  };
}

const pkceChallenge = async (verifier: string): Promise<string> => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

/** To the provider, with the signed state cookie set. */
async function toProvider(env: PaywallEnv, provider: OAuthProvider, authUrl: string, q: URLSearchParams, s: OAuthState): Promise<Response> {
  return redirect(`${authUrl}?${q}`, [oauthCookie(provider, await signState(env.AUTH_SECRET!, s), OAUTH_TTL_S)]);
}

/** The failure marker's companions: which provider it was, and why when the page has more to say (e.g. `microsoft_email`). */
export const FAILED_VIA_PARAM = 'via';
export const FAILED_REASON_PARAM = 'reason';
const failedAt = (returnTo: string, provider: OAuthProvider, reason?: string): string => {
  const to = withParam(withParam(returnTo, SIGNED_IN_PARAM, 'failed'), FAILED_VIA_PARAM, provider);
  return reason ? withParam(to, FAILED_REASON_PARAM, reason) : to;
};

/** The code for an ID token at the provider's token endpoint; null on any failure. */
async function tokenExchange(url: string, form: Record<string, string>, deps: AuthDeps): Promise<string | null> {
  try {
    const res = await (deps.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const t = ((await res.json()) as { id_token?: unknown }).id_token;
    return typeof t === 'string' ? t : null;
  } catch {
    return null;
  }
}

/**
 * Every provider's last step, as for a magic link: a session (with its method; the device cap applies),
 * then returnTo with the checkout marker for a buy intent (re-checked here) and `signin=ok`.
 */
async function finishOAuth(ctx: AuthCtx, db: D1Like, user: UserRow, method: SignInMethod, s: OAuthState, now: number, clear: string, status = 302): Promise<Response> {
  const cookie = await startSession(db, user, ctx.request, ctx.env, now, method);
  const buy = s.buy ? parseIntent(s.buy.product, s.buy.eventId) : null;
  return redirect(signedIn(await afterSignIn(db, ctx.env, user, safeReturnTo(s.returnTo, new URL(ctx.request.url).origin), buy, now)), [cookie, clear], status);
}

/**
 * Who a Microsoft or Apple sign-in is (migrations/0003_identities.sql): the user its identity already
 * signs in, whatever the email says now; else, only with a trusted email, the user with that address
 * (created if new: same verified email, same account) with the identity recorded; else nobody (null).
 * An account keyed to an address nobody proved could later collect what the real owner of that
 * address buys, so an unverified address never creates or links anything. `addedToExisting`: this
 * sign-in linked a new identity to a user who was there before it (the account is told by email).
 */
async function identityUser(db: D1Like, i: IdentityInput, trusted: boolean, now: number): Promise<{ user: UserRow; addedToExisting: boolean } | null> {
  const known = await userByIdentity(db, i.provider, i.subject, now);
  if (known) return { user: known, addedToExisting: false };
  if (!trusted || !i.email) return null;
  const existing = await userByEmail(db, i.email);
  const user = await linkIdentity(db, i, (existing ?? (await ensureUser(db, i.email, now))).id, now);
  return user ? { user, addedToExisting: !!existing && user.id === existing.id } : null;
}

/** finishOAuth, then the new-link notice when the identity was just added to an existing account. */
async function finishIdentity(ctx: AuthCtx, db: D1Like, found: { user: UserRow; addedToExisting: boolean }, method: 'microsoft' | 'apple', s: OAuthState, now: number, clear: string, deps: AuthDeps, status = 302): Promise<Response> {
  const res = await finishOAuth(ctx, db, found.user, method, s, now, clear, status);
  if (found.addedToExisting) await sendLinkNotice(ctx, found.user, method, deps);
  return res;
}

const emailClaim = (c: Claims): string | null => {
  const e = typeof c.email === 'string' ? normEmail(c.email) : '';
  return validEmail(e) ? e : null;
};
const subjectOk = (sub: unknown): sub is string => typeof sub === 'string' && sub.length > 0 && sub.length <= 255;

// ---- Google

async function googleStart(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const env = ctx.env;
  if (!googleReady(env)) return notConfigured('Google sign-in');
  const req = ctx.request;
  const s = newState(new URL(req.url), 'google', (deps.now ?? Date.now)());
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(req, 'google'),
    response_type: 'code',
    scope: 'openid email',
    state: s.state,
    nonce: s.nonce,
    code_challenge: await pkceChallenge(s.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return toProvider(env, 'google', GOOGLE_AUTH_URL, q, s);
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
  const clear = oauthCookie('google', '', 0);
  const s = await readState(env.AUTH_SECRET!, readCookie(req, OAUTH_COOKIE), now, 'google');
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (!s || !code || !sameText(state, s.state)) return redirect(failedAt('/', 'google'), [clear]);
  const failed = redirect(failedAt(s.returnTo, 'google'), [clear]);
  const idToken = await tokenExchange(
    GOOGLE_TOKEN_URL,
    { code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri(req, 'google'), grant_type: 'authorization_code', code_verifier: s.verifier },
    deps,
  );
  // The ID token came straight from Google's token endpoint over TLS in exchange for our code (and
  // our client secret and PKCE verifier): its signature need not be checked against Google's keys
  // (OpenID Connect Core 3.1.3.7). Its claims still are.
  const claims = idToken ? decodeJwtPayload(idToken) : null;
  const who = claims ? checkClaims(claims, env.GOOGLE_CLIENT_ID!, s.nonce, now) : null;
  if (!who) return failed;
  const db = env.AUTH_DB!;
  let user = await userByGoogleSub(db, who.sub);
  if (!user) {
    // Linked by verified email: the same person as a magic-link sign-in (or a purchase) with that address.
    user = await ensureUser(db, who.email, now);
    await setGoogleSub(db, user.id, who.sub);
  }
  // users.google_sub stays what Google signs in by; the identities row is a copy, best effort (no table before migration 0003).
  try {
    await linkIdentity(db, { provider: 'google', subject: who.sub, email: who.email, emailVerified: true }, user.id, now);
  } catch {
    /* migration 0003 not applied yet */
  }
  return finishOAuth(ctx, db, user, 'google', s, now, clear);
}

// ---- Microsoft (identity platform v2.0, tenant `common`)

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Microsoft's issuer names the account's tenant: `https://login.microsoftonline.com/<tid>/v2.0`, tid a GUID. */
export const microsoftIssuerOk = (iss: unknown, c: Claims): boolean => typeof c.tid === 'string' && GUID_RE.test(c.tid) && iss === `https://login.microsoftonline.com/${c.tid}/v2.0`;

/**
 * A verified Microsoft ID token's identity: `sub` (stable per app and user) with `tid` as its tenant,
 * and the `email` claim (lower-cased; absent: none). The email is trusted only when
 *  (a) the account is a personal one (tid is the personal-accounts tenant) and it has an email, or
 *  (b) a work or school account's token carries the optional claim `xms_edov` true: the tenant has
 *      verified that it owns the email's domain.
 * Any other work or school address is just what a tenant admin typed into a directory, so it may not
 * be the person's at all: it never creates or links an account (identityUser). An `email_verified`
 * claim that is there and false (false or "false") overrides both: the email is not trusted.
 */
export function microsoftIdentity(c: Claims): { identity: IdentityInput; trusted: boolean } | null {
  if (!subjectOk(c.sub) || typeof c.tid !== 'string' || !GUID_RE.test(c.tid)) return null;
  const email = emailClaim(c);
  const edov = c.xms_edov === true || c.xms_edov === 'true' || c.xms_edov === '1';
  const unverified = c.email_verified === false || c.email_verified === 'false';
  const tenant = c.tid.toLowerCase();
  const trusted = !!email && !unverified && (tenant === MICROSOFT_PERSONAL_TENANT || edov);
  return { identity: { provider: 'microsoft', subject: c.sub, email, emailVerified: trusted, tenant }, trusted };
}

async function microsoftStart(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const env = ctx.env;
  if (!microsoftReady(env)) return notConfigured('Microsoft sign-in');
  const req = ctx.request;
  const s = newState(new URL(req.url), 'microsoft', (deps.now ?? Date.now)());
  const q = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID!.trim(),
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri(req, 'microsoft'),
    scope: 'openid email profile',
    state: s.state,
    nonce: s.nonce,
    code_challenge: await pkceChallenge(s.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return toProvider(env, 'microsoft', MICROSOFT_AUTH_URL, q, s);
}

async function microsoftCallback(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const env = ctx.env;
  if (!microsoftReady(env)) return notConfigured('Microsoft sign-in');
  const req = ctx.request;
  const url = new URL(req.url);
  const now = (deps.now ?? Date.now)();
  const clear = oauthCookie('microsoft', '', 0);
  const s = await readState(env.AUTH_SECRET!, readCookie(req, OAUTH_COOKIE), now, 'microsoft');
  const state = url.searchParams.get('state') ?? '';
  if (!s || !state || !sameText(state, s.state)) return redirect(failedAt('/', 'microsoft'), [clear]);
  const failed = (reason?: string): Response => redirect(failedAt(s.returnTo, 'microsoft', reason), [clear]);
  const code = url.searchParams.get('code') ?? '';
  if (!code) return failed();
  const clientId = env.MICROSOFT_CLIENT_ID!.trim();
  const idToken = await tokenExchange(
    MICROSOFT_TOKEN_URL,
    { client_id: clientId, client_secret: env.MICROSOFT_CLIENT_SECRET!.trim(), code, redirect_uri: redirectUri(req, 'microsoft'), grant_type: 'authorization_code', code_verifier: s.verifier },
    deps,
  );
  const claims = idToken ? await verifyIdToken(idToken, { jwksUrl: MICROSOFT_JWKS_URL, iss: microsoftIssuerOk, aud: clientId, nonce: s.nonce }, deps) : null;
  const who = claims ? microsoftIdentity(claims) : null;
  if (!who) return failed();
  const db = env.AUTH_DB!;
  const found = await identityUser(db, who.identity, who.trusted, now);
  if (!found) return failed('microsoft_email');
  return finishIdentity(ctx, db, found, 'microsoft', s, now, clear, deps);
}

// ---- Apple (Sign in with Apple on the web, no Apple JS)

const APPLE_RELAY_DOMAIN = '@privaterelay.appleid.com';

/** Apple's client secret: an ES256 JWT from the .p8 key, good for 5 minutes (the imported key is kept per isolate). */
export function appleClientSecret(env: PaywallEnv, now: number): Promise<string> {
  const iat = Math.floor(now / 1000);
  return signEs256(env.APPLE_PRIVATE_KEY!, env.APPLE_KEY_ID!.trim(), { iss: env.APPLE_TEAM_ID!.trim(), iat, exp: iat + 300, aud: APPLE_ISSUER, sub: env.APPLE_SERVICES_ID!.trim() });
}

/**
 * A verified Apple ID token's identity: `sub`, and the email, trusted only with `email_verified` true
 * (boolean or "true"). A private relay address (`is_private_email`, or @privaterelay.appleid.com) is
 * verified and unique to this app: it gets an account of its own, matching only a user who already
 * has that very address. Apple may leave the email out on later sign-ins: the identity comes first.
 */
export function appleIdentity(c: Claims): { identity: IdentityInput; trusted: boolean } | null {
  if (!subjectOk(c.sub)) return null;
  const email = emailClaim(c);
  const verified = c.email_verified === true || c.email_verified === 'true';
  const relay = c.is_private_email === true || c.is_private_email === 'true' || !!email?.endsWith(APPLE_RELAY_DOMAIN);
  return { identity: { provider: 'apple', subject: c.sub, email, emailVerified: verified, isPrivateRelay: relay }, trusted: !!email && verified };
}

async function appleStart(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const env = ctx.env;
  if (!appleReady(env)) return notConfigured('Apple sign-in');
  const req = ctx.request;
  const s = newState(new URL(req.url), 'apple', (deps.now ?? Date.now)());
  // Scope `email` only: names are never asked for, stored or shown.
  const q = new URLSearchParams({
    response_type: 'code',
    response_mode: 'form_post',
    client_id: env.APPLE_SERVICES_ID!.trim(),
    redirect_uri: redirectUri(req, 'apple'),
    scope: 'email',
    state: s.state,
    nonce: s.nonce,
  });
  return toProvider(env, 'apple', APPLE_AUTH_URL, q, s);
}

/** The only Origin Apple's form post may carry (when it carries one). */
export const APPLE_ORIGIN = 'https://appleid.apple.com';

/**
 * Apple's form post comes from https://appleid.apple.com, so there is no same-origin check here: the
 * signed SameSite=None cookie, and the posted state matching it, stand in for one. An Origin other
 * than Apple's (ours included) is refused before anything is read. A missing Origin, or `null`, is
 * accepted: browsers send `Origin: null` on a cross-site form POST when the sending page's referrer
 * policy is no-referrer, and some privacy tools strip it, so refusing those would lock out real
 * users; CSRF is already prevented by the posted state having to match the HMAC-signed, host-only,
 * path-scoped cookie, which an attacker can neither read nor set. Every answer is a 303 (on to a
 * GET) and clears the cookie.
 */
async function appleCallback(ctx: AuthCtx, deps: AuthDeps): Promise<Response> {
  const env = ctx.env;
  if (!appleReady(env)) return notConfigured('Apple sign-in');
  const req = ctx.request;
  const now = (deps.now ?? Date.now)();
  const clear = oauthCookie('apple', '', 0);
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== 'null' && origin !== APPLE_ORIGIN) return redirect(failedAt('/', 'apple'), [clear], 303);
  const s = await readState(env.AUTH_SECRET!, readCookie(req, APPLE_OAUTH_COOKIE), now, 'apple');
  const raw = /^application\/x-www-form-urlencoded\b/i.test(req.headers.get('content-type') ?? '') ? await readCapped(req, MAX_BODY_BYTES) : null;
  // The posted `user` field (the name, on a first sign-in) is never read.
  const form = raw ? new URLSearchParams(new TextDecoder().decode(raw)) : null;
  const state = form?.get('state') ?? '';
  if (!s || !form || !state || !sameText(state, s.state)) return redirect(failedAt('/', 'apple'), [clear], 303);
  const failed = (reason?: string): Response => redirect(failedAt(s.returnTo, 'apple', reason), [clear], 303);
  const error = form.get('error');
  if (error) return failed(error === 'user_cancelled_authorize' ? 'cancelled' : undefined);
  const code = form.get('code') ?? '';
  if (!code) return failed();
  let clientSecret: string;
  try {
    clientSecret = await appleClientSecret(env, now);
  } catch {
    console.error('[recall auth] apple: APPLE_PRIVATE_KEY is not a usable P-256 PKCS#8 key');
    return failed();
  }
  const clientId = env.APPLE_SERVICES_ID!.trim();
  const idToken = await tokenExchange(APPLE_TOKEN_URL, { client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri(req, 'apple') }, deps);
  const claims = idToken ? await verifyIdToken(idToken, { jwksUrl: APPLE_JWKS_URL, iss: APPLE_ISSUER, aud: clientId, nonce: s.nonce }, deps) : null;
  const who = claims ? appleIdentity(claims) : null;
  if (!who) return failed();
  const db = env.AUTH_DB!;
  const found = await identityUser(db, who.identity, who.trusted, now);
  if (!found) return failed('apple_email');
  return finishIdentity(ctx, db, found, 'apple', s, now, clear, deps, 303);
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
    'sessions/revoke': { POST: () => revokeRoute(ctx, deps) },
    'sessions/revoke-others': { POST: () => revokeOthersRoute(ctx, deps) },
    'google/start': { GET: () => googleStart(ctx, deps) },
    'google/callback': { GET: () => googleCallback(ctx, deps) },
    'microsoft/start': { GET: () => microsoftStart(ctx, deps) },
    'microsoft/callback': { GET: () => microsoftCallback(ctx, deps) },
    'apple/start': { GET: () => appleStart(ctx, deps) },
    'apple/callback': { POST: () => appleCallback(ctx, deps) },
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
