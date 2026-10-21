import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { fullRateBuffers, fullRateTracks, fullRateWants } from '../src/analysis/fullRate';
import { interp } from '../src/analysis/geo';
import { drawingBuffers } from '../src/analysis/transfer';
import { MAP_PRE_MS, PRE_LEG, type BoatDrawing, type FullRateTrack, type TrackSegment } from '../src/analysis/types';
import type { RaceData } from '../src/data/types';
import { boatsAt, mapBox, scrubFrame, scrubPoints, trackMap, trackMapView, trackPointsFull } from '../src/ui/charts';
import { localTime } from '../src/ui/format';
import {
  CHUNK,
  MAP_FULL_K,
  MAP_FULL_SPAN_M,
  MAP_HOLD_S,
  boatAt,
  drawingPieces,
  legRanges,
  lowerBound,
  nearRanges,
  rotTrack,
  timeRange,
  upperBound,
  useFullRate,
  type MapPiece,
} from '../src/ui/mapPieces';
import { PRE_START, mapTipLines, pickMapPoint } from '../src/ui/mapPoints';
import {
  DEFAULT_TRAIL,
  formatTParam,
  gunRel,
  mapTimeSearch,
  paramOfTime,
  parseSpeed,
  parseTParam,
  parseTrail,
  playFrom,
  playStep,
  scrubLabel,
  scrubParams,
  scrubWindow,
  timeOfParam,
  trailWindow,
} from '../src/ui/scrub';
import { fixtureRace } from './helpers';

const data = fixtureRace();
const a = analyzeRace(data);
const gun = a.meta.gunMs;
const twd = a.wind.twdAtGunDeg;

/** A 1 Hz segment along y = 0 (x east, 3 m per s) from `t0`, with the fixes from `holeAt` on moved `holeMs` later. */
function seg(n: number, t0 = 0, leg = 0, holeAt = n, holeMs = 0): TrackSegment {
  return {
    leg,
    x: Float32Array.from({ length: n }, (_, i) => i * 3),
    y: new Float32Array(n),
    t: Float64Array.from({ length: n }, (_, i) => t0 + i * 1000 + (i >= holeAt ? holeMs : 0)),
    sog: Float32Array.from({ length: n }, (_, i) => 5 + i * 0.1),
    roll: Float32Array.from({ length: n }, (_, i) => -i),
  };
}
const drawing = (segments: TrackSegment[], pre?: TrackSegment): BoatDrawing => ({ ...a.drawings[0], id: 'b', segments, pre });

describe('a boat at a moment (the scrubber dots)', () => {
  const d = drawing([seg(10, 0, 0, 5, 20_000)]);
  const ranges = legRanges(d, true);

  it('interpolates linearly between fixes', () => {
    const b = boatAt('b', ranges, 2500, 2000, 0)!;
    expect(b.x).toBeCloseTo(7.5);
    expect(b.y).toBe(0);
    expect(b.sog).toBeCloseTo(5.25);
    expect(b.roll).toBeCloseTo(-2.5);
    expect(b.cog).toBeCloseTo(90);
    expect(b.hold).toBe(false);
    expect(b.leg).toBe(0);
    // Map coordinates: the rotated position (no rotation at twd 0 bar the y flip).
    expect(b.mx).toBeCloseTo(7.5);
  });

  it('sits on a fix at its exact time', () => {
    const b = boatAt('b', ranges, 3000, 2000, 0)!;
    expect(b.x).toBe(9);
    expect(b.sog).toBeCloseTo(5.3);
    // The last fix: there, too.
    expect(boatAt('b', ranges, 9000 + 20_000, 2000, 0)!.x).toBe(27);
  });

  it('has no dot inside a gap (after a short hold), nor before the first or after the last fix', () => {
    // The hole runs 4 s → 25 s.
    const hold = boatAt('b', ranges, 4000 + MAP_HOLD_S * 1000 - 1, 2000, 0)!;
    expect(hold.hold).toBe(true);
    expect(hold.x).toBe(12);
    expect(hold.lastFix).toBe(4000);
    expect(boatAt('b', ranges, 4000 + MAP_HOLD_S * 1000 + 1, 2000, 0)).toBeNull();
    expect(boatAt('b', ranges, 15_000, 2000, 0)).toBeNull();
    expect(boatAt('b', ranges, -1, 2000, 0)).toBeNull();
    expect(boatAt('b', ranges, 29_001, 2000, 0)).toBeNull();
  });

  it('reads the leg the boat is on, and before the gun the pre-start track', () => {
    const pre = { ...seg(5, -4000), leg: PRE_LEG };
    const two = drawing([seg(5, 0, 0), seg(5, 4000, 1)], pre);
    const r = legRanges(two, true);
    expect(r.map((x) => x.leg)).toEqual([PRE_LEG, 0, 1]);
    expect(boatAt('b', r, -2500, 2000, 0)!.leg).toBe(PRE_LEG);
    expect(boatAt('b', r, 2500, 2000, 0)!.leg).toBe(0);
    expect(boatAt('b', r, 6500, 2000, 0)!.leg).toBe(1);
    // Without the pre-gun track (the full-race view), nothing before the gun.
    expect(boatAt('b', legRanges(two, false), -2500, 2000, 0)).toBeNull();
    // The shared last pre-start fix is the first beat (the gun), not pre-start.
    expect(boatAt('b', r, 0, 2000, 0)!.leg).toBe(0);
    expect(boatAt('b', r, -1, 2000, 0)!.leg).toBe(PRE_LEG);
  });

  it('puts every boat of a real race on the first beat at the gun', () => {
    const boats = boatsAt(a, null, gun);
    expect(boats.length).toBe(a.drawings.length);
    for (const b of boats) expect(b.leg).toBe(0);
  });

  it('gives every boat of a real race a dot mid-race, on the track', () => {
    const t = gun + 5 * 60_000;
    const boats = boatsAt(a, null, t);
    expect(boats.length).toBe(a.drawings.length);
    for (const b of boats) {
      const s = a.drawings.find((d) => d.id === b.id)!.segments.find((g) => g.t[0] <= t && g.t[g.t.length - 1] >= t)!;
      expect(b.x).toBeCloseTo(interp(s.t, s.x, t), 3);
      expect(b.leg).toBe(s.leg);
    }
  });
});

describe('trail windows', () => {
  const t = Float64Array.from([0, 1000, 2000, 2000, 3000, 5000]);

  it('finds index ranges by binary search', () => {
    expect(lowerBound(t, 2000)).toBe(2);
    expect(upperBound(t, 2000)).toBe(4);
    expect(timeRange(t, 500, 2500)).toEqual([1, 4]);
    expect(timeRange(t, 6000, 7000)).toEqual([6, 6]);
    expect(timeRange(t, 1000, 3000, 2, 5)).toEqual([2, 5]);
  });

  it('runs 30 s, 2 min or the whole window up to t', () => {
    const w = scrubWindow(a);
    expect(w.t0).toBe(gun - MAP_PRE_MS);
    expect(w.t1).toBe(Math.max(...a.drawings.map((d) => d.segments.at(-1)!.t.at(-1)!)));
    const t1 = gun + 600_000;
    expect(trailWindow(t1, '30', w)).toEqual([t1 - 30_000, t1]);
    expect(trailWindow(t1, '120', w)).toEqual([t1 - 120_000, t1]);
    expect(trailWindow(t1, 'all', w)).toEqual([w.t0, t1]);
    // Never before the window opens.
    expect(trailWindow(w.t0 + 10_000, '120', w)).toEqual([w.t0, w.t0 + 10_000]);
  });

  it('draws only the fixes inside [t − trail, t]', () => {
    const w = scrubWindow(a);
    for (const trail of ['30', '120', 'all'] as const) {
      const t1 = gun + 400_000;
      const win = trailWindow(t1, trail, w);
      const f = scrubFrame(a, null, null, {}, { t: t1, win });
      expect(f.pieces.length).toBeGreaterThan(0);
      for (const pc of f.pieces) {
        expect(pc.src.t[pc.i0]).toBeGreaterThanOrEqual(win[0]);
        expect(pc.src.t[pc.i1 - 1]).toBeLessThanOrEqual(win[1]);
        // …and every fix inside it (none left out at either end).
        if (pc.i0 > 0 && pc.leg === PRE_LEG) expect(pc.src.t[pc.i0 - 1]).toBeLessThan(win[0]);
        if (pc.i1 < pc.src.t.length) expect(pc.src.t[pc.i1]).toBeGreaterThan(win[1]);
      }
      const n = f.pieces.reduce((s, p) => s + p.i1 - p.i0, 0);
      const all = a.drawings.reduce((s, d) => s + d.segments.reduce((q, g) => q + g.t.length, 0) + (d.pre?.t.length ?? 0), 0);
      expect(n).toBeLessThan(all);
    }
  });

  it('includes the pre-gun track only while scrubbing the whole race', () => {
    const w = scrubWindow(a);
    const f = scrubFrame(a, null, null, {}, { t: gun + 30_000, win: trailWindow(gun + 30_000, '120', w) });
    expect(f.pieces.some((p) => p.leg === PRE_LEG)).toBe(true);
    expect(scrubFrame(a, null, 0, {}, { t: gun + 30_000, win: trailWindow(gun + 30_000, '120', w) }).pieces.some((p) => p.leg === PRE_LEG)).toBe(false);
    expect(drawingPieces(twd, a.drawings[0], { leg: null }).some((p) => p.leg === PRE_LEG)).toBe(false);
  });

  it('zoomed in, keeps only the stretches near the view (and a fix or two either side)', () => {
    const d = a.drawings[0];
    const s = d.segments[1];
    const { x: rx, y: ry } = rotTrack(twd, s);
    const mid = s.t.length >> 1;
    const clip = { x0: rx[mid] - 20, x1: rx[mid] + 20, y0: ry[mid] - 20, y1: ry[mid] + 20 };
    const ranges = nearRanges(rx, ry, 0, s.t.length, clip);
    expect(ranges.length).toBeGreaterThan(0);
    const kept = ranges.reduce((n, [i0, i1]) => n + i1 - i0, 0);
    expect(kept).toBeLessThan(s.t.length);
    const inClip = (i: number): boolean => rx[i] >= clip.x0 && rx[i] <= clip.x1 && ry[i] >= clip.y0 && ry[i] <= clip.y1;
    // Every fix in the view is kept…
    for (let i = 0; i < s.t.length; i++) if (inClip(i)) expect(ranges.some(([i0, i1]) => i >= i0 && i < i1)).toBe(true);
    // …and each kept stretch is a chunk touching the view, grown by at most two fixes.
    for (const [i0, i1] of ranges) expect(i1 - i0).toBeLessThanOrEqual(Math.ceil((i1 - i0) / CHUNK) * CHUNK + 4);
    expect(ranges.some(([i0, i1]) => i0 <= mid && mid < i1)).toBe(true);
  });

  it('draws a zoomed map exactly as before from the trimmed pieces', () => {
    const box = mapBox(a, null);
    const view = { cx: box.x0 + (box.x1 - box.x0) * 0.4, cy: box.y0 + (box.y1 - box.y0) * 0.5, k: 8 };
    const all = drawingPieces(twd, a.drawings[0], { leg: null });
    const near = drawingPieces(twd, a.drawings[0], { leg: null, clip: { ...trackMapView(a, null, view).view } });
    expect(near.reduce((n, p) => n + p.i1 - p.i0, 0)).toBeLessThan(all.reduce((n, p) => n + p.i1 - p.i0, 0));
  });
});

describe('t= in the URL', () => {
  it('parses gun-relative whole seconds, negative before the gun', () => {
    expect(parseTParam('90')).toBe(90);
    expect(parseTParam('-45')).toBe(-45);
    expect(parseTParam('−45')).toBe(-45);
    expect(parseTParam('+30')).toBe(30);
    expect(parseTParam(' 12 ')).toBe(12);
    expect(parseTParam('0')).toBe(0);
    for (const junk of ['', 'abc', '1.5', '1e3', '--4', '12s', '1234567']) expect(parseTParam(junk)).toBeNull();
    expect(parseTParam(null)).toBeNull();
    expect(parseTParam(undefined)).toBeNull();
  });

  it('formats whole seconds with an ASCII minus', () => {
    expect(formatTParam(-45)).toBe('-45');
    expect(formatTParam(90.4)).toBe('90');
    expect(formatTParam(-0)).toBe('0');
    expect(parseTParam(formatTParam(-120))).toBe(-120);
  });

  it('clamps to the race window', () => {
    const w = scrubWindow(a);
    expect(timeOfParam(-45, gun, w)).toBe(gun - 45_000);
    expect(timeOfParam(-600, gun, w)).toBe(w.t0);
    expect(timeOfParam(999_999, gun, w)).toBe(w.t1);
    expect(paramOfTime(gun - 44_600, gun)).toBe(-45);
  });

  it('writes t= (and trail= off the default) while scrubbing, and removes both for the full race', () => {
    expect(scrubParams(gun + 90_000, gun, DEFAULT_TRAIL)).toEqual({ t: '90', trail: null });
    expect(scrubParams(gun - 45_000, gun, 'all')).toEqual({ t: '-45', trail: 'all' });
    expect(scrubParams(null, gun, 'all')).toEqual({ t: null, trail: null });
    expect(mapTimeSearch('?event=x&div=J70&race=8', -45)).toBe('?event=x&div=J70&race=8&t=-45');
    expect(mapTimeSearch('?event=x&t=10&trail=30', null)).toBe('?event=x');
    expect(mapTimeSearch('', 600, '30')).toBe('?t=600&trail=30');
    expect(parseTrail('30')).toBe('30');
    expect(parseTrail('bogus')).toBe(DEFAULT_TRAIL);
    expect(parseSpeed('16')).toBe(16);
    expect(parseSpeed('3')).toBe(1);
  });

  it('labels the time locally and from the gun', () => {
    expect(gunRel(gun + 90_000, gun)).toBe('gun +1:30');
    expect(gunRel(gun - 45_000, gun)).toBe('gun −0:45');
    expect(gunRel(gun, gun)).toBe('gun +0:00');
    expect(scrubLabel(gun + 90_000, a)).toBe(`${localTime(gun + 90_000, a.meta.tzOffsetMs)} · gun +1:30`);
  });
});

describe('the pre-gun track', () => {
  it('runs from ≈ 2 min before the gun to where the segments start, at the feed rate', () => {
    for (const d of a.drawings) {
      const pre = d.pre!;
      expect(pre.leg).toBe(PRE_LEG);
      expect(pre.t[0]).toBeGreaterThanOrEqual(gun - MAP_PRE_MS);
      expect(pre.t[0]).toBeLessThan(gun - MAP_PRE_MS + 10_000);
      expect(pre.t.at(-1)).toBe(d.segments[0].t[0]);
      for (const arr of [pre.x, pre.y, pre.sog]) expect(arr.length).toBe(pre.t.length);
      // Every fix of the feed in that span (not thinned to 1 Hz).
      const raw = data.boats.find((b) => b.id === d.id)!.track.t;
      const want = new Set(Array.from(raw).filter((t) => t >= gun - MAP_PRE_MS && t <= d.segments[0].t[0])).size;
      expect(pre.t.length).toBe(want);
    }
    const steps = a.drawings.flatMap((d) => Array.from(d.pre!.t.subarray(1), (t, i) => t - d.pre!.t[i]));
    expect(steps.some((s) => s < 1000)).toBe(true);
  });

  it('lines up with the segments (same coordinates: the shared fix is the same point)', () => {
    for (const d of a.drawings) {
      expect(d.pre!.x.at(-1)).toBe(d.segments[0].x[0]);
      expect(d.pre!.y.at(-1)).toBe(d.segments[0].y[0]);
    }
  });

  it('has its buffers moved, not copied, to the page', () => {
    const fresh = analyzeRace(fixtureRace());
    const bufs = drawingBuffers(fresh);
    const pre = fresh.drawings[0].pre!;
    for (const arr of [pre.x, pre.y, pre.t, pre.sog]) expect(bufs).toContain(arr.buffer);
    const n = pre.t.length;
    const moved = structuredClone(fresh, { transfer: bufs });
    expect(moved.drawings[0].pre!.t.length).toBe(n);
    expect(pre.t.length).toBe(0);
  });

  it('is not drawn in the full-race view', () => {
    expect(trackMap(a, null, null, {})).not.toContain('trk pre');
    const f = scrubFrame(a, null, null, {}, { t: gun - 30_000, win: [gun - MAP_PRE_MS, gun - 30_000] });
    expect(f.tracks).toContain('trk pre');
    expect(f.tracks).not.toMatch(/class="trk"/);
  });
});

/** The race with boat `id` given a 10 Hz log (Boat.fullRate) along its feed track, rolled 5° to starboard. */
function withLog(src: RaceData, id: string): RaceData {
  const boats = src.boats.map((b) => {
    if (b.id !== id) return b;
    const t0 = src.gunMs - 5 * 60_000;
    const t1 = b.track.t[b.track.t.length - 1];
    const n = Math.floor((t1 - t0) / 100) + 1;
    const t = Float64Array.from({ length: n }, (_, i) => t0 + i * 100);
    return {
      ...b,
      fullRate: {
        t,
        lat: Float64Array.from(t, (x) => interp(b.track.t, b.track.lat, x)),
        lon: Float64Array.from(t, (x) => interp(b.track.t, b.track.lon, x)),
        roll: new Float32Array(n).fill(5),
      },
    };
  });
  return { ...src, boats };
}

describe('full-rate detail when zoomed in', () => {
  it('switches on at the zoom threshold, or on a small view', () => {
    const big = { x0: 0, y0: 0, x1: 2000, y1: 1500 };
    expect(useFullRate(big, MAP_FULL_K - 0.01)).toBe(false);
    expect(useFullRate(big, MAP_FULL_K)).toBe(true);
    expect(useFullRate({ x0: 0, y0: 0, x1: MAP_FULL_SPAN_M - 1, y1: 100 }, 1)).toBe(true);
    const box = mapBox(a, null);
    const mid = { cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2 };
    const at = (k: number): boolean => {
      const v = trackMapView(a, null, { ...mid, k });
      return useFullRate(v.view, v.k);
    };
    expect(at(1)).toBe(false);
    expect(at(4)).toBe(true);
  });

  it('sends the feed at its own rate where it is faster than the drawings, with SOG and roll as drawn', () => {
    const full = fullRateTracks(data, fullRateWants(a));
    expect(full.length).toBeGreaterThan(0);
    for (const tk of full) {
      expect(tk.source).toBe('feed');
      const d = a.drawings.find((x) => x.id === tk.id)!;
      expect(tk.t[0]).toBe(d.pre!.t[0]);
      expect(tk.t.at(-1)).toBe(d.segments.at(-1)!.t.at(-1));
      const drawn = d.segments.reduce((n, s) => n + s.t.length, 0);
      expect(tk.t.length).toBeGreaterThan(drawn);
      // The drawn fixes are among them, at the same place and speed.
      const s = d.segments[1];
      const j = lowerBound(tk.t, s.t[3]);
      expect(tk.t[j]).toBe(s.t[3]);
      expect(tk.x[j]).toBe(s.x[3]);
      expect(tk.sog[j]).toBe(s.sog[3]);
    }
    const bufs = fullRateBuffers(full);
    expect(new Set(bufs).size).toBe(bufs.length);
    expect(bufs.length).toBe(full.length * 4 + full.filter((x) => x.roll).length);
  });

  it('uses Boat.fullRate (an uploaded log) when the boat has one', () => {
    const id = a.drawings[0].id;
    const full = fullRateTracks(withLog(data, id), fullRateWants(a));
    const tk = full.find((x) => x.id === id)!;
    expect(tk.source).toBe('log');
    expect(tk.t[1] - tk.t[0]).toBe(100);
    expect(tk.t[0]).toBeGreaterThanOrEqual(gun - MAP_PRE_MS);
    expect(tk.t[0] - (gun - MAP_PRE_MS)).toBeLessThan(100);
    expect(tk.roll![10]).toBe(5);
    // Same coordinates as the drawings.
    const s = a.drawings[0].segments[1];
    const j = lowerBound(tk.t, s.t[5]);
    expect(Math.hypot(tk.x[j] - s.x[5], tk.y[j] - s.y[5])).toBeLessThan(2);
  });

  it('falls back to the feed when the log does not cover the window', () => {
    const id = a.drawings[0].id;
    const src = withLog(data, id);
    const boats = src.boats.map((b) =>
      b.id !== id
        ? b
        : { ...b, fullRate: { t: Float64Array.from([0, 100]), lat: Float64Array.from([0, 0]), lon: Float64Array.from([0, 0]) } },
    );
    const full = fullRateTracks({ ...src, boats }, fullRateWants(a));
    expect(full.find((x) => x.id === id)?.source).toBe('feed');
  });

  it('draws from the full-rate track, cut at the same leg times, where there is one', () => {
    const id = a.drawings[0].id;
    const set = new Map(fullRateTracks(withLog(data, id), fullRateWants(a)).map((tk): [string, FullRateTrack] => [tk.id, tk]));
    const d = a.drawings[0];
    const r = legRanges(d, true, set.get(id));
    expect(r[0].leg).toBe(PRE_LEG);
    expect(r.slice(1).map((x) => x.leg)).toEqual(d.segments.map((s) => s.leg));
    r.slice(1).forEach((x, i) => {
      expect(x.src.t[x.lo]).toBeGreaterThanOrEqual(d.segments[i].t[0]);
      expect(x.src.t[x.hi - 1]).toBeLessThanOrEqual(d.segments[i].t.at(-1)!);
    });
    const pieces: MapPiece[] = drawingPieces(twd, d, { leg: null, full: set });
    expect(pieces.every((p) => p.src === set.get(id))).toBe(true);
    // Zoomed in on full-rate, the hover reads the full-rate fixes near the view.
    const box = mapBox(a, null);
    const view = { cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, k: 4 };
    const p = trackPointsFull(a, null, view, set);
    expect(p.segs).toContain(set.get(id));
    // And the scrubber's dot moves at 10 Hz.
    const b1 = boatsAt(a, null, gun + 60_000, set).find((b) => b.id === id)!;
    const b2 = boatsAt(a, null, gun + 60_050, set).find((b) => b.id === id)!;
    expect(b2.roll).toBe(5);
    expect(Math.hypot(b2.x - b1.x, b2.y - b1.y)).toBeGreaterThan(0);
  });
});

describe('tooltips at the scrubbed time', () => {
  const w = scrubWindow(a);

  it('a dot reads the boat interpolated at t, with its place then', () => {
    const t = gun + 5 * 60_000 + 500;
    const f = scrubFrame(a, null, null, {}, { t, win: trailWindow(t, '120', w) });
    const p = scrubPoints(a, f);
    const b = f.boats[0];
    const pick = pickMapPoint(p, b.mx, b.my, 1, 1, null)!;
    expect(pick).toEqual({ kind: 'dot', d: 0 });
    const asked: [string, number][] = [];
    const lines = mapTipLines(a, p, pick, {
      placeAt: (id, at) => {
        asked.push([id, at]);
        return { place: 3, of: 6 };
      },
    });
    expect(lines[1]).toBe(`${localTime(t, a.meta.tzOffsetMs)} (gun +5:01)`);
    expect(lines[2]).toMatch(new RegExp(`^SOG ${b.sog.toFixed(1)} kn( · COG \\d{1,3}°)?$`));
    expect(lines).toContain(a.legs[b.leg].name);
    expect(lines).toContain('Place 3 of 6');
    expect(asked).toEqual([[b.id, t]]);
  });

  it('before the gun: "gun −m:ss", pre-start, no leg and no place', () => {
    const t = gun - 45_000;
    const f = scrubFrame(a, null, null, { colour: 'sog' }, { t, win: trailWindow(t, '30', w) });
    const p = scrubPoints(a, f);
    const b = f.boats[0];
    expect(b.leg).toBe(PRE_LEG);
    const lines = mapTipLines(a, p, pickMapPoint(p, b.mx, b.my, 1, 1, null)!, { placeAt: () => ({ place: 1, of: 6 }), legLine: (l) => `leg ${l}` });
    expect(lines[1]).toBe(`${localTime(t, a.meta.tzOffsetMs)} (gun −0:45)`);
    expect(lines).toContain(PRE_START);
    expect(lines.join(' ')).not.toMatch(/Place|leg |Beat|Run/);
    // A drawn pre-gun fix reads the same way.
    const k = p.legs.indexOf(PRE_LEG);
    const fix = p.starts[k];
    const fl = mapTipLines(a, p, { kind: 'fix', i: fix });
    expect(fl[1]).toMatch(/\(gun −[01]:\d\d\)$/);
    expect(fl).toContain(PRE_START);
  });

  it('fixes keep their gap notes and roll at the window edge (read from the whole source track)', () => {
    const t = gun + 300_000;
    const f = scrubFrame(a, null, null, {}, { t, win: trailWindow(t, '30', w) });
    const p = scrubPoints(a, f);
    const s = p.legs.findIndex((l) => l >= 0);
    expect(p.offs[s]).toBeGreaterThan(0);
    const lines = mapTipLines(a, p, { kind: 'fix', i: p.starts[s] });
    expect(lines[1]).toContain(localTime(p.segs[s].t[p.offs[s]], a.meta.tzOffsetMs));
  });
});

describe('the scrubber map', () => {
  it('draws the static map with empty layers for the moving parts', () => {
    const svg = trackMap(a, null, null, { scrub: true });
    expect(svg).toContain('<g class="scrub-trk"></g>');
    expect(svg).toContain('<g class="scrub-dots"></g>');
    expect(svg).not.toContain('<polyline');
    expect(svg).toContain('class="startline"');
  });

  it('draws a dot per boat in the colouring, the selected boat last, bigger and labelled', () => {
    const w = scrubWindow(a);
    const t = gun + 200_000;
    const id = a.boats[2].id;
    const f = scrubFrame(a, id, null, {}, { t, win: trailWindow(t, '120', w) });
    expect((f.dots.match(/<circle class="dot/g) ?? []).length).toBe(f.boats.length);
    const last = f.dots.slice(f.dots.lastIndexOf('<g class="boat-at'));
    expect(last).toContain(`data-id="${id}"`);
    expect(last).toContain('class="dot on"');
    expect(last).toContain(`>${a.boats[2].sail}</text>`);
    // Leg colour of the leg each boat is on.
    const b = f.boats.find((x) => x.id === id)!;
    expect(last).toContain(`fill="var(--s${b.leg + 1})"`);
    // Boat speed: viridis, day and night.
    const sog = scrubFrame(a, null, null, { colour: 'sog' }, { t, win: trailWindow(t, '120', w) });
    expect(sog.dots).toMatch(/<circle class="dot"[^>]* fill="#[0-9a-f]{6}" style="--cd:#[0-9a-f]{6}"/);
    // Rank: plasma (or grey when unranked there).
    expect(scrubFrame(a, null, null, { colour: 'rank' }, { t, win: trailWindow(t, '120', w) }).dots).toMatch(/fill="(#[0-9a-f]{6}|rgb\([^)]+\)|var\(--ink-3\))"/);
  });

  it('draws a held dot hollow', () => {
    const d = drawing([seg(10, gun, 0, 5, 20_000)]);
    const one = { ...a, drawings: [d], boats: [{ ...a.boats[0], id: 'b' }] };
    const w = scrubWindow(one);
    const f = scrubFrame(one, null, null, {}, { t: gun + 6000, win: trailWindow(gun + 6000, '30', w) });
    expect(f.boats[0].hold).toBe(true);
    expect(f.dots).toContain('class="dot hold"');
    expect(f.dots).toContain('fill="var(--surface)"');
  });
});

describe('playback', () => {
  const w = { t0: 0, t1: 100_000 };

  it('steps real elapsed time × speed', () => {
    expect(playStep(10_000, 100, 1, w)).toEqual({ t: 10_100, done: false });
    expect(playStep(10_000, 100, 4, w)).toEqual({ t: 10_400, done: false });
    expect(playStep(10_000, 100, 16, w)).toEqual({ t: 11_600, done: false });
    expect(playStep(10_000, -5, 16, w)).toEqual({ t: 10_000, done: false });
  });

  it('stops at the end, and plays from the start again', () => {
    expect(playStep(99_000, 100, 16, w)).toEqual({ t: 100_000, done: true });
    expect(playFrom(100_000, w)).toBe(0);
    expect(playFrom(null, w)).toBe(0);
    expect(playFrom(40_000, w)).toBe(40_000);
  });
});
