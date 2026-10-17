import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { fixtureRace, loadExpected } from './helpers';

// Reproduces the Python prototype's benelux_act3_race8_metrics.csv from the
// trimmed fixture (competitors ~1 Hz away from the gun, so small drift is expected).
const analysis = analyzeRace(fixtureRace());
const expected = loadExpected();
const bySail = new Map(analysis.boats.map((b) => [b.sail, b]));

describe('Benelux Act III race 8 vs prototype CSV', () => {
  it('finds all six boats, four legs and the right course', () => {
    expect(analysis.boats).toHaveLength(6);
    expect(analysis.legs.map((l) => l.name)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(analysis.legs.map((l) => l.to)).toEqual(['M1', 'Gate', 'M1', 'Finish']);
    expect(analysis.wind.method).toBe('tacks');
  });

  it('reproduces the finish order exactly', () => {
    const order = expected.slice().sort((a, b) => +a.finish - +b.finish).map((r) => r.sail);
    expect(analysis.boats.map((b) => b.sail)).toEqual(order);
    for (const r of expected) expect(bySail.get(r.sail)!.finishPos).toBe(+r.finish);
  });

  it('estimates the wind close to the prototype (12° beat 1, 7° beat 2)', () => {
    const [b1, b2] = analysis.wind.estimates;
    expect(Math.abs(b1.twdDeg - 11.6)).toBeLessThan(3);
    expect(Math.abs(b2.twdDeg - 6.8)).toBeLessThan(3);
    expect(Math.abs(b1.tackAngleDeg - 72.6)).toBeLessThan(5);
  });

  it('finds the pin favoured by ~17 m on a 98 m line', () => {
    expect(analysis.line.favored).toBe('left');
    expect(analysis.line.lengthM).toBeCloseTo(97.8, 0);
    expect(Math.abs(analysis.line.favoredByM - 17)).toBeLessThan(3);
  });

  it('ends each start trail on the bow and points the arrow along COG', () => {
    for (const d of analysis.drawings) {
      expect(d.bow).not.toBeNull();
      expect(d.courseAtGun).not.toBeNull();
      expect(d.trail.x.length).toBeGreaterThan(5);
      const i = d.trail.x.length - 1;
      expect(d.trail.x[i]).toBeCloseTo(d.bow![0], 5);
      expect(d.trail.y[i]).toBeCloseTo(d.bow![1], 5);
    }
  });

  it('writes plain-English findings naming the best and worst starters', () => {
    const text = analysis.findings.map((f) => f.text).join('\n');
    expect(text).toMatch(/Best start: #6 and #4/);
    expect(text).toMatch(/Furthest back: #5/);
    expect(text).toMatch(/#3 lost \d+ s on Beat 1/);
  });

  it('samples DTL at the source offset before the gun', () => {
    const atGun = analyzeRace({ ...fixtureRace(), dtlSampleOffsetMs: 0 });
    for (const b of atGun.boats) {
      const s = bySail.get(b.sail)!.start!;
      // Every boat is moving toward the line, so 0.9 s earlier it is further back.
      expect(s.dtlM - b.start!.dtlM).toBeGreaterThan(0.3);
      expect(s.speedKn).toBe(b.start!.speedKn);
    }
  });

  for (const r of expected) {
    it(`start metrics for #${r.sail}`, () => {
      const s = bySail.get(r.sail)!.start!;
      // Our DTL, sampled at the device's start fix, agrees with the Vakaros figure.
      expect(Math.abs(s.dtlM - +r.dtl_rc_m)).toBeLessThan(0.5);
      expect(Math.abs(s.speedKn - +r.speed_at_gun_kn)).toBeLessThan(0.3);
      expect(Math.abs(s.twaDeg - +r.twa_at_gun)).toBeLessThan(6);
      expect(Math.abs(s.linePosPct - +r.line_pos_pct)).toBeLessThan(3);
      expect(Math.abs(s.secsLate - +r.secs_late)).toBeLessThan(1.5);
      expect(s.rcDtlM).toBeCloseTo(+r.dtl_rc_m, 1);
    });

    it(`leg metrics for #${r.sail}`, () => {
      const b = bySail.get(r.sail)!;
      for (let i = 0; i < 4; i++) {
        const leg = b.legs[i]!;
        expect(leg, `leg ${i + 1}`).not.toBeNull();
        expect(Math.abs(leg.timeS - +r[`L${i + 1}_time_s`]), `L${i + 1} time`).toBeLessThan(10);
        expect(Math.abs(leg.sogKn - +r[`L${i + 1}_sog_kn`]), `L${i + 1} sog`).toBeLessThan(0.3);
        expect(Math.abs(leg.vmgKn - +r[`L${i + 1}_vmg_kn`]), `L${i + 1} vmg`).toBeLessThan(0.3);
        expect(Math.abs(leg.twaDeg - +r[`L${i + 1}_twa`]), `L${i + 1} twa`).toBeLessThan(6);
      }
      expect(Math.abs(b.raceTimeS! - +r.race_time_s)).toBeLessThan(2);
      expect(Math.abs(b.sogAvgKn! - +r.sog_avg_kn)).toBeLessThan(0.3);
    });
  }
});
