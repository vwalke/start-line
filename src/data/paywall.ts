/**
 * The paywall, from the page's side: /api/auth/me says whether it is on (PAYWALL_ENABLED is a
 * Pages env var, never baked into the build), who is signed in and their passes. With the flag off
 * it answers 404 (the proxy's unknown endpoint). That, or anything else but a well-formed
 * `{ paywall: true }` (an error, vite dev's proxy, an old deploy), reads as off, quietly (nothing
 * logged), so the page then looks exactly as it did before the paywall. Sign-in, checkout and sign-out go through
 * the same-origin /api/auth and /api/billing routes (functions/_auth.ts, functions/_stripe.ts).
 */
import type { PassView } from '../../functions/_entitlements';

export const AUTH_BASE = '/api/auth';
export const BILLING_BASE = '/api/billing';

/** Why this browser was signed out from elsewhere: the 3-device cap, another device, or the admin. */
export type SignedOutReason = 'device_limit' | 'remote' | 'admin';

/** How a session signed in (functions/_authDb.ts SignInMethod); null for older rows. */
export type SignInMethod = 'email' | 'google' | 'microsoft' | 'apple';
const METHODS: readonly SignInMethod[] = ['email', 'google', 'microsoft', 'apple'];

/** The sign-in providers with a start route (functions/_auth.ts OAuthProvider). */
export type OAuthProvider = 'google' | 'microsoft' | 'apple';

/** One signed-in device of the account (`id` is the session's public id; never a token). */
export interface DeviceView {
  id: string;
  label: string;
  method: SignInMethod | null;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

/** A device this sign-in signed out (the cap): its name and when it was last used. */
export interface BumpedView {
  label: string;
  lastSeenAt: number;
}

export type Me =
  | { paywall: false }
  | {
      paywall: true;
      user: { email: string } | null;
      entitlements: PassView[];
      /** turnstileSiteKey: the email forms' Turnstile widget (null or absent: none). microsoft / apple: absent reads as off. */
      signIn: { email: boolean; google: boolean; microsoft?: boolean; apple?: boolean; turnstileSiteKey?: string | null };
      signedOutReason?: SignedOutReason;
      devices?: { max: number; list: DeviceView[] };
      bumped?: BumpedView[];
    };

export const PAYWALL_OFF: Me = { paywall: false };

const REASONS: readonly SignedOutReason[] = ['device_limit', 'remote', 'admin'];
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function parseDevices(raw: unknown): { max: number; list: DeviceView[] } | undefined {
  const d = (raw && typeof raw === 'object' ? raw : null) as { max?: unknown; list?: unknown } | null;
  if (!d || !isNum(d.max) || !Array.isArray(d.list)) return undefined;
  const list = (d.list as Record<string, unknown>[])
    .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.label === 'string' && isNum(x.createdAt) && isNum(x.lastSeenAt))
    .map((x): DeviceView => ({
      id: x.id as string,
      label: x.label as string,
      method: METHODS.includes(x.method as SignInMethod) ? (x.method as SignInMethod) : null,
      createdAt: x.createdAt as number,
      lastSeenAt: x.lastSeenAt as number,
      current: x.current === true,
    }));
  return { max: d.max, list };
}

/** /api/auth/me's body, checked; anything unexpected is "off". */
export function parseMe(body: unknown): Me {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.paywall !== true) return PAYWALL_OFF;
  const u = b.user as { email?: unknown } | null | undefined;
  const ents = Array.isArray(b.entitlements) ? (b.entitlements as PassView[]).filter((e) => e && typeof e === 'object' && typeof e.scope === 'string') : [];
  const s = (b.signIn ?? {}) as { email?: unknown; google?: unknown; microsoft?: unknown; apple?: unknown; turnstileSiteKey?: unknown };
  const user = u && typeof u.email === 'string' ? { email: u.email } : null;
  const devices = user ? parseDevices(b.devices) : undefined;
  const bumped = user && Array.isArray(b.bumped) ? (b.bumped as Record<string, unknown>[]).filter((x) => x && typeof x.label === 'string' && isNum(x.lastSeenAt)).map((x) => ({ label: x.label as string, lastSeenAt: x.lastSeenAt as number })) : [];
  const reason = !user && REASONS.includes(b.signedOutReason as SignedOutReason) ? (b.signedOutReason as SignedOutReason) : undefined;
  return {
    paywall: true,
    user,
    entitlements: ents,
    signIn: {
      email: s.email === true,
      google: s.google === true,
      microsoft: s.microsoft === true,
      apple: s.apple === true,
      turnstileSiteKey: typeof s.turnstileSiteKey === 'string' && s.turnstileSiteKey ? s.turnstileSiteKey : null,
    },
    ...(reason ? { signedOutReason: reason } : {}),
    ...(devices ? { devices } : {}),
    ...(bumped.length ? { bumped } : {}),
  };
}

export async function fetchMe(doFetch: typeof fetch = fetch): Promise<Me> {
  try {
    const res = await doFetch(`${AUTH_BASE}/me`, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return PAYWALL_OFF;
    return parseMe(await res.json());
  } catch {
    return PAYWALL_OFF;
  }
}

export interface PostResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

async function post(url: string, body: unknown, doFetch: typeof fetch = fetch): Promise<PostResult> {
  try {
    const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body: json && typeof json === 'object' ? json : {} };
  } catch {
    return { ok: false, status: 0, body: { message: "Couldn't reach Recall. Check your connection and try again." } };
  }
}

/** What a signed-out sailor clicked (a Regatta Pass, the only pass on sale): carried through sign-in (the server checks and signs it). */
export interface BuyIntent {
  product: 'regatta';
  eventId: string;
}

/** `turnstileToken`: the Turnstile widget's answer, when the site uses Turnstile. */
export const sendSignInLink = (email: string, returnTo: string, f?: typeof fetch, buy?: BuyIntent | null, turnstileToken?: string | null): Promise<PostResult> =>
  post(`${AUTH_BASE}/email`, { email, returnTo, ...(buy ? { buy } : {}), ...(turnstileToken ? { turnstileToken } : {}) }, f);
export const sendRestoreLink = (email: string, returnTo: string, f?: typeof fetch, turnstileToken?: string | null): Promise<PostResult> =>
  post(`${AUTH_BASE}/restore`, { email, returnTo, ...(turnstileToken ? { turnstileToken } : {}) }, f);
export const signOut = (f?: typeof fetch): Promise<PostResult> => post(`${AUTH_BASE}/logout`, {}, f);
/** Sign out another device of the account (by its id in the device list); the answer carries the updated `devices`. */
export const revokeDevice = (id: string, f?: typeof fetch): Promise<PostResult> => post(`${AUTH_BASE}/sessions/revoke`, { id }, f);
export const revokeOtherDevices = (f?: typeof fetch): Promise<PostResult> => post(`${AUTH_BASE}/sessions/revoke-others`, {}, f);
/** `intent`: the server's signed marker, for the automatic checkout right after sign-in. */
export const startCheckout = (eventId: string, returnTo: string, f?: typeof fetch, intent?: string): Promise<PostResult> =>
  post(`${BILLING_BASE}/checkout`, { product: 'regatta', eventId, returnTo, ...(intent ? { intent } : {}) }, f);

/** A provider's start route, with where to come back to and the pass being bought (if any). */
export const oauthStartUrl = (provider: OAuthProvider, returnTo: string, buy?: BuyIntent | null): string =>
  `${AUTH_BASE}/${provider}/start?${new URLSearchParams({ returnTo, ...(buy ? { buy: buy.product, event: buy.eventId } : {}) })}`;
export const googleStartUrl = (returnTo: string, buy?: BuyIntent | null): string => oauthStartUrl('google', returnTo, buy);
export const microsoftStartUrl = (returnTo: string, buy?: BuyIntent | null): string => oauthStartUrl('microsoft', returnTo, buy);
export const appleStartUrl = (returnTo: string, buy?: BuyIntent | null): string => oauthStartUrl('apple', returnTo, buy);

/** The one-time marker the server adds after a sign-in that carried an intent (functions/_auth.ts BUY_PARAM). */
export const BUY_PARAM = 'buy';

/** The marker's intent as the page reads it (unverified: the server checks the signature on checkout); an old `season` marker is none. */
export function peekBuy(token: string | null): BuyIntent | null {
  const payload = token?.split('.')[0];
  if (!payload || token!.length > 600) return null;
  try {
    const o = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (payload.length % 4)) % 4))) as { p?: unknown; e?: unknown };
    if (o.p === 'regatta' && typeof o.e === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(o.e)) return { product: 'regatta', eventId: o.e };
  } catch {
    /* not a marker */
  }
  return null;
}
/** Manage subscription: a same-origin POST answered with `{ url }` (Stripe's Billing Portal), which the page then opens. */
export const openPortal = (f?: typeof fetch): Promise<PostResult> => post(`${BILLING_BASE}/portal`, {}, f);

/** A data request refused by the paywall: the worker's error text starts with the status (data/cache.ts). */
export const isPaywallError = (message: string): boolean => /^40[12]\b/.test(message);
