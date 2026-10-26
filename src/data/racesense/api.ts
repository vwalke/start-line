/**
 * Network access to the public RaceSense endpoints. Everything goes through
 * our /api proxy (a Cloudflare Pages Function in production; Vite in dev)
 * so the browser Web Worker never has to CORS-fetch a third party.
 */
import { DAY, HOUR, MINUTE, cachedJson, cachedJsonFrom, type CacheOpts } from '../cache';
import type { LandingResponse, RegattaResponse, TelemetryPage, WindResponse } from './types';

export const PROXY_BASE = '/api';
/** teleapi's maximum page size. */
const PAGE = 100_000;
/** Never walk more than this many pages for one race. */
const MAX_PAGES = 8;

export function fetchLanding(signal?: AbortSignal): Promise<LandingResponse> {
  return cachedJson<LandingResponse>(`${PROXY_BASE}/landing`, 10 * MINUTE, signal);
}

function loadRegatta(eventId: string, opts: CacheOpts = {}): Promise<{ body: RegattaResponse; cached: boolean }> {
  // A finished event's document no longer changes; a live one does. Judge by when this copy was
  // fetched: one saved mid-event stays short-lived even after the event ends.
  const ttl = (body: unknown, fetchedAt: number): number => {
    const end = (body as RegattaResponse).revisions?.at(-1)?.doc?.endDate;
    return end && fetchedAt - end > DAY ? 7 * DAY : 2 * MINUTE;
  };
  return cachedJsonFrom<RegattaResponse>(`${PROXY_BASE}/regatta?event=${encodeURIComponent(eventId)}`, ttl, opts);
}

export async function fetchRegatta(eventId: string, signal?: AbortSignal, opts: { fresh?: boolean } = {}): Promise<RegattaResponse> {
  return (await loadRegatta(eventId, { ...opts, signal })).body;
}

/**
 * The regatta, refetched once from the network (bypassing our caches) when a cached copy
 * fails `usable`, e.g. one saved before any boat finished. A network copy is returned as is.
 */
export async function fetchUsableRegatta(
  eventId: string,
  usable: (r: RegattaResponse) => boolean,
  signal?: AbortSignal,
): Promise<RegattaResponse> {
  const got = await loadRegatta(eventId, { signal });
  if (!got.cached || usable(got.body)) return got.body;
  return fetchRegatta(eventId, signal, { fresh: true });
}

/**
 * A division name as teleapi tags its rows: spaces as '_' and dots as '//' ("VX One" → "VX_One",
 * "Female 7.5" → "Female_7//5"). Queried by the plain name, such a division returns no rows. The
 * regatta document and everything keyed off it keep the display name.
 */
export function feedDivision(name: string): string {
  return name.replace(/ /g, '_').replace(/\./g, '//');
}

/**
 * Telemetry for [after, before] (ms), paginated by advancing `after`
 * (exclusive). Pages overlap by 1 ms so rows sharing the boundary
 * timestamp aren't lost; the adapter de-duplicates. `division` is the display name (mapped by feedDivision).
 */
export async function fetchTelemetry(
  eventId: string,
  division: string | null,
  after: number,
  before: number,
  opts: { signal?: AbortSignal; finished?: boolean; onPage?: (n: number, rows: number) => void } = {},
): Promise<TelemetryPage[]> {
  const pages: TelemetryPage[] = [];
  let cursor = Math.floor(after);
  const ttl = opts.finished ? 30 * DAY : MINUTE;
  for (let n = 0; n < MAX_PAGES; n++) {
    const p = new URLSearchParams({ after: String(cursor), before: String(Math.floor(before)), limit: String(PAGE) });
    if (division) p.set('division', feedDivision(division));
    const url = `${PROXY_BASE}/telemetry/event/${encodeURIComponent(eventId)}?${p}`;
    const page = await cachedJson<TelemetryPage>(url, ttl, opts.signal);
    pages.push(page);
    opts.onPage?.(n + 1, page.Rows?.length ?? 0);
    if (!page.Fields || !page.Rows || page.Rows.length < PAGE) break;
    const tsIdx = page.Fields.indexOf('ts');
    const last = Math.floor(Number(page.Rows[page.Rows.length - 1][tsIdx]));
    if (!(last > cursor + 1)) break;
    cursor = last - 1;
  }
  return pages;
}

/** Modelled wind (not measured) for the race day; failures are non-fatal. */
export async function fetchWind(lat: number, lon: number, gunMs: number, signal?: AbortSignal): Promise<WindResponse | undefined> {
  const day = new Date(gunMs).toISOString().slice(0, 10);
  const url = `${PROXY_BASE}/wind?v=3&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&start=${day}&end=${day}`;
  try {
    return await cachedJson<WindResponse>(url, Date.now() - gunMs > 2 * DAY ? 30 * DAY : HOUR, signal);
  } catch {
    return undefined;
  }
}
