import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { groupIds } from '../src/analysis/coach/groups';
import type { Vec } from '../src/analysis/geo';
import { startReplays, type StartReplay } from '../src/analysis/startReplay';
import { PRE_LEG, type BoatDrawing, type RaceAnalysis, type TrackSegment } from '../src/analysis/types';
import { LANE_FIRST_FROM_S, LANE_FRAMES_S, laneSnapshots, laneText, thirdOf, type LaneFrame } from '../src/ui/laneSnapshots';
import { laneSnapshotsHtml, mountLaneSnapshots } from '../src/ui/laneSnapshotsView';
import { ic37Race } from './helpers';

/**
 * Lane snapshots (Start tab): a synthetic start (line from (−100, 0) pin to (100, 0) RC, first mark 1 km north,
 * wind from the north; boats sailing north at 2 m/s, 1 Hz fixes), then IC37 North Americans race 5.
 */
const GUN = 1_000_000;
const sec = (s: number): number => GUN + s * 1000;

/** A 1 Hz track at x, sailing north at `v` m/s through y0 at the gun, over [s0, s1] s (gun-relative), minus the `holes` (open intervals, s). */
function track(x: number, y0: number, s0 = -120, s1 = 180, holes: [number, number][] = [], v = 2): { t: number[]; x: number[]; y: number[] } {
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

  it('three frames at gun −60 s, +60 s, +120 s; each trails from the frame before (the first from −90 s)', () => {
    expect(LANE_FRAMES_S).toEqual([-60, 60, 120]);
    expect(L.frames.map((f) => f.s)).toEqual([-60, 60, 120]);
    expect(L.frames.map((f) => f.t)).toEqual([sec(-60), sec(60), sec(120)]);
    expect(L.frames.map((f) => f.from)).toEqual([sec(LANE_FIRST_FROM_S), sec(-60), sec(60)]);
    expect(L.frames.map((f) => f.title)).toEqual(['gun −1:00', 'gun +1:00', 'gun +2:00']);
  });

  it("the boat's position at each frame (wind from the north: north up, y down) and a trail from the previous frame's position", () => {
    const [f0, f1, f2] = L.frames.map((f) => boatIn(f, 'A'));
    near(f0.pos, [0, -(-100 + 2 * -60)]);
    near(f1.pos, [0, -(-100 + 2 * 60)]);
    near(f2.pos, [0, -(-100 + 2 * 120)]);
    // One unbroken trail each: −90 → −60, −60 → +60 (across the pre-start / leg boundary), +60 → +120.
    expect(f0.trail).toHaveLength(1);
    expect(f1.trail).toHaveLength(1);
    expect(f2.trail).toHaveLength(1);
    near(f0.trail[0][0], [0, -(-100 + 2 * -90)]);
    near(f1.trail[0][0], f0.pos!);
    near(f1.trail[0].at(-1)!, f1.pos!);
    near(f2.trail[0][0], f1.pos!);
    // 1 Hz, the gun's shared fix kept once: −60 … +60 is 121 points.
    expect(f1.trail[0]).toHaveLength(121);
  });

  it('the first frame trails from where the data starts when that is after −90 s', () => {
    const b = laneSnapshots(race([{ id: 'A', tr: track(0, -100, -75) }]), { me: 'A' });
    const t0 = boatIn(b.frames[0], 'A').trail[0];
    near(t0[0], [0, -(-100 + 2 * -75)]);
    expect(t0).toHaveLength(16);
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

  it('a common view for all frames: the line and every placed boat near the start; the far mark left out (an arrow instead)', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100) }]), { me: null });
    expect(L.view.x0).toBeLessThan(-100);
    expect(L.view.x1).toBeGreaterThan(100);
    // −220 m south at −60 s (map y +220) … 140 m north at +120 s (map y −140).
    expect(L.view.y1).toBeGreaterThan(220);
    expect(L.view.y0).toBeLessThan(-140);
    expect(L.view.y0).toBeGreaterThan(-1000);
    expect(L.markName).toBe('Mark 1');
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
    // Along the axis, not straight-line: Front is 90 m off the axis, still 1000 − (−50 + 240) = 810 m to go.
    expect(boatIn(f, 'Front').toMarkM).toBeCloseTo(810, 6);
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
    { id: 'Never', tr: track(60, -100) },
    { id: 'Clean', tr: track(-30, -100) },
  ];
  const L = laneSnapshots(race(boats), { me: 'Early', replays: [rep('Early', 30), rep('Late', 90), rep('Never', null)] });
  const over = (id: string) => L.frames.map((f) => boatIn(f, id).over);

  it('nobody is over before the gun; an OCS boat is over at a frame after the gun until it cleared (clearedMs)', () => {
    expect(over('Early')).toEqual([null, 'cleared', null]);
    expect(over('Late')).toEqual([null, 'over', 'cleared']);
    expect(over('Never')).toEqual([null, 'over', 'over']);
    expect(over('Clean')).toEqual([null, null, null]);
    expect(boatIn(L.frames[1], 'Early').clearedMs).toBe(sec(30));
    expect(boatIn(L.frames[2], 'Late').clearedMs).toBe(sec(90));
  });

  it('the captions name them', () => {
    expect(L.frames[1].caption).toContain('Over (OCS): Late, Never.');
    expect(L.frames[1].caption).toContain('OCS, cleared: Early +30 s.');
    expect(L.frames[2].caption).toContain('OCS, cleared: Late +90 s.');
  });

  it('before the gun, a boat on the course side of the line is "above the line" (geometry, not OCS)', () => {
    const b = laneSnapshots(race([{ id: 'Hi', tr: track(0, 150) }, { id: 'Lo', tr: track(10, -100) }]), { me: null });
    expect(boatIn(b.frames[0], 'Hi').courseSide).toBe(true);
    expect(boatIn(b.frames[0], 'Lo').courseSide).toBe(false);
    expect(boatIn(b.frames[1], 'Hi').courseSide).toBe(false);
    expect(b.frames[0].caption).toContain('Above the line: Hi.');
  });

  it('no over marks before the replays are in', () => {
    const b = laneSnapshots(race(boats), { me: 'Early', replays: null });
    expect(b.frames.flatMap((f) => f.boats.map((x) => x.over)).every((x) => x == null)).toBe(true);
  });
});

describe('lane snapshots: data gaps', () => {
  it('a long gap over a frame: the boat is missing there (no position made up), and its trails break at the gap', () => {
    const L = laneSnapshots(race([{ id: 'S', tr: track(0, -100, -120, 180, [[40, 80], [95, 105]]) }]), { me: 'S' });
    const [, f1, f2] = L.frames.map((f) => boatIn(f, 'S'));
    expect(f1.pos).toBeNull();
    expect(L.frames[1].missing).toEqual(['S']);
    expect(L.frames[1].caption).toBe('S: no position (tracker gap).');
    // −60 → +40 drawn, nothing made up past the last fix before the gap.
    expect(f1.trail).toHaveLength(1);
    near(f1.trail[0].at(-1)!, [0, -(-100 + 2 * 40)]);
    // +60 → +120: from the fix after the gap (+80) to +95, then +105 → +120.
    expect(f2.trail).toHaveLength(2);
    near(f2.trail[0][0], [0, -(-100 + 2 * 80)]);
    near(f2.trail[1][0], [0, -(-100 + 2 * 105)]);
    near(f2.pos, [0, -(-100 + 2 * 120)]);
  });

  it('a short step (within the gap rule) is interpolated; just inside a gap the dot holds at the last fix (the scrubber rule)', () => {
    // 1 Hz with the fix at +60 missing: a 2 s step, not a gap.
    const short = laneSnapshots(race([{ id: 'S', tr: track(0, -100, -120, 180, [[59, 61]]) }]), { me: 'S' });
    near(boatIn(short.frames[1], 'S').pos, [0, -(-100 + 2 * 60)]);
    expect(boatIn(short.frames[1], 'S').hold).toBe(false);
    // A gap +58 … +80: 2 s after the last fix, held there (hollow).
    const held = laneSnapshots(race([{ id: 'S', tr: track(0, -100, -120, 180, [[58, 80]]) }]), { me: 'S' });
    const h = boatIn(held.frames[1], 'S');
    expect(h.hold).toBe(true);
    near(h.pos, [0, -(-100 + 2 * 58)]);
  });

  it('a feed that starts a fraction of a second after a frame places the boat at its first fix', () => {
    const tr = track(0, -100, -60);
    tr.t[0] += 100; // −59.9 s
    const L = laneSnapshots(race([{ id: 'A', tr }]), { me: 'A' });
    near(boatIn(L.frames[0], 'A').pos, [0, -(-100 + 2 * -60)]);
    // …but not one that starts 10 s later.
    const late = laneSnapshots(race([{ id: 'A', tr: track(0, -100, -50) }]), { me: 'A' });
    expect(boatIn(late.frames[0], 'A').pos).toBeNull();
  });

  it('no data before the gun: the −60 s frame says so, the others still draw', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100, 0) }, { id: 'B', tr: track(50, -100, 0) }]), { me: 'A' });
    expect(L.frames[0].empty).toBe(true);
    expect(L.frames[0].caption).toBe('No data before the gun.');
    expect(L.frames[1].empty).toBe(false);
    expect(L.frames[2].empty).toBe(false);
    expect(boatIn(L.frames[1], 'A').trail[0][0]).toEqual([0, 100]);
    const html = laneSnapshotsHtml(race([{ id: 'A', tr: track(0, -100, 0) }]), L);
    expect(html).toContain('No data before the gun');
  });

  it('feed starts after −60 s but before the gun: the −60 s frame says when tracking starts', () => {
    const L = laneSnapshots(race([{ id: 'A', tr: track(0, -100, -30) }, { id: 'B', tr: track(50, -100, -20) }]), { me: 'A' });
    expect(L.frames[0].empty).toBe(true);
    expect(L.frames[0].caption).toBe('Tracking starts at gun −0:30.');
    expect(L.frames[0].label).toContain('Tracking starts at gun −0:30.');
    // The +1:00 frame still draws the pre-gun trail.
    near(boatIn(L.frames[1], 'A').trail[0][0], [0, -(-100 + 2 * -30)]);
  });

  it('the selected boat in a tracker gap: said once, not repeated under "Not tracked"', () => {
    const L = laneSnapshots(race([{ id: 'S', tr: track(0, -100, -120, 180, [[40, 80]]) }, { id: 'A', tr: track(20, -100) }, { id: 'Ghost' }]), { me: 'S' });
    const cap = L.frames[1].caption;
    expect(cap).toMatch(/^S: no position \(tracker gap\)\./);
    expect(cap.match(/\bS\b/g)).toHaveLength(1);
    expect(cap).toContain('Not tracked: Ghost.');
    expect(L.frames[1].label).toContain('S: no position (tracker gap). Not tracked: Ghost.');
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
    expect(html.match(/role="img" aria-label="Lane snapshot at gun −1:00: 3 of 3 boats placed/g)).toHaveLength(1);
    expect(html).toContain('data-s="-60"');
    expect(html).toContain('data-s="120"');
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

  it('three frames, wind-up, every boat placed in each (the feed starts at −59.9 s, so −60 s has no trail)', () => {
    expect(L.frames.map((f) => f.title)).toEqual(['gun −1:00', 'gun +1:00', 'gun +2:00']);
    expect(L.windUp).toBe(true);
    for (const f of L.frames) {
      expect(f.empty).toBe(false);
      expect(f.missing).toEqual([]);
      expect(f.placed).toBe(a.boats.length);
    }
    expect(at(0, 'USA 016').trail).toEqual([]);
    expect(at(1, 'USA 016').trail).toHaveLength(1);
    expect(at(2, 'USA 016').trail).toHaveLength(1);
    // The mark is upwind: the arrow points up the page.
    expect(L.markDir![1]).toBeLessThan(-0.9);
  });

  it("USA 016's lane: the RC side of the middle a minute before, at the pin end by +1:00, further left by +2:00; places toward the mark sensible", () => {
    const [b0, b1, b2] = [0, 1, 2].map((i) => at(i, 'USA 016'));
    expect(b0.third).toBe('rc');
    expect(b0.across!).toBeGreaterThan(0.6);
    expect(b0.across!).toBeLessThan(0.8);
    expect(b1.across!).toBeGreaterThan(-0.2);
    expect(b1.across!).toBeLessThan(0.05);
    expect(b2.across!).toBeLessThan(b1.across!);
    for (const b of [b0, b1, b2]) {
      expect(b.rank).toBeGreaterThanOrEqual(1);
      expect(b.rank).toBeLessThanOrEqual(a.boats.length);
    }
    // Up the order off the line: ≈ 12th a minute before, ≈ 6th at +1:00, ≈ 4th at +2:00.
    expect(b1.rank!).toBeLessThan(b0.rank!);
    expect(b2.rank!).toBeLessThanOrEqual(b1.rank!);
    expect(L.frames[1].caption).toMatch(/^USA 016: past the pin end \(by \d+% of the line\) · ≈ \d+(st|nd|rd|th) of 15 toward /);
  });

  it('USA 017 and USA 019 (OCS, cleared ≈ +26 s and ≈ +35 s at the bow): not over at −60 s, cleared by the +60 s frame, clean at +120 s', () => {
    for (const [sail, cleared] of [
      ['USA 017', 26],
      ['USA 019', 35],
    ] as const) {
      expect(L.frames.map((f) => boatIn(f, idOf(sail)).over)).toEqual([null, 'cleared', null]);
      expect((at(1, sail).clearedMs! - a.meta.gunMs) / 1000).toBeCloseTo(cleared, -0.5);
    }
    expect(L.frames[1].caption).toMatch(/OCS, cleared: .*USA 017 \+26 s/);
    expect(L.frames[1].caption).toMatch(/USA 019 \+35 s/);
    // Nobody else is ever marked over, and nobody is above the line a minute before.
    const others = L.frames.flatMap((f) => f.boats.filter((b) => b.over && b.id !== idOf('USA 017') && b.id !== idOf('USA 019')));
    expect(others).toEqual([]);
    expect(L.frames[0].boats.some((b) => b.courseSide)).toBe(false);
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
