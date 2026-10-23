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

export type Me =
  | { paywall: false }
  | {
      paywall: true;
      user: { email: string } | null;
      entitlements: PassView[];
      signIn: { email: boolean; google: boolean };
    };

export const PAYWALL_OFF: Me = { paywall: false };

/** /api/auth/me's body, checked; anything unexpected is "off". */
export function parseMe(body: unknown): Me {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.paywall !== true) return PAYWALL_OFF;
  const u = b.user as { email?: unknown } | null | undefined;
  const ents = Array.isArray(b.entitlements) ? (b.entitlements as PassView[]).filter((e) => e && typeof e === 'object' && typeof e.scope === 'string') : [];
  const s = (b.signIn ?? {}) as { email?: unknown; google?: unknown };
  return {
    paywall: true,
    user: u && typeof u.email === 'string' ? { email: u.email } : null,
    entitlements: ents,
    signIn: { email: s.email === true, google: s.google === true },
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

export const sendSignInLink = (email: string, returnTo: string, f?: typeof fetch, buy?: BuyIntent | null): Promise<PostResult> =>
  post(`${AUTH_BASE}/email`, { email, returnTo, ...(buy ? { buy } : {}) }, f);
export const sendRestoreLink = (email: string, returnTo: string, f?: typeof fetch): Promise<PostResult> => post(`${AUTH_BASE}/restore`, { email, returnTo }, f);
export const signOut = (f?: typeof fetch): Promise<PostResult> => post(`${AUTH_BASE}/logout`, {}, f);
/** `intent`: the server's signed marker, for the automatic checkout right after sign-in. */
export const startCheckout = (eventId: string, returnTo: string, f?: typeof fetch, intent?: string): Promise<PostResult> =>
  post(`${BILLING_BASE}/checkout`, { product: 'regatta', eventId, returnTo, ...(intent ? { intent } : {}) }, f);

export const googleStartUrl = (returnTo: string, buy?: BuyIntent | null): string =>
  `${AUTH_BASE}/google/start?${new URLSearchParams({ returnTo, ...(buy ? { buy: buy.product, event: buy.eventId } : {}) })}`;

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
