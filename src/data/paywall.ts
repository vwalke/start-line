/**
 * The paywall, from the page's side: /api/auth/me says whether it is on (PAYWALL_ENABLED is a
 * Pages env var, never baked into the build), who is signed in and their passes. Anything but a
 * well-formed `{ paywall: true }` (an error, vite dev's proxy, an old deploy) reads as off, so the
 * page then looks exactly as it did before the paywall. Sign-in, checkout and sign-out go through
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

export const sendSignInLink = (email: string, returnTo: string, f?: typeof fetch): Promise<PostResult> => post(`${AUTH_BASE}/email`, { email, returnTo }, f);
export const sendRestoreLink = (email: string, returnTo: string, f?: typeof fetch): Promise<PostResult> => post(`${AUTH_BASE}/restore`, { email, returnTo }, f);
export const signOut = (f?: typeof fetch): Promise<PostResult> => post(`${AUTH_BASE}/logout`, {}, f);
export const startCheckout = (product: 'regatta' | 'season', eventId: string | null, returnTo: string, f?: typeof fetch): Promise<PostResult> =>
  post(`${BILLING_BASE}/checkout`, { product, ...(eventId ? { eventId } : {}), returnTo }, f);

export const googleStartUrl = (returnTo: string): string => `${AUTH_BASE}/google/start?${new URLSearchParams({ returnTo })}`;
export const PORTAL_URL = `${BILLING_BASE}/portal`;

/** A data request refused by the paywall: the worker's error text starts with the status (data/cache.ts). */
export const isPaywallError = (message: string): boolean => /^40[12]\b/.test(message);
