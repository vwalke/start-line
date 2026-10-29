/**
 * POST /api/track: the page's usage events (src/ui/track.ts), one Workers Analytics Engine data point each in
 * the RECALL_EVENTS binding (dataset recall_events). The schema is in functions/_trackSchema.ts.
 *
 * Without the binding it answers 204 and stores nothing, so it is safe to ship before the dataset exists.
 * Every batch is checked whole (any bad part refuses it all): at most BODY_MAX bytes and BATCH_MAX events,
 * only known keys and event names, and every string matched to its pattern. Nothing that identifies a person
 * is read or written: no IP (only Cloudflare's coarse country), no cookie, no user agent.
 * writeDataPoint is fire-and-forget (the runtime sends it after the answer); a failure is ignored.
 */
import { trustedOrigin } from './_auth';
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
}

export interface TrackCtx {
  request: Request;
  env: TrackEnv;
}

export interface TrackPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
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
    out.push({ indexes: [sid], blobs: [x.n, pathOf(x.p), e, r, auth, dev, f, th, d, country], doubles: [s, t] });
  }
  return out;
}

/** Cloudflare's two-letter country for the request ('' elsewhere, or for Tor's T1 / unknown XX). */
function countryOf(req: Request): string {
  const c = (req as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : '';
}

export async function handleTrack(ctx: TrackCtx): Promise<Response> {
  const { request: req, env } = ctx;
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  const ds = env.RECALL_EVENTS;
  if (!ds) return noContent();
  // A browser's beacon carries this site's Origin; another site's page is refused (no Origin: a beacon from an older browser).
  const origin = req.headers.get('origin');
  if (origin && origin !== 'null' && !trustedOrigin(origin, new URL(req.url).origin)) return refuse(403);
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
