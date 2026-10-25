import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { BoatDrawing, DrawnTrack, RaceAnalysis, TrackSegment } from '../src/analysis/types';
import { boatsAt, scrubFrame, startSnapshot, trackMap } from '../src/ui/charts';
import { EST_OPACITY, SHORT_GAP_S } from '../src/ui/gapFill';
import { laneScrub } from '../src/ui/laneSnapshots';
import { laneScrubHtml } from '../src/ui/laneSnapshotsView';
import { rotator } from '../src/ui/mapPieces';
import { drawingGapMs } from '../src/ui/mapPoints';
import { rawHoles } from '../src/analysis/rawHoles';
import { ic37Race } from './helpers';

/**
 * Drawing a track with one short gap (filled in, lighter, solid) and one long gap (left blank): the Race Viewer's
 * tracks and trails, its boats, the start chart's trails and Start Playback. IC37 race 5 is dense (no gaps), so the
 * holes are cut into one boat's track: a short one 30–40 s after the gun, a long one 100–140 s after it.
 */
const base = analyzeRace(ic37Race());
const gun = base.meta.gunMs;
const SHORT: [number, number] = [gun + 30_000, gun + 40_000];
const LONG: [number, number] = [gun + 100_000, gun + 140_000];
/** Fixes strictly inside one of `holes` dropped. */
function cut<T extends DrawnTrack>(s: T, holes: [number, number][]): T {
  const keep = [...s.t].map((t, i) => (holes.some(([a, b]) => t > a && t < b) ? -1 : i)).filter((i) => i >= 0);
  const pick = <A extends Float32Array | Float64Array>(arr: A): A => (arr.constructor as unknown as { from(x: number[]): A }).from(keep.map((i) => arr[i]));
  const roll = (s as Partial<TrackSegment>).roll;
  return { ...s, t: pick(s.t), x: pick(s.x), y: pick(s.y), sog: pick(s.sog), ...(roll ? { roll: pick(roll) } : {}) };
}
const d0 = base.drawings[0];
const id = d0.id;
const TRAIL_SHORT: [number, number] = [gun - 16_000, gun - 6_000];
const TRAIL_LONG: [number, number] = [gun - 58_000, gun - 24_000];
const segments = d0.segments.map((s) => cut(s, [SHORT, LONG]));
const trail = cut(d0.trail, [TRAIL_SHORT, TRAIL_LONG]);
/** The cut track as the feed would have it (every fix once, time order): its holes are what the map reads (BoatDrawing.holes). */
function feedOf(tracks: DrawnTrack[]): ReturnType<typeof rawHoles> {
  const fixes = new Map<number, [number, number, number]>();
  for (const tr of tracks) for (let i = 0; i < tr.t.length; i++) fixes.set(tr.t[i], [tr.x[i], tr.y[i], tr.sog[i]]);
  const ts = [...fixes.keys()].sort((p, q) => p - q);
  return rawHoles(ts, ts.map((t) => fixes.get(t)![0]), ts.map((t) => fixes.get(t)![1]), ts.map((t) => fixes.get(t)![2]), -Infinity);
}
const d: BoatDrawing = { ...d0, segments, trail, holes: feedOf([...(d0.pre ? [d0.pre] : []), ...segments]) };
const a: RaceAnalysis = { ...base, drawings: [d, ...base.drawings.slice(1)] };
const seg = d.segments.find((s) => s.t[0] <= SHORT[0] && s.t[s.t.length - 1] >= LONG[1])!;
const rot = rotator(a.wind.twdAtGunDeg);
/** The fixes either side of the hole starting at `t0`, in map coordinates and as the map writes them. */
function ends(tr: DrawnTrack, t0: number): { t: [number, number]; p: [string, string] } {
  const i = [...tr.t].findIndex((t, k) => t <= t0 && tr.t[k + 1] > t0);
  const f = (k: number): string => rot([tr.x[k], tr.y[k]]).map((v) => v.toFixed(1)).join(',');
  return { t: [tr.t[i], tr.t[i + 1]], p: [f(i), f(i + 1)] };
}
const polylines = (svg: string): string[] => svg.match(/<polyline [^>]*>/g) ?? [];
const pointsOf = (p: string): string => p.match(/points="([^"]*)"/)![1];

describe('a track with one short and one long gap', () => {
  const short = ends(seg, SHORT[0]);
  const long = ends(seg, LONG[0]);

  it('the holes are what the test means: one short gap (over the gap rule, ≤ SHORT_GAP_S), one long', () => {
    expect(drawingGapMs(d)).toBe(SHORT_GAP_S * 1000);
    expect(short.t[1] - short.t[0]).toBeGreaterThan(d.holes!.holeMs);
    expect(short.t[1] - short.t[0]).toBeLessThanOrEqual(SHORT_GAP_S * 1000);
    expect(long.t[1] - long.t[0]).toBeGreaterThan(SHORT_GAP_S * 1000);
  });

  it('Race Viewer tracks: the short gap is a lighter solid "trk-est" line from fix to fix; nothing is drawn across the long one', () => {
    for (const svg of [trackMap(a, null, null), trackMap(a, id, null), trackMap(a, id, null, { colour: 'rank' })]) {
      const est = polylines(svg).filter((p) => /class="[^"]*\btrk-est\b/.test(p));
      const mine = est.find((p) => pointsOf(p).startsWith(short.p[0]) && pointsOf(p).endsWith(short.p[1]));
      expect(mine).toBeDefined();
      expect(pointsOf(mine!).split(' ').length).toBeGreaterThan(5);
      for (const p of est) {
        expect(p).not.toContain('stroke-dasharray');
        expect(p).toMatch(/stroke-opacity="0\.\d+"/);
      }
      for (const p of polylines(svg)) expect(pointsOf(p)).not.toContain(`${long.p[0]} ${long.p[1]}`);
      expect(svg).not.toContain('trk-gap');
      expect(est.some((p) => pointsOf(p).startsWith(long.p[0]))).toBe(false);
    }
    // Boat speed: the short gap in a lighter path of its own, no gap chord.
    const sog = trackMap(a, null, null, { colour: 'sog' });
    expect(sog).toMatch(new RegExp(`<path class="sog sog-est"[^>]*stroke-opacity="${EST_OPACITY}"`));
    expect(sog).not.toContain('sog-gap');
  });

  it('Race Viewer trails: the short gap in the lighter slices, the long gap left out', () => {
    const at = (t: number) => scrubFrame(a, id, null, { scrub: true }, { t, win: [t - 120_000, t], trailMs: 120_000 });
    const tr = at(SHORT[1] + 20_000).trails.find((x) => x.id === id)!;
    expect(tr.est?.some(Boolean)).toBe(true);
    const later = at(LONG[1] + 30_000).trails.find((x) => x.id === id)!;
    const bridge = `${long.p[0]}L${long.p[1]}`;
    for (const path of [...later.d, ...(later.est ?? [])]) expect(path).not.toContain(bridge);
  });

  it('the boat in the short gap: a normal filled hull on the curve; in the long gap, held and hollow', () => {
    const inShort = boatsAt(a, id, SHORT[0] + 5_000).find((b) => b.id === id)!;
    expect(inShort.est).toBe(true);
    expect(inShort.hold).toBe(false);
    expect(inShort.dir).not.toBeNull();
    const f = scrubFrame(a, id, null, { scrub: true }, { t: SHORT[0] + 5_000, win: [SHORT[0] - 115_000, SHORT[0] + 5_000], trailMs: 120_000 });
    const mark = f.dots.match(new RegExp(`<(path|circle) class="dot[^"]*" data-id="${id}"[^>]*>`))![0];
    expect(mark).not.toMatch(/\blost\b/);
    expect(mark).not.toContain('fill="var(--surface)"');
    const inLong = boatsAt(a, id, LONG[0] + 20_000).find((b) => b.id === id)!;
    expect([inLong.hold, inLong.stale]).toEqual([true, true]);
  });

  it('Start View - Gun: the trail\'s short gap drawn lighter and solid, nothing across the long one', () => {
    const svg = startSnapshot(a, null);
    const tShort = ends(d.trail, TRAIL_SHORT[0]);
    const tLong = ends(d.trail, TRAIL_LONG[0]);
    expect(tLong.t[1] - tLong.t[0]).toBeGreaterThan(SHORT_GAP_S * 1000);
    const est = polylines(svg).filter((p) => p.includes('trail-est'));
    expect(est.some((p) => pointsOf(p).startsWith(tShort.p[0]) && pointsOf(p).endsWith(tShort.p[1]))).toBe(true);
    for (const p of est) expect(p).not.toContain('stroke-dasharray');
    for (const p of polylines(svg)) expect(pointsOf(p)).not.toContain(`${tLong.p[0]} ${tLong.p[1]}`);
  });

  it('Start Playback: the boat a filled hull in the short gap, the trail lighter across it, broken at the long gap', () => {
    const L = laneScrub(a, { me: id });
    const s = (SHORT[0] + 5_000 - gun) / 1000;
    const b = L.frame(s).boats.find((x) => x.id === id)!;
    expect(b.pos).not.toBeNull();
    expect([b.hold, b.stale]).toEqual([false, false]);
    const html = laneScrubHtml(a, L, undefined, s);
    const boat = html.match(new RegExp(`<g class="lane-boat [^"]*" data-id="${id}">[\\s\\S]*?</g>`))![0];
    expect(boat).not.toMatch(/\blost\b/);
    expect(boat).not.toContain('fill="var(--surface)"');
    const after = L.frame((SHORT[1] + 15_000 - gun) / 1000).boats.find((x) => x.id === id)!;
    expect(after.fadeEst.some(Boolean)).toBe(true);
    expect(laneScrubHtml(a, L, undefined, (SHORT[1] + 15_000 - gun) / 1000)).toMatch(/class="lane-trail [^"]*lane-est"[^>]*stroke-opacity="0\.\d+"/);
    // Past the long gap: the trail in two pieces, none across it.
    const past = L.frame((LONG[1] + 20_000 - gun) / 1000).boats.find((x) => x.id === id)!;
    expect(past.trail.length).toBeGreaterThanOrEqual(2);
  });
});
