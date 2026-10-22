/**
 * Paywall (phase 1): the flag, the session cookie, and the gate the data routes call. Kept in a `_`
 * file (not a route). Everything here is inert unless PAYWALL_ENABLED is "1", "true" or "on": with
 * it off, the data routes never call in here and the auth / billing routes answer 404 (README
 * "Paywall (phase 1, behind PAYWALL_ENABLED)").
 *
 * The gate: race 1 of each division is free (src/data/freeRace.ts); anything else needs a session
 * (401 sign_in_required) and an entitlement for the event (402 payment_required). Entitled data may
 * still come from the shared edge cache entry (it is the same for everyone entitled), but goes to the
 * browser as `private, max-age=300` with `Vary: Cookie`; free data keeps the route's own caching.
 */
import { allowed, type Entitlement } from './_entitlements';
import { entitlementsOf, sessionUser, type D1Like, type UserRow } from './_authDb';
import { UA, UPSTREAM, MAX_UPSTREAM_BYTES, looksLikeJson, ttlFor } from './_lib';
import { sha256Hex } from '../src/data/vkx/compact';
import { freeRacesOf, isFreeRace, telemetryIsFree, type FreeRaces } from '../src/data/freeRace';
import type { RegattaResponse } from '../src/data/racesense/types';
import type { AskIds } from '../src/data/askCoach/protocol';
import { DIV_NAME_RE, EVENT_ID_RE } from '../src/data/vkx/validate';

/** Cloudflare Email Sending's `send_email` binding, as far as we use it (see _auth.ts sendEmail). */
export interface EmailBindingLike {
  send(message: unknown): Promise<unknown>;
}

export interface PaywallEnv {
  PAYWALL_ENABLED?: string;
  AUTH_DB?: D1Like;
  AUTH_COOKIE_DOMAIN?: string;
  /** Signs the short-lived Google sign-in cookie. */
  AUTH_SECRET?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  EMAIL?: EmailBindingLike;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_REGATTA?: string;
  STRIPE_PRICE_SEASON?: string;
  STRIPE_MANAGED_PAYMENTS?: string;
  STRIPE_API_VERSION?: string;
}

export interface PaywallDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Edge cache (caches.default in production); null to skip. */
  cache?: Cache | null;
}

/** Only "1", "true" or "on" (any case) turn it on. */
export const flagOn = (raw: string | undefined): boolean => /^(1|true|on)$/i.test((raw ?? '').trim());
export const paywallOn = (env: { PAYWALL_ENABLED?: string } | undefined): boolean => flagOn(env?.PAYWALL_ENABLED);

// ---- responses

const SECURITY = { 'x-content-type-options': 'nosniff' };

export const jsonOut = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...headers } });

/** What a route answers with the flag off: exactly the catch-all proxy's unknown-endpoint 404. */
export const notFound = (): Response => jsonOut(404, { error: 'Unknown endpoint' });

export const PRIVATE_CACHE = 'private, max-age=300';

/** An entitled (not free) response for the browser: private, varying by cookie. */
export function privately(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('cache-control', PRIVATE_CACHE);
  h.set('vary', 'Cookie');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// ---- crypto helpers

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 (hex) of a token, with a purpose prefix so a token of one kind never matches another. */
export const tokenHash = (kind: 'session' | 'login', token: string): Promise<string> => sha256Hex(new TextEncoder().encode(`recall-${kind}:${token}`));

export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---- cookies

export const SESSION_COOKIE = 'wf_session';
export const DEFAULT_COOKIE_DOMAIN = '.walkeforward.com';

/** The Domain attribute for this host: none on localhost / *.pages.dev or any host outside the cookie domain. */
export function cookieDomain(host: string, env: PaywallEnv): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  const d = (env.AUTH_COOKIE_DOMAIN?.trim() || DEFAULT_COOKIE_DOMAIN).toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || h === 'pages.dev' || h.endsWith('.pages.dev')) return null;
  const bare = d.replace(/^\./, '');
  return h === bare || h.endsWith(`.${bare}`) ? d : null;
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function cookieHeader(name: string, value: string, o: { domain: string | null; maxAgeS: number; path?: string }): string {
  return [`${name}=${value}`, ...(o.domain ? [`Domain=${o.domain}`] : []), `Path=${o.path ?? '/'}`, `Max-Age=${o.maxAgeS}`, 'Secure', 'HttpOnly', 'SameSite=Lax'].join('; ');
}

export const sessionCookie = (token: string, req: Request, env: PaywallEnv, maxAgeS: number): string =>
  cookieHeader(SESSION_COOKIE, token, { domain: cookieDomain(new URL(req.url).host, env), maxAgeS });

// ---- who is asking (cached per isolate ~60 s)

export const SESSION_CACHE_MS = 60_000;
const SESSION_CACHE_MAX = 5_000;

export interface Viewer {
  user: UserRow | null;
  entitlements: Entitlement[];
}

const NOBODY: Viewer = { user: null, entitlements: [] };
const viewers = new Map<string, { at: number; v: Viewer }>();

/** Forget a session's cached lookup (sign-out, or a fresh /api/auth/me). */
export const forgetViewer = (hash: string): boolean => viewers.delete(hash);
export const clearViewerCache = (): void => viewers.clear();

/** The session's user and entitlements; `fresh` skips (and refills) the cache. */
export async function viewerOf(req: Request, env: PaywallEnv, now: number, fresh = false): Promise<Viewer & { hash: string | null }> {
  const token = readCookie(req, SESSION_COOKIE);
  const db = env.AUTH_DB;
  if (!token || !TOKEN_RE.test(token) || !db) return { ...NOBODY, hash: null };
  const hash = await tokenHash('session', token);
  const hit = viewers.get(hash);
  if (!fresh && hit && now - hit.at < SESSION_CACHE_MS) return { ...hit.v, hash };
  const user = await sessionUser(db, hash, now);
  const v: Viewer = user ? { user, entitlements: await entitlementsOf(db, user.id) } : NOBODY;
  if (viewers.size >= SESSION_CACHE_MAX) viewers.delete(viewers.keys().next().value!);
  viewers.set(hash, { at: now, v });
  return { ...v, hash };
}

// ---- the regatta document, for race 1 (edge cache shared with /api/regatta, then ~2 min per isolate)

export const FREE_CACHE_MS = 2 * 60_000;
const freeCache = new Map<string, { at: number; free: FreeRaces }>();
export const clearFreeCache = (): void => freeCache.clear();

/** Each division's race 1 for an event; null when the document can't be had (upstream down). A missing event has no free race. */
export async function freeRacesFor(eventId: string, origin: string, deps: PaywallDeps): Promise<FreeRaces | null> {
  const now = (deps.now ?? Date.now)();
  const hit = freeCache.get(eventId);
  if (hit && now - hit.at < FREE_CACHE_MS) return hit.free;
  const qs = new URLSearchParams({ event: eventId });
  const key = new Request(`${origin}/api/regatta?${qs}`);
  let body: string | null = null;
  if (deps.cache) {
    try {
      const res = await deps.cache.match(key);
      if (res) body = await res.text();
    } catch {
      /* best-effort */
    }
  }
  if (body == null) {
    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(`${UPSTREAM}regatta?${qs}`, { headers: { accept: 'application/json', 'user-agent': UA } });
    } catch {
      return null;
    }
    if (res.status === 404) body = '{}';
    else {
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > MAX_UPSTREAM_BYTES || !looksLikeJson(text)) return null;
      body = text;
      // Filled as /api/regatta fills it, so either route's copy serves the other.
      const ttl = ttlFor('regatta', qs, text);
      const out = new Response(text, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${Math.min(ttl, 300)}, s-maxage=${ttl}`, ...SECURITY, 'x-start-line-cache-ttl': String(ttl) },
      });
      if (deps.cache) await deps.cache.put(key, out).catch(() => undefined);
    }
  }
  let free: FreeRaces;
  try {
    free = freeRacesOf(JSON.parse(body) as RegattaResponse);
  } catch {
    free = { divisions: [], windows: [] };
  }
  if (freeCache.size > 500) freeCache.clear();
  freeCache.set(eventId, { at: now, free });
  return free;
}

// ---- the gate

export type GateResult =
  /** Free (race 1): keep the route's own caching. */
  | { kind: 'free' }
  /** Entitled: serve, privately. */
  | { kind: 'entitled' }
  | { kind: 'deny'; response: Response };

export const PAYMENT_REQUIRED = 'payment_required';
export const SIGN_IN_REQUIRED = 'sign_in_required';

export function denied(signedIn: boolean, eventId: string | null, race: number | string | null): Response {
  return signedIn
    ? jsonOut(402, { error: PAYMENT_REQUIRED, eventId, race, message: 'Race 1 is free. Unlock this regatta (or get a Season Pass) to see the rest.' })
    : jsonOut(401, { error: SIGN_IN_REQUIRED, eventId, race, message: 'Race 1 is free. Sign in and unlock this regatta to see the rest.' });
}

/**
 * Decide one request: `isFree` says whether it is race 1's (null when that can't be known, e.g.
 * the document is unreachable: then only an entitlement lets it through, else 502). `race` goes
 * into the 401 / 402 body for the page.
 */
export async function gate(
  req: Request,
  env: PaywallEnv,
  o: { eventId: string | null; race: number | string | null; isFree: (() => Promise<boolean | null>) | boolean },
  deps: PaywallDeps = {},
): Promise<GateResult> {
  const now = (deps.now ?? Date.now)();
  const free = typeof o.isFree === 'boolean' ? o.isFree : await o.isFree();
  if (free === true) return { kind: 'free' };
  let v: Viewer;
  try {
    v = await viewerOf(req, env, now);
  } catch {
    // D1 unreachable: fail closed (race 1 never gets here).
    return { kind: 'deny', response: jsonOut(503, { error: 'auth_unavailable', message: 'Sign-in is unavailable right now. Try again in a minute.' }) };
  }
  if (allowed(v.entitlements, v.user?.id ?? null, { eventId: o.eventId, free: false, now })) return { kind: 'entitled' };
  if (free === null) return { kind: 'deny', response: jsonOut(502, { error: 'Upstream unreachable' }) };
  return { kind: 'deny', response: denied(!!v.user, o.eventId, o.race) };
}

// ---- the data routes' gates

/**
 * /api/telemetry/event/ID?after&before[&division]: free when the whole window lies in race 1's free
 * window (src/data/freeRace.ts telemetryIsFree); any window reaching past it (a later race, or a
 * window spanning race 1 and more) needs an entitlement. The client's pages of one race all share its
 * window's `before` and start inside it, so race 1's pages are all free.
 */
export function telemetryGate(req: Request, env: PaywallEnv, eventId: string, qs: URLSearchParams, deps: PaywallDeps = {}): Promise<GateResult> {
  const origin = new URL(req.url).origin;
  const after = Number(qs.get('after'));
  const before = Number(qs.get('before'));
  const division = qs.get('division');
  const isFree = async (): Promise<boolean | null> => {
    const f = await freeRacesFor(eventId, origin, deps);
    return f ? telemetryIsFree(f, division, after, before) : null;
  };
  return gate(req, env, { eventId, race: null, isFree }, deps);
}

/** /api/vkx/data?event&div&race&sn&h: race 1's boat logs are free. Malformed ids pass to the handler (its 400). */
export function vkxGate(req: Request, env: PaywallEnv, deps: PaywallDeps = {}): Promise<GateResult> {
  const url = new URL(req.url);
  const event = url.searchParams.get('event') ?? '';
  const div = url.searchParams.get('div') ?? '';
  const race = url.searchParams.get('race') ?? '';
  if (!EVENT_ID_RE.test(event) || !DIV_NAME_RE.test(div) || !/^\d{1,12}$/.test(race)) return Promise.resolve({ kind: 'free' });
  const isFree = async (): Promise<boolean | null> => {
    const f = await freeRacesFor(event, url.origin, deps);
    return f ? isFreeRace(f, div, Number(race)) : null;
  };
  return gate(req, env, { eventId: event, race: Number(race), isFree }, deps);
}

/**
 * Ask Coach: a question about race 1 (the Race view) is free; about another race, or the Regatta
 * view (every race), it needs an entitlement for the event. With no event id, only a pass for every
 * regatta will do. The deny response, or null to go on.
 */
export async function askGate(req: Request, env: PaywallEnv, ids: AskIds, deps: PaywallDeps = {}): Promise<Response | null> {
  const eventId = ids.event ?? null;
  const origin = new URL(req.url).origin;
  const isFree = async (): Promise<boolean | null> => {
    if (!eventId || ids.view === 'regatta' || !ids.div || !ids.race || !/^\d{1,12}$/.test(ids.race)) return false;
    const f = await freeRacesFor(eventId, origin, deps);
    return f ? isFreeRace(f, ids.div, Number(ids.race)) : null;
  };
  const g = await gate(req, env, { eventId, race: ids.race ?? null, isFree }, deps);
  return g.kind === 'deny' ? g.response : null;
}
