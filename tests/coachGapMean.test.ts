/**
 * The gap chart's bold group line: the mean of the group boats with a value at a point when there are
 * GROUP_MEAN_MAX_BOATS (5) or fewer, their median when there are more (Fall Brawl J/70 race 3, official results).
 */
import { describe, expect, it } from 'vitest';
import { rivalLadder } from '../src/analysis/coach';
import { groupIds } from '../src/analysis/coach/groups';
import { GROUP_MEAN_MAX_BOATS, groupStat, groupStatKind } from '../src/analysis/coach/timeGap';
import { median } from '../src/analysis/geo';
import { boatsCount, ladderChips, ladderStatLabel } from '../src/ui/coach';
import { coachRace, fallbrawlOfficial, fallbrawlRace } from './helpers';

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

describe('groupStat / groupStatKind', () => {
  it('the mean for 5 boats or fewer, the median for more', () => {
    expect(GROUP_MEAN_MAX_BOATS).toBe(5);
    expect([1, 3, 5].map(groupStatKind)).toEqual(['mean', 'mean', 'mean']);
    expect([6, 7, 20].map(groupStatKind)).toEqual(['median', 'median', 'median']);
    expect(groupStat([1, 2, 6])).toBe(3);
    expect(groupStat([0, 0, 0, 0, 10])).toBe(2);
    // Asymmetric: the mean and median differ.
    expect(groupStat([0, 1, 2, 3, 4, 50])).toBe(2.5);
    expect(groupStat([0, 1, 2, 3, 4, 50, 60])).toBe(3);
    expect(groupStat([0, 1, 50])).toBeCloseTo(17, 12);
    expect(median([0, 1, 50])).toBe(1);
  });

  it('the same boats in any order give the very same value', () => {
    const xs = [0.1, 14.7008337402, -3.3, 7.25, 0.07];
    expect(groupStat([...xs].reverse())).toBe(groupStat(xs));
    expect(groupStat([xs[2], xs[0], xs[4], xs[1], xs[3]])).toBe(groupStat(xs));
  });
});

describe('Coach gap chart: the group line on Fall Brawl J/70 race 3', () => {
  const { a, m } = coachRace(fallbrawlRace('j70r3', fallbrawlOfficial('j70r3')));
  const me = a.boats.find((b) => b.finishPos === 3)!;
  const drawn = <T extends { behindS: number | null }>(ps: T[]): T[] => ps.filter((p) => p.behindS != null);

  it('Top 3: the mean of the three rivals, and seldom on a single rival\'s thin line', () => {
    const l = rivalLadder(m, a, me.id, { kind: 'leaders' })!;
    expect(l.group).toHaveLength(3);
    const pts = drawn(l.points);
    expect(pts.length).toBeGreaterThan(100);
    expect(pts.every((p) => p.n <= 3 && groupStatKind(p.n) === 'mean')).toBe(true);
    // Where all three are read as positions are (no bridged boat), the group's readings are the thin lines'.
    const full = pts.filter((p) => p.n === 3 && !p.est && p.each.every((e) => e != null));
    expect(full.length).toBeGreaterThan(pts.length / 2);
    for (const p of full) expect(p.behindS!).toBeCloseTo(mean(p.each as number[]), 9);
    const onOne = pts.filter((p) => p.each.some((e) => e === p.behindS)).length;
    expect(onOne).toBeLessThan(pts.length / 10);
  });

  it('Whole fleet: the median where more than 5 boats have a value', () => {
    const l = rivalLadder(m, a, me.id, { kind: 'fleet' })!;
    expect(l.group.length).toBeGreaterThan(GROUP_MEAN_MAX_BOATS);
    const big = drawn(l.points).filter((p) => p.n > GROUP_MEAN_MAX_BOATS);
    expect(big.length).toBeGreaterThan(100);
    // Where nobody is bridged, the median of the thin lines (the boats with a value there).
    const full = big.filter((p) => !p.est && p.each.filter((e) => e != null).length === p.n);
    expect(full.length).toBeGreaterThan(0);
    for (const p of full) expect(p.behindS!).toBe(median(p.each.filter((e): e is number => e != null)));
  });

  it('a Custom group of 5: the mean where all 5 have a value', () => {
    const ids = groupIds(a.boats, me.id, { kind: 'fleet' }).slice(0, 5);
    const g = { kind: 'custom', ids } as const;
    const l = rivalLadder(m, a, me.id, g)!;
    expect(l.group).toHaveLength(5);
    const five = drawn(l.points).filter((p) => p.n === 5);
    expect(five.length).toBeGreaterThan(100);
    const full = five.filter((p) => !p.est && p.each.every((e) => e != null));
    expect(full.length).toBeGreaterThan(0);
    for (const p of full) expect(p.behindS!).toBeCloseTo(mean(p.each as number[]), 9);
    expect(full.some((p) => Math.abs(p.behindS! - median(p.each as number[])) > 0.5)).toBe(true);
  });

  it('the legend names the statistic the drawn points use', () => {
    const top = rivalLadder(m, a, me.id, { kind: 'leaders' })!;
    const [chip] = ladderChips(a, top, { kind: 'leaders' }, true);
    expect(chip.text).toBe(`#${me.sail} vs top 3 (mean)`);
    expect(chip.title).toBe('The mean of the boats with data when there are 5 or fewer, the median when there are more');
    const fleet = rivalLadder(m, a, me.id, { kind: 'fleet' })!;
    const kinds = new Set(drawn(fleet.points).map((p) => groupStatKind(p.n)));
    const want = kinds.size > 1 ? 'mean / median' : [...kinds][0];
    expect(ladderStatLabel(fleet.points, fleet.group.length)).toBe(want);
    expect(ladderChips(a, fleet, { kind: 'fleet' }, false)[0].text).toMatch(new RegExp(`^#${me.sail} vs .+ \\(${want}\\)$`));
    // 16 boats with data at every drawn point.
    expect(ladderChips(a, fleet, { kind: 'fleet' }, false)[0].text).toBe(`#${me.sail} vs fleet (median)`);
    expect(ladderStatLabel([{ n: 3, behindS: 1 }, { n: 8, behindS: 2 }, { n: 4, behindS: null }], 8)).toBe('mean / median');
    expect(ladderStatLabel([{ n: 8, behindS: null }], 8)).toBe('median');
    expect(ladderStatLabel([], 3)).toBe('mean');
  });

  it('the readout says which statistic a point uses', () => {
    expect(boatsCount({ n: 3, est: 0 })).toBe('mean of 3 boats');
    expect(boatsCount({ n: 8, est: 2 })).toBe('median of 8 boats, 2 estimated');
  });
});
