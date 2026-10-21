import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { coachCtx } from '../src/analysis/coach/detectors/context';
import { d5Peers } from '../src/analysis/coach/detectors/consolidate';
import type { RaceData } from '../src/data/types';
import { cardHtml, cardText, d5RefChip, secondsChip, windowChip } from '../src/ui/coachCards';
import { j105Race } from './helpers';

/**
 * Coach phase 3 against the Good Trade debrief (2026 J/105 CBC, Oct 18; EDT = UTC−4): the wind detectors
 * D4 (wrong side of a shift) and D5 (gains not banked / overstand), through the app's own path.
 */
const GT = 'USA 96';
const edt = (hhmmss: string): number => Date.parse(`2026-10-18T${hhmmss}-04:00`);

function setup(data: RaceData) {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  const model = buildCoach(a, raw.wind, raw.crossMs)!;
  return { a, model, d: coachDebrief(a, model, GT)! };
}
const name = (a: ReturnType<typeof analyzeRace>, id: string) => a.boats.find((b) => b.id === id)!.name;

describe('D4 golden: race 2 Beat 1, the wrong side of a 15° left shift (debrief ≈ 85 s)', () => {
  const { a, d } = setup(j105Race(2));
  const c = d.cards[0];

  it('is the #1 card, ≈ 85 s ±10 vs Mirage, who held left', () => {
    expect(c.kind).toBe('D4');
    // Got 89.9 s: Mirage's gap +63 → +153 s, 12:26:55–12:35:55 (debrief: 31 s + 54 s over minutes 1–9).
    expect(c.seconds).toBeGreaterThanOrEqual(85 - 10);
    expect(c.seconds).toBeLessThanOrEqual(85 + 10);
    // Only Mirage was 100 m+ to the left over the window; Crescendo crossed back, Patriot stayed close.
    expect(c.refBoats.map((id) => name(a, id))).toEqual(['Mirage']);
    expect(c.confidence).toBe('high');
    expect(c.t0).toBeGreaterThanOrEqual(edt('12:25:56')); // after Good Trade crossed the line (D1 owns the start)
    expect(c.t1).toBeLessThanOrEqual(edt('12:37:00'));
  });

  it('facts: the wind backed 33° → 19°, Good Trade right, headed far more than Mirage', () => {
    expect(c.facts.dir).toBe('left');
    expect(c.facts.side).toBe('right');
    expect(c.facts.otherSide).toBe('left');
    expect(Math.round(c.facts.twd0 as number)).toBe(33);
    expect(c.facts.shift as number).toBeGreaterThanOrEqual(12);
    expect(c.facts.ldr).toBe('Mirage');
    // Debrief: 18 % vs 2 % (over the whole race's upwind time on the full-rate data); the window here.
    expect(c.facts.headed as number).toBeGreaterThanOrEqual(0.1);
    expect(c.facts.ldrHeaded as number).toBeLessThanOrEqual(0.05);
  });

  it('renders the §6 template', () => {
    const t = cardText(c, a.meta.tzOffsetMs);
    expect(t.title).toBe('Wrong side of a 14° left shift');
    expect(t.chips[0]).toBe('wind 33° → 19°');
    expect(t.chips[1]).toMatch(/^headed \d+% vs Mirage 0%$/);
    expect(t.sentence).toMatch(/^You went right while the leaders held left; the wind backed 14°/);
    expect(t.tip).toContain('on a header more than 30 s, tack');
    expect(secondsChip(c)).toBe('≈ 90 s');
    expect(windowChip(c, a)).toBe('12:26–12:35');
  });

  it('the early-lane D3 (19 s, same minutes) rides on the start card, and D4 claims most of that part', () => {
    // D1 fired (64 m back): the D3 after it merges into the start card, its seconds a part of their own.
    expect(d.found.some((o) => o.kind === 'D3')).toBe(false);
    const start = d.found.find((o) => o.kind === 'D1')!;
    expect(Math.round(start.facts.d3S as number)).toBe(19);
    expect(start.parts).toHaveLength(2);
    const c = d.cards.find((x) => x.kind === 'D1')!;
    // D4 holds most of the D3 part (Beat 1's first minutes); the crossing's 47 s are untouched.
    expect(c.seconds - (start.facts.d1S as number)).toBeLessThan(19 / 2);
    expect(c.seconds).toBeGreaterThanOrEqual(start.facts.d1S as number);
  });
});

describe('D5 golden: race 3 Beat 2, overstood the left corner (debrief ≈ 180 s, #1)', () => {
  const { a, model, d } = setup(j105Race(3));
  const c = d.cards[0];

  it('is the #1 card, ≈ 180 s ±25 on the boats that finished just ahead', () => {
    expect(c.kind).toBe('D5');
    expect(c.variant).toBe('overstand');
    // Got 184.3 s: −68 s at 2:55:54 pm → +117 s at 2:59:54 pm (debrief: +67 s → −116 s on the 4th–9th boats).
    expect(c.seconds).toBeGreaterThanOrEqual(180 - 25);
    expect(c.seconds).toBeLessThanOrEqual(180 + 25);
    expect(Math.round(-(c.facts.gPeak as number))).toBeGreaterThanOrEqual(57);
    expect(Math.round(-(c.facts.gPeak as number))).toBeLessThanOrEqual(77);
    expect(c.facts.gTrough as number).toBeGreaterThanOrEqual(106);
    expect(c.facts.gTrough as number).toBeLessThanOrEqual(126);
    // The official 4th–9th (Juggernaut DSQ) = the tracked 5th–10th: the 6 places a banked gain could have taken.
    expect(c.refBoats.map((id) => name(a, id))).toEqual(['Santas Reign, Dear', 'Patriot', 'Relentless', 'Constellation', "Smoke 'n Oakum", 'Dragonfly']);
    expect(d5Peers(coachCtx(a, model, GT)!).ahead).toBe(true);
    // Marks estimated from the fleet's turns: medium at most; the 1 km split shows ⚠ wind est.
    expect(c.confidence).toBe('medium');
    expect(c.windEst).toBe(true);
  });

  it('facts: 1.1 km left, layline from ~1.8 km, the wind swung back 12°+', () => {
    expect(c.facts.side).toBe('left');
    expect(c.facts.sepM as number).toBeGreaterThan(1000);
    expect(c.facts.layFromM as number).toBeGreaterThan(1600);
    expect(c.facts.layFromM as number).toBeLessThan(1900);
    expect(c.facts.shift as number).toBeGreaterThanOrEqual(12);
    expect(c.facts.dir).toBe('right');
    expect(c.t0).toBeGreaterThanOrEqual(edt('14:55:00'));
    expect(c.t1).toBeLessThanOrEqual(edt('15:00:30'));
  });

  it('renders the §6 overstand template, with a vs-peers chip (not the page Top 3)', () => {
    const t = cardText(c, a.meta.tzOffsetMs);
    expect(t.title).toBe('Overstood the left corner');
    expect(t.sentence).toBe('The left paid first, 68 s up on the boats that finished 5th–10th; then the wind swung back 12° and you were 117 s down.');
    expect(t.chips).toEqual(['1085 m left', 'layline from 1760 m', '68 s up → 117 s down']);
    expect(d5RefChip(c.facts)).toBe('vs 5th–10th');
    expect(cardHtml(c, 0, a, false)).toContain('vs 5th–10th');
    expect(t.tip).toContain('tack on the next header');
  });

  it('the ±3° wind term uses typical (start/mid/end) sep, not the 1 km peak, so the chip is ≈ 184 s', () => {
    // Peak-only sep was 1085 m → 119–249 s (hi/lo > 2). Mid-window the boats are 709 m apart
    // and the trough has no fix; typicalSep is the same D3 fix.
    expect(c.secondsHi / Math.max(1, c.secondsLo)).toBeLessThanOrEqual(2);
    expect(secondsChip(c)).toBe('≈ 184 s');
    expect(c.windEst).toBe(true);
  });

  it('the D4 read of the same swing is left to D5; the phase-2 cards follow (D7, D3)', () => {
    expect(d.cards.map((x) => x.kind)).toEqual(['D5', 'D7', 'D3']);
    expect(d.cards.filter((x) => x.kind === 'D4')).toEqual([]);
  });
});

describe('D5 golden: race 1, caught Patriot, then let him go (debrief ≈ 32 s)', () => {
  const { a, model, d } = setup(j105Race(1));
  const c = d.cards.find((x) => x.kind === 'D5')!;

  it('caught-leader vs Patriot: level at ~11:14, 400 m apart, Patriot pulling away on a right-hand lift', () => {
    expect(c.variant).toBe('caught-leader');
    expect(c.refBoats.map((id) => name(a, id))).toEqual(['Patriot']);
    expect(Math.abs(c.facts.gPeak as number)).toBeLessThanOrEqual(10);
    expect(c.t0).toBeGreaterThanOrEqual(edt('11:13:30'));
    expect(c.t0).toBeLessThanOrEqual(edt('11:15:00'));
    expect(c.facts.sepM as number).toBeGreaterThanOrEqual(300);
    expect(c.facts.dir).toBe('right');
    expect(c.facts.side).toBe('left');
    expect(c.facts.tacked).toBe(1);
    expect(cardText(c, a.meta.tzOffsetMs).title).toBe('Caught the leader, then tacked away');
  });

  it('…≈ 45 s, not 32: the debrief stopped at 11:40 race time; the ladder keeps losing to the top of the beat', () => {
    // The debrief's 32 s is the gap at 11:40 after the gun (its readable data ended at 12:40). On the full raw
    // data the prototype ladder (charts.py) reads 39 s at 12:40 and 52 s at 14:40; the debrief booked that
    // growth as its item #3 ("top of Beat 1 and the rounding, 15–20 s, low confidence"). The fixture reads the
    // trough at 13:30 (49 s), inside 6 min of the peak and where the track still covers half of each 2 min,
    // so D5's seconds are peak → trough = 45 s. The debrief's own checkpoint matches within a few seconds:
    const ctx = coachCtx(a, model, GT)!;
    const pts = ctx.gaps(['USA 242'], edt('11:16:10'), edt('11:17:10'));
    const v = pts.map((p) => p.each[0]).filter((x): x is number => x != null);
    expect(Math.abs(v.reduce((s, x) => s + x, 0) / v.length - 34)).toBeLessThanOrEqual(5);
    expect(c.seconds).toBeGreaterThanOrEqual(35);
    expect(c.seconds).toBeLessThanOrEqual(55);
    expect(c.facts.tTrough as number).toBeLessThanOrEqual(edt('11:18:40'));
    // Medium (Patriot's 4 s fixes leave it 50–80 % covered by the Coach's measure; the marks are estimated).
    expect(c.confidence).toBe('medium');
  });

  it('ranks #1 by score (45 × 0.7 = 31.8) just ahead of the early-lane D3 (29.4 × 1.0); the debrief had them the other way', () => {
    expect(d.cards.map((x) => x.kind)).toEqual(['D5', 'D3']);
  });
});
