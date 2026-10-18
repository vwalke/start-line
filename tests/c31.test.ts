import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { primaryDtlM } from '../src/analysis/findings';
import { OCS_BLIND_NOTE } from '../src/analysis/validity';
import { currentDoc } from '../src/data/racesense/adapter';
import { startSnapshot } from '../src/ui/charts';
import { metricsTable } from '../src/ui/table';
import { c31Fixture, c31Race } from './helpers';

// C31 Gold Cup race 10 (trimmed to four boats). The Vakaros feed carried a stale
// race-9 row for Black Pearl and no distance for Stella Maris; the public track
// has gaps at the gun for Black Pearl (17 s) and Milkwave (32 s).
const analysis = analyzeRace(c31Race());
const start = (sail: string) => analysis.boats.find((b) => b.sail === sail)!.start!;

/** The inner HTML of each <td> in a boat's table row. */
function cells(html: string, id: string): string[] {
  const row = new RegExp(`<tr data-id="${id}"[^>]*>(.*?)</tr>`).exec(html)![1];
  return [...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
}
const tdClass = (html: string, id: string, col: number): string =>
  [...new RegExp(`<tr data-id="${id}"[^>]*>(.*?)</tr>`).exec(html)![1].matchAll(/<td class="([^"]*)"/g)][col][1];
// Columns: Fin, Boat, Start, DTL Vakaros, Check ours, Late, …
const START = 2;
const VAK = 3;
const OURS = 4;
const LATE = 5;

describe('C31 Gold Cup race 10: start validity', () => {
  it('Black Pearl: stale race-9 row, gap-interpolated check, unranked, OCS-blind', () => {
    const s = start('GER42');
    expect(s.rcStatus).toBe('stale');
    expect(s.rcDtlM).toBeNull();
    expect(s.rcNote).toBe('Vakaros reported no start fix (stale race 9 data)');
    expect(Math.abs(s.dtlM - -3.1)).toBeLessThan(0.5);
    expect(s.dtlGapS).toBeCloseTo(17.1, 1);
    expect(s.dtlNote).toBe('interpolated across a 17 s data gap');
    expect(s.rank).toBeNull();
    expect(s.startPlace).toBeNull();
    expect(s.over).toBe(false);
    expect(s.lateS).toBeNull();
    expect(s.ocsBlind).toBe(true);
    expect(s.warn).toBeNull();
  });

  it('Milkwave: valid Vakaros 0.434 (mask 5) ranks it despite a 32 s gap in ours', () => {
    const s = start('ITA 78');
    expect(s.rcStatus).toBe('ok');
    expect(s.rcDtlM).toBe(0.434);
    expect(s.dtlGapS).toBeCloseTo(31.7, 1);
    expect(s.rank).toEqual({ m: 0.434, source: 'vakaros' });
    expect(s.startPlace).toBe(1);
    expect(s.lateS).toBeNull();
    expect(s.warn).toBeNull(); // ours is gap-interpolated, so no ⚠ even though it reads −6.0
    expect(s.ocsBlind).toBe(false);
  });

  it('Stella Maris: no Vakaros distance (mask 8), ranked by our valid check', () => {
    const s = start('AUT 3165');
    expect(s.rcStatus).toBe('missing');
    expect(s.rcDtlM).toBeNull();
    expect(s.rcNote).toBe('Vakaros reported no distance for this boat');
    expect(s.dtlGapS).toBeNull();
    expect(s.rank?.source).toBe('ours');
    expect(Math.abs(s.rank!.m - 2.1)).toBeLessThan(0.3);
    expect(s.startPlace).toBe(2);
    expect(s.lateS).not.toBeNull();
    expect(s.ocsBlind).toBe(false);
  });

  it('Outrage: Vakaros 12.593 and ours agree', () => {
    const s = start('FRA 901');
    expect(s.rank).toEqual({ m: 12.593, source: 'vakaros' });
    expect(Math.abs(s.dtlM - 12.9)).toBeLessThan(0.5);
    expect(s.dtlGapS).toBeNull();
    expect(s.warn).toBeNull();
    expect(s.startPlace).toBe(3);
  });

  it('primaryDtlM is the ranking value or null', () => {
    expect(primaryDtlM(start('ITA 78'))).toBe(0.434);
    expect(primaryDtlM(start('AUT 3165'))).toBe(start('AUT 3165').dtlM);
    expect(primaryDtlM(start('GER42'))).toBeNull();
  });

  it('does not add the fleet-wide disagreement warning', () => {
    expect(analysis.warnings.join(' ')).not.toMatch(/Vakaros DTL differs/);
  });
});

describe('C31 race 10: metrics table', () => {
  const html = metricsTable(analysis, null);

  it('Black Pearl: — for Vakaros and rank, ~ for ours, no Late', () => {
    const c = cells(html, 'GER42');
    expect(c[START]).toBe('<span class="na" title="No reliable start figure" aria-label="No reliable start figure">—</span>');
    expect(c[VAK]).toBe(
      '<span class="na" title="Vakaros reported no start fix (stale race 9 data)" aria-label="Vakaros reported no start fix (stale race 9 data)">—</span>',
    );
    expect(c[OURS]).toBe(
      '<span class="gap" title="interpolated across a 17 s data gap" aria-label="interpolated across a 17 s data gap">~-3.1</span>',
    );
    expect(c[LATE]).toBe('—');
  });

  it('Milkwave: ranked 1st by Vakaros (▲), ~ for ours, no ⚠', () => {
    const c = cells(html, 'ITA 78');
    expect(c[START]).toBe('<span class="ic" aria-label="best">▲</span>1 <small class="rk-src" title="Vakaros device">V</small>');
    expect(tdClass(html, 'ITA 78', START)).toBe('num best');
    expect(c[VAK]).toBe('0.4');
    expect(c[OURS]).toBe(
      '<span class="gap" title="interpolated across a 32 s data gap" aria-label="interpolated across a 32 s data gap">~-6.0</span>',
    );
    expect(c[LATE]).toBe('—');
  });

  it('Stella Maris: — (not 0.0) for Vakaros, ranked by ours', () => {
    const c = cells(html, 'AUT 3165');
    expect(c[VAK]).toBe(
      '<span class="na" title="Vakaros reported no distance for this boat" aria-label="Vakaros reported no distance for this boat">—</span>',
    );
    expect(c[VAK]).not.toContain('0.0');
    expect(c[START]).toBe('2 <small class="rk-src" title="our track check">ours</small>');
    expect(c[OURS]).toBe('2.1');
    expect(c[LATE]).toMatch(/^\d+\.\d$/);
  });

  it('Outrage: ranked last by Vakaros (▼), no ⚠', () => {
    const c = cells(html, 'FRA 901');
    expect(c[START]).toBe('<span class="ic" aria-label="worst">▼</span>3 <small class="rk-src" title="Vakaros device">V</small>');
    expect(c[VAK]).toBe('12.6');
    expect(c[OURS]).toBe('12.9');
  });

  it('the Vakaros column no longer carries best/worst marks', () => {
    for (const id of ['GER42', 'ITA 78', 'AUT 3165', 'FRA 901']) expect(tdClass(html, id, VAK)).toBe('num');
    expect(html).not.toContain('class="warn"');
  });

  it('lists the notes under the table for touch screens', () => {
    expect(html).toContain('V = Vakaros device, ours = our track check');
    expect(html).toContain(
      `<li><b>#GER42</b> Black Pearl — Vakaros reported no start fix (stale race 9 data); our check interpolated across a 17 s data gap; ${OCS_BLIND_NOTE}.</li>`,
    );
    expect(html).toContain('<li><b>#ITA 78</b> Milkwave — our check interpolated across a 32 s data gap.</li>');
    expect(html).toContain('<li><b>#AUT 3165</b> Stella Maris — Vakaros reported no distance for this boat.</li>');
    expect(html).not.toContain('<li><b>#FRA 901</b>');
  });

  it('shows ⚠ when Vakaros and ours disagree by more than 3 m, and a genuine 0.0', () => {
    const f = c31Fixture();
    const st = currentDoc(f.regatta).divisions[0].races.find((r) => r.raceNumber === 10)!.starts.at(-1)!;
    const fra = st.startingStats!.find((s) => s.sailNumber === 'FRA 901')!;
    fra.dtlMm = 7604;
    // Make Black Pearl's row a fresh race-10 one (its line ends too) with a genuine 0.
    const ger = st.startingStats!.find((s) => s.sailNumber === 'GER42')!;
    Object.assign(ger, { raceNumber: 10, dtlMm: 0, mask: { value: 1 }, lineLeftLocation: fra.lineLeftLocation, lineRightLocation: fra.lineRightLocation });
    const a = analyzeRace(c31Race(f));
    const t = metricsTable(a, null);
    const warn = 'Vakaros 7.6 m vs ours 12.9 m (5.3 m apart) — one of them is off (feed, GPS or bow offset).';
    expect(cells(t, 'FRA 901')[VAK]).toBe(`<span class="warn" title="${warn}" aria-label="disagrees with our check">⚠</span>7.6`);
    expect(t).toContain(`<li><b>#FRA 901</b> Outrage — ${warn}</li>`);
    // Black Pearl with a genuine 0 (bit 1 set): valid, shown as 0.0 and ranked first.
    expect(cells(t, 'GER42')[VAK]).toBe('0.0');
    expect(cells(t, 'GER42')[START]).toContain('1 <small class="rk-src" title="Vakaros device">V</small>');
  });
});

describe('C31 race 10: findings and chart', () => {
  const text = analysis.findings.map((f) => f.text);

  it('ranks the best start by the Vakaros figure and omits Late when blank', () => {
    expect(text).toContain('Best start: #ITA 78 (Milkwave) — 0.4 m back, at 5.6 kn. #ITA 78 (Milkwave) finished 1st.');
    expect(text.find((t) => t.startsWith('Furthest back:'))).toMatch(/^Furthest back: #FRA 901 \(Outrage\) — 12\.6 m, ≈\d+ s late/);
  });

  it('adds a hedged note for Black Pearl and no over-the-line claim', () => {
    expect(text).toContain(
      '#GER42 (Black Pearl): Vakaros had no start fix for this race and our track has a 17 s gap at the gun; it may have been over (≈3.1 m over by interpolation), but neither figure is reliable.',
    );
    expect(text.filter((t) => t.includes('#GER42') && t.includes('over the line'))).toEqual([]);
    expect(text.filter((t) => t.includes(OCS_BLIND_NOTE) || t.includes('Vakaros had no start fix'))).toHaveLength(1);
  });

  it('labels the chart with the ranking value, ~ for gap-only, never a bogus 0.0', () => {
    const svg = startSnapshot(analysis, null);
    const label = (sail: string): string => new RegExp(`>${sail}</text>\\s*<text[^>]*class="sub">([^<]*)</text>`).exec(svg)![1];
    expect(label('ITA 78')).toBe('0.4 m');
    expect(label('GER42')).toBe('~-3.1 m');
    expect(label('AUT 3165')).toBe('2.1 m');
    expect(label('FRA 901')).toBe('12.6 m');
    expect(svg).toMatch(/<title>#GER42: no reliable distance \(ours ~-3\.1 m\), SOG 6\.\d kn at the gun<\/title>/);
    expect(svg).toMatch(/<title>#ITA 78: 0\.4 m behind \(Vakaros; ours ~-6\.0 m\), SOG 5\.6 kn at the gun<\/title>/);
  });
});
