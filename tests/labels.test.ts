import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { Vec } from '../src/analysis/geo';
import { labelCandidates, parseStartNames, placeLabels, segmentHitsRect, startNamesControls, type LabelReq, type Rect } from '../src/ui/labels';
import { rotator, startFitBox, startSnapshot } from '../src/ui/charts';
import { clampView, fitView } from '../src/ui/view';
import { fixtureRace, m24Race } from './helpers';

const req = (id: string, at: Vec, fwd: Vec = [0, -1]): LabelReq => ({ id, at, fwd, w: 20, h: 10, reach: { ahead: 0, side: 1, behind: 7 } });
const overlap = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe('Names preference', () => {
  it('parses with Auto as the default', () => {
    expect(parseStartNames(null)).toBe('auto');
    expect(parseStartNames('junk')).toBe('auto');
    expect(parseStartNames('all')).toBe('all');
    expect(parseStartNames('off')).toBe('off');
  });

  it('renders a segmented group like Colour', () => {
    const html = startNamesControls('off');
    expect(html).toMatch(/class="seg" role="group" aria-label="Boat names on the start chart"/);
    expect(html).toContain('<span class="seg-lbl" aria-hidden="true">Names</span>');
    expect(html).toContain('data-start-names="off" aria-pressed="true"');
    expect(html).toContain('data-start-names="auto" aria-pressed="false"');
    expect(html).toContain('data-start-names="all" aria-pressed="false"');
  });
});

describe('label candidates', () => {
  it('tries ahead, right, left, then behind, clear of the shape', () => {
    const [ahead, right, left, behind] = labelCandidates(req('a', [0, 0]), 2);
    expect(ahead).toEqual({ x0: -10, y0: -12, x1: 10, y1: -2 }); // up the page
    expect(right).toEqual({ x0: 3, y0: -5, x1: 23, y1: 5 });
    expect(left).toEqual({ x0: -23, y0: -5, x1: -3, y1: 5 });
    expect(behind).toEqual({ x0: -10, y0: 9, x1: 10, y1: 19 });
  });

  it('turns with the heading', () => {
    // Heading right on screen: "right" of the boat is down the page.
    const [ahead, right] = labelCandidates(req('a', [0, 0], [1, 0]), 2);
    expect(ahead.x0).toBeCloseTo(2, 9);
    expect(right.y0).toBeCloseTo(3, 9);
  });

  it('detects a segment through a box', () => {
    const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(segmentHitsRect([-5, 5], [15, 5], r)).toBe(true);
    expect(segmentHitsRect([-5, -1], [15, -1], r)).toBe(false);
    expect(segmentHitsRect([2, 2], [3, 3], r)).toBe(true);
    expect(segmentHitsRect([-5, 20], [20, -5], r)).toBe(true);
    expect(segmentHitsRect([-5, 30], [30, -5], r)).toBe(false);
  });
});

describe('placeLabels', () => {
  it('places in priority order and moves or skips labels that would overlap', () => {
    // Six boats abreast, 4 units apart: the first takes "ahead", the next go elsewhere, some are skipped.
    const reqs = [0, 1, 2, 3, 4, 5].map((i) => req(String(i), [4 * i, 0]));
    const out = placeLabels(reqs, { pad: 2 });
    expect(out.get('0')).toEqual(labelCandidates(reqs[0], 2)[0]);
    expect(out.get('1')).toEqual(labelCandidates(reqs[1], 2)[3]); // ahead, right and left all touch the first: behind
    const boxes = [...out.values()];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
    expect(out.size).toBeGreaterThan(1);
    expect(out.size).toBeLessThan(6);
  });

  it('keeps labels off the line, out of taken boxes and inside the bounds', () => {
    const line: [Vec, Vec] = [[-50, -7], [50, -7]];
    const out = placeLabels([req('a', [0, 0])], { pad: 2, segments: [line], taken: [{ x0: 2, y0: -6, x1: 30, y1: 6 }], bounds: { x0: -100, y0: -100, x1: 100, y1: 100 } });
    // Ahead crosses the line, right is taken: left.
    expect(out.get('a')).toEqual(labelCandidates(req('a', [0, 0]), 2)[2]);
    expect(placeLabels([req('a', [95, 0])], { pad: 2, bounds: { x0: -100, y0: -100, x1: 100, y1: 100 } }).get('a')!.x1).toBeLessThanOrEqual(100);
  });

  it("prefers a spot off other boats' hulls, but still names a boat when there is none", () => {
    const soft = [{ id: 'b', box: { x0: -2, y0: -20, x1: 2, y1: -3 } }];
    expect(placeLabels([req('a', [0, 0])], { pad: 2, soft }).get('a')).toEqual(labelCandidates(req('a', [0, 0]), 2)[1]);
    // Its own hull never counts against it.
    expect(placeLabels([req('b', [0, 0])], { pad: 2, soft }).get('b')).toEqual(labelCandidates(req('b', [0, 0]), 2)[0]);
    const everywhere = [{ id: 'b', box: { x0: -100, y0: -100, x1: 100, y1: 100 } }];
    expect(placeLabels([req('a', [0, 0])], { pad: 2, soft: everywhere }).get('a')).toEqual(labelCandidates(req('a', [0, 0]), 2)[0]);
  });

  it('always names the forced (selected) boat, and places everyone with cull off', () => {
    const reqs = [req('a', [0, 0]), req('b', [1, 0]), req('c', [2, 0]), req('d', [3, 0]), req('e', [4, 0]), req('f', [5, 0])];
    expect(placeLabels(reqs, { pad: 2, force: 'f' }).has('f')).toBe(true);
    expect(placeLabels(reqs, { pad: 2, cull: false }).size).toBe(6);
  });
});

const ids = (svg: string, cls: string): string[] => [...svg.matchAll(new RegExp(`<g class="[^"]*\\b${cls}\\b[^"]*" data-id="([^"]+)"`, 'g'))].map((m) => m[1]);
const named = (svg: string): number => (svg.match(/<g class="blbl"/g) ?? []).length;

describe('start chart names', () => {
  const a = analyzeRace(m24Race()); // 12 boats bunched at the pin
  const box = startFitBox(a);
  const fit = fitView(box);

  it('Auto never overlaps two names, and every boat keeps its hover title', () => {
    const svg = startSnapshot(a, null);
    const boxes = [...svg.matchAll(/<g class="blbl"[^>]*><text x="([-\d.]+)" y="([-\d.]+)" font-size="([\d.]+)"[^>]*>([^<]+)</g)].map((m) => {
      const w = m[4].length * 0.6 * +m[3];
      return { x0: +m[1] - w / 2, x1: +m[1] + w / 2, y0: +m[2] - +m[3], y1: +m[2] };
    });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
    expect((svg.match(/<g class="boat[^"]*" data-id="[^"]+"><title>#/g) ?? []).length).toBe(a.drawings.length);
    expect(named(svg) + ids(svg, 'nolbl').length).toBe(a.drawings.length);
  });

  it('Auto names the best starter and the selected boat first', () => {
    const best = a.boats.find((b) => b.start?.startPlace === 1)!;
    expect(ids(startSnapshot(a, null), 'nolbl')).not.toContain(best.id);
    for (const b of a.boats) expect(ids(startSnapshot(a, b.id), 'nolbl')).not.toContain(b.id);
  });

  it('zooming in reveals more names', () => {
    const hidden = ids(startSnapshot(a, null), 'nolbl');
    expect(hidden.length).toBeGreaterThan(0);
    // Zoomed 8x onto each boat that went unnamed at Fit, most get their name back.
    const rot = rotator(a.wind.twdAtGunDeg);
    const back = hidden.filter((id) => {
      const [cx, cy] = rot(a.drawings.find((d) => d.id === id)!.bow!);
      return !ids(startSnapshot(a, null, clampView(box, { cx, cy, k: 8 })), 'nolbl').includes(id);
    });
    expect(back.length).toBeGreaterThan(hidden.length / 2);
    // Names stay the same size on screen: font size tracks the view width.
    const fs = (svg: string): number => +/class="blbl"[^>]*><text [^>]*font-size="([\d.]+)"/.exec(svg)![1];
    const vw = (svg: string): number => +/viewBox="[^ ]+ [^ ]+ ([^ ]+)/.exec(svg)![1];
    const s1 = startSnapshot(a, null);
    const s4 = startSnapshot(a, null, clampView(box, { ...fit, k: 4 }));
    expect(fs(s1) / vw(s1)).toBeCloseTo(fs(s4) / vw(s4), 4);
  });

  it('All names every boat; Off only the selected one', () => {
    expect(named(startSnapshot(a, null, undefined, 'boat', { names: 'all' }))).toBe(a.drawings.length);
    expect(named(startSnapshot(a, null, undefined, 'boat', { names: 'off' }))).toBe(0);
    const pick = a.boats[3].id;
    const off = startSnapshot(a, pick, undefined, 'boat', { names: 'off' });
    expect(named(off)).toBe(1);
    expect(ids(off, 'nolbl')).not.toContain(pick);
  });

  it('is smaller than before and scales up on a narrow (phone) chart', () => {
    const j = analyzeRace(fixtureRace());
    const fs = (svg: string): number => +/class="blbl"[^>]*><text [^>]*font-size="([\d.]+)"/.exec(svg)![1];
    const vw = (svg: string): number => +/viewBox="[^ ]+ [^ ]+ ([^ ]+)/.exec(svg)![1];
    const wide = startSnapshot(j, null, undefined, 'boat', { widthPx: 900 });
    const phone = startSnapshot(j, null, undefined, 'boat', { widthPx: 360 });
    expect(fs(wide) / vw(wide)).toBeCloseTo(10 / 600, 4); // was 13
    // ≥ 8 px rendered on a 360 px chart.
    expect((fs(phone) / vw(phone)) * 360).toBeCloseTo(8, 1);
  });
});
