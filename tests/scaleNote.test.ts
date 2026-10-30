import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { startReplays } from '../src/analysis/startReplay';
import { classDims } from '../src/data/classes';
import { BOAT_SHAPE_PX, scaleNoteText } from '../src/ui/boatShape';
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
    expect(scaleNoteText(J70, at(9.2))).toBe('Boats drawn about 9× actual size');
    expect(scaleNoteText(J70, at(2.3))).toBe('Boats drawn about 2× actual size');
    expect(scaleNoteText(J70, at(1.96))).toBe('Boats drawn about 2× actual size');
    expect(scaleNoteText(J70, at(1.46))).toBe('Boats drawn about 1.5× actual size');
    expect(scaleNoteText(J70, at(1.1))).toBe('Boats drawn about 1.1× actual size');
    expect(scaleNoteText(J70, at(1.04))).toBeNull();
    expect(scaleNoteText(J70, at(1))).toBeNull();
    // To scale (longer than the symbol on screen), no class, no size on screen.
    expect(scaleNoteText(J70, at(0.5))).toBeNull();
    expect(scaleNoteText(null, 0.01)).toBeNull();
    expect(scaleNoteText(J70, 0)).toBeNull();
  });

  it('one note for every boat, the selected one included: nothing at true scale', () => {
    expect(scaleNoteText(J70, at(3.2))).toBe('Boats drawn about 3× actual size');
    // Just past the symbol's size, and well past it: to scale, nothing said.
    expect(scaleNoteText(J70, at(1.02))).toBeNull();
    expect(scaleNoteText(J70, BOAT_SHAPE_PX / J70.loaM)).toBeNull();
    expect(scaleNoteText(J70, (BOAT_SHAPE_PX / J70.loaM) * 1.3)).toBeNull();
    for (const f of [9.2, 2.3, 1.46, 1.1, 1.02, 0.96]) expect(scaleNoteText(J70, at(f)) ?? '').not.toMatch(/[Ss]elected/);
  });
});

describe('J/70 NAs R2 on the Race Viewer (Fit ~3209 m across, a 1050 css px desktop card)', () => {
  // The race's Fit viewBox width at a 1280 px viewport, measured; the card's SVG draws it across 1050 css px.
  const FIT_M = 3209;
  const CARD_PX = 1050;
  const pxPerM = (k: number): number => (CARD_PX * k) / FIT_M;
  const factor = (k: number): number => BOAT_SHAPE_PX / (J70.loaM * pxPerM(k));

  it('Fit: a 2.3 px J/70, 4×: 9.1 px, the 8× preset: 18 px; said as BOAT_SHAPE_PX over that, nothing once to scale', () => {
    expect(J70.loaM * pxPerM(1)).toBeCloseTo(2.27, 2);
    expect(J70.loaM * pxPerM(4)).toBeCloseTo(9.08, 2);
    // Whole numbers from 2×, one decimal below, nothing once it rounds to 1×.
    const said = (f: number): string | null => {
      const r = Math.round(f * 10) / 10;
      return r > 1 ? `Boats drawn about ${r >= 2 ? Math.round(f) : r.toFixed(1)}× actual size` : null;
    };
    for (const k of [1, 2, 4]) expect(scaleNoteText(J70, pxPerM(k))).toBe(said(factor(k)));
    expect(scaleNoteText(J70, pxPerM(1))).toBe(`Boats drawn about ${Math.round(factor(1))}× actual size`);
    // As said at the size chosen (10 px): 4.4× at Fit, 1.1× at 4×.
    if (BOAT_SHAPE_PX === 10) {
      expect(scaleNoteText(J70, pxPerM(1))).toBe('Boats drawn about 4× actual size');
      expect(scaleNoteText(J70, pxPerM(4))).toBe('Boats drawn about 1.1× actual size');
    }
    // 8×: an 18 px J/70, longer than the symbol.
    expect(J70.loaM * pxPerM(8)).toBeGreaterThan(BOAT_SHAPE_PX);
    expect(scaleNoteText(J70, pxPerM(8))).toBeNull();
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
      const want = scaleNoteText(dims, 1 / pxOf(v, scr));
      const n = noteOf(trackMap(a, null, null, { scrub: true, view: v, screen: scr }));
      expect(n?.text ?? null).toBe(want);
      if (want) said++;
    }
    expect(said).toBeGreaterThan(0);
    // At Fit on the card the hulls are well past scale: a whole number.
    expect(noteOf(trackMap(a, null, null, { scrub: true, screen: scr }))!.text).toMatch(/^Boats drawn about \d+× actual size$/);
  });

  it('hidden once the hulls are to scale on screen, a boat selected or not; the same words either way; never on the static map', () => {
    const scr = { w: 1050, h: 600 };
    const id = a.boats[0].id;
    // At Fit: the same note with a boat selected.
    const fitNote = noteOf(trackMap(a, null, null, { scrub: true, screen: scr }))!.text;
    expect(noteOf(trackMap(a, id, null, { scrub: true, screen: scr }))!.text).toBe(fitNote);
    expect(fitNote).not.toMatch(/[Ss]elected/);
    // Zoomed all the way in on this big course: a J/70 12.5 px long, to scale.
    const v = centre(K_MAX);
    const len = dims.loaM / pxOf(v, scr);
    expect(len).toBeGreaterThanOrEqual(BOAT_SHAPE_PX);
    expect(noteOf(trackMap(a, null, null, { scrub: true, view: v, screen: scr }))).toBeNull();
    expect(noteOf(trackMap(a, id, null, { scrub: true, view: v, screen: scr }))).toBeNull();
    expect(noteOf(trackMap(a, null, null, { view: fitView(fit), screen: scr }))).toBeNull();
  });

  it('a phone (390 css px): fits the map’s width, stacked above the scale bar where it can’t sit beside it', () => {
    for (const scr of [
      { w: 390, h: 300 },
      { w: 390, h: 700 },
    ]) {
      const svg = trackMap(a, null, null, { scrub: true, screen: scr });
      const n = noteOf(svg)!;
      expect(n.text).toBe(scaleNoteText(dims, 1 / pxOf(fitView(fit), scr)));
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
    const want = scaleNoteText(dims, ppu);
    expect(want).not.toBeNull();
    expect(noteOf(laneScrubHtml(a, L, 0, ppu))?.text).toBe(want);
    const k = Math.ceil(BOAT_SHAPE_PX / (dims.loaM * ppu)) + 1;
    const cx = (L.view.x0 + L.view.x1) / 2;
    const cy = (L.view.y0 + L.view.y1) / 2;
    expect(noteOf(laneScrubHtml(a, L, 0, ppu, false, { cx, cy, k }))).toBeNull();
  });
});
