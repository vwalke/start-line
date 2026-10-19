import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { M_PER_NM } from '../src/analysis/distance';
import { kindSummary, placeSummaries } from '../src/analysis/summary';
import type { BoatResult, LegDef, LegKind, LegResult } from '../src/analysis/types';
import { fixtureRace } from './helpers';

const def = (index: number, kind: LegKind): LegDef => ({ index, kind, name: `${kind} ${index}`, to: 'M' });
const leg = (timeS: number, o: Partial<LegResult> = {}): LegResult => ({
  startMs: 0,
  endMs: timeS * 1000,
  timeS,
  sogKn: 6,
  vmgKn: 5,
  twaDeg: 40,
  rankAtEnd: null,
  distM: 1000,
  distGapS: null,
  tacks: 0,
  gybes: 0,
  manoeuvreGap: false,
  coverage: 1,
  maxGapS: 1,
  heelDeg: null,
  heelS: 0,
  trimDeg: null,
  heelCoverage: null,
  ...o,
});
const defs = [def(0, 'upwind'), def(1, 'downwind'), def(2, 'reach'), def(3, 'upwind')];

describe('kindSummary', () => {
  it('adds the legs of the kind, weighting VMG, TWA and coverage by time (not a plain mean)', () => {
    const legs = [
      leg(600, { vmgKn: 4, twaDeg: 40, distM: 2000, tacks: 3, coverage: 1, maxGapS: 2 }),
      leg(300, { vmgKn: 9, twaDeg: 150 }),
      leg(100, { vmgKn: 7, twaDeg: 90 }),
      leg(200, { vmgKn: 6, twaDeg: 48, distM: 800, tacks: 2, coverage: 0.5, maxGapS: 40, distGapS: 40, manoeuvreGap: true }),
    ];
    const s = kindSummary(legs, defs, 'upwind')!;
    expect(s).toMatchObject({ legs: 2, of: 2, complete: true, timeS: 800, distM: 2800, tacks: 5, gybes: 0, distApprox: true, manoeuvreApprox: true, maxGapS: 40, place: null });
    expect(s.vmgKn).toBeCloseTo((4 * 600 + 6 * 200) / 800, 9); // 4.5, not the plain mean 5
    expect(s.twaDeg).toBeCloseTo((40 * 600 + 48 * 200) / 800, 9);
    expect(s.coverage).toBeCloseTo((600 + 0.5 * 200) / 800, 9);
    expect(s.sogKn).toBeCloseTo(2800 / M_PER_NM / (800 / 3600), 9);
  });

  it('pools heel over the fixes it rests on, and weights trim and heel coverage by leg time', () => {
    const legs = [
      leg(600, { heelDeg: 10, heelS: 500, trimDeg: 2, heelCoverage: 1 }),
      leg(300, { heelDeg: -3, heelS: 300 }),
      leg(100),
      leg(200, { heelDeg: 20, heelS: 100, trimDeg: 4, heelCoverage: 0.5 }),
    ];
    const s = kindSummary(legs, defs, 'upwind')!;
    expect(s.heelDeg).toBeCloseTo((10 * 500 + 20 * 100) / 600, 9); // 11.67, not the leg-time mean 12.5
    expect(s.trimDeg).toBeCloseTo((2 * 600 + 4 * 200) / 800, 9);
    expect(s.heelCoverage).toBeCloseTo((600 + 0.5 * 200) / 800, 9);
    expect(kindSummary(legs, defs, 'downwind')!.heelDeg).toBe(-3);
    // A leg with no heel is left out, not counted as 0; with none at all, null.
    expect(kindSummary([leg(600, { heelDeg: 12, heelS: 400, heelCoverage: 0.8 }), null, null, leg(200)], defs, 'upwind')).toMatchObject({ heelDeg: 12, heelCoverage: 0.8 });
    expect(kindSummary([leg(600), null, null, leg(200)], defs, 'upwind')).toMatchObject({ heelDeg: null, trimDeg: null, heelCoverage: null });
  });

  it('leaves reaches out of both', () => {
    const legs = [leg(600), leg(300, { twaDeg: 150 }), leg(100, { twaDeg: 90 }), leg(200)];
    expect(kindSummary(legs, defs, 'downwind')).toMatchObject({ legs: 1, of: 1, timeS: 300, twaDeg: 150 });
    expect(kindSummary(legs, defs, 'upwind')!.timeS).toBe(800);
  });

  it('flags a boat missing a leg of the kind as incomplete, and is null with none', () => {
    expect(kindSummary([leg(600), leg(300), leg(100), null], defs, 'upwind')).toMatchObject({ legs: 1, of: 2, complete: false, timeS: 600 });
    expect(kindSummary([null, leg(300), leg(100), null], defs, 'upwind')).toBeNull();
    expect(kindSummary([leg(600)], [def(0, 'upwind')], 'downwind')).toBeNull();
  });
});

describe('placeSummaries', () => {
  const boat = (id: string, up: number | null, complete = true): BoatResult =>
    ({ id, upwind: up == null ? null : { ...kindSummary([leg(up)], [def(0, 'upwind')], 'upwind')!, complete } }) as BoatResult;

  it('ranks complete summaries by total time, ties sharing a place, incomplete unplaced', () => {
    const bs = [boat('a', 700), boat('b', 600), boat('c', 700), boat('d', 650, false), boat('e', null), boat('f', 800)];
    placeSummaries(bs, 'upwind');
    expect(bs.map((b) => b.upwind?.place ?? null)).toEqual([2, 1, 2, null, null, 4]);
  });
});

describe('upwind / downwind on the Benelux fixture', () => {
  const a = analyzeRace(fixtureRace());

  it('sums Beat 1 + Beat 2 and Run 1 + Run 2, placed by total time', () => {
    for (const b of a.boats) {
      const [b1, r1, b2, r2] = b.legs.map((l) => l!);
      expect(b.upwind).toMatchObject({ legs: 2, of: 2, complete: true, tacks: b1.tacks + b2.tacks, gybes: b1.gybes + b2.gybes });
      expect(b.upwind!.timeS).toBeCloseTo(b1.timeS + b2.timeS, 9);
      expect(b.upwind!.distM).toBeCloseTo(b1.distM + b2.distM, 9);
      expect(b.upwind!.vmgKn).toBeCloseTo((b1.vmgKn * b1.timeS + b2.vmgKn * b2.timeS) / (b1.timeS + b2.timeS), 9);
      expect(b.downwind!.timeS).toBeCloseTo(r1.timeS + r2.timeS, 9);
    }
    const order = [...a.boats].sort((x, y) => x.upwind!.timeS - y.upwind!.timeS);
    expect(order.map((b) => b.upwind!.place)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(a.boats.find((b) => b.sail === '4')!.upwind!.place).toBe(1);
  });
});
