import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { Vec } from '../src/analysis/geo';
import { startReplays } from '../src/analysis/startReplay';
import {
  BOAT_SHAPE_MIN_KN,
  BOAT_SHAPE_MIN_PX,
  BOAT_SHAPE_ON_PX,
  BOAT_SHAPE_PX,
  boatShapeOr,
  headingDir,
  hullOutline,
  hullOutlineAt,
  hullPathAt,
  hullPathD,
  shapeRotationDeg,
} from '../src/ui/boatShape';
import { boatsAt, scrubFrame, startClass, trackMapView } from '../src/ui/charts';
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

  it('falls back to the dot: unknown heading, held in a gap, too slow, no class, too small on screen', () => {
    expect(boatShapeOr({ ...base, dir: null })).toEqual({ dot: 'no-heading' });
    expect(boatShapeOr({ ...base, dir: [0, 0] })).toEqual({ dot: 'no-heading' });
    expect(boatShapeOr({ ...base, dir: [NaN, 1] })).toEqual({ dot: 'no-heading' });
    expect(boatShapeOr({ ...base, hold: true })).toEqual({ dot: 'hold' });
    expect(BOAT_SHAPE_MIN_KN).toBe(1);
    expect(boatShapeOr({ ...base, sog: 0.9 })).toEqual({ dot: 'slow' });
    expect(boatShapeOr({ ...base, sog: BOAT_SHAPE_MIN_KN })).toEqual({ shape: [0, -1], dims: J70 });
    expect(boatShapeOr({ ...base, dims: null })).toEqual({ dot: 'no-class' });
    // Zoomed out too far: the hull to scale under 1.5 px on screen (a 12 px symbol would overstate it over 8×).
    expect(BOAT_SHAPE_MIN_PX).toBe(1.5);
    const edge = BOAT_SHAPE_MIN_PX / J70.loaM;
    expect('shape' in boatShapeOr({ ...base, pxPerM: edge })).toBe(true);
    expect(boatShapeOr({ ...base, pxPerM: edge * 0.99 })).toEqual({ dot: 'small' });
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

  it('at Fit an IC37 to scale would be 2.5 px: a 12 px hull symbol along its course; a dot with a course tick only for a boat without a course', () => {
    const { view } = trackMapView(a, null);
    const unit = Math.max(view.x1 - view.x0, view.y1 - view.y0) / 600;
    const px = dims.loaM / unit;
    expect(px).toBeGreaterThan(BOAT_SHAPE_MIN_PX);
    expect(px).toBeLessThan(BOAT_SHAPE_PX);
    const f = scrubFrame(a, null, null, {}, { t, win });
    const f12 = BOAT_SHAPE_PX / px;
    const d = hullPathAt([moving.mx, moving.my], moving.dir!, { loaM: dims.loaM * f12, beamM: dims.beamM * f12 });
    expect(f.dots).toContain(`<path class="dot hull" data-id="${moving.id}" d="${d}"`);
    expect(f.dots).not.toMatch(new RegExp(`<circle class="dot[^"]*" data-id="${moving.id}"`));
    // A boat with no course (if any at this second) keeps its dot; no course tick on a hull.
    for (const b of boats.filter((x) => !x.dir || x.hold)) expect(f.dots).toMatch(new RegExp(`<circle class="dot[^"]*" data-id="${b.id}"`));
    expect(f.dots.match(/class="dot-hdg"/g)?.length ?? 0).toBe(boats.filter((x) => x.dir && !x.hold && 'dot' in boatShapeOr({ dir: x.dir, hold: false, sog: x.sog, dims, pxPerM: 1 / unit })).length);
  });

  it('zoomed in on a boat: its hull to scale, centred on its position, pointing along its course; colours, labels and classes kept', () => {
    const view = { cx: moving.mx, cy: moving.my, k: K_MAX };
    const f = scrubFrame(a, moving.id, null, { view }, { t, win });
    const { view: box } = trackMapView(a, null, view);
    const unit = Math.max(box.x1 - box.x0, box.y1 - box.y0) / 600;
    // To scale: longer than the symbol's 15 px.
    expect(dims.loaM / unit).toBeGreaterThanOrEqual(BOAT_SHAPE_ON_PX);
    const d = hullPathAt([moving.mx, moving.my], moving.dir!, dims);
    expect(f.dots).toContain(`<path class="dot hull on" data-id="${moving.id}" d="${d}" fill="var(--s`);
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
