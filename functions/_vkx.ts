/**
 * Boat-log (.vkx) uploads: the handlers behind functions/api/vkx/*.ts, kept
 * in a `_` file (not a route) so tests and the dev mock call them directly.
 *
 * Uploads are PUBLIC: anyone viewing the race sees the boat's track.
 *
 * Storage: an R2 bucket bound as VKX_BUCKET. One object per race and boat,
 *   v1/<eventId>/<base64url(division)>/<raceId>/<deviceSn>.bin
 * holding the gzipped compact payload (src/data/vkx/compact.ts), with its
 * facts in customMetadata (no separate .json). Newest upload wins; the one
 * it replaced is kept as <deviceSn>.prev.bin (one level).
 *
 * Every upload is decoded and sanity-checked here, then checked against the
 * boat's public feed track (teleapi, the same upstream as the /api proxy):
 * a few short windows (src/data/vkx/match.ts checkWindows), and the
 * device's fixes must agree with the log (median < 5 m). If the feed can't
 * be reached the upload is refused (503): nothing unverified is stored.
 *
 * A delete token (random, returned once) removes an upload; only its
 * SHA-256 is stored. Deleting the current upload brings back the previous
 * one, if any; the token of an upload since replaced deletes that `.prev`.
 *
 * Privacy: nothing identifying is stored or logged. The optional upload
 * rate limit keys an in-memory map (per isolate) by a salted hash of the
 * client IP; it never leaves the isolate's memory.
 */
import { MAX_UPSTREAM_BYTES, TELE_UPSTREAM, UA } from './_lib';
import { PayloadError, decodePayloadRaw, gunzip, readHeader, sha256Hex, type PayloadHeader, type PayloadTrack } from '../src/data/vkx/compact';
import { CHECK_WINDOWS, MATCH_MIN_POINTS, checkDevice, checkWindows, feedFixes, sameSail, type FeedCheck, type FeedFix } from '../src/data/vkx/match';
import { DIV_NAME_RE, EVENT_ID_RE, RACE_ID_RE, divKey, payloadProblems } from '../src/data/vkx/validate';
import type { TelemetryPage } from '../src/data/racesense/types';

// ---- the R2 surface we use (structurally what Workers' R2Bucket provides)

export interface R2ObjectLike {
  key: string;
  size: number;
  uploaded: Date;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface R2PutOptionsLike {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: R2PutOptionsLike): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number; include?: ('customMetadata' | 'httpMetadata')[] }): Promise<{
    objects: R2ObjectLike[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface VkxEnv {
  VKX_BUCKET?: R2BucketLike;
}

export interface VkxDeps {
  /** Upstream fetch (teleapi); tests mock it. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Edge cache (caches.default in production); null to skip. */
  cache?: Cache | null;
  /** Per-isolate upload limiter; null to skip. */
  limiter?: RateLimiter | null;
}

export interface Ctx {
  request: Request;
  env: VkxEnv;
  waitUntil?(p: Promise<unknown>): void;
}

// ---- limits

/** Largest gzipped payload per race and boat, bytes (a 10 Hz race is ~0.3 MB). */
export const MAX_UPLOAD_BYTES = 2_000_000;
export const PAYLOAD_TYPE = 'application/octet-stream';
/** The list's cache, s (purged on upload / delete where the edge cache allows). */
export const LIST_TTL_S = 60;
/** Uploads per client per window (per isolate). */
export const RATE_MAX = 20;
export const RATE_WINDOW_MS = 10 * 60_000;
const SN_RE = /^\d{1,10}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ---- responses

const SECURITY = { 'x-content-type-options': 'nosniff' };

export const json = (status: number, body: unknown, cache = 'no-store'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...SECURITY } });

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response => json(status, { ok: false, error, ...extra });

export const UNAVAILABLE = 'Boat-log uploads are not set up on this site (no storage bound)';
const noBucket = (): Response => fail(503, UNAVAILABLE, { code: 'no-storage' });

// ---- keys

export interface UploadId {
  event: string;
  div: string;
  race: string;
  sn: number;
}

export const objectKey = (id: UploadId, prev = false): string => `v1/${id.event}/${divKey(id.div)}/${id.race}/${id.sn}${prev ? '.prev' : ''}.bin`;
export const prefixOf = (event: string, div: string, race?: string): string => `v1/${event}/${divKey(div)}/${race ? `${race}/` : ''}`;

/** Ids from a query string, strictly checked; a string is the error. */
export function idFromQuery(q: URLSearchParams, needSn: boolean): (Omit<UploadId, 'race' | 'sn'> & { race?: string; sn?: number }) | string {
  const event = q.get('event') ?? '';
  const div = q.get('div') ?? '';
  const race = q.get('race');
  const sn = q.get('sn');
  if (!EVENT_ID_RE.test(event)) return 'Bad event';
  if (!DIV_NAME_RE.test(div)) return 'Bad div';
  if (race != null && !RACE_ID_RE.test(race)) return 'Bad race';
  if (needSn && (race == null || sn == null || !SN_RE.test(sn))) return race == null ? 'Missing race' : 'Bad sn';
  return { event, div, ...(race != null ? { race } : {}), ...(needSn ? { sn: Number(sn) } : {}) };
}

const listUrl = (origin: string, event: string, div: string, race?: string): string => {
  const p = new URLSearchParams({ event, div });
  if (race) p.set('race', race);
  return `${origin}/api/vkx/list?${p}`;
};
export const dataUrl = (id: UploadId, sha: string): string =>
  `/api/vkx/data?${new URLSearchParams({ event: id.event, div: id.div, race: id.race, sn: String(id.sn), h: sha })}`;

// ---- tokens

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const tokenHash = (token: string): Promise<string> => sha256Hex(new TextEncoder().encode(`recall-vkx:${token}`));

function sameHex(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---- rate limit (per isolate, in memory)

export class RateLimiter {
  private hits = new Map<string, number[]>();
  /** Salt is created on first remaining()/allow(): Workers forbid getRandomValues at module load. */
  private salt: string | undefined;
  constructor(
    readonly max = RATE_MAX,
    readonly windowMs = RATE_WINDOW_MS,
  ) {}
  private async keyOf(ip: string): Promise<string> {
    const salt = (this.salt ??= randomToken());
    return (await sha256Hex(new TextEncoder().encode(`${salt}|${ip}`))).slice(0, 24);
  }
  /** How many more the client may make now (nothing is counted). */
  async remaining(ip: string, now: number): Promise<number> {
    const key = await this.keyOf(ip);
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (this.hits.has(key)) this.hits.set(key, list);
    return Math.max(0, this.max - list.length);
  }
  /** True when the client may upload now (and counts it). The IP is hashed with a per-isolate salt and only kept here. */
  async allow(ip: string, now: number): Promise<boolean> {
    const key = await this.keyOf(ip);
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (this.hits.size > 10_000) {
      // Bound memory without wiping the limiter (a rotating-IP flood used to clear everyone).
      const keys = this.hits.keys();
      for (let n = 0; n < 2_000; n++) {
        const k = keys.next();
        if (k.done) break;
        this.hits.delete(k.value);
      }
    }
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

/** The production limiter: one per isolate, created on the first upload (not at import). */
let limiter: RateLimiter | undefined;

const isolateLimiter = (): RateLimiter => (limiter ??= new RateLimiter());

// ---- feed check

export type FeedCheckResult =
  | FeedCheck
  | { ok: false; reason: 'upstream'; n: number; medianM: null }
  /** The device's feed fixes carry another sail number than the payload claims. */
  | { ok: false; reason: 'sail'; n: number; medianM: number | null; feedSail: string };

/**
 * Check the log against device `sn`'s public feed in the shared windows,
 * stopping once MATCH_MIN_POINTS fixes agree (or clearly don't). At most
 * CHECK_WINDOWS small GETs.
 */
export async function verifyAgainstFeed(track: PayloadTrack, doFetch: typeof fetch): Promise<FeedCheckResult> {
  const h = track.header;
  const fixes: FeedFix[] = [];
  let last: FeedCheck = { ok: false, reason: 'too-few', n: 0, medianM: null };
  for (const w of checkWindows(h.t0, h.t1).slice(0, CHECK_WINDOWS)) {
    const qs = new URLSearchParams({ after: String(w.after), before: String(w.before), limit: '100000', division: h.div });
    let page: TelemetryPage;
    try {
      const res = await doFetch(`${TELE_UPSTREAM}${h.event}?${qs}`, { headers: { accept: 'application/json', 'user-agent': UA } });
      if (!res.ok) return { ok: false, reason: 'upstream', n: 0, medianM: null };
      const text = await res.text();
      if (text.length > MAX_UPSTREAM_BYTES * 2) return { ok: false, reason: 'upstream', n: 0, medianM: null };
      page = JSON.parse(text) as TelemetryPage;
    } catch {
      return { ok: false, reason: 'upstream', n: 0, medianM: null };
    }
    for (const f of feedFixes([page])) if (f.sn === h.sn) fixes.push(f);
    last = checkDevice(track, fixes, h.sn);
    if (last.n >= MATCH_MIN_POINTS) break;
  }
  // The track is filed (and merged) under the sail: it must be the one this device sails under in the feed.
  const sails = new Set(fixes.map((f) => f.sail).filter(Boolean));
  if (sails.size && ![...sails].some((s) => sameSail(s, h.sail))) {
    return { ok: false, reason: 'sail', n: last.n, medianM: last.medianM, feedSail: [...sails][0] };
  }
  return last;
}

// ---- handlers

/** The request body, or null once it passes `max` bytes (announced or read). */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const announced = Number(req.headers.get('content-length') ?? 0);
  if (announced > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const meta = (h: PayloadHeader, sha: string, tokenHashHex: string, size: number, uploadedAt: number, check: { n: number; medianM: number }): Record<string, string> => ({
  sha,
  tokenHash: tokenHashHex,
  sail: h.sail,
  name: h.name ?? '',
  rateHz: String(h.rateHz),
  n: String(h.n),
  t0: String(h.t0),
  t1: String(h.t1),
  gunMs: String(h.gunMs),
  size: String(size),
  uploadedAt: String(uploadedAt),
  srcSha256: h.srcSha256,
  checkN: String(check.n),
  checkMedianM: check.medianM.toFixed(2),
});

/** Drop this data centre's cached lists for the race (awaited, so the uploader's next read is current here). */
async function purgeLists(ctx: Ctx, deps: VkxDeps, id: UploadId): Promise<void> {
  const cache = deps.cache;
  if (!cache) return;
  const origin = new URL(ctx.request.url).origin;
  await Promise.all([listUrl(origin, id.event, id.div), listUrl(origin, id.event, id.div, id.race)].map((u) => cache.delete(new Request(u)).catch(() => false)));
}

/** POST /api/vkx/upload: body = one gzipped payload (≤ MAX_UPLOAD_BYTES); optional header x-replace-token. */
export async function handleUpload(ctx: Ctx, deps: VkxDeps = {}): Promise<Response> {
  const bucket = ctx.env.VKX_BUCKET;
  if (!bucket) return noBucket();
  const req = ctx.request;
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== PAYLOAD_TYPE) return fail(415, `Send the payload as ${PAYLOAD_TYPE}`);
  const now = (deps.now ?? Date.now)();
  const lim = deps.limiter === undefined ? isolateLimiter() : deps.limiter;
  if (lim && !(await lim.allow(req.headers.get('cf-connecting-ip') ?? 'local', now))) {
    return fail(429, 'Too many uploads from here; try again in a few minutes');
  }
  const gz = await readCapped(req, MAX_UPLOAD_BYTES);
  if (!gz) return fail(413, `Payload over ${MAX_UPLOAD_BYTES / 1e6} MB`);

  let track: PayloadTrack;
  try {
    const raw = await gunzip(gz);
    const { header } = readHeader(raw);
    // Ids first: a bad id is a bad request, whatever the samples say.
    if (!EVENT_ID_RE.test(String(header.event)) || !RACE_ID_RE.test(String(header.race)) || typeof header.div !== 'string' || !DIV_NAME_RE.test(header.div)) {
      return fail(400, 'Bad event, division or race id');
    }
    if (!Number.isInteger(header.sn) || header.sn < 1 || header.sn > 0xffffffff) return fail(400, 'Bad device serial');
    track = decodePayloadRaw(raw);
  } catch (e) {
    if (e instanceof PayloadError) return fail(422, `Unreadable payload: ${e.message}`);
    throw e;
  }
  const problems = payloadProblems(track, now);
  if (problems.length) return fail(422, `Rejected: ${problems.join('; ')}`, { problems });
  const h = track.header;

  const check = await verifyAgainstFeed(track, deps.fetch ?? fetch);
  if (!check.ok) {
    if (check.reason === 'upstream') return fail(503, "Couldn't reach the public RaceSense feed to check this log against the boat's track; nothing was stored. Try again in a few minutes.", { code: 'upstream' });
    if (check.reason === 'sail') {
      return fail(422, `Device ${h.sn} sails as ${check.feedSail} in the public feed, not ${h.sail}`, { code: 'sail' });
    }
    if (check.reason === 'too-few') {
      return fail(422, `The public feed has too few fixes of this boat (${check.n}) in the checked windows to confirm the log is its track`, { code: 'too-few', n: check.n });
    }
    return fail(422, `This log doesn't follow ${h.sail}'s public track (median ${Math.round(check.medianM ?? 0)} m off over ${check.n} fixes)`, {
      code: 'mismatch',
      n: check.n,
      medianM: check.medianM,
    });
  }

  const id: UploadId = { event: h.event, div: h.div, race: h.race, sn: h.sn };
  const key = objectKey(id);
  const sha = await sha256Hex(gz);
  const token = randomToken();
  const replaceToken = req.headers.get('x-replace-token') ?? '';
  const current = await bucket.head(key);
  let prevKept = false;
  if (current) {
    // Re-uploading over your own upload (you hold its token) replaces it; anyone else's becomes `.prev`.
    const own = TOKEN_RE.test(replaceToken) && sameHex(current.customMetadata?.tokenHash, await tokenHash(replaceToken));
    if (!own) {
      const body = await bucket.get(key);
      if (body) {
        await bucket.put(objectKey(id, true), await body.arrayBuffer(), { httpMetadata: { contentType: PAYLOAD_TYPE }, customMetadata: body.customMetadata ?? {} });
        prevKept = true;
      }
    }
  }
  await bucket.put(key, gz, {
    httpMetadata: { contentType: PAYLOAD_TYPE },
    customMetadata: meta(h, sha, await tokenHash(token), gz.length, now, check),
  });
  await purgeLists(ctx, deps, id);
  return json(200, {
    ok: true,
    key,
    race: h.race,
    sn: h.sn,
    sail: h.sail,
    sha,
    size: gz.length,
    uploadedAt: now,
    token,
    prevKept,
    check: { n: check.n, medianM: Math.round(check.medianM * 100) / 100 },
    url: dataUrl(id, sha),
  });
}

export interface ListItem {
  race: string;
  sn: number;
  sail: string;
  name: string;
  rateHz: number;
  n: number;
  t0: number;
  t1: number;
  gunMs: number;
  uploadedAt: number;
  size: number;
  sha: string;
  url: string;
}

/** GET /api/vkx/list?event&div[&race]: the current uploads (not the `.prev` ones). */
export async function handleList(ctx: Ctx, deps: VkxDeps = {}): Promise<Response> {
  const bucket = ctx.env.VKX_BUCKET;
  if (!bucket) return noBucket();
  const url = new URL(ctx.request.url);
  const q = idFromQuery(url.searchParams, false);
  if (typeof q === 'string') return fail(400, q);
  const cacheKey = new Request(listUrl(url.origin, q.event, q.div, q.race));
  const cache = deps.cache;
  // `fresh=1`: the uploader's own re-read right after an upload or removal skips the cached copy (and refreshes it).
  if (cache && url.searchParams.get('fresh') !== '1') {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return hit;
  }
  const items: ListItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    let res: Awaited<ReturnType<R2BucketLike['list']>>;
    try {
      res = await bucket.list({ prefix: prefixOf(q.event, q.div, q.race), cursor, limit: 1000, include: ['customMetadata'] });
    } catch {
      return fail(503, 'Upload storage is unavailable right now', { code: 'storage' });
    }
    for (const o of res.objects) {
      const m = /\/([A-Za-z0-9_-]{1,32})\/(\d{1,10})\.bin$/.exec(o.key);
      const c = o.customMetadata ?? {};
      if (!m || !SHA_RE.test(c.sha ?? '')) continue;
      const id: UploadId = { event: q.event, div: q.div, race: m[1], sn: Number(m[2]) };
      items.push({
        race: m[1],
        sn: id.sn,
        sail: c.sail ?? '',
        name: c.name ?? '',
        rateHz: Number(c.rateHz),
        n: Number(c.n),
        t0: Number(c.t0),
        t1: Number(c.t1),
        gunMs: Number(c.gunMs),
        uploadedAt: Number(c.uploadedAt),
        size: Number(c.size ?? o.size),
        sha: c.sha,
        url: dataUrl(id, c.sha),
      });
    }
    if (!res.truncated || !res.cursor) break;
    cursor = res.cursor;
  }
  const fresh = url.searchParams.get('fresh') === '1';
  const out = json(200, { ok: true, uploads: items }, fresh ? 'no-store' : `public, max-age=${LIST_TTL_S}`);
  if (cache) {
    // Stored with the normal 60 s header, whichever request filled it.
    const p = cache.put(cacheKey, json(200, { ok: true, uploads: items }, `public, max-age=${LIST_TTL_S}`)).catch(() => undefined);
    if (ctx.waitUntil) ctx.waitUntil(p);
  }
  return out;
}

/** GET /api/vkx/data?event&div&race&sn&h: the payload, content-addressed by `h` (its SHA-256), so cached for good. */
export async function handleData(ctx: Ctx, _deps: VkxDeps = {}): Promise<Response> {
  const bucket = ctx.env.VKX_BUCKET;
  if (!bucket) return noBucket();
  const url = new URL(ctx.request.url);
  const q = idFromQuery(url.searchParams, true);
  if (typeof q === 'string') return fail(400, q);
  const h = url.searchParams.get('h') ?? '';
  if (!SHA_RE.test(h)) return fail(400, 'Bad h');
  const id = q as UploadId;
  // Not kept in the edge cache: a removed upload must stop being served (browsers still cache it, immutable).
  let obj: R2ObjectBodyLike | null;
  try {
    obj = await bucket.get(objectKey(id));
  } catch {
    return fail(503, 'Upload storage is unavailable right now', { code: 'storage' });
  }
  if (!obj || obj.customMetadata?.sha !== h) return fail(404, 'No such upload (it may have been replaced or removed)');
  const out = new Response(await obj.arrayBuffer(), {
    headers: {
      'content-type': PAYLOAD_TYPE,
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${h}"`,
      ...SECURITY,
    },
  });
  return out;
}

/**
 * POST (or DELETE) /api/vkx/delete with JSON {event, div, race, sn, token}.
 * The current upload's token removes it and brings back the previous one;
 * the token of an upload since replaced removes that `.prev` copy.
 */
export async function handleDelete(ctx: Ctx, deps: VkxDeps = {}): Promise<Response> {
  const bucket = ctx.env.VKX_BUCKET;
  if (!bucket) return noBucket();
  const raw = await readCapped(ctx.request, 4_000);
  if (!raw) return fail(413, 'Too large');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return fail(400, 'Send JSON');
  }
  const q = idFromQuery(new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v ?? '')])), true);
  if (typeof q === 'string') return fail(400, q);
  const token = String(body.token ?? '');
  if (!TOKEN_RE.test(token)) return fail(400, 'Bad token');
  const id = q as UploadId;
  const hash = await tokenHash(token);
  const key = objectKey(id);
  const prevKey = objectKey(id, true);
  const [cur, prev] = await Promise.all([bucket.head(key), bucket.head(prevKey)]);
  if (cur && sameHex(cur.customMetadata?.tokenHash, hash)) {
    const old = prev ? await bucket.get(prevKey) : null;
    if (old) {
      await bucket.put(key, await old.arrayBuffer(), { httpMetadata: { contentType: PAYLOAD_TYPE }, customMetadata: old.customMetadata ?? {} });
      await bucket.delete(prevKey);
    } else {
      await bucket.delete(key);
    }
    await purgeLists(ctx, deps, id);
    return json(200, { ok: true, removed: 'current', restored: !!old });
  }
  if (prev && sameHex(prev.customMetadata?.tokenHash, hash)) {
    await bucket.delete(prevKey);
    return json(200, { ok: true, removed: 'previous', restored: false });
  }
  if (!cur && !prev) return fail(404, 'No such upload');
  return fail(403, "That token doesn't match this upload");
}

/** Methods a route doesn't serve. */
export const methodNotAllowed = (allow: string): Response =>
  new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
    status: 405,
    headers: { allow, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY },
  });

/** caches.default when running on Cloudflare; null elsewhere. */
export function edgeCache(): Cache | null {
  try {
    return (globalThis.caches as CacheStorage & { default?: Cache }).default ?? null;
  } catch {
    return null;
  }
}
