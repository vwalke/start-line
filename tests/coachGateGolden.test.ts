/**
 * D13 golden: the gate choice on the committed whole-fleet fixtures (scripts/make-fixture.mjs --preset gate-<key>:
 * 1 Hz within ±6 min of each boat's gate rounding, every 10 s elsewhere). The investigation's prototype
 * (inputs/gate.py, on the full-rate cache) is the reference: the favoured buoy, its offset Δ and the side difference
 * are reproduced within a few metres / seconds. Where the fixture can't reproduce a prototype figure the test says why:
 * - Viper 640 R2: the prototype's "gate rounding" is the finish (every boat's rounding time is its finish time; its
 *   "beat" is sailing back after finishing). The race was beat → run → finish past the gate: no gate leg, no D13.
 * - J/24 R2: the wind veered ~15° (299° → 314°) over the 10 minutes the fleet rounded the gate, so its cards are low
 *   confidence (the design's downgrade); a low card needs 30 s and scores 0.4, so not every ➖ makes a boat's top 3.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { RaceAnalysis } from '../src/analysis/types';
import { buildCoach, coachRaw, type CoachModel } from '../src/analysis/coach';
import { coachCtx } from '../src/analysis/coach/detectors/context';
import { detectGate, raceGates, type GateRead } from '../src/analysis/coach/detectors/gate';
import { gateGeoms } from '../src/analysis/coach/gateSides';
import { coachDebrief, type CoachDebrief } from '../src/analysis/coach/debrief';
import { legStories } from '../src/analysis/coach/legStory';
import { GATE_THEME, raceDigest, summarizeRegatta } from '../src/analysis/coach/regatta';
import { cardText, cardWarnings, goodTexts, wentText } from '../src/ui/coachCards';
import { legStoryText } from '../src/ui/coachLegs';
import { askFinding, askLeg } from '../src/ui/coachAskContext';
import { legsTable } from '../src/ui/table';
import { gateRace, GATE_RACES } from './helpers';

type Key = keyof typeof GATE_RACES;
const cache = new Map<Key, { a: RaceAnalysis; m: CoachModel; gates: GateRead[] }>();
function race(key: Key) {
  let r = cache.get(key);
  if (!r) {
    const data = gateRace(key);
    const a = analyzeRace(data);
    const raw = coachRaw(a, data);
    const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null, raw.turns ?? null, raw.overStart ?? null)!;
    const gates = raceGates(a, m, coachCtx(a, m, a.boats[0].id)!.loaM);
    cache.set(key, (r = { a, m, gates }));
  }
  return r;
}
const idOf = (a: RaceAnalysis, sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
const debOf = (key: Key, sail: string): CoachDebrief => {
  const { a, m } = race(key);
  return coachDebrief(a, m, idOf(a, sail))!;
};
const d13 = (d: CoachDebrief) => ({
  found: d.found.filter((o) => o.kind === 'D13'),
  card: d.cards.find((c) => c.kind === 'D13') ?? null,
  plus: d.plus.filter((p) => p.detector === 'D13'),
  ok: d.ok.filter((p) => p.detector === 'D13'),
});
/** Every boat's D13 output in a race (full debrief: cards, Went well, ✓). */
const fleetD13 = (key: Key) => {
  const { a, m } = race(key);
  return a.boats.map((b) => ({ sail: b.sail, ...d13(coachDebrief(a, m, b.id)!) }));
};
/** D13 only: whether the detector itself fired (no full debrief of every boat). */
const fleetDetect = (key: Key) => {
  const { a, m } = race(key);
  return a.boats.map((b) => {
    const r = detectGate(coachCtx(a, m, b.id)!);
    return { sail: b.sail, found: r.opps, plus: r.good, ok: r.notes };
  });
};

describe('D13 golden: J/24 Nationals R2 (favoured right, confirmed; the wind veered through the roundings)', { timeout: 20_000 }, () => {
  it('reads the gate as the prototype did: right buoy 17 m further upwind, right quicker by ~31 s (24 right / 9 left)', () => {
    const [g] = race('j24r2').gates;
    expect(g.leg).toBe(1);
    expect(g.twdFrom).toBe('tacks');
    expect(g.twd).toBeGreaterThan(305);
    expect(g.twd).toBeLessThan(313); // prototype 309°
    expect(g.fav).toBe('right');
    expect(g.deltaM).toBeGreaterThan(14);
    expect(g.deltaM).toBeLessThan(20); // prototype 17 m
    expect(g.beatS!).toBeGreaterThan(7);
    expect(g.beatS!).toBeLessThan(11); // prototype 8.7 s
    expect(g.empS!).toBeGreaterThan(26);
    expect(g.empS!).toBeLessThan(35); // prototype 30.5 s
    expect(g.confirmed).toBe(true);
    expect(g.n).toEqual({ left: 9, right: 24 });
    expect(g.evaluated).toBe(true);
  });

  it('➖ for the left-buoy boats that lost through the passage (USA 2607, 3479, 3359, 3361, …), low confidence: the wind moved', () => {
    const all = fleetD13('j24r2');
    const fired = all.filter((b) => b.found.length).map((b) => b.sail);
    for (const s of ['USA 2607', 'USA 3479', 'USA 3359', 'USA 3361', 'USA 1938', 'USA 5354', 'USA 5274']) expect(fired).toContain(s);
    // Only left-buoy boats get a ➖.
    const { gates } = race('j24r2');
    const { a } = race('j24r2');
    for (const s of fired) expect(gates[0].boats.get(idOf(a, s))!.side).toBe('left');
    for (const b of all.filter((x) => x.found.length > 0 && ['USA 2607', 'USA 3479', 'USA 3359', 'USA 3361'].includes(x.sail))) {
      expect(b.found[0].seconds).toBeGreaterThan(28);
      expect(b.found[0].seconds).toBeLessThan(34);
      expect(b.found[0].facts.shift).toBe(1);
    }
  });

  it("USA 2607's card is the design's example: left mark, 17 m, ~9 s on the beat, ~46 s quicker on the right, ~10 places", () => {
    const { a } = race('j24r2');
    const d = d13(debOf('j24r2', 'USA 2607'));
    expect(d.card).not.toBeNull();
    expect(d.card!.confidence).toBe('low');
    const t = cardText(d.card!);
    expect(t.title).toBe('Unfavored gate mark (left)');
    expect(t.sentence).toMatch(/^Leeward gate: took the left mark \(looking upwind\) — 17 m further downwind, about 9 s on the beat\. Boats rounding the right mark at the same time were 4[5-8] s quicker 300 m up the beat; you lost (9|10) places\./);
    // Four boats rounded the right buoy just ahead of it, and were still ~40 s quicker: no traffic excuse.
    expect(d.card!.facts.traffic).toBe(4);
    expect(t.sentence).toMatch(/The right mark was busy \(4 boats just ahead\), but they were still \d+ s quicker\./);
    expect(cardWarnings(d.card!, a)).toEqual(['low confidence', 'wind shifting']);
    // Seconds: the side difference; range from the beat-only geometry to its own loss.
    expect(d.card!.secondsLo).toBeGreaterThan(7);
    expect(d.card!.secondsHi).toBeGreaterThan(44);
  });

  it('➕ for the right-buoy boats that gained places (USA 4104/79/4047 +9, USA 537 +8, USA 4103 +8); the busy-buoy ➕ for USA 2246', () => {
    const all = fleetD13('j24r2');
    const plus = (s: string) => all.find((b) => b.sail === s)!.plus;
    for (const [s, n] of [
      ['USA 4104/79/4047', 9],
      ['USA 537', 8],
      ['USA 4103', 8],
    ] as const) {
      expect(plus(s).map((p) => p.variant)).toEqual(['fav']);
      expect(wentText(plus(s)[0])).toBe(`Leeward gate: took the favored right mark (17 m further upwind) and gained ${n} places`);
    }
    expect(wentText(plus('USA 2246')[0])).toBe('Leeward gate: favored gate was busy (5 boats ahead) — the clear one was reasonable; gained 1 place');
  });

  it('the legs table marks every boat’s buoy on Run 1 (looking upwind), and the leg story says it', () => {
    const { a, m } = race('j24r2');
    const html = legsTable(a, null);
    expect(html.match(/>Gate L</g)?.length).toBe(9);
    expect(html.match(/>Gate R</g)?.length).toBe(24);
    const s = legStories(a, m, idOf(a, 'USA 2607'), { kind: 'leaders' })[1];
    expect(s.gate).toEqual({ side: 'left', left: 9, right: 24 });
    const t = legStoryText(s, a, idOf(a, 'USA 2607'), { kind: 'leaders' });
    expect(t.summary.map((c) => c.text)).toContain('Gate L');
    expect(t.lines.flat().map((c) => c.text)).toEqual(expect.arrayContaining(['left gate 9 · right gate 24', 'you left']));
    // Ask Coach reads the same chips.
    expect(askLeg(s, a, idOf(a, 'USA 2607'), { kind: 'leaders' }).summary).toContain('Gate L');
    // No gate at the end of the beats.
    expect(legStories(a, m, idOf(a, 'USA 2607'), { kind: 'leaders' })[0].gate).toBeNull();
  });
});

describe('D13 golden: J/24 Nationals R5 (favoured left, confirmed, steady wind)', { timeout: 20_000 }, () => {
  it('reads the gate as the prototype did: left buoy 34 m further upwind, left quicker by ~28 s (20 left / 12 right)', () => {
    const [g] = race('j24r5').gates;
    expect(g.fav).toBe('left');
    expect(g.deltaM).toBeGreaterThan(31);
    expect(g.deltaM).toBeLessThan(37); // prototype 34 m
    expect(g.beatS!).toBeGreaterThan(15);
    expect(g.beatS!).toBeLessThan(21); // prototype 19 s (its VMG 1.78 m/s from the passage; the fleet's beat VMG here 1.9)
    expect(g.empS!).toBeGreaterThan(24);
    expect(g.empS!).toBeLessThan(33); // prototype 28.1 s
    expect(g.confirmed).toBe(true);
    expect(g.n).toEqual({ left: 20, right: 12 });
  });

  it('➖ cards, high confidence, for USA 5208 (−8 places), USA 3969 (−5) and USA 3479; seconds = the side difference', () => {
    for (const [s, lost] of [
      ['USA 5208', 8],
      ['USA 3969', 5],
      ['USA 3479', 4],
    ] as const) {
      const d = d13(debOf('j24r5', s));
      expect(d.card, s).not.toBeNull();
      expect(d.card!.confidence).toBe('high');
      expect(d.card!.seconds).toBeGreaterThan(24);
      expect(d.card!.seconds).toBeLessThan(33);
      expect(cardText(d.card!).sentence).toContain(`took the right mark (looking upwind) — 34 m further downwind, about 18 s on the beat`);
      expect(cardText(d.card!).sentence).toContain(`you lost ${lost} places`);
    }
  });

  it("D9's sparse-data places at the gate ride on USA 5208's D13 card as a chip, not a card of their own", () => {
    const deb = debOf('j24r5', 'USA 5208');
    const d = d13(deb);
    expect(d.card!.chips?.map((c) => c.kind)).toEqual(['D9']);
    expect(deb.found.some((o) => o.kind === 'D9' && o.facts.mode === 'places' && o.facts.leg === 'Run 1')).toBe(false);
    expect(cardText(d.card!).chips[2]).toMatch(/^\d+(st|nd|rd|th) → \d+(st|nd|rd|th) of 33 at the mark$/);
    expect(deb.cards.filter((c) => c.kind === 'D9' && c.facts.leg === 'Run 1')).toEqual([]);
  });

  it('➕ for the left-buoy gainers (USA 3361 +8, USA 2246 +5); USA 2736 took the clear right buoy in traffic and gained', () => {
    const all = fleetD13('j24r5');
    const plus = (s: string) => all.find((b) => b.sail === s)!.plus;
    expect(wentText(plus('USA 3361')[0])).toBe('Leeward gate: took the favored left mark (34 m further upwind) and gained 8 places');
    expect(wentText(plus('USA 2246')[0])).toBe('Leeward gate: took the favored left mark (34 m further upwind) and gained 5 places');
    expect(plus('USA 2736').map((p) => p.variant)).toEqual(['traffic']);
    // USA 2918: the clear buoy in traffic, places gained but slower than the left's contemporaries: ✓, not ➕.
    const ok = all.find((b) => b.sail === 'USA 2918')!.ok;
    expect(ok.flatMap(goodTexts)).toEqual(['Leeward gate: favored gate was busy (3 boats ahead) — the clear one was reasonable; gained 4 places']);
  });

  it('Ask Coach carries the D13 card like any other', () => {
    const { a } = race('j24r5');
    const deb = debOf('j24r5', 'USA 5208');
    const f = askFinding(d13(deb).card!, a, deb.raceCov);
    expect(f.title).toBe('Unfavored gate mark (right)');
    expect(f.what).toContain('took the right mark (looking upwind)');
    expect(f.confidence).toBe('high');
  });

  it('the Regatta view: gate choice is a subtheme of the leeward roundings, out of the races D13 judged a gate in', () => {
    const races = (['j24r2', 'j24r5'] as const).map((key, i) => {
      const { a, m } = race(key);
      return { raceNumber: i + 1, label: `R${GATE_RACES[key].raceNumber}`, name: `Race ${GATE_RACES[key].raceNumber}`, status: 'done' as const, digest: raceDigest(a, m, 'USA 3479') };
    });
    for (const r of races) expect(r.digest.evaluated).toContain(GATE_THEME);
    const s = summarizeRegatta(races);
    const f = s.findings.find((x) => x.theme === GATE_THEME)!;
    expect(f.label).toBe('Leeward roundings: gate choice');
    expect(f.gated).toBe(true);
    expect(f.races).toBe(2);
    expect(f.of).toBe(2);
    // A boat that took the favoured buoy both times: judged in both races, no finding.
    const fav = (['j24r2', 'j24r5'] as const).map((key) => raceDigest(race(key).a, race(key).m, 'USA 4103'));
    expect(fav.every((d) => d.evaluated!.includes(GATE_THEME) && !d.findings.some((x) => x.theme === GATE_THEME))).toBe(true);
  });
});

describe('D13 golden: no gate-choice card where the prototype found none', { timeout: 20_000 }, () => {
  it('J/111 R5: the left buoy 35 m further upwind, but the sides passed alike (≈ 1 s): not confirmed, nothing', () => {
    const [g] = race('j111r5').gates;
    expect(g.fav).toBe('left');
    expect(g.deltaM).toBeGreaterThan(30);
    expect(Math.abs(g.empS!)).toBeLessThan(5); // prototype −0.9 s
    expect(g.confirmed).toBe(false);
    expect(fleetDetect('j111r5').filter((b) => b.found.length || b.plus.length || b.ok.length)).toEqual([]);
  });

  it('IC37 R2: buoys level (Δ 4 m): not favoured, although the right buoy’s boats were 16 s quicker (that was the right side of the beat)', () => {
    const [g] = race('ic37r2').gates;
    expect(g.deltaM).toBeLessThan(6); // prototype 5 m
    expect(g.fav).toBeNull();
    expect(g.empS!).toBeLessThan(-12); // prototype: the right (lower here) buoy 16 s quicker
    expect(fleetDetect('ic37r2').filter((b) => b.found.length || b.plus.length || b.ok.length)).toEqual([]);
  });

  it('Melges 24 Worlds R5: the left buoy 13 m further upwind, but no side difference (≈ 0 s): nothing', () => {
    const [g] = race('m24r5').gates;
    expect(g.fav).toBe('left');
    expect(g.deltaM).toBeGreaterThan(11);
    expect(g.deltaM).toBeLessThan(16); // prototype 13 m
    expect(Math.abs(g.empS!)).toBeLessThan(4); // prototype 1.6 s
    expect(g.confirmed).toBe(false);
    expect(fleetDetect('m24r5').filter((b) => b.found.length || b.plus.length || b.ok.length)).toEqual([]);
  });

  it('Viper 640 R2: the run ends at the finish past the gate (no beat after it): no gate leg, so D13 never runs', () => {
    const { a } = race('viperr2');
    expect(a.legs.map((l) => l.to)).toEqual(['WW 1', 'Finish']);
    expect(gateGeoms(a)).toEqual([]);
    expect(race('viperr2').gates).toEqual([]);
    expect(fleetDetect('viperr2').filter((b) => b.found.length || b.plus.length || b.ok.length)).toEqual([]);
    expect(legsTable(a, null)).not.toMatch(/>Gate [LR]</);
  });
});
