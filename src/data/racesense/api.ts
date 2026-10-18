/**
 * Network access to the public RaceSense endpoints. Everything goes through
 * our /api proxy (a Cloudflare Pages Function in production; Vite in dev)
 * so the browser Web Worker never has to CORS-fetch a third party.
 */
import { DAY, HOUR, MINUTE, cachedJson } from '../cache';
import type { LandingResponse, RegattaResponse, TelemetryPage, WindResponse } from './types';

export const PROXY_BASE = '/api';
/** teleapi's maximum page size. */
const PAGE = 100_000;
/** Never walk more than this many pages for one race. */
const MAX_PAGES = 8;

export function fetchLanding(signal?: AbortSignal): Promise<LandingResponse> {
  return cachedJson<LandingResponse>(`${PROXY_BASE}/landing`, 10 * MINUTE, signal);
}

export function fetchRegatta(eventId: string, signal?: AbortSignal): Promise<RegattaResponse> {
  // A finished event's document no longer changes; a live one does.
  const ttl = (body: unknown): number => {
    const end = (body as RegattaResponse).revisions?.at(-1)?.doc?.endDate;
    return end && Date.now() - end > DAY ? 7 * DAY : 2 * MINUTE;
  };
  return cachedJson<RegattaResponse>(`${PROXY_BASE}/regatta?event=${encodeURIComponent(eventId)}`, ttl, signal);
}

/**
 * Telemetry for [after, before] (ms), paginated by advancing `after`
 * (exclusive). Pages overlap by 1 ms so rows sharing the boundary
 * timestamp aren't lost; the adapter de-duplicates.
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
    if (division) p.set('division', division);
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
