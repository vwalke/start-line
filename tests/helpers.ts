import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRaceData, currentDoc, nextGunMs, type OfficialRaceInput } from '../src/data/racesense/adapter';
import { matchBoats } from '../src/data/official/sail';
import { parseResults, type YsResultBoat, type YsResultReport } from '../src/data/official/yachtscoring';
import type { RegattaResponse, TelemetryPage, WindResponse } from '../src/data/racesense/types';
import type { RaceData } from '../src/data/types';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw, type CoachModel } from '../src/analysis/coach';
import { coachDebrief, type CoachDebrief } from '../src/analysis/coach/debrief';
import type { RaceAnalysis } from '../src/analysis/types';

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

function trimmedRace(file: string, division: string, raceNumber: number): RaceData {
  const f = JSON.parse(readFileSync(here(file), 'utf8')) as Fixture;
  return buildRaceData(f.regatta, { division, raceNumber }, [f.telemetry], {
    eventId: f.eventId,
    kind: 'fixture',
    wind: f.wind ?? undefined,
  });
}

/** Melges 24 Worlds race 4: only the Gate is tracked (the start boats, which motor up to lay it); 12 boats incl. the winner 870, plus coaches 03/07/10, SPARE 1 and 619. */
export const m24Race = (): RaceData => trimmedRace('./fixtures/m24_r4.json', 'M24', 4);

/** J/88 North Americans race 5: no mark trackers at all; 8 boats. */
export const j88Race = (): RaceData => trimmedRace('./fixtures/j88_r5.json', 'J88', 5);

/** IC37 North Americans race 5 (gun 10:05:01 EDT): all 15 boats, gun − 60 s to the end of Beat 1 (dense to +6 min) — the Coach start case. */
export const ic37Race = (): RaceData => trimmedRace('./fixtures/ic37_r5.json', 'IC37', 5);

/**
 * IC37 race 5's official results (Yachtscoring, tests/fixtures/ys50934_r5.json: sails, statuses, places and times
 * only), parsed and paired by sail with the RaceSense boats as link.ts does; times are EDT (UTC − 4 h). `edit` may
 * change the report's boats first (a synthetic code).
 */
export function ic37Official(edit?: (boats: YsResultBoat[]) => void): OfficialRaceInput {
  const rep = JSON.parse(readFileSync(here('./fixtures/ys50934_r5.json'), 'utf8')) as YsResultReport;
  const cls = rep.data![0].divisions![0].classes![0];
  edit?.(cls.boats!);
  const rows = parseResults(rep, { circle: rep.data![0].circleName!, className: cls.className! })!;
  const f = JSON.parse(readFileSync(here('./fixtures/ic37_r5.json'), 'utf8')) as Fixture;
  const sails = buildRaceData(f.regatta, { division: 'IC37', raceNumber: 5 }, [f.telemetry], { eventId: f.eventId, kind: 'fixture' }).boats.map((b) => b.sail);
  const m = matchBoats(sails, rows, (s) => ({ sail: s }), (r) => ({ prefix: r.prefix, sail: r.sail }));
  const rsOf = new Map(m.pairs.map((p) => [p.b, p.a]));
  return { number: 5, tzOffsetMs: -4 * 3_600_000, rows: rows.map((r) => ({ ...r, rsSail: rsOf.get(r) ?? null })) };
}

/** IC37 race 5 linked to its official results (ic37Official), as the app builds it. */
export function ic37LinkedRace(official: OfficialRaceInput = ic37Official()): RaceData {
  const f = JSON.parse(readFileSync(here('./fixtures/ic37_r5.json'), 'utf8')) as Fixture;
  const ref = { division: 'IC37', raceNumber: 5 };
  return buildRaceData(f.regatta, ref, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind ?? undefined, official, nextGunMs: nextGunMs(currentDoc(f.regatta), ref) });
}

/** The J/105 fixtures' raw form (to edit the telemetry before building). */
export const j105Fixture = (raceNumber: 1 | 2 | 3): Fixture =>
  JSON.parse(readFileSync(here(`./fixtures/j105_r${raceNumber}.json`), 'utf8')) as Fixture;

/**
 * 2026 J105 CBC race 1, 2 or 3: no mark trackers; Good Trade (USA 96) is a sparse
 * tracker (a 45 min hole through Run 1 and Beat 2 of race 2) with a broken
 * compass (~115° off its course in race 1), plus 7 boats across the results.
 * Race 3 (the Coach golden case): Good Trade plus the official 1st–9th finishers.
 */
export function j105Race(raceNumber: 1 | 2 | 3, f: Fixture = j105Fixture(raceNumber)): RaceData {
  return buildRaceData(f.regatta, { division: 'J105', raceNumber }, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind });
}

/** The gate-choice (D13) goldens: whole fleets, 1 Hz around each boat's gate rounding (scripts/make-fixture.mjs --preset gate-<key>). */
export const GATE_RACES = {
  j24r2: { division: 'J-24', raceNumber: 2 },
  j24r5: { division: 'J-24', raceNumber: 5 },
  j111r5: { division: 'J-111', raceNumber: 5 },
  ic37r2: { division: 'IC37', raceNumber: 2 },
  m24r5: { division: 'M24', raceNumber: 5 },
  viperr2: { division: 'Viper 640', raceNumber: 2 },
} as const;
export const gateRace = (key: keyof typeof GATE_RACES): RaceData => trimmedRace(`./fixtures/gate_${key}.json`, GATE_RACES[key].division, GATE_RACES[key].raceNumber);

/**
 * J/70 Worlds 2026 (Cascais), Open, races 2 and 3: the whole 100-boat fleet, native rate around the gun and each windward
 * rounding, every 10 s elsewhere, holes kept (scripts/make-fixture.mjs --preset cascais-r2 / cascais-r3).
 */
export const CASCAIS_RACES = {
  r2: { division: 'Open', raceNumber: 2 },
  r3: { division: 'Open', raceNumber: 3 },
} as const;
export const cascaisRace = (key: keyof typeof CASCAIS_RACES): RaceData => trimmedRace(`./fixtures/cascais_${key}.json`, CASCAIS_RACES[key].division, CASCAIS_RACES[key].raceNumber);

/** A race through the app path: the analysis and the Coach's model. */
export interface CoachRace {
  a: RaceAnalysis;
  m: CoachModel;
}
export function coachRace(data: RaceData): CoachRace {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  return { a, m: buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null, raw.turns ?? null, raw.overStart ?? null)! };
}

/** Each boat's debrief once per model: the fleet-wide tests of one file share them (read-only). */
const debriefs = new WeakMap<CoachModel, Map<string, CoachDebrief | null>>();
export function debriefOf(a: RaceAnalysis, m: CoachModel, id: string): CoachDebrief | null {
  let byId = debriefs.get(m);
  if (!byId) debriefs.set(m, (byId = new Map()));
  if (!byId.has(id)) byId.set(id, coachDebrief(a, m, id));
  return byId.get(id)!;
}

/** D17 over every boat: its cards in the top 3, all it found (before the ranking), its Went well lines. */
export function d17Tally(a: RaceAnalysis, m: CoachModel): { cards: number; found: number; plus: number } {
  const out = { cards: 0, found: 0, plus: 0 };
  for (const b of a.boats) {
    const d = debriefOf(a, m, b.id);
    if (!d) continue;
    out.cards += d.cards.filter((c) => c.kind === 'D17').length;
    out.found += d.found.filter((o) => o.kind === 'D17').length;
    out.plus += d.plus.filter((n) => n.detector === 'D17').length;
  }
  return out;
}

export type CsvRow = Record<string, string>;
export function loadExpected(): CsvRow[] {
  const [head, ...lines] = readFileSync(here('./fixtures/benelux_act3_race8_metrics.csv'), 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}
