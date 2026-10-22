import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { awayFromLineThresholdM, biasAngle, biasSensitivityM, lineBias, windSource } from '../src/analysis/line';
import type { RaceAnalysis, WindInfo } from '../src/analysis/types';
import { startKey } from '../src/ui/captions';
import { rotator, startClass, startFitBox, startScale, startSnapshot } from '../src/ui/charts';
import {
  FAV_GAP_PX,
  FAV_OFFSET_PX,
  alongLabelBox,
  alongLineLabel,
  biasBasis,
  biasBullets,
  lineChips,
  windChip,
  favouredText,
  favouredTexts,
  lineExtensions,
} from '../src/ui/startLine';
import { fitView } from '../src/ui/view';
import { c31Race, fixtureRace, j88Race, m24Race } from './helpers';

const line = (bearingDeg: number, lengthM = 100) => ({ bearingDeg, lengthM });

describe('lineBias', () => {
  it('is square when the line runs TWD + 90', () => {
    const b = lineBias(line(90), 0);
    expect(b.biasDeg).toBeCloseTo(0, 9);
    expect(b.byM).toBeCloseTo(0, 9);
    expect(b.favored).toBe('square');
  });

  it('favours the pin when the pin end is upwind (+ bias)', () => {
    // Wind from north; pin → RC heading 100°: the pin end sits further north.
    const b = lineBias(line(100), 0);
    expect(b.biasDeg).toBeCloseTo(10, 9);
    expect(b.favored).toBe('left');
    expect(b.byM).toBeCloseTo(100 * Math.sin((10 * Math.PI) / 180), 9);
  });

  it('favours the RC when the RC end is upwind (− bias)', () => {
    const b = lineBias(line(75), 0);
    expect(b.biasDeg).toBeCloseTo(-15, 9);
    expect(b.favored).toBe('right');
    expect(b.byM).toBeCloseTo(100 * Math.sin((15 * Math.PI) / 180), 9);
  });

  it('wraps around north', () => {
    expect(lineBias(line(85), 355).biasDeg).toBeCloseTo(0, 9);
    expect(lineBias(line(80), 5).biasDeg).toBeCloseTo(-15, 9);
    expect(lineBias(line(2), 270).biasDeg).toBeCloseTo(2, 9);
    expect(lineBias(line(358), 275).biasDeg).toBeCloseTo(-7, 9);
    expect(lineBias(line(358), 275).favored).toBe('right');
  });

  it('calls a line within 2 m square', () => {
    expect(lineBias(line(91, 100), 0).favored).toBe('square'); // 1.7 m
    expect(lineBias(line(91.2, 100), 0).favored).toBe('left'); // 2.1 m
  });

  it('reads a reversed line as degrees off square', () => {
    expect(biasAngle(lineBias(line(260), 0))).toBeCloseTo(10, 9);
  });

  it('gives the sensitivity to a 5° wind error', () => {
    expect(biasSensitivityM(100)).toBeCloseTo(8.72, 2);
  });
});

const fixtures: [string, RaceAnalysis][] = [
  ['Benelux J70 r8', analyzeRace(fixtureRace())],
  ['C31 Gold Cup r10', analyzeRace(c31Race())],
  ['Melges 24 Worlds r4', analyzeRace(m24Race())],
  ['J/88 NA r5', analyzeRace(j88Race())],
];

describe.each(fixtures)('%s', (_name, a) => {
  it('agrees with analyze.ts favoredByM and favoured end', () => {
    const b = lineBias(a.line, a.wind.twdAtGunDeg);
    expect(b.byM).toBeCloseTo(a.line.favoredByM, 6);
    expect(b.favored).toBe(a.line.favored);
  });

  it('draws dashed extensions past both ends and labels the favoured end', () => {
    const svg = startSnapshot(a, null);
    const ext = [...svg.matchAll(/<line class="line-ext" data-end="(pin|rc)"[^>]*stroke-dasharray/g)].map((m) => m[1]);
    expect(ext).toEqual(['pin', 'rc']);
    // Under the boats: before the first boat group.
    expect(svg.indexOf('line-ext')).toBeLessThan(svg.indexOf('class="boat'));
    const fav = /<text class="fav-lbl"[^>]*><title>([^<]+)<\/title>([^<]+)<\/text>/.exec(svg)!;
    expect(fav).not.toBeNull();
    // At Fit the "(n lengths)" part is dropped to fit the extension; zoomed in it comes back.
    expect(fav[2]).toBe(favouredTexts(a, startClass(a)!.dims)[1]);
    expect(fav[2]).toMatch(/^(Pin|RC) favoured \d+° · \d+ m$/);
    expect(fav[1]).toContain('±5° of wind ≈ ±');
    const zoomed = startSnapshot(a, null, { ...fitView(startFitBox(a)), k: 4 });
    expect(zoomed).toContain(`>${favouredText(a, startClass(a)!.dims)}</text>`);
  });

  it('runs the label along the favoured extension, rotated, past the end mark and just above the line', () => {
    const svg = startSnapshot(a, null);
    const m = /<text class="fav-lbl" x="([-\d.]+)" y="([-\d.]+)" transform="rotate\(([-\d.]+) ([-\d.]+) ([-\d.]+)\)"[^>]*text-anchor="(start|end|middle)"/.exec(svg)!;
    expect(m).not.toBeNull();
    const [x, y, rot] = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(rot).toBeGreaterThan(-90);
    expect(rot).toBeLessThanOrEqual(90);
    expect(Number(m[4])).toBe(x);
    expect(Number(m[5])).toBe(y);
    // Along the extension: the label point projects past the favoured end, by at least the gap, toward the tip.
    const rotr = rotator(a.wind.twdAtGunDeg);
    const [L, R] = [rotr(a.line.left), rotr(a.line.right)];
    const [end, other] = a.line.favored === 'left' ? [L, R] : [R, L];
    const len = Math.hypot(end[0] - other[0], end[1] - other[1]);
    const u = [(end[0] - other[0]) / len, (end[1] - other[1]) / len];
    const unit = Number(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/.exec(svg)![1]) / 600;
    const past = (x - end[0]) * u[0] + (y - end[1]) * u[1];
    // (coordinates are written to 0.1)
    expect(past).toBeGreaterThanOrEqual(FAV_GAP_PX * unit - 0.1);
    // Just off the line, on the screen-up side.
    const perp = (x - end[0]) * -u[1] + (y - end[1]) * u[0];
    expect(Math.abs(Math.abs(perp) - FAV_OFFSET_PX * unit)).toBeLessThan(0.1);
    expect(y).toBeLessThan(end[1] + (x - end[0]) * (u[1] / (u[0] || 1e-9)));
  });
});

describe('favoured end text', () => {
  const [, j70] = fixtures[0];
  const [, c31] = fixtures[1];
  const [, j88] = fixtures[3];

  it('names the end, degrees, metres and lengths', () => {
    expect(favouredText(j70, { loaM: 6.934, beamM: 2.249 })).toMatch(/^Pin favoured \d+° · 19 m \(2\.7 lengths\)$/);
    expect(favouredText(j70, null)).toMatch(/^Pin favoured \d+° · 19 m$/);
    expect(favouredText(j88, null)).toMatch(/^RC favoured \d+° · 2 m$/);
    expect(startSnapshot(c31, null)).toMatch(/>Pin favoured \d+° · 42 m<\/text>/);
    expect(startSnapshot(c31, null, { ...fitView(startFitBox(c31)), k: 2 })).toMatch(/>Pin favoured \d+° · 42 m \(4\.3 lengths\)<\/text>/);
    expect(favouredTexts(c31, null)).toEqual([
      expect.stringMatching(/^Pin favoured \d+° · 42 m$/),
      expect.stringMatching(/^Pin fav\. \d+° · 42 m$/),
      expect.stringMatching(/^Pin \d+° · 42 m$/),
      expect.stringMatching(/^Pin \d+°$/),
    ]);
  });

  it('says Square line within the threshold, centred along the line', () => {
    const sq = { ...j70, line: { ...j70.line, bearingDeg: j70.wind.twdAtGunDeg + 90.5 } };
    expect(favouredText(sq, null)).toBe('Square line');
    const svg = startSnapshot(sq, null);
    expect(svg).toMatch(/<text class="fav-lbl"[^>]*transform="rotate\([-\d.]+ [-\d.]+ [-\d.]+\)"[^>]*text-anchor="middle"[^>]*><title>[^<]+<\/title>Square line<\/text>/);
  });

  it('stays the same size on screen at every zoom, and shortens on a phone rather than overrun', () => {
    const size = (svg: string): number => {
      const vbW = Number(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/.exec(svg)![1]);
      return Number(/class="fav-lbl"[^>]*font-size="([\d.]+)"/.exec(svg)![1]) / (vbW / 600);
    };
    const fit = fitView(startFitBox(j70));
    const sizes = [1, 2, 4, 8].map((k) => size(startSnapshot(j70, null, { ...fit, k })));
    // Same on-screen size at every zoom (the font size is written to 0.01 chart units, ~2% at 8×).
    for (const s of sizes) expect(Math.abs(s / 8.5 - 1)).toBeLessThan(0.03);
  });

  it.each([
    ['J/70', j70],
    ['C31', c31],
  ])('%s on a 390 px phone: on the extension, a shorter wording with the metres, inside the frame', (_n, a) => {
    const svg = startSnapshot(a, null, undefined, 'boat', { widthPx: 390 });
    const m = /<text class="fav-lbl" x="([-\d.]+)" y="([-\d.]+)" transform="rotate\(([-\d.]+)[^"]*\)" font-size="([\d.]+)"[^>]*text-anchor="(start|end)"><title>[^<]+<\/title>([^<]+)<\/text>/.exec(svg)!;
    expect(m).not.toBeNull();
    const [x, y, rot, fs, anchor, text] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), m[5], m[6]];
    const texts = favouredTexts(a, startClass(a)!.dims);
    // Not the full wording (no room on a phone), but one that keeps the metres.
    expect(texts.slice(1, -1)).toContain(text);
    expect(text).toMatch(/· \d+ m$/);
    // On the extension: past the favoured end, away from the other end.
    const rotr = rotator(a.wind.twdAtGunDeg);
    const [L, R] = [rotr(a.line.left), rotr(a.line.right)];
    const [end, other] = a.line.favored === 'left' ? [L, R] : [R, L];
    const len = Math.hypot(end[0] - other[0], end[1] - other[1]);
    const u = [(end[0] - other[0]) / len, (end[1] - other[1]) / len];
    const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg)!.slice(1).map(Number);
    const unit = vb[2] / 600;
    expect((x - end[0]) * u[0] + (y - end[1]) * u[1]).toBeGreaterThanOrEqual(FAV_GAP_PX * unit - 0.1);
    // The whole text stays inside the chart frame.
    const w = text.length * 0.6 * fs;
    const r = (rot * Math.PI) / 180;
    const sgn = anchor === 'start' ? 1 : -1;
    const far = [x + sgn * Math.cos(r) * w, y + sgn * Math.sin(r) * w];
    expect(far[0]).toBeGreaterThanOrEqual(vb[0] - 0.5);
    expect(far[0]).toBeLessThanOrEqual(vb[0] + vb[2] + 0.5);
    // The narrow Fit frame is wider than the desktop one, within the phone cap.
    const wide = startFitBox(a);
    const narrow = startFitBox(a, 390);
    expect(narrow.x1 - narrow.x0).toBeGreaterThanOrEqual(wide.x1 - wide.x0);
  });

  it('the Fit frame only changes across the narrow threshold', () => {
    expect(startFitBox(j70, 390)).toEqual(startFitBox(j70, 360));
    expect(startFitBox(j70, 1200)).toEqual(startFitBox(j70));
    expect(startFitBox(j70, 0)).toEqual(startFitBox(j70));
  });

  it('chips the line, the favoured end in degrees and metres, and the wind with its confidence', () => {
    const [len, fav, wind] = lineChips(j70);
    expect(len.text).toMatch(/^Line \d+ m$/);
    expect(fav.text).toMatch(/^Pin fav\. \d+° · 19 m$/);
    expect(wind).toMatchObject({ text: 'wind est. (high)' });
    expect(wind.warn).toBeUndefined();
    // The C31's weather model is ~60° off the tacks: medium, still a plain chip; the detail is its title.
    expect(windChip(c31)).toMatchObject({ text: 'wind est. (medium)' });
    expect(windChip(c31).title).toBe(biasBasis(c31));
    expect(biasBasis(c31)).toMatch(/fleet's tacks in the first 3 min \(338 steady headings, 195 \/ 143 a tack, tack angle 69°; weather model \d+° off\)/);
  });

  it('puts the wind source and the sensitivity in the ⓘ bullet', () => {
    // Benelux R8's wind at the gun is the start window's (wind.ts estimateStartTwd).
    expect(biasBullets(j70)).toEqual([expect.stringMatching(/^Favoured end vs wind \d+° \(tacks, first 3 min\); ±5° of wind ≈ ±9 m\.$/)]);
    expect(biasBasis(j70)).toMatch(/^Wind \d+° at the gun, wind estimated from the fleet's tacks in the first 3 min \([\d,]+ steady headings, [\d,]+ \/ [\d,]+ a tack, tack angle \d+°/);
  });

  it('promotes a low-confidence wind to a ⚠ chip', () => {
    const course = { ...j70, wind: { ...j70.wind, method: 'course' as const } };
    expect(windChip(course)).toMatchObject({ text: 'wind assumed', warn: true });
    expect(lineChips(course)[2].warn).toBe(true);
    expect(biasBullets(course)[0]).toContain('(first leg assumed upwind)');
    const model = { ...j70, wind: { ...j70.wind, method: 'model' as const } };
    expect(windChip(model)).toMatchObject({ text: 'model wind (medium)' });
    expect(windChip(model).warn).toBeUndefined();
  });
});

describe('windSource', () => {
  const base: WindInfo = { method: 'tacks', estimates: [{ legIndex: 0, tMs: 1, twdDeg: 10, tackAngleDeg: 72, samples: 900 }], gunSource: 'beat', startWindow: null, twdAtGunDeg: 10, model: null };

  it('rates tacks with plenty of samples and an agreeing model high', () => {
    expect(windSource(base).confidence).toBe('high');
    expect(windSource({ ...base, model: { label: 'm', dirAtGunDeg: 18 } }).confidence).toBe('high');
    expect(windSource({ ...base, model: { label: 'm', dirAtGunDeg: 25 } }).confidence).toBe('medium');
    expect(windSource({ ...base, estimates: [{ ...base.estimates[0], samples: 120 }] }).confidence).toBe('medium');
  });

  it('rates the model medium and the course assumption low', () => {
    expect(windSource({ ...base, method: 'model', estimates: [] })).toMatchObject({ text: 'weather-model wind', confidence: 'medium' });
    expect(windSource({ ...base, method: 'course', estimates: [] })).toMatchObject({ text: 'assumed: first leg dead upwind', confidence: 'low' });
  });

  it('says which tacks set the wind at the gun: the first 3 min (with each tack’s count) or the first beat', () => {
    expect(windSource(base)).toMatchObject({ text: "wind estimated from the fleet's tacks on the first beat", span: 'first beat' });
    expect(windSource(base).detail).toBe('900 steady upwind headings on leg 1, tack angle 72°');
    const sw = { ...base, gunSource: 'start-window' as const, startWindow: { tMs: 0, twdDeg: 14, tackAngleDeg: 70, samples: 1_250, tackSamples: [900, 350] as [number, number] }, twdAtGunDeg: 14 };
    expect(windSource(sw)).toMatchObject({ text: "wind estimated from the fleet's tacks in the first 3 min", from: "from the fleet's tacks in the first 3 min", span: 'first 3 min', confidence: 'high' });
    expect(windSource(sw).detail).toBe('1,250 steady headings, 900 / 350 a tack, tack angle 70°');
  });
});

describe('alongLineLabel', () => {
  const gap = 18;
  const offset = 4;
  // Unit directions in every quadrant and on the axes (y down, as SVG).
  const dirs: [number, number][] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [0.97, -0.24],
    [-0.97, 0.24],
  ];

  it.each(dirs)('direction (%d, %d): upright, past the end by the gap, offset to screen-up', (dx, dy) => {
    const p0: [number, number] = [100, 50];
    const p1: [number, number] = [100 + dx * 200, 50 + dy * 200];
    const l = alongLineLabel(p0, p1, { gap, offset });
    expect(l.rotate).toBeGreaterThan(-90);
    expect(l.rotate).toBeLessThanOrEqual(90);
    const [ux, uy] = l.along;
    // Beyond the end mark by exactly the gap along the line, and `offset` off it.
    expect((l.x - p0[0]) * ux + (l.y - p0[1]) * uy).toBeCloseTo(gap, 9);
    expect(Math.abs((l.x - p0[0]) * -uy + (l.y - p0[1]) * ux)).toBeCloseTo(offset, 9);
    // The offset is the text's up: screen-up (or sideways for a vertical line), never down.
    expect(l.up[1]).toBeLessThanOrEqual(1e-9);
    expect(l.up[0] * ux + l.up[1] * uy).toBeCloseTo(0, 9);
    // The text runs outward from the end: anchored at its start reading along, or at its end when flipped.
    const r = (l.rotate * Math.PI) / 180;
    const reads = Math.cos(r) * ux + Math.sin(r) * uy;
    expect(l.anchor).toBe(reads > 0 ? 'start' : 'end');
    expect(l.room).toBeCloseTo(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) - gap, 9);
    // Its box starts no nearer the end mark than the gap (less the text's height off the line).
    const box = alongLabelBox(l, 60, 10);
    const corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]];
    expect(Math.max(...corners.map(([x, y]) => (x - p0[0]) * ux + (y - p0[1]) * uy))).toBeGreaterThan(gap + 50);
  });

  it('flips a leftward line 180° so it reads upright', () => {
    expect(alongLineLabel([0, 0], [-100, 0], { gap, offset })).toMatchObject({ rotate: 0, anchor: 'end', x: -gap, y: -offset });
    expect(alongLineLabel([0, 0], [100, 0], { gap, offset })).toMatchObject({ rotate: 0, anchor: 'start', x: gap, y: -offset });
    expect(alongLineLabel([0, 0], [0, -100], { gap, offset }).rotate).toBe(90);
    expect(alongLineLabel([0, 0], [0, 100], { gap, offset }).rotate).toBe(90);
  });

  it('centres on a segment for a square line', () => {
    const l = alongLineLabel([0, 0], [-200, 20], { gap, offset, centre: true });
    expect(l.anchor).toBe('middle');
    expect(l.room).toBeCloseTo(Math.hypot(200, 20), 9);
    expect(l.x - l.up[0] * offset).toBeCloseTo(-100, 9);
    expect(l.y - l.up[1] * offset).toBeCloseTo(10, 9);
  });
});

describe('lineExtensions', () => {
  const frame = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };

  it('continues the line 0.6 lengths past each end', () => {
    const [pin, rc] = lineExtensions([0, 0], [100, 0], frame);
    expect(pin).toEqual([[0, 0], [-60, 0]]);
    expect(rc).toEqual([[100, 0], [160, 0]]);
  });

  it('stops at the frame when that is nearer', () => {
    const [pin, rc] = lineExtensions([0, 0], [100, 0], { x0: -20, y0: -10, x1: 130, y1: 10 });
    expect(pin[1][0]).toBeCloseTo(-20, 9);
    expect(rc[1][0]).toBeCloseTo(130, 9);
  });

  it('runs from the chart line ends in the start chart', () => {
    const a = fixtures[0][1];
    const rot = rotator(a.wind.twdAtGunDeg);
    const [pin] = lineExtensions(rot(a.line.left), rot(a.line.right), startFitBox(a));
    expect(pin[0]).toEqual(rot(a.line.left));
  });
});

describe('awayFromLineThresholdM', () => {
  it('stays in the hundreds of metres for a normal start and leaves a 2 km boat outside', () => {
    const t = awayFromLineThresholdM([20, 30, 40, 50, 60, 2000]);
    expect(t).toBeGreaterThanOrEqual(300);
    expect(t).toBeLessThan(500);
    expect(t).toBeLessThan(2000);
  });
});

describe('start-map bounds: a boat far from the line', () => {
  it('leaves Fit on the fleet, drops that boat from start places, and lists it as away', () => {
    const data = fixtureRace();
    const id = data.boats[0].id;
    const shifted = {
      ...data,
      boats: data.boats.map((b) => (b.id === id ? { ...b, track: { ...b.track, lat: b.track.lat.map((x) => x + 0.02) } } : b)),
    };
    const a = analyzeRace(shifted);
    const far = a.boats.find((b) => b.id === id)!;
    expect(far.start?.awayFromLine).toBe(true);
    expect(far.start?.startPlace).toBeNull();
    expect(a.findings.some((f) => f.kind === 'start' && f.text.includes('away from the line'))).toBe(true);
    expect(startKey(a, { scale: startScale(a) }).chips.some((c) => c.text.endsWith('away from the line') && !c.warn)).toBe(true);
    const box = startFitBox(a);
    const fleet = startFitBox(analyzeRace(data));
    expect(Math.max(box.x1 - box.x0, box.y1 - box.y0)).toBeLessThan(800);
    expect(Math.max(box.x1 - box.x0, box.y1 - box.y0)).toBeLessThan(Math.max(fleet.x1 - fleet.x0, fleet.y1 - fleet.y0) + 80);
  });
});
