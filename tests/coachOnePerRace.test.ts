import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw, type CoachModel } from '../src/analysis/coach';
import { coachDebrief, sideCard } from '../src/analysis/coach/debrief';
import { withAlso } from '../src/analysis/coach/detectors/side';
import { D16_GOOD_SHARE, D16_MATERIAL_S, D16_MIN_BOATS, biasCall, medianStartPct } from '../src/analysis/coach/detectors/lineBias';
import { CAP_EXEMPT, MAX_PER_KIND } from '../src/analysis/coach/rank';
import { alsoSeconds, raceDigest } from '../src/analysis/coach/regatta';
import type { Opportunity } from '../src/analysis/coach/opportunity';
import { MS_TO_KN } from '../src/analysis/geo';
import type { RaceAnalysis } from '../src/analysis/types';
import { cardText, wentText } from '../src/ui/coachCards';
import { raceAskContext } from '../src/ui/coachAskContext';
import { gateRace } from './helpers';

const opp = (o: Partial<Opportunity>): Opportunity => ({
  kind: 'D14',
  variant: 'wrong-side',
  t0: 0,
  t1: 600_000,
  seconds: 60,
  secondsLo: 30,
  secondsHi: 90,
  confidence: 'high',
  coverage: 1,
  conf: { boatCov: 1 },
  facts: {},
  refBoats: [],
  ...o,
});

describe('D14 is one card a race (side.ts withAlso, debrief.ts sideCard)', () => {
  const beat1 = opp({ t0: 0, t1: 600_000, seconds: 40, facts: { leg: 'Beat 1' } });
  const run1 = opp({ t0: 600_000, t1: 1_000_000, seconds: 90, facts: { leg: 'Run 1' } });
  const beat2 = opp({ t0: 1_000_000, t1: 1_600_000, seconds: 70, facts: { leg: 'Beat 2' } });
  it('the most seconds, the other legs in course order on its facts', () => {
    const one = withAlso([beat1, run1, beat2])!;
    expect(one.facts.leg).toBe('Run 1');
    expect(one.facts).toMatchObject({ also: 'Beat 1, Beat 2', alsoN: 2, alsoS: 110 });
    expect(withAlso([beat1])).toBe(beat1);
    expect(withAlso([])).toBeNull();
  });
  it('the leg that keeps the most once the other findings claimed theirs: a run D7 holds keeps none', () => {
    const d7 = opp({ kind: 'D7', variant: 'hot', t0: 600_000, t1: 1_000_000, seconds: 120 });
    const one = sideCard([beat1, run1, beat2], [d7])!;
    expect(one.facts.leg).toBe('Beat 2');
    // Beat 1 keeps its 40 s, Run 1 none: D7 took its stretch.
    expect(one.facts).toMatchObject({ also: 'Beat 1, Run 1', alsoS: 40 });
    expect(sideCard([beat1, run1, beat2], [])!.facts.leg).toBe('Run 1');
  });
  it('the Regatta theme counts the riding legs too', () => {
    expect(alsoSeconds({ kind: 'D14', facts: { alsoS: 85 } })).toBe(85);
    expect(alsoSeconds({ kind: 'D7', facts: { alsoS: 85 } })).toBe(0);
  });
});

describe('D16 against the fleet’s median start (lineBias.ts biasCall, medianStartPct)', () => {
  it('a card only D16_MATERIAL_S or more beyond the median toward the unfavoured end; ➕ in the favoured third at or toward the favoured end of it', () => {
    expect(D16_MATERIAL_S).toBe(10);
    // Median 0.5 of the line from the favoured end: (0.9 − 0.5) × 60 m ÷ 2 m/s = 12 s; (0.8 − 0.5) × 60 m ÷ 2 m/s = 9 s.
    expect(biasCall(0.9, 0.5, 60, 2)).toBe('card');
    expect(biasCall(0.8, 0.5, 60, 2)).toBeNull();
    // At the unfavoured end of the line but the fleet's median there too: nothing given away on the fleet.
    expect(biasCall(0.95, 0.75, 60, 2)).toBeNull();
    expect(biasCall(0.95, 0.6, 60, 2)).toBe('card');
    // The favoured third, at or toward the favoured end of the median: ➕ (however small the gain).
    expect(biasCall(D16_GOOD_SHARE, 0.5, 60, 2)).toBe('good');
    expect(biasCall(0.2, 0.2, 60, 2)).toBe('good');
    expect(biasCall(0, 0.1, 5, 2)).toBe('good');
    // Toward the favoured end of the median but outside the favoured third, or in it but behind a pin-heavy median: nothing.
    expect(biasCall(0.4, 0.75, 200, 2)).toBeNull();
    expect(biasCall(0.3, 0.1, 20, 2)).toBeNull();
  });

  it('the median over boats whose position at the gun was read (over-early boats count; away or across an unread hole do not)', () => {
    const st = (linePosPct: number, o: Partial<NonNullable<RaceAnalysis['boats'][number]['start']>> = {}) =>
      ({ start: { linePosPct, over: false, awayFromLine: false, dtlGapS: null, estDtlM: null, ...o } }) as unknown as RaceAnalysis['boats'][number];
    const boats = [st(10), st(20), st(30, { over: true }), st(80), st(140), st(5, { awayFromLine: true }), st(0, { dtlGapS: 12 }), st(90, { dtlGapS: 8, estDtlM: 3 })];
    // 10, 20, 30, 80, 100 (clamped), 90 → median 55.
    expect(medianStartPct({ boats })).toBe(55);
    expect(D16_MIN_BOATS).toBe(5);
    expect(medianStartPct({ boats: boats.slice(0, 4) })).toBeNull();
  });

  it('the card says how far from the median and what it cost; the ➕ how far toward the favoured end', () => {
    const facts = { favoured: 'pin', deg: 6, byM: 100, linePosPct: 92, medianPct: 50, share: 0.92, medianShare: 0.5, alongM: 420, givenM: 42, vmg: 4.5 };
    const c = opp({ kind: 'D16', variant: 'unfavoured', seconds: 18, facts });
    expect(cardText({ ...c, score: 0, limit: null } as never).sentence).toBe(
      "Pin favoured 6° (~100 m over the line). You started 420 m toward the committee boat from the fleet's median start: ≈ 42 m upwind, about 18 s at the fleet's 4.5 kn up the first beat.",
    );
    const boat = { ...facts, favoured: 'boat', alongM: 300, givenM: 30 };
    expect(cardText({ ...opp({ kind: 'D16', variant: 'unfavoured', seconds: 13, facts: boat }), score: 0, limit: null } as never).sentence).toMatch(
      /^Committee boat favoured 6° \(~100 m over the line\)\. You started 300 m toward the pin from the fleet's median start: ≈ 30 m upwind, about 13 s/,
    );
    const good = { kind: 'plus' as const, detector: 'D16' as const, variant: 'favoured', t0: 0, t1: 1, seconds: 8, facts: { ...facts, alongM: -350, givenM: -35, gainS: 8 } };
    expect(wentText(good)).toBe("Start: pin end favoured 6° (~100 m) and you started 350 m toward the pin from the fleet's median start (≈ 35 m upwind)");
    expect(wentText({ ...good, facts: { ...good.facts, alongM: 0.2, givenM: 0.02 } })).toBe("Start: pin end favoured 6° (~100 m) and you started at the fleet's median start");
  });
});

interface Race {
  a: RaceAnalysis;
  m: CoachModel;
  id: (sail: string) => string;
}
const build = (data: ReturnType<typeof gateRace>): Race => {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null, raw.turns ?? null, raw.overStart ?? null)!;
  return { a, m, id: (sail) => a.boats.find((b) => b.sail === sail)!.id };
};

describe('Melges 24 R5 and J/24 R2: one side-of-course card a race, material line-bias cards only', () => {
  let m24: Race;
  let j24: Race;
  beforeAll(() => {
    m24 = build(gateRace('m24r5'));
    j24 = build(gateRace('j24r2'));
  }, 120_000);

  it('853 (three "Left paid" cards before): one D14 card, the other legs as "also …", on the card and in Ask Coach', () => {
    const me = m24.a.boats.find((b) => b.sail === '853')!;
    const d = coachDebrief(m24.a, m24.m, me.id)!;
    const side = d.cards.filter((c) => c.kind === 'D14');
    expect(side).toHaveLength(1);
    const c = side[0];
    expect(c.facts).toMatchObject({ leg: 'Run 2', also: 'Run 1, Beat 2', alsoN: 2 });
    const t = cardText(c);
    expect(t.title).toBe('Left paid on Run 2');
    expect(t.sentence).toMatch(/ Also on the side that didn't pay: Run 1, Beat 2\.$/);
    const ask = raceAskContext({ a: m24.a, me, deb: d, stories: [], group: { kind: 'leaders' }, head: [] });
    expect(ask.findings!.find((f) => f.title === t.title)!.what).toContain('Also on the side that didn\'t pay: Run 1, Beat 2.');
    // The Regatta theme still counts the riding legs' seconds.
    const side14 = raceDigest(m24.a, m24.m, '853').findings.filter((f) => f.theme === 'side');
    expect(side14).toHaveLength(1);
    expect(side14[0].seconds).toBeCloseTo(c.seconds + (c.facts.alsoS as number), 6);
    expect(side14[0].seconds).toBeGreaterThan(c.seconds);
  });

  it('every boat: at most one D14 card and one D14 Went well line; no detector over MAX_PER_KIND in the top 3', () => {
    let cards = 0;
    for (const b of m24.a.boats) {
      const d = coachDebrief(m24.a, m24.m, b.id)!;
      const n = d.cards.filter((c) => c.kind === 'D14').length;
      expect(n).toBeLessThanOrEqual(1);
      cards += n;
      const plus = d.plus.filter((p) => p.detector === 'D14');
      expect(plus.length).toBeLessThanOrEqual(1);
      for (const p of plus) expect(wentText(p)).toMatch(/^(Beat|Run) \d: on the (left|right) side, which paid .*?(\(also (Beat|Run) \d(, (Beat|Run) \d)*\))?$/);
      const kinds = new Map<string, number>();
      for (const c of d.cards) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
      for (const [k, v] of kinds) if (!CAP_EXEMPT.has(k as Opportunity['kind'])) expect(v).toBeLessThanOrEqual(MAX_PER_KIND);
    }
    // 43 D14 cards (up to 3 a boat) before.
    expect(cards).toBeLessThanOrEqual(28);
  }, 60_000);

  it('D16 against the median start: every card D16_MATERIAL_S or more, its boat beyond the median toward the unfavoured end', () => {
    // M24 R5: the gun window has too few port-tack minutes (wind.ts START_WIND_MIN_TACK_SHARE), so Beat 1's wind, 6.8°.
    // J/24 R2: the first 3 min put the line within 2° of square: no D16 at all (5 cards before, against Beat 1's wind).
    const tally = (r: Race): { found: number; card: number; good: number } => {
      let found = 0;
      let card = 0;
      let good = 0;
      for (const b of r.a.boats) {
        const d = coachDebrief(r.a, r.m, b.id)!;
        card += d.cards.filter((c) => c.kind === 'D16').length;
        const o = d.found.find((x) => x.kind === 'D16');
        if (o) {
          found++;
          expect(o.seconds).toBeGreaterThanOrEqual(D16_MATERIAL_S);
          expect(o.facts.share as number).toBeGreaterThan(o.facts.medianShare as number);
          expect(o.facts.alongM as number).toBeGreaterThan(0);
          expect(o.seconds).toBeCloseTo(((o.facts.share as number) - (o.facts.medianShare as number)) * (o.facts.byM as number) / ((o.facts.vmg as number) / MS_TO_KN), 6);
        }
        const p = d.plus.find((x) => x.detector === 'D16');
        if (p) {
          good++;
          expect(p.facts.share as number).toBeLessThanOrEqual(D16_GOOD_SHARE);
          expect(p.facts.share as number).toBeLessThanOrEqual(p.facts.medianShare as number);
        }
      }
      return { found, card, good };
    };
    // M24 R5: 10 top-3 cards before (the unfavoured third); now found on 8 boats, 5 in their top 3; the Went well lines as before.
    expect(tally(m24)).toEqual({ found: 8, card: 5, good: 14 });
    expect(tally(j24)).toEqual({ found: 0, card: 0, good: 0 });
  }, 60_000);
});
