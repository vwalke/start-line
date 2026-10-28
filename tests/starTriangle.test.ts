import { describe, expect, it } from 'vitest';
import { analyzeRace, markLabel, markRole } from '../src/analysis/analyze';
import { len, sub, type Vec } from '../src/analysis/geo';
import { raceFinishes, recordsLine } from '../src/data/racesense/adapter';
import type { Finish } from '../src/data/racesense/types';
import { trackMap } from '../src/ui/charts';
import { coachRace, debriefOf, starFixture, starRace } from './helpers';

const fin = (sailNumber: string, raceNumber: number | null): Finish => ({ sailNumber, raceNumber, finishingTime: '2026-10-28T18:07:07Z' });
const at = (lon: number, lat: number): { coordinates: [number, number] } => ({ coordinates: [lon, lat] });
/** A record on the line at `lon` (the line runs ~70 m north–south there): 0.01° of longitude is ~1 km. */
const onLine = (f: Finish, lon: number): Finish => ({ ...f, lineLeftLocation: at(lon, 27.8965), lineRightLocation: at(lon, 27.8959) });

describe('finish records from another race', () => {
  // Race 3 finished on the line at −82.47, race 4 on the line at −82.455 (~1.5 km away).
  const race3 = { finishes: [onLine(fin('a', 3), -82.47), onLine(fin('d', 3), -82.47)] };

  it('drops a copy: another race number, that race’s line for the same sail, far from this race’s line', () => {
    const race4 = { finishes: [onLine(fin('a', 4), -82.455), onLine(fin('b', 4), -82.455), onLine(fin('c', 4), -82.455), onLine(fin('d', 3), -82.47)] };
    expect(raceFinishes(race4, [race3, race4]).map((f) => f.sailNumber)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a late boat whose device counts differently (no copy in another race), and one on this race’s line', () => {
    const late = { finishes: [onLine(fin('a', 4), -82.455), onLine(fin('b', 4), -82.455), onLine(fin('c', 4), -82.455), onLine(fin('e', 3), -82.47)] };
    expect(raceFinishes(late, [race3, late])).toHaveLength(4);
    // A device that kept another race's ends where the committee re-laid its line a few tens of metres away.
    const near = { finishes: [onLine(fin('a', 4), -82.4702), onLine(fin('b', 4), -82.4702), onLine(fin('d', 3), -82.47)] };
    expect(raceFinishes(near, [race3, near])).toHaveLength(3);
  });

  it('keeps the device’s offset race count, and 0 or no number (unknown)', () => {
    // J/105 race 2: every finish reads 3, one 0 (Good Trade's).
    const fins = [fin('a', 3), fin('b', 3), fin('c', 0), fin('d', null)];
    expect(raceFinishes({ finishes: fins })).toHaveLength(4);
  });

  it('keeps every record with no clear majority', () => {
    expect(raceFinishes({ finishes: [fin('a', 4), fin('b', 3)] })).toHaveLength(2);
    expect(raceFinishes({ finishes: [] })).toEqual([]);
  });

  it('Star NAs race 4: 8318’s record (race 3’s number and line) is not this race’s finish', () => {
    const doc = starFixture().regatta.revisions.at(-1)!.doc;
    const races = doc.divisions[0].races;
    const race = races.find((r) => r.raceNumber === 4)!;
    expect(race.finishes).toHaveLength(10);
    expect(raceFinishes(race, races).map((f) => f.sailNumber)).not.toContain('8318');
    expect(raceFinishes(race, races)).toHaveLength(9);
    const b = starRace().boats.find((x) => x.sail === '8318')!;
    expect(b.finishMs).toBeNull();
  });
});

describe('the finish records’ own line', () => {
  it('is the median of their ends', () => {
    const at = (lon: number, lat: number): { coordinates: [number, number] } => ({ coordinates: [lon, lat] });
    const fins: Finish[] = [1, 2, 3].map((k) => ({ ...fin(String(k), 4), lineLeftLocation: at(-82 + k * 1e-6, 27), lineRightLocation: at(-82.001, 27 + k * 1e-6) }));
    expect(recordsLine([...fins, fin('x', 4)])).toEqual({ left: { lat: 27, lon: -82 + 2e-6 }, right: { lat: 27 + 2e-6, lon: -82.001 } });
    expect(recordsLine([fin('x', 4)])).toBeNull();
  });
});

describe('mark roles from the legs into and out of a mark', () => {
  it('reads windward, leeward and reach marks', () => {
    expect(markRole('upwind', 'reach')).toBe('windward');
    expect(markRole('upwind', 'downwind')).toBe('windward');
    expect(markRole('reach', 'upwind')).toBe('leeward');
    expect(markRole('downwind', 'upwind')).toBe('leeward');
    expect(markRole('reach', 'reach')).toBe('reach');
    // A gybe between a reach and a run, or two beats: not clear.
    expect(markRole('reach', 'downwind')).toBeNull();
    expect(markRole('upwind', 'upwind')).toBeNull();
  });

  it('relabels only where the title names another role', () => {
    expect(markLabel('Leeward port', ['reach', 'reach'])).toBe('Reach mark');
    expect(markLabel('M2', ['reach'])).toBe('M2');
    expect(markLabel('Reach', ['windward'])).toBe('Windward mark');
    expect(markLabel('Wing', ['reach'])).toBe('Wing');
    expect(markLabel('Windward', ['windward', 'windward'])).toBe('Windward');
    expect(markLabel('Leeward', ['windward'])).toBe('Windward mark');
    expect(markLabel('Windward', ['leeward'])).toBe('Leeward mark');
    // A code says nothing the legs contradict; a mark rounded in two roles keeps its title.
    expect(markLabel('M1', ['windward'])).toBe('M1');
    expect(markLabel('Leeward port', ['reach', 'leeward'])).toBe('Leeward port');
    expect(markLabel('Leeward port', [null])).toBe('Leeward port');
  });
});

describe('Star NAs race 4: two Olympic triangles and a beat to a finish at windward', () => {
  const data = starRace();
  const a = analyzeRace(data);
  const gun = a.meta.gunMs;
  const min = (t: number | null | undefined): number => (t! - gun) / 60_000;

  it('has the finish line where the finish trackers were at the finishes (~76 m near windward), not across the course', () => {
    const fl = a.finishLine!;
    const length = len(sub(fl.left, fl.right));
    expect(length).toBeGreaterThan(60);
    expect(length).toBeLessThan(95);
    expect(length).toBeLessThan(150);
    const mid: Vec = [(fl.left[0] + fl.right[0]) / 2, (fl.left[1] + fl.right[1]) / 2];
    const windward = a.marks.find((m) => m.name === 'Windward')!;
    expect(len(sub(mid, windward.xy[0]))).toBeLessThan(200);
    // ~2 km from the start line.
    expect(len(sub(mid, [(a.line.left[0] + a.line.right[0]) / 2, (a.line.left[1] + a.line.right[1]) / 2]))).toBeGreaterThan(1500);
    expect(a.finishLineEstimated).toBeUndefined();
  });

  it('sails Beat 1, two reaches, Beat 2, two reaches and Beat 3 to the finish at windward', () => {
    expect(a.legSource).toBe('course');
    expect(a.legs.map((l) => l.name)).toEqual(['Beat 1', 'Reach 1', 'Reach 2', 'Beat 2', 'Reach 3', 'Reach 4', 'Beat 3']);
    expect(a.legs.map((l) => l.to)).toEqual(['Windward', 'Reach mark', 'Leeward mark', 'Windward', 'Reach mark', 'Leeward mark', 'Finish']);
  });

  it('times the leader’s roundings where its track turns', () => {
    const b = a.boats.find((x) => x.sail === '5618')!;
    expect(b.finishPos).toBe(1);
    const ends = b.legs.map((l) => min(l?.endMs));
    const want = [15.8, 23.5, 30, 47.7, 53.8, 61.3, 77.1];
    ends.forEach((t, i) => expect(Math.abs(t - want[i])).toBeLessThan(1.5));
  });

  it('labels the listed "Leeward port" the Reach mark (the feed’s title kept), and places the untracked leeward mark (est.) near the start', () => {
    const reach = a.marks.find((m) => m.name === 'Reach mark')!;
    expect(reach.title).toBe('Leeward port');
    expect(reach.estimated).toBeUndefined();
    const lee = a.marks.find((m) => m.estimated)!;
    expect(lee.name).toBe('Leeward mark');
    const startMid: Vec = [(a.line.left[0] + a.line.right[0]) / 2, (a.line.left[1] + a.line.right[1]) / 2];
    expect(len(sub(lee.xy[0], startMid))).toBeLessThan(300);
    expect(a.marks).toHaveLength(3);
    expect(a.notes.map((n) => n.kind)).toContain('marks-est');
    expect(a.notes.map((n) => n.kind)).not.toContain('legs-fleet');
  });

  it('draws "Finish" on its line and "Reach mark" with the feed’s name as its tooltip', () => {
    const svg = trackMap(a, null);
    expect(svg).toMatch(/<line class="finishline" [^>]*\/><text [^>]*class="lbl"[^>]*>Finish<\/text>/);
    expect(svg).not.toContain('finishline est');
    expect(svg).toContain('<title>Leeward port</title>Reach mark</text>');
    expect(svg).toContain('Leeward (est.)');
  });

  it('runs the Coach on the reaches: no run summaries, every boat’s debrief', () => {
    const r = coachRace(data);
    expect(r.m.course.kinds).toEqual(['upwind', 'reach', 'reach', 'upwind', 'reach', 'reach', 'upwind']);
    for (const b of r.a.boats) expect(() => debriefOf(r.a, r.m, b.id)).not.toThrow();
    const winner = r.a.boats.find((x) => x.sail === '5618')!;
    expect(winner.downwind).toBeNull();
    expect(winner.upwind).not.toBeNull();
  }, 60_000);
});
