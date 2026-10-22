import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw, type CoachModel } from '../src/analysis/coach';
import { coachDebrief, sideCard } from '../src/analysis/coach/debrief';
import { withAlso } from '../src/analysis/coach/detectors/side';
import { D16_CARD_SHARE, D16_GOOD_SHARE, D16_MATERIAL_S, biasCall } from '../src/analysis/coach/detectors/lineBias';
import { CAP_EXEMPT, MAX_PER_KIND } from '../src/analysis/coach/rank';
import { alsoSeconds, raceDigest } from '../src/analysis/coach/regatta';
import type { Opportunity } from '../src/analysis/coach/opportunity';
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

describe('D16 only when the ground given away is material (lineBias.ts biasCall)', () => {
  it('unfavoured third: a card from D16_MATERIAL_S at the fleet’s Beat-1 VMG; favoured third: ➕; else nothing', () => {
    expect(D16_MATERIAL_S).toBe(10);
    // 0.8 × 60 m ÷ 2 m/s = 24 s; 0.8 × 20 m ÷ 2 m/s = 8 s.
    expect(biasCall(0.8, 60, 2)).toBe('card');
    expect(biasCall(0.8, 20, 2)).toBeNull();
    expect(biasCall(D16_CARD_SHARE, 30, 2)).toBe('card');
    expect(biasCall(D16_CARD_SHARE, 29, 2)).toBeNull();
    expect(biasCall(0.5, 200, 2)).toBeNull();
    expect(biasCall(D16_GOOD_SHARE, 5, 2)).toBe('good');
    expect(biasCall(0, 200, 2)).toBe('good');
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

  it('D16 cards only with D16_MATERIAL_S or more given away; the favoured end stays a Went well line', () => {
    let card = 0;
    let good = 0;
    for (const r of [m24, j24]) {
      for (const b of r.a.boats) {
        const d = coachDebrief(r.a, r.m, b.id)!;
        const o = d.found.find((x) => x.kind === 'D16');
        if (o) {
          card++;
          expect(o.seconds).toBeGreaterThanOrEqual(D16_MATERIAL_S);
          expect(o.facts.share as number).toBeGreaterThanOrEqual(D16_CARD_SHARE);
        }
        const p = d.plus.find((x) => x.detector === 'D16');
        if (p) {
          good++;
          expect(p.facts.share as number).toBeLessThanOrEqual(D16_GOOD_SHARE);
        }
      }
    }
    expect(card).toBeGreaterThan(0);
    expect(good).toBeGreaterThan(0);
  }, 60_000);
});
