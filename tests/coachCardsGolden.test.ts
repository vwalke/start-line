import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { CROSS_TO_MS, buildCoach, coachRaw, rivalLadder } from '../src/analysis/coach';
import { coachDebrief, type CoachDebrief } from '../src/analysis/coach/debrief';
import { coachCtx } from '../src/analysis/coach/detectors/context';
import { detectLastLeg } from '../src/analysis/coach/detectors/lastLeg';
import { MIN_SECONDS } from '../src/analysis/coach/opportunity';
import type { RaceAnalysis } from '../src/analysis/types';
import type { RaceData } from '../src/data/types';
import { coachChips, ladderChart } from '../src/ui/coach';
import { cardSpans, cardText, coachCardsHtml, secondsChip, windowChip } from '../src/ui/coachCards';
import { c31Race, fixtureRace, j105Race, j88Race, m24Race } from './helpers';

/**
 * Coach phase 2 against the Good Trade debrief (2026 J/105 CBC, Oct 18; EDT = UTC−4), through the app's own
 * path: the worker's raw half (coachRaw: the wind and the start crossings from the raw fixes), the model on
 * the drawn tracks, then the debrief. Tolerance ±10 s where the fixture supports the item.
 * D4/D5 (shifts, consolidation) are phase 3, so the debrief's R1 #2, R2 #1 and R3 #1 are not expected here.
 */
const GT = 'USA 96';
const edt = (hhmmss: string): number => Date.parse(`2026-10-18T${hhmmss}-04:00`);

function setup(data: RaceData, boat = GT) {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  const model = buildCoach(a, raw.wind, raw.crossMs)!;
  return { a, model, d: coachDebrief(a, model, boat)! };
}

const card = (d: CoachDebrief, kind: string) => d.cards.find((c) => c.kind === kind);

describe('Coach golden: Good Trade race 1 (gun 11:05 EDT)', () => {
  const { a, model, d } = setup(j105Race(1));

  it('#1 "Slow off a great start" ≈ 30 s, with the D2 chip 4.4 vs 7.5 kn Relentless', () => {
    const c = d.cards[0];
    expect(c.kind).toBe('D3');
    expect(c.variant).toBe('slow-start');
    // Got 29.4 s: the median gap to the top 3 (Patriot, Mirage, Crescendo) a minute after the crossing (+5.6 s) → at +5 min.
    expect(c.seconds).toBeGreaterThanOrEqual(30 - 10);
    expect(c.seconds).toBeLessThanOrEqual(30 + 10);
    expect(c.refBoats.map((id) => a.boats.find((b) => b.id === id)!.name)).toEqual(['Patriot', 'Mirage', 'Crescendo']);
    const d2 = c.chips!.find((x) => x.kind === 'D2')!;
    expect(d2.facts.nbrName).toBe('Relentless');
    expect((d2.facts.sog as number).toFixed(1)).toBe('4.4');
    expect((d2.facts.nbrSog as number).toFixed(1)).toBe('7.5');
    const t = cardText(c);
    expect(t.title).toBe('Slow off a great start');
    expect(t.chips).toContain('4.4 vs 7.5 kn Relentless');
    expect(t.chips).toContain('2 tacks by 2:48'); // debrief: "tacked to port at 2:10 … then tacked back"
    expect(t.sentence).toContain('Relentless, bow-level 20 m to windward, rolled you at 7.5 kn and 2 early tacks');
    expect(windowChip(c, a)).toBe('11:05–11:10');
    expect(c.confidence).toBe('high');
  });

  it('D6 does not fire: the ✓ upwind chip, pointing ≈ 39° vs the fleet ≈ 43° (debrief 39 vs 43)', () => {
    expect(d.found.some((o) => o.kind === 'D6')).toBe(false);
    const ok = d.ok.find((n) => n.detector === 'D6')!;
    expect(ok.facts.twa as number).toBeGreaterThanOrEqual(37);
    expect(ok.facts.twa as number).toBeLessThanOrEqual(41);
    expect(ok.facts.fTwa as number).toBeGreaterThanOrEqual(41);
    expect(ok.facts.fTwa as number).toBeLessThanOrEqual(45);
    const html = coachCardsHtml(a, d, null, 0.27);
    expect(html).toContain('✓ Upwind pointing 40° vs fleet 42°');
    // The start itself was fine (D1 measured, did not fire).
    expect(d.ok.some((n) => n.detector === 'D1')).toBe(true);
    // One card only, and it says so.
    expect(d.cards).toHaveLength(1);
    expect(html).toContain('Only 1 clear gain with this data');
  });

  it('the header adds the seconds at stake; a selected card shades its window on the gap chart', () => {
    const me = a.boats.find((b) => b.id === GT)!;
    const l = rivalLadder(model, a, GT, { kind: 'leaders' })!;
    const text = coachChips(a, me, l, d.totalS).map((c) => c.text);
    expect(text).toContain(`≈ ${Math.round(d.totalS)} s at stake`);
    const svg = ladderChart(a, model, l, { kind: 'leaders' }, { widthPx: 900, highlight: cardSpans(d.cards[0]) });
    expect(svg.match(/class="cl-hl"/g)).toHaveLength(1);
    expect(ladderChart(a, model, l, { kind: 'leaders' }, { widthPx: 900 })).not.toContain('cl-hl');
  });
});

describe('Coach golden: Good Trade race 2 (gun 12:25 EDT)', () => {
  const { a, model, d } = setup(j105Race(2));

  it('the start (D1) ≈ 50 s: 64 m back at the gun, 17th of 18 over the line, the front row 6–9 s after the gun', () => {
    const c = card(d, 'D1')!;
    expect(c.variant).toBe('second-row');
    // 55.6 s − the front row's median (5.8, 6.7, 8.6, 12.3, 13.9) = 47 s (start.py on the full data: 55.6 and the same five).
    expect(c.seconds).toBeGreaterThanOrEqual(50 - 10);
    expect(c.seconds).toBeLessThanOrEqual(50 + 10);
    expect(Math.round(c.facts.dtl as number)).toBe(64);
    expect(c.facts.crossRank).toBe(17);
    expect(c.facts.n).toBe(18);
    expect(Math.round(c.facts.crossS as number)).toBe(56);
    expect([Math.round(c.facts.frontLo as number), Math.round(c.facts.frontHi as number)]).toEqual([6, 9]);
    expect(c.facts.favoured).toBe('pin');
    expect(secondsChip(c)).toBe('≈ 47 s');
    expect(d.cards[0].kind).toBe('D1');
  });

  it('the last run (D10): evaluated, but the ladder does not support the debrief’s 10–35 s — no card (see the note)', () => {
    // The debrief's "Crescendo +36 s, Patriot +12 s" came from time-at-distance along the rhumb axis, which
    // ends 55 s behind Crescendo although it finished 42 s ahead. The wind ladder (finish as a line) ends at
    // the true margins and gives Crescendo ≈ +12 s, Patriot ≈ 0 over the run: under the medium minimum (20 s;
    // the marks are estimated from the fleet's turns).
    const ctx = coachCtx(a, model, GT)!;
    const o = detectLastLeg(ctx);
    expect(card(d, 'D10')).toBeUndefined();
    const fin = (id: string) => (a.boats.find((b) => b.id === GT)!.finishMs! - a.boats.find((b) => b.id === id)!.finishMs!) / 1000;
    expect(Math.round(fin('USA 159'))).toBe(42);
    expect(Math.round(fin('USA 242'))).toBe(32);
    // The boats 1–2 places ahead by tracked finish are Crescendo (2nd) and Patriot (3rd).
    const pts = ctx.gaps(['USA 159', 'USA 242'], edt('13:27:30'), edt('13:33:09'));
    const last = (k: number) => pts.filter((p) => p.each[k] != null).at(-1)!.each[k]!;
    expect(Math.abs(last(0) - fin('USA 159'))).toBeLessThan(5);
    expect(Math.abs(last(1) - fin('USA 242'))).toBeLessThan(5);
    if (o) expect(o.seconds).toBeLessThan(MIN_SECONDS.medium);
  });

  it('…the same last-run window does get a card: slow downwind (D7) ≈ 33 s, VMG below the fleet', () => {
    const c = card(d, 'D7')!;
    expect(c.variant).toBe('slow');
    expect(c.t0).toBeGreaterThanOrEqual(edt('13:27:00'));
    expect(c.t1).toBeLessThanOrEqual(edt('13:33:09'));
    expect(c.seconds).toBeGreaterThanOrEqual(20);
    expect(c.seconds).toBeLessThanOrEqual(45);
    expect(c.facts.vmg as number).toBeLessThan(c.facts.fVmg as number);
    expect(c.confidence).toBe('medium');
  });

  it('15 % race coverage still gets a debrief: its start and last run are densely tracked', () => {
    expect(a.boats.find((b) => b.id === GT)!.coverage!).toBeLessThan(0.25);
    expect(d.noData).toBe(false);
    expect(d.cards.length).toBeGreaterThan(0);
  });
});

describe('Coach golden: Good Trade race 3 (gun 14:10 EDT)', () => {
  const { a, d } = setup(j105Race(3));

  it('downwind too deep (D7) 60–80 s: 153° vs the top 3 well higher, slower, VMG below the fleet', () => {
    const c = card(d, 'D7')!;
    expect(c.variant).toBe('deep');
    // Got 70 s (Run 1: VMG 4.1 vs the fleet's 4.4 in the same windows × 999 s). Run 2 fails the 60 % of windows rule.
    expect(c.seconds).toBeGreaterThanOrEqual(60);
    expect(c.seconds).toBeLessThanOrEqual(80);
    expect(c.facts.legs).toBe('Run 1');
    expect(Math.abs((c.facts.twa as number) - 153)).toBeLessThanOrEqual(3);
    // Debrief: top 3 137° (their own leg medians on the full data); the fixture's 4 s fixes give 143.5°.
    expect(c.facts.tTwa as number).toBeLessThanOrEqual(146);
    expect((c.facts.twa as number) - (c.facts.tTwa as number)).toBeGreaterThanOrEqual(8);
    expect(c.facts.sog as number).toBeLessThan(c.facts.tSog as number);
    expect(c.facts.wind).toBe('light');
    expect(cardText(c).title).toBe('Too deep on the light-air run');
    expect(cardText(c).chips[0]).toMatch(/^153° vs top-3 14\d°$/);
  });

  it('early (D3) ≈ 38 s to the leaders (Mirage first): 2 tacks by 3:51 while the fleet held on', () => {
    const c = card(d, 'D3')!;
    expect(c.seconds).toBeGreaterThanOrEqual(38 - 10);
    expect(c.seconds).toBeLessThanOrEqual(38 + 10);
    expect(a.boats.find((b) => b.id === c.refBoats[0])!.name).toBe('Mirage');
    expect(c.variant).toBe('tacks');
    expect(c.facts.tacks).toBe(2);
    expect(c.facts.lastTackS as number).toBeLessThan(240);
    expect(c.facts.fleetTacks).toBeLessThanOrEqual(1);
    expect(windowChip(c, a)).toBe('14:10–14:15');
  });
});

describe('Coach sanity across the other fixtures', () => {
  const races: [string, () => RaceData][] = [
    ['benelux J70 r8', fixtureRace],
    ['m24 r4', m24Race],
    ['j88 r5', j88Race],
    ['c31 r10', () => c31Race()],
  ];
  for (const [name, mk] of races) {
    it(`${name}: no crash; ≤ 3 cards; none under its minimum (≥ 10 s) or from under 25 % data; times inside the race`, () => {
      const data = mk();
      const a: RaceAnalysis = analyzeRace(data);
      const raw = coachRaw(a, data);
      const model = buildCoach(a, raw.wind, raw.crossMs)!;
      expect(model).not.toBeNull();
      for (const t of Object.values(raw.crossMs)) if (t != null) expect(t).toBeLessThanOrEqual(a.meta.gunMs + CROSS_TO_MS);
      // A handful of boats spread over the results (all of a small fleet).
      const ids = a.boats.filter((_, i) => a.boats.length <= 8 || i % 3 === 0).map((b) => b.id);
      let cards = 0;
      for (const id of ids) {
        const d = coachDebrief(a, model, id)!;
        expect(d.cards.length).toBeLessThanOrEqual(3);
        if (d.noData) expect(d.cards).toEqual([]);
        for (const c of d.cards) {
          cards++;
          expect(c.seconds).toBeGreaterThanOrEqual(10);
          expect(c.seconds).toBeGreaterThanOrEqual(MIN_SECONDS[c.confidence]);
          expect(c.coverage).toBeGreaterThanOrEqual(0.25);
          expect(c.confidence).not.toBe('none');
          expect(c.t1).toBeGreaterThanOrEqual(c.t0);
          expect(c.t0).toBeGreaterThanOrEqual(a.meta.gunMs - 10_000);
          const t = cardText(c);
          expect(t.title.length).toBeGreaterThan(0);
          expect(t.chips.length).toBeLessThanOrEqual(3);
          expect(`${t.sentence} ${t.tip} ${t.chips.join(' ')}`).not.toMatch(/NaN|undefined|null/);
        }
        expect(coachCardsHtml(a, d, null, null)).not.toMatch(/NaN|undefined/);
      }
      expect(cards).toBeGreaterThanOrEqual(0);
    });
  }
});
