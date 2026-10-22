import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { groupIds } from '../src/analysis/coach/groups';
import type { Vec } from '../src/analysis/geo';
import { startReplays, type StartReplay } from '../src/analysis/startReplay';
import { PRE_LEG, type BoatDrawing, type RaceAnalysis, type TrackSegment } from '../src/analysis/types';
import { LANE_FRAMES_S, LANE_GUARD_LINES, LANE_GUARD_MIN_M, LANE_PAD, LANE_PAD_M, LANE_TRAIL_FROM_S, laneSnapshots, laneView, type LaneFrame } from '../src/ui/laneSnapshots';
import {
  LANE_DEFAULT_W_PX,
  LANE_MAX_H_PX,
  laneKeyStep,
  lanePxPerUnit,
  laneSnapshotsHtml,
  mountLaneSnapshots,
  pxToUnits,
  stepLaneFrame,
  windBadgeHtml,
} from '../src/ui/laneSnapshotsView';
import { ic37Race } from './helpers';

/**
 * Lane snapshots (Start tab): a synthetic start (line from (−100, 0) pin to (100, 0) RC, first mark 1 km north,
 * wind from the north; boats sailing north at 2 m/s, 1 Hz fixes), then IC37 North Americans race 5.
 */
const GUN = 1_000_000;
const sec = (s: number): number => GUN + s * 1000;

/** A 1 Hz track at x, sailing north at `v` m/s through y0 at the gun, over [s0, s1] s (gun-relative), minus the `holes` (open intervals, s). */
function track(x: number, y0: number, s0 = -120, s1 = 200, holes: [number, number][] = [], v = 2): { t: number[]; x: number[]; y: number[] } {
  const out = { t: [] as number[], x: [] as number[], y: [] as number[] };
  for (let s = s0; s <= s1 + 1e-9; s += 1) {
    if (holes.some(([a, b]) => s > a && s < b)) continue;
    out.t.push(sec(s));
    out.x.push(x);
    out.y.push(y0 + v * s);
  }
  return out;
}

function seg(tr: { t: number[]; x: number[]; y: number[] }, keep: (t: number) => boolean, leg: number): TrackSegment {
  const idx = tr.t.map((t, i) => (keep(t) ? i : -1)).filter((i) => i >= 0);
  return {
    leg,
    t: Float64Array.from(idx.map((i) => tr.t[i])),
    x: Float32Array.from(idx.map((i) => tr.x[i])),
    y: Float32Array.from(idx.map((i) => tr.y[i])),
    sog: Float32Array.from(idx.map(() => 4)),
  };
}

function drawing(id: string, tr: { t: number[]; x: number[]; y: number[] }): BoatDrawing {
  const pre = seg(tr, (t) => t <= GUN, PRE_LEG);
  const leg = seg(tr, (t) => t >= GUN, 0);
  return { id, segments: leg.t.length ? [leg] : [], ...(pre.t.length ? { pre } : {}) } as unknown as BoatDrawing;
}

interface BoatSpec {
  id: string;
  tr?: { t: number[]; x: number[]; y: number[] };
}

function race(boats: BoatSpec[], twd = 0, method: 'tacks' | 'model' | 'course' = 'tacks', mark: Vec = [0, 1000], line: [Vec, Vec] = [[-100, 0], [100, 0]]): RaceAnalysis {
  return {
    meta: { gunMs: GUN, tzOffsetMs: 0 },
    line: { left: line[0], right: line[1], lengthM: Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) },
    legPts: [[0, 0], mark, [0, 0]],
    legs: [{ index: 0, name: 'Beat 1', kind: 'upwind', to: 'Mark 1' }],
    marks: [{ name: 'Mark 1', xy: [mark] }],
    wind: { method, estimates: [], twdAtGunDeg: twd, model: null },
    boats: boats.map((b, i) => ({ id: b.id, sail: b.id, colorSlot: i, finishPos: i + 1, legs: [] })),
    drawings: boats.filter((b) => b.tr).map((b) => drawing(b.id, b.tr!)),
  } as unknown as RaceAnalysis;
}

const boatIn = (f: LaneFrame, id: string) => f.boats.find((b) => b.id === id)!;
const near = (p: Vec | null, q: Vec, d = 1e-6): void => {
  expect(p).not.toBeNull();
  expect(Math.hypot(p![0] - q[0], p![1] - q[1])).toBeLessThan(d);
};
const rep = (boat: string, clearedS: number | null): StartReplay => ({
  boat,
  gunMs: GUN,
  flagged: true,
  early: true,
  firstCrossMs: sec(-2),
  over: [sec(-2), sec(10)],
  wentBackMs: sec(10),
  clearedMs: clearedS == null ? null : sec(clearedS),
  maxOverM: 5,
  maxOverAtMs: GUN,
  lostS: null,
});

describe('lane snapshots: frames and trails', () => {
  const a = race([{ id: 'A', tr: track(0, -100) }]);
  const L = laneSnapshots(a, { me: 'A' });

  it('three frames at gun +60 s, +120 s, +180 s; every trail from gun −30 s', () => {
    expect(LANE_FRAMES_S).toEqual([60, 120, 180]);
    expect(LANE_TRAIL_FROM_S).toBe(-30);
    expect(L.frames.map((f) => f.s)).toEqual([60, 120, 180]);
    expect(L.frames.map((f) => f.t)).toEqual([sec(60), sec(120), sec(180)]);
    expect(L.frames.map((f) => f.from)).toEqual([sec(-30), sec(-30), sec(-30)]);
    expect(L.frames.map((f) => f.title)).toEqual(['gun +1:00', 'gun +2:00', 'gun +3:00']);
  });

  it("the boat's position at each frame (wind from the north: north up, y down) and a trail from its position at gun −30 s", () => {
    const [f0, f1, f2] = L.frames.map((f) => boatIn(f, 'A'));
    near(f0.pos, [0, -(-100 + 2 * 60)]);
    near(f1.pos, [0, -(-100 + 2 * 120)]);
    near(f2.pos, [0, -(-100 + 2 * 180)]);
    // One unbroken trail each, across the pre-start / leg boundary, from −30 s to the frame.
    for (const b of [f0, f1, f2]) {
      expect(b.trail).toHaveLength(1);
      near(b.trail[0][0], [0, -(-100 + 2 * -30)]);
      near(b.trail[0].at(-1)!, b.pos!);
    }
    // 1 Hz, the gun's shared fix kept once: −30 … +60 is 91 points, … +120 151, … +180 211 (1:30, 2:30, 3:30).
    expect([f0, f1, f2].map((b) => b.trail[0].length)).toEqual([91, 151, 211]);
  });

  it('trails start at gun −30 s, inclusive, and never earlier', () => {
    // The data from −120 s: the earliest trail point is the −30 s fix, in every frame (map y = −north).
    for (const f of L.frames) {
      const ys = boatIn(f, 'A').trail.flat().map((p) => -p[1]);
      expect(Math.min(...ys)).toBeCloseTo(-100 + 2 * -30, 6);
    }
    // A feed that starts exactly at −30 s: the trail still starts there.
    const exact = laneSnapshots(race([{ id: 'A', tr: track(0, -100, -30) }]), { me: 'A' });
    near(boatIn(exact.frames[0], 'A').trail[0][0], [0, -(-100 + 2 * -30)]);
  });

  it('a trail starts where the data does when that is after −30 s; the caption says nothing about it', () => {
    const b = laneSnapshots(race([{ id: 'A', tr: track(0, -100, -10) }]), { me: 'A' });
    const t0 = boatIn(b.frames[0], 'A').trail[0];
    near(t0[0], [0, -(-100 + 2 * -10)]);
    expect(t0).toHaveLength(71);
    expect(b.frames[0].caption).toBe('A: ≈ 1 of 1');
    const afterGun = laneSnapshots(race([{ id: 'A', tr: track(0, -100, 5) }]), { me: 'A' });
    expect(afterGun.frames[0].caption + afterGun.frames[0].label).not.toMatch(/Tracking starts|No data before|trails from/i);
  });
});

describe('lane snapshots: orientation and the true wind', () => {
  it('wind-up: wind from the east puts east at the top; the wind arrow points straight down, labelled with the TWD, estimated', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }], 90), { me: null });
    expect(L.windUp).toBe(true);
    expect(L.note).toBe("True wind ↓ from the top, estimated from the fleet's tacks on the first beat.");
    near(L.wind!.down, [0, 1]);
    expect(L.wind!.label).toBe('TWD ~90° est.');
    expect(L.wind!.assumed).toBe(false);
    expect(L).not.toHaveProperty('mark');
    // The pin (west) at the bottom, the RC (east) at the top.
    near(L.line[0], [0, 100]);
    near(L.line[1], [0, -100]);
  });

  it('the TWD label: estimated from the tacks, from the model, or assumed from the course', () => {
    const one = [{ id: 'A', tr: track(0, -100) }];
    expect(laneSnapshots(race(one, 18), { me: null }).wind!.label).toBe('TWD ~18° est.');
    expect(laneSnapshots(race(one, 18, 'model'), { me: null }).wind!.label).toBe('TWD 18° (model)');
    const course = laneSnapshots(race(one, 18, 'course'), { me: null });
    expect(course.wind!.label).toBe('TWD ~18° assumed');
    expect(course.note).toMatch(/assumed from the course/);
    near(course.wind!.down, [0, 1]);
  });

  it('no wind estimate: north up, the wind assumed square to the line from the course side, and says so', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }], NaN), { me: null });
    expect(L.windUp).toBe(false);
    expect(L.note).toMatch(/North up: no wind estimate; wind assumed square to the line/);
    // The line runs east-west, the course side north: the wind blows from the north, down the page.
    near(L.wind!.down, [0, 1]);
    expect(L.wind!.label).toBe('Wind assumed ⟂ line');
    expect(L.wind!.assumed).toBe(true);
    // The first mark only tells the course side: one to the south turns the arrow round.
    const south = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }], NaN, 'tacks', [0, -1000]), { me: null });
    near(south.wind!.down, [0, -1]);
  });

  it('no wind estimate, a skewed line: the arrow square to the line, and places along that perpendicular', () => {
    // Pin (−100, −50) → RC (100, 50): the course side is north-west of it.
    const line: [Vec, Vec] = [
      [-100, -50],
      [100, 50],
    ];
    const boats = [
      { id: 'NW', tr: track(-40, -20, -120, 200, [], 0) },
      { id: 'SE', tr: track(40, -40, -120, 200, [], 0) },
    ];
    const L = laneSnapshots(race(boats, NaN, 'tacks', [0, 1000], line), { me: 'SE' });
    const d = L.wind!.down;
    const along = [L.line[1][0] - L.line[0][0], L.line[1][1] - L.line[0][1]];
    expect(Math.abs(d[0] * along[0] + d[1] * along[1])).toBeLessThan(1e-9);
    // Downwind is south-east: map x +, map y + (y down).
    expect(d[0]).toBeGreaterThan(0);
    expect(d[1]).toBeGreaterThan(0);
    const f = L.frames[0];
    // Along the line's perpendicular toward the course side, n = (−1, 2)/√5, from the line's middle (0, 0): (−40, −20)·n vs (40, −40)·n.
    expect(boatIn(f, 'NW').windwardM).toBeCloseTo((40 - 40) / Math.sqrt(5), 6);
    expect(boatIn(f, 'SE').windwardM).toBeCloseTo((-40 - 80) / Math.sqrt(5), 6);
    expect(boatIn(f, 'NW').rank).toBe(1);
    expect(f.caption).toBe('SE: ≈ 2 of 2');
    expect(f.label).toBe('Lane snapshot at gun +1:00: 2 of 2 boats placed. SE: ≈ 2 of 2 upwind. No wind estimate: wind assumed square to the start line.');
    const html = laneSnapshotsHtml(race(boats, NaN, 'tacks', [0, 1000], line), L);
    // The badge: dashed, turned to the assumed downwind, its title in full.
    expect(html).toContain('<div class="lane-wind assumed" title="No wind estimate: wind assumed square to the start line">');
    expect(html).toMatch(/<div class="lane-wind assumed"[^>]*><svg class="lane-wind-arrow"[^>]*><g transform="rotate\([-\d.]+\)"><line [^>]*stroke-dasharray/);
    const deg = Number(html.match(/<g transform="rotate\(([-\d.]+)\)">/)![1]);
    expect(deg).toBeCloseTo((Math.atan2(-d[0], d[1]) * 180) / Math.PI, 1);
    // The arrow drawn pointing down, turned by deg: it points along `d`.
    const th = (deg * Math.PI) / 180;
    expect(-Math.sin(th)).toBeCloseTo(d[0], 2);
    expect(Math.cos(th)).toBeCloseTo(d[1], 2);
    expect(html).toContain('<span>Wind assumed ⟂ line</span>');
    expect(html).toContain('North up: no wind estimate; wind assumed square to the line, from the course side.');
  });

  it('a common view for all frames, fitted tightly: the line, every position and trail, padded 8% each way; no reach box, no wind strip; the mark not drawn', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }]), { me: null });
    // x: the line (−100 … 100), padded 8% of 200 = 16 m. y: the trail's start, 160 m south at −30 s (map y +160),
    // to its position 260 m north at +3:00 (map y −260): 420 m, padded 33.6 m. Nothing else.
    expect(LANE_PAD).toBe(0.08);
    expect(L.view.x0).toBeCloseTo(-116, 3);
    expect(L.view.x1).toBeCloseTo(116, 3);
    expect(L.view.y0).toBeCloseTo(-260 - 33.6, 3);
    expect(L.view.y1).toBeCloseTo(160 + 33.6, 3);
    const html = laneSnapshotsHtml(race([{ id: 'A', tr: track(0, -100) }]), L);
    expect(html).not.toContain('class="mark"');
    expect(html).not.toContain('Mark 1');
  });

  it('a small fleet near the line: the minimum padding, in metres', () => {
    expect(LANE_PAD_M).toBe(10);
    const v = laneView(
      [
        [-50, 0],
        [50, 0],
      ],
      [[0, 40]],
      400,
    );
    // x: 100 m → 8 m padding, under the 10 m minimum; y: 0 … 40 → 3.2 m, also 10 m.
    expect(v).toEqual({ x0: -60, x1: 60, y0: -10, y1: 50 });
  });

  it('the outlier guard only leaves points out: what is beyond it never counts, however long the trail', () => {
    expect([LANE_GUARD_LINES, LANE_GUARD_MIN_M]).toEqual([3, 400]);
    // 8 m/s: 340 m south at −30 s, 1340 m north at +3:00; the guard is max(3 × 200, 400) = 600 m from the line's middle.
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }, { id: 'Fast', tr: track(-50, -100, -120, 200, [], 8) }]), { me: null });
    // Up to the guard (600 m north) and its padding; nowhere near its 1340 m.
    expect(L.view.y0).toBeGreaterThan(-600 - 0.08 * 1200 - 1);
    expect(L.view.y1).toBeLessThan(700);
    expect(L.view.y1).toBeGreaterThan(340);
    // The guard adds nothing: with every point inside it, the view is the same as without one.
    const pts: Vec[] = [
      [0, 30],
      [20, -60],
    ];
    const line: [Vec, Vec] = [
      [-100, 0],
      [100, 0],
    ];
    expect(laneView(line, pts, 600)).toEqual(laneView(line, pts, Infinity));
  });

  it('a boat away from the line is drawn but does not size the view', () => {
    const stray = race([{ id: 'A', tr: track(0, -100) }, { id: 'Far', tr: track(350, -100) }]);
    const base = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }]), { me: null }).view;
    expect(laneSnapshots(stray, { me: null }).view.x1).toBeGreaterThan(350);
    const away = { ...stray, boats: stray.boats.map((b) => (b.id === 'Far' ? { ...b, start: { awayFromLine: true } } : b)) } as RaceAnalysis;
    const L = laneSnapshots(away, { me: null });
    expect(L.view).toEqual(base);
    expect(boatIn(L.frames[0], 'Far').pos).not.toBeNull();
  });
});

describe('lane snapshots: captions', () => {
  const fleet3 = [
    { id: 'Back', tr: track(0, -150) },
    { id: 'Front', tr: track(90, -50) },
    { id: 'Mid', tr: track(-90, -100) },
  ];
  const ranks = (L: ReturnType<typeof laneSnapshots>) => L.frames.map((f) => fleet3.map((b) => boatIn(f, b.id).rank));

  it('ranks by distance made to windward along the wind (approximate): further upwind, better', () => {
    const L = laneSnapshots(race(fleet3), { me: 'Mid' });
    const f = L.frames[2];
    expect(boatIn(f, 'Front').rank).toBe(1);
    expect(boatIn(f, 'Mid').rank).toBe(2);
    expect(boatIn(f, 'Back').rank).toBe(3);
    // Along the wind from the line's middle, not straight-line: Front is 90 m to the side, −50 + 360 = 310 m to windward.
    expect(boatIn(f, 'Front').windwardM).toBeCloseTo(310, 6);
    expect(f.caption).toBe('Mid: ≈ 2 of 3');
    expect(f.label).toBe('Lane snapshot at gun +3:00: 3 of 3 boats placed. Mid: ≈ 2 of 3 upwind. True wind from 0° (estimated).');
    expect(f.caption).not.toMatch(/Mark 1|toward|third|pin|RC/);
    expect(f.label).not.toMatch(/Mark 1|toward/);
  });

  it('the ranks never depend on where the first mark is: one well off to the side changes nothing', () => {
    const base = ranks(laneSnapshots(race(fleet3), { me: 'Mid' }));
    for (const mark of [
      [800, 300],
      [-900, 100],
      [0, -1000],
    ] as Vec[]) {
      const L = laneSnapshots(race(fleet3, 0, 'tacks', mark), { me: 'Mid' });
      expect(ranks(L)).toEqual(base);
      expect(L.frames[2].caption).toBe('Mid: ≈ 2 of 3');
    }
  });

  it('ranks along the wind, whichever way it blows: wind from the east, the boat furthest east first', () => {
    const L = laneSnapshots(race(fleet3, 90), { me: 'Mid' });
    const f = L.frames[0];
    expect(['Front', 'Back', 'Mid'].map((id) => boatIn(f, id).rank)).toEqual([1, 2, 3]);
    expect(boatIn(f, 'Front').windwardM).toBeCloseTo(90, 6);
    expect(f.caption).toBe('Mid: ≈ 3 of 3');
  });

  it('no boat selected: no caption; the label still says how many are placed and the wind', () => {
    const L = laneSnapshots(race(fleet3), { me: null });
    expect(L.frames[0].caption).toBe('');
    expect(L.frames[0].label).toBe('Lane snapshot at gun +1:00: 3 of 3 boats placed. True wind from 0° (estimated).');
  });

  it('the selected boat and its group highlighted, the rest not', () => {
    const L = laneSnapshots(
      race([
        { id: 'A', tr: track(0, -100) },
        { id: 'B', tr: track(20, -100) },
        { id: 'C', tr: track(40, -100) },
      ]),
      { me: 'B', group: ['C'] },
    );
    expect(L.frames[0].boats.map((b) => b.role)).toEqual(['other', 'me', 'group']);
  });
});

describe('lane snapshots: over early', () => {
  const boats = [
    { id: 'Early', tr: track(0, -100) },
    { id: 'Late', tr: track(30, -100) },
    { id: 'Later', tr: track(45, -100) },
    { id: 'Never', tr: track(60, -100) },
    { id: 'Clean', tr: track(-30, -100) },
  ];
  const L = laneSnapshots(race(boats), { me: 'Early', replays: [rep('Early', 30), rep('Late', 90), rep('Later', 150), rep('Never', null)] });
  const over = (id: string) => L.frames.map((f) => boatIn(f, id).over);

  it('an OCS boat is over at a frame until it cleared (clearedMs), then cleared in every later frame', () => {
    expect(over('Early')).toEqual(['cleared', 'cleared', 'cleared']);
    expect(over('Late')).toEqual(['over', 'cleared', 'cleared']);
    expect(over('Later')).toEqual(['over', 'over', 'cleared']);
    expect(over('Never')).toEqual(['over', 'over', 'over']);
    expect(over('Clean')).toEqual([null, null, null]);
    expect(L.frames.map((f) => boatIn(f, 'Early').clearedMs)).toEqual([sec(30), sec(30), sec(30)]);
    expect(boatIn(L.frames[0], 'Late').clearedMs).toBeNull();
    expect(boatIn(L.frames[2], 'Late').clearedMs).toBe(sec(90));
  });

  it('not in the captions or labels: on the map, and the key\'s legend says what the rings mean', () => {
    const html = laneSnapshotsHtml(race(boats), L);
    for (const f of L.frames) expect(f.caption + f.label).not.toMatch(/OCS|over early|cleared/i);
    const key = html.split('<p class="lane-key muted">')[1];
    // Just the legend: no other over-early words in the key.
    expect(key.split('<span class="lane-legend">')[0]).not.toMatch(/OCS|ring|over early|cleared/i);
  });

  it('the legend: a solid ring "OCS" and a dashed ring "OCS, cleared", the swatches as the map draws them (aria-hidden)', () => {
    const html = laneSnapshotsHtml(race(boats), L);
    const legend = html.split('<span class="lane-legend">')[1].split('</p>')[0];
    const items = legend.match(/<span class="lane-legend-item">.*?<\/svg>[^<]*<\/span>/g)!;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/<\/svg>OCS<\/span>$/);
    expect(items[1]).toMatch(/<\/svg>OCS, cleared<\/span>$/);
    for (const i of items) expect(i).toContain('<svg class="lane-swatch" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">');
    // The map's ring around an unhighlighted dot, at one css px per unit: same classes, width and dashes.
    expect(items[0]).toContain('<circle class="lane-over" cx="7" cy="7" r="5.70" stroke-width="1.30"/>');
    expect(items[1]).toContain('<circle class="lane-cleared" cx="7" cy="7" r="5.70" stroke-width="1.30" stroke-dasharray="2.50 2.00"/>');
    expect(items[0]).not.toContain('dasharray');
    expect(html.match(/class="lane-legend"/g)).toHaveLength(1);
  });

  it('no legend when no boat was over early (none OCS, or the replays not in yet)', () => {
    const clean = laneSnapshots(race(boats), { me: 'Early', replays: [] });
    expect(laneSnapshotsHtml(race(boats), clean)).not.toMatch(/lane-legend|lane-swatch|OCS/);
    const pending = laneSnapshots(race(boats), { me: 'Early', replays: null });
    expect(laneSnapshotsHtml(race(boats), pending)).not.toMatch(/lane-legend|lane-swatch|OCS/);
  });

  it('the rings: solid while over, dashed once cleared, no "OCS" text; the dot\'s title says it, with when it cleared', () => {
    const html = laneSnapshotsHtml(race(boats), L);
    const first = html.split('<figure')[1];
    expect(first.match(/class="lane-over"/g)).toHaveLength(3);
    expect(first.match(/class="lane-over"[^>]*stroke-dasharray/g)).toBeNull();
    expect(first.match(/class="lane-cleared"[^>]*stroke-dasharray/g)).toHaveLength(1);
    expect(html).not.toMatch(/>OCS<\/text>|lane-ocs/);
    expect(first).toContain('<title>Late, over early (OCS)</title>');
    expect(first).toContain('<title>Early, over early (OCS), cleared +30 s</title>');
    expect(first).toContain('<title>Clean</title>');
    expect(html).not.toMatch(/lane-above|above the line/i);
  });

  it('no over marks before the replays are in', () => {
    const b = laneSnapshots(race(boats), { me: 'Early', replays: null });
    expect(b.frames.flatMap((f) => f.boats.map((x) => x.over)).every((x) => x == null)).toBe(true);
  });
});

describe('lane snapshots: data gaps', () => {
  it('a long gap over a frame: the boat is missing there (no position made up), and its trails break at the gap', () => {
    const L = laneSnapshots(race([{ id: 'S', tr: track(0, -100, -120, 180, [[40, 80], [95, 105]]) }]), { me: 'S' });
    const [f0, f1] = L.frames.map((f) => boatIn(f, 'S'));
    expect(f0.pos).toBeNull();
    expect(L.frames[0].placed).toBe(0);
    expect(L.frames[0].caption).toBe('S: no position (tracker gap).');
    // −30 → +40 drawn, nothing made up past the last fix before the gap.
    expect(f0.trail).toHaveLength(1);
    near(f0.trail[0].at(-1)!, [0, -(-100 + 2 * 40)]);
    // −30 → +120: to +40, then from the fix after the gap (+80) to +95, then +105 → +120.
    expect(f1.trail).toHaveLength(3);
    near(f1.trail[0][0], [0, -(-100 + 2 * -30)]);
    near(f1.trail[1][0], [0, -(-100 + 2 * 80)]);
    near(f1.trail[2][0], [0, -(-100 + 2 * 105)]);
    near(f1.pos, [0, -(-100 + 2 * 120)]);
  });

  it('a short step (within the gap rule) is interpolated; just inside a gap the dot holds at the last fix (the scrubber rule)', () => {
    // 1 Hz with the fix at +60 missing: a 2 s step, not a gap.
    const short = laneSnapshots(race([{ id: 'S', tr: track(0, -100, -120, 180, [[59, 61]]) }]), { me: 'S' });
    near(boatIn(short.frames[0], 'S').pos, [0, -(-100 + 2 * 60)]);
    expect(boatIn(short.frames[0], 'S').hold).toBe(false);
    // A gap +58 … +80: 2 s after the last fix, held there (hollow).
    const held = laneSnapshots(race([{ id: 'S', tr: track(0, -100, -120, 180, [[58, 80]]) }]), { me: 'S' });
    const h = boatIn(held.frames[0], 'S');
    expect(h.hold).toBe(true);
    near(h.pos, [0, -(-100 + 2 * 58)]);
  });

  it('a feed that starts a fraction of a second after a frame places the boat at its first fix', () => {
    const tr = track(0, -100, 60);
    tr.t[0] += 100; // +60.1 s
    const L = laneSnapshots(race([{ id: 'A', tr }]), { me: 'A' });
    near(boatIn(L.frames[0], 'A').pos, [0, -(-100 + 2 * 60)]);
    // …but not one that starts 10 s later.
    const late = laneSnapshots(race([{ id: 'A', tr: track(0, -100, 70) }, { id: 'B', tr: track(50, -100) }]), { me: 'A' });
    expect(boatIn(late.frames[0], 'A').pos).toBeNull();
  });

  it("a frame with no positions and no trails: 'No tracks at this time.'", () => {
    // Tracking only from +2:30: the +1:00 and +2:00 frames are empty, the +3:00 frame draws.
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100, 150) }, { id: 'B', tr: track(50, -100, 150) }]), { me: 'A' });
    expect(L.frames.map((f) => f.empty)).toEqual([true, true, false]);
    expect(L.frames[0].caption).toBe('No tracks at this time.');
    expect(L.frames[0].label).toBe('Lane snapshot at gun +1:00: no tracks at this time.');
    expect(L.frames[2].caption).toBe('A: ≈ 1 of 2');
    const html = laneSnapshotsHtml(race([{ id: 'A', tr: track(0, -100, 150) }]), L);
    expect(html).toContain('class="lane-empty"');
    expect(html).toContain('>No tracks</text>');
  });

  it('the selected boat in a tracker gap: said once; other boats without a position not listed', () => {
    const L = laneSnapshots(race([{ id: 'S', tr: track(0, -100, -120, 180, [[40, 80]]) }, { id: 'A', tr: track(20, -100) }, { id: 'Ghost' }]), { me: 'S' });
    expect(L.frames[0].caption).toBe('S: no position (tracker gap).');
    expect(L.frames[0].label).toBe('Lane snapshot at gun +1:00: 1 of 3 boats placed. S: no position (tracker gap). True wind from 0° (estimated).');
  });

  it('the selected boat with no track at all: "not tracked" once', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }, { id: 'Ghost' }, { id: 'Gone' }]), { me: 'Ghost' });
    for (const f of L.frames) {
      expect(f.caption).toBe('Ghost: not tracked.');
      expect(f.label.match(/Ghost/g)).toHaveLength(1);
      expect(f.label).not.toContain('Gone');
    }
  });

  it('a boat with no track at all: not placed in any frame, and out of the "of n"', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }, { id: 'Ghost' }]), { me: 'A' });
    for (const f of L.frames) {
      expect(f.placed).toBe(1);
      expect(f.caption).toBe('A: ≈ 1 of 1');
      expect(boatIn(f, 'Ghost').pos).toBeNull();
      expect(boatIn(f, 'Ghost').trail).toEqual([]);
    }
  });
});

describe('lane snapshots: renderer', () => {
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'B', tr: track(20, -100) },
    { id: 'C', tr: track(40, -100) },
  ]);
  const L = laneSnapshots(a, { me: 'B', group: ['C'], replays: [rep('A', 90)] });
  const html = laneSnapshotsHtml(a, L, 'the top 3 (Coach group)');

  it('three frames, each an SVG with an accessible label, the shared view, the line and the true-wind arrow', () => {
    expect(html.match(/<figure class="lane-frame/g)).toHaveLength(3);
    expect(html.match(/<svg class="chart lane-svg"/g)).toHaveLength(3);
    expect(html).toContain('role="img" aria-label="Lane snapshot at gun +1:00: 3 of 3 boats placed. B: ≈ 2 of 3 upwind. True wind from 0° (estimated)."');
    expect(html).toContain('data-s="60"');
    expect(html).toContain('data-s="180"');
    expect(html).not.toMatch(/Trails from|Lane: across|pin to RC|Red ring|frame before/);
    const v = L.view;
    expect(html.match(new RegExp(`viewBox="${v.x0.toFixed(1)} ${v.y0.toFixed(1)}`, 'g'))).toHaveLength(3);
    expect(html.match(/class="startline"/g)).toHaveLength(3);
    expect(html).not.toMatch(/Mark 1|Toward|lane-markdir/);
  });

  it("the wind: a badge over the map's top-right corner (outside the SVG and its extent), pointing straight down, labelled with the TWD, marked estimated", () => {
    const badge = '<div class="lane-wind" title="True wind from 0° (estimated)"><svg class="lane-wind-arrow" viewBox="-8 -8 16 16" width="14" height="14" aria-hidden="true" focusable="false"><g transform="rotate(0.0)">';
    expect(html.split(badge)).toHaveLength(4);
    expect(html.match(/<span>TWD ~0° est\.<\/span><\/div>/g)).toHaveLength(3);
    // After each map's SVG, inside the map's box: not drawn in the map, so it takes none of its room.
    expect(html.match(/<\/svg><div class="lane-wind"/g)).toHaveLength(3);
    for (const svg of html.match(/<svg class="chart lane-svg"[\s\S]*?<\/svg>/g)!) expect(svg).not.toMatch(/lane-wind|TWD/);
    expect(windBadgeHtml(L)).toBe(html.match(/<div class="lane-wind"[\s\S]*?<\/div>/)![0]);
    expect(windBadgeHtml({ wind: null })).toBe('');
    // The key: who is highlighted, and the wind's source; nothing else.
    expect(html.split('<p class="lane-key muted">')[1].split('<span class="lane-legend">')[0]).toBe('B highlighted, with the top 3 (Coach group); the rest faded. True wind ↓ from the top, estimated from the fleet&#39;s tacks on the first beat.');
    // A true wind is drawn solid (dashed only when assumed).
    expect(windBadgeHtml(L)).not.toContain('dasharray');
    expect(L.frames[0].label).toMatch(/True wind from 0° \(estimated\)\.$/);
  });

  it('a model wind is labelled as the model, not estimated', () => {
    const m = race([{ id: 'A', tr: track(0, -100) }], 18, 'model');
    const out = laneSnapshotsHtml(m, laneSnapshots(m, { me: 'A' }));
    expect(out).toContain('<span>TWD 18° (model)</span>');
    expect(out).not.toContain('est.');
  });

  it('constant on-screen sizes: css px per unit from the rendered size (meet, height capped), sizes in units = px / scale', () => {
    const v = L.view;
    const w = v.x1 - v.x0;
    const h = v.y1 - v.y0;
    // Unmeasured: the default width, the height capped.
    const ppu = lanePxPerUnit(v);
    expect(ppu).toBeCloseTo(Math.min(LANE_DEFAULT_W_PX / w, Math.min((LANE_DEFAULT_W_PX * h) / w, LANE_MAX_H_PX) / h), 9);
    // Measured: the smaller of the two fits (a wide, height-capped box: the height decides).
    expect(lanePxPerUnit(v, 1400, 400)).toBeCloseTo(Math.min(1400 / w, 400 / h), 9);
    expect(lanePxPerUnit({ x0: 0, y0: 0, x1: 1000, y1: 800 }, 1400)).toBeCloseTo(560 / 800, 9);
    expect(lanePxPerUnit({ x0: 0, y0: 0, x1: 1000, y1: 800 }, 390)).toBeCloseTo(0.39, 9);
    expect(pxToUnits(13, 0.5)).toBe(26);
    // The labels: 13 px for the selected boat, 12 px for its group, whatever the view's size.
    const fs = (id: string): number => Number(html.match(new RegExp(`data-id="${id}"><title>[^<]*</title><circle [^>]*/><text [^>]*font-size="([\\d.]+)"`))![1]);
    expect(fs('B')).toBeCloseTo(pxToUnits(13, ppu), 1);
    expect(fs('C')).toBeCloseTo(pxToUnits(12, ppu), 1);
    // At twice the scale, half the units: the same 13 px on screen.
    const big = laneSnapshotsHtml(a, L, undefined, 0, ppu * 2);
    expect(Number(big.match(/class="lane-lbl on"[^>]*font-size="([\d.]+)"/)![1])).toBeCloseTo(pxToUnits(13, ppu * 2), 1);
  });

  it('lines, trails, dots and rings keep their stroke width on screen (non-scaling)', () => {
    expect(html).toMatch(/<line class="startline" [^>]*stroke-width="2.2" vector-effect="non-scaling-stroke"\/>/);
    for (const m of html.match(/<polyline class="lane-trail[^>]*>/g)!) expect(m).toContain('vector-effect="non-scaling-stroke"');
    for (const m of html.match(/<circle class="lane-dot[^>]*>/g)!) expect(m).toContain('vector-effect="non-scaling-stroke"');
    expect(html).toMatch(/<circle class="lane-over" [^>]*stroke-width="1.30" vector-effect="non-scaling-stroke"\/>/);
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  it('the selected boat and its group highlighted (labelled), the rest faded; the over ring', () => {
    expect(html).toContain('class="lane-boat lane-me" data-id="B"');
    expect(html).toContain('class="lane-boat lane-group" data-id="C"');
    expect(html).toContain('class="lane-boat lane-other dim" data-id="A"');
    expect(html).toContain('class="lane-trail lane-other dim"');
    expect(html).toMatch(/class="lane-lbl on"[^>]*>B</);
    expect(html).toContain('class="lane-over"');
    expect(html).toContain('<title>A, over early (OCS)</title>');
    expect(html).toContain('B highlighted, with the top 3 (Coach group)');
    // The selected boat drawn last (on top).
    const dots = html.split('<g class="lane-dots">')[1].split('<g class="lane-flags">')[0];
    expect(dots.lastIndexOf('data-id="B"')).toBeGreaterThan(dots.lastIndexOf('data-id="A"'));
  });

  it('mount: nothing worked out until opened; then drawn, the replays asked once per race', async () => {
    let asked = 0;
    let onToggle: (() => void) | null = null;
    const body = { innerHTML: '' };
    const root = {
      open: false,
      querySelector: () => body,
      addEventListener: (type: string, f: () => void) => {
        if (type === 'toggle') onToggle = f;
      },
    } as unknown as HTMLDetailsElement;
    const lanes = mountLaneSnapshots(root, () => ({ a, me: 'B', group: { kind: 'leaders' } }), () => {
      asked++;
      return Promise.resolve([rep('A', 90)]);
    });
    lanes.refresh();
    expect(body.innerHTML).toBe('');
    expect(asked).toBe(0);
    (root as { open: boolean }).open = true;
    onToggle!();
    expect(body.innerHTML.match(/<figure class="lane-frame/g)).toHaveLength(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(body.innerHTML).toContain('class="lane-over"');
    lanes.refresh();
    expect(asked).toBe(1);
  });

  it('mount: open but on a hidden tab, nothing is worked out until the tab shows', () => {
    let asked = 0;
    let onTab = false;
    const body = { innerHTML: '' };
    const root = { open: true, querySelector: () => body, addEventListener: () => {} } as unknown as HTMLDetailsElement;
    const lanes = mountLaneSnapshots(
      root,
      () => ({ a, me: 'B', group: { kind: 'leaders' } }),
      () => {
        asked++;
        return Promise.resolve([]);
      },
      () => onTab,
    );
    lanes.refresh();
    expect(body.innerHTML).toBe('');
    expect(asked).toBe(0);
    onTab = true;
    lanes.refresh();
    expect(body.innerHTML.match(/<figure class="lane-frame/g)).toHaveLength(3);
    expect(asked).toBe(1);
  });
});

describe('lane snapshots: one frame at a time', () => {
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'B', tr: track(20, -100) },
  ]);
  const L = laneSnapshots(a, { me: 'B' });
  /** The frames' data-s and whether each is hidden; the picker's pressed state and disabled arrows. */
  const shown = (html: string): string[] => [...html.matchAll(/<figure class="lane-frame[^"]*" data-s="(\d+)"( hidden)?>/g)].map((m) => `${m[1]}${m[2] ? ' hidden' : ''}`);
  const pressed = (html: string): string[] => [...html.matchAll(/data-lane-frame="(\d)" aria-pressed="(true|false)"/g)].filter((m) => m[2] === 'true').map((m) => m[1]);
  const disabled = (html: string): string[] => [...html.matchAll(/data-lane-step="(-?1)" aria-label="[^"]*"( disabled)?/g)].filter((m) => m[2]).map((m) => m[1]);

  it('defaults to +1:00: that frame on show, the other two hidden (from screen readers too), ‹ disabled', () => {
    const html = laneSnapshotsHtml(a, L);
    expect(shown(html)).toEqual(['60', '120 hidden', '180 hidden']);
    expect(pressed(html)).toEqual(['0']);
    expect(disabled(html)).toEqual(['-1']);
    expect(html).toContain('<div class="seg" role="group" aria-label="Snapshot time"><button type="button" data-lane-frame="0" aria-pressed="true" aria-label="gun +1:00">+1:00</button>');
    expect(html).toContain('>+2:00</button>');
    expect(html).toContain('>+3:00</button>');
    expect(html).toContain('aria-label="Previous snapshot" disabled>‹</button>');
    expect(html).toContain('aria-label="Next snapshot">›</button>');
    // The frame on show keeps its label.
    expect(html).toMatch(/data-s="60"><figcaption>.*?role="img" aria-label="Lane snapshot at gun \+1:00: /);
  });

  it('every frame in the same view (one viewBox), whichever is on show', () => {
    for (const sel of [0, 1, 2]) {
      const boxes = new Set([...laneSnapshotsHtml(a, L, undefined, sel).matchAll(/class="chart lane-svg" viewBox="([^"]+)"/g)].map((m) => m[1]));
      expect(boxes.size).toBe(1);
    }
  });

  it('the last frame: › disabled; out-of-range picks are clamped', () => {
    const html = laneSnapshotsHtml(a, L, undefined, 2);
    expect(shown(html)).toEqual(['60 hidden', '120 hidden', '180']);
    expect(pressed(html)).toEqual(['2']);
    expect(disabled(html)).toEqual(['1']);
    expect(shown(laneSnapshotsHtml(a, L, undefined, 9))).toEqual(['60 hidden', '120 hidden', '180']);
  });

  it('steps clamp at the ends (no wrap); ← → map to −1 / +1', () => {
    expect(stepLaneFrame(0, -1, 3)).toBe(0);
    expect(stepLaneFrame(0, 1, 3)).toBe(1);
    expect(stepLaneFrame(2, 1, 3)).toBe(2);
    expect(laneKeyStep('ArrowLeft')).toBe(-1);
    expect(laneKeyStep('ArrowRight')).toBe(1);
    expect(laneKeyStep('Enter')).toBe(0);
  });

  it('mount: the buttons, the arrows and the keys step between frames; kept across redraws (a boat change)', () => {
    const on: Record<string, (ev: unknown) => void> = {};
    const body = { innerHTML: '' };
    const root = { open: true, querySelector: () => body, addEventListener: (t: string, f: (ev: unknown) => void) => (on[t] = f) } as unknown as HTMLDetailsElement;
    let me = 'B';
    const lanes = mountLaneSnapshots(root, () => ({ a, me, group: { kind: 'leaders' } }), () => Promise.resolve([]));
    lanes.refresh();
    expect(lanes.frame()).toBe(0);
    const btn = (attrs: Record<string, string>) => ({ target: { closest: () => ({ dataset: attrs }) } });
    on.click(btn({ laneStep: '1' }));
    expect(lanes.frame()).toBe(1);
    expect(shown(body.innerHTML)).toEqual(['60 hidden', '120', '180 hidden']);
    on.click(btn({ laneFrame: '2' }));
    expect(lanes.frame()).toBe(2);
    on.click(btn({ laneStep: '1' }));
    expect(lanes.frame()).toBe(2); // clamped
    let prevented = 0;
    const key = (k: string) => ({ key: k, target: { closest: () => null }, preventDefault: () => prevented++ });
    on.keydown(key('ArrowLeft'));
    expect(lanes.frame()).toBe(1);
    on.keydown(key('ArrowLeft'));
    on.keydown(key('ArrowLeft'));
    expect(lanes.frame()).toBe(0); // clamped
    expect(prevented).toBe(3);
    on.keydown(key('Tab'));
    expect(prevented).toBe(3);
    on.keydown(key('ArrowRight'));
    me = 'A';
    lanes.refresh();
    expect(lanes.frame()).toBe(1);
    expect(pressed(body.innerHTML)).toEqual(['1']);
    expect(body.innerHTML).toContain('A highlighted');
  });
});

describe('IC37 R5: USA 016 selected', () => {
  const data = ic37Race();
  const a = analyzeRace(data);
  const idOf = (sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
  const me = idOf('USA 016');
  const replays = startReplays(a, data);
  const L = laneSnapshots(a, { me, group: groupIds(a.boats, me, { kind: 'leaders' }), replays });
  const at = (i: number, sail: string) => boatIn(L.frames[i], idOf(sail));

  it('three frames, wind-up, every boat placed in each, every trail from gun −0:30 (the feed starts at −59.9 s)', () => {
    expect(L.frames.map((f) => f.title)).toEqual(['gun +1:00', 'gun +2:00', 'gun +3:00']);
    expect(L.windUp).toBe(true);
    for (const f of L.frames) {
      expect(f.empty).toBe(false);
      expect(f.placed).toBe(a.boats.length);
      expect(f.caption).toMatch(/^USA 016: ≈ \d+ of 15$/);
    }
    // One unbroken trail each, longer frame by frame.
    const lens = [0, 1, 2].map((i) => at(i, 'USA 016').trail.map((t) => t.length));
    for (const l of lens) expect(l).toHaveLength(1);
    expect(lens[1][0]).toBeGreaterThan(lens[0][0]);
    expect(lens[2][0]).toBeGreaterThan(lens[1][0]);
    // The true wind blows straight down the page, labelled with the analysis's wind at the gun.
    near(L.wind!.down, [0, 1]);
    expect(L.wind!.label).toMatch(/^TWD ~\d+° est\.$/);
  });

  it("USA 016's places to windward sensible; no lane text, no mark's name", () => {
    for (const b of [0, 1, 2].map((i) => at(i, 'USA 016'))) {
      expect(b.rank).toBeGreaterThanOrEqual(1);
      expect(b.rank).toBeLessThanOrEqual(a.boats.length);
    }
    expect(L.frames[0].label).toMatch(/^Lane snapshot at gun \+1:00: 15 of 15 boats placed\. USA 016: ≈ \d+ of 15 upwind\. True wind from \d+° \(estimated\)\.$/);
    for (const f of L.frames) expect(f.caption + f.label).not.toMatch(/past the|third|% of the line|from pin/);
    // Never a mark's name.
    const html = laneSnapshotsHtml(a, L);
    for (const name of new Set([...a.marks.map((m) => m.name), ...a.legs.map((l) => l.to)].filter(Boolean))) {
      for (const f of L.frames) expect(f.caption + f.label).not.toContain(name);
      expect(html).not.toContain(`>${name}<`);
    }
    expect(html).not.toMatch(/Ofst|toward/i);
  });

  it('USA 017 and USA 019 (OCS, cleared ≈ +26 s and ≈ +35 s at the bow): cleared in every frame, from +1:00 on, on the map only', () => {
    for (const [sail, cleared] of [
      ['USA 017', 26],
      ['USA 019', 35],
    ] as const) {
      expect(L.frames.map((f) => boatIn(f, idOf(sail)).over)).toEqual(['cleared', 'cleared', 'cleared']);
      expect((at(0, sail).clearedMs! - a.meta.gunMs) / 1000).toBeCloseTo(cleared, -0.5);
    }
    const html = laneSnapshotsHtml(a, L);
    expect(html.match(/<title>USA 017, over early \(OCS\), cleared \+26 s<\/title>/g)).toHaveLength(3);
    expect(html.match(/<title>USA 019, over early \(OCS\), cleared \+35 s<\/title>/g)).toHaveLength(3);
    for (const f of L.frames) expect(f.caption + f.label).not.toMatch(/OCS|cleared/);
    // The key's legend for the rings, both kinds.
    const legend = html.split('<span class="lane-legend">')[1];
    expect(legend).toMatch(/<circle class="lane-over"[^>]*\/><\/svg>OCS<\/span>/);
    expect(legend).toMatch(/<circle class="lane-cleared"[^>]*stroke-dasharray[^>]*\/><\/svg>OCS, cleared<\/span>/);
    // Nobody else is ever marked over.
    const others = L.frames.flatMap((f) => f.boats.filter((b) => b.over && b.id !== idOf('USA 017') && b.id !== idOf('USA 019')));
    expect(others).toEqual([]);
  });

  it('highlights USA 016 and its Coach group (the top 3)', () => {
    const roles = L.frames[1].boats.filter((b) => b.role !== 'other');
    expect(roles.find((b) => b.role === 'me')!.sail).toBe('USA 016');
    expect(roles.filter((b) => b.role === 'group')).toHaveLength(3);
    const html = laneSnapshotsHtml(a, L);
    expect(html.match(/<figure class="lane-frame/g)).toHaveLength(3);
    expect(html.match(/class="lane-boat lane-me"/g)).toHaveLength(3);
  });
});
