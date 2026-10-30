/**
 * POST /api/track: the page's usage events (src/ui/track.ts), one Workers Analytics Engine data point each in
 * the RECALL_EVENTS binding (dataset recall_events). The schema is in functions/_trackSchema.ts.
 *
 * Without the binding it answers 204 and stores nothing (and touches no database), so it is safe to ship
 * before the dataset exists. The page posts JSON with fetch (keepalive, no credentials); the Origin header is
 * required and must be one of TRACK_ORIGINS' (trackOriginOk). Each batch then counts once against its IP's
 * hourly counter in auth_rate_limits (`track-ip:<salted sha256>`, as feedback and race emails do; one upsert),
 * 429 past TRACK_IP_LIMIT; with no AUTH_DB, or when D1 errs, it lets the batch through (analytics never
 * breaks the page). The IP is used for that counter only, never written to a data point.
 * Every batch is checked whole (any bad part refuses it all): at most BODY_MAX bytes and BATCH_MAX events,
 * only known keys and event names, and every string matched to its pattern. Nothing that identifies a person
 * is stored: no IP (only Cloudflare's coarse country), no cookie, no user agent.
 * writeDataPoint is fire-and-forget (the runtime sends it after the answer); a failure is ignored.
 */
import { countRateHit, pruneRateLimits, type D1Like } from './_authDb';
import { ipHash } from './_feedback';
import { readCapped } from './_vkx';
import {
  AUTH,
  BATCH_MAX,
  BODY_MAX,
  DETAIL_RE,
  DEVICES,
  EVENT_ID_RE,
  HOST_RE,
  PATH_RE,
  RACE_ID_RE,
  SESSION_MAX,
  SESSION_MS_MAX,
  SID_RE,
  THEMES,
  TRACK_EVENTS,
  TRACK_PATHS,
} from './_trackSchema';

/** The part of Analytics Engine's binding used here. */
export interface AnalyticsDatasetLike {
  writeDataPoint(p: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface TrackEnv {
  RECALL_EVENTS?: AnalyticsDatasetLike;
  /** The rate limit's counters (auth_rate_limits); without it there is no limit. */
  AUTH_DB?: D1Like;
  /** Salts the IP's hash in the counter's key. */
  AUTH_SECRET?: string;
}

export interface TrackCtx {
  request: Request;
  env: TrackEnv;
  waitUntil?(p: Promise<unknown>): void;
}

export interface TrackDeps {
  /** Batches per IP per hour; null: no limit. */
  ipLimit?: number | null;
  now?: () => number;
  random?: () => number;
}

export interface TrackPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/**
 * Batches per IP per hour. A busy session sends a batch every few seconds at most (300 events, often one
 * or two a batch), and a club's or a marina's Wi-Fi puts a whole fleet behind one IP: room for many.
 */
export const TRACK_IP_LIMIT = 2_000;
const PRUNE_CHANCE = 0.01;

/** The production site, and the Pages project's own address (previews are one label under it). */
export const SITE_ORIGIN = 'https://recall.walkeforward.com';
const PAGES_HOST = 'start-line.pages.dev';
const PREVIEW_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.start-line\.pages\.dev$/;
const DEV_RE = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/;
const isLocalHost = (host: string): boolean => /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(host);

/**
 * The page that sent the batch is Recall's: the production origin exactly, the Pages project's own or a
 * preview's (`https://<branch or hash>.start-line.pages.dev`), or, only when this request itself was made to
 * localhost (wrangler pages dev), `http://localhost:<port>` / `http://127.0.0.1:<port>`. Whole-string matches:
 * no missing or "null" Origin, no suffix or prefix lookalikes.
 */
export function trackOriginOk(origin: string | null, requestUrl: string): boolean {
  if (!origin || origin === 'null') return false;
  if (origin === SITE_ORIGIN || origin === `https://${PAGES_HOST}` || PREVIEW_RE.test(origin)) return true;
  if (!DEV_RE.test(origin)) return false;
  try {
    return isLocalHost(new URL(requestUrl).host);
  } catch {
    return false;
  }
}

/** Count this batch against its IP's hour; true when over. Fails open: no database, or an error, is never over. */
async function overLimit(ctx: TrackCtx, deps: TrackDeps): Promise<boolean> {
  const limit = deps.ipLimit === undefined ? TRACK_IP_LIMIT : deps.ipLimit;
  const db = ctx.env.AUTH_DB;
  if (limit == null || !db) return false;
  try {
    const now = (deps.now ?? Date.now)();
    const ip = await ipHash(ctx.request.headers.get('cf-connecting-ip') ?? 'local', ctx.env.AUTH_SECRET);
    const n = await countRateHit(db, `track-ip:${ip}`, now);
    if ((deps.random ?? Math.random)() < PRUNE_CHANCE) {
      const prune = pruneRateLimits(db, now).catch(() => undefined);
      if (ctx.waitUntil) ctx.waitUntil(prune);
      else await prune;
    }
    // countRateHit answers Infinity when D1 sends no count back: an error here, so let it through.
    return Number.isFinite(n) && n > limit;
  } catch {
    return false;
  }
}

const BATCH_KEYS = new Set(['sid', 'dev', 'th', 'auth', 'ev']);
const EVENT_KEYS = new Set(['n', 'p', 'e', 'r', 'd', 'f', 's', 't']);

const noContent = (): Response => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
const refuse = (status: number): Response => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (o: Record<string, unknown>, keys: Set<string>): boolean => Object.keys(o).every((k) => keys.has(k));
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
/** An optional string: absent ('' stored), or one matching `re`. Null: present but bad. */
const opt = (v: unknown, re: RegExp): string | null => (v === undefined ? '' : typeof v === 'string' && re.test(v) ? v : null);
const int = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);

/** A known path, or 'other' (never the raw string: the page only ever sends its own). */
const pathOf = (p: string): string => ((TRACK_PATHS as readonly string[]).includes(p) ? p : 'other');

/** The data points for a batch, or null if any part of it is wrong. */
export function trackPoints(body: unknown, country = ''): TrackPoint[] | null {
  if (!isObj(body) || !onlyKeys(body, BATCH_KEYS)) return null;
  const { sid, dev, th, auth, ev } = body;
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
  if (!oneOf(DEVICES, dev) || !oneOf(THEMES, th) || !oneOf(AUTH, auth)) return null;
  if (!Array.isArray(ev) || ev.length < 1 || ev.length > BATCH_MAX) return null;
  const out: TrackPoint[] = [];
  for (const x of ev) {
    if (!isObj(x) || !onlyKeys(x, EVENT_KEYS)) return null;
    if (!oneOf(TRACK_EVENTS, x.n)) return null;
    if (typeof x.p !== 'string' || !PATH_RE.test(x.p)) return null;
    const e = opt(x.e, EVENT_ID_RE);
    const r = opt(x.r, RACE_ID_RE);
    const d = opt(x.d, DETAIL_RE);
    const f = opt(x.f, HOST_RE);
    const s = int(x.s, 1, SESSION_MAX);
    const t = int(x.t, 0, SESSION_MS_MAX);
    if (e == null || r == null || d == null || f == null || s == null || t == null) return null;
    // The referrer belongs to the session's first event only.
    if (f && s !== 1) return null;
    // index1 is the event name: Analytics Engine samples by index, so it stays low-cardinality (the session is blob11).
    out.push({ indexes: [x.n], blobs: [x.n, pathOf(x.p), e, r, auth, dev, f, th, d, country, sid], doubles: [s, t] });
  }
  return out;
}

/** Cloudflare's two-letter country for the request ('' elsewhere, or for Tor's T1 / unknown XX). */
function countryOf(req: Request): string {
  const c = (req as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : '';
}

export async function handleTrack(ctx: TrackCtx, deps: TrackDeps = {}): Promise<Response> {
  const { request: req, env } = ctx;
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  const ds = env.RECALL_EVENTS;
  if (!ds) return noContent();
  // The page's fetch always carries its Origin; anything else (another site, no Origin, "null") is refused.
  if (!trackOriginOk(req.headers.get('origin'), req.url)) return refuse(403);
  // JSON only: a form on another page can't send it without asking first (CORS), and this route never says yes.
  if (!/^application\/json\s*(?:;|$)/i.test(req.headers.get('content-type') ?? '')) return refuse(415);
  if (await overLimit(ctx, deps)) return refuse(429);
  const raw = await readCapped(req, BODY_MAX);
  if (!raw) return refuse(413);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return refuse(400);
  }
  const points = trackPoints(body, countryOf(req));
  if (!points) return refuse(400);
  for (const p of points) {
    try {
      ds.writeDataPoint(p);
    } catch {
      // Analytics only: never fail the page over it.
    }
  }
  return noContent();
}
