import { describe, expect, it } from 'vitest';
import {
  RACESENSE_DTL_SAMPLE_OFFSET_MS,
  argbToHex,
  buildRaceData,
  currentDoc,
defaultRace, listRaces, parseTelemetry, snFromHex, telemetryWindow, tzOffsetMs } from '../src/data/racesense/adapter';
import { fixtureRace, loadFixture } from './helpers';

describe('RaceSense adapter', () => {
  it('maps 10-hex serials to telemetry sn (low 16 bits)', () => {
    expect(snFromHex('0238004CA1')).toBe(19617);
    expect(snFromHex('38C9')).toBe(14537);
  });

  it('converts feed colours and microsecond tz offsets', () => {
    expect(argbToHex(4293913065)).toBe('#efe9e9');
    expect(argbToHex(0xff112233)).toBe('#112233');
    expect(tzOffsetMs(7_200_000_000)).toBe(7_200_000);
    expect(tzOffsetMs(3_600_000)).toBe(3_600_000);
  });

  it('lists races newest first and defaults to the latest finished one', () => {
    const doc = currentDoc(loadFixture().regatta);
    const races = listRaces(doc);
    expect(races[0].raceNumber).toBe(9);
    expect(races[0].finished).toBe(false);
    expect(defaultRace(doc)?.raceNumber).toBe(8);
  });

  it('asks only for the race window', () => {
    const doc = currentDoc(loadFixture().regatta);
    const w = telemetryWindow(doc, { division: 'J70', raceNumber: 8 });
    expect(w.after).toBe(1792237201000 - 90_000);
    expect(w.before - w.after).toBeLessThan(25 * 60_000);
  });

  it('de-duplicates overlapping pages', () => {
    const page = { Fields: ['ts', 'sn', 'role', 'latitude', 'longitude'], Rows: [[1, 2, 'mark', 52, 5]] };
    expect(parseTelemetry([page, page])).toHaveLength(1);
  });

  it('builds RaceData with boats, line, course and finishes', () => {
    const rd = fixtureRace();
    expect(rd.gunMs).toBe(1792237201000);
    expect(rd.boats.map((b) => b.sail).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(rd.boats.every((b) => b.bowOffsetM === 2.65)).toBe(true);
    expect(rd.course.map((c) => `${c.name}:${c.kind}`)).toEqual(['M1:mark', 'Gate:gate', 'M1:mark']);
    expect(rd.finishLine).not.toBeNull();
    expect(rd.boats.filter((b) => b.finishMs != null)).toHaveLength(6);
    expect(rd.tzOffsetMs).toBe(2 * 3_600_000);
    expect(rd.windModel?.samples.length).toBeGreaterThan(0);
    // Mark tracks are kept (10 s medians) so moved marks can be followed.
    expect(rd.course[0].tracks?.[0].t.length).toBeGreaterThan(10);
    expect(rd.course[0].id).toBe(rd.course[2].id);
    expect(rd.dtlSampleOffsetMs).toBe(RACESENSE_DTL_SAMPLE_OFFSET_MS);
    expect(RACESENSE_DTL_SAMPLE_OFFSET_MS).toBe(900);
  });

  it('treats a negative bowOffsetCm as unset and uses the division default', () => {
    const f = loadFixture();
    const regatta = structuredClone(f.regatta);
    const div = currentDoc(regatta).divisions.find((d) => d.name === 'J70')!;
    div.offsetOverrideCm = 265;
    div.participants.find((p) => p.sailNumber === '3')!.bowOffsetCm = -1;
    const rd = buildRaceData(regatta, { division: 'J70', raceNumber: 8 }, [f.telemetry]);
    expect(rd.boats.find((b) => b.sail === '3')!.bowOffsetM).toBe(2.65);
  });
});
