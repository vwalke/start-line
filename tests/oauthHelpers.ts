/**
 * Shared bits for the Microsoft / Apple sign-in tests: RSA (RS256) and P-256 keys made with WebCrypto,
 * signed ID tokens, and a fake provider (token endpoint + JWKS) behind the injectable fetch. No real
 * network call is ever made; every id and secret is an obvious fake.
 */
import { b64urlBytes, b64urlJson } from '../functions/_jwt';

export interface RsaKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function rsaKey(kid: string): Promise<RsaKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty: pub.kty, n: pub.n, e: pub.e, alg: 'RS256', use: 'sig', kid } };
}

/** A compact RS256 JWT signed with `key` (the header may be overridden, e.g. alg or kid). */
export async function signRs256(key: RsaKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const input = `${b64urlJson({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header })}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64urlBytes(new Uint8Array(sig))}`;
}

/** A P-256 key pair and its private key as a PKCS#8 PEM (64-character lines), as Apple's .p8 file is. */
export async function p256Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = Buffer.from(der).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

export interface ProviderCall {
  url: string;
  body: URLSearchParams | null;
}

/**
 * A provider behind fetch: `tokenUrl` answers `{ id_token }` (from `idToken`, which sees the posted
 * form), `jwksUrl` answers the current `keys`; anything else is a 404. `calls` keeps every request.
 */
export function fakeProvider(o: {
  tokenUrl: string;
  jwksUrl: string;
  keys: () => JsonWebKey[];
  idToken: (form: URLSearchParams) => Promise<string> | string;
  tokenStatus?: number;
}): typeof fetch & { calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? new URLSearchParams(String(init.body)) : null;
    calls.push({ url, body });
    if (url === o.jwksUrl) return new Response(JSON.stringify({ keys: o.keys() }), { headers: { 'content-type': 'application/json' } });
    if (url === o.tokenUrl) {
      if (o.tokenStatus && o.tokenStatus !== 200) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: o.tokenStatus });
      return new Response(JSON.stringify({ id_token: await o.idToken(body!), access_token: 'access_test_fake', token_type: 'Bearer' }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch & { calls: ProviderCall[] };
  f.calls = calls;
  return f;
}

/** A JWT's header and payload, decoded (nothing verified). */
export const jwtParts = (jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown>; input: string; sig: Uint8Array } => {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>,
    input: `${h}.${p}`,
    sig: new Uint8Array(Buffer.from(s, 'base64url')),
  };
};
