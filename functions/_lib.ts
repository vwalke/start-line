/**
 * Shared allowlist, query canonicalisation and cache TTL for the Pages
 * Function proxy. Kept in a `_` file so Cloudflare does not treat it as a
 * route. The handler in functions/api/[[path]].ts is the only entry.
 */

export const UPSTREAM = 'https://racesense.vakaros.com/api/';
export const MIN = 60;
export const DAY = 86_400;
export const MAX_UPSTREAM_BYTES = 2_000_000;

export const ALLOWED: Record<string, readonly string[]> = {
  landing: [],
  regatta: ['event'],
  wind: ['v', 'lat', 'lon', 'start', 'end'],
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const RULES: Record<string, Record<string, (v: string) => boolean>> = {
  landing: {},
  regatta: { event: (v) => /^[A-Za-z0-9_-]{4,64}$/.test(v) },
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
