/**
 * Shared allowlist, query canonicalisation and cache TTL for the Pages
 * Function proxy. Kept in a `_` file so Cloudflare does not treat it as a
 * route. The handler in functions/api/[[path]].ts is the only entry.
 */

import { hasLiveGun, type GunDoc } from '../src/data/live';

export const UPSTREAM = 'https://racesense.vakaros.com/api/';
export const TELE_UPSTREAM = 'https://teleapi.regatta.app/telemetry/event/';
export const MIN = 60;
export const DAY = 86_400;
export const MAX_UPSTREAM_BYTES = 2_000_000;
/** A race in progress (the open race's page refreshes each minute): its regatta document and official results, s. */
export const LIVE_TTL = 30;
/** …and its telemetry: a window still open, or the recent tail a refresh asks for, s. */
export const LIVE_TELEMETRY_TTL = 20;
/** A telemetry window starting this recently is a live race's tail, s. */
export const LIVE_TAIL_S = 15 * 60;
export const UA = 'StartLine/1 (+https://walkeforward.com)';

export const ALLOWED: Record<string, readonly string[]> = {
  landing: [],
  regatta: ['event'],
  wind: ['v', 'lat', 'lon', 'start', 'end'],
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{4,64}$/;
const MS = /^\d{10,16}$/;

const RULES: Record<string, Record<string, (v: string) => boolean>> = {
  landing: {},
  regatta: { event: (v) => EVENT_ID.test(v) },
  wind: {
    v: (v) => /^\d{1,2}$/.test(v),
    lat: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && Math.abs(n) <= 90;
    },
    lon: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && Math.abs(n) <= 180;
    },
    start: (v) => DATE.test(v),
    end: (v) => DATE.test(v),
  },
};

const REQUIRED: Record<string, readonly string[]> = {
  landing: [],
  regatta: ['event'],
  wind: ['lat', 'lon', 'start', 'end'],
};

export function endpointPath(raw: string | string[] | undefined): string {
  return (Array.isArray(raw) ? raw.join('/') : (raw ?? '')).replace(/\/+$/, '');
}

export interface QueryOk {
  ok: true;
  qs: URLSearchParams;
}
export interface QueryErr {
  ok: false;
  status: number;
  error: string;
}

export type ProxyRoute =
  | { kind: 'racesense'; path: string }
  | { kind: 'telemetry'; eventId: string }
  | { kind: 'ys'; resource: YsResource; path: string }
  | { kind: 'error'; status: number; error: string };

/** landing / regatta / wind, /telemetry/event/:id (streamed, larger), or ys/… (Yachtscoring). */
export function parseRoute(path: string): ProxyRoute {
  if (path in ALLOWED) return { kind: 'racesense', path };
  const m = /^telemetry\/event\/([^/]+)$/.exec(path);
  if (m) {
    if (!EVENT_ID.test(m[1])) return { kind: 'error', status: 400, error: 'Bad event' };
    return { kind: 'telemetry', eventId: m[1] };
  }
  if (path.startsWith('ys/')) return parseYsRoute(path.slice(3));
  return { kind: 'error', status: 404, error: 'Unknown endpoint' };
}

// ---- Yachtscoring (official results). The API sends `Access-Control-Allow-Origin: *`, so this
// route is for the edge cache, stripping personal fields and a single origin, not for CORS.

export const YS_UPSTREAM = 'https://api.yachtscoring.com/v1/public/';
export const HOUR = 3600;

export type YsResource = 'search' | 'event' | 'splits' | 'races' | 'results' | 'cumulative' | 'boats';

/** Numeric ids only (Yachtscoring event ids are 5 digits today). */
const YS_ID = /^[1-9]\d{0,6}$/;
const YS_SUB: Record<string, YsResource> = {
  splits: 'splits',
  races: 'races',
  'result-detail-report': 'results',
  'cumulative-result': 'cumulative',
  boats: 'boats',
};

/** `event` (search), `event/:id`, `event/:id/{splits,races,result-detail-report,cumulative-result,boats}`. */
export function parseYsRoute(path: string): ProxyRoute {
  if (path === 'event') return { kind: 'ys', resource: 'search', path };
  const m = /^event\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (!m) return { kind: 'error', status: 404, error: 'Unknown endpoint' };
  if (!YS_ID.test(m[1])) return { kind: 'error', status: 400, error: 'Bad event' };
  if (m[2] === undefined) return { kind: 'ys', resource: 'event', path };
  const resource = YS_SUB[m[2]];
  return resource ? { kind: 'ys', resource, path } : { kind: 'error', status: 404, error: 'Unknown endpoint' };
}

const YS_SIZE = (max: number) => (v: string) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= max;
/** Known query params per resource, in canonical order; the upstream sees nothing else. */
const YS_RULES: Record<YsResource, Record<string, (v: string) => boolean>> = {
  search: {
    name_contains: (v) => v.trim().length > 0 && v.length <= 60 && !/[<>{}\\]/.test(v),
    startDate_gte: (v) => DATE.test(v),
    startDate_lte: (v) => DATE.test(v),
    sort: (v) => /^(startDate|endDate|name)\.(asc|desc)$/.test(v),
    size: YS_SIZE(100),
  },
  event: {},
  splits: { getAllRows: (v) => v === 'true' },
  // `live=1`: asked by the page refreshing a race in progress (src/ui/live.ts); never sent upstream, kept in the cache key (ysTtl).
  races: { size: YS_SIZE(200), live: (v) => v === '1' },
  results: { raceNumber: (v) => /^[1-9]\d{0,2}$/.test(v), live: (v) => v === '1' },
  cumulative: {},
  boats: { size: YS_SIZE(200) },
};

/** Drop unknown params, validate the rest; a search needs a name or a date window, a race report its race. */
export function buildYsQuery(resource: YsResource, search: URLSearchParams): QueryOk | QueryErr {
  const rules = YS_RULES[resource];
  const qs = new URLSearchParams();
  for (const [k, ok] of Object.entries(rules)) {
    const v = search.get(k);
    if (v == null || v === '') continue;
    if (!ok(v)) return { ok: false, status: 400, error: `Bad ${k}` };
    qs.set(k, v);
  }
  if (resource === 'search' && !qs.has('name_contains') && !(qs.has('startDate_gte') && qs.has('startDate_lte'))) {
    return { ok: false, status: 400, error: 'Missing name_contains or date window' };
  }
  if (resource === 'search' && qs.has('startDate_gte') && qs.has('startDate_lte')) {
    const span = Date.parse(qs.get('startDate_lte')!) - Date.parse(qs.get('startDate_gte')!);
    if (!(span >= 0) || span > 62 * DAY * 1000) return { ok: false, status: 400, error: 'Bad date window' };
  }
  if (resource === 'results' && !qs.has('raceNumber')) return { ok: false, status: 400, error: 'Missing raceNumber' };
  return { ok: true, qs };
}

/**
 * Keys that name or reach a person (owners, crew, skippers, contacts). Removed at any depth before
 * a response is cached or returned; Recall needs sail numbers, boat names, classes, times and places only.
 */
export const YS_PERSONAL = /owner|crew|skipper|helm|captain|email|phone|mobile|contact|firstname|lastname|fullname|person|member|yachtclub|homeport|hometown|biography|photo|avatar|user/i;

export function stripPersonal(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripPersonal);
  if (x === null || typeof x !== 'object') return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (YS_PERSONAL.test(k)) continue;
    out[k] = stripPersonal(v);
  }
  return out;
}

const YS_DATE_KEYS = /^(startDate|endDate|startTime|finishTime|updatedAt|raceUpdatedAt|resultUpdatedAt)$/;

/** The latest date-like value in a response (event end, race start, finish, last edit), ms; NaN if none. */
export function latestDate(x: unknown, depth = 0): number {
  if (depth > 8 || x === null || typeof x !== 'object') return NaN;
  let best = NaN;
  const take = (t: number): void => {
    if (Number.isFinite(t) && !(t <= best)) best = t;
  };
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (typeof v === 'string' && YS_DATE_KEYS.test(k)) take(Date.parse(v));
    else if (v && typeof v === 'object') take(latestDate(v, depth + 1));
  }
  return best;
}

/**
 * Searches: 1 h. Everything else: 7 days once the event has been quiet for 2 days (its end date,
 * last start, last finish and last edit all older than that); 5 min while it is current, LIVE_TTL for
 * a `live` ask (a race in progress being refreshed).
 */
export function ysTtl(resource: YsResource, body: unknown, now = Date.now(), live = false): number {
  if (resource === 'search') return HOUR;
  const last = latestDate(body);
  if (Number.isFinite(last) && now - last > 2 * DAY * 1000) return 7 * DAY;
  return live ? LIVE_TTL : 5 * MIN;
}

/** The query Yachtscoring sees: `live` is ours (the cache key keeps it). */
export function ysUpstreamQuery(qs: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(qs);
  out.delete('live');
  return out;
}

/** Drop unknown params, validate the rest, require the ones each endpoint needs. */
export function buildQuery(path: string, search: URLSearchParams): QueryOk | QueryErr {
  const allowed = ALLOWED[path];
  if (!allowed) return { ok: false, status: 404, error: 'Unknown endpoint' };
  const rules = RULES[path] ?? {};
  const qs = new URLSearchParams();
  for (const k of allowed) {
    const v = search.get(k);
    if (v == null || v === '') continue;
    if (v.length > 80) return { ok: false, status: 400, error: `Bad ${k}` };
    if (rules[k] && !rules[k](v)) return { ok: false, status: 400, error: `Bad ${k}` };
    qs.set(k, v);
  }
  for (const k of REQUIRED[path] ?? []) {
    if (!qs.has(k)) return { ok: false, status: 400, error: `Missing ${k}` };
  }
  return { ok: true, qs };
}

/**
 * teleapi's division tag (src/data/racesense/api.ts feedDivision): spaces come as '_' and dots as '//'
 * ("Female_7//5"), so '/' is allowed only as that pair. A 64-character name with a few dots stays under the cap.
 */
const DIVISION = /^[A-Za-z0-9](?:[A-Za-z0-9 ._+-]|\/\/)*$/;
const DIVISION_MAX = 80;

export function buildTelemetryQuery(search: URLSearchParams): QueryOk | QueryErr {
  const after = search.get('after') ?? '';
  const before = search.get('before') ?? '';
  if (!MS.test(after)) return { ok: false, status: 400, error: 'Bad after' };
  if (!MS.test(before)) return { ok: false, status: 400, error: 'Bad before' };
  const a = Number(after);
  const b = Number(before);
  if (!(b > a) || b - a > 6 * 3_600_000) return { ok: false, status: 400, error: 'Bad window' };
  const qs = new URLSearchParams();
  qs.set('after', after);
  qs.set('before', before);
  const limit = search.get('limit');
  if (limit != null && limit !== '') {
    if (!/^\d{1,6}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100_000) {
      return { ok: false, status: 400, error: 'Bad limit' };
    }
    qs.set('limit', limit);
  }
  const division = search.get('division');
  if (division != null && division !== '') {
    if (division.length > DIVISION_MAX || !DIVISION.test(division)) return { ok: false, status: 400, error: 'Bad division' };
    qs.set('division', division);
  }
  return { ok: true, qs };
}

export function ttlFor(path: string, qs: URLSearchParams, body: string): number {
  if (path === 'landing') return 10 * MIN;
  if (path === 'wind') {
    const end = Date.parse(qs.get('end') ?? '');
    return Number.isFinite(end) && Date.now() - end > 2 * DAY * 1000 ? 30 * DAY : 6 * 3600;
  }
  try {
    const doc = (JSON.parse(body) as { revisions?: { doc?: GunDoc & { endDate?: number } }[] }).revisions?.at(-1)?.doc;
    if (doc?.endDate && Date.now() - doc.endDate > DAY * 1000) return 7 * DAY;
    // A race in progress, or in its start sequence (data/live.ts gunLive): its gun, finishes and end come in on this document.
    if (hasLiveGun(doc, Date.now())) return LIVE_TTL;
  } catch {
    /* not JSON: short */
  }
  return 2 * MIN;
}

/** Past race windows can sit in the edge cache; a live window (still open, or a live race's recent tail) stays shortest. */
export function telemetryTtl(qs: URLSearchParams, now = Date.now()): number {
  const before = Number(qs.get('before') ?? '');
  const after = Number(qs.get('after') ?? '');
  if (Number.isFinite(before) && now - before > DAY * 1000) return 7 * DAY;
  if (before > now || after > now - LIVE_TAIL_S * 1000) return LIVE_TELEMETRY_TTL;
  return MIN;
}

export function looksLikeJson(body: string): boolean {
  const s = body.trimStart();
  return s.startsWith('{') || s.startsWith('[');
}

export const jsonError = (status: number, msg: string): Response =>
  new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
