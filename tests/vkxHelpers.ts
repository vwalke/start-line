/**
 * Boat-log (.vkx) fixtures: RO's (Relative Obscurity, USA 833) own log of Fri
 * Sep 11 2026, J/70 Worlds Cascais, trimmed to 12:01–12:08Z (R7 gun) and
 * 13:51–13:58Z (R8 gun), with the matching feed rows and regatta document
 * (scripts/make-vkx-fixture.mjs). The full 10 MB log is read only when present.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RegattaResponse, TelemetryPage } from '../src/data/racesense/types';
import type { FeedFetcher } from '../src/data/vkx/plan';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export const FULL_SAMPLE = process.env.VKX_SAMPLE ?? '/workspace/recall-vkx-run/inputs/ro-usa833-2026-09-11.vkx';
export const hasFullSample = existsSync(FULL_SAMPLE);

export const EVENT = 'oRkxbTpSZPbSkrmKrbj2';
export const DIV = 'Open';
export const RO = { sn: 12364, sail: 'USA 833', name: 'RELATIVE OBSCURITY' };
/** A UTC time on the day. */
export const Z = (hhmmss: string): number => Date.parse(`2026-09-11T${hhmmss}Z`);
/** The regatta document's R7 gun (RaceSense records it 1 s after the boat's timer zero). */
export const R7_GUN = Z('12:05:01');
/** Official R8 (not in the RaceSense race list): the boat's timer gun, and its finish as FINDINGS has it. */
export const R8_GUN = Z('13:55:00');
export const R8_END = Z('15:17:30');
/** RO's R7 finish as FINDINGS has it (R7 has no finishes in the regatta document). */
export const R7_RO_FINISH = Z('13:32:30');

export function readAb(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export const trimVkx = (): ArrayBuffer => readAb(here('./fixtures/vkx/ro-trim.vkx'));
export const fullVkx = (): ArrayBuffer => readAb(FULL_SAMPLE);

let feed: TelemetryPage | null = null;
export function vkxFeed(): TelemetryPage {
  feed ??= JSON.parse(readFileSync(here('./fixtures/vkx/feed.json'), 'utf8')) as TelemetryPage;
  return feed;
}

export const vkxRegatta = (): RegattaResponse => JSON.parse(readFileSync(here('./fixtures/vkx/regatta.json'), 'utf8')) as RegattaResponse;

/** The feed rows in [after, before], optionally edited. */
export function feedSlice(after: number, before: number, page: TelemetryPage = vkxFeed()): TelemetryPage {
  const ts = page.Fields!.indexOf('ts');
  return { Fields: page.Fields, Rows: page.Rows!.filter((r) => Number(r[ts]) >= after && Number(r[ts]) <= before) };
}

/** A FeedFetcher over the fixture (as the app's /api/telemetry proxy would answer). */
export const fixtureFetcher =
  (page: TelemetryPage = vkxFeed(), calls: { n: number } = { n: 0 }): FeedFetcher =>
  async (after, before) => {
    calls.n++;
    return [feedSlice(after, before, page)];
  };

/** A fetch() standing in for teleapi: answers /telemetry/event/<id>?after&before from the fixture; `down` fails. */
export function mockUpstream(opts: { page?: TelemetryPage; down?: 'throw' | 'status' } = {}): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.toString());
    if (opts.down === 'throw') throw new TypeError('fetch failed');
    if (opts.down === 'status') return new Response('busy', { status: 502 });
    const page = feedSlice(Number(url.searchParams.get('after')), Number(url.searchParams.get('before')), opts.page);
    return new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

/** A copy of the feed with one device's rows moved by (dLat, dLon) degrees, or kept only where `keep` says. */
export function editFeed(sn: number, edit: { dLat?: number; dLon?: number; keep?: (ts: number, k: number) => boolean }): TelemetryPage {
  const p = vkxFeed();
  const f = (n: string): number => p.Fields!.indexOf(n);
  let k = 0;
  const rows = p.Rows!.flatMap((r) => {
    if (Number(r[f('sn')]) !== sn) return [r];
    if (edit.keep && !edit.keep(Number(r[f('ts')]), k++)) return [];
    const c = [...r];
    c[f('latitude')] = Number(c[f('latitude')]) + (edit.dLat ?? 0);
    c[f('longitude')] = Number(c[f('longitude')]) + (edit.dLon ?? 0);
    return [c];
  });
  return { Fields: p.Fields, Rows: rows };
}
