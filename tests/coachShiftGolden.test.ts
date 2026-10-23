import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw, rivalLadder, type CoachModel } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { coachCtx } from '../src/analysis/coach/detectors/context';
import { D5_GAIN_S, D5_LOSS_S, d5Peers, gapReads, swings } from '../src/analysis/coach/detectors/consolidate';
import { typicalSep } from '../src/analysis/coach/detectors/early';
import { legWindow } from '../src/analysis/coach/detectors/shift';
import { gapNoise, untrackedS, type GapReading } from '../src/analysis/coach/opportunity';
import type { RaceAnalysis } from '../src/analysis/types';
import type { RaceData } from '../src/data/types';
import { cardHtml, cardText, d5RefChip, secondsChip, windowChip } from '../src/ui/coachCards';
import { j105Race } from './helpers';

/**
 * Coach phase 3 against the Good Trade debrief (2026 J/105 CBC, Oct 18; EDT = UTC−4): the wind detectors
 * D4 (wrong side of a shift) and D5 (gains not banked / overstand), through the app's own path.
 *
 * Their seconds are the chart's (the gap at equal course progress, timeGap.ts groupGap, with the card's boats as the
 * group): a card never tells another story than the chart. The debrief was written off the same-moment wind ladder,
 * which credits a shift as it happens; the chart takes one wind for the whole leg, so a side that "paid first" in a
 * shift shows less. Each test says what the numbers were on the ladder.
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

/** The chart (Custom: the reading's boats) at the reading's two points: the bold line, or `boat`'s thin line. */
function chartAt(m: CoachModel, a: RaceAnalysis, g: GapReading): [number | null, number | null] {
  const l = rivalLadder(m, a, GT, { kind: 'custom', ids: g.ids })!;
  const k = g.boat != null ? l.group.indexOf(g.boat) : -1;
  const at = (t: number) => {
    const p = l.points.find((q) => q.tMs === t);
    return p ? (k >= 0 ? p.each[k] : p.behindS) : null;
  };
  return [at(g.t0), at(g.t1)];
}

describe('D4 golden: race 2 Beat 1, the wrong side of a 15° left shift (debrief ≈ 85 s; the chart ≈ 60 s)', () => {
  const { a, model, d } = setup(j105Race(2));
  const o = d.found.find((x) => x.kind === 'D4')!;
  const c = d.cards.find((x) => x.kind === 'D4')!;

  it('found: ≈ 60 s vs Mirage and Crescendo, who held left — the chart with them as the group, its first point to its last', () => {
    // Got 59.7 s: 43.2 s behind at 12:26:01 → 102.8 s at 12:34:51. On the wind ladder it was 89.9 s vs Mirage alone
    // (+63 → +153 s, 12:26:55–12:35:55; debrief: 31 s + 54 s over minutes 1–9).
    expect(Math.abs(o.seconds - 60)).toBeLessThanOrEqual(5);
    expect(o.refBoats.map((id) => name(a, id))).toEqual(['Mirage', 'Crescendo']);
    const [g] = o.gaps!;
    expect(g.ids).toEqual(o.refBoats);
    const [c0, c1] = chartAt(model, a, g);
    expect([c0, c1]).toEqual([g.g0, g.g1]);
    expect(o.seconds).toBeCloseTo(g.g1 - g.g0, 9);
    expect([o.t0, o.t1]).toEqual([g.t0, g.t1]);
    expect(o.confidence).toBe('high');
    expect(o.t0).toBeGreaterThanOrEqual(edt('12:25:56')); // after Good Trade crossed the line (D1 owns the start)
    expect(o.t1).toBeLessThanOrEqual(edt('12:37:00'));
  });

  it('facts: the wind backed 30° → 15°, Good Trade right, headed far more than Mirage', () => {
    // The window now starts at 12:26:01 (was 12:26:55: 33° → 19°): the same shift, read from the chart's first point.
    // The wind is read at the chart points the seconds read, 12:26:01 and 12:34:51: 29.7° → 15.1° (at the window's own
    // ends, up to 10 s before each point, the chips said "29° → 15°" and the title a 14° shift).
    expect(o.facts.dir).toBe('left');
    expect(o.facts.side).toBe('right');
    expect(o.facts.otherSide).toBe('left');
    expect(Math.round(o.facts.twd0 as number)).toBe(30);
    expect(o.facts.twd0).toBe(model.wind.twdAt(o.t0));
    expect(o.facts.twd1).toBe(model.wind.twdAt(o.t1));
    expect(o.facts.shift as number).toBeGreaterThanOrEqual(12);
    expect(o.facts.ldr).toBe('Mirage');
    // Debrief: 18 % vs 2 % (over the whole race's upwind time on the full-rate data); the window here.
    expect(o.facts.headed as number).toBeGreaterThanOrEqual(0.1);
    expect(o.facts.ldrHeaded as number).toBeLessThanOrEqual(0.05);
  });

  it('renders the §6 template; the card is #2, after the start, and keeps what the start card does not claim', () => {
    const t = cardText(c, a.meta.tzOffsetMs);
    expect(t.title).toBe('Wrong side of a 15° left shift');
    expect(t.chips[0]).toBe('wind 30° → 15°');
    expect(t.chips[1]).toMatch(/^headed \d+% vs Mirage 0%$/);
    expect(t.sentence).toMatch(/^You went right while the leaders held left; the wind backed 15°/);
    expect(t.tip).toContain('on a header more than 30 s, tack');
    expect(windowChip(c, a)).toBe('12:26–12:34');
    // The start card (71 s: the crossing's 47 s + the early lane's 24 s, 12:26–12:31) ranks first now, so D4 gives up the
    // minutes they share: 26 s of its 60 shown (was the other way round: D4 ≈ 90 s first, the start ≈ 51 s).
    expect(d.cards.map((x) => x.kind)).toEqual(['D1', 'D4', 'D7']);
    expect(c.seconds).toBeLessThan(o.seconds);
    expect(secondsChip(c)).toBe('≈ 26 s');
  });

  it('the early-lane D3 (24 s, same minutes) rides on the start card; the start keeps it, the crossing\'s 47 s untouched', () => {
    // D1 fired (64 m back): the D3 after it merges into the start card, its seconds a part of their own.
    expect(d.found.some((x) => x.kind === 'D3')).toBe(false);
    const start = d.found.find((x) => x.kind === 'D1')!;
    // Got 24.4 s on the chart (Top 3: 42.6 → 67.0 s, 12:26:01–12:30:51); on the wind ladder it was 19 s.
    expect(Math.round(start.facts.d3S as number)).toBe(24);
    expect(start.parts).toHaveLength(2);
    const card = d.cards.find((x) => x.kind === 'D1')!;
    expect(card.seconds).toBeCloseTo(start.seconds, 9);
    expect(card.seconds).toBeCloseTo((start.facts.d1S as number) + (start.facts.d3S as number), 6);
  });
});

describe('D5 golden: race 3 Beat 2, overstood the left corner (debrief ≈ 180 s; the chart ≈ 85 s)', () => {
  const { a, model, d } = setup(j105Race(3));
  const c = d.cards.find((x) => x.kind === 'D5')!;

  it('≈ 85 s on the boats that finished just ahead: 12 s behind at 2:56 pm → 98 s by 3:00 pm, as the chart has it', () => {
    expect(c.variant).toBe('overstand');
    // Got 85.4 s: 12.5 s behind at 14:56:01 → 97.9 s at 15:00:01, the chart's points with the 4th–9th as the group
    // (coachGolden: 12.5 s at 2:56 pm, ≈ 98 s by 3 pm). On the wind ladder it was 184.3 s: −68 s (ahead) at
    // 2:55:54 pm → +117 s at 2:59:54 pm (debrief: +67 s → −116 s): the ladder credits the left shift as it happens,
    // the chart (one wind for the leg) doesn't, so the corner never shows as a lead.
    expect(Math.abs(c.seconds - 85)).toBeLessThanOrEqual(5);
    expect(c.facts.gPeak as number).toBeCloseTo(12.5, 0);
    expect(Math.abs((c.facts.gTrough as number) - 98)).toBeLessThanOrEqual(2);
    const [g] = c.gaps!;
    expect([g.t0, g.t1]).toEqual([edt('14:56:01'), edt('15:00:01')]);
    expect(chartAt(model, a, g)).toEqual([g.g0, g.g1]);
    expect(c.seconds).toBeCloseTo(g.g1 - g.g0, 9);
    // The official 4th–9th (Juggernaut DSQ) = the tracked 5th–10th: the 6 places a banked gain could have taken.
    expect(c.refBoats.map((id) => name(a, id))).toEqual(['Santas Reign, Dear', 'Patriot', 'Relentless', 'Constellation', "Smoke 'n Oakum", 'Dragonfly']);
    expect(d5Peers(coachCtx(a, model, GT)!).ahead).toBe(true);
    // The 1 km split's ±3° wind term (≈ ±57 s) is wider than the 85 s itself: low (was medium on 184 s); ⚠ wind est.
    expect(c.confidence).toBe('low');
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

  it('renders the §6 overstand template: the closest it got (still behind), not a lead; a vs-peers chip (not the page Top 3)', () => {
    const t = cardText(c, a.meta.tzOffsetMs);
    expect(t.title).toBe('Overstood the left corner');
    expect(t.sentence).toBe('The left paid first: you closed to 12 s behind the boats that finished 5th–10th; then the wind swung back 12° and you were 98 s down.');
    expect(t.chips).toEqual(['1078 m left', 'layline from 1760 m', '12 s down → 98 s down']);
    expect(d5RefChip(c.facts)).toBe('vs 5th–10th');
    expect(cardHtml(c, 2, a, false)).toContain('vs 5th–10th');
    expect(t.tip).toContain('tack on the next header');
  });

  it('the ±3° wind term uses typical (start/mid/end) sep, not the 1 km peak', () => {
    // Peak-only sep (1078 m) would add its full wind term; mid-window the boats are ~700 m apart.
    const ctx = coachCtx(a, model, GT)!;
    const untracked = untrackedS(ctx.tr.t, c.t0, c.t1);
    const typical = gapNoise(typicalSep(ctx, c.refBoats, c.t0, c.t1), model.vmg[2], untracked).noise;
    expect(c.secondsHi - c.seconds).toBeCloseTo(typical, 6);
    expect(gapNoise(c.facts.sepM as number, model.vmg[2], untracked).noise).toBeGreaterThan(typical);
    expect(secondsChip(c)).toBe('29–142 s');
  });

  it('the D4 read of the same swing is left to D5; the phase-2 cards rank ahead of the low-confidence D5 (D7, D3)', () => {
    // Was D5 (184 s, medium) first: now its score is 0.4 × 60 (a low card counts up to LOW_IMPACT_CAP_S).
    expect(d.cards.map((x) => x.kind)).toEqual(['D7', 'D3', 'D5']);
    expect(d.cards.filter((x) => x.kind === 'D4')).toEqual([]);
  });
});

describe('D5 golden: race 1, caught Patriot, then let him go (debrief ≈ 32 s): under the thresholds on the chart', () => {
  const { a, model, d } = setup(j105Race(1));
  const ctx = coachCtx(a, model, GT)!;

  it('Patriot\'s line on the chart: 27.6 s behind → 9.8 s (11:15:01) → 39 s (11:18:21): a gain under D5_GAIN_S, a loss under D5_LOSS_S, no card', () => {
    // On the wind ladder Good Trade drew level from ~31 s back and lost 45 s by 11:18:40 (a medium card, 45 s, #1).
    // On the chart (Patriot's own line, as positions are read) the same story is smaller: 17.8 s gained, 29.2 s lost.
    const [a0, b0] = legWindow(ctx.tr, 0)!;
    const pts = ctx.gaps(ctx.leaders, a0, b0);
    const k = ctx.leaders.indexOf('USA 242');
    const reads = gapReads(pts, 0, a0, b0, (p) => p.each[k], ctx.tr.t);
    const at = (hhmmss: string) => reads.find((r) => r.t === edt(hhmmss))!.g;
    expect(at('11:08:01')).toBeCloseTo(27.6, 1);
    expect(at('11:15:01')).toBeCloseTo(9.8, 1);
    expect(at('11:18:21')).toBeCloseTo(39.0, 1);
    expect(at('11:08:01') - at('11:15:01')).toBeLessThan(D5_GAIN_S);
    expect(at('11:18:21') - at('11:15:01')).toBeLessThan(D5_LOSS_S);
    expect(swings(reads)).toEqual([]);
    expect(d.found.some((o) => o.kind === 'D5')).toBe(false);
  });

  it('the debrief\'s own checkpoint still holds: ≈ 34 s behind Patriot at 11:16–11:17', () => {
    // The debrief's 32 s is the gap at 11:40 after the gun (its readable data ended at 12:40); the chart's Patriot line
    // averages 30 s over 11:16:10–11:17:10 (the ladder: 34 s).
    const pts = ctx.gaps(['USA 242'], edt('11:16:10'), edt('11:17:10'));
    const v = pts.map((p) => p.each[0]).filter((x): x is number => x != null);
    expect(Math.abs(v.reduce((s, x) => s + x, 0) / v.length - 34)).toBeLessThanOrEqual(5);
  });

  it('one card: the early-lane D3 (the debrief had D5 and D3)', () => {
    expect(d.cards.map((x) => x.kind)).toEqual(['D3']);
  });
});
