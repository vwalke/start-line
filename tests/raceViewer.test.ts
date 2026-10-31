import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { Vec } from '../src/analysis/geo';
import { BOAT_SHAPE_MIN_KN, BOAT_SHAPE_PX, BOAT_STALE_MS, boatMark, boatStale, hullPathAt } from '../src/ui/boatShape';
import { boatsAt, mapBox, scrubFrame, trackMap, type BoatTrail } from '../src/ui/charts';
import { laneScrub } from '../src/ui/laneSnapshots';
import { laneScrubHtml } from '../src/ui/laneSnapshotsView';
import { mapPaint } from '../src/ui/mapPaint';
import { MAP_HOLD_S, lastHeadingAt, legRanges, type LegRange } from '../src/ui/mapPieces';
import { DEFAULT_TRAIL, fadingTrailMs, scrubWindow, trailWindow } from '../src/ui/scrub';
import { BOAT_TRAIL_MS, fadeSlice, TRAIL_FADE, TRAIL_MAX_PTS, trailPaths, type TrailStretch } from '../src/ui/trail';
import { paintTrails } from '../src/ui/trailLayer';
import { clampView, type View } from '../src/ui/view';
import { j105Race } from './helpers';

/**
 * The Race tab's "Race Viewer" (was "Tracks by leg") and the Start tab's "Around the gun": each boat's 2-minute fading
 * trail (ui/trail.ts, painted by ui/trailLayer.ts without a full redraw), and the boat drawn filled while its data is
 * fresh, hollow once it is lost, along its last heading when it has none now (ui/boatShape.ts boatMark).
 */

/** A 1 Hz trail sailing east 3 m/s from t = 0 … n − 1 s, with the fixes from `holeAt` on moved `holeMs` later. */
function line(n: number, holeAt = n, holeMs = 0): TrailStretch {
  const t = Array.from({ length: n }, (_, i) => i * 1000 + (i >= holeAt ? holeMs : 0));
  return { t, x: t.map((ms) => (ms / 1000) * 3), y: t.map(() => 0), i0: 0, i1: n };
}
/** The points of path data, in order. */
const pts = (d: string): Vec[] => [...d.matchAll(/[ML]([-\d.]+),([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const moves = (d: string): number => (d.match(/M/g) ?? []).length;

describe('the trail: its length and fade (trail.ts trailPaths)', () => {
  it('BOAT_TRAIL_MS is 2 minutes and the default trail; 30 s is still offered; All and Window draw the tracks', () => {
    expect(BOAT_TRAIL_MS).toBe(120_000);
    expect(fadingTrailMs(DEFAULT_TRAIL)).toBe(BOAT_TRAIL_MS);
    expect(fadingTrailMs('30')).toBe(30_000);
    expect(fadingTrailMs('all')).toBeNull();
    expect(fadingTrailMs('win')).toBeNull();
    const w = { t0: 0, t1: 1e9 };
    expect(trailWindow(500_000, DEFAULT_TRAIL, w)).toEqual([500_000 - BOAT_TRAIL_MS, 500_000]);
  });

  it('reaches back exactly the trail length, up to now and the boat', () => {
    // Half a second after the 300 s fix, the boat 1.5 m on.
    const now = 300_500;
    const d = trailPaths([line(400)], now, BOAT_TRAIL_MS, [901.5, 0]);
    const all = d.flatMap(pts);
    // From the first fix inside the 2 min (181 s), nothing before it.
    expect(Math.min(...all.map((p) => p[0]))).toBe(181 * 3);
    // The head's slice ends on the boat; nothing after now.
    expect(pts(d[0]).at(-1)).toEqual([901.5, 0]);
    expect(Math.max(...all.map((p) => p[0]))).toBe(901.5);
  });

  it('fades toward the tail: one path per slice, head first, each a quarter of the length, joined end to end', () => {
    expect(TRAIL_FADE).toHaveLength(4);
    for (let i = 1; i < TRAIL_FADE.length; i++) expect(TRAIL_FADE[i]).toBeLessThan(TRAIL_FADE[i - 1]);
    expect([0, 29_999, 30_001, 60_001, 119_999, 200_000, -5].map((age) => fadeSlice(age, BOAT_TRAIL_MS))).toEqual([0, 0, 1, 2, 3, 3, 0]);
    const now = 300_000;
    const d = trailPaths([line(400)], now, BOAT_TRAIL_MS);
    expect(d).toHaveLength(TRAIL_FADE.length);
    // Each slice one unbroken run over its 30 s (31 fixes at 1 Hz, sharing its ends with the next slice).
    for (const s of d) expect(moves(s)).toBe(1);
    const xs = d.map((s) => pts(s).map((p) => p[0]));
    // Head slice: the newest 30 s (270 … 300 s), the tail slice the oldest (180 … 210 s).
    expect([xs[0][0], xs[0].at(-1)]).toEqual([270 * 3, 300 * 3]);
    expect([xs[3][0], xs[3].at(-1)]).toEqual([180 * 3, 210 * 3]);
    for (let i = 0; i < 3; i++) expect(xs[i][0]).toBe(xs[i + 1].at(-1));
  });

  it('runs on across a step of any length (the maps fill holes in first): one stroke per slice', () => {
    // Fixes 0 … 249 s, then the rest 10 s later: an 11 s step at 250 s, drawn straight on (x 747 → 780).
    const now = 300_000;
    const d = trailPaths([line(300, 250, 10_000)], now, BOAT_TRAIL_MS);
    expect(d.join('').split('M').filter(Boolean).length).toBe(TRAIL_FADE.length);
    expect(d.join('')).toContain('747.0,0.0L780.0,0.0');
    // The head joins on too, however old the last fix.
    const head = trailPaths([line(100)], 110_000, BOAT_TRAIL_MS, [500, 0]);
    expect(head.join('')).toContain('L500.0,0.0');
  });

  it('takes a fix shared by two stretches once, and stretches in time order', () => {
    const a = line(61);
    // The next stretch starts on the first one's last fix (60 s, x 180).
    const b: TrailStretch = { t: [60_000, 61_000, 62_000], x: [180, 183, 186], y: [0, 0, 0], i0: 0, i1: 3 };
    const d = trailPaths([a, b], 62_000, BOAT_TRAIL_MS);
    const all = d.flatMap(pts).map((p) => p[0]);
    expect(all.filter((x) => x === 180)).toHaveLength(1);
    expect(pts(d[0]).at(-1)![0]).toBe(186);
  });

  it('a 10 Hz log is thinned to about TRAIL_MAX_PTS points; its ends kept', () => {
    const n = 1500;
    const t = Array.from({ length: n }, (_, i) => i * 100 + (i >= 800 ? 5000 : 0));
    const s: TrailStretch = { t, x: t.map((ms) => ms / 100), y: t.map(() => 0), i0: 0, i1: n };
    const now = t[n - 1];
    const d = trailPaths([s], now, BOAT_TRAIL_MS);
    const all = d.flatMap(pts);
    expect(all.length).toBeLessThanOrEqual(TRAIL_MAX_PTS + 2 * TRAIL_FADE.length + 4);
    expect(all.length).toBeGreaterThan(TRAIL_MAX_PTS / 2);
    const xs = all.map((p) => p[0]);
    // From the trail's first fix to the last, the 5 s step at 800 drawn straight on.
    expect(Math.min(...xs)).toBe((now - BOAT_TRAIL_MS) / 100);
    expect(pts(d[0]).at(-1)![0]).toBe(now / 100);
  });

  it('zoomed in, only steps near the view', () => {
    const clip = { x0: 600, y0: -10, x1: 700, y1: 10 };
    const d = trailPaths([line(400)], 300_000, BOAT_TRAIL_MS, null, clip);
    const xs = d.flatMap(pts).map((p) => p[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(597);
    expect(Math.max(...xs)).toBeLessThanOrEqual(703);
  });

  it('zoomed in, a step crossing the view with both ends outside it is still drawn (its box overlaps the view)', () => {
    // Two fixes 60 s apart, 300 m either side of a 20 m view (a slow feed: no gap at a 120 s threshold).
    const s: TrailStretch = { t: [0, 60_000], x: [-300, 300], y: [-5, 5], i0: 0, i1: 2 };
    const clip = { x0: -10, y0: -10, x1: 10, y1: 10 };
    expect(trailPaths([s], 60_000, BOAT_TRAIL_MS, null, clip).join('')).toBe('M-300.0,-5.0L300.0,5.0');
    // Wholly beside the view (its box clear of it): left out.
    const beside: TrailStretch = { ...s, y: [50, 60] };
    expect(trailPaths([beside], 60_000, BOAT_TRAIL_MS, null, clip).join('')).toBe('');
  });
});

describe('the boat: filled while its data is fresh, hollow once lost, the last heading kept (boatShape.ts boatMark)', () => {
  const J70 = { loaM: 6.934, beamM: 2.249 };
  const base = { dir: [0, -1] as Vec, hold: false, stale: false, sog: 5, dims: J70, pxPerM: 4, lastDir: [1, 0] as Vec };

  it('fresh: the hull along its course, filled', () => {
    expect(boatMark(base)).toEqual({ shape: [0, -1], dims: J70, hollow: false });
  });

  it('hollow only past a final fix, once it is BOAT_STALE_MS old (in a hole the boat glides: never held)', () => {
    expect(BOAT_STALE_MS).toBe(30_000);
    expect(boatStale(true, 10_000, 10_000 + 1000)).toBe(false);
    expect(boatStale(true, 10_000, 10_000 + 29_000)).toBe(false);
    expect(boatStale(true, 10_000, 10_000 + BOAT_STALE_MS)).toBe(false);
    expect(boatStale(true, 10_000, 10_000 + BOAT_STALE_MS + 1)).toBe(true);
    // Not held: never stale.
    expect(boatStale(false, 10_000, 60_000)).toBe(false);
    // Held, not stale yet: the hull along its last heading, filled; stale: the same hull, hollow.
    expect(boatMark({ ...base, hold: true })).toEqual({ shape: [1, 0], dims: J70, hollow: false });
    expect(boatMark({ ...base, hold: true, stale: true })).toEqual({ shape: [1, 0], dims: J70, hollow: true });
  });

  it('a slow or stopped boat keeps the hull at its last heading; with no heading ever known, the dot', () => {
    expect(boatMark({ ...base, sog: BOAT_SHAPE_MIN_KN / 2 })).toEqual({ shape: [1, 0], dims: J70, hollow: false });
    expect(boatMark({ ...base, dir: null })).toEqual({ shape: [1, 0], dims: J70, hollow: false });
    expect(boatMark({ ...base, dir: null, lastDir: null })).toEqual({ dot: 'no-heading', hollow: false });
    expect(boatMark({ ...base, sog: 0.2, lastDir: null })).toEqual({ dot: 'slow', hollow: false });
    expect(boatMark({ ...base, hold: true, stale: true, lastDir: null })).toEqual({ dot: 'hold', hollow: true });
  });

  it('zoomed out, the symbol follows the same filled / hollow rule, however far out', () => {
    // At Fit a J/70 is a symbol BOAT_SHAPE_PX long, hollow when lost.
    const sym = boatMark({ ...base, pxPerM: 1, hold: true, stale: true });
    expect('shape' in sym && sym.dims.loaM).toBeCloseTo(BOAT_SHAPE_PX, 6);
    expect(sym.hollow).toBe(true);
    // Far out (0.7 px to scale): still the symbol, BOAT_SHAPE_PX long, hollow too.
    const far = boatMark({ ...base, pxPerM: 0.1, hold: true, stale: true });
    expect('shape' in far && far.dims.loaM * 0.1).toBeCloseTo(BOAT_SHAPE_PX, 6);
    expect(far.hollow).toBe(true);
    expect(boatMark({ ...base, dims: null })).toEqual({ dot: 'no-class', hollow: false });
  });

  it('the last heading is deterministic at any time (scrubbing back gives what play did): the latest step at 1 kn or more', () => {
    // East at 3 m/s for 10 s, stopped 10 s (no moves), then a 30 s hole.
    const t = Float64Array.from([...Array.from({ length: 21 }, (_, i) => i * 1000), 50_000]);
    const x = Float32Array.from([...Array.from({ length: 21 }, (_, i) => Math.min(i, 10) * 3), 30]);
    const src = { t, x, y: new Float32Array(t.length), sog: Float32Array.from(t, (_, i) => (i <= 10 ? 6 : 0)) };
    const ranges: LegRange[] = [{ leg: 0, src, lo: 0, hi: t.length }];
    expect(lastHeadingAt(ranges, -1, 0)).toBeNull();
    expect(lastHeadingAt(ranges, 0, 0)).toBeNull();
    for (const ms of [5000, 15_000, 20_000, 35_000, 49_999]) expect(lastHeadingAt(ranges, ms, 0)).toEqual([1, 0]);
  });
});

describe('the Race Viewer while scrubbing: each boat its own fading trail', () => {
  const a = analyzeRace(j105Race(1));
  const ME = 'USA 527';
  const t = a.meta.gunMs + 480_000;
  const w = scrubWindow(a);
  const frame = (highlight: string | null, opts = {}, leg: number | null = null) =>
    scrubFrame(a, highlight, leg, opts, { t, win: trailWindow(t, DEFAULT_TRAIL, w), trailMs: BOAT_TRAIL_MS });
  const colorOf = (dots: string, id: string): string => new RegExp(`data-id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*fill="([^"]+)"`).exec(dots)![1];

  it('a trail per placed boat, in its hull color, the map tracks left out', () => {
    const f = frame(null);
    expect(f.trails.length).toBeGreaterThan(a.boats.length / 2);
    expect(f.tracks).not.toMatch(/class="trk/);
    for (const tr of f.trails) {
      expect(tr.d).toHaveLength(TRAIL_FADE.length);
      expect(tr.stroke).toBe(colorOf(f.dots, tr.id));
      expect(tr.cls).toBe('btrail');
    }
    // All: the map's tracks, no fading trails.
    const all = scrubFrame(a, null, null, {}, { t, win: trailWindow(t, 'all', w), trailMs: fadingTrailMs('all') });
    expect(all.trails).toEqual([]);
    expect(all.tracks).toMatch(/class="trk/);
  });

  it('colored as the boats in Rank and Boat speed (each with a night color too); dimmed with a selection, the selected boat last', () => {
    for (const colour of ['rank', 'sog'] as const) {
      const f = frame(null, { colour });
      for (const tr of f.trails) expect(tr.stroke).toBe(colorOf(f.dots, tr.id));
      expect(f.trails.some((tr) => tr.cd)).toBe(true);
    }
    const f = frame(ME);
    expect(f.trails.at(-1)!.id).toBe(ME);
    expect(f.trails.at(-1)!.cls).toBe('btrail on');
    expect(f.trails.at(-1)!.w).toBeGreaterThan(f.trails[0].w);
    expect(f.trails.slice(0, -1).every((tr) => tr.cls === 'btrail dim')).toBe(true);
    // One leg shown: boats off it faint.
    const one = frame(null, {}, 0);
    expect(one.trails.every((tr) => !tr.cls.includes('off') || one.boats.find((b) => b.id === tr.id)!.leg !== 0)).toBe(true);
  });

  it('a trail both dimmed and off the leg is the faintest (style.css): fainter than dimmed or off-leg alone', () => {
    const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
    const opacity = (sel: string): number => Number(new RegExp(`svg ${sel.replace(/\./g, '\\.')} \\{ opacity: ([\\d.]+); \\}`).exec(css)![1]);
    const [dim, off, both] = ['.btrail.dim', '.btrail.off', '.btrail.dim.off'].map(opacity);
    expect(both).toBeLessThan(dim);
    expect(both).toBeLessThan(off);
    // As the frame writes it: the combined class, a boat just past the leg shown while another is selected.
    const found = a.legs.some((_, leg) =>
      Array.from({ length: 40 }, (_, i) => a.meta.gunMs + i * 60_000).some((at) =>
        scrubFrame(a, ME, leg, {}, { t: at, win: trailWindow(at, DEFAULT_TRAIL, w), trailMs: BOAT_TRAIL_MS }).trails.some((tr) => tr.cls === 'btrail dim off'),
      ),
    );
    expect(found).toBe(true);
  });

  it('runs on across each boat’s holes as the map bridges its tracks: one stroke per fade slice', () => {
    const f = frame(null);
    for (const tr of f.trails) for (const d of tr.d) expect((d.match(/M/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});

/** A minimal SVG DOM: what paintTrails touches. */
class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  parent: El | null = null;
  constructor(
    readonly tag: string,
    readonly ownerDocument: Doc,
  ) {}
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
    this.ownerDocument.sets++;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  appendChild(c: El): El {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
}
class Doc {
  created = 0;
  sets = 0;
  createElementNS(_ns: string, tag: string): El {
    this.created++;
    return new El(tag, this);
  }
}

describe('playing with trails: no full redraw, each boat’s paths reused (trailLayer.ts)', () => {
  const a = analyzeRace(j105Race(1));
  const ME = 'USA 527';
  const fit = mapBox(a, null);
  const w = scrubWindow(a);

  it('120 frames of follow-camera play at 16×: 0 full renders; the paths made once, only their d set', () => {
    const doc = new Doc();
    const layer = new El('g', doc);
    let view: View = (() => {
      const me = boatsAt(a, ME, a.meta.gunMs + 480_000).find((b) => b.id === ME)!;
      return clampView(fit, { cx: me.mx, cy: me.my, k: 4 });
    })();
    let renders = 0;
    const frames: (() => void)[] = [];
    const p = mapPaint({
      render: () => {
        renders++;
        trackMap(a, ME, null, { view, scrub: true });
        p.rendered(view);
      },
      move: () => {},
      drawMs: () => 5,
      view: () => view,
      raf: (f) => frames.push(f),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    p.rendered(view);
    let t = a.meta.gunMs + 480_000;
    const paths = new Set<El>();
    const groups = new Set<El>();
    let firstCreated = 0;
    let lastD = '';
    let changed = 0;
    for (let i = 0; i < 120; i++) {
      t += 16 * 16;
      // drawScrub: the follow camera pans first (the viewBox only), then the frame into the layers.
      const me = boatsAt(a, ME, t).find((b) => b.id === ME)!;
      view = clampView(fit, { cx: me.mx, cy: me.my, k: 4 });
      p.follow(true);
      const f = scrubFrame(a, ME, null, { view }, { t, win: trailWindow(t, DEFAULT_TRAIL, w), trailMs: fadingTrailMs(DEFAULT_TRAIL) });
      paintTrails(layer as unknown as Element, f.trails);
      frames.splice(0).forEach((fn) => fn());
      if (i === 0) firstCreated = doc.created;
      for (const g of layer.children) {
        groups.add(g);
        for (const c of g.children) paths.add(c);
      }
      const mine = layer.children.at(-1)!.children[0].attrs.get('d')!;
      if (mine !== lastD) changed++;
      lastD = mine;
    }
    expect(renders).toBe(0);
    expect(firstCreated).toBeGreaterThan(0);
    // The groups and paths made for the boats near the view, then reused (a boat coming into view makes its own once).
    expect(doc.created - firstCreated).toBeLessThanOrEqual(5 * 6);
    // Every group and path made was kept: one path per fade slice, and as many lighter ones once a boat has a filled-in stretch (ui/gapFill.ts).
    expect(paths.size + groups.size).toBe(doc.created);
    for (const g of groups) expect([TRAIL_FADE.length, 2 * TRAIL_FADE.length]).toContain(g.children.length);
    // The selected boat on top, its head slice moving every frame.
    expect(layer.children.at(-1)!.attrs.get('class')).toBe('btrail on');
    expect(changed).toBeGreaterThan(100);
  });

  it('a boat whose trail ends is removed; one coming back gets new paths; order follows the frame', () => {
    const doc = new Doc();
    const layer = new El('g', doc) as unknown as Element;
    const tr = (id: string, d = 'M0,0L1,1'): BoatTrail => ({ id, stroke: 'red', cls: 'btrail', w: 1, d: [d, '', '', ''] });
    paintTrails(layer, [tr('A'), tr('B')]);
    const g = layer as unknown as El;
    expect(g.children.map((c) => c.children.length)).toEqual([5, 5].map(() => TRAIL_FADE.length));
    const sets = doc.sets;
    // The same frame again: nothing set.
    expect(paintTrails(layer, [tr('A'), tr('B')])).toEqual({ created: 0, removed: 0, dSet: 0 });
    expect(doc.sets).toBe(sets);
    // B on top now, A's head moved: one d set, the order changed by re-appending.
    expect(paintTrails(layer, [tr('A', 'M0,0L2,2'), tr('B')].reverse())).toEqual({ created: 0, removed: 0, dSet: 1 });
    expect(g.children.map((c) => c.children[0].attrs.get('d'))).toEqual(['M0,0L1,1', 'M0,0L2,2']);
    expect(paintTrails(layer, [tr('B')])).toEqual({ created: 0, removed: 1, dSet: 0 });
    expect(g.children).toHaveLength(1);
    expect(paintTrails(layer, [tr('B'), tr('A')]).created).toBe(1);
  });
});

describe('a tracker that stops: held hollow for MAP_HOLD_S after its final fix, unless the boat finished', () => {
  const a = analyzeRace(j105Race(1));
  const lastFix = (id: string): number => a.drawings.find((d) => d.id === id)!.segments.at(-1)!.t.at(-1)!;
  // USA 55 has no finish; USA 527 finished (its last drawn fix just before its finish time).
  const LOST = 'USA 55';
  const DONE = 'USA 527';
  const placed = (t: number, id: string) => boatsAt(a, null, t).find((b) => b.id === id) ?? null;

  it('no finish: held at its last fix, filled at first, then hollow, for MAP_HOLD_S; then gone', () => {
    const t0 = lastFix(LOST);
    expect(a.boats.find((b) => b.id === LOST)!.finishMs).toBeNull();
    expect(placed(t0 + 1000, LOST)).toMatchObject({ hold: true, stale: false, lastFix: t0 });
    expect(placed(t0 + 60_000, LOST)).toMatchObject({ hold: true, stale: true, lastFix: t0 });
    expect(placed(t0 + MAP_HOLD_S * 1000 + 1000, LOST)).toBeNull();
    // Drawn hollow, at its last heading, with its "no data since" point details.
    const f = scrubFrame(a, null, null, {}, { t: t0 + 60_000, win: trailWindow(t0 + 60_000, DEFAULT_TRAIL, scrubWindow(a)), trailMs: BOAT_TRAIL_MS });
    expect(f.dots).toMatch(new RegExp(`class="dot hull hold lost[^"]*"[^>]*data-id="${LOST}"|data-id="${LOST}"[^>]*class="dot hull hold lost`));
  });

  it('finished: never held past its finish, so never shown as a lost boat after it', () => {
    const fin = a.boats.find((b) => b.id === DONE)!.finishMs!;
    expect(fin).toBeGreaterThanOrEqual(lastFix(DONE));
    expect(fin - lastFix(DONE)).toBeLessThan(BOAT_STALE_MS);
    expect(placed(fin, DONE)).toBeNull();
    expect(placed(fin + 30_000, DONE)).toBeNull();
    // Until its finish, within a second or so of its last fix: held, still filled.
    expect(placed(lastFix(DONE) + 500, DONE)).toMatchObject({ hold: true, stale: false });
  });

  it('played across the stop: its trail paths are reused (not removed and made again), its trail ends at its last fix', () => {
    const doc = new Doc();
    const layer = new El('g', doc);
    const t0 = lastFix(LOST);
    const w = scrubWindow(a);
    let groups: El | null = null;
    for (let t = t0 - 5000; t <= t0 + 60_000; t += 256) {
      const f = scrubFrame(a, LOST, null, {}, { t, win: trailWindow(t, DEFAULT_TRAIL, w), trailMs: BOAT_TRAIL_MS });
      const r = paintTrails(layer as unknown as Element, f.trails);
      expect(f.boats.some((b) => b.id === LOST)).toBe(true);
      const mine = layer.children.at(-1)!;
      if (groups) expect(mine).toBe(groups);
      groups = mine;
      if (t > t0) {
        expect(r.created).toBe(0);
        const b = f.boats.find((x) => x.id === LOST)!;
        // The newest point drawn (the head slice empties once the stop is older than a slice).
        const head = pts(mine.children.map((c) => c.attrs.get('d') ?? '').find(Boolean)!).at(-1)!;
        expect(Math.hypot(head[0] - b.mx, head[1] - b.my)).toBeLessThan(0.1);
      }
    }
  });
});

describe('Around the gun: the same trail and the same filled / hollow boat', () => {
  const GUN = 1_000_000;
  const sec = (s: number): number => GUN + s * 1000;
  /** 1 Hz sailing north at 2 m/s, minus the holes (open, s). */
  const seg = (x: number, leg: number, keep: (s: number) => boolean, holes: [number, number][] = []) => {
    const s = Array.from({ length: 321 }, (_, i) => i - 120).filter((v) => keep(v) && !holes.some(([p, q]) => v > p && v < q));
    return { leg, t: Float64Array.from(s, sec), x: Float32Array.from(s, () => x), y: Float32Array.from(s, (v) => -100 + 2 * v), sog: Float32Array.from(s, () => 4) };
  };
  const drawing = (id: string, x: number, holes: [number, number][] = []) => ({ id, pre: seg(x, -1, (s) => s <= 0, holes), segments: [seg(x, 0, (s) => s >= 0, holes)] });
  // OCS's tracker stops at +50 (no finish: held at its last fix, hollow from +80); H's has a 40 s hole, +50 … +90 (bridged).
  const a = {
    meta: { gunMs: GUN, tzOffsetMs: 0, boatClass: 'J/70' },
    line: { left: [-100, 0], right: [100, 0], lengthM: 200 },
    legPts: [[0, 0], [0, 1000], [0, 0]],
    legs: [{ index: 0, name: 'Beat 1', kind: 'upwind', to: 'Mark 1' }],
    marks: [{ name: 'Mark 1', xy: [[0, 1000]] }],
    wind: { method: 'tacks', estimates: [], twdAtGunDeg: 0, model: null },
    boats: ['A', 'OCS', 'H'].map((id, i) => ({ id, sail: id, colorSlot: i, finishPos: i + 1, legs: [] })),
    drawings: [drawing('A', 0), drawing('OCS', 30, [[50, 999]]), drawing('H', 60, [[50, 90]])],
  } as unknown as Parameters<typeof laneScrub>[0];
  const rep = { boat: 'OCS', gunMs: GUN, early: true, firstCrossMs: sec(-2), over: [sec(-2), sec(10)], wentBackMs: sec(10), clearedMs: null, maxOverM: 5, maxOverAtMs: GUN, lostS: null } as never;
  const L = laneScrub(a, { me: 'A', replays: [rep] });

  it('its trail: the last 2 min, fading in the same four slices, straight on across a hole', () => {
    const b = L.frame(180).boats.find((x) => x.id === 'A')!;
    expect(b.fade).toHaveLength(TRAIL_FADE.length);
    const ys = b.fade.flatMap(pts).map((p) => -p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-100 + 2 * 60, 6);
    const html = laneScrubHtml(a, L, 180);
    for (const op of TRAIL_FADE) expect(html).toContain(`stroke-opacity="${op}"`);
    // The boat past its hole +50 … +90: one trail across it, and in the hole it glides.
    const h = L.frame(100).boats.find((x) => x.id === 'H')!;
    expect(h.trail.length).toBe(1);
    expect(L.frame(70).boats.find((x) => x.id === 'H')).toMatchObject({ hold: false, stale: false });
  });

  it('an over-early boat keeps its over-early styling and its color when hollow', () => {
    const at = (s: number): string => laneScrubHtml(a, L, s).match(/<g class="lane-boat[^"]*" data-id="OCS">[\s\S]*?<\/g>/)![0];
    const filled = at(40);
    const hollow = at(90);
    expect(L.frame(90).boats.find((x) => x.id === 'OCS')).toMatchObject({ over: 'over', hold: true, stale: true });
    expect(filled).toContain('over early (OCS)');
    expect(hollow).toContain('over early (OCS)');
    expect(hollow).toMatch(/class="lane-dot lane-hull lost"[^>]*fill="var\(--surface\)" stroke="var\(--ink-3\)"/);
    expect(filled).toMatch(/class="lane-dot lane-hull"[^>]*fill="var\(--ink-3\)"/);
    // The over-the-line track still drawn, as when it was filled.
    expect(laneScrubHtml(a, L, 90)).toContain('class="ocs-over"');
  });

  it('the race map and Around the gun draw a held boat the same way: the hull at its last fix and last heading', () => {
    const d = a.drawings.find((x) => x.id === 'OCS')!;
    const ranges = legRanges(d, true);
    const lastDir = lastHeadingAt(ranges, sec(60), 0)!;
    expect(lastDir[0]).toBeCloseTo(0, 9);
    expect(lastDir[1]).toBeCloseTo(-1, 9);
    const b = L.frame(60).boats.find((x) => x.id === 'OCS')!;
    const lane = laneScrubHtml(a, L, 60, 4).match(/data-id="OCS"><title>[^<]*<\/title><path [^>]* d="([^"]+)"/)![1];
    expect(lane).toBe(hullPathAt(b.pos!, lastDir, { loaM: Math.max(6.934, BOAT_SHAPE_PX / 4), beamM: (2.249 * Math.max(6.934, BOAT_SHAPE_PX / 4)) / 6.934 }));
  });
});
