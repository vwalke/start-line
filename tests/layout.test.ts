import { describe, expect, it } from 'vitest';
import { START_TRAIL_MS, addDrawnMark, analyzeRace } from '../src/analysis/analyze';
import type { RaceAnalysis } from '../src/analysis/types';
import { currentDoc, PRE_START_FETCH_MS, RACESENSE_DTL_SAMPLE_OFFSET_MS, telemetryWindow } from '../src/data/racesense/adapter';
import { splitFindings } from '../src/analysis/findings';
import { boatList, findingsList } from '../src/ui/boats';
import { legLegend, mapBox, rotator, trackMap } from '../src/ui/charts';
import { fixtureRace, loadFixture } from './helpers';

const data = fixtureRace();
const a = analyzeRace(data);
const gun = data.gunMs;

describe('60 s start trails', () => {
  it('is one 60 s constant, and the live fetch window covers it', () => {
    expect(START_TRAIL_MS).toBe(60_000);
    expect(PRE_START_FETCH_MS).toBeGreaterThanOrEqual(START_TRAIL_MS);
    const w = telemetryWindow(currentDoc(loadFixture().regatta), { division: 'J70', raceNumber: 8 });
    expect(w.after).toBeLessThanOrEqual(gun - START_TRAIL_MS);
  });

  it('draws every fix from 60 s before the gun on the Benelux fixture', () => {
    const ts = gun - RACESENSE_DTL_SAMPLE_OFFSET_MS;
    for (const d of a.drawings) {
      const t = Array.from(data.boats.find((b) => b.id === d.id)!.track.t);
      // The fixture carries track well before the trail window.
      expect(t[0]).toBeLessThan(gun - START_TRAIL_MS - 30_000);
      const inTrail = t.filter((x) => x >= gun - START_TRAIL_MS && x <= ts);
      const first = inTrail[0];
      expect(first).toBeGreaterThanOrEqual(gun - 60_000);
      expect(first).toBeLessThan(gun - 59_000); // well before gun − 30 s
      // The trail is those fixes, plus the bow tip when no fix sits on the sample.
      expect(d.trail.x.length - inTrail.length).toBeGreaterThanOrEqual(0);
      expect(d.trail.x.length - inTrail.length).toBeLessThanOrEqual(1);
      expect(d.trail.x.length).toBeGreaterThan(1.8 * t.filter((x) => x >= gun - 30_000 && x <= ts).length);
    }
  });
});

describe('mark labels: overlapping M1/M2 are not both drawn', () => {
  it('keeps the first mark when an unused tracker sits on the same turn', () => {
    const out: RaceAnalysis['marks'] = [];
    addDrawnMark(out, { name: 'M2', xy: [[0, 0]] }, { replaceEstimate: true });
    addDrawnMark(out, { name: 'M1', xy: [[8, 4]] });
    addDrawnMark(out, { name: 'Leeward mark', xy: [[400, 0]], estimated: true }, { replaceEstimate: true });
    addDrawnMark(out, { name: 'M1', xy: [[405, 3]] });
    expect(out.map((m) => m.name)).toEqual(['M2', 'Leeward mark']);
  });

  it('omits a second name when two marks overlap on the race map', () => {
    const p = a.marks[0]?.xy[0] ?? ([0, 0] as [number, number]);
    const svg = trackMap({ ...a, marks: [{ name: 'M2', xy: [p] }, { name: 'M1', xy: [[p[0] + 1, p[1] + 1]] }] }, null);
    const labels = [...svg.matchAll(/<text [^>]*class="lbl[^"]*"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(labels.filter((t) => t === 'M1' || t === 'M2')).toHaveLength(1);
    expect(svg.match(/<circle class="mark"/g)?.length).toBe(2);
  });
});

describe('Race Viewer: the legend selects a leg', () => {
  const legsIn = (svg: string): string[] => [...new Set([...svg.matchAll(/<polyline class="trk[^"]*" data-leg="(\d+)"/g)].map((m) => m[1]))];
  const vb = (svg: string): number[] => /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);

  it('shows every leg by default and only the selected leg when one is picked', () => {
    expect(legsIn(trackMap(a, null)).sort()).toEqual(['0', '1', '2', '3']);
    const svg = trackMap(a, null, 2);
    expect(legsIn(svg)).toEqual(['2']);
    expect(svg.match(/<polyline class="trk/g)).toHaveLength(a.drawings.filter((d) => d.segments.some((s) => s.leg === 2 && s.x.length > 1)).length);
    expect(svg).toContain('aria-label="Tracks on Beat 2"');
  });

  it('fits the view to the selected leg’s segments and marks', () => {
    const all = mapBox(a);
    const leg = mapBox(a, 2);
    const [x0, y0, w, h] = vb(trackMap(a, null, 2));
    [x0, y0, x0 + w, y0 + h].forEach((n, i) => expect(n).toBeCloseTo([leg.x0, leg.y0, leg.x1, leg.y1][i], 9));
    expect((leg.x1 - leg.x0) * (leg.y1 - leg.y0)).toBeLessThan((all.x1 - all.x0) * (all.y1 - all.y0));
    const rot = rotator(a.wind.twdAtGunDeg);
    const inside = ([x, y]: number[]) => x >= leg.x0 && x <= leg.x1 && y >= leg.y0 && y <= leg.y1;
    for (const d of a.drawings) for (const s of d.segments.filter((s) => s.leg === 2)) for (let i = 0; i < s.x.length; i++) expect(inside(rot([s.x[i], s.y[i]]))).toBe(true);
    // Beat 2 runs from the Gate to M1.
    for (const m of a.marks.filter((m) => m.name === 'Gate' || m.name === 'M1')) for (const p of m.xy) expect(inside(rot(p))).toBe(true);
    // Beat 1 starts at the line.
    const b1 = mapBox(a, 0);
    for (const p of [a.line.left, a.line.right]) {
      const [x, y] = rot(p);
      expect(x >= b1.x0 && x <= b1.x1 && y >= b1.y0 && y <= b1.y1).toBe(true);
    }
  });

  it('keeps highlight dimming within a selected leg', () => {
    const id = a.boats[2].id;
    const svg = trackMap(a, id, 1);
    expect(legsIn(svg)).toEqual(['1']);
    expect(svg.match(/class="trk on"/g)).toHaveLength(1);
    expect(svg.match(/class="trk dim"/g)).toHaveLength(a.drawings.length - 1);
  });

  it('renders the legend as toggle buttons with aria-pressed', () => {
    const pressed = (html: string): string[] => [...html.matchAll(/data-leg="([^"]+)" aria-pressed="true"/g)].map((m) => m[1]);
    const html = legLegend(a);
    expect(html.match(/<button type="button" class="key"/g)).toHaveLength(a.legs.length + 1);
    expect(pressed(html)).toEqual(['all']);
    expect(html).toContain('data-leg="3" aria-pressed="false"><i style="background:var(--s4)"></i>Run 2 → finish</button>');
    expect(pressed(legLegend(a, 2))).toEqual(['2']);
  });
});

describe('boat list and findings share the selection', () => {
  it('lists boats in finish order with swatch, sail, name and place', () => {
    const html = boatList(a, null);
    expect([...html.matchAll(/class="boat-item" data-id="([^"]+)"/g)].map((m) => m[1])).toEqual(a.boats.map((b) => b.id));
    const b = a.boats[0];
    expect(html).toContain(`<i class="sw" style="background:var(--s${b.colorSlot + 1})"></i><b class="sail">${b.sail}</b>`);
    expect(html).toContain('<span class="pos">1</span>');
    expect(html).toContain('data-clear disabled');
    expect(html).not.toContain('aria-pressed="true"');
  });

  it('marks the selected boat and enables Clear', () => {
    const id = a.boats[3].id;
    const html = boatList(a, id);
    expect([...html.matchAll(/data-id="([^"]+)" aria-pressed="true"/g)].map((m) => m[1])).toEqual([id]);
    expect(html).not.toContain('data-clear disabled');
  });

  it('tags findings with the boats they are about', () => {
    const best = a.findings.find((f) => f.text.startsWith('Best start'))!;
    // The single best starter and the worst, no tied batch.
    expect(best.boatIds).toEqual(['6', '5']);
    expect(a.findings.find((f) => /#3 lost/.test(f.text))!.boatIds).toEqual(['3']);
    expect(a.findings.find((f) => f.kind === 'wind')!.boatIds).toBeUndefined();
  });

  it('highlights the selected boat’s findings and dims the rest', () => {
    expect(findingsList(a.findings, null)).not.toMatch(/ (hl|dim)"/);
    const html = findingsList(a.findings, '3');
    const items = [...html.matchAll(/<li class="([^"]+)">(.*?)<\/li>/g)].map((m) => ({ cls: m[1], text: m[2] }));
    expect(items).toHaveLength(a.findings.length);
    for (const [i, it] of items.entries()) expect(it.cls.endsWith(a.findings[i].boatIds?.includes('3') ? ' hl' : ' dim')).toBe(true);
    expect(items.find((x) => x.text.includes('#3 lost'))!.cls).toBe('leg hl');
  });
});

describe('findings split between the start and the race', () => {
  const { start, race } = splitFindings(a.findings);

  it('puts the line and the starts under the start chart, the rest with the race, in order', () => {
    expect(start.map((f) => f.kind)).toEqual(['line', 'start']);
    expect(start[0].text).toMatch(/^The pin \(left\) end was favored by 12° ≈ 20 m against the estimated wind of 10°\./);
    expect(start[1].text).toMatch(/^Best start: #6 — .+ Worst start: #5 — /);
    expect(race.every((f) => f.kind === 'leg' || f.kind === 'result' || f.kind === 'wind')).toBe(true);
    expect(race.some((f) => /#3 lost/.test(f.text))).toBe(true);
    expect(race.at(-1)!.kind).toBe('wind');
    // Every finding lands in exactly one list, each list keeping the original order.
    const idx = (fs: typeof start): number[] => fs.map((f) => a.findings.indexOf(f));
    expect([...idx(start), ...idx(race)].sort((x, y) => x - y)).toEqual(a.findings.map((_, i) => i));
    for (const fs of [start, race]) expect(idx(fs)).toEqual([...idx(fs)].sort((x, y) => x - y));
  });

  it('highlights the selected boat in both lists', () => {
    // #6 started best; #3 lost the most on a leg.
    expect(findingsList(start, '6')).toMatch(/<li class="start hl"><table class="start-cmp" aria-label="Best and worst start">/);
    expect(findingsList(start, '5')).toMatch(/<li class="start hl"><table class="start-cmp"/);
    expect(findingsList(start, '4')).toMatch(/<li class="start dim"><table class="start-cmp"/);
    expect(findingsList(start, '6')).toMatch(/<li class="line (hl|dim)">/);
    expect(findingsList(race, '3')).toMatch(/<li class="leg hl">#3 lost/);
    expect(findingsList(race, '3')).toMatch(/<li class="wind dim">/);
  });

  it('is empty-safe', () => {
    expect(splitFindings([])).toEqual({ start: [], race: [] });
    expect(findingsList([], null)).toBe('');
  });
});
