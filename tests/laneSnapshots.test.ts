import { describe, expect, it, vi } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { groupIds } from '../src/analysis/coach/groups';
import type { Vec } from '../src/analysis/geo';
import { startReplays, type StartReplay } from '../src/analysis/startReplay';
import { PRE_LEG, type BoatDrawing, type RaceAnalysis, type TrackSegment } from '../src/analysis/types';
import { endHoldBefore, legRanges } from '../src/ui/mapPieces';
import { drawingGapMs } from '../src/ui/mapPoints';
import {
  LANE_END_S,
  LANE_START_S,
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
  LANE_CUE_GUN_S,
  LANE_CUE_PRE_S,
  LANE_DEFAULT_W_PX,
  LANE_MAX_H_PX,
  LANE_PLAY_MS,
  LANE_SAY_MS,
  LANE_SHIFT_STEP_S,
  LANE_ZOOMS,
  laneCueSecond,
  laneFollowInput,
  laneFollowTarget,
  laneKeyTarget,
  lanePxPerUnit,
  laneScrubHtml,
  laneShape,
  laneVisible,
  laneZoomTarget,
  mountLaneSnapshots,
  pxToUnits,
  stepLaneSecond,
  windBadgeHtml,
} from '../src/ui/laneSnapshotsView';
import { ocsLegend, ocsStretch, ocsSvg } from '../src/ui/ocsStyle';
import { BOAT_SHAPE_MIN_PX, BOAT_SHAPE_ON_PX, BOAT_SHAPE_PX, BOAT_STALE_MS } from '../src/ui/boatShape';
import { MAP_HOLD_S } from '../src/ui/mapPieces';
import { BOAT_TRAIL_MS, TRAIL_FADE } from '../src/ui/trail';
import { courseStats } from '../src/ui/follow';
import { clampView, fitView, presetActive, viewBox, zoomPreset, type View } from '../src/ui/view';
import { ic37Race } from './helpers';

/**
 * Around the gun (Start tab): a time slider −1:30 … +3:00. A synthetic start (line from (−100, 0) pin to (100, 0) RC,
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
  /** Its finish, s from the gun (none: no finish). */
  finishS?: number;
}

function race(boats: BoatSpec[], twd = 0, method: 'tacks' | 'model' | 'course' = 'tacks', mark: Vec = [0, 1000], line: [Vec, Vec] = [[-100, 0], [100, 0]]): RaceAnalysis {
  return {
    meta: { gunMs: GUN, tzOffsetMs: 0 },
    line: { left: line[0], right: line[1], lengthM: Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) },
    legPts: [[0, 0], mark, [0, 0]],
    legs: [{ index: 0, name: 'Beat 1', kind: 'upwind', to: 'Mark 1' }],
    marks: [{ name: 'Mark 1', xy: [mark] }],
    wind: { method, estimates: [], twdAtGunDeg: twd, model: null },
    boats: boats.map((b, i) => ({ id: b.id, sail: b.id, colorSlot: i, finishPos: i + 1, finishMs: b.finishS == null ? null : sec(b.finishS), legs: [] })),
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

describe('around the gun: frames and trails', () => {
  const a = race([{ id: 'A', tr: track(0, -100) }]);
  const L = laneScrub(a, { me: 'A' });

  it('a frame at every second from gun −1:30 to +3:00 (clamped, to the whole second); every trail from gun −1:30', () => {
    expect([LANE_START_S, LANE_END_S, LANE_STEP_S, L.start, L.end]).toEqual([-90, 180, 1, -90, 180]);
    expect(LANE_TRAIL_FROM_S).toBe(-90);
    expect([-90, -72, -1, 0, 1, 45, 83, 180].map((s) => L.frame(s).title)).toEqual(['gun −1:30', 'gun −1:12', 'gun −0:01', 'gun +0:00', 'gun +0:01', 'gun +0:45', 'gun +1:23', 'gun +3:00']);
    expect(L.frame(-5).s).toBe(-5);
    expect(L.frame(-91).s).toBe(-90);
    expect(L.frame(-1e9).s).toBe(-90);
    expect(Object.is(L.frame(-0.2).s, 0)).toBe(true);
    expect(L.frame(181).s).toBe(180);
    expect(L.frame(12.4).s).toBe(12);
    expect(L.frame(NaN).s).toBe(0);
    // Memoised: the same frame object for the same second.
    expect(L.frame(83)).toBe(L.frame(83.2));
    expect(frames(L).map((f) => f.s)).toEqual([60, 120, 180]);
    expect(frames(L).map((f) => f.t)).toEqual([sec(60), sec(120), sec(180)]);
    expect(frames(L).map((f) => f.from)).toEqual([sec(-90), sec(-90), sec(-90)]);
    // Before the gun too: a frame at −1:00 with its trail from −1:30.
    near(boatIn(L.frame(-60), 'A').pos, [0, -(-100 + 2 * -60)]);
    expect(boatIn(L.frame(-60), 'A').trail[0]).toHaveLength(31);
    expect(frames(L).map((f) => f.title)).toEqual(['gun +1:00', 'gun +2:00', 'gun +3:00']);
  });

  it("the boat's position at each frame (wind from the north: north up, y down) and a trail from its position BOAT_TRAIL_MS before", () => {
    const [f0, f1, f2] = frames(L).map((f) => boatIn(f, 'A'));
    near(f0.pos, [0, -(-100 + 2 * 60)]);
    near(f1.pos, [0, -(-100 + 2 * 120)]);
    near(f2.pos, [0, -(-100 + 2 * 180)]);
    // One unbroken trail each, across the pre-start / leg boundary, from 2 min before the frame to the frame.
    for (const [b, s] of [[f0, 60], [f1, 120], [f2, 180]] as const) {
      expect(b.trail).toHaveLength(1);
      near(b.trail[0][0], [0, -(-100 + 2 * (s - BOAT_TRAIL_MS / 1000))]);
      near(b.trail[0].at(-1)!, b.pos!);
    }
    // 1 Hz, the gun's shared fix kept once: 2 min is 121 points.
    expect([f0, f1, f2].map((b) => b.trail[0].length)).toEqual([121, 121, 121]);
    // Fading toward the tail: one path per slice, head first, the head's slice ending at the boat.
    expect(f2.fade).toHaveLength(TRAIL_FADE.length);
    expect(f2.fade.every(Boolean)).toBe(true);
    expect(f2.fade[0].endsWith(`L0.0,${(-(-100 + 2 * 180)).toFixed(1)}`)).toBe(true);
    expect(f2.fade.at(-1)!.startsWith(`M0.0,${(-(-100 + 2 * 60)).toFixed(1)}`)).toBe(true);
  });

  it('trails start at gun −1:30 at the earliest (inclusive), and reach back BOAT_TRAIL_MS', () => {
    expect(BOAT_TRAIL_MS).toBe(120_000);
    // The data from −120 s: the earliest trail point is the −90 s fix, or 2 min before the frame (map y = −north).
    for (const f of [L.frame(-90), L.frame(-30), L.frame(30), ...frames(L)]) {
      const ys = boatIn(f, 'A').trail.flat().map((p) => -p[1]);
      if (f.s > -90) expect(Math.min(...ys)).toBeCloseTo(-100 + 2 * Math.max(-90, f.s - 120), 6);
    }
    // At −1:30 itself: no trail yet (a single point), the boat placed.
    expect(boatIn(L.frame(-90), 'A').trail).toEqual([]);
    near(boatIn(L.frame(-90), 'A').pos, [0, -(-100 + 2 * -90)]);
    // A feed that starts exactly at −90 s: the trail still starts there.
    const exact = laneScrub(race([{ id: 'A', tr: track(0, -100, -90) }]), { me: 'A' });
    near(boatIn(exact.frame(0), 'A').trail[0][0], [0, -(-100 + 2 * -90)]);
  });

  it('a trail starts where the data does when that is after −1:30; the caption says nothing about it', () => {
    const b = laneScrub(race([{ id: 'A', tr: track(0, -100, -10) }]), { me: 'A' });
    const t0 = boatIn(frames(b)[0], 'A').trail[0];
    near(t0[0], [0, -(-100 + 2 * -10)]);
    expect(t0).toHaveLength(71);
    expect(frames(b)[0].caption).toBe('A: ≈ 1 of 1');
    const afterGun = laneScrub(race([{ id: 'A', tr: track(0, -100, 5) }]), { me: 'A' });
    expect(frames(afterGun)[0].caption + frames(afterGun)[0].label).not.toMatch(/Tracking starts|No data before|trails from/i);
  });
});

describe('around the gun: orientation and the true wind', () => {
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
    // x: the line (−100 … 100), padded 8% of 200 = 16 m. y: its position 280 m south at −1:30 (map y +280),
    // to its position 260 m north at +3:00 (map y −260): 540 m, padded 43.2 m. Nothing else.
    expect(LANE_PAD).toBe(0.08);
    expect(L.view.x0).toBeCloseTo(-116, 3);
    expect(L.view.x1).toBeCloseTo(116, 3);
    expect(L.view.y0).toBeCloseTo(-260 - 43.2, 3);
    expect(L.view.y1).toBeCloseTo(280 + 43.2, 3);
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

describe('around the gun: captions', () => {
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

describe('around the gun: over early', () => {
  const boats = [
    { id: 'Early', tr: track(0, -100) },
    { id: 'Late', tr: track(30, -100) },
    { id: 'Later', tr: track(45, -100) },
    { id: 'Never', tr: track(60, -100) },
    { id: 'Clean', tr: track(-30, -100) },
  ];
  const L = laneScrub(race(boats), { me: 'Early', replays: [rep('Early', 30), rep('Late', 90), rep('Later', 150), rep('Never', null)] });
  const a0 = () => race(boats);
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

  it('not in the captions or labels: on the map, and the key\'s legend says what the styling means', () => {
    const html = laneScrubHtml(race(boats), L);
    for (const f of frames(L)) expect(f.caption + f.label).not.toMatch(/OCS|over early|cleared/i);
    const key = html.split('<p class="lane-key muted">')[1];
    // Just the legend: no other over-early words in the key.
    expect(key.split('<span class="ocs-legend">')[0]).not.toMatch(/OCS|ring|over early|cleared/i);
  });

  it('the legend: the over-the-line track, the dip back, where it went back and cleared, drawn as the maps draw them (aria-hidden)', () => {
    const html = laneScrubHtml(race(boats), L);
    expect(html).toContain(ocsLegend());
    const items = ocsLegend().match(/<span class="ocs-legend-item">.*?<\/svg>[^<]*<\/span>/g)!;
    expect(items.map((i) => i.replace(/.*<\/svg>/, '').replace('</span>', ''))).toEqual(['Over early', 'Going back', 'Back', 'Cleared']);
    for (const i of items) expect(i).toContain('aria-hidden="true" focusable="false"');
    // The race view's classes (style.css: --bad red, a surface casing; dashed going back; a hollow ring, a filled dot).
    expect(items[0]).toMatch(/class="ocs-case".*class="ocs-over"/);
    expect(items[1]).toMatch(/class="ocs-dip"[^>]*stroke-dasharray/);
    expect(items[2]).toContain('class="ocs-mark back"');
    expect(items[3]).toContain('class="ocs-mark clear"');
    expect(html.match(/class="ocs-legend"/g)).toHaveLength(1);
    expect(html).not.toMatch(/lane-over|lane-cleared|lane-legend|lane-swatch/);
  });

  it('no legend when no boat was over early (none OCS, or the replays not in yet)', () => {
    const clean = laneScrub(race(boats), { me: 'Early', replays: [] });
    expect(laneScrubHtml(race(boats), clean)).not.toMatch(/ocs-legend|ocs-swatch|OCS|ocs-over/);
    const pending = laneScrub(race(boats), { me: 'Early', replays: null });
    expect(laneScrubHtml(race(boats), pending)).not.toMatch(/ocs-legend|ocs-swatch|OCS|ocs-over/);
  });

  it('the track map\'s OCS styling: red over the line, dashed red going back until cleared, a ring where it went back and a dot where it cleared; the title says it', () => {
    const fig = (s: number): string => laneScrubHtml(race(boats), L, undefined, s).split('<figure')[1].split('</figure>')[0];
    const count = (h: string, re: RegExp): number => h.match(re)?.length ?? 0;
    const html = laneScrubHtml(race(boats), L, undefined, 60);
    const first = fig(60);
    // Over the line from −2 s to going back at +10 s: all four OCS boats; the clean one never.
    expect(count(first, /<polyline class="ocs-over"/g)).toBe(4);
    // Going back from +10 s, drawn until it cleared (Early at +30 s) or to the frame (the rest), dashed.
    expect(count(first, /<polyline class="ocs-dip"[^>]*stroke-dasharray/g)).toBe(4);
    expect(count(first, /class="ocs-mark back"/g)).toBe(4);
    expect(count(first, /class="ocs-mark clear"/g)).toBe(1);
    // A minute before the gun: none over yet. At the gun: over the line only, nothing back yet.
    expect(fig(-60)).not.toMatch(/ocs-/);
    expect(count(fig(0), /<polyline class="ocs-over"/g)).toBe(4);
    expect(fig(0)).not.toMatch(/ocs-dip|ocs-mark/);
    // +3:00: every clearing reached (Never: still going back, no clearing).
    expect(count(fig(180), /class="ocs-mark clear"/g)).toBe(3);
    // Exactly the shared helper's drawing, the same as the track map's replay (non-scaling here).
    const ppu = lanePxPerUnit(L.view);
    const want = ocsSvg(boatIn(L.frame(60), 'Late').ocs!, { unit: 1 / ppu, nonScaling: true });
    expect(first).toContain(want.tracks);
    expect(first).toContain(want.marks);
    // The stretch is the replay's: Early's dip ends where it cleared, at +30 s (2 m/s north from −100 m: 40 m north).
    const early = boatIn(L.frame(60), 'Early').ocs!;
    near(early.dip[0].at(-1)!, [0, -(-100 + 2 * 30)]);
    near(early.clear!, [0, -(-100 + 2 * 30)]);
    expect(early).toEqual(ocsStretch(rep('Early', 30), legRanges(a0().drawings[0], true), drawingGapMs(a0().drawings[0]), 0, sec(60), [sec(-90), sec(60)]));
    // Never faded with the boat, no "OCS" text on the map; the boat's title says it.
    expect(html).not.toMatch(/>OCS<\/text>/);
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

describe('around the gun: data gaps', () => {
  it('a long gap over a frame: the boat held hollow at its last fix (no position made up), and its trails break at the gap', () => {
    const L = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[40, 80], [95, 105]]) }]), { me: 'S' });
    const [f0, f1] = frames(L).map((f) => boatIn(f, 'S'));
    // 20 s into the gap: at the +40 fix, hollow (stale), still pointing up the course.
    near(f0.pos, [0, -(-100 + 2 * 40)]);
    expect([f0.hold, f0.stale]).toEqual([true, true]);
    near(f0.lastDir, [0, -1]);
    expect(frames(L)[0].caption).toBe('S: ≈ 1 of 1 (last fix)');
    // −60 → +40 drawn, nothing made up past the last fix before the gap.
    expect(f0.trail).toHaveLength(1);
    near(f0.trail[0].at(-1)!, [0, -(-100 + 2 * 40)]);
    // 0 → +120: to +40, then from the fix after the gap (+80) on to +120, the 10 s gap +95 … +105 filled in (ui/gapFill.ts) and drawn lighter.
    expect(f1.trail).toHaveLength(2);
    near(f1.trail[0][0], [0, 100]);
    near(f1.trail[1][0], [0, -(-100 + 2 * 80)]);
    expect(f1.trail[1].some(([x, y]) => Math.abs(x) < 0.5 && Math.abs(y + (-100 + 2 * 100)) < 0.5)).toBe(true);
    expect(f1.fadeEst.some(Boolean)).toBe(true);
    near(f1.pos, [0, -(-100 + 2 * 120)]);
    expect([f1.hold, f1.stale]).toEqual([false, false]);
    // A gap longer than MAP_HOLD_S: missing once the hold runs out.
    const long = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[5, 180]]) }]), { me: 'S' });
    expect(MAP_HOLD_S).toBe(120);
    expect(boatIn(long.frame(5 + MAP_HOLD_S - 1), 'S').pos).not.toBeNull();
    expect(boatIn(long.frame(5 + MAP_HOLD_S + 5), 'S').pos).toBeNull();
    expect(long.frame(5 + MAP_HOLD_S + 5).placed).toBe(0);
  });

  it('a short step (within the gap rule) is interpolated; just inside a gap the dot holds at the last fix (the scrubber rule)', () => {
    // 1 Hz with the fix at +60 missing: a 2 s step, not a gap.
    const short = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[59, 61]]) }]), { me: 'S' });
    near(boatIn(frames(short)[0], 'S').pos, [0, -(-100 + 2 * 60)]);
    expect(boatIn(frames(short)[0], 'S').hold).toBe(false);
    // A hole +58 … +80 (22 s, up to SHORT_GAP_S): filled in (ui/gapFill.ts), the boat placed on it, filled.
    const filled = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[58, 80]]) }]), { me: 'S' });
    const f = boatIn(frames(filled)[0], 'S');
    expect([f.hold, f.stale]).toEqual([false, false]);
    near(f.pos, [0, -(-100 + 2 * 60)], 0.5);
    // A hole +58 … +100 (42 s): held at its last fix, hollow from the start (BOAT_STALE_MS is SHORT_GAP_S).
    const held = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[58, 100]]) }]), { me: 'S' });
    const h = boatIn(frames(held)[0], 'S');
    expect([h.hold, h.stale]).toEqual([true, true]);
    near(h.pos, [0, -(-100 + 2 * 58)]);
    expect(BOAT_STALE_MS).toBe(30_000);
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
    // Its last fix 130 s before +1:00 (more than MAP_HOLD_S): no position.
    const L = laneScrub(race([{ id: 'S', tr: track(0, -100, -120, 180, [[-70, 180]]) }, { id: 'A', tr: track(20, -100) }, { id: 'Ghost' }]), { me: 'S' });
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

describe('around the gun: renderer', () => {
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
    expect(html.split('<p class="lane-key muted">')[1].split('<span class="ocs-legend">')[0]).toBe('B highlighted, with the top 3 (Coach group); the rest faded. True wind ↓ from the top, estimated from the fleet&#39;s tacks on the first beat.');
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

  it('lines, trails, dots and the OCS styling keep their stroke width on screen (non-scaling)', () => {
    expect(html).toMatch(/<line class="startline" [^>]*stroke-width="2.2" vector-effect="non-scaling-stroke"\/>/);
    for (const m of html.match(/<path class="lane-trail[^>]*>/g)!) expect(m).toContain('vector-effect="non-scaling-stroke"');
    for (const m of html.match(/<circle class="lane-dot[^>]*>/g)!) expect(m).toContain('vector-effect="non-scaling-stroke"');
    expect(html).toMatch(/<polyline class="ocs-over" [^>]*stroke-width="3.20" vector-effect="non-scaling-stroke"\/>/);
    const fig = html.split('<figure')[1].split('</figure>')[0];
    for (const m of fig.match(/<(polyline|circle) class="ocs-[^>]*>/g)!) expect(m).toContain('vector-effect="non-scaling-stroke"');
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  it('the selected boat and its group highlighted (labelled), the rest faded; the over-early track', () => {
    expect(html).toContain('class="lane-boat lane-me" data-id="B"');
    expect(html).toContain('class="lane-boat lane-group" data-id="C"');
    expect(html).toContain('class="lane-boat lane-other dim" data-id="A"');
    expect(html).toContain('class="lane-trail lane-other dim"');
    expect(html).toMatch(/class="lane-lbl on"[^>]*>B</);
    expect(html).toContain('class="ocs-over"');
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
    expect(body.innerHTML).toContain('class="ocs-over"');
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

describe('around the gun: the default extent over the whole slider (−1:30 … +3:00)', () => {
  // A: steady; Fast: 4 m/s (its +3:00 point sets the top); Gap: a tracker gap +40 … +80; Late: tracked only from +100 s.
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'Fast', tr: track(-60, -100, -120, 200, [], 4) },
    { id: 'Gap', tr: track(60, -120, -120, 200, [[40, 80]]) },
    { id: 'Late', tr: track(-30, -150, 100) },
  ]);
  const L = laneScrub(a, { me: 'A' });
  const inside = (p: readonly number[]): boolean => p[0] >= L.view.x0 && p[0] <= L.view.x1 && p[1] >= L.view.y0 && p[1] <= L.view.y1;

  it('contains every boat at every second −1:30 … +3:00, every trail point and the line', () => {
    for (let s = LANE_START_S; s <= LANE_END_S; s++) {
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
    for (const s of [-90, -45, -1, 0, 1, 37, 90, 179, 180]) {
      const html = laneScrubHtml(a, L, undefined, s);
      boxes.add(html.match(/class="chart lane-svg" viewBox="([^"]+)"/)![1]);
    }
    expect(boxes.size).toBe(1);
    // …and it is the fit box itself (Fit, the default zoom).
    const v = L.view;
    expect([...boxes][0]).toBe(`${v.x0.toFixed(1)} ${v.y0.toFixed(1)} ${(v.x1 - v.x0).toFixed(1)} ${(v.y1 - v.y0).toFixed(1)}`);
    // Early on the boats fill a small part of it: it is sized for +3:00, not for the second on show.
    const at0 = L.frame(0).boats.filter((b) => b.pos).map((b) => b.pos![1]);
    expect(Math.min(...at0)).toBeGreaterThan(L.view.y0 + 0.5 * (L.view.y1 - L.view.y0));
  });

  it('is the whole slider’s extent: the line, every second’s positions and the trails to +3:00, through the same fit and guard', () => {
    const pts = [];
    for (let s = LANE_START_S; s <= LANE_END_S; s++) for (const b of L.frame(s).boats) if (b.pos) pts.push(b.pos);
    for (const b of L.frame(LANE_END_S).boats) pts.push(...b.trail.flat());
    expect(L.view).toEqual(laneView(L.line, pts, Math.max(LANE_GUARD_LINES * 200, LANE_GUARD_MIN_M)));
  });
});

describe('around the gun: positions and trails on the 1 s grid', () => {
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'Gap', tr: track(60, -120, -120, 200, [[40, 80]]) },
    { id: 'Short', tr: track(30, -110, -120, 200, [[99, 101]]) },
    { id: 'Ends', tr: track(-30, -150, -120, 150) },
    { id: 'Done', tr: track(-60, -150, -120, 150), finishS: 150 },
    { id: 'Ghost' },
  ]);
  const L = laneScrub(a, { me: 'Gap' });

  it('every second’s position is the existing lookup (placeAt: the scrubber’s, near-fix and gap rules)', () => {
    for (const d of a.drawings) {
      for (let s = LANE_START_S; s <= LANE_END_S; s++) {
        const at = placeAt(d.id, legRanges(d, true), sec(s), drawingGapMs(d), 0, endHoldBefore(a.boats.find((b) => b.id === d.id)!.finishMs));
        const b = boatIn(L.frame(s), d.id);
        if (!at) expect(b.pos, `${d.id} +${s} s`).toBeNull();
        else {
          expect(b.pos).toEqual([at.mx, at.my]);
          expect(b.hold).toBe(at.hold);
        }
      }
    }
  });

  it('every second’s trail is the trail worked out directly (laneTrail over the 2 min before, from gun −1:30 at the earliest)', () => {
    for (const d of a.drawings) {
      for (let s = LANE_START_S; s <= LANE_END_S; s++) {
        const from = Math.max(sec(LANE_TRAIL_FROM_S), sec(s) - BOAT_TRAIL_MS);
        expect(boatIn(L.frame(s), d.id).trail).toEqual(laneTrail(a, d.id, 0, from, sec(s)));
      }
    }
  });

  it('a boat in a tracker gap over SHORT_GAP_S is held at its last fix, hollow; one whose tracker stops is filled for BOAT_STALE_MS; the caption says so', () => {
    const gap = (s: number) => boatIn(L.frame(s), 'Gap');
    expect(gap(40).pos).not.toBeNull();
    expect(gap(40).hold).toBe(false);
    // Held at the +40 fix through the 40 s gap (it is shorter than MAP_HOLD_S), until the fix after it (+80): hollow throughout.
    expect(gap(42).hold).toBe(true);
    expect(gap(42).stale).toBe(true);
    near(gap(42).pos, [60, -(-120 + 2 * 40)]);
    // (Within 1 s of the fix after it, +79, the near-fix rule places it there.)
    for (const s of [46, 60, 78]) {
      near(gap(s).pos, [60, -(-120 + 2 * 40)]);
      expect([gap(s).hold, gap(s).stale]).toEqual([true, true]);
      expect(L.frame(s).caption).toMatch(/^Gap: ≈ \d of \d \(last fix\)$/);
    }
    expect(gap(80).pos).not.toBeNull();
    expect(gap(80).stale).toBe(false);
    // A 2 s step is no gap: interpolated.
    near(boatIn(L.frame(100), 'Short').pos, [30, -(-110 + 2 * 100)]);
    // Its tracker stops at +2:30 with no finish: held at its last fix, filled for BOAT_STALE_MS (30 s: to the slider's end), the trail kept to its end.
    const ends = (s: number) => boatIn(L.frame(s), 'Ends');
    for (const s of [151, 153, 170, 180]) {
      near(ends(s).pos, [-30, -(-150 + 2 * 150)]);
      expect([ends(s).hold, ends(s).stale]).toEqual([true, false]);
    }
    near(ends(170).trail.at(-1)!.at(-1)!, [-30, -(-150 + 2 * 150)]);
    // The same track ending at its finish: finished, not lost; at its last fix for up to 1 s (the near-fix rule), then gone.
    near(boatIn(L.frame(151), 'Done').pos, [-60, -(-150 + 2 * 150)]);
    expect(boatIn(L.frame(151), 'Done').hold).toBe(false);
    expect(boatIn(L.frame(152), 'Done').pos).toBeNull();
    expect(boatIn(L.frame(90), 'Ghost').pos).toBeNull();
  });
});

describe('around the gun: the slider', () => {
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'B', tr: track(20, -100) },
  ]);
  const L = laneScrub(a, { me: 'B' });
  const disabled = (html: string): string[] => [...html.matchAll(/data-lane-step="(-?1)" aria-label="[^"]*"( disabled)?/g)].filter((m) => m[2]).map((m) => m[1]);
  const shownS = (html: string): number => Number(html.match(/<figure class="lane-frame[^"]*" data-s="(-?\d+)"/)![1]);

  it('the controls: ‹, play, the slider −90 … 180 s in 1 s steps (its spoken value the time), ›; it opens at the gun; at −1:30 ‹ is disabled', () => {
    const html = laneScrubHtml(a, L);
    expect(shownS(html)).toBe(0);
    expect(disabled(html)).toEqual([]);
    expect(html).toContain('<button type="button" class="lane-step" data-lane-step="1" aria-label="Forward 1 second">›</button>');
    expect(html).toContain('<button type="button" class="lane-play" data-lane-play aria-pressed="false" aria-label="Play">');
    expect(html).toContain('<input type="range" class="lane-range" min="-90" max="180" step="1" value="0" aria-label="Seconds from the gun" aria-valuetext="gun +0:00"');
    const first = laneScrubHtml(a, L, undefined, -90);
    expect(disabled(first)).toEqual(['-1']);
    expect(first).toContain('<button type="button" class="lane-step" data-lane-step="-1" aria-label="Back 1 second" disabled>‹</button>');
    expect(first).toContain('value="-90" aria-label="Seconds from the gun" aria-valuetext="gun −1:30"');
    expect(laneScrubHtml(a, L, undefined, -72)).toContain('aria-valuetext="gun −1:12"');
    expect(html).toMatch(/data-s="0"><figcaption><b class="lane-time">gun \+0:00<\/b>.*?role="img" aria-label="Fleet at gun \+0:00: /);
    // No snapshot picker left.
    expect(html).not.toMatch(/data-lane-frame|Snapshot time|snapshot/i);
  });

  it('mid-way both steps on; at +3:00 › disabled; out-of-range seconds clamped', () => {
    const mid = laneScrubHtml(a, L, undefined, 83);
    expect(disabled(mid)).toEqual([]);
    expect(mid).toContain('value="83" aria-label="Seconds from the gun" aria-valuetext="gun +1:23"');
    expect(disabled(laneScrubHtml(a, L, undefined, 180))).toEqual(['1']);
    expect(shownS(laneScrubHtml(a, L, undefined, 999))).toBe(180);
    expect(shownS(laneScrubHtml(a, L, undefined, -4))).toBe(-4);
    expect(shownS(laneScrubHtml(a, L, undefined, -999))).toBe(-90);
    expect(laneScrubHtml(a, L, undefined, 0, undefined, true)).toContain('aria-pressed="true"');
  });

  it('steps and keys clamp to −90 … 180: ← → 1 s, Shift 10 s, Home / End the ends; other keys are not ours', () => {
    expect(LANE_SHIFT_STEP_S).toBe(10);
    expect(laneSecond(-1)).toBe(-1);
    expect(laneSecond(-91)).toBe(-90);
    expect(laneSecond(200)).toBe(180);
    expect(laneSecond(7.6)).toBe(8);
    expect(laneSecond(-7.6)).toBe(-8);
    expect(laneSecond(NaN)).toBe(0);
    expect([stepLaneSecond(0, -1, 180), stepLaneSecond(-90, -1, 180), stepLaneSecond(-89, -10, 180), stepLaneSecond(180, 1, 180), stepLaneSecond(179, 10, 180)]).toEqual([-1, -90, -90, 180, 180]);
    expect(laneKeyTarget('ArrowLeft', false, 50, 180)).toBe(49);
    expect(laneKeyTarget('ArrowRight', false, 50, 180)).toBe(51);
    expect(laneKeyTarget('ArrowLeft', true, 50, 180)).toBe(40);
    expect(laneKeyTarget('ArrowRight', true, 50, 180)).toBe(60);
    expect(laneKeyTarget('ArrowLeft', true, 5, 180)).toBe(-5);
    expect(laneKeyTarget('ArrowLeft', true, -85, 180)).toBe(-90);
    expect(laneKeyTarget('ArrowRight', true, 175, 180)).toBe(180);
    expect(laneKeyTarget('ArrowLeft', false, -90, 180)).toBe(-90);
    expect(laneKeyTarget('ArrowRight', false, 180, 180)).toBe(180);
    expect(laneKeyTarget('Home', false, 90, 180)).toBe(-90);
    expect(laneKeyTarget('End', false, -30, 180)).toBe(180);
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
    expect(lanes.second()).toBe(-1); // before the gun now
    on.input({ target: { classList: { contains: (c: string) => c === 'lane-range' }, value: '-200' } });
    expect(lanes.second()).toBe(-90); // clamped
    on.click(btn({ laneStep: '-1' }));
    expect(lanes.second()).toBe(-90);
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
    expect(lanes.second()).toBe(-90);
    expect(prevented).toBe(5);
    on.keydown(key('Tab'));
    expect(prevented).toBe(5);
    on.keydown(key('ArrowRight', true));
    // An arrow the map has used already (panning it, zoomed in) is not a step.
    on.keydown({ ...key('ArrowRight'), defaultPrevented: true });
    me = 'A';
    lanes.refresh();
    expect(lanes.second()).toBe(-80);
    expect(shownS(body.innerHTML)).toBe(-80);
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
      // From the end: back to −1:30 and on.
      on.click(btn({}));
      expect(lanes.second()).toBe(-90);
      vi.advanceTimersByTime(LANE_PLAY_MS * 5);
      expect(lanes.second()).toBe(-85);
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

  it('+1:00, +2:00, +3:00: wind-up, every boat placed at each, every trail the last 2 min (+1:00 from where the feed starts, −59.9 s)', () => {
    expect(frames(L).map((f) => f.title)).toEqual(['gun +1:00', 'gun +2:00', 'gun +3:00']);
    expect(L.windUp).toBe(true);
    for (const f of frames(L)) {
      expect(f.empty).toBe(false);
      expect(f.placed).toBe(a.boats.length);
      expect(f.caption).toMatch(/^USA 016: ≈ \d+ of 15$/);
    }
    // One unbroken trail each, as worked out directly over the 2 min before (from where the feed starts at +1:00).
    for (const i of [0, 1, 2]) {
      const b = at(i, 'USA 016');
      expect(b.trail).toHaveLength(1);
      const t = frames(L)[i].t;
      expect(b.trail).toEqual(laneTrail(a, me, a.wind.twdAtGunDeg, Math.max(a.meta.gunMs + LANE_TRAIL_FROM_S * 1000, t - BOAT_TRAIL_MS), t));
    }
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
    // The key's legend for the over-early styling; both boats' tracks drawn over the line and back, both cleared.
    expect(html).toContain(ocsLegend());
    const fig = html.split('<figure')[1].split('</figure>')[0];
    expect(fig.match(/<polyline class="ocs-over"/g)!.length).toBeGreaterThanOrEqual(2);
    expect(fig.match(/<polyline class="ocs-dip"/g)!.length).toBeGreaterThanOrEqual(2);
    expect(fig.match(/class="ocs-mark clear"/g)).toHaveLength(2);
    expect(fig.match(/class="ocs-mark back"/g)).toHaveLength(2);
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
      for (let s = LANE_START_S; s <= LANE_END_S; s++) {
        const at = placeAt(d.id, legRanges(d, true), a.meta.gunMs + s * 1000, drawingGapMs(d), twd);
        const b = boatIn(L.frame(s), d.id);
        expect(b.pos).toEqual(at ? [at.mx, at.my] : null);
        if (b.pos && !away) expect(inside(b.pos), `${b.sail} at +${s} s`).toBe(true);
      }
      for (const s of [-90, -30, 0, 45, 133, 180]) {
        const t = a.meta.gunMs + s * 1000;
        expect(boatIn(L.frame(s), d.id).trail).toEqual(laneTrail(a, d.id, twd, Math.max(a.meta.gunMs + LANE_TRAIL_FROM_S * 1000, t - BOAT_TRAIL_MS), t));
      }
    }
    // One view for the whole slider: the same viewBox at −1:30, at the gun and at +3:00.
    const box = (s: number): string => laneScrubHtml(a, L, undefined, s).match(/class="chart lane-svg" viewBox="([^"]+)"/)![1];
    expect(box(0)).toBe(box(180));
    expect(box(-90)).toBe(box(0));
  });
});

describe('around the gun: zoom (the track map’s pan / zoom)', () => {
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'B', tr: track(20, -100) },
  ]);
  const L = laneScrub(a, { me: 'B' });
  const vb = (html: string): string => html.match(/class="chart lane-svg" viewBox="([^"]+)"/)![1];

  it('the presets as the track map’s (Fit, 2×, 4×, 8×), Fit pressed by default; zoomed, the map shows the visible part of the fit box', () => {
    expect([...LANE_ZOOMS]).toEqual([1, 2, 4, 8]);
    const html = laneScrubHtml(a, L);
    expect(html).toContain('<div class="zoom lane-zoom" role="group" aria-label="Start Playback map zoom"><button type="button" data-zoom="1" aria-pressed="true">Fit</button><button type="button" data-zoom="2" aria-pressed="false">2×</button>');
    expect(html).toContain('<div class="lane-stage panzoom" tabindex="0" role="group" aria-label="Start Playback map. Arrow keys pan when zoomed, plus and minus zoom, 0 resets.">');
    const z = { ...fitView(L.view), k: 2 };
    const zoomed = laneScrubHtml(a, L, undefined, 0, undefined, false, z);
    expect(zoomed).toContain('data-zoom="2" aria-pressed="true"');
    expect(zoomed).toContain('class="lane-stage panzoom zoomed"');
    const v = laneVisible(L.view, z);
    expect(v.x1 - v.x0).toBeCloseTo((L.view.x1 - L.view.x0) / 2, 9);
    expect(vb(zoomed)).toBe(`${v.x0.toFixed(1)} ${v.y0.toFixed(1)} ${(v.x1 - v.x0).toFixed(1)} ${(v.y1 - v.y0).toFixed(1)}`);
    // Sizes stay put on screen: at 2× a label is half as many view units.
    const fs = (h: string): number => Number(h.match(/class="lane-lbl on"[^>]*font-size="([\d.]+)"/)![1]);
    expect(fs(zoomed)).toBeCloseTo(fs(html) / 2, 1);
  });

  /** A mount on a stand-in body whose parts are kept (the stage updated in place, as in the page). */
  function mounted() {
    const el = () => {
      const attrs: Record<string, string> = {};
      return { innerHTML: '', textContent: '', value: '', disabled: false, attrs, setAttribute: (k: string, v: string) => (attrs[k] = v) };
    };
    const parts: Record<string, ReturnType<typeof el>> = {};
    const body = { innerHTML: '', querySelector: (sel: string) => (body.innerHTML ? (parts[sel] ??= el()) : null) };
    const on: Record<string, (ev: unknown) => void> = {};
    const root = { open: true, querySelector: () => body, addEventListener: (t: string, f: (ev: unknown) => void) => (on[t] = f) } as unknown as HTMLDetailsElement;
    const lanes = mountLaneSnapshots(root, () => ({ a, me: 'B', group: { kind: 'leaders' } }), () => Promise.resolve([]));
    lanes.refresh();
    return { on, parts, lanes, root };
  }
  const btn = (attrs: Record<string, string>) => ({ target: { closest: () => ({ dataset: attrs }) } });

  it('defaults to Fit (the extent over the whole slider); scrubbing and play never change the zoom; Fit resets it', () => {
    vi.useFakeTimers();
    try {
      const { on, parts, lanes } = mounted();
      expect(lanes.zoom()).toEqual(fitView(L.view));
      expect(presetActive(L.view, lanes.zoom(), 1)).toBe(true);
      on.click(btn({ zoom: '4' }));
      const z = lanes.zoom();
      expect(z.k).toBe(4);
      expect(vb(parts['.lane-stage'].innerHTML)).not.toBe(vb(laneScrubHtml(a, L)));
      // A pan (as the map's drag would) is kept too.
      lanes.setZoom({ ...z, cx: z.cx + 20 });
      const panned = lanes.zoom();
      for (let i = 0; i < 15; i++) on.click(btn({ laneStep: '1' }));
      on.input({ target: { classList: { contains: (c: string) => c === 'lane-range' }, value: '-60' } });
      on.keydown({ key: 'End', shiftKey: false, preventDefault: () => {} });
      on.keydown({ key: 'Home', shiftKey: false, preventDefault: () => {} });
      on.click(btn({}));
      vi.advanceTimersByTime(LANE_PLAY_MS * 50);
      expect(lanes.second()).toBe(-40);
      expect(lanes.zoom()).toEqual(panned);
      // The stage redrawn at the second on show, in the same visible box.
      expect(parts['.lane-stage'].innerHTML).toMatch(/^<figure class="lane-frame" data-s="-40">/);
      expect(vb(parts['.lane-stage'].innerHTML)).toBe(vb(laneScrubHtml(a, L, undefined, -40, undefined, false, panned)));
      // Fit: back to the default extent.
      on.click(btn({ zoom: '1' }));
      expect(lanes.zoom()).toEqual(fitView(L.view));
      expect(vb(parts['.lane-stage'].innerHTML)).toBe(vb(laneScrubHtml(a, L)));
    } finally {
      vi.useRealTimers();
    }
  });

  it('zoom clamps to the fit box (never out past Fit, never off it)', () => {
    const { lanes } = mounted();
    lanes.setZoom({ cx: 1e6, cy: 1e6, k: 0.2 });
    expect(lanes.zoom()).toEqual(fitView(L.view));
    lanes.setZoom({ cx: 1e6, cy: 0, k: 2 });
    expect(laneVisible(L.view, lanes.zoom()).x1).toBeCloseTo(L.view.x1, 6);
  });
});

describe('around the gun: boats as hulls where they can be', () => {
  // J/70s (6.93 m), sailing north at 2 m/s (4 kn by the feed).
  const j70 = (boats: BoatSpec[]): RaceAnalysis => {
    const r = race(boats);
    (r.meta as { boatClass?: string }).boatClass = 'J/70';
    return r;
  };
  const a = j70([
    { id: 'A', tr: track(0, -100) },
    { id: 'B', tr: track(20, -100) },
    { id: 'Gap', tr: track(40, -100, -120, 200, [[58, 100]]) },
  ]);
  const L = laneScrub(a, { me: 'B' });
  const ppu = lanePxPerUnit(L.view);

  it('the class sizes the hull; each boat’s course on the 1 s grid is the scrubber’s (north: straight up the map)', () => {
    expect(L.dims).toEqual({ loaM: 6.934, beamM: 2.249 });
    const b = boatIn(L.frame(60), 'B');
    near(b.dir, [0, -1]);
    expect(b.sog).toBe(4);
    // Unknown class: no dims, dots.
    expect(laneScrub(race([{ id: 'A', tr: track(0, -100) }]), { me: null }).dims).toBeNull();
  });

  it('at Fit a J/70 to scale would be 6 px: a symbol BOAT_SHAPE_PX long (15 px selected); zoomed in, to scale; centred on the boat, along its course', () => {
    const px = L.dims!.loaM * ppu;
    expect(px).toBeGreaterThan(BOAT_SHAPE_MIN_PX);
    expect(px).toBeLessThan(BOAT_SHAPE_PX);
    const fit = laneScrubHtml(a, L, undefined, 60);
    const bow = (html: string, id: string): number => Number(html.match(new RegExp(`data-id="${id}"><title>${id}</title><path class="lane-dot lane-hull" d="M[-\\d.]+,([-\\d.]+)`))![1]);
    const posB = boatIn(L.frame(60), 'B').pos!;
    const posA = boatIn(L.frame(60), 'A').pos!;
    expect(posB[1] - bow(fit, 'B')).toBeCloseTo(BOAT_SHAPE_ON_PX / ppu / 2, 1);
    expect(posA[1] - bow(fit, 'A')).toBeCloseTo(BOAT_SHAPE_PX / ppu / 2, 1);
    const z = { ...fitView(L.view), k: 4 };
    const html = laneScrubHtml(a, L, undefined, 60, ppu, false, z);
    const b = boatIn(L.frame(60), 'B');
    const d = html.match(/data-id="B"><title>B<\/title><path class="lane-dot lane-hull" d="([^"]+)"/)![1];
    // The bow LOA/2 up the page from the boat.
    expect(d.startsWith(`M${b.pos![0].toFixed(2)},${(b.pos![1] - L.dims!.loaM / 2).toFixed(2)}`)).toBe(true);
    expect(html).toMatch(/<path class="lane-dot lane-hull"[^>]*vector-effect="non-scaling-stroke"\/>/);
    // Labels kept (the selected boat's in bold), colours kept (a small fleet: the boats' own).
    expect(html).toMatch(/class="lane-lbl on"[^>]*>B</);
    expect(html).toMatch(/data-id="B"><title>B<\/title><path [^>]*fill="var\(--s2\)"/);
  });

  it('held in a gap, slow or without a course: the hull along its last heading; hollow in a gap over SHORT_GAP_S', () => {
    const z = { ...fitView(L.view), k: 8 };
    const hull = (s: number): string => laneScrubHtml(a, L, undefined, s, ppu, false, z).match(/data-id="Gap"><title>Gap \(last fix, in a gap\)<\/title>(<[^>]*>)/)![1];
    // 2 s into the 42 s gap at +58: held at its last fix, hollow (outlined in its color), pointing up the course.
    expect(boatIn(L.frame(60), 'Gap')).toMatchObject({ hold: true, stale: true });
    expect(hull(60)).toMatch(/^<path class="lane-dot lane-hull lost" [^>]*fill="var\(--surface\)" stroke="var\(--ink-3\)" stroke-width="1.6"/);
    // 10 s in: the same hull, at the same place and heading.
    expect(hull(68).match(/ d="([^"]+)"/)![1]).toBe(hull(60).match(/ d="([^"]+)"/)![1]);
    const at = boatIn(L.frame(60), 'A');
    expect(laneShape(L, at, 10)).not.toBeNull();
    // No course now, or slow: the last heading known; none ever known: the dot.
    expect(laneShape(L, { ...at, dir: null }, 10)?.dir).toEqual(at.lastDir ?? [0, -1]);
    expect(laneShape(L, { ...at, sog: 0.5 }, 10)).not.toBeNull();
    expect(laneShape(L, { ...at, dir: null, lastDir: null }, 10)).toBeNull();
    expect(laneShape(L, { ...at, sog: 0.5, lastDir: null }, 10)).toBeNull();
    expect(laneShape({ dims: null }, at, 10)).toBeNull();
    expect(laneShape(L, at, BOAT_SHAPE_MIN_PX / L.dims!.loaM - 0.01)).toBeNull();
    expect(laneShape(L, at, BOAT_SHAPE_MIN_PX / L.dims!.loaM + 0.01)).not.toBeNull();
  });
});

describe('around the gun: "Replay start →" cues the slider', () => {
  const a = race([
    { id: 'A', tr: track(0, -100) },
    { id: 'B', tr: track(20, -100) },
  ]);

  it('5 s before its track went over, never later than 10 s before the gun, never before −1:30', () => {
    expect([LANE_CUE_PRE_S, LANE_CUE_GUN_S]).toEqual([5, -10]);
    expect(laneCueSecond({ gunMs: GUN, over: [sec(-2), sec(10)] })).toBe(-10);
    expect(laneCueSecond({ gunMs: GUN, over: [sec(-30), sec(10)] })).toBe(-35);
    expect(laneCueSecond({ gunMs: GUN, over: [sec(-88), sec(10)] })).toBe(-90);
    expect(laneCueSecond({ gunMs: GUN, over: null })).toBe(-10);
  });

  it('mount: cue opens the section on that second, the selected boat drawn, and plays from there (or waits, paused)', () => {
    vi.useFakeTimers();
    try {
      const body = { innerHTML: '' };
      const root = { open: false, querySelector: () => body, addEventListener: () => {} } as unknown as HTMLDetailsElement;
      let me = 'A';
      const lanes = mountLaneSnapshots(root, () => ({ a, me, group: { kind: 'leaders' } }), () => Promise.resolve([rep('B', 20)]));
      me = 'B';
      lanes.cue(laneCueSecond(rep('B', 20)), true);
      expect(root.open).toBe(true);
      expect(lanes.second()).toBe(-10);
      expect(lanes.playing()).toBe(true);
      expect(body.innerHTML).toContain('B highlighted');
      vi.advanceTimersByTime(LANE_PLAY_MS * 3);
      expect(lanes.second()).toBe(-7);
      // Reduced motion: cued, paused, ready to play.
      lanes.cue(-200, false);
      expect(lanes.second()).toBe(-90);
      expect(lanes.playing()).toBe(false);
      expect(body.innerHTML).toContain('data-s="-90"');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('around the gun: zoom centers on the selected boat (with the look-ahead) or the fleet, and follows it', () => {
  /** A mount on a stand-in body whose parts are kept (the stage updated in place, as in the page). */
  function mountOn(a: RaceAnalysis, me: string | null) {
    const el = () => {
      const attrs: Record<string, string> = {};
      return { innerHTML: '', textContent: '', value: '', disabled: false, attrs, setAttribute: (k: string, v: string) => (attrs[k] = v) };
    };
    const parts: Record<string, ReturnType<typeof el>> = {};
    const body = { innerHTML: '', querySelector: (sel: string) => (body.innerHTML ? (parts[sel] ??= el()) : null) };
    const on: Record<string, (ev: unknown) => void> = {};
    const root = { open: true, querySelector: () => body, addEventListener: (t: string, f: (ev: unknown) => void) => (on[t] = f) } as unknown as HTMLDetailsElement;
    const lanes = mountLaneSnapshots(root, () => ({ a, me, group: { kind: 'leaders' } }), () => Promise.resolve([]));
    lanes.refresh();
    return { on, parts, lanes };
  }
  const btn = (attrs: Record<string, string>) => ({ target: { closest: () => ({ dataset: attrs }) } });
  // A sails north from well left of the pin, B from the RC end; C has a tracker hole around the gun.
  const a = race([
    { id: 'A', tr: track(-90, -100) },
    { id: 'B', tr: track(90, -100) },
    { id: 'C', tr: track(0, -100, -120, 200, [[-10, 10]]) },
  ]);

  it('the target: the selected boat where placed; no selection or a gap: the fleet’s middle; nobody placed: null', () => {
    const L = laneScrub(a, { me: 'B' });
    const f = L.frame(0);
    expect(laneZoomTarget(f, 'B')).toEqual(boatIn(f, 'B').pos);
    const A = boatIn(f, 'A').pos!;
    const B = boatIn(f, 'B').pos!;
    expect(boatIn(f, 'C').pos).toBeNull();
    const mid: [number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    expect(laneZoomTarget(f, null)).toEqual(mid);
    expect(laneZoomTarget(f, 'C')).toEqual(mid);
    expect(laneZoomTarget({ boats: f.boats.map((b) => ({ ...b, pos: null })) }, 'B')).toBeNull();
  });

  it('a preset centers on the selected boat with the look-ahead (clamped at the map’s edge); without one, the fleet; Fit is the default extent', () => {
    const { on, lanes } = mountOn(a, 'B');
    const L = lanes.scrub()!;
    const B = boatIn(L.frame(0), 'B').pos!;
    on.click(btn({ zoom: '4' }));
    expect(lanes.zoom()).toEqual(zoomPreset(L.view, 4, laneFollowTarget(L, 0, 4)));
    const vb = viewBox(L.view, lanes.zoom());
    expect(B[0]).toBeGreaterThan(vb.x0);
    expect(B[0]).toBeLessThan(vb.x0 + vb.w);
    // Sailing up the map (upwind): the view leads, the boat below its center.
    expect(B[1]).toBeGreaterThan(lanes.zoom().cy);
    expect(B[1]).toBeLessThan(vb.y0 + vb.h);
    expect(lanes.following()).toBe(true);
    on.click(btn({ zoom: '1' }));
    expect(lanes.zoom()).toEqual(fitView(L.view));
    const none = mountOn(a, null);
    none.on.click(btn({ zoom: '2' }));
    const Ln = none.lanes.scrub()!;
    expect(none.lanes.zoom()).toEqual(zoomPreset(Ln.view, 2, laneZoomTarget(Ln.frame(0), null)));
  });

  it('playing zoomed in: the boat held about a third of the way in from the trailing edge (upwind), the zoom unchanged; a hand pan stops it', () => {
    vi.useFakeTimers();
    try {
      const { on, lanes } = mountOn(a, 'B');
      const L = lanes.scrub()!;
      on.click(btn({ zoom: '8' }));
      on.click(btn({})); // play
      let framed = 0;
      for (let i = 0; i < 120; i++) {
        vi.advanceTimersByTime(LANE_PLAY_MS);
        const now = lanes.zoom();
        expect(now.k).toBe(8);
        const input = laneFollowInput(L, 'B', lanes.second())!;
        const dir = courseStats(input.dirs).dir!;
        expect(dir[1]).toBeLessThan(-0.99); // up the map
        const w = viewBox(L.view, now);
        const p = input.pos;
        expect(p[1]).toBeGreaterThanOrEqual(w.y0 - 1e-9);
        expect(p[1]).toBeLessThanOrEqual(w.y0 + w.h + 1e-9);
        // Not held at the map's edge: the boat's share of the view from the bottom (trailing) edge.
        if (clampView(L.view, { ...now, cy: now.cy + 1 }).cy !== now.cy + 1 || clampView(L.view, { ...now, cy: now.cy - 1 }).cy !== now.cy - 1) continue;
        const f = (w.y0 + w.h - p[1]) / w.h;
        expect(f).toBeGreaterThan(0.3);
        expect(f).toBeLessThan(0.36);
        framed++;
      }
      expect(framed).toBeGreaterThan(30);
      // A pan by hand: the follow stops, and play no longer moves the view.
      const by: View = { ...lanes.zoom(), cx: lanes.zoom().cx - 5 };
      lanes.setZoom(by);
      expect(lanes.following()).toBe(false);
      const held = lanes.zoom();
      on.click(btn({ laneStep: '-1' }));
      on.click(btn({}));
      vi.advanceTimersByTime(LANE_PLAY_MS * 40);
      expect(lanes.zoom()).toEqual(held);
      // A preset again: centered on the boat's look-ahead and following.
      on.click(btn({ zoom: '4' }));
      expect(lanes.following()).toBe(true);
      expect(lanes.zoom()).toEqual(zoomPreset(L.view, 4, laneFollowTarget(L, lanes.second(), 4)));
    } finally {
      vi.useRealTimers();
    }
  });

  it('dots become hulls zoomed in (the size rule at the current zoom, the same frames), and dots again at Fit', () => {
    // J/70s on a 4 km line: at Fit, under BOAT_SHAPE_MIN_PX to scale.
    const wide = race(
      [
        { id: 'A', tr: track(-1900, -100) },
        { id: 'B', tr: track(1900, -100) },
      ],
      0,
      'tacks',
      [0, 1000],
      [
        [-2000, 0],
        [2000, 0],
      ],
    );
    (wide.meta as { boatClass?: string }).boatClass = 'J/70';
    const { on, parts, lanes } = mountOn(wide, 'B');
    const L = lanes.scrub()!;
    expect(L.dims!.loaM * lanePxPerUnit(L.view)).toBeLessThan(BOAT_SHAPE_MIN_PX);
    const hulls = (): number => (parts['.lane-stage'].innerHTML.match(/lane-hull/g) ?? []).length;
    on.click(btn({ zoom: '1' }));
    expect(hulls()).toBe(0);
    on.click(btn({ zoom: '8' }));
    expect(hulls()).toBeGreaterThan(0);
    // Not worked out again: the same precomputed scrub.
    expect(lanes.scrub()).toBe(L);
    on.click(btn({ zoom: '1' }));
    expect(hulls()).toBe(0);
  });
});
