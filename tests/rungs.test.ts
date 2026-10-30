import { describe, expect, it } from 'vitest';
import { bearingVec, dot, wrap180, type Vec } from '../src/analysis/geo';
import { ladderReader, leaderOf, rungXY, type LadderNow, type LadderRead } from '../src/analysis/coach/ladderNow';
import { legEnd, legLengths, rung } from '../src/analysis/coach/ladder';
import { liveWind } from '../src/analysis/coach/liveWind';
import { progressAt, progressBase } from '../src/analysis/coach/progress';
import { gapCourse, legWinds } from '../src/analysis/coach/timeGap';
import type { CoachModel } from '../src/analysis/coach';
import { makeTwdAt, windPoints } from '../src/analysis/wind';
import { scrubFrame, startClass, trackMap, trackMapView } from '../src/ui/charts';
import { rotator } from '../src/ui/mapPieces';
import {
  clipSpan,
  ladderText,
  paintRungs,
  placeLabel,
  Rects,
  rungAxis,
  rungDraws,
  rungLabel,
  rungsAt,
  type Rung,
  type RungAxis,
  type RungDraw,
  type RungLabelDraw,
} from '../src/ui/rungs';
import { coachRace, fixtureRace, starRace } from './helpers';

/**
 * Ladder rungs on the track map's scrubber (ui/rungs.ts, coach/ladderNow.ts): square to the wind at that moment
 * (coach/liveWind.ts) at the leader's and the selected boat's rungs (the Coach's layline rung), edge to edge across
 * the view, on beats and runs only; the selected boat's distance behind the leader along the wind; labels along their
 * lines. The leader is the map tooltip's first place (coach/progress.ts reads the same ladder).
 */

const cross = (u: Vec, v: Vec): number => u[0] * v[1] - u[1] * v[0];
const { a, m } = coachRace(fixtureRace());
const gun = a.meta.gunMs;
const lastFinish = Math.max(...a.boats.map((b) => b.finishMs ?? 0));
const mapTwd = a.wind.twdAtGunDeg;
const read = ladderReader(a, m);
const snap = (t: number): { leader: number; reads: LadderRead[]; now: LadderNow } => {
  const now = read(t);
  return { leader: now.leader, reads: now.reads.map((r) => ({ ...r })), now };
};
const times: number[] = [];
for (let t = gun + 30_000; t < lastFinish; t += 20_000) times.push(t);
const live = liveWind(m);

describe('rung geometry', () => {
  it('lies square to the leg’s wind, in map coordinates', () => {
    const ax = rungAxis('upwind', 220, 220)!;
    expect(ax.up[0]).toBeCloseTo(0, 9);
    expect(ax.up[1]).toBeCloseTo(-1, 9);
    const shifted = rungAxis('downwind', 235, 220)!;
    expect(dot(shifted.up, shifted.across)).toBeCloseTo(0, 9);
    const up = rotator(220)(bearingVec(235));
    expect(shifted.up[0]).toBeCloseTo(up[0], 9);
    expect(shifted.up[1]).toBeCloseTo(up[1], 9);
  });

  it('has none on a reach, or with no wind', () => {
    expect(rungAxis('reach', 220, 220)).toBeNull();
    expect(rungAxis('upwind', NaN, 220)).toBeNull();
  });

  it('clips a line to a box, or gives nothing outside it', () => {
    const out = { s0: 0, s1: 0 };
    const box = { x0: -100, y0: -50, x1: 100, y1: 50 };
    expect(clipSpan(0, 10, 1, 0, box, -Infinity, Infinity, out)).toBe(true);
    expect([out.s0, out.s1]).toEqual([-100, 100]);
    expect(clipSpan(0, 80, 1, 0, box, -Infinity, Infinity, out)).toBe(false);
    expect(clipSpan(0, 0, 0, 0, box, -Infinity, Infinity, out)).toBe(false);
  });
});

describe('the Coach’s ladder at a moment (coach/ladderNow.ts)', () => {
  const { course } = gapCourse(m);
  const lens = legLengths(course);

  it('is the Coach’s layline rung and course progress, on the wind at that moment', () => {
    let n = 0;
    for (const t of times) {
      const now = read(t);
      const twd = live.twdAt(t);
      const ta = live.taAt(t);
      expect(now.twdDeg).toBe(twd);
      expect(now.taDeg).toBe(ta);
      for (const r of now.reads) {
        if (r.est || r.done || course.kinds[r.leg] === 'reach' || r.leg === course.kinds.length - 1) continue;
        const p: Vec = [r.x, r.y];
        const kind = course.kinds[r.leg];
        // The legs before the last end on their mark: ladder.ts rung exactly, on the wind then.
        expect(r.rung).toBeCloseTo(rung(p, legEnd(course, r.leg, p), twd, kind, ta), 6);
        // Progress: the share of the leg's ladder from its start mark (on the same wind) climbed, scaled to its rhumb length.
        const a0 = course.pts[r.leg];
        const full = Math.max(rung(a0, legEnd(course, r.leg, a0), twd, kind, ta), 0.3 * lens[r.leg]);
        const before = lens.slice(0, r.leg).reduce((s, x) => s + x, 0);
        expect(r.prog).toBeCloseTo(before + lens[r.leg] * (1 - r.rung / full), 6);
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it('rungXY is ladder.ts rung', () => {
    const w = bearingVec(200);
    for (const [p, kind] of [
      [[30, -400], 'upwind'],
      [[600, -100], 'upwind'],
      [[-50, 300], 'downwind'],
      [[400, 500], 'downwind'],
    ] as const) {
      const up = kind === 'upwind';
      const ta = 84;
      const half = (up ? ta / 2 : 30) * (Math.PI / 180);
      expect(rungXY(p[0], p[1], 0, 0, w[0], w[1], up, Math.tan(half), Math.cos(half))).toBeCloseTo(rung([...p], [0, 0], 200, kind, ta), 9);
    }
  });

  it('marks a boat with no position estimated, exactly as the tooltip’s places do, and never leads with it', () => {
    // The leader at the first beat's middle loses its tracker for ten minutes there.
    const t0 = gun + 300_000;
    const lead = read(t0).reads[read(t0).leader].id;
    const tr = m.tracks.get(lead)!;
    const keep = [...tr.t.keys()].filter((i) => Math.abs(tr.t[i] - t0) > 300_000);
    const holed = { ...tr, t: Float64Array.from(keep, (i) => tr.t[i]), x: Float64Array.from(keep, (i) => tr.x[i]), y: Float64Array.from(keep, (i) => tr.y[i]) };
    const m3: CoachModel = { ...m, tracks: new Map([...m.tracks, [lead, holed]]) };
    const read3 = ladderReader(a, m3);
    const base = progressBase(a, m3);
    let est = 0;
    for (const t of [...times.filter((_, i) => i % 4 === 0), t0]) {
      const places = progressAt(a, m3, base, t).byId;
      const now = read3(t);
      for (const r of now.reads) {
        if (r.done) continue;
        const p = places.get(r.id);
        expect(r.est).toBe(p ? p.est : true);
        if (r.est) est++;
      }
    }
    expect(est).toBeGreaterThan(0);
    const now = read3(t0);
    expect(now.reads.find((r) => r.id === lead)!.est).toBe(true);
    expect(now.reads[now.leader].id).not.toBe(lead);
    expect(now.reads[now.leader].est).toBe(false);
  });

  it('leads with a finisher, then the furthest on; never an estimated place', () => {
    const r = (o: Partial<LadderRead>): Pick<LadderRead, 'est' | 'done' | 'finishMs' | 'prog'> => ({ est: false, done: false, finishMs: null, prog: 0, ...o });
    expect(leaderOf([r({ prog: 100 }), r({ prog: 300 }), r({ prog: 200 })])).toBe(1);
    // An estimated place further on is skipped.
    expect(leaderOf([r({ prog: 100 }), r({ prog: 900, est: true }), r({ prog: 200 })])).toBe(2);
    // Finished: ahead of anyone racing, the earlier first.
    expect(leaderOf([r({ prog: 900 }), r({ done: true, finishMs: 20 }), r({ done: true, finishMs: 10 })])).toBe(2);
    expect(leaderOf([r({ est: true })])).toBe(-1);
    expect(leaderOf([])).toBe(-1);
    // And on the race: the leader is never estimated.
    for (const t of times) {
      const now = read(t);
      if (now.leader >= 0) expect(now.reads[now.leader].est).toBe(false);
    }
  });

  it('reads each moment into the same objects, and the moment before again at once', () => {
    const one = read(times[10]);
    const reads = one.reads;
    const first = reads[0];
    const two = read(times[20]);
    expect(two).toBe(one);
    expect(two.reads).toBe(reads);
    expect(two.reads[0]).toBe(first);
    expect(read(times[20])).toBe(two);
    expect(ladderReader(a, m)).toBe(read);
  });
});

describe('the wind of the moment, beats and runs alike', () => {
  const { course } = gapCourse(m);
  const runs = course.kinds.flatMap((k, i) => (k === 'downwind' ? [i] : []));

  it('lays every rung square to the wind then, on whatever leg its boat is on', () => {
    expect(runs.length).toBeGreaterThan(0);
    let onRun = 0;
    for (const t of times) {
      const now = read(t);
      for (const x of now.reads) {
        if (x.est || x.done) continue;
        const r = rungsAt({ now, selected: x.id, mapTwdDeg: mapTwd }).find((q) => q.id === x.id);
        if (course.kinds[x.leg] === 'reach') {
          expect(r).toBeUndefined();
          continue;
        }
        expect(r!.axis.twdDeg).toBe(live.twdAt(t));
        expect(r!.axis.kind).toBe(course.kinds[x.leg]);
        if (course.kinds[x.leg] === 'downwind') onRun++;
      }
    }
    expect(onRun).toBeGreaterThan(20);
  });

  it('follows the Coach’s wind series on the runs, not the beats’ estimates at the middle of the run', () => {
    // The same race with the Coach's wind series reading 300° throughout: the runs' rungs follow it.
    const m2: CoachModel = { ...m, wind: { ...m.wind, twdAt: () => 300 } };
    const read2 = ladderReader(a, m2);
    const beatsMid = makeTwdAt(windPoints(a.wind), a.wind.twdAtGunDeg);
    for (const i of runs) {
      const legs = a.boats.map((b) => b.legs[i]).filter((l) => l != null);
      const mid = legs.reduce((s, l) => s + (l.startMs + l.endMs) / 2, 0) / legs.length;
      const now = read2(mid);
      const x = now.reads.find((r) => r.leg === i && !r.est)!;
      const r = rungsAt({ now, selected: x.id, mapTwdDeg: mapTwd }).find((q) => q.id === x.id)!;
      expect(r.axis.twdDeg).toBeCloseTo(300, 6);
      expect(Math.abs(beatsMid(mid) - 300)).toBeGreaterThan(5);
    }
  });
});

describe('a shift up the beat (Star NA race 4, the first beat)', () => {
  // The fleet's wind backs from ~52° at the gun to ~35° five minutes in and comes back to ~44° by eight; the leg's one
  // wind (timeGap.ts legWinds) is ~43° all the way.
  const star = coachRace(starRace());
  const sa = star.a;
  const sm = star.m;
  const sRead = ladderReader(sa, sm);
  const sLive = liveWind(sm);
  const sBase = progressBase(sa, sm);
  const sCourse = gapCourse(sm).course;
  const L0 = legLengths(sCourse)[0];
  const sGun = sa.meta.gunMs;
  const sMap = sa.wind.twdAtGunDeg;
  const firstRound = Math.min(...[...sm.tracks.values()].map((tr) => tr.bounds[1] ?? Infinity));
  const beat: number[] = [];
  for (let t = sGun + 10_000; t < firstRound; t += 10_000) beat.push(t);
  /** The tooltip's first measured place at `t` (app.ts placeReader shows no place for an estimated one). */
  const firstPlace = (t: number): string | null => {
    let best: string | null = null;
    let bp = Infinity;
    for (const [id, r] of progressAt(sa, sm, sBase, t).byId) {
      if (r.est || r.place >= bp) continue;
      best = id;
      bp = r.place;
    }
    return best;
  };

  it('is a real shift: the wind then moves well off the leg’s one wind', () => {
    const lw = legWinds(sCourse, sm.wind, sm.tracks.values(), sm.gunMs, sm.endMs)[0].twdDeg;
    const offs = beat.map((t) => wrap180(sLive.twdAt(t) - lw));
    expect(Math.max(...offs)).toBeGreaterThan(6);
    expect(Math.min(...offs)).toBeLessThan(-6);
  });

  it('leads with the tooltip’s first place at every moment through it, and over the whole race', () => {
    const lastFin = Math.max(...sa.boats.map((b) => b.finishMs ?? 0));
    const all = [...beat];
    for (let t = firstRound; t < lastFin; t += 30_000) all.push(t);
    let led = 0;
    for (const t of all) {
      const now = sRead(t);
      const first = firstPlace(t);
      expect(now.leader >= 0 ? now.reads[now.leader].id : null).toBe(first);
      if (first) led++;
    }
    expect(led).toBeGreaterThan(all.length * 0.9);
  });

  it('measures “behind” on the same wind as the places: the rung difference on the wind then, the places in its order', () => {
    let n = 0;
    for (const t of beat) {
      const now = sRead(t);
      if (now.leader < 0) continue;
      const lead = now.reads[now.leader];
      const places = progressAt(sa, sm, sBase, t).byId;
      const twd = sLive.twdAt(t);
      const ta = sLive.taAt(t);
      const rungAt = (p: Vec): number => rung(p, legEnd(sCourse, 0, p), twd, 'upwind', ta);
      const full = Math.max(rungAt(sCourse.pts[0]), 0.3 * L0);
      for (const x of now.reads) {
        if (x.est || x.done || x.id === lead.id || x.leg !== 0 || lead.leg !== 0) continue;
        const sel = rungsAt({ now, selected: x.id, mapTwdDeg: sMap }).find((r) => r.role === 'sel')!;
        const behind = rungAt([x.x, x.y]) - rungAt([lead.x, lead.y]);
        expect(sel.behindM).toBeCloseTo(behind, 6);
        expect(sel.behindM!).toBeGreaterThanOrEqual(-1e-9);
        // Further behind up the ladder is further down the tooltip's places, the same distance to go apart (scaled to the rhumb line).
        const pl = places.get(x.id)!;
        const pd = places.get(lead.id)!;
        if (behind > 1e-6) expect(pl.place).toBeGreaterThan(pd.place);
        expect(pl.dtg - pd.dtg).toBeCloseTo((behind * L0) / full, 6);
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it('turns the rungs with the wind: square to it at two moments across the shift', () => {
    const seen: number[] = [];
    for (const t of [sGun + 30_000, sGun + 270_000]) {
      const now = sRead(t);
      const [r] = rungsAt({ now, selected: null, mapTwdDeg: sMap });
      const twd = sLive.twdAt(t);
      expect(r.axis.twdDeg).toBe(twd);
      // Into the wind then, in map coordinates, and the line square to it.
      const up = rotator(sMap)(bearingVec(twd));
      expect(r.axis.up[0]).toBeCloseTo(up[0], 9);
      expect(r.axis.up[1]).toBeCloseTo(up[1], 9);
      expect(dot(r.axis.up, r.axis.across)).toBeCloseTo(0, 9);
      const [d] = rungDraws([r], { box: { x0: -5000, y0: -5000, x1: 5000, y1: 5000 }, unit: 1, k: 1 }, { sail: (id) => id, dims: null }, new Rects());
      expect(dot([d.x2 - d.x1, d.y2 - d.y1], r.axis.up)).toBeCloseTo(0, 6);
      seen.push(twd);
    }
    // More than 10° apart: the rungs turned with the shift.
    expect(Math.abs(wrap180(seen[1] - seen[0]))).toBeGreaterThan(10);
  });
});

describe('leader and behind', () => {
  const { course } = gapCourse(m);

  it('the leader’s rung is never behind the selected boat’s, and the distance is the Coach’s rung difference', () => {
    let same = 0;
    for (const t of times) {
      const now = read(t);
      if (now.leader < 0) continue;
      for (const sel of now.reads) {
        const rungs = rungsAt({ now, selected: sel.id, mapTwdDeg: mapTwd }).map((r) => ({ ...r, at: [...r.at] as Vec }));
        const lead = rungs.find((r) => r.role === 'leader');
        const mine = rungs.find((r) => r.role === 'sel');
        if (!lead || !mine) continue;
        expect(lead.leg).toBeGreaterThanOrEqual(mine.leg);
        if (lead.leg !== mine.leg) {
          expect(mine.behindM).toBeNull();
          continue;
        }
        const lr = now.reads[now.leader];
        // Behind: its rung less the leader's (ladder.ts rung on the Coach's leg wind), never negative.
        expect(mine.behindM).toBeCloseTo(sel.rung - lr.rung, 9);
        expect(mine.behindM!).toBeGreaterThanOrEqual(-1e-9);
        // The lines are that far apart along the wind, the leader's the further up a beat (down a run).
        const up = lead.axis.up;
        const apart = dot([lead.at[0] - mine.at[0], lead.at[1] - mine.at[1]], up) * (lead.axis.kind === 'upwind' ? 1 : -1);
        expect(apart).toBeCloseTo(mine.behindM!, 6);
        same++;
      }
    }
    expect(same).toBeGreaterThan(100);
  });

  it('puts a rung through its boat inside the laylines', () => {
    let through = 0;
    for (const t of times) {
      const now = read(t);
      for (const x of now.reads) {
        if (x.est || x.done || x.leg >= course.kinds.length - 1 || course.kinds[x.leg] === 'reach') continue;
        const r = rungsAt({ now, selected: x.id, mapTwdDeg: mapTwd }).find((q) => q.id === x.id);
        if (!r) continue;
        const p = rotator(mapTwd)([x.x, x.y]);
        const off = dot([p[0] - r.at[0], p[1] - r.at[1]], r.axis.up);
        // Inside the laylines: on the line; past one, the line is behind the boat.
        expect(off * (r.axis.kind === 'upwind' ? 1 : -1)).toBeGreaterThanOrEqual(-1e-6);
        if (Math.abs(off) < 1e-6) through++;
      }
    }
    expect(through).toBeGreaterThan(100);
  });

  it('labels the leader and the selected boat by sail number, in lengths for a known class', () => {
    expect(rungLabel({ role: 'leader', behindM: null }, 'USA 11', null)).toBe('Leader');
    expect(rungLabel({ role: 'sel', behindM: 120.4 }, 'USA 11', null)).toBe('USA 11 · 120 m behind');
    expect(rungLabel({ role: 'sel', behindM: null }, 'USA 11', null)).toBe('USA 11');
    expect(ladderText(-0.4, null)).toBe('level');
    expect(ladderText(6.9, { loaM: 6.9 })).toBe('1 length behind');
    expect(ladderText(-20, { loaM: 6.9 })).toBe('2.9 lengths ahead');
  });
});

describe('label placement', () => {
  const view = { x0: -500, y0: -500, x1: 500, y1: 500 };
  const out = (): RungLabelDraw => ({ x: 0, y: 0, deg: 0, text: '', fs: 0, sw: 0, box: { x0: 0, y0: 0, x1: 0, y1: 0 } });
  const W = 80;
  const H = 12;
  const GAP = 3;

  it('sits just off its own line, square to it, at the end asked for', () => {
    const l = out();
    expect(placeLabel(0, 100, 1, 0, -400, 400, W, H, GAP, 'end', view, new Rects(), l)).toBe(true);
    expect(l.x).toBeCloseTo(400 - W / 2, 9);
    expect(l.y).toBeCloseTo(100 - H / 2 - GAP, 9);
    expect(l.deg).toBeCloseTo(0, 9);
    const s = out();
    placeLabel(0, 100, 1, 0, -400, 400, W, H, GAP, 'start', view, new Rects(), s);
    expect(s.x).toBeCloseTo(-400 + W / 2, 9);
  });

  it('slides along the line off whatever is in the way', () => {
    const avoid = new Rects();
    // A boat and its label where the leader's would go.
    avoid.add(300, 60, 420, 110);
    const l = out();
    placeLabel(0, 100, 1, 0, -400, 400, W, H, GAP, 'end', view, avoid, l);
    expect(avoid.hits(l.box.x0, l.box.y0, l.box.x1, l.box.y1)).toBe(0);
    expect(l.x).toBeLessThan(300);
    // Still just off its line.
    expect(l.y).toBeCloseTo(100 - H / 2 - GAP, 9);
  });

  it('goes below its line when above is taken all along, and falls back to the least crowded spot', () => {
    const avoid = new Rects();
    avoid.add(-500, 0, 500, 99);
    const l = out();
    placeLabel(0, 100, 1, 0, -400, 400, W, H, GAP, 'end', view, avoid, l);
    expect(l.y).toBeCloseTo(100 + H / 2 + GAP, 9);
    avoid.add(-500, 101, 500, 200);
    const f = out();
    expect(placeLabel(0, 100, 1, 0, -400, 400, W, H, GAP, 'end', view, avoid, f)).toBe(true);
    expect(Number.isFinite(f.x)).toBe(true);
  });

  it('has none on a line too short for it', () => {
    expect(placeLabel(0, 100, 1, 0, -30, 30, W, H, GAP, 'end', view, new Rects(), out())).toBe(false);
  });

  it('reads on a steep line: along it, never upside down', () => {
    for (const twd of [130, 160, 200, 250, 300, 310]) {
      const ax = rungAxis('upwind', twd, 220)!;
      const rungs: Rung[] = [{ role: 'leader', id: 'A', leg: 0, axis: ax, at: [0, 0], rung: 0, behindM: null }];
      const [d] = rungDraws(rungs, { box: view, unit: 1, k: 1 }, { sail: (id) => id, dims: null }, new Rects());
      const l = d.label!;
      expect(Math.abs(l.deg)).toBeLessThanOrEqual(90);
      // Along its line, and square off it by half its height and the gap.
      const dir: Vec = [d.x2 - d.x1, d.y2 - d.y1];
      const L = Math.hypot(...dir);
      expect(Math.abs(Math.atan2(dir[1], dir[0]) - (l.deg * Math.PI) / 180) % Math.PI).toBeLessThan(1e-9);
      const off = cross(dir, [l.x - d.x1, l.y - d.y1]) / L;
      expect(Math.abs(off)).toBeCloseTo((1.2 * 10.5) / 2 + 3, 6);
    }
  });

  it('keeps the selected boat’s label off the leader’s', () => {
    const ax = rungAxis('upwind', 220, 220)!;
    const rungs: Rung[] = [
      { role: 'leader', id: 'A', leg: 0, axis: ax, at: [0, 0], rung: 100, behindM: null },
      { role: 'sel', id: 'B', leg: 0, axis: ax, at: [0, 4], rung: 104, behindM: 4 },
    ];
    // A view so narrow the two would sit on each other at the same spot.
    const [l, s] = rungDraws(rungs, { box: { x0: -80, y0: -300, x1: 80, y1: 300 }, unit: 1, k: 1 }, { sail: (id) => id, dims: null }, new Rects());
    const [p, q] = [l.label!.box, s.label!.box];
    expect(p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1).toBe(false);
  });
});

describe('across the view', () => {
  const ax = rungAxis('downwind', 235, 220)!;
  const rungs: Rung[] = [{ role: 'leader', id: 'A', leg: 0, axis: ax, at: [40, -20], rung: 0, behindM: null }];

  it('runs edge to edge across the view drawn, through its point', () => {
    for (const box of [
      { x0: -500, y0: -1000, x1: 500, y1: 200 },
      { x0: 0, y0: -60, x1: 90, y1: 10 },
    ]) {
      const [d] = rungDraws(rungs, { box, unit: 1, k: 1 }, { sail: (id) => id, dims: null }, new Rects());
      const onEdge = (x: number, y: number): boolean =>
        [Math.abs(x - box.x0), Math.abs(x - box.x1), Math.abs(y - box.y0), Math.abs(y - box.y1)].some((e) => e < 1e-6) &&
        x >= box.x0 - 1e-6 &&
        x <= box.x1 + 1e-6 &&
        y >= box.y0 - 1e-6 &&
        y <= box.y1 + 1e-6;
      expect(onEdge(d.x1, d.y1)).toBe(true);
      expect(onEdge(d.x2, d.y2)).toBe(true);
      expect(Math.abs(cross([d.x2 - d.x1, d.y2 - d.y1], [40 - d.x1, -20 - d.y1]))).toBeLessThan(1e-6);
    }
  });

  it('draws none for a rung outside the view', () => {
    expect(rungDraws(rungs, { box: { x0: 1000, y0: 1000, x1: 1100, y1: 1100 }, unit: 1, k: 1 }, { sail: (id) => id, dims: null }, new Rects())).toHaveLength(0);
  });

  it('on the race map, follows a zoomed and panned view', () => {
    const t = gun + 150_000;
    const leader = read(t).reads[read(t).leader].id;
    const full = trackMapView(a, null).box;
    const view = { cx: (full.x0 + full.x1) / 2 + 150, cy: (full.y0 + full.y1) / 2 - 300, k: 4 };
    const vb = trackMapView(a, null, view).view;
    const f = scrubFrame(a, null, null, { view }, { t, win: [t - 120_000, t], trailMs: 120_000, ladder: read(t) });
    for (const d of f.rungs) {
      for (const [x, y] of [
        [d.x1, d.y1],
        [d.x2, d.y2],
      ]) {
        const edge = Math.min(Math.abs(x - vb.x0), Math.abs(x - vb.x1), Math.abs(y - vb.y0), Math.abs(y - vb.y1));
        expect(edge).toBeLessThan(1e-6);
      }
    }
    expect(leader).toBeTruthy();
  });
});

describe('rungs on the race map', () => {
  const scrub = (t: number, highlight: string | null = null, ladder: LadderNow | null = read(t)) =>
    scrubFrame(a, highlight, null, {}, { t, win: [t - 120_000, t], trailMs: 120_000, ladder });

  it('has a layer for them, between the trails and the boats', () => {
    const svg = trackMap(a, null, null, { scrub: true });
    const at = ['g class="scrub-ocs"', 'g class="scrub-rungs"', 'g class="scrub-dots"'].map((s) => svg.indexOf(s));
    expect(at.every((x) => x > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });

  it('draws the leader’s and the selected boat’s on the first beat, labelled, clear of the boats', () => {
    const t = gun + 150_000;
    const now = snap(t);
    const lead = now.reads[now.leader];
    const other = now.reads.find((r) => !r.est && r.id !== lead.id && r.leg === lead.leg)!;
    expect(scrub(t).rungs.map((r) => r.role)).toEqual(['leader']);
    const f = scrub(t, other.id);
    const [l, s] = f.rungs.map((d) => ({ ...d, label: d.label && { ...d.label } }));
    expect([l.role, s.role]).toEqual(['leader', 'sel']);
    expect(l.label?.text).toBe('Leader');
    const sail = a.boats.find((b) => b.id === other.id)!.sail;
    expect(startClass(a)).not.toBeNull();
    expect(s.label?.text).toBe(`${sail} · ${ladderText(other.rung - lead.rung, startClass(a)!.dims)}`);
    expect(s.label?.text).toMatch(/ lengths? behind$/);
    // Clear of the boats on the map (their hulls and labels).
    const boxes = f.boats.map((b) => [b.mx, b.my] as Vec);
    for (const d of [l, s]) {
      const bx = d.label!.box;
      expect(boxes.some(([x, y]) => x > bx.x0 && x < bx.x1 && y > bx.y0 && y < bx.y1)).toBe(false);
    }
  });

  it('draws none before the gun or without the ladder; none for a selected leader twice', () => {
    expect(scrub(gun - 30_000, a.boats[1].id).rungs).toHaveLength(0);
    expect(scrub(gun + 150_000, a.boats[1].id, null).rungs).toHaveLength(0);
    const now = read(gun + 150_000);
    expect(scrub(gun + 150_000, now.reads[now.leader].id).rungs.map((r) => r.role)).toEqual(['leader']);
  });

  it('draws none once the boats have finished', () => {
    expect(scrub(lastFinish + 1000, a.boats[1].id).rungs).toHaveLength(0);
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

describe('reuse from frame to frame', () => {
  const ax: RungAxis = rungAxis('upwind', 220, 220)!;
  const sc = { box: { x0: -400, y0: -800, x1: 400, y1: 100 }, unit: 1, k: 1 };
  const txt = { sail: (id: string) => id, dims: null };
  const draws = (y: number, sel: boolean): readonly RungDraw[] =>
    rungDraws(
      [
        { role: 'leader', id: 'A', leg: 0, axis: ax, at: [0, y], rung: 0, behindM: null },
        ...(sel ? [{ role: 'sel' as const, id: 'B', leg: 0, axis: ax, at: [0, y + 50] as [number, number], rung: 50, behindM: 50 }] : []),
      ],
      sc,
      txt,
      new Rects(),
    );

  it('fills the same rungs, axes, draws and labels, and keeps the label text while it says the same', () => {
    const now = read(times[30]);
    const sel = now.reads.find((r, i) => i !== now.leader && !r.est)!.id;
    const one = rungsAt({ now, selected: sel, mapTwdDeg: mapTwd });
    const objs = [...one];
    const axes = one.map((r) => ({ axis: r.axis, up: r.axis.up, across: r.axis.across, at: r.at }));
    const twd1 = one[0].axis.twdDeg;
    const two = rungsAt({ now: read(times[31]), selected: sel, mapTwdDeg: mapTwd });
    expect(two).toBe(one);
    two.forEach((r, i) => {
      expect(r).toBe(objs[i]);
      // The wind moved and the axis with it, in the same objects.
      expect(r.axis).toBe(axes[i].axis);
      expect(r.axis.up).toBe(axes[i].up);
      expect(r.axis.across).toBe(axes[i].across);
      expect(r.at).toBe(axes[i].at);
    });
    expect(two[0].axis.twdDeg).toBe(live.twdAt(times[31]));
    expect(two[0].axis.twdDeg).not.toBe(twd1);
    // The wind's samples are worked out once per race, and the moment read is kept.
    expect(liveWind(m)).toBe(live);
    expect(read(times[31])).toBe(read(times[31]));
    const d1 = draws(-300, true);
    const [p, q] = d1;
    const text = q.label!.text;
    const d2 = draws(-310, true);
    expect(d2).toBe(d1);
    expect(d2[0]).toBe(p);
    expect(d2[1].label).toBe(q.label);
    // The same distance: the very same string, not a new one.
    expect(d2[1].label!.text).toBe(text);
  });

  it('paints each rung once, then sets only what moved', () => {
    const doc = new Doc();
    const layer = new El(doc);
    paintRungs(layer as unknown as Element, draws(-300, true));
    expect(doc.created).toBe(6);
    expect(layer.children).toHaveLength(2);
    const sets = doc.sets;
    expect(paintRungs(layer as unknown as Element, draws(-300, true))).toEqual({ created: 0, set: 0 });
    expect(doc.sets).toBe(sets);
    expect(paintRungs(layer as unknown as Element, draws(-310, true)).created).toBe(0);
    paintRungs(layer as unknown as Element, draws(-310, false));
    expect(layer.children[1].attrs.get('display')).toBe('none');
    expect(paintRungs(layer as unknown as Element, draws(-310, true)).created).toBe(0);
    expect(layer.children[1].attrs.has('display')).toBe(false);
    expect(doc.created).toBe(6);
    expect(layer.children[1].children[1].textContent).toBe('B · 50 m behind');
    expect(layer.children[0].children[1].attrs.get('transform')).toMatch(/^rotate\(/);
  });
});
