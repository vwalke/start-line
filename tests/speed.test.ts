import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { legRanks, overallRanks, raceLegRanks } from '../src/analysis/speedRank';
import type { BoatResult, LegResult } from '../src/analysis/types';
import { legColor, trackMap } from '../src/ui/charts';
import { colourControls, parseRankBy, parseTrackColour, readPref, SPEED_RANGE, speedColor, speedKey, viridis, writePref } from '../src/ui/speed';
import { fixtureRace } from './helpers';

const leg = (timeS: number, distGapS: number | null = null): LegResult => ({
  startMs: 0,
  endMs: timeS * 1000,
  timeS,
  sogKn: 6,
  vmgKn: 5,
  twaDeg: 40,
  rankAtEnd: null,
  distNm: 1,
  distGapS,
});

const boat = (id: string, legs: (LegResult | null)[], raceTimeS: number | null = null, finishPos: number | null = null): BoatResult => ({
  id,
  sail: id,
  name: `#${id}`,
  colorSlot: 0,
  finishPos,
  finishMs: null,
  raceTimeS,
  sogAvgKn: null,
  distNm: null,
  distApprox: false,
  start: null,
  legs,
});

describe('leg ranking', () => {
  const boats = [
    boat('a', [leg(400), leg(300)]),
    boat('b', [leg(380), null]),
    boat('c', [leg(420, 12), leg(310)]),
    boat('d', [leg(400), leg(NaN)]),
    boat('e', [null, leg(290)]),
  ];

  it('orders by leg time, fastest first, ties share a rank (1, 2, 2, 4)', () => {
    const r = legRanks(boats, 0);
    expect([...r.keys()]).toEqual(['b', 'a', 'd', 'c']);
    expect(['b', 'a', 'd', 'c'].map((id) => r.get(id)!.rank)).toEqual([1, 2, 2, 4]);
    expect(r.get('a')!.of).toBe(4);
    expect(r.get('a')!.timeS).toBe(400);
  });

  it('normalizes t by rank: 0 fastest, 1 slowest', () => {
    const r = legRanks(boats, 0);
    expect(r.get('b')!.t).toBe(0);
    expect(r.get('a')!.t).toBeCloseTo(1 / 3);
    expect(r.get('d')!.t).toBeCloseTo(1 / 3);
    expect(r.get('c')!.t).toBe(1);
  });

  it('leaves out boats that did not complete the leg (null or non-finite time)', () => {
    const r = legRanks(boats, 1);
    expect([...r.keys()]).toEqual(['e', 'a', 'c']);
    expect(r.has('b')).toBe(false);
    expect(r.has('d')).toBe(false);
    expect(legRanks(boats, 0).has('e')).toBe(false);
    expect(legRanks(boats, 7).size).toBe(0);
  });

  it('flags a leg time that spans a telemetry gap (> 5 s, as the table ~)', () => {
    const r = legRanks(boats, 0);
    expect(r.get('c')!.gapS).toBe(12);
    expect(r.get('a')!.gapS).toBeNull();
  });

  it('gives a lone boat t = 0', () => {
    const r = legRanks([boat('x', [leg(100)])], 0);
    expect(r.get('x')).toMatchObject({ rank: 1, of: 1, t: 0 });
  });

  it('ranks each leg separately for the whole race', () => {
    const per = raceLegRanks(boats, 2);
    expect(per).toHaveLength(2);
    expect(per[0].get('b')!.rank).toBe(1);
    expect(per[1].get('e')!.rank).toBe(1);
    expect(per[1].get('a')!.rank).toBe(2);
  });
});

describe('overall ranking', () => {
  it('ranks finishers by race time and leaves non-finishers out', () => {
    const r = overallRanks([
      boat('a', [leg(400, 8), leg(300)], 700, 2),
      boat('b', [leg(380), leg(310)], 690, 1),
      boat('c', [leg(420), null], null, null),
    ]);
    expect([...r.keys()]).toEqual(['b', 'a']);
    expect(r.get('b')).toMatchObject({ rank: 1, of: 2, t: 0, timeS: 690 });
    expect(r.get('a')).toMatchObject({ rank: 2, t: 1, gapS: 8 });
    expect(r.has('c')).toBe(false);
  });

  it('falls back to finish position when a finisher has no race time', () => {
    const r = overallRanks([boat('a', [], 700, 2), boat('b', [], null, 1), boat('c', [], null, null)]);
    expect([...r.keys()]).toEqual(['b', 'a']);
    expect(Number.isNaN(r.get('b')!.timeS)).toBe(true);
    expect(r.has('c')).toBe(false);
  });
});

describe('speed colour scale', () => {
  it('hits the viridis ends and clamps out-of-range input', () => {
    expect(viridis(0)).toBe('#440154');
    expect(viridis(1)).toBe('#fde725');
    expect(viridis(0.5)).toBe('#21918c');
    expect(viridis(-3)).toBe('#440154');
    expect(viridis(9)).toBe('#fde725');
    expect(viridis(NaN)).toBe('#440154');
  });

  it('outputs #rrggbb', () => {
    for (let t = 0; t <= 1; t += 0.05) {
      expect(viridis(t)).toMatch(/^#[0-9a-f]{6}$/);
      expect(speedColor(t)).toMatch(/^#[0-9a-f]{6}$/);
      expect(speedColor(t, 'dark')).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('puts the fastest at the bright end of each scheme slice', () => {
    expect(speedColor(0, 'light')).toBe(viridis(SPEED_RANGE.light[1]));
    expect(speedColor(1, 'light')).toBe(viridis(SPEED_RANGE.light[0]));
    expect(speedColor(0, 'dark')).toBe('#fde725');
    expect(speedColor(1, 'dark')).toBe(viridis(0.25));
    expect(speedColor(-1)).toBe(speedColor(0));
    expect(speedColor(2)).toBe(speedColor(1));
  });

  it('gets monotonically darker from fastest to slowest', () => {
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const scheme of ['light', 'dark'] as const) {
      let prev = Infinity;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const l = lum(speedColor(t, scheme));
        expect(l).toBeLessThanOrEqual(prev + 1e-9);
        prev = l;
      }
    }
  });
});

describe('colour preference', () => {
  it('parses stored values, defaulting to Leg / Each leg', () => {
    expect(parseTrackColour('speed')).toBe('speed');
    expect(parseTrackColour('leg')).toBe('leg');
    for (const bad of [null, undefined, '', 'Speed', 'rainbow', '{}']) expect(parseTrackColour(bad)).toBe('leg');
    expect(parseRankBy('overall')).toBe('overall');
    for (const bad of [null, undefined, '', 'OVERALL', 'x']) expect(parseRankBy(bad)).toBe('leg');
  });

  it('survives storage that throws', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(readPref('recall.trackColour')).toBeNull();
      expect(() => writePref('recall.trackColour', 'speed')).not.toThrow();
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('renders accessible toggle buttons; Rank by only for the whole race in Speed', () => {
    const leg = colourControls('leg', 'leg', null);
    expect(leg).toContain('data-colour="leg" aria-pressed="true"');
    expect(leg).toContain('data-colour="speed" aria-pressed="false"');
    expect(leg).not.toContain('data-rank');
    expect(colourControls('speed', 'overall', null)).toContain('data-rank="overall" aria-pressed="true"');
    expect(colourControls('speed', 'leg', 1)).not.toContain('data-rank');
  });
});

describe('track map in Speed', () => {
  const a = analyzeRace(fixtureRace());
  const polylines = (svg: string): string[] => [...svg.matchAll(/<polyline class="trk[^"]*"[^>]*>[\s\S]*?<\/polyline>/g)].map((m) => m[0]);
  const width = (p: string): number => Number(/ stroke-width="([\d.]+)"/.exec(p)![1]);

  it('leaves the Leg colouring as it was, with a boat · leg tooltip', () => {
    const svg = trackMap(a, null, 1);
    expect(svg).toBe(trackMap(a, null, 1, { colour: 'leg' }));
    const ps = polylines(svg);
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every((p) => p.includes(`stroke="${legColor(1)}"`) && p.startsWith('<polyline class="trk"'))).toBe(true);
    expect(svg).not.toContain('spd');
    expect(ps[0]).toMatch(/<title>#\S+.* · .+<\/title>/);
  });

  it('colours one leg by rank with viridis, fastest on top, top 3 thicker', () => {
    const svg = trackMap(a, null, 1, { colour: 'speed' });
    const ps = polylines(svg).filter((p) => !p.includes('unranked'));
    expect(ps.length).toBeGreaterThan(3);
    expect(svg).not.toMatch(/stroke="var\(--s\d\)"/);
    expect(ps.every((p) => /stroke="#[0-9a-f]{6}" style="--cd:#[0-9a-f]{6}"/.test(p))).toBe(true);
    // Drawn slowest → fastest: the last one is #1, coloured as the fastest.
    const last = ps[ps.length - 1];
    expect(last).toMatch(/<title>[^<]*#1 of \d+/);
    expect(last).toContain(`stroke="${speedColor(0)}"`);
    const top = ps.filter((p) => p.includes(' top'));
    const rest = ps.filter((p) => !p.includes(' top'));
    expect(top.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...top.map(width))).toBeGreaterThan(Math.max(...rest.map(width)));
    expect(svg).toContain('aria-label="Tracks on');
  });

  it('draws boats that did not complete a leg grey, dashed and underneath', () => {
    const victim = a.boats[0].id;
    const cut = { ...a, boats: a.boats.map((b) => (b.id === victim ? { ...b, legs: b.legs.map((l, i) => (i === 1 ? null : l)) } : b)) };
    const svg = trackMap(cut, null, 1, { colour: 'speed' });
    const ps = polylines(svg);
    const un = ps.filter((p) => p.includes(`data-id="${victim}"`));
    expect(un.length).toBeGreaterThan(0);
    expect(un.every((p) => p.includes('unranked') && p.includes('stroke-dasharray') && p.includes('did not complete'))).toBe(true);
    expect(ps[0]).toContain('unranked');
    expect(speedKey(cut, 1, 'leg')).toContain('grey dashed');
  });

  it('ranks every segment on its own leg for the whole race', () => {
    const svg = trackMap(a, null, null, { colour: 'speed' });
    const ps = polylines(svg);
    for (const l of a.legs) {
      expect(ps.some((p) => p.includes(`data-leg="${l.index}"`) && new RegExp(`${l.name} · #1 of`).test(p))).toBe(true);
    }
    expect(speedKey(a, null, 'leg')).toContain('on each leg');
  });

  it('colours the whole track by race time with Rank by: Overall', () => {
    const svg = trackMap(a, null, null, { colour: 'speed', rankBy: 'overall' });
    const winner = a.boats.reduce((p, q) => ((q.raceTimeS ?? Infinity) < (p.raceTimeS ?? Infinity) ? q : p));
    const mine = polylines(svg).filter((p) => p.includes(`data-id="${winner.id}"`));
    expect(mine.length).toBe(a.legs.length);
    expect(mine.every((p) => p.includes('overall #1 of') && p.includes(`stroke="${speedColor(0)}"`))).toBe(true);
    expect(speedKey(a, null, 'overall')).toMatch(/race time.*\d+:\d\d → \d+:\d\d/);
  });

  it('puts a selected boat on top with a casing and fades the rest', () => {
    const id = a.boats[3].id;
    const svg = trackMap(a, id, 1, { colour: 'speed' });
    const ps = polylines(svg);
    expect(ps[ps.length - 1]).toContain(`data-id="${id}"`);
    expect(ps[ps.length - 1]).toContain(' on');
    expect(svg).toMatch(/<polyline class="spd-sel"[^>]*\/><polyline class="trk spd[^"]* on"/);
    expect(ps.filter((p) => !p.includes(`data-id="${id}"`)).every((p) => p.includes(' fade'))).toBe(true);
  });

  it('shows the time range for a single leg in the key', () => {
    const r = [...a.boats].map((b) => b.legs[1]?.timeS).filter((t): t is number => t != null);
    expect(r.length).toBeGreaterThan(0);
    expect(speedKey(a, 1, 'leg')).toMatch(/on this leg.*\d+:\d\d → \d+:\d\d/s);
  });
});
