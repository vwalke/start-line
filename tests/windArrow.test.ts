import { describe, expect, it } from 'vitest';
import { dot, wrap180, type Vec } from '../src/analysis/geo';
import { ladderReader } from '../src/analysis/coach/ladderNow';
import { liveWind } from '../src/analysis/coach/liveWind';
import { startSnapshot, trackMap } from '../src/ui/charts';
import { Rects, rungDraws, rungsAt } from '../src/ui/rungs';
import { arrowTurnDeg, MIN_TURN_DEG, paintWindArrow, windArrowOf, windLabel } from '../src/ui/windArrow';
import { coachRace, starRace } from './helpers';

/**
 * The Race Viewer's wind arrow (ui/windArrow.ts) turns with the wind of the moment (coach/liveWind.ts, the wind the
 * ladder rungs lie square to) on a map that stays drawn with the gun's wind at the top; only its line and head turn,
 * and only by half a degree or more. Its label reads the wind's direction to the degree; nothing has a native tooltip.
 */

/** A minimal SVG DOM: what paintWindArrow and windArrowOf touch. */
class El {
  attrs = new Map<string, string>();
  kids: El[] = [];
  textContent = '';
  sets = 0;
  finds = 0;
  constructor(
    readonly cls: string,
    readonly tag = 'g',
  ) {}
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
    this.sets++;
  }
  querySelector(sel: string): El | null {
    this.finds++;
    return this.find(sel);
  }
  private find(sel: string): El | null {
    for (const c of this.kids) {
      if (sel === `.${c.cls}` || sel === c.tag || sel === `g.map-hud g.${c.cls}`) return c;
      const d = c.find(sel);
      if (d) return d;
    }
    return null;
  }
}

/** An arrow as charts.ts windArrow draws it: its line and head turning about (100, 27), and its label. */
function arrow(): { g: El; dir: El; label: El } {
  const g = new El('wind');
  const dir = new El('wind-dir');
  const label = new El('', 'text');
  dir.attrs.set('data-cx', '100.0');
  dir.attrs.set('data-cy', '27.0');
  g.kids.push(dir, label);
  return { g, dir, label };
}

/** The turn drawn on `dir`, °. */
const turnOf = (dir: El): number => Number(/rotate\((-?[\d.]+) /.exec(dir.attrs.get('transform') ?? 'rotate(0 ')![1]);
/** Straight down the map (the arrow drawn for the gun's wind), turned clockwise on screen by `deg`. */
const arrowDir = (deg: number): Vec => {
  const r = (deg * Math.PI) / 180;
  return [-Math.sin(r), Math.cos(r)];
};

/** The arrow as drawn in `svg`: its line's top, its middle, and its label's anchor, font size and text. */
function drawnArrow(svg: string): { x: number; y: number; cx: number; cy: number; tx: number; ty: number; fs: number; text: string } {
  const g = svg.slice(svg.indexOf('<g class="wind">'));
  const mid = /data-cx="([\d.-]+)" data-cy="([\d.-]+)"><line x1="([\d.-]+)" y1="([\d.-]+)"/.exec(g)!;
  const t = /<text x="([\d.-]+)" y="([\d.-]+)" font-size="([\d.-]+)" text-anchor="end">([^<]*)<\/text><\/g>/.exec(g)!;
  return { cx: +mid[1], cy: +mid[2], x: +mid[3], y: +mid[4], tx: +t[1], ty: +t[2], fs: +t[3], text: t[4] };
}

describe('the wind arrow on a shift (Star NA race 4, the first beat)', () => {
  const { a, m } = coachRace(starRace());
  const read = ladderReader(a, m);
  const live = liveWind(m);
  const gun = a.meta.gunMs;
  const mapTwd = a.wind.twdAtGunDeg;

  it('turns with the wind of the moment, square to the rungs at two moments across the shift', () => {
    const { g, dir, label } = arrow();
    const seen: number[] = [];
    for (const t of [gun + 30_000, gun + 270_000]) {
      const now = read(t);
      const twd = now.twdDeg;
      expect(twd).toBe(live.twdAt(t));
      const p = paintWindArrow(g as unknown as Element, twd, mapTwd);
      const deg = turnOf(dir);
      expect(p.deg).toBeCloseTo(wrap180(twd - mapTwd), 9);
      expect(deg).toBeCloseTo(wrap180(twd - mapTwd), 1);
      expect(dir.attrs.get('transform')).toMatch(/ 100\.0 27\.0\)$/);
      expect(label.textContent).toBe(`wind ${Math.round(twd) % 360}° (est.)`);
      // Down the wind: the way the rung's axis points into it, reversed; and square to the rung as drawn.
      const [r] = rungsAt({ now, selected: null, mapTwdDeg: mapTwd });
      const ad = arrowDir(p.deg);
      expect(ad[0]).toBeCloseTo(-r.axis.up[0], 9);
      expect(ad[1]).toBeCloseTo(-r.axis.up[1], 9);
      const [d] = rungDraws([r], { box: { x0: -5000, y0: -5000, x1: 5000, y1: 5000 }, unit: 1, k: 1 }, { sail: (id) => id, dims: null }, new Rects());
      const along: Vec = [d.x2 - d.x1, d.y2 - d.y1];
      expect(dot(arrowDir(deg), along) / Math.hypot(...along)).toBeCloseTo(0, 2);
      seen.push(deg);
    }
    // Over 10° apart: the arrow turned with the shift, as the rungs did.
    expect(Math.abs(seen[1] - seen[0])).toBeGreaterThan(10);
  });

  it('points straight down for the gun’s wind, its label the gun’s wind, with no tooltip', () => {
    expect(arrowTurnDeg(mapTwd, mapTwd)).toBe(0);
    expect(arrowTurnDeg(NaN, mapTwd)).toBe(0);
    for (const svg of [trackMap(a, null, null, { scrub: true }), trackMap(a, null, null)]) {
      // (Two of this race's marks carry a tooltip of their own; the corners carry none.)
      const hud = svg.slice(svg.indexOf('<g class="map-hud">'));
      expect(hud).not.toContain('<title>');
      expect(hud).toMatch(/<g class="wind-dir" data-cx="[\d.-]+" data-cy="[\d.-]+"><line /);
      // The label is outside the group that turns: it stays upright.
      expect(hud.indexOf(windLabel(mapTwd))).toBeGreaterThan(hud.indexOf('</g>', hud.indexOf('wind-dir')));
      expect(drawnArrow(svg).text).toBe(`wind ${Math.round(mapTwd) % 360}° (est.)`);
    }
  });

  it('keeps its label clear of the arrow turned to any angle', () => {
    const d = drawnArrow(trackMap(a, null, null, { scrub: true }));
    const unit = d.fs / 11;
    // The arrow sweeps a circle about its middle: half its length, and half its stroke.
    const r = (d.cy - d.y) + unit;
    // The label's nearest corner to it: its right end, its baseline plus the descent of "(" and ")".
    const bottom = d.ty + 0.3 * d.fs;
    expect(d.tx).toBeLessThan(d.cx);
    expect(bottom).toBeLessThan(d.cy);
    expect(Math.hypot(d.cx - d.tx, d.cy - bottom)).toBeGreaterThan(r);
  });

  it('on the Start chart: the gun’s wind in the label, where it was beside the arrow, and no tooltip', () => {
    const svg = startSnapshot(a, null);
    // (The boats keep theirs, the facts at the gun.)
    expect(svg.slice(svg.indexOf('<g class="wind">'))).not.toContain('<title>');
    const d = drawnArrow(svg);
    expect(d.text).toBe(`wind ${Math.round(mapTwd) % 360}° (est.)`);
    // 6 screen units left of the arrow, 3 below its top, as before the arrow turned on the Race Viewer.
    const unit = d.fs / 11;
    expect(d.tx).toBeCloseTo(d.x - 6 * unit, 6);
    expect(d.ty).toBeCloseTo(d.y + 3 * unit, 6);
  });
});

describe('the wind arrow’s label', () => {
  it('reads the wind to the degree, 0–359, or no degrees with no wind known', () => {
    expect(windLabel(272.4)).toBe('wind 272° (est.)');
    expect(windLabel(359.6)).toBe('wind 0° (est.)');
    expect(windLabel(-88)).toBe('wind 272° (est.)');
    expect(windLabel(NaN)).toBe('wind (est.)');
  });
});

describe('the wind arrow from frame to frame', () => {
  it('sets nothing while the wind holds, or moves under half a degree; then just the turn', () => {
    const { g, dir, label } = arrow();
    const el = g as unknown as Element;
    // The gun's wind: drawn so already.
    label.textContent = windLabel(270);
    expect(paintWindArrow(el, 270, 270).set).toBe(0);
    expect(dir.attrs.has('transform')).toBe(false);
    expect(paintWindArrow(el, 272, 270).set).toBe(2);
    expect(dir.attrs.get('transform')).toBe('rotate(2.0 100.0 27.0)');
    expect(label.textContent).toBe('wind 272° (est.)');
    const sets = dir.sets;
    // The same wind, and a wobble under MIN_TURN_DEG: nothing set, the same elements.
    expect(paintWindArrow(el, 272, 270).set).toBe(0);
    expect(paintWindArrow(el, 272 + MIN_TURN_DEG * 0.8, 270).set).toBe(0);
    expect(paintWindArrow(el, 272 - MIN_TURN_DEG * 0.8, 270).set).toBe(0);
    expect(dir.sets).toBe(sets);
    expect(label.textContent).toBe('wind 272° (est.)');
    // Half a degree on: the turn only (still 272° to the degree).
    expect(paintWindArrow(el, 272 - MIN_TURN_DEG, 270).set).toBe(1);
    expect(turnOf(dir)).toBeCloseTo(1.5, 9);
    expect(label.textContent).toBe('wind 272° (est.)');
    // A whole degree on: the label too.
    expect(paintWindArrow(el, 270.9, 270).set).toBe(2);
    expect(label.textContent).toBe('wind 271° (est.)');
    // Across north: the short way round, and the label from 0–359.
    expect(paintWindArrow(el, 359.6, 5).deg).toBeCloseTo(-5.4, 9);
    expect(label.textContent).toBe('wind 0° (est.)');
    // Its elements were found once, on the first frame.
    expect(g.finds).toBe(2);
  });

  it('puts the live wind’s degrees on a map drawn with no wind known', () => {
    const { g, label } = arrow();
    label.textContent = windLabel(NaN);
    expect(paintWindArrow(g as unknown as Element, 272.2, NaN).set).toBe(1);
    expect(label.textContent).toBe('wind 272° (est.)');
  });

  it('finds the map’s arrow once per map, never per frame', () => {
    const svg = new El('', 'svg');
    const hud = new El('map-hud');
    const { g } = arrow();
    hud.kids.push(g);
    svg.kids.push(hud);
    const s = svg as unknown as Element;
    for (let i = 0; i < 60; i++) expect(windArrowOf(s)).toBe(g);
    expect(svg.finds).toBe(1);
    // A new map: looked up again.
    const next = new El('', 'svg');
    expect(windArrowOf(next as unknown as Element)).toBeNull();
    expect(windArrowOf(next as unknown as Element)).toBeNull();
    expect(next.finds).toBe(1);
  });
});
