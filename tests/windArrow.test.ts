import { describe, expect, it } from 'vitest';
import { dot, wrap180, type Vec } from '../src/analysis/geo';
import { ladderReader } from '../src/analysis/coach/ladderNow';
import { liveWind } from '../src/analysis/coach/liveWind';
import { trackMap } from '../src/ui/charts';
import { Rects, rungDraws, rungsAt } from '../src/ui/rungs';
import { arrowTurnDeg, MIN_TURN_DEG, paintWindArrow, windTitle } from '../src/ui/windArrow';
import { coachRace, starRace } from './helpers';

/**
 * The Race Viewer's wind arrow (ui/windArrow.ts) turns with the wind of the moment (coach/liveWind.ts, the wind the
 * ladder rungs lie square to) on a map that stays drawn with the gun's wind at the top; only its line and head turn,
 * and only by half a degree or more.
 */

/** A minimal SVG DOM: what paintWindArrow touches. */
class El {
  attrs = new Map<string, string>();
  kids: El[] = [];
  textContent = '';
  sets = 0;
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
    for (const c of this.kids) {
      if (sel === `.${c.cls}` || sel === c.tag) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
}

/** An arrow as charts.ts windArrow draws it: its tooltip, and its line and head turning about (100, 27). */
function arrow(): { g: El; dir: El; title: El } {
  const g = new El('wind');
  const title = new El('', 'title');
  const dir = new El('wind-dir');
  dir.attrs.set('data-cx', '100.0');
  dir.attrs.set('data-cy', '27.0');
  g.kids.push(title, dir);
  return { g, dir, title };
}

/** The turn drawn on `dir`, °. */
const turnOf = (dir: El): number => Number(/rotate\((-?[\d.]+) /.exec(dir.attrs.get('transform') ?? 'rotate(0 ')![1]);
/** Straight down the map (the arrow drawn for the gun's wind), turned clockwise on screen by `deg`. */
const arrowDir = (deg: number): Vec => {
  const r = (deg * Math.PI) / 180;
  return [-Math.sin(r), Math.cos(r)];
};

describe('the wind arrow on a shift (Star NA race 4, the first beat)', () => {
  const { a, m } = coachRace(starRace());
  const read = ladderReader(a, m);
  const live = liveWind(m);
  const gun = a.meta.gunMs;
  const mapTwd = a.wind.twdAtGunDeg;

  it('turns with the wind of the moment, square to the rungs at two moments across the shift', () => {
    const { g, dir, title } = arrow();
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
      expect(title.textContent).toBe(`Wind from ${Math.round(twd) % 360}° (est.)`);
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

  it('points straight down for the gun’s wind, with the gun’s wind in its tooltip', () => {
    expect(arrowTurnDeg(mapTwd, mapTwd)).toBe(0);
    expect(arrowTurnDeg(NaN, mapTwd)).toBe(0);
    const svg = trackMap(a, null, null, { scrub: true });
    const hud = svg.slice(svg.indexOf('<g class="map-hud">'));
    expect(hud).toContain(`<title>${windTitle(mapTwd)}</title>`);
    expect(hud).toMatch(/<g class="wind-dir" data-cx="[\d.-]+" data-cy="[\d.-]+"><line /);
    // The label is outside the group that turns: it stays upright.
    expect(hud.indexOf('wind (est.)')).toBeGreaterThan(hud.indexOf('</g>', hud.indexOf('wind-dir')));
  });
});

describe('the wind arrow from frame to frame', () => {
  it('sets nothing while the wind holds, or moves under half a degree; then just the turn', () => {
    const { g, dir, title } = arrow();
    const el = g as unknown as Element;
    // The gun's wind: drawn so already.
    expect(paintWindArrow(el, 270, 270).set).toBe(0);
    expect(dir.attrs.has('transform')).toBe(false);
    title.textContent = windTitle(270);
    expect(paintWindArrow(el, 272, 270).set).toBe(2);
    expect(dir.attrs.get('transform')).toBe('rotate(2.0 100.0 27.0)');
    expect(title.textContent).toBe('Wind from 272° (est.)');
    const sets = dir.sets;
    // The same wind, and a wobble under MIN_TURN_DEG: nothing set, the same elements.
    expect(paintWindArrow(el, 272, 270).set).toBe(0);
    expect(paintWindArrow(el, 272 + MIN_TURN_DEG * 0.8, 270).set).toBe(0);
    expect(paintWindArrow(el, 272 - MIN_TURN_DEG * 0.8, 270).set).toBe(0);
    expect(dir.sets).toBe(sets);
    expect(g.querySelector('.wind-dir')).toBe(dir);
    // Half a degree on: the turn only (still 272° to the degree).
    expect(paintWindArrow(el, 272 - MIN_TURN_DEG, 270).set).toBe(1);
    expect(turnOf(dir)).toBeCloseTo(1.5, 9);
    expect(title.textContent).toBe('Wind from 272° (est.)');
    // Across north: the short way round, and the tooltip from 0–359.
    expect(paintWindArrow(el, 359.6, 5).deg).toBeCloseTo(-5.4, 9);
    expect(title.textContent).toBe('Wind from 0° (est.)');
  });
});
