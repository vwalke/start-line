import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLOCK_SKEW_S, JWKS_REFETCH_MS, JWKS_TTL_MS, b64urlBytes, b64urlJson, claimsOk, clearJwksCache, decodeJwt, pemDer, signEs256, verifyIdToken, type IdTokenRules } from '../functions/_jwt';
import { NOW } from './paywallHelpers';
import { fakeProvider, jwtParts, p256Pem, rsaKey, signRs256, type RsaKey } from './oauthHelpers';

const JWKS = 'https://login.example/keys';
const RULES: IdTokenRules = { jwksUrl: JWKS, iss: 'https://issuer.example', aud: 'client-test-fake', nonce: 'nonce-test-fake' };
const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: 'https://issuer.example',
  aud: 'client-test-fake',
  sub: 'subject-1',
  iat: NOW / 1000 - 10,
  exp: NOW / 1000 + 600,
  nonce: 'nonce-test-fake',
  ...over,
});

let k1: RsaKey;
let k2: RsaKey;
let other: RsaKey;
beforeAll(async () => {
  [k1, k2, other] = await Promise.all([rsaKey('kid-1'), rsaKey('kid-2'), rsaKey('kid-1')]);
});
beforeEach(clearJwksCache);

/** A JWKS endpoint serving `keys` (changeable), counting its fetches. */
const jwks = (keys: () => JsonWebKey[]) => fakeProvider({ tokenUrl: 'https://unused.example/token', jwksUrl: JWKS, keys, idToken: () => '' });

describe('verifyIdToken (RS256 against a JWKS)', () => {
  it('a good signature and good claims pass, and answer the claims', async () => {
    const f = jwks(() => [k1.jwk, k2.jwk]);
    const token = await signRs256(k2, claims());
    expect(await verifyIdToken(token, RULES, { fetch: f, now: () => NOW })).toMatchObject({ sub: 'subject-1' });
    expect(f.calls.map((c) => c.url)).toEqual([JWKS]);
  });

  it('a tampered payload, the wrong key or an unknown kid fail', async () => {
    const f = jwks(() => [k1.jwk]);
    const deps = { fetch: f, now: () => NOW };
    const good = await signRs256(k1, claims());
    const [h, , s] = good.split('.');
    expect(await verifyIdToken(`${h}.${b64urlJson(claims({ sub: 'someone-else' }))}.${s}`, RULES, deps)).toBeNull();
    // Same kid, another key's signature.
    expect(await verifyIdToken(await signRs256(other, claims()), RULES, deps)).toBeNull();
    expect(await verifyIdToken(await signRs256(k2, claims()), RULES, deps)).toBeNull();
    expect(await verifyIdToken(await signRs256(k1, claims(), { kid: undefined }), RULES, deps)).toBeNull();
    expect(await verifyIdToken(good, RULES, deps)).not.toBeNull();
  });

  it('only RS256: alg none, HS256 and ES256 fail, whatever the signature', async () => {
    const f = jwks(() => [k1.jwk]);
    const deps = { fetch: f, now: () => NOW };
    const body = b64urlJson(claims());
    expect(await verifyIdToken(`${b64urlJson({ alg: 'none', kid: 'kid-1' })}.${body}.`, RULES, deps)).toBeNull();
    for (const alg of ['HS256', 'ES256', 'RS512', 'PS256']) {
      const t = await signRs256(k1, claims(), { alg });
      expect(await verifyIdToken(t, RULES, deps), alg).toBeNull();
    }
    // An HMAC "signed" with the public key's modulus as the secret (the classic confusion) fails too.
    const input = `${b64urlJson({ alg: 'HS256', kid: 'kid-1' })}.${body}`;
    const hk = await crypto.subtle.importKey('raw', new TextEncoder().encode(k1.jwk.n!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hk, new TextEncoder().encode(input)));
    expect(await verifyIdToken(`${input}.${b64urlBytes(mac)}`, RULES, deps)).toBeNull();
    for (const junk of ['', 'a.b', 'a.b.c.d', `${input}.!!`, 42, null]) expect(await verifyIdToken(junk, RULES, deps)).toBeNull();
  });

  it('expired (beyond 5 minutes of skew), iat or nbf in the future, wrong iss, aud or nonce fail', async () => {
    const f = jwks(() => [k1.jwk]);
    const deps = { fetch: f, now: () => NOW };
    const run = async (over: Record<string, unknown>, rules: Partial<IdTokenRules> = {}) => verifyIdToken(await signRs256(k1, claims(over)), { ...RULES, ...rules }, deps);
    expect(await run({ exp: NOW / 1000 - CLOCK_SKEW_S - 1 })).toBeNull();
    expect(await run({ exp: NOW / 1000 - CLOCK_SKEW_S + 30 })).not.toBeNull();
    expect(await run({ exp: undefined })).toBeNull();
    expect(await run({ exp: String(NOW / 1000 + 600) })).toBeNull();
    expect(await run({ iat: NOW / 1000 + CLOCK_SKEW_S + 60 })).toBeNull();
    expect(await run({ iat: 'yesterday' })).toBeNull();
    expect(await run({ nbf: NOW / 1000 + CLOCK_SKEW_S + 60 })).toBeNull();
    expect(await run({ nbf: NOW / 1000 - 5 })).not.toBeNull();
    expect(await run({ iss: 'https://evil.example' })).toBeNull();
    expect(await run({ aud: 'someone-else' })).toBeNull();
    expect(await run({ aud: ['someone-else', 'client-test-fake'] })).not.toBeNull();
    expect(await run({ nonce: 'nonce-test-other' })).toBeNull();
    expect(await run({ nonce: undefined })).toBeNull();
    expect(await run({}, { nonce: '' })).toBeNull();
    // The issuer may be a check of the claims (Microsoft's names the tenant).
    expect(await run({ tid: 't1', iss: 'https://issuer.example/t1' }, { iss: (iss, c) => iss === `https://issuer.example/${String(c.tid)}` })).not.toBeNull();
    expect(await run({ tid: 't1', iss: 'https://issuer.example/t2' }, { iss: (iss, c) => iss === `https://issuer.example/${String(c.tid)}` })).toBeNull();
    expect(claimsOk(claims(), RULES, NOW)).toBe(true);
  });

  it('JWKS: cached an hour; an unknown kid refetches once (at most every 5 minutes), then fails', async () => {
    let keys: JsonWebKey[] = [k1.jwk];
    const f = jwks(() => keys);
    let now = NOW;
    const deps = { fetch: f, now: () => now };
    const t1 = await signRs256(k1, claims());
    const t2 = await signRs256(k2, claims());
    expect(await verifyIdToken(t1, RULES, deps)).not.toBeNull();
    expect(await verifyIdToken(t1, RULES, deps)).not.toBeNull();
    expect(f.calls).toHaveLength(1);
    // kid-2 is unknown and the keys are fresh (under 5 minutes): no refetch, it fails.
    expect(await verifyIdToken(t2, RULES, deps)).toBeNull();
    expect(f.calls).toHaveLength(1);
    // 5 minutes on, a key rotation: one refetch finds it.
    now += JWKS_REFETCH_MS;
    keys = [k1.jwk, k2.jwk];
    expect(await verifyIdToken(t2, RULES, deps)).not.toBeNull();
    expect(f.calls).toHaveLength(2);
    // A kid nobody has: one refetch at most per 5 minutes.
    const t3 = await signRs256(await rsaKey('kid-3'), claims());
    expect(await verifyIdToken(t3, RULES, deps)).toBeNull();
    expect(await verifyIdToken(t3, RULES, deps)).toBeNull();
    expect(f.calls).toHaveLength(2);
    now += JWKS_REFETCH_MS;
    expect(await verifyIdToken(t3, RULES, { ...deps, now: () => now })).toBeNull();
    expect(f.calls).toHaveLength(3);
    // After an hour the keys are fetched again even for a known kid.
    now += JWKS_TTL_MS;
    expect(await verifyIdToken(await signRs256(k1, claims({ exp: now / 1000 + 600, iat: now / 1000 })), RULES, deps)).not.toBeNull();
    expect(f.calls).toHaveLength(4);
  });

  it('a JWKS that is down or malformed fails closed', async () => {
    const t = await signRs256(k1, claims());
    const down = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    expect(await verifyIdToken(t, RULES, { fetch: down, now: () => NOW })).toBeNull();
    clearJwksCache();
    const thrown = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await verifyIdToken(t, RULES, { fetch: thrown, now: () => NOW })).toBeNull();
    clearJwksCache();
    expect(await verifyIdToken(t, RULES, { fetch: jwks(() => [{ kty: 'EC', kid: 'kid-1' } as JsonWebKey]), now: () => NOW })).toBeNull();
  });

  it('decodeJwt reads the parts without trusting them', async () => {
    const d = decodeJwt(await signRs256(k1, claims()))!;
    expect(d.header).toMatchObject({ alg: 'RS256', kid: 'kid-1' });
    expect(d.payload.sub).toBe('subject-1');
    expect(decodeJwt('x'.repeat(20_000))).toBeNull();
  });
});

describe('ES256 (Apple’s client secret)', () => {
  it('signs a JWT whose raw r||s signature verifies with the public key', async () => {
    const { pem, publicKey } = await p256Pem();
    const jwt = await signEs256(pem, 'KEYID12345', { iss: 'TEAMID1234', sub: 'com.example.services' });
    const { header, payload, input, sig } = jwtParts(jwt);
    expect(header).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
    expect(payload).toEqual({ iss: 'TEAMID1234', sub: 'com.example.services' });
    expect(sig).toHaveLength(64);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(input))).toBe(true);
  });

  it('takes the PEM with literal \\n sequences and surrounding whitespace; refuses junk', async () => {
    const { pem, publicKey } = await p256Pem();
    const oneLine = `  ${pem.trim().replace(/\n/g, '\\n')}  \n`;
    expect(oneLine).not.toContain('\n-----');
    expect(pemDer(oneLine)).toEqual(pemDer(pem));
    const { input, sig } = jwtParts(await signEs256(oneLine, 'K', { a: 1 }));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(input))).toBe(true);
    expect(pemDer('not a key')).toBeNull();
    await expect(signEs256('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', 'K', {})).rejects.toThrow();
  });
});
