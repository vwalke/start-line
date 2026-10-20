/** Offline sources for the race-recovery goldens (tests/fixtures/recovery, built by scripts/make-recovery-fixtures.ts). */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { YsSource } from '../src/data/official/yachtscoring';
import type { FetchRows, OrphanFound } from '../src/data/orphans';
import { parseTelemetry } from '../src/data/racesense/adapter';
import type { RegattaResponse, TelemetryPage } from '../src/data/racesense/types';

const here = (p: string): string => fileURLToPath(new URL(`./fixtures/recovery/${p}`, import.meta.url));
export const readJson = <T>(p: string): T => JSON.parse(readFileSync(here(p), 'utf8')) as T;
export const regatta = (f: 'rs_j105.json' | 'rs_aycfs.json' | 'rs_j70.json'): RegattaResponse => readJson<RegattaResponse>(f);

/** As the fixture script names them. */
const ysFile = (path: string): string => path.replace(/[^A-Za-z0-9._-]+/g, '_') + '.json';

/** Yachtscoring from the recorded responses; anything not recorded fails like a 404. */
export function fixtureYs(calls: string[] = []): YsSource {
  const get = async <T>(path: string): Promise<T> => {
    calls.push(path);
    const f = `ys/${ysFile(path)}`;
    if (!existsSync(here(f))) throw new Error(`404 Not Found for /api/ys/${path}`);
    return readJson<T>(f);
  };
  return {
    searchDates: async (gte, lte) => (await get<{ rows?: never[] }>(`event?startDate_gte=${gte}&startDate_lte=${lte}&sort=startDate.desc&size=100`)).rows ?? [],
    searchName: async (q) => (await get<{ rows?: never[] }>(`event?name_contains=${encodeURIComponent(q)}&sort=startDate.desc&size=40`)).rows ?? [],
    event: (id) => get(`event/${id}`),
    races: async (id) => (await get<{ rows?: never[] }>(`event/${id}/races?size=200`)).rows ?? [],
    results: (id, n) => get(`event/${id}/result-detail-report?raceNumber=${n}`),
  };
}

/** The recorded probes, replayed; a probe the recording doesn't have fails the test. */
export function replayProbes(file: 'j70_probes.json' | 'ayc_probes.json'): { fetchRows: FetchRows; recorded: OrphanFound[] | undefined; calls: string[] } {
  const f = readJson<{ probes: Record<string, TelemetryPage>; found?: OrphanFound[] }>(file);
  const calls: string[] = [];
  return {
    calls,
    recorded: f.found,
    fetchRows: async (a, b, division) => {
      const k = `${a}|${b}|${division ?? ''}`;
      calls.push(k);
      const page = f.probes[k];
      if (!page) throw new Error(`probe not recorded: ${k}`);
      return parseTelemetry([page]);
    },
  };
}

export interface FinishFixture {
  official: number;
  gunMs: number;
  endMs: number;
  feedRaceNumber: number | null;
  telemetry: TelemetryPage;
  atGun?: TelemetryPage;
}
export const finishFixture = (label: 'or3' | 'or4' | 'or7' | 'or8'): FinishFixture => readJson<FinishFixture>(`j70_${label}.json`);

export interface SailtiBoat {
  sail: string;
  name: string;
  races: { points: number; code: string | null }[];
}
export const sailti = (): SailtiBoat[] =>
  (JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/recovery/j70worlds-2026-sailti-overall.json', import.meta.url)), 'utf8')) as { boats: SailtiBoat[] }).boats;
