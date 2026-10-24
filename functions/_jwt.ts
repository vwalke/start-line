/**
 * ID tokens and client-secret JWTs for Microsoft and Apple sign-in (functions/_auth.ts), with WebCrypto
 * only (no dependencies):
 *   - verifyIdToken: an RS256 token checked against the provider's JWKS (the key by `kid`; alg RS256
 *     only, so `none`, HS* and the rest fail), then its claims: exp (5 minutes of skew), iat / nbf when
 *     present, iss, aud, nonce (constant-time). Null on any failure; tokens are never logged.
 *   - The JWKS is cached per isolate for an hour; a `kid` it doesn't hold refetches it, at most once
 *     every 5 minutes per URL (a key rotation), and otherwise fails.
 *   - signEs256: an ES256 JWT (Apple's client secret) from a PKCS#8 PEM, its key imported once per isolate.
 */
import { sameText } from './_paywall';

export const JWKS_TTL_MS = 3_600_000;
export const JWKS_REFETCH_MS = 5 * 60_000;
export const CLOCK_SKEW_S = 300;

export interface JwtDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export type Claims = Record<string, unknown>;

// ---- base64url

export const b64urlBytes = (bytes: Uint8Array): string => {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const b64urlJson = (o: unknown): string => b64urlBytes(new TextEncoder().encode(JSON.stringify(o)));

/** base64url to bytes; null when it isn't base64url. */
export function fromB64urlBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const jsonPart = (s: string): Claims | null => {
  const b = fromB64urlBytes(s);
  if (!b) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(b)) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Claims) : null;
  } catch {
    return null;
  }
};

/** A compact JWS's three parts, decoded (nothing verified). */
export function decodeJwt(token: string): { header: Claims; payload: Claims; signingInput: string; signature: Uint8Array } | null {
  if (typeof token !== 'string' || token.length > 16_000) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = jsonPart(parts[0]);
  const payload = jsonPart(parts[1]);
  const signature = fromB64urlBytes(parts[2]);
  if (!header || !payload || !signature) return null;
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature };
}

// ---- JWKS

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface JwksEntry {
  /** When these keys were fetched. */
  at: number;
  keys: Jwk[];
  imported: Map<string, Promise<CryptoKey>>;
}

const jwksCache = new Map<string, JwksEntry>();
/** Tests start each case with no keys cached. */
export const clearJwksCache = (): void => jwksCache.clear();

async function fetchJwks(url: string, deps: JwtDeps, now: number): Promise<JwksEntry | null> {
  try {
    const res = await (deps.fetch ?? fetch)(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: unknown };
    const keys = Array.isArray(body?.keys) ? (body.keys as Jwk[]).filter((k) => k && typeof k === 'object' && k.kty === 'RSA' && typeof k.kid === 'string') : [];
    const entry: JwksEntry = { at: now, keys, imported: new Map() };
    jwksCache.set(url, entry);
    return entry;
  } catch {
    return null;
  }
}

/** The verifying key for `kid`: from the cached JWKS (under an hour old), else a fresh one (an unknown kid refetches at most every 5 minutes). */
async function keyFor(url: string, kid: string, deps: JwtDeps, now: number): Promise<CryptoKey | null> {
  let entry = jwksCache.get(url) ?? null;
  if (!entry || now - entry.at >= JWKS_TTL_MS) entry = await fetchJwks(url, deps, now);
  else if (!entry.keys.some((k) => k.kid === kid) && now - entry.at >= JWKS_REFETCH_MS) entry = await fetchJwks(url, deps, now);
  const jwk = entry?.keys.find((k) => k.kid === kid);
  if (!entry || !jwk) return null;
  let key = entry.imported.get(kid);
  if (!key) {
    const { kty, n, e } = jwk;
    key = crypto.subtle.importKey('jwk', { kty, n, e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    entry.imported.set(kid, key);
  }
  try {
    return await key;
  } catch {
    entry.imported.delete(kid);
    return null;
  }
}

// ---- verifying an ID token

export interface IdTokenRules {
  jwksUrl: string;
  /** The issuer: a fixed string, or a check of the claims (Microsoft's depends on the tenant). */
  iss: string | ((iss: unknown, claims: Claims) => boolean);
  aud: string;
  nonce: string;
}

const audOk = (aud: unknown, want: string): boolean => (Array.isArray(aud) ? aud.length > 0 && aud.every((a) => typeof a === 'string') && aud.includes(want) : aud === want);

/** The claims' times, issuer, audience and nonce (`now` in ms). */
export function claimsOk(c: Claims, r: Omit<IdTokenRules, 'jwksUrl'>, now: number): boolean {
  const t = now / 1000;
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp) || c.exp + CLOCK_SKEW_S <= t) return false;
  if (c.iat !== undefined && (typeof c.iat !== 'number' || c.iat - CLOCK_SKEW_S > t)) return false;
  if (c.nbf !== undefined && (typeof c.nbf !== 'number' || c.nbf - CLOCK_SKEW_S > t)) return false;
  if (typeof r.iss === 'string' ? c.iss !== r.iss : !r.iss(c.iss, c)) return false;
  if (!audOk(c.aud, r.aud)) return false;
  return typeof c.nonce === 'string' && !!r.nonce && sameText(c.nonce, r.nonce);
}

/** An RS256 ID token's claims once its signature (the provider's JWKS) and claims check out; null otherwise. */
export async function verifyIdToken(token: unknown, r: IdTokenRules, deps: JwtDeps = {}): Promise<Claims | null> {
  if (typeof token !== 'string') return null;
  const jwt = decodeJwt(token);
  if (!jwt || jwt.header.alg !== 'RS256' || typeof jwt.header.kid !== 'string' || !jwt.header.kid) return null;
  if (jwt.header.crit !== undefined) return null;
  const now = (deps.now ?? Date.now)();
  const key = await keyFor(r.jwksUrl, jwt.header.kid, deps, now);
  if (!key) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, jwt.signature, new TextEncoder().encode(jwt.signingInput));
  } catch {
    return null;
  }
  return ok && claimsOk(jwt.payload, r, now) ? jwt.payload : null;
}

// ---- ES256 (Apple's client secret)

/** A PKCS#8 PEM's DER bytes: literal "\n" sequences and surrounding whitespace tolerated. */
export function pemDer(pem: string): Uint8Array | null {
  const m = /^-----BEGIN PRIVATE KEY-----([\s\S]+)-----END PRIVATE KEY-----$/.exec(pem.replace(/\\n/g, '\n').trim());
  const body = m ? m[1].replace(/\s+/g, '') : '';
  if (!body || !/^[A-Za-z0-9+/]+=*$/.test(body)) return null;
  try {
    return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const ecKeys = new Map<string, Promise<CryptoKey>>();

function ecKey(pem: string): Promise<CryptoKey> {
  let key = ecKeys.get(pem);
  if (!key) {
    const der = pemDer(pem);
    key = der ? crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) : Promise.reject(new Error('bad PEM'));
    key.catch(() => ecKeys.delete(pem));
    ecKeys.set(pem, key);
  }
  return key;
}

/** A compact ES256 JWT (WebCrypto's ECDSA signature is already JOSE's raw r||s). */
export async function signEs256(pem: string, kid: string, payload: Claims): Promise<string> {
  const input = `${b64urlJson({ alg: 'ES256', kid })}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await ecKey(pem), new TextEncoder().encode(input));
  return `${input}.${b64urlBytes(new Uint8Array(sig))}`;
}
