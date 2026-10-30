import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { startReplays } from '../src/analysis/startReplay';
import { classDims } from '../src/data/classes';
import { BOAT_SHAPE_ON_PX, BOAT_SHAPE_PX, scaleNoteText } from '../src/ui/boatShape';
import { mapBox, startClass, trackMap, trackMapView } from '../src/ui/charts';
import { laneScrub } from '../src/ui/laneSnapshots';
import { laneScrubHtml, lanePxPerUnit } from '../src/ui/laneSnapshotsView';
import { textWidth } from '../src/ui/labels';
import { clampView, fitView, K_MAX, type View } from '../src/ui/view';
import { cascaisRace, ic37Race } from './helpers';

const J70 = classDims('J/70')!;
/** Css px per meter at which the fleet's symbol is drawn `f` times a J/70's real size. */
const at = (f: number): number => BOAT_SHAPE_PX / (J70.loaM * f);
const noteOf = (svg: string): { x: number; y: number; fs: number; text: string } | null => {
  const m = /<text class="scale-note" x="([-\d.]+)" y="([-\d.]+)" font-size="([\d.]+)"[^>]*>([^<]+)<\/text>/.exec(svg);
  return m ? { x: Number(m[1]), y: Number(m[2]), fs: Number(m[3]), text: m[4] } : null;
};

describe('scaleNoteText: how much bigger than scale the boats are drawn', () => {
  it('whole numbers from 2×, one decimal below, hidden once it rounds to 1×', () => {
    expect(J70.loaM).toBe(6.934);
    expect(scaleNoteText(J70, at(9.2), false)).toBe('Boats drawn about 9× actual size');
    expect(scaleNoteText(J70, at(2.3), false)).toBe('Boats drawn about 2× actual size');
    expect(scaleNoteText(J70, at(1.96), false)).toBe('Boats drawn about 2× actual size');
    expect(scaleNoteText(J70, at(1.46), false)).toBe('Boats drawn about 1.5× actual size');
    expect(scaleNoteText(J70, at(1.1), false)).toBe('Boats drawn about 1.1× actual size');
    expect(scaleNoteText(J70, at(1.04), false)).toBeNull();
    expect(scaleNoteText(J70, at(1), false)).toBeNull();
    // To scale (longer than the symbol on screen), no class, no size on screen.
    expect(scaleNoteText(J70, at(0.5), false)).toBeNull();
    expect(scaleNoteText(null, 0.01, true)).toBeNull();
    expect(scaleNoteText(J70, 0, false)).toBeNull();
  });

  it('the fleet to scale but the selected boat’s bigger symbol enlarged: says so of the selected boat', () => {
    // Fleet at 1.02× (said as 1×: hidden); the selected boat's 15 px symbol 1.275×.
    expect(scaleNoteText(J70, at(1.02), false)).toBeNull();
    expect(scaleNoteText(J70, at(1.02), true)).toBe('Selected boat drawn about 1.3× actual size');
    expect(scaleNoteText(J70, at(0.96), true)).toBe('Selected boat drawn about 1.2× actual size');
    // The fleet enlarged too: the fleet's factor, whatever is selected.
    expect(scaleNoteText(J70, at(3.2), true)).toBe('Boats drawn about 3× actual size');
    // At true scale for the selected boat too: nothing.
    expect(scaleNoteText(J70, BOAT_SHAPE_ON_PX / J70.loaM, true)).toBeNull();
    expect(scaleNoteText(J70, (BOAT_SHAPE_ON_PX / J70.loaM) * 1.01, true)).toBeNull();
  });
});

describe('J/70 NAs R2 on the Race Viewer (Fit ~3209 m across, a 1050 css px desktop card)', () => {
  // The race's Fit viewBox width at a 1280 px viewport, measured; the card's SVG draws it across 1050 css px.
  const FIT_M = 3209;
  const CARD_PX = 1050;
  const pxPerM = (k: number): number => (CARD_PX * k) / FIT_M;
  const factor = (k: number): number => BOAT_SHAPE_PX / (J70.loaM * pxPerM(k));

  it('Fit: about 5×; 4×: about 1.3×; the 8× preset: to scale, nothing said', () => {
    expect(factor(1)).toBeCloseTo(5.29, 2);
    expect(scaleNoteText(J70, pxPerM(1), false)).toBe(`Boats drawn about ${Math.round(factor(1))}× actual size`);
    expect(scaleNoteText(J70, pxPerM(1), false)).toBe('Boats drawn about 5× actual size');
    expect(factor(4)).toBeCloseTo(1.32, 2);
    expect(scaleNoteText(J70, pxPerM(4), false)).toBe(`Boats drawn about ${(Math.round(factor(4) * 10) / 10).toFixed(1)}× actual size`);
    expect(scaleNoteText(J70, pxPerM(4), false)).toBe('Boats drawn about 1.3× actual size');
    // 8×: an 18 px J/70, longer than either symbol.
    expect(J70.loaM * pxPerM(8)).toBeGreaterThan(BOAT_SHAPE_ON_PX);
    expect(scaleNoteText(J70, pxPerM(8), false)).toBeNull();
    expect(scaleNoteText(J70, pxPerM(8), true)).toBeNull();
  });
});

describe('the Race Viewer map measures the note on screen (Cascais R3, J/70s)', () => {
  const a = analyzeRace(cascaisRace('r3'));
  const dims = startClass(a)!.dims;
  const fit = mapBox(a, null);
  const centre = (k: number): View => clampView(fit, { cx: (fit.x0 + fit.x1) / 2, cy: (fit.y0 + fit.y1) / 2, k });
  const pxOf = (v: View, scr: { w: number; h: number }): number => {
    const { view } = trackMapView(a, null, v);
    return Math.max((view.x1 - view.x0) / scr.w, (view.y1 - view.y0) / scr.h);
  };

  it('says the factor for the card’s size at Fit, 4× and 8×, from the view drawn "meet" into it', () => {
    const scr = { w: 1050, h: 600 };
    let said = 0;
    for (const v of [fitView(fit), centre(4), centre(8)]) {
      const want = scaleNoteText(dims, 1 / pxOf(v, scr), false);
      const n = noteOf(trackMap(a, null, null, { scrub: true, view: v, screen: scr }));
      expect(n?.text ?? null).toBe(want);
      if (want) said++;
    }
    expect(said).toBeGreaterThan(0);
    // At Fit on the card the hulls are well past scale: a whole number.
    expect(noteOf(trackMap(a, null, null, { scrub: true, screen: scr }))!.text).toMatch(/^Boats drawn about \d+× actual size$/);
  });

  it('hidden once the hulls are to scale on screen; the selected boat’s bigger symbol said alone; never on the static map', () => {
    const scr = { w: 1050, h: 600 };
    // Zoomed all the way in on this big course: a J/70 12.5 px long, the fleet to scale, the selected boat's 15 px symbol not.
    const v = centre(K_MAX);
    const len = dims.loaM / pxOf(v, scr);
    expect(len).toBeGreaterThanOrEqual(BOAT_SHAPE_PX);
    expect(len).toBeLessThan(BOAT_SHAPE_ON_PX);
    expect(noteOf(trackMap(a, null, null, { scrub: true, view: v, screen: scr }))).toBeNull();
    const id = a.boats[0].id;
    expect(noteOf(trackMap(a, id, null, { scrub: true, view: v, screen: scr }))!.text).toBe(
      `Selected boat drawn about ${(Math.round((BOAT_SHAPE_ON_PX / len) * 10) / 10).toFixed(1)}× actual size`,
    );
    // A wider screen at that zoom: the selected boat to scale too, nothing said.
    const big = { w: 1050 * (BOAT_SHAPE_ON_PX / len) * 1.1, h: 600 * (BOAT_SHAPE_ON_PX / len) * 1.1 };
    expect(noteOf(trackMap(a, id, null, { scrub: true, view: v, screen: big }))).toBeNull();
    expect(noteOf(trackMap(a, null, null, { view: fitView(fit), screen: scr }))).toBeNull();
  });

  it('a phone (390 css px): fits the map’s width, stacked above the scale bar where it can’t sit beside it', () => {
    for (const scr of [
      { w: 390, h: 300 },
      { w: 390, h: 700 },
    ]) {
      const svg = trackMap(a, null, null, { scrub: true, screen: scr });
      const n = noteOf(svg)!;
      expect(n.text).toBe(scaleNoteText(dims, 1 / pxOf(fitView(fit), scr), false));
      const { view } = trackMapView(a, null);
      const x0 = n.x - textWidth(n.text, n.fs);
      expect(x0).toBeGreaterThanOrEqual(view.x0);
      expect(n.x).toBeLessThanOrEqual(view.x1);
      // Clear of the scale bar and its label.
      const bar = /<g class="scalebar"><line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)"[\s\S]*?y="([-\d.]+)" font-size="([\d.]+)"/.exec(svg)!;
      const [bx0, by, bx1, ly, bfs] = [1, 2, 3, 4, 5].map((i) => Number(bar[i]));
      const side = x0 > bx1;
      const above = n.y + 0.3 * n.fs < ly - bfs;
      expect(side || above).toBe(true);
      expect(bx0).toBeLessThan(bx1);
      expect(by).toBeGreaterThan(ly);
    }
  });
});

describe('Start Playback: the note says the factor at Fit and goes at true scale (IC37 R5)', () => {
  const data = ic37Race();
  const a = analyzeRace(data);
  const dims = startClass(a)!.dims;
  const L = laneScrub(a, { me: null, replays: startReplays(a, data) });
  const ppu = lanePxPerUnit(L.view);

  it('the factor at Fit, nothing once a hull is longer than the symbol', () => {
    const want = scaleNoteText(dims, ppu, false);
    expect(want).not.toBeNull();
    expect(noteOf(laneScrubHtml(a, L, 0, ppu))?.text).toBe(want);
    const k = Math.ceil(BOAT_SHAPE_ON_PX / (dims.loaM * ppu)) + 1;
    const cx = (L.view.x0 + L.view.x1) / 2;
    const cy = (L.view.y0 + L.view.y1) / 2;
    expect(noteOf(laneScrubHtml(a, L, 0, ppu, false, { cx, cy, k }))).toBeNull();
  });
});
