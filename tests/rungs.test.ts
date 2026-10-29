import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { bearingVec, dot, type Vec } from '../src/analysis/geo';
import { PRE_LEG, type RaceAnalysis } from '../src/analysis/types';
import { boatsAt, scrubFrame, startClass, trackMap } from '../src/ui/charts';
import { rotator } from '../src/ui/mapPieces';
import {
  clipLine,
  courseBox,
  ladderBehindM,
  ladderText,
  leaderOf,
  legAxes,
  paintRungs,
  raceCourseBox,
  rungAxis,
  rungAxisFor,
  rungDraws,
  rungLabel,
  rungSegment,
  rungsAt,
  type RungAxis,
  type RungBoat,
  type RungDraw,
  type RungInput,
} from '../src/ui/rungs';
import { fixtureRace } from './helpers';

/**
 * Ladder rungs on the track map's scrubber (ui/rungs.ts): square to the leg's wind through the leader and the selected
 * boat, across the course, on beats and runs only; the selected boat's distance behind the leader along the wind.
 */

const cross = (u: Vec, v: Vec): number => u[0] * v[1] - u[1] * v[0];
const box = { x0: -500, y0: -1000, x1: 500, y1: 200 };

describe('rung geometry', () => {
  it('lies square to the leg’s wind, in map coordinates', () => {
    // The map is drawn with the gun's wind at the top: a leg on that wind has level rungs.
    const ax = rungAxis('upwind', 220, 220)!;
    expect(ax.up[0]).toBeCloseTo(0, 9);
    expect(ax.up[1]).toBeCloseTo(-1, 9);
    expect(Math.abs(ax.across[0])).toBeCloseTo(1, 9);
    // A leg 15° right of it: the rungs tilt with it, and stay square to its wind.
    const shifted = rungAxis('downwind', 235, 220)!;
    expect(dot(shifted.up, shifted.across)).toBeCloseTo(0, 9);
    expect(Math.hypot(...shifted.across)).toBeCloseTo(1, 9);
    expect((Math.atan2(-shifted.up[1], shifted.up[0]) * 180) / Math.PI).toBeCloseTo(90 - 15, 6);
    // The map's own rotation of the leg's wind.
    const up = rotator(220)(bearingVec(235));
    expect(shifted.up[0]).toBeCloseTo(up[0], 9);
    expect(shifted.up[1]).toBeCloseTo(up[1], 9);
  });

  it('has none on a reach, or with no wind', () => {
    expect(rungAxis('reach', 220, 220)).toBeNull();
    expect(rungAxis('upwind', NaN, 220)).toBeNull();
  });

  it('passes through the boat and ends on the course box', () => {
    const ax = rungAxis('upwind', 230, 220)!;
    const p: Vec = [120, -300];
    const [a, b] = rungSegment(p, ax.across, box)!;
    // Through the boat, along the rung.
    expect(cross([a[0] - p[0], a[1] - p[1]], ax.across)).toBeCloseTo(0, 6);
    expect(cross([b[0] - p[0], b[1] - p[1]], ax.across)).toBeCloseTo(0, 6);
    expect(dot([b[0] - a[0], b[1] - a[1]], ax.up)).toBeCloseTo(0, 6);
    // The boat between the ends, both on the box's edge (nearly level: the left and right sides).
    expect(dot([p[0] - a[0], p[1] - a[1]], ax.across)).toBeGreaterThan(0);
    expect(dot([b[0] - p[0], b[1] - p[1]], ax.across)).toBeGreaterThan(0);
    expect(Math.min(a[0], b[0])).toBeCloseTo(box.x0, 6);
    expect(Math.max(a[0], b[0])).toBeCloseTo(box.x1, 6);
    for (const q of [a, b]) {
      expect(q[1]).toBeGreaterThanOrEqual(box.y0);
      expect(q[1]).toBeLessThanOrEqual(box.y1);
    }
  });

  it('reaches a boat outside the course, and no further than it needs to', () => {
    const ax = rungAxis('upwind', 220, 220)!;
    const p: Vec = [900, -400];
    const [a, b] = rungSegment(p, ax.across, box, 50)!;
    const xs = [a[0], b[0]].sort((u, v) => u - v);
    expect(xs[0]).toBeCloseTo(box.x0, 6);
    expect(xs[1]).toBeCloseTo(950, 6);
    // Far below the course: the box grows down to it.
    const low = rungSegment([0, 800], ax.across, box, 50)!;
    expect(low[0][1]).toBeCloseTo(800, 6);
    expect(low[1][1]).toBeCloseTo(800, 6);
  });

  it('clips to a window, or gives nothing outside it', () => {
    expect(clipLine([0, 0], [1, 0], { x0: -10, y0: 5, x1: 10, y1: 9 })).toBeNull();
    expect(clipLine([0, 0], [0, 0], box)).toBeNull();
    const [a, b] = clipLine([0, 0], [1, 0], { x0: -10, y0: -1, x1: 10, y1: 1 }, 0, 4)!;
    expect(a).toEqual([0, 0]);
    expect(b).toEqual([4, 0]);
  });

  it('builds the course box from the course, padded', () => {
    expect(courseBox([])).toBeNull();
    const b = courseBox([
      [0, 0],
      [100, -1000],
    ])!;
    // 15% of the 1000 m span each way.
    expect(b).toEqual({ x0: -150, y0: -1150, x1: 250, y1: 150 });
    // A small course: at least 60 m.
    expect(courseBox([[0, 0]])).toEqual({ x0: -60, y0: -60, x1: 60, y1: 60 });
  });
});

describe('ladder distance', () => {
  const beat = rungAxis('upwind', 220, 220)!;
  const run = rungAxis('downwind', 220, 220)!;

  it('is + behind and − ahead, along the wind only', () => {
    // Up the map is upwind. On a beat the leader is 120 m further up: 120 m behind, whatever the side-to-side split.
    expect(ladderBehindM([0, 0], [0, -120], beat)).toBeCloseTo(120, 9);
    expect(ladderBehindM([300, 0], [-200, -120], beat)).toBeCloseTo(120, 9);
    expect(ladderBehindM([0, -150], [0, -120], beat)).toBeCloseTo(-30, 9);
    // On a run the leader is further down.
    expect(ladderBehindM([0, -120], [0, 0], run)).toBeCloseTo(120, 9);
    expect(ladderBehindM([0, 40], [0, 0], run)).toBeCloseTo(-40, 9);
  });

  it('measures along a shifted leg’s own wind', () => {
    const ax = rungAxis('upwind', 250, 220)!;
    // 100 m along that leg's wind, plus 70 m along its rung.
    const p: Vec = [0, 0];
    const lead: Vec = [100 * ax.up[0] + 70 * ax.across[0], 100 * ax.up[1] + 70 * ax.across[1]];
    expect(ladderBehindM(p, lead, ax)).toBeCloseTo(100, 9);
  });

  it('reads in metres, or in lengths when the class length is known', () => {
    expect(ladderText(120.4, null)).toBe('120 m behind');
    expect(ladderText(-35, null)).toBe('35 m ahead');
    expect(ladderText(1240, null)).toBe('1,240 m behind');
    expect(ladderText(0.4, null)).toBe('level');
    const j70 = { loaM: 6.934 };
    expect(ladderText(6 * 6.934, j70)).toBe('6 lengths behind');
    expect(ladderText(6.934, j70)).toBe('1 length behind');
    expect(ladderText(-2.5 * 6.934, j70)).toBe('2.5 lengths ahead');
    expect(ladderText(83.2, j70)).toBe('12 lengths behind');
    expect(ladderText(2, j70)).toBe('level');
  });

  it('labels the leader and the selected boat by sail number', () => {
    expect(rungLabel({ role: 'leader', behindM: null }, 'USA 11', null)).toBe('Leader');
    expect(rungLabel({ role: 'sel', behindM: 120 }, 'USA 11', null)).toBe('USA 11 · 120 m behind');
    expect(rungLabel({ role: 'sel', behindM: null }, 'USA 11', null)).toBe('USA 11');
    for (const s of [rungLabel({ role: 'sel', behindM: 4 }, 'GBR 7', { loaM: 4.23 }), ladderText(-9, null)]) expect(s).not.toMatch(/gap|no data/i);
  });
});

describe('which rungs show', () => {
  const beat = rungAxis('upwind', 220, 220);
  const run = rungAxis('downwind', 220, 220);
  const axes: (RungAxis | null)[] = [beat, run, null, beat];
  const boat = (id: string, leg: number, my: number, hold = false): RungBoat => ({ id, leg, mx: 0, my, hold });
  const input = (o: Partial<RungInput>): RungInput => ({
    t: 1000,
    boats: [boat('A', 0, -300), boat('B', 0, -200)],
    leader: 'A',
    selected: null,
    axes,
    finishMs: new Map(),
    racing: new Set(['A', 'B', 'C']),
    ...o,
  });

  it('draws the leader’s on a beat or a run', () => {
    expect(rungsAt(input({})).map((r) => [r.role, r.id])).toEqual([['leader', 'A']]);
    expect(rungsAt(input({ boats: [boat('A', 1, 0)] })).map((r) => r.axis.kind)).toEqual(['downwind']);
  });

  it('draws none before the gun, on a reach, after the finish or held at a last fix', () => {
    expect(rungsAt(input({ boats: [boat('A', PRE_LEG, 0)] }))).toEqual([]);
    expect(rungsAt(input({ boats: [boat('A', 2, 0)] }))).toEqual([]);
    expect(rungsAt(input({ finishMs: new Map([['A', 900]]) }))).toEqual([]);
    expect(rungsAt(input({ finishMs: new Map([['A', 1000]]) }))).toEqual([]);
    expect(rungsAt(input({ finishMs: new Map([['A', 1001]]) }))).toHaveLength(1);
    expect(rungsAt(input({ boats: [boat('A', 0, 0, true)] }))).toEqual([]);
    expect(rungAxisFor(boat('A', 9, 0), 0, axes, null)).toBeNull();
  });

  it('draws none until the leader is known, nor for a leader not on the map', () => {
    expect(rungsAt(input({ leader: null, selected: 'B' }))).toEqual([]);
    expect(rungsAt(input({ leader: 'Z' }))).toEqual([]);
  });

  it('adds the selected boat’s, with its distance, only when selected and not the leader', () => {
    const two = rungsAt(input({ selected: 'B' }));
    expect(two.map((r) => [r.role, r.id])).toEqual([
      ['leader', 'A'],
      ['sel', 'B'],
    ]);
    expect(two[0].behindM).toBeNull();
    expect(two[1].behindM).toBeCloseTo(100, 9);
    expect(rungsAt(input({ selected: 'A' })).map((r) => r.role)).toEqual(['leader']);
    // Not racing: no rung.
    expect(rungsAt(input({ selected: 'B', racing: new Set(['A']) })).map((r) => r.role)).toEqual(['leader']);
  });

  it('gives each boat its own leg’s rung, with no distance across legs', () => {
    const r = rungsAt(input({ boats: [boat('A', 1, -300), boat('B', 0, -200)], selected: 'B' }));
    expect(r.map((x) => [x.role, x.axis.kind, x.behindM])).toEqual([
      ['leader', 'downwind', null],
      ['sel', 'upwind', null],
    ]);
  });

  it('keeps the selected boat’s rung when the leader has none', () => {
    // The leader rounding onto a reach, or finished: the selected boat still has its own, without a distance.
    const onReach = rungsAt(input({ boats: [boat('A', 2, -300), boat('B', 0, -200)], selected: 'B' }));
    expect(onReach.map((x) => [x.role, x.behindM])).toEqual([['sel', null]]);
    const done = rungsAt(input({ selected: 'B', finishMs: new Map([['A', 10]]) }));
    expect(done.map((x) => [x.role, x.behindM])).toEqual([['sel', null]]);
  });

  it('takes the boat in first place as the leader', () => {
    expect(leaderOf(new Map([['B', { place: 2 }], ['A', { place: 1 }]]))).toBe('A');
    expect(leaderOf(new Map())).toBeNull();
  });
});

describe('rungs on the race map', () => {
  const a = analyzeRace(fixtureRace());
  const gun = a.meta.gunMs;
  const ids = a.boats.map((b) => b.id);
  const scrub = (t: number, leader: string | null, highlight: string | null = null) =>
    scrubFrame(a, highlight, null, {}, { t, win: [t - 120_000, t], trailMs: 120_000, leader });

  it('takes each leg’s wind: the beat’s own estimate, none on a reach', () => {
    const axes = legAxes(a);
    expect(axes.map((x) => x?.kind)).toEqual(a.legs.map((l) => l.kind));
    for (const e of a.wind.estimates) expect(axes[e.legIndex]!.twdDeg).toBe(e.twdDeg);
    const reach: RaceAnalysis = { ...a, legs: a.legs.map((l, i) => (i === 1 ? { ...l, kind: 'reach' } : l)) };
    expect(legAxes(reach)[1]).toBeNull();
  });

  it('has a layer for them, between the trails and the boats', () => {
    const svg = trackMap(a, null, null, { scrub: true });
    const at = ['g class="scrub-ocs"', 'g class="scrub-rungs"', 'g class="scrub-dots"'].map((s) => svg.indexOf(s));
    expect(at.every((x) => x > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });

  it('draws the leader’s and the selected boat’s on the first beat, labelled', () => {
    const t = gun + 150_000;
    const boats = boatsAt(a, null, t);
    expect(boats.every((b) => b.leg === 0)).toBe(true);
    // The furthest up the beat's wind, as the leader here.
    const up = legAxes(a)[0]!.up;
    const [lead, , other] = [...boats].sort((p, q) => dot([q.mx, q.my], up) - dot([p.mx, p.my], up));
    expect(scrub(t, lead.id).rungs.map((r) => r.role)).toEqual(['leader']);
    const f = scrub(t, lead.id, other.id);
    expect(f.rungs.map((r) => r.role)).toEqual(['leader', 'sel']);
    expect(f.rungs[0].label?.text).toBe('Leader');
    const sail = a.boats.find((b) => b.id === other.id)!.sail;
    const behind = dot([lead.mx - other.mx, lead.my - other.my], up);
    expect(behind).toBeGreaterThan(0);
    // A J/70: in lengths.
    expect(startClass(a)).not.toBeNull();
    expect(f.rungs[1].label?.text).toBe(`${sail} · ${ladderText(behind, startClass(a)!.dims)}`);
    expect(f.rungs[1].label?.text).toMatch(/ lengths? behind$/);
    // Each through its boat, square to the leg's wind, spanning the course.
    const course = raceCourseBox(a)!;
    for (const [r, b] of [
      [f.rungs[0], lead],
      [f.rungs[1], other],
    ] as const) {
      const d: Vec = [r.x2 - r.x1, r.y2 - r.y1];
      expect(Math.abs(dot(d, up)) / Math.hypot(...d)).toBeLessThan(1e-9);
      expect(Math.abs(cross([b.mx - r.x1, b.my - r.y1], d)) / Math.hypot(...d)).toBeLessThan(1e-6);
      expect(Math.hypot(...d)).toBeGreaterThan(0.9 * (course.x1 - course.x0));
    }
  });

  it('draws none before the gun or without a leader; none for a selected leader twice', () => {
    expect(scrub(gun - 30_000, ids[0], ids[1]).rungs).toEqual([]);
    expect(scrub(gun + 150_000, null, ids[1]).rungs).toEqual([]);
    expect(scrub(gun + 150_000, ids[0], ids[0]).rungs.map((r) => r.role)).toEqual(['leader']);
  });

  it('draws none once the boats have finished', () => {
    const last = Math.max(...a.boats.map((b) => b.finishMs ?? 0));
    expect(scrub(last + 1000, ids[0], ids[1]).rungs).toEqual([]);
  });
});

/** A minimal SVG DOM: what paintRungs touches. */
class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  textContent = '';
  constructor(readonly ownerDocument: Doc) {}
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
    this.ownerDocument.sets++;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  appendChild(c: El): void {
    this.children.push(c);
  }
}
class Doc {
  created = 0;
  sets = 0;
  createElementNS(): El {
    this.created++;
    return new El(this);
  }
}

describe('paintRungs', () => {
  const ax = rungAxis('upwind', 220, 220)!;
  const sc = { box: { x0: -400, y0: -800, x1: 400, y1: 100 }, unit: 1, k: 1 };
  const draws = (y: number, sel: boolean): RungDraw[] =>
    rungDraws(
      [
        { role: 'leader', id: 'A', leg: 0, axis: ax, at: [0, y], behindM: null },
        ...(sel ? [{ role: 'sel' as const, id: 'B', leg: 0, axis: ax, at: [0, y + 50] as Vec, behindM: 50 }] : []),
      ],
      box,
      sc,
      (r) => rungLabel(r, r.id, null),
    );

  it('labels inside the view: the leader at the right, the selected boat at the left', () => {
    const [l, s] = draws(-300, true);
    expect(l.label).toMatchObject({ anchor: 'end', text: 'Leader' });
    expect(l.label!.x).toBeCloseTo(sc.box.x1 - 8, 6);
    expect(s.label).toMatchObject({ anchor: 'start', text: 'B · 50 m behind' });
    expect(s.label!.x).toBeCloseTo(sc.box.x0 + 8, 6);
    expect(l.dash).not.toBe('');
    expect(s.dash).toBe('');
    // Out of view: the line, no label.
    expect(draws(-900, false)[0].label).toBeNull();
  });

  it('reuses its elements from frame to frame', () => {
    const doc = new Doc();
    const layer = new El(doc);
    paintRungs(layer as unknown as Element, draws(-300, true));
    expect(doc.created).toBe(6);
    expect(layer.children).toHaveLength(2);
    const sets = doc.sets;
    // The same frame again: nothing created, nothing set.
    expect(paintRungs(layer as unknown as Element, draws(-300, true))).toEqual({ created: 0, set: 0 });
    expect(doc.sets).toBe(sets);
    // A frame later: only the lines and labels move.
    expect(paintRungs(layer as unknown as Element, draws(-310, true)).created).toBe(0);
    // No selection: its rung hidden, kept for the next.
    paintRungs(layer as unknown as Element, draws(-310, false));
    expect(layer.children[1].attrs.get('display')).toBe('none');
    expect(paintRungs(layer as unknown as Element, draws(-310, true)).created).toBe(0);
    expect(layer.children[1].attrs.has('display')).toBe(false);
    expect(doc.created).toBe(6);
    expect(layer.children[1].children[1].textContent).toBe('B · 50 m behind');
  });
});
