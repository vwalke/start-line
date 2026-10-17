import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRaceData } from '../src/data/racesense/adapter';
import type { RegattaResponse, TelemetryPage, WindResponse } from '../src/data/racesense/types';
import type { RaceData } from '../src/data/types';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export interface Fixture {
  eventId: string;
  regatta: RegattaResponse;
  wind: WindResponse;
  telemetry: TelemetryPage;
}

let cached: Fixture | null = null;
export function loadFixture(): Fixture {
  cached ??= JSON.parse(readFileSync(here('./fixtures/benelux_r8.json'), 'utf8')) as Fixture;
  return cached;
}

export function fixtureRace(): RaceData {
  const f = loadFixture();
  return buildRaceData(f.regatta, { division: 'J70', raceNumber: 8 }, [f.telemetry], {
    eventId: f.eventId,
    kind: 'fixture',
    wind: f.wind,
  });
}

/** C31 Gold Cup race 10: four boats chosen for the Vakaros data-quality cases (stale row, mask 5, no distance, clean). */
export function c31Fixture(): Fixture {
  return JSON.parse(readFileSync(here('./fixtures/c31_r10.json'), 'utf8')) as Fixture;
}

export function c31Race(f: Fixture = c31Fixture()): RaceData {
  return buildRaceData(f.regatta, { division: 'C31', raceNumber: 10 }, [f.telemetry], {
    eventId: f.eventId,
    kind: 'fixture',
    wind: f.wind,
  });
}

export type CsvRow = Record<string, string>;
export function loadExpected(): CsvRow[] {
  const [head, ...lines] = readFileSync(here('./fixtures/benelux_act3_race8_metrics.csv'), 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}
