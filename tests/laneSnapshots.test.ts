import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { groupIds } from '../src/analysis/coach/groups';
import type { Vec } from '../src/analysis/geo';
import { startReplays, type StartReplay } from '../src/analysis/startReplay';
import { PRE_LEG, type BoatDrawing, type RaceAnalysis, type TrackSegment } from '../src/analysis/types';
import { LANE_FRAMES_S, LANE_TRAIL_FROM_S, laneSnapshots, laneText, thirdOf, type LaneFrame } from '../src/ui/laneSnapshots';
import { laneSnapshotsHtml, mountLaneSnapshots } from '../src/ui/laneSnapshotsView';
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

function race(boats: BoatSpec[], twd = 0, method: 'tacks' | 'course' = 'tacks'): RaceAnalysis {
  return {
    meta: { gunMs: GUN, tzOffsetMs: 0 },
    line: { left: [-100, 0], right: [100, 0], lengthM: 200 },
    legPts: [
      [0, 0],
      [0, 1000],
      [0, 0],
    ],
    legs: [{ index: 0, name: 'Beat 1', kind: 'upwind', to: 'Mark 1' }],
    marks: [{ name: 'Mark 1', xy: [[0, 1000]] }],
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
    // A feed that starts exactly at −30 s: the trail still starts there, and the caption has nothing to say about it.
    const exact = laneSnapshots(race([{ id: 'A', tr: track(0, -100, -30) }]), { me: 'A' });
    near(boatIn(exact.frames[0], 'A').trail[0][0], [0, -(-100 + 2 * -30)]);
    expect(exact.frames[0].caption).not.toMatch(/Tracking starts|No data before/);
  });

  it('a trail starts where the data does when that is after −30 s', () => {
    const b = laneSnapshots(race([{ id: 'A', tr: track(0, -100, -10) }]), { me: 'A' });
    const t0 = boatIn(b.frames[0], 'A').trail[0];
    near(t0[0], [0, -(-100 + 2 * -10)]);
    expect(t0).toHaveLength(71);
  });
});

describe('lane snapshots: orientation and the first mark', () => {
  it('wind-up: wind from the east puts east at the top, and the mark (north) to the left', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }], 90), { me: null });
    expect(L.windUp).toBe(true);
    expect(L.note).toBeNull();
    near(L.markDir, [-1, 0]);
    // The pin (west) at the bottom, the RC (east) at the top.
    near(L.line[0], [0, 100]);
    near(L.line[1], [0, -100]);
  });

  it('north-up when there is no wind estimate, and says so', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }], NaN), { me: null });
    expect(L.windUp).toBe(false);
    expect(L.note).toMatch(/North up/);
    near(L.markDir, [0, -1]);
  });

  it('notes wind assumed from the course', () => {
    expect(laneSnapshots(race([{ id: 'A', tr: track(0, -100) }], 0, 'course'), { me: null }).note).toMatch(/assumed/);
  });

  it('a common view for all frames: the line, every placed boat and its trail near the start; the far mark left out (an arrow instead)', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }]), { me: null });
    expect(L.view.x0).toBeLessThan(-100);
    expect(L.view.x1).toBeGreaterThan(100);
    // The trails' start, 160 m south at −30 s (map y +160) … 260 m north at +180 s (map y −260).
    expect(L.view.y1).toBeGreaterThan(160);
    expect(L.view.y0).toBeLessThan(-260);
    expect(L.view.y0).toBeGreaterThan(-1000);
    expect(L.markName).toBe('Mark 1');
  });

  it('the view leaves out what is beyond the reach, however long the trail: only the part of it within reach counts', () => {
    // 8 m/s: 340 m south at −30 s, 1340 m north at +3:00; the reach is 600 m from the line's middle.
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }, { id: 'Fast', tr: track(-50, -100, -120, 200, [], 8) }]), { me: null });
    // At most the reach (600 m north), the padding and the mark arrow's room: nowhere near its 1340 m.
    expect(L.view.y0).toBeGreaterThan(-900);
    expect(L.view.y1).toBeLessThan(700);
    expect(L.view.y1).toBeGreaterThan(340);
  });
});

describe('lane snapshots: captions', () => {
  it('across the line: pin, middle and RC thirds, and past either end', () => {
    expect(thirdOf(0.1)).toBe('pin');
    expect(thirdOf(0.5)).toBe('middle');
    expect(thirdOf(0.9)).toBe('rc');
    expect(laneText(0.48)).toBe('middle third (48% from pin)');
    expect(laneText(-0.08)).toBe('past the pin end (by 8% of the line)');
    expect(laneText(1.41)).toBe('past the RC end (by 41% of the line)');
    const L = laneSnapshots(
      race([
        { id: 'P', tr: track(-80, -100) },
        { id: 'M', tr: track(0, -100) },
        { id: 'R', tr: track(80, -100) },
      ]),
      { me: 'P' },
    );
    const f = L.frames[1];
    expect(['P', 'M', 'R'].map((id) => boatIn(f, id).third)).toEqual(['pin', 'middle', 'rc']);
    expect(boatIn(f, 'P').across).toBeCloseTo(0.1, 6);
    expect(f.caption).toMatch(/^P: pin third \(10% from pin\) · ≈ \d+(st|nd|rd|th) of 3 toward Mark 1\./);
  });

  it('ranks by distance still to go toward the first mark, along the course axis (approximate)', () => {
    const L = laneSnapshots(
      race([
        { id: 'Back', tr: track(0, -150) },
        { id: 'Front', tr: track(90, -50) },
        { id: 'Mid', tr: track(-90, -100) },
      ]),
      { me: 'Mid' },
    );
    const f = L.frames[2];
    expect(boatIn(f, 'Front').rank).toBe(1);
    expect(boatIn(f, 'Mid').rank).toBe(2);
    expect(boatIn(f, 'Back').rank).toBe(3);
    // Along the axis, not straight-line: Front is 90 m off the axis, still 1000 − (−50 + 360) = 690 m to go.
    expect(boatIn(f, 'Front').toMarkM).toBeCloseTo(690, 6);
    expect(f.caption).toContain('≈ 2nd of 3 toward Mark 1');
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

  it('a boat that cleared before +1:00 is "OCS, cleared" in the +1:00 caption; one still over is "Over (OCS)"', () => {
    expect(L.frames[0].caption).toContain('Over (OCS): Late, Later, Never.');
    expect(L.frames[0].caption).toContain('OCS, cleared: Early +30 s.');
    expect(L.frames[1].caption).toContain('Over (OCS): Later, Never.');
    expect(L.frames[1].caption).toContain('OCS, cleared: Early +30 s, Late +90 s.');
    expect(L.frames[2].caption).toContain('Over (OCS): Never.');
    expect(L.frames[2].caption).toContain('OCS, cleared: Early +30 s, Late +90 s, Later +150 s.');
    expect(L.frames[0].label).toContain('OCS, cleared: Early +30 s.');
  });

  it('the rings: solid red with "OCS" while over, dashed once cleared; no "above the line" any more', () => {
    const html = laneSnapshotsHtml(race(boats), L);
    const first = html.split('<figure')[1];
    expect(first.match(/class="lane-over"/g)).toHaveLength(3);
    expect(first.match(/class="lane-cleared"[^>]*stroke-dasharray/g)).toHaveLength(1);
    expect(first.match(/>OCS<\/text>/g)).toHaveLength(3);
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
    expect(L.frames[0].missing).toEqual(['S']);
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

  it("trail coverage: the fleet's first fix after −30 s but before the gun, 'Tracking starts at gun −0:10'", () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100, -10) }, { id: 'B', tr: track(50, -100, -5) }]), { me: 'A' });
    for (const f of L.frames) {
      expect(f.empty).toBe(false);
      expect(f.caption).toMatch(/^A: .* Tracking starts at gun −0:10\.$/);
      expect(f.label).toContain('Tracking starts at gun −0:10.');
      near(boatIn(f, 'A').trail[0][0], [0, -(-100 + 2 * -10)]);
    }
  });

  it("trail coverage: no fix before the gun, 'No data before the gun' (at the gun) or with when tracking starts (after it)", () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100, 0) }, { id: 'B', tr: track(50, -100, 0) }]), { me: 'A' });
    for (const f of L.frames) {
      expect(f.empty).toBe(false);
      expect(f.caption).toMatch(/ No data before the gun\.$/);
      expect(boatIn(f, 'A').trail[0][0]).toEqual([0, 100]);
    }
    expect(L.frames[0].label).toContain('No data before the gun.');
    const later = laneSnapshots(race([{ id: 'A', tr: track(0, -100, 5) }]), { me: 'A' });
    expect(later.frames[0].caption).toMatch(/ No data before the gun; tracking starts at gun \+0:05\.$/);
  });

  it("a frame with no positions and no trails: 'No tracks at this time.'", () => {
    // Tracking only from +2:30: the +1:00 and +2:00 frames are empty, the +3:00 frame draws.
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100, 150) }, { id: 'B', tr: track(50, -100, 150) }]), { me: 'A' });
    expect(L.frames.map((f) => f.empty)).toEqual([true, true, false]);
    expect(L.frames[0].caption).toBe('No tracks at this time.');
    expect(L.frames[0].label).toBe('Lane snapshot at gun +1:00, trails from gun −0:30. No tracks at this time.');
    expect(L.frames[2].caption).toMatch(/No data before the gun; tracking starts at gun \+2:30\.$/);
    const html = laneSnapshotsHtml(race([{ id: 'A', tr: track(0, -100, 150) }]), L);
    expect(html).toContain('class="lane-empty"');
    expect(html).toContain('>No tracks</text>');
  });

  it('the selected boat in a tracker gap: said once, not repeated under "Not tracked"', () => {
    const L = laneSnapshots(race([{ id: 'S', tr: track(0, -100, -120, 180, [[40, 80]]) }, { id: 'A', tr: track(20, -100) }, { id: 'Ghost' }]), { me: 'S' });
    const cap = L.frames[0].caption;
    expect(cap).toBe('S: no position (tracker gap). Not tracked: Ghost.');
    expect(cap.match(/\bS\b/g)).toHaveLength(1);
    expect(L.frames[0].label).toBe('Lane snapshot at gun +1:00, trails from gun −0:30: 1 of 3 boats placed. S: no position (tracker gap). Not tracked: Ghost.');
  });

  it('the selected boat with no track at all: "not tracked" once; other missing boats still listed', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }, { id: 'Ghost' }, { id: 'Gone' }]), { me: 'Ghost' });
    for (const f of L.frames) {
      expect(f.caption).toMatch(/^Ghost: not tracked\./);
      expect(f.caption.match(/Ghost/g)).toHaveLength(1);
      expect(f.caption).not.toContain('tracker gap');
      expect(f.caption).toContain('Not tracked: Gone.');
      expect(f.label.match(/Ghost/g)).toHaveLength(1);
    }
  });

  it('a boat with no track at all: listed as not tracked in every frame', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }, { id: 'Ghost' }]), { me: 'A' });
    for (const f of L.frames) {
      expect(f.missing).toEqual(['Ghost']);
      expect(f.placed).toBe(1);
      expect(f.caption).toContain('Not tracked: Ghost.');
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

  it('three frames, each an SVG with an accessible label, the shared view, the line and the mark arrow', () => {
    expect(html.match(/<figure class="lane-frame/g)).toHaveLength(3);
    expect(html.match(/<svg class="chart lane-svg"/g)).toHaveLength(3);
    expect(html.match(/role="img" aria-label="Lane snapshot at gun \+1:00, trails from gun −0:30: 3 of 3 boats placed/g)).toHaveLength(1);
    expect(html).toContain('data-s="60"');
    expect(html).toContain('data-s="180"');
    expect(html).toContain('Trails from gun −0:30 (or where the data starts)');
    expect(html).not.toContain('frame before');
    const v = L.view;
    expect(html.match(new RegExp(`viewBox="${v.x0.toFixed(1)} ${v.y0.toFixed(1)}`, 'g'))).toHaveLength(3);
    expect(html.match(/class="startline"/g)).toHaveLength(3);
    expect(html).toContain('<title>Toward Mark 1</title>');
  });

  it('the selected boat and its group highlighted (labelled), the rest faded; the over ring and OCS label', () => {
    expect(html).toContain('class="lane-boat lane-me" data-id="B"');
    expect(html).toContain('class="lane-boat lane-group" data-id="C"');
    expect(html).toContain('class="lane-boat lane-other dim" data-id="A"');
    expect(html).toContain('class="lane-trail lane-other dim"');
    expect(html).toMatch(/class="lane-lbl on"[^>]*>B</);
    expect(html).toContain('class="lane-over"');
    expect(html).toContain('>OCS</text>');
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
      addEventListener: (_: string, f: () => void) => (onToggle = f),
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
      expect(f.missing).toEqual([]);
      expect(f.placed).toBe(a.boats.length);
      expect(f.caption).not.toMatch(/Tracking starts|No data before/);
    }
    // One unbroken trail each, longer frame by frame.
    const lens = [0, 1, 2].map((i) => at(i, 'USA 016').trail.map((t) => t.length));
    for (const l of lens) expect(l).toHaveLength(1);
    expect(lens[1][0]).toBeGreaterThan(lens[0][0]);
    expect(lens[2][0]).toBeGreaterThan(lens[1][0]);
    // The mark is upwind: the arrow points up the page.
    expect(L.markDir![1]).toBeLessThan(-0.9);
  });

  it("USA 016's lane: at the pin end by +1:00, further left by +2:00 and +3:00; places toward the mark sensible", () => {
    const [b1, b2, b3] = [0, 1, 2].map((i) => at(i, 'USA 016'));
    expect(b1.across!).toBeGreaterThan(-0.2);
    expect(b1.across!).toBeLessThan(0.05);
    expect(b2.across!).toBeLessThan(b1.across!);
    expect(b3.across!).toBeLessThan(b2.across!);
    for (const b of [b1, b2, b3]) {
      expect(b.rank).toBeGreaterThanOrEqual(1);
      expect(b.rank).toBeLessThanOrEqual(a.boats.length);
    }
    // ≈ 6th at +1:00, ≈ 4th at +2:00.
    expect(b2.rank!).toBeLessThan(b1.rank!);
    expect(L.frames[0].caption).toMatch(/^USA 016: past the pin end \(by \d+% of the line\) · ≈ \d+(st|nd|rd|th) of 15 toward /);
  });

  it('USA 017 and USA 019 (OCS, cleared ≈ +26 s and ≈ +35 s at the bow): cleared in every frame, from +1:00 on', () => {
    for (const [sail, cleared] of [
      ['USA 017', 26],
      ['USA 019', 35],
    ] as const) {
      expect(L.frames.map((f) => boatIn(f, idOf(sail)).over)).toEqual(['cleared', 'cleared', 'cleared']);
      expect((at(0, sail).clearedMs! - a.meta.gunMs) / 1000).toBeCloseTo(cleared, -0.5);
    }
    for (const f of L.frames) {
      expect(f.caption).toMatch(/OCS, cleared: .*USA 017 \+26 s/);
      expect(f.caption).toMatch(/USA 019 \+35 s/);
      expect(f.caption).not.toContain('Over (OCS)');
    }
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
