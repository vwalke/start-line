/**
 * The hero from a stored race (a test fixture: regatta document, telemetry, wind), analysed as the
 * worker does. Used by scripts/landing-hero.mjs and its test; never loaded by the page.
 */
import { analyzeRace } from '../analysis/analyze';
import { buildRaceData } from '../data/racesense/adapter';
import type { RegattaResponse, TelemetryPage, WindResponse } from '../data/racesense/types';
import { heroSvg } from './hero';

export interface HeroFixture {
  eventId: string;
  regatta: RegattaResponse;
  telemetry: TelemetryPage;
  wind?: WindResponse | null;
}

export function heroFromFixture(f: HeroFixture, division: string, raceNumber: number, scheme: 'day' | 'night' = 'day'): string {
  const data = buildRaceData(f.regatta, { division, raceNumber }, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind ?? undefined });
  const a = analyzeRace(data);
  return heroSvg(a, {
    title: `Recall's track map of a real race with ${a.boats.length} boats. Wind is at the top, the tracks are colored by leg, each boat is shown at its position mid-race, and the leaders are labeled by sail number.`,
    scheme,
  });
}
