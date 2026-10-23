import { describe, expect, it, vi } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { groupIds } from '../src/analysis/coach/groups';
import type { Vec } from '../src/analysis/geo';
import { startReplays, type StartReplay } from '../src/analysis/startReplay';
import { PRE_LEG, type BoatDrawing, type RaceAnalysis, type TrackSegment } from '../src/analysis/types';
import { legRanges } from '../src/ui/mapPieces';
import { drawingGapMs } from '../src/ui/mapPoints';
import {
  LANE_END_S,
  LANE_GUARD_LINES,
  LANE_GUARD_MIN_M,
  LANE_PAD,
  LANE_PAD_M,
  LANE_STEP_S,
  LANE_TRAIL_FROM_S,
  laneScrub,
  laneSecond,
  laneTrail,
  laneView,
  placeAt,
  type LaneFrame,
  type LaneScrub,
} from '../src/ui/laneSnapshots';
import {
  LANE_DEFAULT_W_PX,
  LANE_MAX_H_PX,
  LANE_PLAY_MS,
  LANE_SAY_MS,
  LANE_SHIFT_STEP_S,
  laneKeyTarget,
  lanePxPerUnit,
  laneScrubHtml,
  mountLaneSnapshots,
  pxToUnits,
  stepLaneSecond,
  windBadgeHtml,
} from '../src/ui/laneSnapshotsView';
import { ic37Race } from './helpers';

/**
 * After the gun (Start tab): a time slider 0 … 3:00. A synthetic start (line from (−100, 0) pin to (100, 0) RC,
 * first mark 1 km north, wind from the north; boats sailing north at 2 m/s, 1 Hz fixes), then IC37 North
 * Americans race 5. Many checks look at +1:00, +2:00 and +3:00 (`frames`), the seconds the old snapshots showed.
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
/** The frames at gun +1:00, +2:00 and +3:00. */
const frames = (L: LaneScrub): LaneFrame[] => [60, 120, 180].map((s) => L.frame(s));
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

describe('after the gun: frames and trails', () => {
  const a = race([{ id: 'A', tr: track(0, -100) }]);
  const L = laneScrub(a, { me: 'A' });

  it('a frame at every second from the gun to +3:00 (clamped, to the whole second); every trail from gun −30 s', () => {
    expect([LANE_END_S, LANE_STEP_S, L.end]).toEqual([180, 1, 180]);
    expect(LANE_TRAIL_FROM_S).toBe(-30);
    expect([0, 1, 83, 180].map((s) => L.frame(s).title)).toEqual(['gun +0:00', 'gun +0:01', 'gun +1:23', 'gun +3:00']);
    expect(L.frame(-5).s).toBe(0);
    expect(L.frame(181).s).toBe(180);
    expect(L.frame(12.4).s).toBe(12);
    expect(L.frame(NaN).s).toBe(0);
    // Memoised: the same frame object for the same second.
    expect(L.frame(83)).toBe(L.frame(83.2));
    expect(frames(L).map((f) => f.s)).toEqual([60, 120, 180]);
    expect(frames(L).map((f) => f.t)).toEqual([sec(60), sec(120), sec(180)]);
    expect(frames(L).map((f) => f.from)).toEqual([sec(-30), sec(-30), sec(-30)]);
    expect(frames(L).map((f) => f.title)).toEqual(['gun +1:00', 'gun +2:00', 'gun +3:00']);
  });

  it("the boat's position at each frame (wind from the north: north up, y down) and a trail from its position at gun −30 s", () => {
    const [f0, f1, f2] = frames(L).map((f) => boatIn(f, 'A'));
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
    for (const f of frames(L)) {
      const ys = boatIn(f, 'A').trail.flat().map((p) => -p[1]);
      expect(Math.min(...ys)).toBeCloseTo(-100 + 2 * -30, 6);
    }
    // A feed that starts exactly at −30 s: the trail still starts there.
    const exact = laneScrub(race([{ id: 'A', tr: track(0, -100, -30) }]), { me: 'A' });
    near(boatIn(frames(exact)[0], 'A').trail[0][0], [0, -(-100 + 2 * -30)]);
  });

  it('a trail starts where the data does when that is after −30 s; the caption says nothing about it', () => {
    const b = laneScrub(race([{ id: 'A', tr: track(0, -100, -10) }]), { me: 'A' });
    const t0 = boatIn(frames(b)[0], 'A').trail[0];
    near(t0[0], [0, -(-100 + 2 * -10)]);
    expect(t0).toHaveLength(71);
    expect(frames(b)[0].caption).toBe('A: ≈ 1 of 1');
    const afterGun = laneScrub(race([{ id: 'A', tr: track(0, -100, 5) }]), { me: 'A' });
    expect(frames(afterGun)[0].caption + frames(afterGun)[0].label).not.toMatch(/Tracking starts|No data before|trails from/i);
  });
});

describe('after the gun: orientation and the true wind', () => {
  it('wind-up: wind from the east puts east at the top; the wind arrow points straight down, labelled with the TWD, estimated', () => {
    const L = laneScrub(race([{ id: 'A', tr: track(0, -100) }], 90), { me: null });
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
    expect(laneScrub(race(one, 18), { me: null }).wind!.label).toBe('TWD ~18° est.');
    expect(laneScrub(race(one, 18, 'model'), { me: null }).wind!.label).toBe('TWD 18° (model)');
    const course = laneScrub(race(one, 18, 'course'), { me: null });
    expect(course.wind!.label).toBe('TWD ~18° assumed');
    expect(course.note).toMatch(/assumed from the course/);
    near(course.wind!.down, [0, 1]);
  });

  it('no wind estimate: north up, the wind assumed square to the line from the course side, and says so', () => {
    const L = laneScrub(race([{ id: 'A', tr: track(0, -100) }], NaN), { me: null });
    expect(L.windUp).toBe(false);
    expect(L.note).toMatch(/North up: no wind estimate; wind assumed square to the line/);
    // The line runs east-west, the course side north: the wind blows from the north, down the page.
    near(L.wind!.down, [0, 1]);
    expect(L.wind!.label).toBe('Wind assumed ⟂ line');
    expect(L.wind!.assumed).toBe(true);
    // The first mark only tells the course side: one to the south turns the arrow round.
    const south = laneScrub(race([{ id: 'A', tr: track(0, -100) }], NaN, 'tacks', [0, -1000]), { me: null });
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
    const L = laneScrub(race(boats, NaN, 'tacks', [0, 1000], line), { me: 'SE' });
    const d = L.wind!.down;
    const along = [L.line[1][0] - L.line[0][0], L.line[1][1] - L.line[0][1]];
    expect(Math.abs(d[0] * along[0] + d[1] * along[1])).toBeLessThan(1e-9);
    // Downwind is south-east: map x +, map y + (y down).
    expect(d[0]).toBeGreaterThan(0);
    expect(d[1]).toBeGreaterThan(0);
    const f = frames(L)[0];
    // Along the line's perpendicular toward the course side, n = (−1, 2)/√5, from the line's middle (0, 0): (−40, −20)·n vs (40, −40)·n.
    expect(boatIn(f, 'NW').windwardM).toBeCloseTo((40 - 40) / Math.sqrt(5), 6);
    expect(boatIn(f, 'SE').windwardM).toBeCloseTo((-40 - 80) / Math.sqrt(5), 6);
    expect(boatIn(f, 'NW').rank).toBe(1);
    expect(f.caption).toBe('SE: ≈ 2 of 2');
    expect(f.label).toBe('Fleet at gun +1:00: 2 of 2 boats placed. SE: ≈ 2 of 2 upwind. No wind estimate: wind assumed square to the start line.');
    const html = laneScrubHtml(race(boats, NaN, 'tacks', [0, 1000], line), L);
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

  it('one view for the whole slider, fitted tightly: the line, every position and trail, padded 8% each way; no reach box, no wind strip; the mark not drawn', () => {
    const L = laneScrub(race([{ id: 'A', tr: track(0, -100) }]), { me: null });
    // x: the line (−100 … 100), padded 8% of 200 = 16 m. y: the trail's start, 160 m south at −30 s (map y +160),
    // to its position 260 m north at +3:00 (map y −260): 420 m, padded 33.6 m. Nothing else.
    expect(LANE_PAD).toBe(0.08);
    expect(L.view.x0).toBeCloseTo(-116, 3);
    expect(L.view.x1).toBeCloseTo(116, 3);
    expect(L.view.y0).toBeCloseTo(-260 - 33.6, 3);
    expect(L.view.y1).toBeCloseTo(160 + 33.6, 3);
    const html = laneScrubHtml(race([{ id: 'A', tr: track(0, -100) }]), L);
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
    const L = laneScrub(race([{ id: 'A', tr: track(0, -100) }, { id: 'Fast', tr: track(-50, -100, -120, 200, [], 8) }]), { me: null });
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
    const base = laneScrub(race([{ id: 'A', tr: track(0, -100) }]), { me: null }).view;
    expect(laneScrub(stray, { me: null }).view.x1).toBeGreaterThan(350);
    const away = { ...stray, boats: stray.boats.map((b) => (b.id === 'Far' ? { ...b, start: { awayFromLine: true } } : b)) } as RaceAnalysis;
    const L = laneScrub(away, { me: null });
    expect(L.view).toEqual(base);
    expect(boatIn(frames(L)[0], 'Far').pos).not.toBeNull();
  });
});

describe('after the gun: captions', () => {
  const fleet3 = [
    { id: 'Back', tr: track(0, -150) },
    { id: 'Front', tr: track(90, -50) },
    { id: 'Mid', tr: track(-90, -100) },
  ];
  const ranks = (L: ReturnType<typeof laneScrub>) => frames(L).map((f) => fleet3.map((b) => boatIn(f, b.id).rank));

  it('ranks by distance made to windward along the wind (approximate): further upwind, better', () => {
    const L = laneScrub(race(fleet3), { me: 'Mid' });
    const f = frames(L)[2];
    expect(boatIn(f, 'Front').rank).toBe(1);
    expect(boatIn(f, 'Mid').rank).toBe(2);
    expect(boatIn(f, 'Back').rank).toBe(3);
    // Along the wind from the line's middle, not straight-line: Front is 90 m to the side, −50 + 360 = 310 m to windward.
    expect(boatIn(f, 'Front').windwardM).toBeCloseTo(310, 6);
    expect(f.caption).toBe('Mid: ≈ 2 of 3');
    expect(f.label).toBe('Fleet at gun +3:00: 3 of 3 boats placed. Mid: ≈ 2 of 3 upwind. True wind from 0° (estimated).');
    expect(f.caption).not.toMatch(/Mark 1|toward|third|pin|RC/);
    expect(f.label).not.toMatch(/Mark 1|toward/);
  });

  it('the ranks never depend on where the first mark is: one well off to the side changes nothing', () => {
    const base = ranks(laneScrub(race(fleet3), { me: 'Mid' }));
    for (const mark of [
      [800, 300],
      [-900, 100],
      [0, -1000],
    ] as Vec[]) {
      const L = laneScrub(race(fleet3, 0, 'tacks', mark), { me: 'Mid' });
      expect(ranks(L)).toEqual(base);
      expect(frames(L)[2].caption).toBe('Mid: ≈ 2 of 3');
    }
  });

  it('ranks along the wind, whichever way it blows: wind from the east, the boat furthest east first', () => {
    const L = laneScrub(race(fleet3, 90), { me: 'Mid' });
    const f = frames(L)[0];
    expect(['Front', 'Back', 'Mid'].map((id) => boatIn(f, id).rank)).toEqual([1, 2, 3]);
    expect(boatIn(f, 'Front').windwardM).toBeCloseTo(90, 6);
    expect(f.caption).toBe('Mid: ≈ 3 of 3');
  });

  it('no boat selected: no caption; the label still says how many are placed and the wind', () => {
    const L = laneScrub(race(fleet3), { me: null });
    expect(frames(L)[0].caption).toBe('');
    expect(frames(L)[0].label).toBe('Fleet at gun +1:00: 3 of 3 boats placed. True wind from 0° (estimated).');
  });

  it('the selected boat and its group highlighted, the rest not', () => {
    const L = laneScrub(
      race([
        { id: 'A', tr: track(0, -100) },
        { id: 'B', tr: track(20, -100) },
        { id: 'C', tr: track(40, -100) },
      ]),
      { me: 'B', group: ['C'] },
    );
    expect(frames(L)[0].boats.map((b) => b.role)).toEqual(['other', 'me', 'group']);
  });
});

describe('after the gun: over early', () => {
  const boats = [
    { id: 'Early', tr: track(0, -100) },
    { id: 'Late', tr: track(30, -100) },
    { id: 'Later', tr: track(45, -100) },
    { id: 'Never', tr: track(60, -100) },
    { id: 'Clean', tr: track(-30, -100) },
  ];
  const L = laneScrub(race(boats), { me: 'Early', replays: [rep('Early', 30), rep('Late', 90), rep('Later', 150), rep('Never', null)] });
  const over = (id: string) => frames(L).map((f) => boatIn(f, id).over);

  it('an OCS boat is over at a frame until it cleared (clearedMs), then cleared in every later frame', () => {
    expect(over('Early')).toEqual(['cleared', 'cleared', 'cleared']);
    expect(over('Late')).toEqual(['over', 'cleared', 'cleared']);
    expect(over('Later')).toEqual(['over', 'over', 'cleared']);
    expect(over('Never')).toEqual(['over', 'over', 'over']);
    expect(over('Clean')).toEqual([null, null, null]);
    expect(frames(L).map((f) => boatIn(f, 'Early').clearedMs)).toEqual([sec(30), sec(30), sec(30)]);
    expect(boatIn(frames(L)[0], 'Late').clearedMs).toBeNull();
    expect(boatIn(frames(L)[2], 'Late').clearedMs).toBe(sec(90));
  });

  it('not in the captions or labels: on the map, and the key\'s legend says what the rings mean', () => {
    const html = laneScrubHtml(race(boats), L);
    for (const f of frames(L)) expect(f.caption + f.label).not.toMatch(/OCS|over early|cleared/i);
    const key = html.split('<p class="lane-key muted">')[1];
    // Just the legend: no other over-early words in the key.
    expect(key.split('<span class="lane-legend">')[0]).not.toMatch(/OCS|ring|over early|cleared/i);
  });

  it('the legend: a solid ring "OCS" and a dashed ring "OCS, cleared", the swatches as the map draws them (aria-hidden)', () => {
    const html = laneScrubHtml(race(boats), L);
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
    const clean = laneScrub(race(boats), { me: 'Early', replays: [] });
    expect(laneScrubHtml(race(boats), clean)).not.toMatch(/lane-legend|lane-swatch|OCS/);
    const pending = laneScrub(race(boats), { me: 'Early', replays: null });
    expect(laneScrubHtml(race(boats), pending)).not.toMatch(/lane-legend|lane-swatch|OCS/);
  });

  it('the rings: solid while over, dashed once cleared, no "OCS" text; the dot\'s title says it, with when it cleared', () => {
    const fig = (s: number): string => laneScrubHtml(race(boats), L, undefined, s).split('<figure')[1].split('</figure>')[0];
    const html = laneScrubHtml(race(boats), L, undefined, 60);
    const first = fig(60);
    expect(first.match(/class="lane-over"/g)).toHaveLength(3);
    // At the gun all four are still over; by +3:00 only the one that never cleared.
    expect(fig(0).match(/class="lane-over"/g)).toHaveLength(4);
    expect(fig(180).match(/class="lane-over"/g)).toHaveLength(1);
    expect(first.match(/class="lane-over"[^>]*stroke-dasharray/g)).toBeNull();
    expect(first.match(/class="lane-cleared"[^>]*stroke-dasharray/g)).toHaveLength(1);
    expect(html).not.toMatch(/>OCS<\/text>|lane-ocs/);
    expect(first).toContain('<title>Late, over early (OCS)</title>');
    expect(first).toContain('<title>Early, over early (OCS), cleared +30 s</title>');
    expect(first).toContain('<title>Clean</title>');
    expect(html).not.toMatch(/lane-above|above the line/i);
  });

  it('no over marks before the replays are in', () => {
    const b = laneScrub(race(boats), { me: 'Early', replays: null });
    expect(frames(b).flatMap((f) => f.boats.map((x) => x.over)).every((x) => x == null)).toBe(true);
  });
});

describe('after the gun: data gaps', () => {
  it('a long gap over a frame: the boat is missing there (no position made up), and its trails break at the gap', () => {
    const L = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[40, 80], [95, 105]]) }]), { me: 'S' });
    const [f0, f1] = frames(L).map((f) => boatIn(f, 'S'));
    expect(f0.pos).toBeNull();
    expect(frames(L)[0].placed).toBe(0);
    expect(frames(L)[0].caption).toBe('S: no position (tracker gap).');
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
    const short = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[59, 61]]) }]), { me: 'S' });
    near(boatIn(frames(short)[0], 'S').pos, [0, -(-100 + 2 * 60)]);
    expect(boatIn(frames(short)[0], 'S').hold).toBe(false);
    // A gap +58 … +80: 2 s after the last fix, held there (hollow).
    const held = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[58, 80]]) }]), { me: 'S' });
    const h = boatIn(frames(held)[0], 'S');
    expect(h.hold).toBe(true);
    near(h.pos, [0, -(-100 + 2 * 58)]);
  });

  it('a feed that starts a fraction of a second after a frame places the boat at its first fix', () => {
    const tr = track(0, -100, 60);
    tr.t[0] += 100; // +60.1 s
    const L = laneScrub(race([{ id: 'A', tr }]), { me: 'A' });
    near(boatIn(frames(L)[0], 'A').pos, [0, -(-100 + 2 * 60)]);
    // …but not one that starts 10 s later.
    const late = laneScrub(race([{ id: 'A', tr: track(0, -100, 70) }, { id: 'B', tr: track(50, -100) }]), { me: 'A' });
    expect(boatIn(frames(late)[0], 'A').pos).toBeNull();
  });

  it("a frame with no positions and no trails: 'No tracks at this time.'", () => {
    // Tracking only from +2:30: the +1:00 and +2:00 frames are empty, the +3:00 frame draws.
    const L = laneScrub(race([{ id: 'A', tr: track(0, -100, 150) }, { id: 'B', tr: track(50, -100, 150) }]), { me: 'A' });
    expect(frames(L).map((f) => f.empty)).toEqual([true, true, false]);
    expect(frames(L)[0].caption).toBe('No tracks at this time.');
    expect(frames(L)[0].label).toBe('Fleet at gun +1:00: no tracks at this time.');
    expect(frames(L)[2].caption).toBe('A: ≈ 1 of 2');
    const html = laneScrubHtml(race([{ id: 'A', tr: track(0, -100, 150) }]), L);
    expect(html).toContain('class="lane-empty"');
    expect(html).toContain('>No tracks</text>');
  });

  it('the selected boat in a tracker gap: said once; other boats without a position not listed', () => {
    const L = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[40, 80]]) }, { id: 'A', tr: track(20, -100) }, { id: 'Ghost' }]), { me: 'S' });
    expect(frames(L)[0].caption).toBe('S: no position (tracker gap).');
    expect(frames(L)[0].label).toBe('Fleet at gun +1:00: 1 of 3 boats placed. S: no position (tracker gap). True wind from 0° (estimated).');
  });

  it('the selected boat with no track at all: "not tracked" once', () => {
    const L = laneScrub(race([{ id: 'A', tr: track(0, -100) }, { id: 'Ghost' }, { id: 'Gone' }]), { me: 'Ghost' });
    for (const f of frames(L)) {
      expect(f.caption).toBe('Ghost: not tracked.');
      expect(f.label.match(/Ghost/g)).toHaveLength(1);
      expect(f.label).not.toContain('Gone');
    }
  });

  it('a boat with no track at all: not placed in any frame, and out of the "of n"', () => {
    const L = laneScrub(race([{ id: 'A', tr: track(0, -100) }, { id: 'Ghost' }]), { me: 'A' });
    for (const f of frames(L)) {
      expect(f.placed).toBe(1);
      expect(f.caption).toBe('A: ≈ 1 of 1');
      expect(boatIn(f, 'Ghost').pos).toBeNull();
      expect(boatIn(f, 'Ghost').trail).toEqual([]);
    }
  });
});

describe('after the gun: renderer', () => {
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'B', tr: track(20, -100) },
    { id: 'C', tr: track(40, -100) },
  ]);
  const L = laneScrub(a, { me: 'B', group: ['C'], replays: [rep('A', 90)] });
  const html = laneScrubHtml(a, L, 'the top 3 (Coach group)', 60);

  it('one frame, the second asked for: an SVG with an accessible label, the fixed view, the line and the true-wind arrow', () => {
    expect(html.match(/<figure class="lane-frame/g)).toHaveLength(1);
    expect(html.match(/<svg class="chart lane-svg"/g)).toHaveLength(1);
    expect(html).toContain('role="img" aria-label="Fleet at gun +1:00: 3 of 3 boats placed. B: ≈ 2 of 3 upwind. True wind from 0° (estimated)."');
    expect(html).toContain('<figure class="lane-frame" data-s="60"><figcaption><b class="lane-time">gun +1:00</b> <span class="lane-cap">B: ≈ 2 of 3</span></figcaption>');
    expect(html).not.toMatch(/Trails from|Lane: across|pin to RC|Red ring|frame before| hidden/);
    const v = L.view;
    expect(html.match(new RegExp(`viewBox="${v.x0.toFixed(1)} ${v.y0.toFixed(1)}`, 'g'))).toHaveLength(1);
    expect(html.match(/class="startline"/g)).toHaveLength(1);
    expect(html).not.toMatch(/Mark 1|Toward|lane-markdir/);
    // The live region starts empty (the mount fills it once scrubbing settles).
    expect(html).toContain('<p class="lane-live" aria-live="polite"></p>');
  });

  it("the wind: a badge over the map's top-right corner (outside the SVG and its extent), pointing straight down, labelled with the TWD, marked estimated", () => {
    const badge = '<div class="lane-wind" title="True wind from 0° (estimated)"><svg class="lane-wind-arrow" viewBox="-8 -8 16 16" width="14" height="14" aria-hidden="true" focusable="false"><g transform="rotate(0.0)">';
    expect(html.split(badge)).toHaveLength(2);
    expect(html.match(/<span>TWD ~0° est\.<\/span><\/div>/g)).toHaveLength(1);
    // After the map's SVG, inside the map's box: not drawn in the map, so it takes none of its room.
    expect(html.match(/<\/svg><div class="lane-wind"/g)).toHaveLength(1);
    for (const svg of html.match(/<svg class="chart lane-svg"[\s\S]*?<\/svg>/g)!) expect(svg).not.toMatch(/lane-wind|TWD/);
    expect(windBadgeHtml(L)).toBe(html.match(/<div class="lane-wind"[\s\S]*?<\/div>/)![0]);
    expect(windBadgeHtml({ wind: null })).toBe('');
    // The key: who is highlighted, and the wind's source; nothing else.
    expect(html.split('<p class="lane-key muted">')[1].split('<span class="lane-legend">')[0]).toBe('B highlighted, with the top 3 (Coach group); the rest faded. True wind ↓ from the top, estimated from the fleet&#39;s tacks on the first beat.');
    // A true wind is drawn solid (dashed only when assumed).
    expect(windBadgeHtml(L)).not.toContain('dasharray');
    expect(frames(L)[0].label).toMatch(/True wind from 0° \(estimated\)\.$/);
  });

  it('a model wind is labelled as the model, not estimated', () => {
    const m = race([{ id: 'A', tr: track(0, -100) }], 18, 'model');
    const out = laneScrubHtml(m, laneScrub(m, { me: 'A' }));
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
    const big = laneScrubHtml(a, L, undefined, 0, ppu * 2);
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
    expect(body.innerHTML.match(/<figure class="lane-frame/g)).toHaveLength(1);
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
    expect(body.innerHTML.match(/<figure class="lane-frame/g)).toHaveLength(1);
    expect(asked).toBe(1);
  });
});

describe('after the gun: the fixed 3-minute extent', () => {
  // A: steady; Fast: 4 m/s (its +3:00 point sets the top); Gap: a tracker gap +40 … +80; Late: tracked only from +100 s.
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'Fast', tr: track(-60, -100, -120, 200, [], 4) },
    { id: 'Gap', tr: track(60, -120, -120, 200, [[40, 80]]) },
    { id: 'Late', tr: track(-30, -150, 100) },
  ]);
  const L = laneScrub(a, { me: 'A' });
  const inside = (p: readonly number[]): boolean => p[0] >= L.view.x0 && p[0] <= L.view.x1 && p[1] >= L.view.y0 && p[1] <= L.view.y1;

  it('contains every boat at every second 0 … 3:00, every trail point and the line', () => {
    for (let s = 0; s <= LANE_END_S; s++) {
      for (const b of L.frame(s).boats) {
        if (b.pos) expect(inside(b.pos), `${b.id} at +${s} s`).toBe(true);
        for (const p of b.trail.flat()) expect(inside(p)).toBe(true);
      }
    }
    expect(inside(L.line[0]) && inside(L.line[1])).toBe(true);
    // Fast at +3:00 is the furthest point: 100 m south at the gun + 720 m = 620 m north (map y −620), padded 8%.
    const top = -(-100 + 4 * 180);
    expect(L.view.y0).toBeLessThan(top);
    expect(L.view.y0).toBeGreaterThan(top - 0.2 * (L.view.y1 - L.view.y0));
  });

  it('is the same whatever the slider: one view, one viewBox, at every second', () => {
    const boxes = new Set<string>();
    for (const s of [0, 1, 37, 90, 179, 180]) {
      const html = laneScrubHtml(a, L, undefined, s);
      boxes.add(html.match(/class="chart lane-svg" viewBox="([^"]+)"/)![1]);
    }
    expect(boxes.size).toBe(1);
    // Early on the boats fill a small part of it: it is sized for +3:00, not for the second on show.
    const at0 = L.frame(0).boats.filter((b) => b.pos).map((b) => b.pos![1]);
    expect(Math.min(...at0)).toBeGreaterThan(L.view.y0 + 0.5 * (L.view.y1 - L.view.y0));
  });

  it('is the 3-minute extent: the line, every second’s positions and the trails to +3:00, through the same fit and guard', () => {
    const pts = [];
    for (let s = 0; s <= LANE_END_S; s++) for (const b of L.frame(s).boats) if (b.pos) pts.push(b.pos);
    for (const b of L.frame(LANE_END_S).boats) pts.push(...b.trail.flat());
    expect(L.view).toEqual(laneView(L.line, pts, Math.max(LANE_GUARD_LINES * 200, LANE_GUARD_MIN_M)));
  });
});

describe('after the gun: positions and trails on the 1 s grid', () => {
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'Gap', tr: track(60, -120, -120, 200, [[40, 80]]) },
    { id: 'Short', tr: track(30, -110, -120, 200, [[99, 101]]) },
    { id: 'Ends', tr: track(-30, -150, -120, 150) },
    { id: 'Ghost' },
  ]);
  const L = laneScrub(a, { me: 'Gap' });

  it('every second’s position is the existing lookup (placeAt: the scrubber’s, near-fix and gap rules)', () => {
    for (const d of a.drawings) {
      for (let s = 0; s <= LANE_END_S; s++) {
        const at = placeAt(d.id, legRanges(d, true), sec(s), drawingGapMs(d), 0);
        const b = boatIn(L.frame(s), d.id);
        if (!at) expect(b.pos, `${d.id} +${s} s`).toBeNull();
        else {
          expect(b.pos).toEqual([at.mx, at.my]);
          expect(b.hold).toBe(at.hold);
        }
      }
    }
  });

  it('every second’s trail is the trail worked out directly (laneTrail from gun −30 s)', () => {
    for (const d of a.drawings) {
      for (let s = 0; s <= LANE_END_S; s++) expect(boatIn(L.frame(s), d.id).trail).toEqual(laneTrail(a, d.id, 0, sec(LANE_TRAIL_FROM_S), sec(s)));
    }
  });

  it('a boat in a tracker gap has no position (held hollow for the first seconds); the caption says so', () => {
    const gap = (s: number) => boatIn(L.frame(s), 'Gap');
    expect(gap(40).pos).not.toBeNull();
    expect(gap(40).hold).toBe(false);
    // Held at the +40 fix for up to 5 s, then gone until the fix after the gap (+80).
    expect(gap(42).hold).toBe(true);
    near(gap(42).pos, [60, -(-120 + 2 * 40)]);
    // (Within 1 s of the fix after it, +79, the near-fix rule places it there.)
    for (const s of [46, 60, 78]) {
      expect(gap(s).pos).toBeNull();
      expect(L.frame(s).caption).toBe('Gap: no position (tracker gap).');
    }
    expect(gap(80).pos).not.toBeNull();
    // A 2 s step is no gap: interpolated.
    near(boatIn(L.frame(100), 'Short').pos, [30, -(-110 + 2 * 100)]);
    // After its track ends (+2:30): placed at its last fix for up to 1 s, then gone, the trail kept to its end.
    near(boatIn(L.frame(151), 'Ends').pos, [-30, -(-150 + 2 * 150)]);
    expect(boatIn(L.frame(152), 'Ends').pos).toBeNull();
    expect(boatIn(L.frame(170), 'Ends').trail).toEqual(boatIn(L.frame(150), 'Ends').trail);
    expect(boatIn(L.frame(90), 'Ghost').pos).toBeNull();
  });
});

describe('after the gun: the slider', () => {
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'B', tr: track(20, -100) },
  ]);
  const L = laneScrub(a, { me: 'B' });
  const disabled = (html: string): string[] => [...html.matchAll(/data-lane-step="(-?1)" aria-label="[^"]*"( disabled)?/g)].filter((m) => m[2]).map((m) => m[1]);
  const shownS = (html: string): number => Number(html.match(/<figure class="lane-frame[^"]*" data-s="(\d+)"/)![1]);

  it('the controls: ‹, play, the slider 0 … 180 s in 1 s steps (its spoken value the time), ›; at the gun ‹ is disabled', () => {
    const html = laneScrubHtml(a, L);
    expect(shownS(html)).toBe(0);
    expect(disabled(html)).toEqual(['-1']);
    expect(html).toContain('<button type="button" class="lane-step" data-lane-step="-1" aria-label="Back 1 second" disabled>‹</button>');
    expect(html).toContain('<button type="button" class="lane-step" data-lane-step="1" aria-label="Forward 1 second">›</button>');
    expect(html).toContain('<button type="button" class="lane-play" data-lane-play aria-pressed="false" aria-label="Play">');
    expect(html).toContain('<input type="range" class="lane-range" min="0" max="180" step="1" value="0" aria-label="Seconds after the gun" aria-valuetext="gun +0:00"');
    expect(html).toMatch(/data-s="0"><figcaption><b class="lane-time">gun \+0:00<\/b>.*?role="img" aria-label="Fleet at gun \+0:00: /);
    // No snapshot picker left.
    expect(html).not.toMatch(/data-lane-frame|Snapshot time|snapshot/i);
  });

  it('mid-way both steps on; at +3:00 › disabled; out-of-range seconds clamped', () => {
    const mid = laneScrubHtml(a, L, undefined, 83);
    expect(disabled(mid)).toEqual([]);
    expect(mid).toContain('value="83" aria-label="Seconds after the gun" aria-valuetext="gun +1:23"');
    expect(disabled(laneScrubHtml(a, L, undefined, 180))).toEqual(['1']);
    expect(shownS(laneScrubHtml(a, L, undefined, 999))).toBe(180);
    expect(shownS(laneScrubHtml(a, L, undefined, -4))).toBe(0);
    expect(laneScrubHtml(a, L, undefined, 0, undefined, true)).toContain('aria-pressed="true"');
  });

  it('steps and keys clamp to 0 … 180: ← → 1 s, Shift 10 s, Home / End the ends; other keys are not ours', () => {
    expect(LANE_SHIFT_STEP_S).toBe(10);
    expect(laneSecond(-1)).toBe(0);
    expect(laneSecond(200)).toBe(180);
    expect(laneSecond(7.6)).toBe(8);
    expect([stepLaneSecond(0, -1, 180), stepLaneSecond(0, 1, 180), stepLaneSecond(180, 1, 180), stepLaneSecond(179, 10, 180)]).toEqual([0, 1, 180, 180]);
    expect(laneKeyTarget('ArrowLeft', false, 50, 180)).toBe(49);
    expect(laneKeyTarget('ArrowRight', false, 50, 180)).toBe(51);
    expect(laneKeyTarget('ArrowLeft', true, 50, 180)).toBe(40);
    expect(laneKeyTarget('ArrowRight', true, 50, 180)).toBe(60);
    expect(laneKeyTarget('ArrowLeft', true, 5, 180)).toBe(0);
    expect(laneKeyTarget('ArrowRight', true, 175, 180)).toBe(180);
    expect(laneKeyTarget('ArrowLeft', false, 0, 180)).toBe(0);
    expect(laneKeyTarget('ArrowRight', false, 180, 180)).toBe(180);
    expect(laneKeyTarget('Home', false, 90, 180)).toBe(0);
    expect(laneKeyTarget('End', false, 90, 180)).toBe(180);
    for (const k of ['Enter', 'Tab', ' ', 'ArrowUp']) expect(laneKeyTarget(k, false, 90, 180)).toBeNull();
  });

  /** A mount on a stand-in body (a full paint each time: no stage to update in place). */
  function mounted(state: () => { me: string }) {
    const on: Record<string, (ev: unknown) => void> = {};
    const body = { innerHTML: '' };
    const root = { open: true, querySelector: () => body, addEventListener: (t: string, f: (ev: unknown) => void) => (on[t] = f) } as unknown as HTMLDetailsElement;
    const lanes = mountLaneSnapshots(root, () => ({ a, me: state().me, group: { kind: 'leaders' } }), () => Promise.resolve([]));
    lanes.refresh();
    return { on, body, root, lanes };
  }
  const btn = (attrs: Record<string, string>) => ({ target: { closest: () => ({ dataset: attrs }) } });

  it('mount: the slider, ‹ ›, the keys move it (clamped); the second kept across redraws (a boat change)', () => {
    let me = 'B';
    const { on, body, lanes } = mounted(() => ({ me }));
    expect(lanes.second()).toBe(0);
    on.click(btn({ laneStep: '1' }));
    expect(lanes.second()).toBe(1);
    expect(shownS(body.innerHTML)).toBe(1);
    on.click(btn({ laneStep: '-1' }));
    on.click(btn({ laneStep: '-1' }));
    expect(lanes.second()).toBe(0); // clamped
    on.input({ target: { classList: { contains: (c: string) => c === 'lane-range' }, value: '120' } });
    expect(lanes.second()).toBe(120);
    expect(body.innerHTML).toContain('value="120"');
    on.input({ target: { classList: { contains: () => false }, value: '5' } });
    expect(lanes.second()).toBe(120);
    let prevented = 0;
    const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, target: { closest: () => null }, preventDefault: () => prevented++ });
    on.keydown(key('ArrowLeft'));
    expect(lanes.second()).toBe(119);
    on.keydown(key('ArrowRight', true));
    expect(lanes.second()).toBe(129);
    on.keydown(key('End'));
    expect(lanes.second()).toBe(180);
    on.keydown(key('ArrowRight', true));
    expect(lanes.second()).toBe(180); // clamped
    on.keydown(key('Home'));
    expect(lanes.second()).toBe(0);
    expect(prevented).toBe(5);
    on.keydown(key('Tab'));
    expect(prevented).toBe(5);
    on.keydown(key('ArrowRight', true));
    me = 'A';
    lanes.refresh();
    expect(lanes.second()).toBe(10);
    expect(shownS(body.innerHTML)).toBe(10);
    expect(body.innerHTML).toContain('A highlighted');
  });

  it('mount: worked out once per race and selection; a refresh with nothing changed reuses it', () => {
    let me = 'B';
    const { lanes } = mounted(() => ({ me }));
    const first = lanes.scrub();
    lanes.refresh();
    expect(lanes.scrub()).toBe(first);
    me = 'A';
    lanes.refresh();
    expect(lanes.scrub()).not.toBe(first);
    expect(lanes.scrub()!.view).toEqual(first!.view);
  });

  it('mount: play steps a second every LANE_PLAY_MS and stops at +3:00; from the end it starts again; a step pauses it', () => {
    vi.useFakeTimers();
    try {
      const { on, lanes, root } = mounted(() => ({ me: 'B' }));
      on.click(btn({}));
      expect(lanes.playing()).toBe(true);
      vi.advanceTimersByTime(LANE_PLAY_MS * 30);
      expect(lanes.second()).toBe(30);
      on.click(btn({ laneStep: '1' }));
      expect(lanes.playing()).toBe(false);
      expect(lanes.second()).toBe(31);
      vi.advanceTimersByTime(LANE_PLAY_MS * 10);
      expect(lanes.second()).toBe(31);
      on.click(btn({}));
      vi.advanceTimersByTime(LANE_PLAY_MS * 400);
      expect(lanes.second()).toBe(180);
      expect(lanes.playing()).toBe(false);
      // From the end: back to the gun and on.
      on.click(btn({}));
      expect(lanes.second()).toBe(0);
      vi.advanceTimersByTime(LANE_PLAY_MS * 5);
      expect(lanes.second()).toBe(5);
      // Pressed again: paused.
      on.click(btn({}));
      expect(lanes.playing()).toBe(false);
      // Closing the section stops it too.
      on.click(btn({}));
      (root as { open: boolean }).open = false;
      vi.advanceTimersByTime(LANE_PLAY_MS);
      expect(lanes.playing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('mount: scrubbing redraws just the map and the controls’ state; the summary is said politely once it settles', () => {
    vi.useFakeTimers();
    try {
      const el = (): { innerHTML: string; textContent: string; value: string; disabled: boolean; attrs: Record<string, string>; setAttribute: (k: string, v: string) => void } => {
        const attrs: Record<string, string> = {};
        return { innerHTML: '', textContent: '', value: '', disabled: false, attrs, setAttribute: (k, v) => (attrs[k] = v) };
      };
      const parts: Record<string, ReturnType<typeof el>> = {};
      const body = {
        innerHTML: '',
        querySelector: (sel: string) => (body.innerHTML ? (parts[sel] ??= el()) : null),
      };
      const on: Record<string, (ev: unknown) => void> = {};
      const root = { open: true, querySelector: () => body, addEventListener: (t: string, f: (ev: unknown) => void) => (on[t] = f) } as unknown as HTMLDetailsElement;
      const lanes = mountLaneSnapshots(root, () => ({ a, me: 'B', group: { kind: 'leaders' } }), () => Promise.resolve([]));
      lanes.refresh();
      const full = body.innerHTML;
      for (let i = 0; i < 20; i++) on.click(btn({ laneStep: '1' }));
      expect(lanes.second()).toBe(20);
      // The body is not repainted; the stage, the slider and the steps are.
      expect(body.innerHTML).toBe(full);
      expect(parts['.lane-stage'].innerHTML).toMatch(/^<figure class="lane-frame" data-s="20">/);
      expect(parts['.lane-range'].value).toBe('20');
      expect(parts['.lane-range'].attrs['aria-valuetext']).toBe('gun +0:20');
      expect(parts['[data-lane-step="-1"]'].disabled).toBe(false);
      // Not said while it moves; said once, for the second it settled on.
      expect(parts['.lane-live']?.textContent ?? '').toBe('');
      vi.advanceTimersByTime(LANE_SAY_MS);
      expect(parts['.lane-live'].textContent).toBe('Fleet at gun +0:20: 2 of 2 boats placed. B: ≈ 2 of 2 upwind. True wind from 0° (estimated).');
      on.keydown({ key: 'End', shiftKey: false, preventDefault: () => {} });
      expect(parts['[data-lane-step="1"]'].disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('IC37 R5: USA 016 selected', () => {
  const data = ic37Race();
  const a = analyzeRace(data);
  const idOf = (sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
  const me = idOf('USA 016');
  const replays = startReplays(a, data);
  const L = laneScrub(a, { me, group: groupIds(a.boats, me, { kind: 'leaders' }), replays });
  const at = (i: number, sail: string) => boatIn(frames(L)[i], idOf(sail));

  it('+1:00, +2:00, +3:00: wind-up, every boat placed at each, every trail from gun −0:30 (the feed starts at −59.9 s)', () => {
    expect(frames(L).map((f) => f.title)).toEqual(['gun +1:00', 'gun +2:00', 'gun +3:00']);
    expect(L.windUp).toBe(true);
    for (const f of frames(L)) {
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
    expect(frames(L)[0].label).toMatch(/^Fleet at gun \+1:00: 15 of 15 boats placed\. USA 016: ≈ \d+ of 15 upwind\. True wind from \d+° \(estimated\)\.$/);
    for (const f of frames(L)) expect(f.caption + f.label).not.toMatch(/past the|third|% of the line|from pin/);
    // Never a mark's name.
    const html = laneScrubHtml(a, L);
    for (const name of new Set([...a.marks.map((m) => m.name), ...a.legs.map((l) => l.to)].filter(Boolean))) {
      for (const f of frames(L)) expect(f.caption + f.label).not.toContain(name);
      expect(html).not.toContain(`>${name}<`);
    }
    expect(html).not.toMatch(/Ofst|toward/i);
  });

  it('USA 017 and USA 019 (OCS, cleared ≈ +26 s and ≈ +35 s at the bow): cleared in every frame, from +1:00 on, on the map only', () => {
    for (const [sail, cleared] of [
      ['USA 017', 26],
      ['USA 019', 35],
    ] as const) {
      expect(frames(L).map((f) => boatIn(f, idOf(sail)).over)).toEqual(['cleared', 'cleared', 'cleared']);
      expect((at(0, sail).clearedMs! - a.meta.gunMs) / 1000).toBeCloseTo(cleared, -0.5);
    }
    for (const s of [60, 120, 180]) {
      const h = laneScrubHtml(a, L, undefined, s);
      expect(h.match(/<title>USA 017, over early \(OCS\), cleared \+26 s<\/title>/g)).toHaveLength(1);
      expect(h.match(/<title>USA 019, over early \(OCS\), cleared \+35 s<\/title>/g)).toHaveLength(1);
    }
    // At the gun both are still over (a solid ring, no clearing time yet).
    const atGun = laneScrubHtml(a, L, undefined, 0);
    expect(atGun).toContain('<title>USA 017, over early (OCS)</title>');
    expect(atGun).toContain('<title>USA 019, over early (OCS)</title>');
    const html = laneScrubHtml(a, L, undefined, 60);
    for (const f of frames(L)) expect(f.caption + f.label).not.toMatch(/OCS|cleared/);
    // The key's legend for the rings, both kinds.
    const legend = html.split('<span class="lane-legend">')[1];
    expect(legend).toMatch(/<circle class="lane-over"[^>]*\/><\/svg>OCS<\/span>/);
    expect(legend).toMatch(/<circle class="lane-cleared"[^>]*stroke-dasharray[^>]*\/><\/svg>OCS, cleared<\/span>/);
    // Nobody else is ever marked over.
    const others = frames(L).flatMap((f) => f.boats.filter((b) => b.over && b.id !== idOf('USA 017') && b.id !== idOf('USA 019')));
    expect(others).toEqual([]);
  });

  it('highlights USA 016 and its Coach group (the top 3)', () => {
    const roles = frames(L)[1].boats.filter((b) => b.role !== 'other');
    expect(roles.find((b) => b.role === 'me')!.sail).toBe('USA 016');
    expect(roles.filter((b) => b.role === 'group')).toHaveLength(3);
    const html = laneScrubHtml(a, L, undefined, 120);
    expect(html.match(/<figure class="lane-frame/g)).toHaveLength(1);
    expect(html.match(/class="lane-boat lane-me"/g)).toHaveLength(1);
  });

  it('the slider over the real feed: every second placed by the existing lookup, trails as worked out directly, all inside the fixed view', () => {
    const twd = a.wind.twdAtGunDeg;
    const inside = (p: Vec): boolean => p[0] >= L.view.x0 && p[0] <= L.view.x1 && p[1] >= L.view.y0 && p[1] <= L.view.y1;
    for (const d of a.drawings) {
      const away = a.boats.find((b) => b.id === d.id)?.start?.awayFromLine;
      for (let s = 0; s <= LANE_END_S; s++) {
        const at = placeAt(d.id, legRanges(d, true), a.meta.gunMs + s * 1000, drawingGapMs(d), twd);
        const b = boatIn(L.frame(s), d.id);
        expect(b.pos).toEqual(at ? [at.mx, at.my] : null);
        if (b.pos && !away) expect(inside(b.pos), `${b.sail} at +${s} s`).toBe(true);
      }
      for (const s of [0, 45, 133, 180]) expect(boatIn(L.frame(s), d.id).trail).toEqual(laneTrail(a, d.id, twd, a.meta.gunMs + LANE_TRAIL_FROM_S * 1000, a.meta.gunMs + s * 1000));
    }
    // One view for the whole slider: the same viewBox at the gun and at +3:00.
    const box = (s: number): string => laneScrubHtml(a, L, undefined, s).match(/class="chart lane-svg" viewBox="([^"]+)"/)![1];
    expect(box(0)).toBe(box(180));
  });
});
