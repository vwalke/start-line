import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { biasAngle, biasSensitivityM, lineBias, windSource } from '../src/analysis/line';
import type { RaceAnalysis, WindInfo } from '../src/analysis/types';
import { rotator, startClass, startFitBox, startSnapshot } from '../src/ui/charts';
import { biasBasis, biasCaption, favouredText, lineExtensions } from '../src/ui/startLine';
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
    expect(fav[2]).toBe(favouredText(a, startClass(a)!.dims));
    expect(fav[2]).toMatch(/^(Pin|RC) favoured \d+° · \d+ m \([\d.]+ lengths\)$/);
    expect(fav[1]).toContain('±5° of wind ≈ ±');
  });
});

describe('favoured end text', () => {
  const [, j70] = fixtures[0];
  const [, c31] = fixtures[1];
  const [, j88] = fixtures[3];

  it('names the end, degrees, metres and lengths', () => {
    expect(favouredText(j70, { loaM: 6.934, beamM: 2.249 })).toMatch(/^Pin favoured \d+° · 17 m \(2\.5 lengths\)$/);
    expect(favouredText(j70, null)).toMatch(/^Pin favoured \d+° · 17 m$/);
    expect(favouredText(j88, null)).toMatch(/^RC favoured \d+° · 7 m$/);
    expect(startSnapshot(c31, null)).toMatch(/>Pin favoured \d+° · 40 m \(4\.2 lengths\)<\/text>/);
  });

  it('says Square line within the threshold', () => {
    const sq = { ...j70, line: { ...j70.line, bearingDeg: j70.wind.twdAtGunDeg + 90.5 } };
    expect(favouredText(sq, null)).toBe('Square line');
    expect(startSnapshot(sq, null)).toContain('>Square line</text>');
  });

  it('puts the degrees in the caption with the wind source and sensitivity', () => {
    expect(biasCaption(j70)).toMatch(/^pin end favoured by \d+° ≈ 17 m \(wind estimated from the fleet's tacks, high confidence; ±5° of wind ≈ ±9 m\)$/);
    // The C31's weather model is ~60° off the tacks: medium.
    expect(biasCaption(c31)).toContain('medium confidence');
    expect(biasBasis(c31)).toMatch(/821 steady upwind headings on leg 1, tack angle 70°; weather model \d+° off/);
  });
});

describe('windSource', () => {
  const base: WindInfo = { method: 'tacks', estimates: [{ legIndex: 0, tMs: 1, twdDeg: 10, tackAngleDeg: 72, samples: 900 }], twdAtGunDeg: 10, model: null };

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
