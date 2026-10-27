import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { RaceAnalysis } from '../src/analysis/types';
import { trackMap } from '../src/ui/charts';
import { textWidth } from '../src/ui/labels';
import { fixtureRace } from './helpers';

/** Benelux J70 race 8 with its marks replaced by "Mark 1" and "Mark 1a", `dx` m apart across the map (wind from 0°: x is across). */
function twoMarks(dx: number, dy = 0): { svg: string; unit: number; k: number } {
  const a0 = analyzeRace(fixtureRace());
  const p = a0.marks[0].xy[0];
  const a: RaceAnalysis = {
    ...a0,
    wind: { ...a0.wind, twdAtGunDeg: 0 },
    marks: [
      { name: 'Mark 1', xy: [p] },
      { name: 'Mark 1a', xy: [[p[0] + dx, p[1] + dy]] },
    ],
  };
  const svg = trackMap(a, null);
  const r = Number(svg.match(/<circle class="mark" cx="[^"]*" cy="[^"]*" r="([^"]+)"/)![1]);
  const fs = Number(svg.match(/<text x="[^"]*" y="[^"]*" font-size="([^"]+)" class="lbl"/)![1]);
  return { svg, unit: r / 5.5, k: fs / 12 };
}
const labels = (svg: string): string[] => [...svg.matchAll(/class="lbl">([^<]*)</g)].map((m) => m[1]);

describe('track map mark labels', () => {
  it("skips a label whose text would overlap an earlier one, though their anchors are apart", () => {
    const { unit, k } = twoMarks(0);
    // Further apart than the old 22-unit anchor check, closer than "Mark 1" is wide.
    const dx = 30 * unit;
    expect(dx).toBeLessThan(textWidth('Mark 1', 12 * k));
    const { svg } = twoMarks(dx);
    expect(labels(svg)).toEqual(['Mark 1']);
    expect(svg.match(/<circle class="mark"/g)).toHaveLength(2);
  });

  it('draws both when they are apart', () => {
    const { unit } = twoMarks(0);
    expect(labels(twoMarks(0, 200 * unit).svg)).toEqual(['Mark 1', 'Mark 1a']);
  });
});
