import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { wrap180 } from '../src/analysis/geo';
import type { RaceAnalysis } from '../src/analysis/types';
import { currentDoc, findRace } from '../src/data/racesense/adapter';
import { legsTableKey, startTableKey } from '../src/ui/table';
import { j105Fixture, j105Race } from './helpers';

/** 2026 J105 CBC (Oct 18, EDT): Good Trade's sparse tracker and broken compass. */
const GT = 'USA 96';
const boat = (a: RaceAnalysis, id: string) => a.boats.find((b) => b.id === id)!;

describe('J/105 race 2: a sparse tracker that finished', () => {
  const data = j105Race(2);
  const a = analyzeRace(data);

  it("accepts Good Trade's finish (13:33:09 EDT) although the device counted 1.1 km of ~13 km", () => {
    expect(data.boats.find((b) => b.id === GT)!.entry).toMatchObject({ finishPlausible: true });
    const gt = boat(a, GT);
    expect(gt.finishMs).toBe(Date.parse('2026-10-18T17:33:09.038Z'));
    expect(gt.finishPos).toBe(2); // 4th of the full fleet's trackers; 2nd of this fixture's boats
    expect(a.notes.some((n) => n.kind === 'finish-unranked')).toBe(false);
  });

  it('still flags a tracker with the same holes that never leaves the line (a committee boat)', () => {
    const f = j105Fixture(2);
    const { race } = findRace(currentDoc(f.regatta), { division: 'J105', raceNumber: 2 });
    const { leftEnd, rightEnd } = race.starts.at(-1)!.startLine!;
    const F = f.telemetry.Fields!;
    const [sail, lat, lon] = ['sail_number', 'latitude', 'longitude'].map((k) => F.indexOf(k));
    for (const r of f.telemetry.Rows!) {
      if (r[sail] !== GT) continue;
      r[lat] = (leftEnd[0] + rightEnd[0]) / 2 + 0.0005 * Math.sin(Number(r[0]) / 60_000);
      r[lon] = (leftEnd[1] + rightEnd[1]) / 2;
    }
    const d = j105Race(2, f);
    expect(d.boats.find((b) => b.id === GT)!.entry).toMatchObject({ finishPlausible: false });
    expect(analyzeRace(d).warnings).toContain("Not ranking #USA 96 (Good Trade)'s finish: the feed has it sailing 1.1 km against the fleet's 13.0 km.");
  });

  it('times no leg across its 45 min hole (no 3039 s Run 1): every leg unknown, out of ranks and summaries', () => {
    const gt = boat(a, GT);
    expect(gt.legs).toEqual([null, null, null, null]);
    expect(gt.upwind).toBeNull();
    expect(gt.downwind).toBeNull();
    // The track is still drawn: the drawing keeps its own split.
    expect(a.drawings.find((d) => d.id === GT)!.segments.length).toBeGreaterThan(0);
    // The others are ranked 1…n at every mark, with nothing slower than twice the leg's median.
    a.legs.forEach((_, li) => {
      const done = a.boats.filter((b) => b.legs[li]);
      expect(done.map((b) => b.legs[li]!.rankAtEnd).sort((x, y) => x! - y!)).toEqual(done.map((_, k) => k + 1));
      const ts = done.map((b) => b.legs[li]!.timeS).sort((x, y) => x - y);
      for (const t of ts) expect(t).toBeLessThan(2 * ts[ts.length >> 1]);
    });
  });

  it('keeps the heading of a tracker whose compass is only loosely off (median 17°)', () => {
    expect(boat(a, GT).headingSource).toBe('device');
  });
});

describe('J/105 race 1: a broken compass', () => {
  const data = j105Race(1);
  const a = analyzeRace(data);
  const gt = boat(a, GT);

  it("detects Good Trade's heading ~115° off its course and uses the GPS course instead", () => {
    expect(gt.headingSource).toBe('cog');
    expect(gt.headingOffDeg!).toBeGreaterThan(90);
    // Beat 1 TWA was 76–83° from the compass: impossible upwind.
    expect(a.legs[0].kind).toBe('upwind');
    expect(gt.legs[0]!.twaDeg).toBeGreaterThanOrEqual(35);
    expect(gt.legs[0]!.twaDeg).toBeLessThanOrEqual(50);
    expect(gt.legs[1]!.twaDeg).toBeGreaterThan(140);
  });

  it('keeps every other boat on its own compass, figures unchanged by the switch', () => {
    for (const b of a.boats) if (b.id !== GT) expect(b.headingSource, b.id).toBe('device');
    expect(boat(a, 'USA 242').headingOffDeg!).toBeLessThan(15);
  });

  it('leaves the broken compass out of the fleet wind', () => {
    const without = analyzeRace({ ...data, boats: data.boats.filter((b) => b.id !== GT) });
    expect(Math.abs(wrap180(a.wind.twdAtGunDeg - without.wind.twdAtGunDeg))).toBeLessThan(0.5);
  });

  it('says so with a ⚠ chip on both tables, and in the start ⓘ', () => {
    const chip = { text: '#USA 96 heading from GPS course', warn: true };
    expect(legsTableKey(a).chips).toContainEqual(expect.objectContaining(chip));
    const start = startTableKey(a);
    expect(start.chips).toContainEqual(expect.objectContaining(chip));
    expect(start.chips.find((c) => c.text === chip.text)!.title).toMatch(/USA 96 Good Trade \(1\d\d° off\)/);
    expect(start.notes.join(' ')).toContain('heading and TWA from the GPS course');
    // A race with only good compasses has no such chip.
    expect(legsTableKey(analyzeRace(j105Race(2))).chips.some((c) => /GPS course/.test(c.text))).toBe(false);
  });
});
