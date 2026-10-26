import { describe, expect, it } from 'vitest';
import { rivalLadder, type CoachModel, type RivalLadder } from '../src/analysis/coach';
import type { RaceAnalysis } from '../src/analysis/types';
import { COACH_BULLETS, ladderChart, ladderChips, ladderRuns } from '../src/ui/coach';
import { coachRace, j105Race } from './helpers';

/**
 * Gap to rivals (ui/coach.ts ladderChart): every line runs straight on across any stretch without values (no breaks,
 * no gray "no data" bands, no "no data" chip). Display only: the series the cards read is untouched.
 */
const pt = (s: number, v: number | null, each: (number | null)[]) => ({ tMs: s * 1000, behindS: v, n: 2, est: 0, each, leg: 0 });
const a = {
  meta: { gunMs: 0, tzOffsetMs: 0 },
  legs: [{ index: 0, name: 'Beat 1', kind: 'upwind', to: 'Mark 1' }],
  boats: [
    { id: 'me', sail: 'USA 1', name: '#USA 1' },
    { id: 'r', sail: 'USA 2', name: '#USA 2' },
    { id: 'q', sail: 'USA 3', name: '#USA 3' },
  ],
} as unknown as RaceAnalysis;
const m = { wind: { twdAt: () => 0, t: [0, 60_000, 120_000], ok: [true, true, true] } } as unknown as CoachModel;
const lad = (points: ReturnType<typeof pt>[]): RivalLadder => ({ boat: 'me', group: ['r', 'q'], points, roundings: [], hole: null }) as unknown as RivalLadder;
const pathOf = (svg: string, cls: string): string => svg.match(new RegExp(`class="${cls}"[^>]*d="([^"]*)"`))![1];
const moves = (d: string): number => (d.match(/M/g) ?? []).length;

describe('Gap to rivals: every line runs straight on across any stretch without values', () => {
  // Points every 5 s. The bold line misses 10 s (one point) and later 25–50 s (values 35 s apart);
  // r misses one point, q 20–50 s (values 40 s apart).
  const points = [
    pt(0, 3, [2, 4]),
    pt(5, 3, [2, 4]),
    pt(10, null, [null, 4]),
    pt(15, 4, [2, 4]),
    pt(20, 4, [2, null]),
    ...[25, 30, 35, 40, 45, 50].map((t) => pt(t, null, [2, null])),
    pt(55, 5, [2, 4]),
    pt(60, 5, [2, 4]),
  ];

  it('ladderRuns: one run through every value, however far apart', () => {
    expect(ladderRuns(points, (i) => points[i].behindS)).toEqual([[0, 1, 3, 4, 11, 12]]);
    const at = (ts: number[]) => ts.map((t) => ({ tMs: t }));
    const gapAt1 = (i: number): number | null => (i === 1 ? null : 1);
    expect(ladderRuns(at([0, 15_000, 30_000]), gapAt1)).toEqual([[0, 2]]);
    expect(ladderRuns(at([0, 15_000, 3_600_000]), gapAt1)).toEqual([[0, 2]]);
  });

  it('the chart: the bold line and each thin line are one stroke each; no bands, no "no data" chip', () => {
    const svg = ladderChart(a, m, lad(points), { kind: 'leaders' }, { widthPx: 720 });
    expect(svg).not.toContain('cl-nodata');
    expect(moves(pathOf(svg, 'cl-med'))).toBe(1);
    expect(moves(pathOf(svg, 'cl-each" data-boat="r'))).toBe(1);
    expect(moves(pathOf(svg, 'cl-each" data-boat="q'))).toBe(1);
    expect(ladderChips(a, lad(points), { kind: 'leaders' }, true).some((c) => c.text === 'no data' || c.swatch === 'band')).toBe(false);
  });

  it('the wind strip: the estimated stretch is the same line (class cl-wind est), the ⓘ says it is lighter and nothing about breaks', () => {
    const svg = ladderChart(a, { wind: { twdAt: () => 0, t: [0, 60_000, 120_000], ok: [true, false, true] } } as unknown as CoachModel, lad(points), { kind: 'leaders' });
    expect(svg).toMatch(/<path class="cl-wind est" d="M[^"]+"\/>/);
    const text = COACH_BULLETS.join(' ');
    expect(text).toContain('lighter where estimated between minutes');
    expect(text).not.toMatch(/break|left blank|gray band|dotted/i);
  });

  it('on a real race (J/105 CBC race 3, USA 96): no bands, and the series the cards read is unchanged by drawing', () => {
    const { a: ra, m: rm } = coachRace(j105Race(3));
    const l = rivalLadder(rm, ra, 'USA 96', { kind: 'leaders' })!;
    const before = structuredClone(l.points);
    const svg = ladderChart(ra, rm, l, { kind: 'leaders' }, { widthPx: 900 });
    expect(svg).not.toContain('cl-nodata');
    expect(l.points).toEqual(before);
    expect(rivalLadder(rm, ra, 'USA 96', { kind: 'leaders' })!.points).toEqual(before);
  });
});
