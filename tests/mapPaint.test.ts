import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { boatsAt, mapBox, scrubFrame, trackMap, trackMapView } from '../src/ui/charts';
import { MAP_SLOW_MS, mapPaint } from '../src/ui/mapPaint';
import { scrubWindow, trailWindow } from '../src/ui/scrub';
import { clampView, type View } from '../src/ui/view';
import { j105Race } from './helpers';

/**
 * The track map's redraws (mapPaint.ts): the follow camera's pans during play move only the viewBox (never the full
 * redraw, the map's innerHTML), a zoom change redraws, and a pause redraws once; what a pan leaves unchanged (line
 * widths, text sizes, label offsets) and what it shifts (the scale bar and wind arrow, `g.map-hud`).
 */
function paintHost(drawMs = 5) {
  let view: View = { cx: 0, cy: 0, k: 4 };
  const frames: (() => void)[] = [];
  const timers = new Map<number, () => void>();
  let id = 0;
  let renders = 0;
  const moves: (View | null)[] = [];
  const p = mapPaint({
    render: () => {
      renders++;
      p.rendered(view);
    },
    move: (drawn) => moves.push(drawn),
    drawMs: () => drawMs,
    view: () => view,
    raf: (f) => frames.push(f),
    setTimer: (f) => {
      timers.set(++id, f);
      return id;
    },
    clearTimer: (i) => timers.delete(i),
  });
  p.rendered(view);
  return {
    p,
    set: (v: Partial<View>) => (view = { ...view, ...v }),
    view: () => view,
    /** Run the queued animation frame(s). */
    frame: () => frames.splice(0).forEach((f) => f()),
    /** Let the view rest: the pending timer(s) fire. */
    rest: () => {
      const fs = [...timers.values()];
      timers.clear();
      fs.forEach((f) => f());
    },
    timers: () => [...timers.keys()],
    renders: () => renders,
    moves,
  };
}

describe('the track map while following: pans move the viewBox, a zoom change redraws', () => {
  it('play: 120 follow pans never redraw the map; a wheel zoom does (once); the pause redraws once', () => {
    const h = paintHost();
    const drawn = h.view();
    for (let i = 1; i <= 120; i++) {
      h.set({ cx: i });
      h.p.follow(true);
      h.frame();
    }
    expect(h.renders()).toBe(0);
    expect(h.moves).toHaveLength(120);
    // Each move knows the view drawn (the same zoom): the scale bar and wind arrow shift by the pan from it.
    expect(h.moves.every((d) => d === drawn)).toBe(true);
    expect(h.timers()).toEqual([]);
    // A wheel zoom during play: redrawn on the next frame, once, however many follow pans come before it.
    h.set({ k: 5 });
    h.p.gesture();
    h.p.follow(true);
    h.p.follow(true);
    h.frame();
    expect(h.renders()).toBe(1);
    for (let i = 1; i <= 30; i++) {
      h.set({ cx: 200 + i });
      h.p.follow(true);
    }
    expect(h.renders()).toBe(1);
    // Paused: one redraw so everything is exact at rest; another pause with no pan since: none.
    h.p.settle();
    expect(h.renders()).toBe(2);
    h.p.settle();
    expect(h.renders()).toBe(2);
  });

  it('paused (the slider, ‹ ›): a follow pan moves the viewBox now and redraws once the view rests', () => {
    const h = paintHost();
    h.set({ cx: 10 });
    h.p.follow(false);
    h.set({ cx: 20 });
    h.p.follow(false);
    expect(h.moves).toHaveLength(2);
    expect(h.renders()).toBe(0);
    expect(h.timers()).toHaveLength(1);
    h.rest();
    expect(h.renders()).toBe(1);
  });

  it('a slow fleet: a wheel zoom moves the viewBox and waits to rest; follow pans during play keep that wait, not restart it', () => {
    const h = paintHost(MAP_SLOW_MS + 30);
    h.set({ k: 6 });
    h.p.gesture();
    h.frame();
    expect(h.renders()).toBe(0);
    // Zoomed since the drawing: no shift for the scale bar (its length is the old zoom's until the redraw).
    expect(h.moves).toEqual([null]);
    const wait = h.timers();
    expect(wait).toHaveLength(1);
    for (let i = 1; i <= 10; i++) {
      h.set({ cx: i });
      h.p.follow(true);
    }
    expect(h.timers()).toEqual(wait);
    expect(h.renders()).toBe(0);
    h.rest();
    expect(h.renders()).toBe(1);
    // Drawn at 6×: follow pans move again, with the shift.
    h.set({ cx: 50 });
    h.p.follow(true);
    expect(h.moves.at(-1)).toEqual({ cx: 10, cy: 0, k: 6 });
    expect(h.renders()).toBe(1);
  });
});

describe('the track map: a pan at the same zoom changes no size, only the scale bar and wind arrow’s place', () => {
  const a = analyzeRace(j105Race(1));
  const ME = 'USA 527';
  const fit = mapBox(a, null);
  const t = a.meta.gunMs + 480_000;
  const me = boatsAt(a, ME, t).find((b) => b.id === ME)!;
  const v1 = clampView(fit, { cx: me.mx, cy: me.my, k: 4 });
  const v2 = clampView(fit, { cx: me.mx + (fit.x1 - fit.x0) / 40, cy: me.my - (fit.y1 - fit.y0) / 60, k: 4 });
  const sizes = (svg: string): string[] => [...svg.matchAll(/(stroke-width|font-size| r)="([-\d.]+)"/g)].map((m) => `${m[1]}=${m[2]}`);

  it('the static map: the same line widths, text and mark sizes; the scale bar, wind arrow and not-to-scale note shifted by exactly the pan', () => {
    expect(v2.cx).not.toBe(v1.cx);
    const s1 = trackMap(a, ME, null, { view: v1, scrub: true });
    const s2 = trackMap(a, ME, null, { view: v2, scrub: true });
    expect(s1).toContain('<g class="map-hud"><g class="wind">');
    expect(sizes(s1)).toEqual(sizes(s2));
    // "Boats not to scale" in the HUD too, moved with it.
    expect(s1).toContain('>Boats not to scale</text></g></svg>');
    const hud = (s: string): number[] => [.../<g class="map-hud">[\s\S]*?<\/svg>/.exec(s)![0].matchAll(/ (?:x|x1)="([-\d.]+)"/g)].map((m) => Number(m[1]));
    const b1 = trackMapView(a, null, v1).view;
    const b2 = trackMapView(a, null, v2).view;
    const dx = hud(s2).map((x, i) => x - hud(s1)[i]);
    expect(dx.length).toBeGreaterThan(2);
    for (const d of dx) expect(d).toBeCloseTo(b2.x0 - b1.x0, 6);
  });

  it('the boats and labels drawn each frame: the same sizes in either view', () => {
    const win = trailWindow(t, '30', scrubWindow(a));
    const d1 = scrubFrame(a, ME, null, { view: v1 }, { t, win }).dots;
    const d2 = scrubFrame(a, ME, null, { view: v2 }, { t, win }).dots;
    expect(d1).toContain('class="dot-lbl on"');
    expect(sizes(d1)).toEqual(sizes(d2));
  });
});
