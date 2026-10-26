import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { BoatDrawing, RaceAnalysis, TrackSegment } from '../src/analysis/types';
import { mapBox, rotator, segRuns, trackMap, trackMapView, trackPoints } from '../src/ui/charts';
import { localTime } from '../src/ui/format';
import { cogAt, fixSegment, heelLabel, mapPoints, mapTipHtml, mapTipLines, pickAt, pickMapPoint } from '../src/ui/mapPoints';
import { clientToChart, fitView, viewBox, type View } from '../src/ui/view';
import { fixtureRace, j105Race } from './helpers';

const a = analyzeRace(fixtureRace());
const vb = (svg: string): number[] => /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);

/** A 1 Hz segment along y = 0 (x east), `n` fixes from t = 0, with the fixes from `holeAt` on moved `holeMs` later. */
function seg(n: number, holeAt = n, holeMs = 0, leg = 0): TrackSegment {
  const t = Float64Array.from({ length: n }, (_, i) => i * 1000 + (i >= holeAt ? holeMs : 0));
  return {
    leg,
    x: Float32Array.from({ length: n }, (_, i) => i * 3),
    y: new Float32Array(n),
    t,
    sog: new Float32Array(n).fill(6),
  };
}

/** The race with boat 0's leg-1 segment given a 12 s hole halfway along. */
function withHole(src: RaceAnalysis): { a: RaceAnalysis; id: string; s: TrackSegment; at: number } {
  const d0 = src.drawings[0];
  const k = d0.segments.findIndex((s) => s.leg === 1);
  const s0 = d0.segments[k];
  const at = s0.t.length >> 1;
  // A 30 s hole (filled in and drawn as the rest of the track: ui/gapFill.ts).
  const t = Float64Array.from(s0.t, (v, i) => (i >= at ? v + 30_000 : v));
  const s: TrackSegment = { ...s0, t };
  // Its feed's own holes are those of the cut track now: judged on the drawn fixes (no BoatDrawing.holes).
  const d: BoatDrawing = { ...d0, segments: d0.segments.map((x, i) => (i === k ? s : x)), holes: undefined };
  return { a: { ...src, drawings: [d, ...src.drawings.slice(1)] }, id: d0.id, s, at };
}

describe('holes are bridged, never breaks', () => {
  it('segRuns: the points as one run (the tracks come with their holes filled in); near the view only when zoomed', () => {
    const s = seg(6, 3, 5000); // steps 1, 1, 6, 1, 1 s
    expect(segRuns(s.x, s.y).map((r) => r.length)).toEqual([6]);
    const lone = { ...seg(5), t: Float64Array.from([0, 1000, 9000, 20000, 21000]) };
    expect(segRuns(lone.x, lone.y).map((r) => r.length)).toEqual([5]);
    // Zoomed in: only the points near the view (and the one either side).
    expect(segRuns(seg(20).x, seg(20).y, { x0: 10, y0: -1, x1: 14, y1: 1 }).map((r) => r.length)).toEqual([3]);
  });

  it('draws one line across a hole (no chord, nothing lighter) in Leg, Rank and Boat speed', () => {
    const { a: h, id } = withHole(a);
    const leg = trackMap(h, null, 1);
    const mine = [...leg.matchAll(/<polyline class="trk" data-leg="1" points="[^"]+"/g)];
    expect(mine.length).toBe(h.drawings.filter((d) => d.segments.some((s) => s.leg === 1 && s.x.length > 1)).length);
    expect(leg).not.toMatch(/trk-gap|trk-est/);
    const rank = trackMap(h, id, 1, { colour: 'rank' });
    expect(rank.match(new RegExp(`<polyline class="trk spd[^"]*" data-leg="1" data-id="${id}"`, 'g'))).toHaveLength(1);
    const sog = trackMap(h, null, 1, { colour: 'sog' });
    expect(sog).toMatch(new RegExp(`<g class="sog-trk" data-id="${id}"`));
    expect(sog).not.toMatch(/sog-gap|sog-est/);
  });

  it('leaves native <title> off Leg and Rank tracks (the hover/tap tooltip is the details)', () => {
    expect(trackMap(a, null, 1)).not.toContain('<title>');
    expect(trackMap(a, a.drawings[0].id, 1, { colour: 'rank' })).not.toContain('<title>');
    expect(trackMap(a, null, null, { colour: 'rank', rankBy: 'overall' })).not.toContain('<title>');
  });

  it('a point in a hole reads like any other: picked as a point, its tooltip with no gap note', () => {
    const { a: h, id, s, at } = withHole(a);
    const p = trackPoints(h, 1);
    expect(p).not.toHaveProperty('gaps');
    // A filled-in point of that boat's track, inside the hole, is in the lookup and picked there like a fix.
    const i = [...p.ix.t].findIndex((t, k) => p.ix.ids[p.ix.boat[k]] === id && t > s.t[at - 1] && t < s.t[at]);
    expect(i).toBeGreaterThanOrEqual(0);
    const pick = pickMapPoint(p, p.ix.x[i], p.ix.y[i], 1e-6, 1e-6, id);
    expect(pick?.kind).toBe('fix');
    expect(pickAt(p, pick!)).toEqual([p.ix.x[i], p.ix.y[i]]);
    const lines = mapTipLines(h, p, pick!);
    expect(lines[0]).toContain(h.boats.find((b) => b.id === id)!.sail);
    expect(lines[1].startsWith(localTime(p.ix.t[i], h.meta.tzOffsetMs))).toBe(true);
    expect(lines.join(' ')).not.toMatch(/no data|no fix|estimated|gap/i);
  });
});

describe('course over ground from positions', () => {
  const at = (deg: number): { x: number[]; y: number[] } => {
    const r = (deg * Math.PI) / 180;
    return { x: [0, 5 * Math.sin(r), 10 * Math.sin(r)], y: [0, 5 * Math.cos(r), 10 * Math.cos(r)] };
  };
  it('gives degrees true (x east, y north), wrapping at 0/360', () => {
    for (const deg of [0, 1, 45, 90, 180, 270, 359]) {
      const { x, y } = at(deg);
      for (const i of [0, 1, 2]) expect(cogAt(x, y, i)).toBeCloseTo(deg % 360, 6);
    }
    const { x, y } = at(359.6);
    expect(cogAt(x, y, 1)).toBeGreaterThan(359);
  });

  it('uses the neighbours either side (one side at an end), and none when still', () => {
    // East, then north: the corner fix between them reads the course across it.
    const x = [0, 5, 10, 10, 10];
    const y = [0, 0, 0, 5, 10];
    expect(cogAt(x, y, 1)).toBeCloseTo(90, 6);
    expect(cogAt(x, y, 2)).toBeCloseTo(45, 6);
    expect(cogAt(x, y, 4)).toBeCloseTo(0, 6);
    expect(cogAt([0, 0], [0, 0.1], 0)).toBeNaN();
    expect(cogAt([0], [0], 0)).toBeNaN();
  });
});

describe('heel', () => {
  it('names the side (roll − = to port), and is absent without a reading', () => {
    expect(heelLabel(-12.4)).toBe('12° heel to port');
    expect(heelLabel(8.6)).toBe('9° heel to starboard');
    expect(heelLabel(0.3)).toBe('0° heel');
    expect(heelLabel(NaN)).toBeNull();
    expect(heelLabel(undefined)).toBeNull();
  });

  it('carries roll onto the drawn segments only when the source has it', () => {
    const segs = a.drawings.flatMap((d) => d.segments);
    expect(segs.every((s) => s.roll && s.roll.length === s.t.length)).toBe(true);
    expect(segs.some((s) => s.roll!.some(Number.isFinite))).toBe(true);
    expect(analyzeRace(j105Race(3)).drawings.every((d) => d.segments.every((s) => s.roll === undefined))).toBe(true);
  });
});

describe('the tooltip', () => {
  const tz = a.meta.tzOffsetMs;
  const p = trackPoints(a, null);
  // A fix with a roll reading, well inside its segment.
  const i = (() => {
    for (let i = 0; i < p.ix.x.length; i++) {
      const { s, j } = fixSegment(p, i);
      if (j > 2 && j < p.segs[s].t.length - 3 && Number.isFinite(p.segs[s].roll![j]) && Math.abs(p.segs[s].roll![j]) >= 1) return i;
    }
    return -1;
  })();

  it('lists boat, time, SOG and COG, heel, leg and place', () => {
    expect(i).toBeGreaterThanOrEqual(0);
    const { s, j } = fixSegment(p, i);
    const sg = p.segs[s];
    const id = p.ix.ids[p.ix.boat[i]];
    const b = a.boats.find((x) => x.id === id)!;
    const lines = mapTipLines(a, p, { kind: 'fix', i }, { placeAt: (who, t) => (who === id && t === sg.t[j] ? { place: 2, of: 6 } : null) });
    const gun = (sg.t[j] - a.meta.gunMs) / 1000;
    expect(lines[0]).toBe(`#${b.sail}${b.name !== `#${b.sail}` ? ` ${b.name}` : ''}`);
    expect(lines[1]).toBe(`${localTime(sg.t[j], tz)} (gun +${Math.floor(gun / 60)}:${String(Math.round(gun % 60)).padStart(2, '0')})`);
    expect(lines[2]).toMatch(new RegExp(`^SOG ${sg.sog[j].toFixed(1)} kn · COG \\d{1,3}°$`));
    const cog = Number(/COG (\d+)°/.exec(lines[2])![1]);
    expect(cog).toBe(Math.round(cogAt(sg.x, sg.y, j)) % 360);
    expect(lines[3]).toBe(heelLabel(sg.roll![j]));
    expect(lines[4]).toBe(a.legs[p.legs[s]].name);
    expect(lines[5]).toBe('Place 2 of 6');
    expect(lines).toHaveLength(6);
    expect(mapTipHtml(lines)).toMatch(/^<b>#[^<]+<\/b><br>\d\d:\d\d:\d\d/);
  });

  it('leaves out heel without a reading and place without a sound one', () => {
    const d: BoatDrawing = { ...a.drawings[0], segments: [seg(10)] };
    const q = mapPoints({ drawings: [d] }, null, (s) => s);
    const lines = mapTipLines(a, q, { kind: 'fix', i: 4 }, { placeAt: () => null });
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe('SOG 6.0 kn · COG 90°');
    expect(lines.join(' ')).not.toMatch(/heel|Place/);
    const nan: BoatDrawing = { ...d, segments: [{ ...seg(10), roll: new Float32Array(10).fill(NaN) }] };
    expect(mapTipLines(a, mapPoints({ drawings: [nan] }, null, (s) => s), { kind: 'fix', i: 4 }).join(' ')).not.toContain('heel');
    // The leg line can be swapped (Boat speed adds the leg's range).
    expect(mapTipLines(a, q, { kind: 'fix', i: 4 }, { legLine: (l) => `leg ${l} · range` })).toContain('leg 0 · range');
  });
});

describe('pan/zoom on the track map', () => {
  it('shows the fit box at Fit and a window inside it when zoomed', () => {
    const box = mapBox(a, null);
    const [x0, y0, w, h] = vb(trackMap(a, null));
    [x0, y0, x0 + w, y0 + h].forEach((n, i) => expect(n).toBeCloseTo([box.x0, box.y0, box.x1, box.y1][i], 9));
    expect(vb(trackMap(a, null, null, { view: fitView(box) }))).toEqual(vb(trackMap(a, null)));
    const v: View = { cx: box.x0 + (box.x1 - box.x0) * 0.3, cy: box.y0 + (box.y1 - box.y0) * 0.6, k: 4 };
    const [zx, zy, zw, zh] = vb(trackMap(a, null, null, { view: v }));
    expect(zw).toBeCloseTo(w / 4, 9);
    expect(zh).toBeCloseTo(h / 4, 9);
    expect(zx).toBeGreaterThanOrEqual(box.x0);
    expect(zy).toBeGreaterThanOrEqual(box.y0);
    expect(zx + zw).toBeLessThanOrEqual(box.x1 + 1e-9);
    expect(zy + zh).toBeLessThanOrEqual(box.y1 + 1e-9);
    // Panned past the edge: clamped back inside.
    const [ex, , ew] = vb(trackMap(a, null, null, { view: { cx: box.x1 + 1000, cy: v.cy, k: 4 } }));
    expect(ex + ew).toBeCloseTo(box.x1, 9);
    // A leg's own frame.
    expect(trackMapView(a, 2).box).toEqual(mapBox(a, 2));
  });

  it('keeps line widths, labels and the scale bar to screen size, the bar on the zoomed scale', () => {
    const box = mapBox(a, null);
    const sw = (svg: string): number => Number(/<polyline class="trk"[^>]* stroke-width="([\d.]+)"/.exec(svg)![1]);
    const fs = (svg: string): number => Number(/<g class="scalebar">[\s\S]*?font-size="([\d.]+)"/.exec(svg)![1]);
    const bar = (svg: string): number => Number(/<g class="scalebar">[\s\S]*?>(\d+) m<\/text>/.exec(svg)![1]);
    const fit = trackMap(a, null);
    const zoom = trackMap(a, null, null, { view: { ...fitView(box), k: 8 } });
    expect(sw(zoom)).toBeCloseTo(sw(fit) / 8, 1);
    expect(fs(zoom)).toBeCloseTo(fs(fit) / 8, 6);
    expect(bar(zoom)).toBeLessThan(bar(fit));
  });

  it('draws only the track near the view when zoomed in', () => {
    const box = mapBox(a, null);
    const v: View = { ...fitView(box), k: 8 };
    const zoom = trackMap(a, null, null, { view: v });
    expect(zoom.length).toBeLessThan(trackMap(a, null).length / 2);
    const w = viewBox(box, v);
    for (const m of zoom.matchAll(/<polyline class="trk[^"]*" data-leg="\d+" points="([^"]+)"/g)) {
      const ps = m[1].split(' ').map((p) => p.split(',').map(Number));
      // Each run has a fix within the view grown by half its size.
      expect(ps.some(([x, y]) => x >= w.x0 - w.w / 2 - 1 && x <= w.x0 + 1.5 * w.w + 1 && y >= w.y0 - w.h / 2 - 1 && y <= w.y0 + 1.5 * w.h + 1)).toBe(true);
    }
  });

  it('hit-tests in the zoomed view, with the pick radius on screen', () => {
    const box = mapBox(a, null);
    const p = trackPoints(a, null);
    const fix = p.ix.x.length >> 1;
    const [fx, fy] = [p.ix.x[fix], p.ix.y[fix]];
    const v: View = { cx: fx, cy: fy, k: 4 };
    const rect = { left: 0, top: 0, width: 600, height: 600 * ((box.y1 - box.y0) / (box.x1 - box.x0)) };
    const vbx = viewBox(box, v);
    const s = Math.min(rect.width / vbx.w, rect.height / vbx.h);
    const px = 1 / s;
    // The fix's own screen point maps back onto it.
    const cx = (rect.width - vbx.w * s) / 2 + (fx - vbx.x0) * s;
    const cy = (rect.height - vbx.h * s) / 2 + (fy - vbx.y0) * s;
    const [x, y] = clientToChart(box, v, rect, cx, cy);
    expect(x).toBeCloseTo(fx, 6);
    expect(y).toBeCloseTo(fy, 6);
    const hit = pickMapPoint(p, x, y, 40 * px, 8 * px, null);
    expect(hit?.kind).toBe('fix');
    expect(Math.hypot(p.ix.x[(hit as { i: number }).i] - fx, p.ix.y[(hit as { i: number }).i] - fy)).toBe(0);
    // ~12 screen px off the track at 4×: too far for an 8 px reach, though at Fit (radii ×4 in map units) it's in reach.
    const nearestTo = (q: [number, number]): number => Math.min(...Array.from(p.ix.x, (xx, k) => Math.hypot(xx - q[0], p.ix.y[k] - q[1])));
    const far = Array.from({ length: 16 }, (_, k): [number, number] => [fx + 12 * px * Math.cos(k * 0.39), fy + 12 * px * Math.sin(k * 0.39)]).find(
      (q) => nearestTo(q) > 9 * px,
    )!;
    expect(far).toBeDefined();
    expect(pickMapPoint(p, far[0], far[1], 40 * px, 8 * px, null)).toBeNull();
    expect(pickMapPoint(p, far[0], far[1], 40 * px * 4, 8 * px * 4, null)).not.toBeNull();
  });

  it('prefers the selected boat within its wider reach', () => {
    const p = mapPoints(
      {
        drawings: [
          { ...a.drawings[0], id: 'near', segments: [seg(5)] },
          { ...a.drawings[1], id: 'sel', segments: [{ ...seg(5), y: new Float32Array(5).fill(10) }] },
        ],
      },
      null,
      (s) => s,
    );
    const anyone = pickMapPoint(p, 6, 2, 20, 4, null)!;
    expect(p.ix.ids[p.ix.boat[(anyone as { i: number }).i]]).toBe('near');
    const sel = pickMapPoint(p, 6, 2, 20, 4, 'sel')!;
    expect(p.ix.ids[p.ix.boat[(sel as { i: number }).i]]).toBe('sel');
    // Out of the selected boat's reach: anyone's nearest still reads.
    const back = pickMapPoint(p, 6, 2, 5, 4, 'sel')!;
    expect(p.ix.ids[p.ix.boat[(back as { i: number }).i]]).toBe('near');
  });

  it('rotates fixes the same for the lookup as for the drawing', () => {
    const p = trackPoints(a, 1);
    const rot = rotator(a.wind.twdAtGunDeg);
    const { s, j } = fixSegment(p, 7);
    const [x, y] = rot([p.segs[s].x[j], p.segs[s].y[j]]);
    expect(p.ix.x[7]).toBeCloseTo(x, 9);
    expect(p.ix.y[7]).toBeCloseTo(y, 9);
    expect(p.ix.leg.every((l) => l === 1)).toBe(true);
  });
});
