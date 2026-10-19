import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { M_PER_NM, pathDistance } from '../src/analysis/distance';
import { SPAN_MS } from '../src/analysis/validity';
import { fM } from '../src/ui/format';
import { legsTable } from '../src/ui/table';
import { c31Race, fixtureRace } from './helpers';

/** A straight run east at `v` m/s with fixes at times `ts` (ms). */
function line(ts: number[], v = 5) {
  return { t: Float64Array.from(ts), x: Float64Array.from(ts.map((t) => (v * t) / 1000)), y: new Float64Array(ts.length) };
}
const every = (from: number, to: number, step: number): number[] => Array.from({ length: (to - from) / step + 1 }, (_, i) => from + i * step);

describe('pathDistance', () => {
  it('measures a straight line of known length in metres', () => {
    const { t, x, y } = line(every(0, 60_000, 1000));
    const d = pathDistance(t, x, y, 0, 60_000);
    expect(d.distM).toBeCloseTo(300, 9);
    expect(d.distGapS).toBeNull();
  });

  it('interpolates the end points between fixes', () => {
    const { t, x, y } = line(every(0, 60_000, 1000));
    expect(pathDistance(t, x, y, 500, 10_500).distM).toBeCloseTo(50, 9);
  });

  it('counts a zig-zag point to point, not end to end', () => {
    const t = Float64Array.from([0, 1000, 2000]);
    const x = Float64Array.from([0, 30, 60]);
    const y = Float64Array.from([0, 40, 0]);
    expect(pathDistance(t, x, y, 0, 2000).distM).toBeCloseTo(100, 9);
  });

  it('flags a hole longer than 5 s with its length', () => {
    expect(SPAN_MS).toBe(5000);
    const { t, x, y } = line([...every(0, 10_000, 1000), ...every(16_500, 30_000, 1000)]);
    const d = pathDistance(t, x, y, 0, 29_500);
    expect(d.distGapS).toBeCloseTo(6.5, 9);
    // Still measured, straight across the hole.
    expect(d.distM).toBeCloseTo(147.5, 6);
    // A leg that only touches the hole at one end still bridges it.
    expect(pathDistance(t, x, y, 12_000, 20_000).distGapS).toBeCloseTo(6.5, 9);
    // A leg entirely clear of it does not.
    expect(pathDistance(t, x, y, 17_000, 29_500).distGapS).toBeNull();
  });

  it('does not flag holes of 5 s or less, or one ending exactly at the leg start', () => {
    const five = line([...every(0, 10_000, 1000), ...every(15_000, 30_000, 1000)]);
    expect(pathDistance(five.t, five.x, five.y, 0, 30_000).distGapS).toBeNull();
    const four = line([...every(0, 10_000, 1000), ...every(14_000, 30_000, 1000)]);
    expect(pathDistance(four.t, four.x, four.y, 0, 30_000).distGapS).toBeNull();
    const hole = line([...every(0, 10_000, 1000), ...every(20_000, 30_000, 1000)]);
    expect(pathDistance(hole.t, hole.x, hole.y, 20_000, 30_000).distGapS).toBeNull();
    expect(pathDistance(hole.t, hole.x, hole.y, 0, 10_000).distGapS).toBeNull();
    expect(pathDistance(hole.t, hole.x, hole.y, 0, 10_001).distGapS).toBe(10);
  });

  it('flags time outside the track as a gap', () => {
    const { t, x, y } = line(every(10_000, 30_000, 1000));
    expect(pathDistance(t, x, y, 0, 30_000).distGapS).toBe(10);
  });
});

describe('distance sailed on the fixtures', () => {
  const a = analyzeRace(fixtureRace());

  it('Benelux race 8: plausible per-boat totals that equal the sum of the legs', () => {
    for (const b of a.boats) {
      const legs = b.legs.map((l) => l!);
      const sum = legs.reduce((s, l) => s + l.distM, 0);
      expect(b.distM).toBeGreaterThan(1.3 * M_PER_NM);
      expect(b.distM).toBeLessThan(2.2 * M_PER_NM);
      expect(b.distM!).toBeCloseTo(sum, 9);
      expect(b.distApprox).toBe(false);
      expect(legs.every((l) => l.distGapS == null)).toBe(true);
      // Same track, same clock: SOG is Dist ÷ time.
      expect(b.sogAvgKn!).toBeCloseTo(b.distM! / M_PER_NM / (b.raceTimeS! / 3600), 9);
      expect(b.legs.every((l) => l && Math.abs(l.sogKn - l.distM / M_PER_NM / (l.timeS / 3600)) < 1e-9)).toBe(true);
    }
  });

  it('shows whole metres, plain when exact', () => {
    const html = legsTable(a, null);
    const b = a.boats[0];
    expect(html).toContain(`>${fM(b.distM)}</td>`);
    expect(html).toContain(`>${fM(b.legs[0]!.distM)}</td>`);
  });

  it('C31 race 10: legs across telemetry holes are approximate (~ with a title), and so is the race', () => {
    const c = analyzeRace(c31Race());
    const b = c.boats.find((x) => x.sail === 'ITA 78')!;
    expect(b.legs.some((l) => l?.distGapS != null)).toBe(true);
    expect(b.distApprox).toBe(true);
    const html = legsTable(c, null);
    const leg = b.legs.find((l) => l?.distGapS != null)!;
    expect(html).toContain(`s telemetry gap in this leg. More than 5 s between GPS fixes; that stretch counts as a straight line.">~${fM(leg.distM)}</span>`);
    expect(html).toContain(`>~${fM(b.distM)}</span>`);
  });
});
