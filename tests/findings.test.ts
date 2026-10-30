import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildFindings, START_COMPARE_ROWS } from '../src/analysis/findings';
import type { BoatResult, RaceAnalysis, StartResult } from '../src/analysis/types';
import { ACT_KEY, ACT_ROW } from '../src/ui/act';
import { findingsClick, findingsList, startCompareHtml } from '../src/ui/boats';
import { fixtureRace } from './helpers';

const base = analyzeRace(fixtureRace());

/** The fixture race with some boats' starts (and names / sails) changed. */
function withBoats(edit: Record<string, Partial<Omit<BoatResult, 'start'>> & { start?: Partial<StartResult> }>): RaceAnalysis {
  return {
    ...base,
    boats: base.boats.map((b) => {
      const e = edit[b.id];
      return e && b.start ? { ...b, ...e, start: { ...b.start, ...e.start } } : b;
    }),
  };
}
const startTexts = (a: RaceAnalysis): string[] => buildFindings(a).filter((f) => f.kind === 'start').map((f) => f.text);

describe('best vs worst start', () => {
  const f = buildFindings(base).find((x) => x.compare)!;

  it('one finding: the single best clean starter beside the worst, under the same row labels', () => {
    expect(buildFindings(base).filter((x) => x.compare)).toHaveLength(1);
    const clean = base.boats.filter((b) => b.start?.startPlace != null).sort((x, y) => x.start!.startPlace! - y.start!.startPlace!);
    expect(f.compare!.best.id).toBe(clean[0].id);
    expect(f.compare!.worst!.id).toBe(clean.at(-1)!.id);
    expect(f.boatIds).toEqual([clean[0].id, clean.at(-1)!.id]);
    expect(f.compare!.rows).toEqual([...START_COMPARE_ROWS]);
    expect(START_COMPARE_ROWS).toEqual(['Behind the line at the gun', 'Late', 'Speed at the gun', 'Line position']);
    for (const side of [f.compare!.best, f.compare!.worst!]) expect(side.values).toHaveLength(START_COMPARE_ROWS.length);
    expect(startTexts(base).some((t) => /Furthest back/.test(t))).toBe(false);
  });

  it('renders a two-column table, the selected boat marked, with a plain-text form', () => {
    const html = startCompareHtml(f.compare!, '6');
    expect(html).toMatch(
      /^<table class="start-cmp" aria-label="Best and worst start"><thead><tr><td><\/td><th scope="col" class="on"><span class="cmp-k">Best<\/span> <button [^>]+><span class="act-key">#6<\/span><\/button><\/th><th scope="col"><span class="cmp-k">Worst<\/span> <button [^>]+><span class="act-key">#5<\/span><\/button><\/th>/,
    );
    for (const r of START_COMPARE_ROWS) expect(html).toContain(`<tr><th scope="row">${r}</th>`);
    expect(html).toContain('<td class="on">5.9 m</td><td>18.9 m</td>');
    expect(html).not.toContain('cmp-note');
    expect(findingsList([f], null)).toBe(`<li class="start">${startCompareHtml(f.compare!, null)}</li>`);
    expect(f.text).toMatch(/^Best start: #6 — behind the line at the gun: 5\.9 m; .+\. Worst start: #5 — behind the line at the gun: 18\.9 m; /);
  });

  it('the best and worst boats are buttons that select the boat, like the boat list', () => {
    const c = buildFindings(withBoats({ '6': { sail: '1518', name: 'Vale Night' } })).find((x) => x.compare)!.compare!;
    const button = (id: string, label: string, pressed: boolean): string =>
      `<button type="button" class="cmp-boat ${ACT_ROW}" data-id="${id}" aria-pressed="${pressed}" aria-label="${label}" title="${label}">`;
    const html = startCompareHtml(c, '5');
    expect(html).toContain(`${button('6', '#1518 Vale Night, best start', false)}<span class="${ACT_KEY}">#1518</span> (Vale Night)</button>`);
    expect(html).toContain(`<th scope="col" class="on"><span class="cmp-k">Worst</span> ${button('5', '#5, worst start', true)}<span class="${ACT_KEY}">#5</span></button></th>`);
    // Activating one selects its boat; activating the selected one clears it; elsewhere does nothing.
    const at = (id: string | null): Element => ({ closest: (sel: string) => (sel === 'button[data-id]' && id ? { getAttribute: () => id } : null) }) as unknown as Element;
    expect(findingsClick(at('6'), null)).toBe('6');
    expect(findingsClick(at('6'), '5')).toBe('6');
    expect(findingsClick(at('5'), '5')).toBeNull();
    expect(findingsClick(at(null), '5')).toBeUndefined();
  });

  it('leaves over-early and away boats out of both, with a note', () => {
    const a = withBoats({
      '6': { start: { over: true, ocs: true, startPlace: null } },
      '5': { start: { awayFromLine: true, startPlace: null } },
    });
    const c = buildFindings(a).find((x) => x.compare)!.compare!;
    expect([c.best.id, c.worst!.id]).not.toContain('6');
    expect([c.best.id, c.worst!.id]).not.toContain('5');
    expect(c.note).toBe('Boats over early or away from the line are left out (listed below).');
    expect(startCompareHtml(c, null)).toContain('<p class="cmp-note">Boats over early or away from the line are left out (listed below).</p>');
  });

  it('with one clean starter, just the best; with none, nothing', () => {
    const others = Object.fromEntries(base.boats.filter((b) => b.id !== '6').map((b) => [b.id, { start: { startPlace: null } }]));
    const one = buildFindings(withBoats(others)).find((x) => x.compare)!;
    expect(one.compare!.worst).toBeNull();
    expect(one.boatIds).toEqual(['6']);
    expect(one.text).not.toContain('Worst');
    expect(startCompareHtml(one.compare!, null)).toContain('aria-label="Best start"');
    expect(startCompareHtml(one.compare!, null)).not.toContain('Worst');
    const none = buildFindings(withBoats({ ...others, '6': { start: { startPlace: null } } }));
    expect(none.some((x) => x.compare)).toBe(false);
  });
});

describe('over early, not flagged OCS', () => {
  const over = (rank: StartResult['rank'], name: string): RaceAnalysis =>
    withBoats({ '3': { sail: 'USA 019', name, start: { over: true, ocs: false, startPlace: null, rank } } });

  it('by Vakaros DTL, with the boat name', () => {
    expect(startTexts(over({ m: -2.34, source: 'vakaros' }, 'Balthasar'))).toContain('#USA 019 (Balthasar) was over 2.3 m by Vakaros DTL (not flagged OCS)');
  });

  it('by our track estimate, and no parentheses without a boat name', () => {
    expect(startTexts(over({ m: -0.96, source: 'ours' }, '#USA 019'))).toContain('#USA 019 was over 1.0 m by our track estimate (not flagged OCS)');
  });

  it('a flagged boat still reads as OCS', () => {
    const a = withBoats({ '3': { start: { over: true, ocs: true, startPlace: null, rank: { m: -1, source: 'vakaros' } } } });
    expect(startTexts(a)).toContain('#3 was flagged OCS by race control.');
  });
});
