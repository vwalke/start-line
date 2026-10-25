/**
 * The gap chart's y scale (Fall Brawl J/70 race 3, official results, the boat that finished 3rd): with the thin lines on
 * and GROUP_MEAN_MAX_BOATS or fewer boats it fits every line; with more it follows the group line plus EACH_HEADROOM
 * and marks a clipped thin line at the panel's edge; with the thin lines off it follows the group line alone.
 */
import { describe, expect, it } from 'vitest';
import { rivalLadder, type RivalLadder } from '../src/analysis/coach';
import { GROUP_MEAN_MAX_BOATS } from '../src/analysis/coach/timeGap';
import { EACH_HEADROOM, ladderChart, ladderLayout } from '../src/ui/coach';
import { coachRace, fallbrawlOfficial, fallbrawlRace } from './helpers';

describe('Coach gap chart: the y scale', () => {
  const { a, m } = coachRace(fallbrawlRace('j70r3', fallbrawlOfficial('j70r3')));
  const me = a.boats.find((b) => b.finishPos === 3)!;
  const gun = a.meta.gunMs;
  const top3 = rivalLadder(m, a, me.id, { kind: 'leaders' })!;
  const fleet = rivalLadder(m, a, me.id, { kind: 'fleet' })!;
  const ahead = (l: RivalLadder): { ref: number[]; own: number[] } => ({
    ref: [0, ...l.points.filter((p) => p.behindS != null).map((p) => -p.behindS!)],
    own: l.points.flatMap((p) => p.each.filter((e): e is number => e != null).map((e) => -e)),
  });

  it('Top 3, thin lines on: every line fits, padded, on round ticks', () => {
    expect(top3.group.length).toBeLessThanOrEqual(GROUP_MEAN_MAX_BOATS);
    const L = ladderLayout(top3, m.wind, gun, 900, true);
    const { ref, own } = ahead(top3);
    const all = [...ref, ...own];
    const hi = Math.max(...all);
    const lo = Math.min(...all);
    // The rivals reach past the group line, so this is the case that clipped before.
    expect(hi > Math.max(...ref) || lo < Math.min(...ref)).toBe(true);
    expect(L.hi).toBeGreaterThanOrEqual(hi + 3);
    expect(L.lo).toBeLessThanOrEqual(lo - 3);
    expect([5, 10, 15, 30, 60, 120, 300, 600]).toContain(L.sStep);
    expect(Math.abs(L.hi % L.sStep)).toBe(0);
    expect(Math.abs(L.lo % L.sStep)).toBe(0);
    expect(ladderChart(a, m, top3, { kind: 'leaders' }, { widthPx: 900, each: true })).not.toContain('cl-clip-mark');
  });

  it('Top 3, thin lines off: the group line alone sets the scale', () => {
    const blank: RivalLadder = { ...top3, points: top3.points.map((p) => ({ ...p, each: p.each.map(() => null) })) };
    const strip = ({ hi, lo, sStep }: { hi: number; lo: number; sStep: number }) => ({ hi, lo, sStep });
    const off = ladderLayout(top3, m.wind, gun, 900, false);
    expect(strip(off)).toEqual(strip(ladderLayout(blank, m.wind, gun, 900, false)));
    expect(strip(off)).toEqual(strip(ladderLayout(blank, m.wind, gun, 900, true)));
    const { ref } = ahead(top3);
    expect(off.hi - off.sStep).toBeLessThan(Math.max(...ref));
    expect(off.lo + off.sStep).toBeGreaterThan(Math.min(...ref));
  });

  describe('Whole fleet (more than 5 boats), thin lines on', () => {
    // Every thin line on the group line, then one rival 5000 s ahead for a stretch.
    const calm: RivalLadder = { ...fleet, points: fleet.points.map((p) => ({ ...p, each: p.each.map((e) => (e == null ? null : p.behindS)) })) };
    const drawn = calm.points.map((p, i) => (p.behindS != null && p.each[0] != null ? i : -1)).filter((i) => i >= 0);
    const from = drawn[Math.floor(drawn.length / 3)];
    const wild: RivalLadder = {
      ...calm,
      points: calm.points.map((p, i) => (i >= from && i < from + 20 && p.each[0] != null ? { ...p, each: [p.each[0] - 5000, ...p.each.slice(1)] } : p)),
    };

    it('the scale follows the group line plus EACH_HEADROOM; an outlier does not stretch it', () => {
      expect(fleet.group.length).toBeGreaterThan(GROUP_MEAN_MAX_BOATS);
      const { ref } = ahead(wild);
      const mHi = Math.max(...ref);
      const mLo = Math.min(...ref);
      const room = EACH_HEADROOM * Math.max(mHi - mLo, 60);
      const L = ladderLayout(wild, m.wind, gun, 900, true);
      expect(L.hi).toBeLessThanOrEqual(mHi + room + L.sStep);
      expect(L.hi).toBeGreaterThanOrEqual(mHi + room);
      expect(L.lo).toBeLessThanOrEqual(mLo);
      expect(L.lo).toBeGreaterThanOrEqual(mLo - room - L.sStep);
    });

    it('a clipped thin line gets an edge marker in its colour; no clipping, no markers', () => {
      const svg = ladderChart(a, m, wild, { kind: 'fleet' }, { widthPx: 900, each: true });
      const marks = [...svg.matchAll(/<path class="cl-clip-mark" data-boat="([^"]+)" d="[^"]*L([\d.]+) ([\d.]+)Z" fill="([^"]+)"/g)];
      expect(marks.map((x) => x[1])).toEqual([wild.group[0]]);
      expect(marks[0][4]).toBe('var(--s1)');
      // At the top edge, where the line crosses out, between the point before the jump and the first one past it.
      const L = ladderLayout(wild, m.wind, gun, 900, true);
      expect(Number(marks[0][3])).toBe(L.padT);
      expect(Number(marks[0][2])).toBeGreaterThanOrEqual(L.x(wild.points[from - 1].tMs) - 0.1);
      expect(Number(marks[0][2])).toBeLessThanOrEqual(L.x(wild.points[from].tMs) + 0.1);
      expect(ladderChart(a, m, calm, { kind: 'fleet' }, { widthPx: 900, each: true })).not.toContain('cl-clip-mark');
      expect(ladderChart(a, m, wild, { kind: 'fleet' }, { widthPx: 900, each: false })).not.toContain('cl-clip-mark');
    });
  });
});
