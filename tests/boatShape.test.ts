import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { Vec } from '../src/analysis/geo';
import { startReplays } from '../src/analysis/startReplay';
import {
  BOAT_SHAPE_MIN_KN,
  BOAT_SHAPE_ON_PX,
  BOAT_SHAPE_PX,
  boatShapeOr,
  BOATS_NOT_TO_SCALE,
  headingDir,
  hullCenterFromBow,
  hullEnlarged,
  hullOutline,
  hullOutlineAt,
  hullPathAt,
  hullPathD,
  shapeRotationDeg,
} from '../src/ui/boatShape';
import { bowAheadM } from '../src/data/classes';
import { boatsAt, scrubFrame, startClass, trackMap, trackMapView } from '../src/ui/charts';
import { textWidth } from '../src/ui/labels';
import { legRanges } from '../src/ui/mapPieces';
import { ocsStretch, ocsSvg } from '../src/ui/ocsStyle';
import { laneScrub } from '../src/ui/laneSnapshots';
import { laneScrubHtml, lanePxPerUnit } from '../src/ui/laneSnapshotsView';
import { trailWindow, scrubWindow } from '../src/ui/scrub';
import { K_MAX } from '../src/ui/view';
import { ic37Race } from './helpers';

/** The boat shape (ui/boatShape.ts): the start chart's hull, shared with the track map and Around the gun. */
const J70 = { loaM: 6.934, beamM: 2.249 };
const close = (p: Vec, q: Vec, d = 1e-6): void => expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(d);

describe('boat shape: orientation', () => {
  it('heading → rotation: degrees clockwise from up the page, for a map direction (y down)', () => {
    expect(shapeRotationDeg([0, -1])).toBeCloseTo(0, 9);
    expect(shapeRotationDeg([1, 0])).toBeCloseTo(90, 9);
    expect(shapeRotationDeg([0, 1])).toBeCloseTo(180, 9);
    expect(shapeRotationDeg([-1, 0])).toBeCloseTo(270, 9);
    expect(shapeRotationDeg([Math.SQRT1_2, -Math.SQRT1_2])).toBeCloseTo(45, 9);
  });

  it('a course over ground on the wind-up map: the course minus the wind, so sailing into the wind points up the page', () => {
    // Wind from 0°: north is up. Sailing 090° (east): right.
    close(headingDir(0, 0)!, [0, -1]);
    close(headingDir(90, 0)!, [1, 0]);
    // Wind from 225°: a boat on 270° is 45° right of the wind, up and to the right.
    close(headingDir(270, 225)!, [Math.SQRT1_2, -Math.SQRT1_2]);
    expect(shapeRotationDeg(headingDir(270, 225)!)).toBeCloseTo(45, 9);
    expect(headingDir(NaN, 0)).toBeNull();
  });

  it('the hull centred on the position: bow LOA/2 ahead along the direction, transom LOA/2 behind, beam across', () => {
    const at: Vec = [10, 20];
    const dir: Vec = [1, 0];
    const o = hullOutlineAt(at, dir, J70);
    close(o[0], [10 + J70.loaM / 2, 20]);
    // Transom corners: LOA/2 behind, ±0.46 beam across.
    const t = o.length >> 1;
    close(o[t], [10 - J70.loaM / 2, 20 + 0.46 * J70.beamM]);
    close(o[t + 1], [10 - J70.loaM / 2, 20 - 0.46 * J70.beamM]);
    // Symmetric about the course; the widest point the beam.
    const ys = o.map((p) => p[1] - 20);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(J70.beamM, 6);
    expect(hullPathAt(at, dir, J70)).toBe(hullPathD(o));
  });

  it('the same outline as the start chart’s (hullOutline, east/north) once turned onto the map', () => {
    // Wind from the north: map = (east, −north). Heading 090: the start chart's bow at the bow point.
    const bow: Vec = [3.467, 0];
    const chart = hullOutline(bow, 90, J70).map(([x, y]): Vec => [x, -y]);
    const map = hullOutlineAt([0, 0], [1, 0], J70);
    chart.forEach((p, i) => close(p, map[i], 1e-3));
  });
});

describe('boat shape: the shape, or the dot', () => {
  const base = { dir: [0, -1] as Vec, hold: false, sog: 5, dims: J70, pxPerM: 2 };

  it('a moving boat with a course and a known class: the hull along its course, to scale once over BOAT_SHAPE_PX, else that long', () => {
    expect([BOAT_SHAPE_PX, BOAT_SHAPE_ON_PX]).toEqual([12, 15]);
    // 6.93 m at 2 px/m = 13.9 px: to scale.
    expect(boatShapeOr(base)).toEqual({ shape: [0, -1], dims: J70 });
    // Unknown SOG (NaN) with a course: still a shape.
    expect(boatShapeOr({ ...base, sog: NaN })).toEqual({ shape: [0, -1], dims: J70 });
    // At 0.5 px/m (3.5 px to scale): a 12 px symbol, the hull's proportions kept; the selected boat's 15 px.
    const small = boatShapeOr({ ...base, pxPerM: 0.5 });
    if (!('shape' in small)) throw new Error('a shape');
    expect(small.dims.loaM * 0.5).toBeCloseTo(BOAT_SHAPE_PX, 9);
    expect(small.dims.beamM / small.dims.loaM).toBeCloseTo(J70.beamM / J70.loaM, 9);
    const on = boatShapeOr({ ...base, pxPerM: 0.5, minPx: BOAT_SHAPE_ON_PX });
    expect('shape' in on && on.dims.loaM * 0.5).toBeCloseTo(BOAT_SHAPE_ON_PX, 9);
  });

  it('falls back to the dot only for unknown heading, held in a gap, too slow or no class', () => {
    expect(boatShapeOr({ ...base, dir: null })).toEqual({ dot: 'no-heading' });
    expect(boatShapeOr({ ...base, dir: [0, 0] })).toEqual({ dot: 'no-heading' });
    expect(boatShapeOr({ ...base, dir: [NaN, 1] })).toEqual({ dot: 'no-heading' });
    expect(boatShapeOr({ ...base, hold: true })).toEqual({ dot: 'hold' });
    expect(BOAT_SHAPE_MIN_KN).toBe(1);
    expect(boatShapeOr({ ...base, sog: 0.9 })).toEqual({ dot: 'slow' });
    expect(boatShapeOr({ ...base, sog: BOAT_SHAPE_MIN_KN })).toEqual({ shape: [0, -1], dims: J70 });
    expect(boatShapeOr({ ...base, dims: null })).toEqual({ dot: 'no-class' });
  });

  it('however far zoomed out, the hull at the fixed symbol size, never a dot', () => {
    // 0.01 px/m: a J/70 to scale is 0.07 px, drawn BOAT_SHAPE_PX long (the selected boat BOAT_SHAPE_ON_PX), its proportions kept.
    for (const pxPerM of [0.2, 0.05, 0.01, 1e-4]) {
      const s = boatShapeOr({ ...base, pxPerM });
      if (!('shape' in s)) throw new Error(`a shape at ${pxPerM} px/m`);
      expect(s.shape).toEqual([0, -1]);
      expect(s.dims.loaM * pxPerM).toBeCloseTo(BOAT_SHAPE_PX, 6);
      expect(s.dims.beamM / s.dims.loaM).toBeCloseTo(J70.beamM / J70.loaM, 9);
      const on = boatShapeOr({ ...base, pxPerM, minPx: BOAT_SHAPE_ON_PX });
      expect('shape' in on && on.dims.loaM * pxPerM).toBeCloseTo(BOAT_SHAPE_ON_PX, 6);
    }
  });

  it('enlarged (the map says "Boats not to scale") exactly while the hull is stretched to the symbol', () => {
    expect(BOATS_NOT_TO_SCALE).toBe('Boats not to scale');
    const edge = BOAT_SHAPE_PX / J70.loaM;
    expect(hullEnlarged(J70, edge * 0.99)).toBe(true);
    expect(hullEnlarged(J70, edge)).toBe(false);
    expect(hullEnlarged(J70, 0.01)).toBe(true);
    // The selected boat's bigger symbol: enlarged a little further in.
    expect(hullEnlarged(J70, edge, BOAT_SHAPE_ON_PX)).toBe(true);
    expect(hullEnlarged(J70, BOAT_SHAPE_ON_PX / J70.loaM, BOAT_SHAPE_ON_PX)).toBe(false);
    // No class: no hulls, nothing to say.
    expect(hullEnlarged(null, 0.01)).toBe(false);
    for (const pxPerM of [0.01, edge * 0.5, edge, 4]) {
      const s = boatShapeOr({ ...base, pxPerM });
      expect('shape' in s && s.dims.loaM > J70.loaM).toBe(hullEnlarged(J70, pxPerM));
    }
  });
});

describe('the track map while scrubbing: hulls where they can be (IC37 R5, 11.3 m)', () => {
  const data = ic37Race();
  const a = analyzeRace(data);
  const dims = startClass(a)!.dims;
  const gun = a.meta.gunMs;
  const w = scrubWindow(a);
  const t = gun + 60_000;
  const win = trailWindow(t, '30', w);
  const boats = boatsAt(a, null, t);
  const moving = boats.find((b) => b.dir && !b.hold && b.sog >= BOAT_SHAPE_MIN_KN)!;
  // The feed's tracker-to-bow distance: the map draws each hull from that bow.
  const bowM = bowAheadM(a.boats.find((b) => b.id === moving.id)!.bowOffsetM, dims);
  const bowOf = (b: { mx: number; my: number }, dir: Vec): Vec => [b.mx + dir[0] * bowM, b.my + dir[1] * bowM];

  it('draws from the feed’s bow: 4.9 m ahead of the tracker on an IC37, not half its 11.3 m', () => {
    expect(bowM).toBeCloseTo(4.9, 9);
  });

  it('at Fit an IC37 to scale would be 2.5 px: a 12 px hull symbol along its course from the bow, reaching further aft; a dot with a course tick only for a boat without a course', () => {
    const { view } = trackMapView(a, null);
    const unit = Math.max(view.x1 - view.x0, view.y1 - view.y0) / 600;
    const px = dims.loaM / unit;
    expect(px).toBeLessThan(BOAT_SHAPE_PX);
    const f = scrubFrame(a, null, null, {}, { t, win });
    const f12 = BOAT_SHAPE_PX / px;
    const big = { loaM: dims.loaM * f12, beamM: dims.beamM * f12 };
    const mid = hullCenterFromBow([moving.mx, moving.my], moving.dir!, bowM, big);
    const d = hullPathAt(mid, moving.dir!, big);
    expect(f.dots).toContain(`<path class="dot hull" data-id="${moving.id}" d="${d}"`);
    // Its bow tip is the real bow; the symbol's extra length is all aft of it.
    const tip = hullOutlineAt(mid, moving.dir!, big)[0];
    const bow = bowOf(moving, moving.dir!);
    expect(Math.hypot(tip[0] - bow[0], tip[1] - bow[1])).toBeLessThan(1e-9);
    expect(f.dots).not.toMatch(new RegExp(`<circle class="dot[^"]*" data-id="${moving.id}"`));
    // A boat with no course (if any at this second) keeps its dot; no course tick on a hull.
    for (const b of boats.filter((x) => !x.dir || x.hold)) expect(f.dots).toMatch(new RegExp(`<circle class="dot[^"]*" data-id="${b.id}"`));
    expect(f.dots.match(/class="dot-hdg"/g)?.length ?? 0).toBe(boats.filter((x) => x.dir && !x.hold && 'dot' in boatShapeOr({ dir: x.dir, hold: false, sog: x.sog, dims, pxPerM: 1 / unit })).length);
  });

  it('zoomed in on a boat: its hull to scale, its bow the feed’s bow ahead of its position, pointing along its course; colours, labels and classes kept', () => {
    const view = { cx: moving.mx, cy: moving.my, k: K_MAX };
    const f = scrubFrame(a, moving.id, null, { view }, { t, win });
    const { view: box } = trackMapView(a, null, view);
    const unit = Math.max(box.x1 - box.x0, box.y1 - box.y0) / 600;
    // To scale: longer than the symbol's 15 px.
    expect(dims.loaM / unit).toBeGreaterThanOrEqual(BOAT_SHAPE_ON_PX);
    const mid = hullCenterFromBow([moving.mx, moving.my], moving.dir!, bowM, dims);
    const d = hullPathAt(mid, moving.dir!, dims);
    expect(f.dots).toContain(`<path class="dot hull on" data-id="${moving.id}" d="${d}" fill="var(--s`);
    const tip = hullOutlineAt(mid, moving.dir!, dims)[0];
    const bow = bowOf(moving, moving.dir!);
    expect(Math.hypot(tip[0] - bow[0], tip[1] - bow[1])).toBeLessThan(1e-9);
    // The selected boat still labelled with its sail number, on top.
    const sail = a.boats.find((b) => b.id === moving.id)!.sail;
    expect(f.dots.endsWith('</g>')).toBe(true);
    expect(f.dots.slice(f.dots.lastIndexOf('<g class="boat-at on">'))).toContain(`>${sail}</text>`);
    // No course tick on a hull (the shape points the way).
    expect(f.dots.slice(f.dots.lastIndexOf('<g class="boat-at on">'))).not.toContain('dot-hdg');
  });

  it('zoomed in, a held boat or one with no course stays a dot', () => {
    const view = { cx: moving.mx, cy: moving.my, k: K_MAX };
    const f = scrubFrame(a, null, null, { view }, { t, win });
    for (const b of boats.filter((x) => x.hold || !x.dir)) expect(f.dots).toMatch(new RegExp(`<circle class="dot[^"]*" data-id="${b.id}"`));
  });
});

describe('"Boats not to scale": said at the bottom of the map while hulls are stretched (IC37 R5, 11.3 m)', () => {
  const a = analyzeRace(ic37Race());
  const dims = startClass(a)!.dims;
  const note = (svg: string): { x: number; y: number; fs: number } | null => {
    const m = svg.match(/<text class="scale-note" x="([-\d.]+)" y="([-\d.]+)" font-size="([\d.]+)" text-anchor="end"[^>]*>Boats not to scale<\/text>/);
    return m ? { x: Number(m[1]), y: Number(m[2]), fs: Number(m[3]) } : null;
  };
  type R = { x0: number; y0: number; x1: number; y1: number };
  const hits = (p: R, q: R): boolean => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;

  it('scrubbing at Fit (hulls stretched to the symbol): in the map’s HUD, bottom right, clear of the scale bar and the wind label', () => {
    const { view } = trackMapView(a, null);
    const unit = Math.max(view.x1 - view.x0, view.y1 - view.y0) / 600;
    expect(dims.loaM / unit).toBeLessThan(BOAT_SHAPE_PX);
    const svg = trackMap(a, null, null, { scrub: true });
    const hud = svg.slice(svg.indexOf('<g class="map-hud">'));
    const n = note(hud);
    expect(n).not.toBeNull();
    const nb: R = { x0: n!.x - textWidth('Boats not to scale', n!.fs), y0: n!.y - n!.fs, x1: n!.x, y1: n!.y + 0.3 * n!.fs };
    expect(nb.x1).toBeLessThanOrEqual(view.x1);
    expect(nb.y1).toBeLessThanOrEqual(view.y1);
    // The scale bar (its line and its label above it) and the wind arrow's label.
    const bar = hud.match(/<g class="scalebar"><line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)"[\s\S]*?font-size="([\d.]+)"[^>]*>([^<]+)</)!;
    const [bx0, by, bx1, bfs] = [1, 2, 3, 4].map((i) => Number(bar[i]));
    expect(hits(nb, { x0: bx0, y0: by - 4 * unit - bfs, x1: bx1, y1: by + 2 * unit })).toBe(false);
    const wind = hud.match(/<g class="wind"[\s\S]*?<text x="([-\d.]+)" y="([-\d.]+)" font-size="([\d.]+)"[^>]*>([^<]+)</)!;
    const [wx, wy, wfs] = [1, 2, 3].map((i) => Number(wind[i]));
    const ww = textWidth(wind[4], wfs);
    expect(hits(nb, { x0: wx - ww, y0: wy - wfs, x1: wx + ww, y1: wy + 0.3 * wfs })).toBe(false);
  });

  it('hidden once the hulls are to scale (zoomed in on a big boat), and on the static map (no boats drawn)', () => {
    const b = boatsAt(a, null, a.meta.gunMs + 60_000).find((x) => x.dir)!;
    const view = { cx: b.mx, cy: b.my, k: K_MAX };
    const { view: box } = trackMapView(a, null, view);
    const unit = Math.max(box.x1 - box.x0, box.y1 - box.y0) / 600;
    expect(dims.loaM / unit).toBeGreaterThanOrEqual(BOAT_SHAPE_ON_PX);
    expect(note(trackMap(a, b.id, null, { scrub: true, view }))).toBeNull();
    expect(note(trackMap(a, null, null, { scrub: true, view }))).toBeNull();
    expect(note(trackMap(a, null))).toBeNull();
  });

  it('Start Playback says it too while its hulls are stretched, and not once they are to scale', () => {
    const L = laneScrub(a, { me: null, replays: startReplays(a, ic37Race()) });
    const ppu = lanePxPerUnit(L.view);
    const fit = laneScrubHtml(a, L, 0);
    expect(note(fit) != null).toBe(dims.loaM * ppu < BOAT_SHAPE_PX);
    // Zoomed in until a hull is longer than the symbol: none.
    const k = Math.ceil(BOAT_SHAPE_ON_PX / (dims.loaM * ppu)) + 1;
    const cx = (L.view.x0 + L.view.x1) / 2;
    const cy = (L.view.y0 + L.view.y1) / 2;
    expect(note(laneScrubHtml(a, L, 0, ppu, false, { cx, cy, k }))).toBeNull();
  });
});

describe('over early: one styling for the track map replay and Around the gun (IC37 R5, USA 019)', () => {
  const data = ic37Race();
  const a = analyzeRace(data);
  const replays = startReplays(a, data);
  const r = replays.find((x) => a.boats.find((b) => b.id === x.boat)?.sail === 'USA 019')!;
  const d = a.drawings.find((x) => x.id === r.boat)!;
  const gun = a.meta.gunMs;

  it('the track map’s replay draws exactly the shared helper’s stretch (classes, widths, dashes, marks)', () => {
    const t = gun + 40_000;
    const win = trailWindow(t, 'all', scrubWindow(a));
    const f = scrubFrame(a, r.boat, null, { replay: r }, { t, win });
    const { view } = trackMapView(a, null);
    const unit = Math.max(view.x1 - view.x0, view.y1 - view.y0) / 600;
    const want = ocsSvg(ocsStretch(r, legRanges(d, true), a.wind.twdAtGunDeg, t, win), { unit });
    expect(want.tracks).toContain('class="ocs-over"');
    expect(want.tracks).toContain('class="ocs-dip"');
    expect(f.ocs).toBe(want.tracks);
    expect(f.dots).toContain(want.marks);
  });

  it('Around the gun draws the same stretch, the same classes (sizes non-scaling), until it cleared', () => {
    const L = laneScrub(a, { me: null, replays });
    const s = 40;
    const t = gun + s * 1000;
    const lane = L.frame(s).boats.find((b) => b.id === r.boat)!;
    const stretch = ocsStretch(r, legRanges(d, true), a.wind.twdAtGunDeg, t, [L.frame(s).from, t]);
    expect(lane.ocs).toEqual(stretch);
    const html = laneScrubHtml(a, L, s);
    const ppu = lanePxPerUnit(L.view);
    expect(html).toContain(ocsSvg(stretch, { unit: 1 / ppu, nonScaling: true }).tracks);
    // Cleared ≈ +35 s: by +40 s the dip ends at the clearing, marked with the filled dot.
    expect(stretch.clear).not.toBeNull();
    expect(html).toContain('class="ocs-mark clear"');
  });
});
