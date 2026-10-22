import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw, type CoachModel } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import {
  D17_GYBE_RECOVER_MS,
  D17_LEAD_MS,
  D17_MAX_GAP_MS,
  D17_MIN_MEASURED,
  D17_MIN_Z,
  D17_PRE_MS,
  D17_TACK_RECOVER_MS,
  costly,
  denseAround,
  fleetManoeuvres,
  legCost,
  manoeuvreLoss,
  material,
  smooth,
  tooMany,
} from '../src/analysis/coach/detectors/manoeuvreCost';
import { classifyRounding } from '../src/analysis/coach/legStory';
import { CAP_EXEMPT, MAX_PER_KIND, rankOpportunities } from '../src/analysis/coach/rank';
import { CONF_WEIGHT, LOW_IMPACT_CAP_S, MIN_SECONDS, impactOf, type Opportunity } from '../src/analysis/coach/opportunity';
import { alsoSeconds, themeKey, themeOf, tipOf, wentOf } from '../src/analysis/coach/regatta';
import { detectManoeuvres } from '../src/analysis/manoeuvres';
import { roundingMs } from '../src/analysis/places';
import type { RaceAnalysis } from '../src/analysis/types';
import { defaultLadderGroup } from '../src/ui/coach';
import { askFinding } from '../src/ui/coachAskContext';
import { cardText, cardWarnings, wentText } from '../src/ui/coachCards';
import { buildReport } from '../src/ui/report';
import type { Card } from '../src/analysis/coach/rank';
import { cascaisRace, gateRace } from './helpers';

// ---- the cost of one manoeuvre (synthetic tracks; wind from the north, 1 Hz fixes)

const T = 100_000;
/** A 1 Hz track from `vel(t)` (m/s, east and north), from 0 to `to` ms, leaving out [holeFrom, holeTo). */
function track(vel: (t: number) => [number, number], to = 200_000, hole: [number, number] | null = null) {
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let px = 0;
  let py = 0;
  for (let ms = 0; ms <= to; ms += 1000) {
    if (ms > 0) {
      const [vx, vy] = vel(ms - 1000);
      px += vx;
      py += vy;
    }
    if (hole && ms >= hole[0] && ms < hole[1]) continue;
    t.push(ms);
    x.push(px);
    y.push(py);
  }
  return { t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y) };
}
const north = (): number => 0;
// Close-hauled at VMG 2 m/s on port (north-east), stopped for 6 s through the tack, then on starboard (north-west).
const tackVel = (stopS: number) => (ms: number): [number, number] => (ms < T - 2000 ? [2, 2] : ms < T - 2000 + stopS * 1000 ? [0, 0] : [-2, 2]);

describe('D17: the cost of one manoeuvre (manoeuvreCost.ts manoeuvreLoss)', () => {
  it('the ground lost through the turn and recovery against the steady VMG before it, in metres and seconds', () => {
    const l = manoeuvreLoss(track(tackVel(6)), T, 'tack', 'upwind', north)!;
    // Baseline: 2 m/s over the steady window. Through [T − 8 s, T + 30 s]: 38 s at 2 m/s = 76 m expected,
    // made 6 s × 2 + 0 + 26 s × 2 = 64 m: 12 m, 6 s.
    expect(l.vmg).toBeCloseTo(2, 6);
    expect(l.lossM).toBeCloseTo(12, 6);
    expect(l.lossS).toBeCloseTo(6, 6);
    expect(D17_PRE_MS).toBe(25_000);
    expect(D17_LEAD_MS).toBe(8_000);
    expect(D17_TACK_RECOVER_MS).toBe(30_000);
  });
  it('a turn with no loss costs nothing; a longer stop costs in proportion', () => {
    expect(manoeuvreLoss(track(tackVel(0)), T, 'tack', 'upwind', north)!.lossM).toBeCloseTo(0, 6);
    expect(manoeuvreLoss(track(tackVel(10)), T, 'tack', 'upwind', north)!.lossM).toBeCloseTo(20, 6);
  });
  it('a gybe downwind: progress away from the wind, read to D17_GYBE_RECOVER_MS after it', () => {
    // Running at VMG 3 m/s (south-east, then south-west), 4 s at half speed through the gybe: 4 × 1.5 = 6 m.
    const vel = (ms: number): [number, number] => (ms < T - 2000 ? [3, -3] : ms < T + 2000 ? [1.5, -1.5] : [-3, -3]);
    const l = manoeuvreLoss(track(vel), T, 'gybe', 'downwind', north)!;
    expect(l.vmg).toBeCloseTo(3, 6);
    expect(l.lossM).toBeCloseTo(6, 6);
    expect(l.lossS).toBeCloseTo(2, 6);
    expect(D17_GYBE_RECOVER_MS).toBeGreaterThan(D17_TACK_RECOVER_MS);
  });
  it('never across a hole: a gap over D17_MAX_GAP_MS anywhere from the steady window to the recovery is skipped', () => {
    expect(D17_MAX_GAP_MS).toBe(10_000);
    const holey = track(tackVel(6), 200_000, [T + 5000, T + 5000 + D17_MAX_GAP_MS + 1000]);
    expect(denseAround(holey.t, T - D17_LEAD_MS - D17_PRE_MS, T + D17_TACK_RECOVER_MS)).toBe(false);
    expect(manoeuvreLoss(holey, T, 'tack', 'upwind', north)).toBeNull();
    // A short gap (under the limit) is fine: only the windows' ends are read.
    const short = track(tackVel(6), 200_000, [T + 5000, T + 9000]);
    expect(manoeuvreLoss(short, T, 'tack', 'upwind', north)!.lossM).toBeCloseTo(12, 6);
    // The track starts inside the steady window: no baseline.
    expect(manoeuvreLoss(track(tackVel(6)), 20_000, 'tack', 'upwind', north)).toBeNull();
  });
  it('no steady baseline (stopped before the turn): skipped', () => {
    const still = (ms: number): [number, number] => (ms < T + 5000 ? [0, 0] : [-2, 2]);
    expect(manoeuvreLoss(track(still), T, 'tack', 'upwind', north)).toBeNull();
  });
});

describe('D17: the calls (costly, tooMany, material, smooth)', () => {
  it('costly: 1.3× the fleet, 4 m more, and D17_MIN_Z standard errors more', () => {
    expect(costly({ medM: 14, fMedM: 8, seM: 2 })).toBe(true);
    // Within two standard errors of the fleet: noise, not a finding.
    expect(costly({ medM: 14, fMedM: 8, seM: 3.5 })).toBe(false);
    expect(D17_MIN_Z).toBe(2);
    // Under 4 m more (a small fleet median makes any ratio big).
    expect(costly({ medM: 3, fMedM: 1, seM: 0.5 })).toBe(false);
    // Over 4 m more but under 1.3×.
    expect(costly({ medM: 24, fMedM: 20, seM: 1 })).toBe(false);
  });
  it('tooMany: trusted counts only, 2 more and 1.5× the fleet median', () => {
    expect(tooMany(6, 3, true)).toBe(true);
    expect(tooMany(6, 3, false)).toBe(false);
    expect(tooMany(6, null, true)).toBe(false);
    expect(tooMany(5, 4, true)).toBe(false);
    expect(tooMany(3, 1, true)).toBe(true);
  });
  it('material: 25 m or 10 s over the leg', () => {
    expect(material({ extraM: 36, extraS: 8 })).toBe(true);
    expect(material({ extraM: 20, extraS: 11 })).toBe(true);
    expect(material({ extraM: 20, extraS: 8 })).toBe(false);
  });
  it('smooth (➕): 0.7× the fleet or better, 4 m and two standard errors less', () => {
    expect(smooth({ medM: 2, fMedM: 14, seM: 3 })).toBe(true);
    expect(smooth({ medM: 7, fMedM: 9, seM: 0.5 })).toBe(false);
    expect(smooth({ medM: 2, fMedM: 14, seM: 7 })).toBe(false);
  });
});

// ---- the fixtures

interface Race {
  a: RaceAnalysis;
  m: CoachModel;
}
const build = (data: ReturnType<typeof cascaisRace>): Race => {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  return { a, m: buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null, raw.turns ?? null, raw.overStart ?? null)! };
};
const idOf = (r: Race, sail: string): string => r.a.boats.find((b) => b.sail === sail)!.id;

describe('D17 on J/24 Nationals R2 (dense on Beat 2: 40 tacks measured from 27 boats)', () => {
  let r: Race;
  beforeAll(() => {
    r = build(gateRace('j24r2'));
  });
  it('fires on USA 3359: three tacks to the fleet’s one at about the fleet’s cost (a count finding, under the medium minimum)', () => {
    const d = coachDebrief(r.a, r.m, idOf(r, 'USA 3359'))!;
    const o = d.found.find((x) => x.kind === 'D17')!;
    expect(o.variant).toBe('tack');
    expect(o.facts).toMatchObject({ leg: 'Beat 2', man: 'tack', n: 3, fN: 1, many: 1 });
    // The extra is the count's: its own tacks were no costlier than the fleet's.
    expect(o.facts.handlingM as number).toBeLessThan(0);
    expect(o.facts.countM as number).toBeGreaterThan(20);
    expect(o.seconds).toBeGreaterThanOrEqual(10);
    // Three measured: medium at best; ~11 s is under the medium minimum, so not a card.
    const [card] = rankOpportunities([o], Infinity);
    expect(card?.confidence ?? 'medium').toBe('medium');
    expect(d.cards.some((c) => c.kind === 'D17')).toBe(false);
    const t = cardText({ ...o, score: 0, limit: null } as Card);
    expect(t.title).toBe('Too many tacks on Beat 2');
    expect(t.sentence).toMatch(/^Beat 2: your tacks cost ~\d+ m each \(~\d+ s\), the fleet's ~\d+ m; you tacked 3 times, the fleet 1 time; 3 tacks = ~\d+ m lost on the fleet\.$/);
    expect(cardWarnings({ ...o, confidence: 'medium', limit: 'refs', score: 0 } as Card, r.a)).toContain('few manoeuvres measured');
  });
  it('a Went well line for USA 1938: tacks far cheaper than the fleet’s', () => {
    const d = coachDebrief(r.a, r.m, idOf(r, 'USA 1938'))!;
    const n = d.plus.find((x) => x.detector === 'D17')!;
    expect(n.variant).toBe('tack');
    expect(n.seconds!).toBeGreaterThanOrEqual(30);
    expect(wentText(n)).toMatch(/^Beat 2: tacks ~0 m each vs fleet ~1[34] m \(3 measured\)$/);
    expect(wentOf(r.a, n)).toMatchObject({ family: 'manoeuvres', label: 'Beat 2' });
  });
  it('the Report’s legs table adds the measured cost to the tacks', () => {
    const boat = idOf(r, 'USA 1938');
    const rep = buildReport({ a: r.a, boat, raceName: 'Race 2', model: r.m, deb: coachDebrief(r.a, r.m, boat), group: defaultLadderGroup(), official: null });
    expect(rep.legs[2].manoeuvres).toMatch(/^~?\d+ tacks? · ~0 m each \(fleet ~1[34]\)$/);
    // Legs without D17_MIN_MEASURED measured stay as they were.
    expect(rep.legs[0].manoeuvres).toMatch(/^~?\d+ tacks?$/);
  });
  it('one D17 card a race per kind of manoeuvre, one D14 card a race, for every boat', () => {
    for (const b of r.a.boats) {
      const d = coachDebrief(r.a, r.m, b.id);
      if (!d) continue;
      expect(d.found.filter((o) => o.kind === 'D14').length).toBeLessThanOrEqual(1);
      for (const v of ['tack', 'gybe']) expect(d.found.filter((o) => o.kind === 'D17' && o.variant === v).length).toBeLessThanOrEqual(1);
      expect(d.cards.filter((c) => c.kind === 'D14').length).toBeLessThanOrEqual(1);
    }
  }, 60_000);
  it('the fleet reference leaves the boat out, and needs D17_MIN_MEASURED of its own', () => {
    const c = legCost({ a: r.a, m: r.m, boat: idOf(r, 'USA 1938') }, 2)!;
    expect(c.mine.measured.length).toBeGreaterThanOrEqual(D17_MIN_MEASURED);
    expect(c.refMans).toBe(40 - c.mine.measured.length);
    expect(c.seM).toBeGreaterThan(0);
  });
});

describe('D17 thin data: Cascais J/70 R3 (the fixture is 10 s apart away from the gun and the windward marks)', () => {
  let r: Race;
  beforeAll(() => {
    r = build(cascaisRace('r3'));
  });
  it('counts the tacks but measures none mid-leg, so no card and no ➕ for any boat', () => {
    const fm = fleetManoeuvres(r);
    const counted = [...fm.values()].reduce((s, legs) => s + legs.reduce((t, l) => t + (l?.times.length ?? 0), 0), 0);
    expect(counted).toBeGreaterThan(100);
    for (const b of r.a.boats) {
      for (let k = 0; k < r.a.legs.length; k++) expect(legCost({ a: r.a, m: r.m, boat: b.id }, k)).toBeNull();
    }
    const d = coachDebrief(r.a, r.m, idOf(r, 'USA 833'))!;
    expect(d.found.some((o) => o.kind === 'D17')).toBe(false);
    expect(d.plus.some((n) => n.detector === 'D17')).toBe(false);
  });
});

describe('D17 and the gybe-set: the rounding’s gybe is never a gybe of the run (Cascais J/70 R2, dense at the windward marks)', () => {
  let r: Race;
  beforeAll(() => {
    r = build(cascaisRace('r2'));
  });
  it('a boat classified gybe-set on Run 1 has that gybe counted on neither the run nor the fleet', () => {
    const fm = fleetManoeuvres(r);
    let setters = 0;
    for (const b of r.a.boats) {
      const round = roundingMs(b, 0);
      const tr = r.m.tracks.get(b.id);
      if (round == null || !tr || classifyRounding(tr, r.m.wind.twdAt, round) !== 'gybe-set') continue;
      const set = detectManoeuvres(tr, r.m.wind.twdAt, round - 5_000, round + 120_000).find((x) => x.kind === 'gybe')!;
      setters++;
      expect(fm.get(b.id)?.[1]?.times ?? []).not.toContain(set.tMs);
    }
    expect(setters).toBeGreaterThan(5);
  });
});

// ---- the card, the Regatta theme, Ask Coach

const d17 = (o: Partial<Opportunity> = {}): Opportunity => ({
  kind: 'D17',
  variant: 'tack',
  t0: 0,
  t1: 600_000,
  spans: [
    [0, 38_000],
    [300_000, 338_000],
  ],
  seconds: 15,
  secondsLo: 8,
  secondsHi: 22,
  confidence: 'high',
  coverage: 1,
  conf: { boatCov: 1 },
  facts: { leg: 'Beat 1', legKind: 'upwind', man: 'tack', n: 6, measured: 5, medM: 14, medS: 6, fMedM: 8, fMedS: 3.4, fN: null, extraM: 36, handlingM: 36, countM: 0, many: 0, vmg: 4.6, refN: 30 },
  refBoats: [],
  ...o,
});

describe('D17 card text, theme and Ask Coach context', () => {
  it('plain and specific: the cost a tack against the fleet’s, and what the leg’s tacks cost', () => {
    const [c] = rankOpportunities([d17()]);
    const t = cardText(c);
    expect(t.title).toBe('Costly tacks on Beat 1');
    expect(t.sentence).toBe("Beat 1: your tacks cost ~14 m each (~6 s), the fleet's ~8 m; 6 tacks = ~36 m lost on the fleet.");
    expect(t.chips).toEqual(['~14 m a tack vs fleet ~8 m', '6 tacks', '5 of 6 measured']);
    expect(t.tip).toMatch(/^Smooth tacks/);
    const g = cardText(rankOpportunities([d17({ variant: 'gybe', facts: { ...d17().facts, leg: 'Run 2', legKind: 'downwind', man: 'gybe', n: 4, fN: 2, countM: 16, also: 'Run 1' } })])[0]);
    expect(g.title).toBe('Costly gybes on Run 2');
    expect(g.sentence).toBe("Run 2: your gybes cost ~14 m each (~6 s), the fleet's ~8 m; you gybed 4 times, the fleet 2 times; 4 gybes = ~36 m lost on the fleet. Also on Run 1.");
    expect(g.chips[1]).toBe('4 gybes vs fleet 2');
  });
  it('a Regatta theme with its own label, phrase and tips; the riding legs count', () => {
    expect(themeKey('D17', 'tack')).toBe('manoeuvres');
    expect(themeKey('D17', 'gybe')).toBe('manoeuvres');
    expect(themeOf('manoeuvres')).toMatchObject({ label: 'Tacks and gybes', phrase: 'losing more ground in tacks or gybes than the fleet' });
    expect(tipOf('D17', 'tack')).toMatch(/^Smooth tacks/);
    expect(tipOf('D17', 'gybe')).toMatch(/^Smooth gybes/);
    expect(alsoSeconds({ kind: 'D17', facts: { alsoS: 12 } })).toBe(12);
  });
  it('Ask Coach carries the card as the page shows it', () => {
    const [c] = rankOpportunities([d17()]);
    const a = { meta: { tzOffsetMs: 0, gunMs: 0 } } as unknown as RaceAnalysis;
    expect(askFinding(c, a, 1)).toMatchObject({ title: 'Costly tacks on Beat 1', seconds: 15, what: "Beat 1: your tacks cost ~14 m each (~6 s), the fleet's ~8 m; 6 tacks = ~36 m lost on the fleet." });
  });
});

// ---- ranking by impact (rank.ts)

const opp = (o: Partial<Opportunity>): Opportunity => ({
  kind: 'D6',
  variant: 'slow',
  t0: 0,
  t1: 60_000,
  seconds: 30,
  secondsLo: 20,
  secondsHi: 40,
  confidence: 'high',
  coverage: 1,
  conf: { boatCov: 1 },
  facts: {},
  refBoats: [],
  ...o,
});
const MIN = 60_000;
const HIGH = { boatCov: 1 };
const MEDIUM = { boatCov: 0.6 };
const LOW = { boatCov: 0.3 };

describe('ranking by impact on the result (rank.ts, opportunity.ts impactOf)', () => {
  it('impact = seconds × the confidence’s weight, low-confidence seconds capped at LOW_IMPACT_CAP_S', () => {
    expect(LOW_IMPACT_CAP_S).toBe(2 * MIN_SECONDS.low);
    expect(impactOf(50, 'high')).toBe(50);
    expect(impactOf(50, 'medium')).toBeCloseTo(50 * CONF_WEIGHT.medium, 9);
    expect(impactOf(50, 'low')).toBeCloseTo(50 * CONF_WEIGHT.low, 9);
    expect(impactOf(300, 'low')).toBeCloseTo(LOW_IMPACT_CAP_S * CONF_WEIGHT.low, 9);
    expect(impactOf(300, 'none')).toBe(0);
  });
  it('orders by impact: a medium 50 s (35) above a high 30 s', () => {
    const cards = rankOpportunities([opp({ kind: 'D9', variant: 'windward', t0: 0, t1: MIN, seconds: 30, conf: HIGH }), opp({ kind: 'D13', variant: 'unfavoured', t0: 5 * MIN, t1: 6 * MIN, seconds: 50, conf: MEDIUM })]);
    expect(cards.map((c) => c.kind)).toEqual(['D13', 'D9']);
    expect(cards[0].score).toBeCloseTo(35, 9);
  });
  it('a low-confidence estimate is discounted and capped: 300 s low (24) under a high 25 s, still showing its 300 s', () => {
    const cards = rankOpportunities([opp({ kind: 'D7', variant: 'slow', t0: 10 * MIN, t1: 20 * MIN, seconds: 300, secondsLo: 200, secondsHi: 400, conf: LOW }), opp({ kind: 'D3', variant: 'lane', t0: 0, t1: 5 * MIN, seconds: 25, conf: HIGH })]);
    expect(cards.map((c) => [c.kind, c.confidence])).toEqual([
      ['D3', 'high'],
      ['D7', 'low'],
    ]);
    expect(cards[1].seconds).toBe(300);
    expect(cards[1].score).toBeCloseTo(24, 9);
  });
  it('two low cards at the cap: the more seconds first, so the bigger one keeps an overlapped stretch', () => {
    const cards = rankOpportunities([opp({ kind: 'D7', variant: 'slow', t0: 0, t1: 10 * MIN, seconds: 80, conf: LOW }), opp({ kind: 'D10', variant: 'run', t0: 5 * MIN, t1: 10 * MIN, seconds: 150, conf: LOW })]);
    expect(cards[0].kind).toBe('D10');
    expect(cards[0].seconds).toBe(150);
    // D7 gives up the half of its window D10 holds.
    expect(cards[1].seconds).toBeCloseTo(40, 9);
  });
  it('penalty turns first: a loop claims its stretch before a bigger rate finding over it, and is never passed over', () => {
    const d7 = opp({ kind: 'D7', variant: 'slow', t0: 0, t1: 10 * MIN, seconds: 200, conf: HIGH });
    const loops = [0, 3, 6].map((k) => opp({ kind: 'D12', variant: '360', t0: k * MIN, t1: k * MIN + 30_000, seconds: 25, conf: MEDIUM }));
    const cards = rankOpportunities([d7, ...loops]);
    expect(CAP_EXEMPT.has('D12')).toBe(true);
    // Three loops, all kept (exempt from MAX_PER_KIND); D7 loses their 90 s of its 10 minutes.
    expect(cards.filter((c) => c.kind === 'D12').map((c) => c.seconds)).toEqual([25, 25]);
    expect(rankOpportunities([d7, ...loops], Infinity).filter((c) => c.kind === 'D12')).toHaveLength(3);
    expect(cards[0].kind).toBe('D7');
    expect(cards[0].seconds).toBeCloseTo(200 * (1 - 90 / 600), 9);
  });
  it('MAX_PER_KIND: a third card of one detector gives its slot to the next of another', () => {
    const d6 = [0, 1, 2].map((k) => opp({ kind: 'D6', variant: 'slow', t0: k * 10 * MIN, t1: (k + 1) * 10 * MIN, seconds: 60 - k, conf: HIGH }));
    const d9 = opp({ kind: 'D9', variant: 'leeward', t0: 40 * MIN, t1: 41 * MIN, seconds: 15, conf: HIGH });
    expect(MAX_PER_KIND).toBe(2);
    expect(rankOpportunities([...d6, d9]).map((c) => c.kind)).toEqual(['D6', 'D6', 'D9']);
  });
  it('the minimums by confidence still gate: a low card under 30 s is never shown, whatever its impact', () => {
    expect(rankOpportunities([opp({ seconds: 29, conf: LOW })])).toEqual([]);
    expect(rankOpportunities([opp({ seconds: 19, conf: MEDIUM })])).toEqual([]);
    expect(rankOpportunities([opp({ seconds: 10, conf: HIGH })])).toHaveLength(1);
  });
  it('D17 is a rate finding over its own stretches: the start’s window takes the tacks in it, pro rata', () => {
    const start = opp({ kind: 'D3', variant: 'lane', t0: 0, t1: 5 * MIN, seconds: 20, conf: HIGH });
    const tacks = d17({ t0: 2 * MIN, t1: 8 * MIN, spans: [[2 * MIN, 2 * MIN + 38_000], [7 * MIN, 7 * MIN + 38_000]], seconds: 30 });
    const cards = rankOpportunities([start, tacks]);
    const c = cards.find((x) => x.kind === 'D17')!;
    expect(c.seconds).toBeCloseTo(15, 9);
    expect(c.spans).toEqual([[7 * MIN, 7 * MIN + 38_000]]);
  });
});
