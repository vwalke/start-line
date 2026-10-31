/**
 * J/70 North Americans race 6 (tests/fixtures/j70nas_r6_start.json: 1513 and 11 more boats, gun −100 s to +60 s).
 * The feed sets no bow offset (every entry and the division say -1), and each Vakaros row says race 8 (the devices
 * count starts themselves). Race control flagged 1513 OCS; its row implies a 7.2 m bow offset on a 6.93 m boat.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { bowAheadM, classDims } from '../src/data/classes';
import {
  buildRaceData,
  currentDoc,
  impliedBowM,
  rcStartFix,
  rowStartMs,
  BOW_COS_MIN,
  POSITION_MATCH_M,
  RACESENSE_DTL_SAMPLE_OFFSET_MS,
  RC_BOW_TOO_LONG,
} from '../src/data/racesense/adapter';
import type { RegattaResponse, StartingStat } from '../src/data/racesense/types';
import type { Fixture } from './helpers';

const f = JSON.parse(readFileSync(new URL('./fixtures/j70nas_r6_start.json', import.meta.url), 'utf8')) as Fixture;
const REF = { division: 'J70', raceNumber: 6 };
const build = (regatta: RegattaResponse = f.regatta) => buildRaceData(regatta, REF, [f.telemetry], { eventId: f.eventId, kind: 'fixture' });
const data = build();
const analysis = analyzeRace(data);
const start = (sail: string) => analysis.boats.find((b) => b.sail === sail)!.start!;
const docOf = (regatta: RegattaResponse) => currentDoc(regatta);
const raceOf = (regatta: RegattaResponse) => docOf(regatta).divisions[0].races![0];
const rows = (regatta: RegattaResponse = f.regatta): StartingStat[] => raceOf(regatta).starts![0].startingStats!;
/** The fixture's document with one boat's Vakaros row changed. */
const withRow = (sail: string, edit: (s: StartingStat) => void): RegattaResponse => {
  const regatta = structuredClone(f.regatta);
  edit(rows(regatta).find((s) => s.sailNumber === sail)!);
  return regatta;
};
const rcOf = (regatta: RegattaResponse, sail: string) => build(regatta).boats.find((b) => b.sail === sail)!.rc!;

describe('J/70 NAs race 6: the start from the bow when the feed sets no offset', () => {
  it('takes the J/70’s usual offset (2.65 m) for every boat: the feed’s -1 is unset', () => {
    const div = docOf(f.regatta).divisions[0];
    expect(div.offsetOverrideCm).toBe(-1);
    expect(div.participants.every((p) => p.bowOffsetCm === -1)).toBe(true);
    expect(data.boats.every((b) => b.bowOffsetM === 2.65)).toBe(true);
    expect(analysis.boats.every((b) => b.bowOffsetM === 2.65)).toBe(true);
  });

  it('1513: 2.1 m to the line from its bow (3.7 m from its tracker); over early, as race control flagged it', () => {
    const s = start('1513');
    expect(s.dtlM).toBeCloseTo(2.09, 1);
    expect(s.rank).toEqual({ m: s.dtlM, source: 'ours' });
    expect(s).toMatchObject({ ocs: true, over: true, startPlace: null });
  });

  it('the hull drawn on the map has its bow where the start is measured from', () => {
    const dims = classDims(data.boatClass);
    for (const b of analysis.boats) expect(bowAheadM(b.bowOffsetM, dims)).toBe(b.bowOffsetM);
  });

  it('a set offset that fits the hull is kept, on the boat or the division', () => {
    const regatta = structuredClone(f.regatta);
    const div = docOf(regatta).divisions[0];
    div.participants.find((p) => p.sailNumber === '49')!.bowOffsetCm = 210;
    div.participants.find((p) => p.sailNumber === '169')!.bowOffsetCm = 1200;
    let rd = build(regatta);
    expect(rd.boats.find((b) => b.sail === '49')!.bowOffsetM).toBe(2.1);
    // 12 m on a J/70 doesn't fit: the class's offset.
    expect(rd.boats.find((b) => b.sail === '169')!.bowOffsetM).toBe(2.65);
    div.offsetOverrideCm = 300;
    rd = build(regatta);
    expect(rd.boats.find((b) => b.sail === '49')!.bowOffsetM).toBe(2.1);
    expect(rd.boats.find((b) => b.sail === '1513')!.bowOffsetM).toBe(3);
  });
});

describe('J/70 NAs race 6: Vakaros rows numbered race 8', () => {
  it('keeps every row: line ends and start time match, and the position is the boat’s own', () => {
    const ok = analysis.boats.filter((b) => b.start!.rcStatus === 'ok');
    expect(ok.length).toBe(analysis.boats.length - 1);
    for (const b of ok) {
      const row = rows().find((s) => s.sailNumber === b.sail)!;
      expect(row.raceNumber).toBe(8);
      expect(b.start!.rcDtlM).toBe(row.dtlMm! / 1000);
    }
  });

  it('sets 1513’s row aside: its device’s bow offset (7.2 m) is longer than a J/70', () => {
    const row = rows().find((s) => s.sailNumber === '1513')!;
    expect(impliedBowM(row)).toBeCloseTo(7.2, 1);
    const s = start('1513');
    expect(s.rcStatus).toBe('untrusted');
    expect(s.rcDtlM).toBeNull();
    expect(s.rcNote).toBe(RC_BOW_TOO_LONG);
    expect(data.boats.find((b) => b.sail === '1513')!.rcDtlM).toBeNull();
  });

  it('keeps a renumbered row on its position alone (no start time) and drops one from elsewhere', () => {
    expect(rcOf(withRow('404', (s) => (s.startTime = null)), '404')).toEqual({ status: 'ok', dtlM: 3.739 });
    // Line ends match but the position is ~110 m off the boat's track: a row carried over from another start.
    const far = withRow('404', (s) => {
      s.startTime = null;
      s.positionAtStart!.coordinates[1] += 0.001;
    });
    expect(rcOf(far, '404')).toMatchObject({ status: 'stale', dtlM: null, staleRace: 8, note: 'Vakaros reported no start fix (stale race 8 data)' });
    // The start time matches, but the position isn't the boat's (race 5's row for 16: 97 m off, a 229 m "bow offset").
    const elsewhere = withRow('404', (s) => (s.positionAtStart!.coordinates[1] += 0.001));
    expect(rcOf(elsewhere, '404')).toMatchObject({ status: 'stale', dtlM: null, staleRace: 8 });
    // With no position reported, the matching start time does.
    const noPos = withRow('404', (s) => (s.mask = { value: 13 }));
    expect(rcOf(noPos, '404')).toEqual({ status: 'ok', dtlM: 3.739 });
    expect(rcOf(withRow('404', (s) => ((s.mask = { value: 13 }), (s.startTime = null))), '404').status).toBe('stale');
    // The start time matches, but a line end is 50 m off.
    const moved = withRow('404', (s) => (s.lineLeftLocation!.coordinates[1] += 0.00045));
    expect(rcOf(moved, '404')).toMatchObject({ status: 'stale', dtlM: null });
    // Another start's time and a position that isn't this boat's.
    const other = withRow('404', (s) => {
      s.startTime = '2026-10-30T12:52:41.000';
      s.positionAtStart!.coordinates[0] += 0.001;
    });
    expect(rcOf(other, '404').status).toBe('stale');
  });

  it('judges the position where the device takes its fix, within POSITION_MATCH_M', () => {
    const regatta = withRow('404', (s) => (s.startTime = null));
    const race = raceOf(regatta);
    const st = race.starts![0];
    const row = rows(regatta).find((s) => s.sailNumber === '404')!;
    const [lon, lat] = row.positionAtStart!.coordinates;
    const div = docOf(regatta).divisions[0];
    let asked = NaN;
    const at = (dLat: number) => (t: number) => ((asked = t), { lat: lat + dLat, lon });
    expect(rcStartFix(row, div, race, st, { positionAt: at(0) }).status).toBe('ok');
    expect(asked).toBe(st.startTime! - RACESENSE_DTL_SAMPLE_OFFSET_MS);
    const m = 1 / 111_195;
    expect(rcStartFix(row, div, race, st, { positionAt: at((POSITION_MATCH_M - 0.5) * m) }).status).toBe('ok');
    expect(rcStartFix(row, div, race, st, { positionAt: at((POSITION_MATCH_M + 0.5) * m) }).status).toBe('stale');
    expect(rcStartFix(row, div, race, st).status).toBe('stale');
  });

  it('reads the row’s start time as the race’s wall clock when it has no zone', () => {
    const race = raceOf(f.regatta);
    const row = rows().find((s) => s.sailNumber === '1513')!;
    expect(row.startTime).toBe('2026-10-30T14:15:01.000');
    expect(rowStartMs(row, race)).toBe(race.starts![0].startTime);
    expect(rowStartMs({ ...row, startTime: '2026-10-30T18:15:01.000Z' }, race)).toBe(race.starts![0].startTime);
    expect(rowStartMs({ ...row, startTime: 1793384101000 }, race)).toBe(1793384101000);
    expect(rowStartMs({ ...row, startTime: null }, race)).toBeNull();
    expect(rowStartMs({ ...row, startTime: 'soon' }, race)).toBeNull();
  });
});

describe('the bow offset a Vakaros row implies', () => {
  // A line running east, so the course side is north; heading in radians, as the feed gives it.
  const L = { lat: 38.95, lon: -76.42 };
  const mLat = 1 / 111_195;
  const mLon = mLat / Math.cos((L.lat * Math.PI) / 180);
  const row = (behindM: number, headingRad: number, dtlM: number): StartingStat => ({
    sailNumber: 'X',
    dtlMm: Math.round(dtlM * 1000),
    mask: { value: 15 },
    headingAtStartDeg: headingRad,
    positionAtStart: { coordinates: [L.lon + 100 * mLon, L.lat - behindM * mLat] },
    lineLeftLocation: { coordinates: [L.lon, L.lat] },
    lineRightLocation: { coordinates: [L.lon + 300 * mLon, L.lat] },
  });

  it('is the antenna’s distance less the device’s, over the cos of its heading against the line’s normal', () => {
    expect(impliedBowM(row(5, 0, 5 - 2.65))!).toBeCloseTo(2.65, 2);
    expect(impliedBowM(row(5, Math.PI / 3, 5 - 2.65 * 0.5))!).toBeCloseTo(2.65, 2);
    expect(impliedBowM(row(5, -Math.PI / 4, 5 - 2.65 * Math.SQRT1_2))!).toBeCloseTo(2.65, 2);
    // A figure past a full turn is degrees.
    expect(impliedBowM(row(5, 60, 5 - 2.65 * 0.5))!).toBeCloseTo(2.65, 2);
  });

  it('says nothing side-on, or without a position, a line end or a distance', () => {
    const side = Math.acos(BOW_COS_MIN - 0.05);
    expect(impliedBowM(row(5, side, -20))).toBeNull();
    expect(impliedBowM({ ...row(5, 0, 2), mask: { value: 13 } })).toBeNull();
    expect(impliedBowM({ ...row(5, 0, 2), mask: { value: 11 } })).toBeNull();
    expect(impliedBowM({ ...row(5, 0, 2), mask: { value: 14 } })).toBeNull();
    expect(impliedBowM({ ...row(5, 0, 2), headingAtStartDeg: undefined })).toBeNull();
  });

  it('sets a row aside when its offset is longer than the boat; otherwise uses it', () => {
    const doc = docOf(f.regatta);
    const div = doc.divisions[0];
    const race = div.races![0];
    const st = { startTime: null, startLine: null };
    const loaM = classDims('J/70')!.loaM;
    expect(rcStartFix(row(5, 0, 5 - 2.65), div, race, st, { loaM })).toEqual({ status: 'ok', dtlM: 2.35 });
    expect(rcStartFix(row(5, 0, 5 - 7.2), div, race, st, { loaM })).toEqual({ status: 'untrusted', dtlM: null, note: RC_BOW_TOO_LONG });
    // Side-on, the figure is noise and isn't judged.
    expect(rcStartFix(row(5, Math.acos(0.2), 5 - 7.2 * 0.2), div, race, st, { loaM }).status).toBe('ok');
    // With no class there's no hull to compare with.
    expect(rcStartFix(row(5, 0, 5 - 7.2), div, race, st).status).toBe('ok');
  });
});
