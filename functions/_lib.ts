/**
 * Shared allowlist, query canonicalisation and cache TTL for the Pages
 * Function proxy. Kept in a `_` file so Cloudflare does not treat it as a
 * route. The handler in functions/api/[[path]].ts is the only entry.
 */

export const UPSTREAM = 'https://racesense.vakaros.com/api/';
export const TELE_UPSTREAM = 'https://teleapi.regatta.app/telemetry/event/';
export const MIN = 60;
export const DAY = 86_400;
export const MAX_UPSTREAM_BYTES = 2_000_000;
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
  | { kind: 'error'; status: number; error: string };

/** landing / regatta / wind, or /telemetry/event/:id (streamed, larger). */
export function parseRoute(path: string): ProxyRoute {
  if (path in ALLOWED) return { kind: 'racesense', path };
  const m = /^telemetry\/event\/([^/]+)$/.exec(path);
  if (m) {
    if (!EVENT_ID.test(m[1])) return { kind: 'error', status: 400, error: 'Bad event' };
    return { kind: 'telemetry', eventId: m[1] };
  }
  return { kind: 'error', status: 404, error: 'Unknown endpoint' };
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
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/.test(division)) return { ok: false, status: 400, error: 'Bad division' };
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
    const doc = (JSON.parse(body) as { revisions?: { doc?: { endDate?: number } }[] }).revisions?.at(-1)?.doc;
    if (doc?.endDate && Date.now() - doc.endDate > DAY * 1000) return 7 * DAY;
  } catch {
    /* not JSON: short */
  }
  return 2 * MIN;
}

/** Past race windows can sit in the edge cache; a live window stays short. */
export function telemetryTtl(qs: URLSearchParams): number {
  const before = Number(qs.get('before') ?? '');
  return Number.isFinite(before) && Date.now() - before > DAY * 1000 ? 7 * DAY : MIN;
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
