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

export function heroFromFixture(f: HeroFixture, division: string, raceNumber: number): string {
  const data = buildRaceData(f.regatta, { division, raceNumber }, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind ?? undefined });
  const a = analyzeRace(data);
  return heroSvg(a, {
    title: `Recall's track map of a real race: ${a.boats.length} boats, wind at the top, tracks coloured by leg, every boat's position mid-race and the leaders labelled by sail number`,
  });
}
