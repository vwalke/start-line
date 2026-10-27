import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw, type CoachModel } from '../src/analysis/coach';
import { D14_MIN_Z } from '../src/analysis/coach/detectors/side';
import { D15_VMG_DROP } from '../src/analysis/coach/detectors/nowhere';
import { D16_MATERIAL_S, D16_MIN_DEG, medianStartPct } from '../src/analysis/coach/detectors/lineBias';
import { classifyRounding, fleetPlaces, fleetSide, legStories, ROUND_DOWN_MAX_MS, ROUND_WINDOW_MS } from '../src/analysis/coach/legStory';
import { rankOpportunities } from '../src/analysis/coach/rank';
import { themeKey, themeOf, tipOf } from '../src/analysis/coach/regatta';
import { sanitizeAskContext } from '../src/analysis/coach/askContext';
import { MS_TO_KN, bearingVec, wrap180, type Vec } from '../src/analysis/geo';
import { biasAngle, lineBias, windSource } from '../src/analysis/line';
import { START_WIND_MIN_SAMPLES, START_WIND_MIN_TACK_N } from '../src/analysis/wind';
import { LEG_MAX_KN, dropImpossibleLegs, legSplitOk } from '../src/analysis/legs';
import { START_EST_NEAR_MS, START_EST_SIDE_MS, estimateDtl } from '../src/analysis/validity';
import type { RaceAnalysis } from '../src/analysis/types';
import { MIN_SECONDS, type Opportunity } from '../src/analysis/coach/opportunity';
import { cardText, goodTexts, wentText } from '../src/ui/coachCards';
import { placeChip } from '../src/ui/coachLegs';
import { biasBullets } from '../src/ui/startLine';
import { raceAskContext } from '../src/ui/coachAskContext';
import { cascaisRace, d17Tally, debriefOf, gateRace, j105Race } from './helpers';

// ---- pure helpers

describe('impossible leg splits (legs.ts legSplitOk)', () => {
  const med = { timeS: 1000, sogKn: 6, vmgKn: 4.5 };
  it('keeps an ordinary leg, drops one too fast or too short', () => {
    expect(legSplitOk({ timeS: 1100, sogKn: 5.8, vmgKn: 4.3 }, med)).toBe(true);
    // Cascais R3: FRA 1089 Beat 2 in 19 s at a VMG of 380 kn; BRA 1618 Run 1 in 69 s at 121 kn.
    expect(legSplitOk({ timeS: 19.2, sogKn: 20_722, vmgKn: 379.6 }, med)).toBe(false);
    expect(legSplitOk({ timeS: 69, sogKn: 3793, vmgKn: 121.4 }, { timeS: 978, sogKn: 11, vmgKn: 9 })).toBe(false);
    // Under 0.3 of the median time, even at a believable speed.
    expect(legSplitOk({ timeS: 250, sogKn: 7, vmgKn: 5 }, med)).toBe(false);
    // A fast fleet: the ceiling is 3× its median, not LEG_MAX_KN.
    expect(legSplitOk({ timeS: 600, sogKn: 30, vmgKn: 25 }, { timeS: 700, sogKn: 20, vmgKn: 15 })).toBe(true);
    expect(LEG_MAX_KN).toBe(25);
  });
  it('sets the impossible ones to null in place', () => {
    const ok = { timeS: 1000, sogKn: 6, vmgKn: 4.5 };
    const boats = [[ok, ok], [ok, { timeS: 20, sogKn: 900, vmgKn: 300 }], [ok, ok]];
    expect(dropImpossibleLegs(boats)).toBe(1);
    expect(boats[1][1]).toBeNull();
    expect(boats[1][0]).toBe(ok);
  });
});

describe('the start across a hole (validity.ts estimateDtl)', () => {
  const t = [0, 1000, 2000, 40_000];
  const dtl = (i: number): number => [30, 27, 24, 0][i];
  const v = (): number => 3;
  it('dead reckons from a fix within START_EST_NEAR_MS', () => {
    // 4 s after the fix at 2 s, at 3 m/s toward the line: 24 − 12.
    expect(estimateDtl(t, 6000, 99, dtl, v)).toBeCloseTo(12, 6);
    expect(START_EST_NEAR_MS).toBe(10_000);
  });
  it('else interpolates when both sides are within START_EST_SIDE_MS, else unknown', () => {
    expect(estimateDtl([0, 20_000 + 25_000], 20_000, 7, dtl, v)).toBe(7);
    expect(estimateDtl([0, 20_000 + START_EST_SIDE_MS + 1], 20_000, 7, dtl, v)).toBeNull();
  });
});

const T0 = 5_000_000;
/** Upwind on starboard (course 315°, wind from 0°) to the mark at T0 + 60 s, then `after(s since the mark)` as the course. */
function rounding(after: (s: number) => number) {
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let p: Vec = [0, 0];
  const v = 6 / MS_TO_KN;
  for (let ms = 0; ms <= 240_000; ms += 1000) {
    t.push(T0 + ms);
    x.push(p[0]);
    y.push(p[1]);
    const s = (ms - 60_000) / 1000;
    const d = bearingVec(s < 0 ? -45 : after(s));
    p = [p[0] + d[0] * v, p[1] + d[1] * v];
  }
  return { t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y) };
}

describe('gybe sets past an offset mark (classifyRounding)', () => {
  const MARK = T0 + 60_000;
  const twd0 = (): number => 0;
  it('a 40 s reach to the offset, then a gybe: a gybe-set (the window runs from the first downwind heading)', () => {
    expect(classifyRounding(rounding((s) => (s < 40 ? -90 : s < 46 ? -150 : 150)), twd0, MARK)).toBe('gybe-set');
  });
  it('the reach, then on down on starboard and a gybe a minute later: a bear-away', () => {
    expect(classifyRounding(rounding((s) => (s < 40 ? -90 : s < 40 + ROUND_WINDOW_MS / 1000 + 30 ? -150 : 150)), twd0, MARK)).toBe('bear-away');
    expect(ROUND_DOWN_MAX_MS).toBe(60_000);
  });
});

// ---- Cascais R2 / R3 (the whole 100-boat fleet)

interface Race {
  a: RaceAnalysis;
  m: CoachModel;
  id: (sail: string) => string;
}
const build = (data: ReturnType<typeof cascaisRace>): Race => {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null, raw.turns ?? null, raw.overStart ?? null)!;
  return { a, m, id: (sail) => a.boats.find((b) => b.sail === sail)!.id };
};
let r2: Race;
let r3: Race;
beforeAll(() => {
  r2 = build(cascaisRace('r2'));
  r3 = build(cascaisRace('r3'));
}, 120_000);

describe('Cascais: gybe sets after the offset mark', () => {
  const rounding = (r: Race, leg: number) => legStories(r.a, r.m, r.id('USA 833'), { kind: 'fleet' })[leg].rounding!;
  it('R2 Run 1: 15+ gybe-setters, who gained clearly more than the bear-aways', () => {
    const s = rounding(r2, 1);
    expect(s.gybeSet.n).toBeGreaterThanOrEqual(15);
    expect(s.gybeSet.gain! - s.bearAway.gain!).toBeGreaterThan(10);
  });
  it('R3 Run 2: the same', () => {
    const s = rounding(r3, 3);
    expect(s.gybeSet.n).toBeGreaterThanOrEqual(15);
    expect(s.gybeSet.gain! - s.bearAway.gain!).toBeGreaterThan(5);
  });
  it('courses without an offset keep their bear-aways (J/105 R3, J/24 R2)', () => {
    for (const data of [j105Race(3), gateRace('j24r2')]) {
      const r = build(data);
      for (const s of legStories(r.a, r.m, r.a.boats[0].id, { kind: 'fleet' })) if (s.rounding) expect(s.rounding.gybeSet.n).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});

describe('Cascais: start places', () => {
  it('USA 833 is placed at the gun from its nearest fix (estimated), not after every ranked boat', () => {
    for (const r of [r2, r3]) {
      const me = r.a.boats.find((b) => b.sail === 'USA 833')!;
      expect(me.start!.startPlace).toBeNull();
      const p = fleetPlaces(r.a).byId.get(me.id)!;
      expect(p.est[0]).toBe(true);
      expect(p.place[0]).toBeLessThan(40);
      const beat1 = legStories(r.a, r.m, me.id, { kind: 'leaders' })[0];
      expect(beat1.mine!.gain).toBeLessThan(42);
      // Placed at the gun from its nearest fix (estimated inside: est), shown plainly.
      expect(placeChip(beat1)).toMatch(/^(gained|lost) \d+ · \d+(st|nd|rd|th) of 100$/);
    }
    // R3: at the pin (0% along the line), among the first ten at the gun; it lost places up Beat 1.
    const p3 = fleetPlaces(r3.a).byId.get(r3.id('USA 833'))!;
    expect(p3.place[0]).toBeLessThanOrEqual(12);
    expect(p3.place[1]! - p3.place[0]!).toBeGreaterThan(0);
  });
  it('a boat with no position near the gun has no start place, and no Beat 1 gain', () => {
    const fp = fleetPlaces(r3.a);
    const unknown = r3.a.boats.filter((b) => fp.byId.get(b.id)?.place[0] === null);
    expect(unknown.length).toBeGreaterThan(0);
    const b = unknown[0];
    const s = legStories(r3.a, r3.m, b.id, { kind: 'fleet' })[0];
    expect(s.mine).toBeNull();
    expect(placeChip(s)).toMatch(/^— · ~?\d+(st|nd|rd|th) of 100$/);
    expect([...s.gainers, ...s.losers].some((m) => unknown.some((u) => u.id === m.id))).toBe(false);
  });
  it('the official start places are unchanged: estPlace keeps their order', () => {
    const ranked = r2.a.boats.filter((b) => b.start?.startPlace != null).sort((p, q) => p.start!.startPlace! - q.start!.startPlace!);
    const est = ranked.map((b) => b.start!.estPlace!);
    expect([...est].sort((p, q) => p - q)).toEqual(est);
  });
});

describe('Cascais: impossible leg splits are unknown', () => {
  it('no leg faster than the ceiling; nothing "fastest" from a glitch', () => {
    for (const r of [r2, r3]) {
      for (const b of r.a.boats) for (const l of b.legs) if (l) expect(l.vmgKn).toBeLessThan(LEG_MAX_KN);
      for (const s of legStories(r.a, r.m, r.id('USA 833'), { kind: 'fleet' })) {
        const med = [...r.a.boats.map((b) => b.legs[s.leg]?.timeS).filter((x): x is number => x != null)].sort((p, q) => p - q);
        expect(s.fastest!.timeS).toBeGreaterThan(0.3 * med[med.length >> 1]);
      }
    }
  });
});

describe('Cascais: the side of the course', () => {
  it('every leg, runs included, has a verdict over most of the fleet', () => {
    for (const r of [r2, r3]) {
      r.a.legs.forEach((_, li) => {
        const s = fleetSide(r.a, r.m, li);
        expect(s).not.toBeNull();
        expect(s!.of).toBeGreaterThanOrEqual(60);
      });
    }
    // R2 Run 2 and R3 Run 2: right paid, clearly (the debrief's "left lost" on both).
    for (const r of [r2, r3]) {
      const s = fleetSide(r.a, r.m, 3)!;
      expect(s.verdict).toBe('right');
      expect(s.z).toBeGreaterThan(D14_MIN_Z);
    }
  });
  it('D14 cards: the boats in the losing third with their own position mid-leg, one card a race; the text names the side and the metres', () => {
    let cards = 0;
    for (const b of r2.a.boats) {
      const d = debriefOf(r2.a, r2.m, b.id)!;
      // One a race: the other legs on the side that didn't pay ride on it ("also …").
      expect(d.cards.filter((x) => x.kind === 'D14').length).toBeLessThanOrEqual(1);
      expect(d.plus.filter((x) => x.detector === 'D14').length).toBeLessThanOrEqual(1);
      for (const c of d.cards.filter((x) => x.kind === 'D14')) {
        cards++;
        const t = cardText(c);
        expect(t.title).toMatch(/^(Left|Right) paid on (Beat|Run) \d$/);
        expect(t.sentence).toMatch(/third of the fleet gained ~\d+ places on the (left|right) third; you were \d+ m (left|right)/);
      }
      for (const p of d.plus.filter((x) => x.detector === 'D14')) expect(wentText(p)).toMatch(/^(Beat|Run) \d: on the (left|right) side, which paid/);
    }
    expect(cards).toBeGreaterThan(0);
    expect(cards).toBeLessThan(r2.a.boats.length);
  }, 60_000);
});

describe('Cascais: the wind at the gun from the fleet’s tacks 0:30–3:30 after it (wind.ts readStartTwd)', () => {
  // Full cached feed (scratch check, not committed): R2 319.8°, R3 317.6°. The fixtures keep the native rate only within
  // ±60 s of the gun (every 10 s after) and read 319.9° / 317.9°: each boat counts once per START_WIND_GRID_MS either way.
  // 0.5° is the most the fixture and the feed parted by over a ±10–12° band and a 1–5 s grid tolerance.
  const FULL_FEED = { r2: 319.8, r3: 317.6 };
  it('R2 and R3: the start window sets the wind at the gun, pinned at the gun; the beats keep their own estimates', () => {
    for (const [k, r] of [['r2', r2], ['r3', r3]] as const) {
      const w = r.a.wind;
      expect(w.gunSource).toBe('start-window');
      expect(w.startWindow!.tMs).toBe(r.a.meta.gunMs);
      expect(w.twdAtGunDeg).toBeCloseTo(w.startWindow!.twdDeg, 9);
      expect(Math.abs(wrap180(w.twdAtGunDeg - FULL_FEED[k]))).toBeLessThan(0.5);
      expect(w.startWindow!.samples).toBeGreaterThanOrEqual(START_WIND_MIN_SAMPLES);
      expect(Math.min(...w.startWindow!.tackSamples)).toBeGreaterThanOrEqual(START_WIND_MIN_TACK_N);
      expect(w.estimates.map((e) => e.legIndex)).toEqual([0, 2]);
      expect(r.a.legs.map((l) => l.kind)).toEqual(['upwind', 'downwind', 'upwind', 'downwind']);
    }
    // R2: right of Beat 1's 314° (the left phase 5–20 min in pulled the whole beat's average left), so the pin is
    // favoured by about 3–5°, not 10°; R3, steadier, moves less.
    expect(wrap180(r2.a.wind.twdAtGunDeg - r2.a.wind.estimates[0].twdDeg)).toBeGreaterThan(4);
    expect(r2.a.line.favored).toBe('left');
    expect(biasAngle(lineBias(r2.a.line, r2.a.wind.twdAtGunDeg))).toBeLessThan(D16_MIN_DEG);
    expect(r2.a.line.favoredByM).toBeGreaterThan(50);
    expect(r2.a.line.favoredByM).toBeLessThan(90);
    expect(Math.abs(wrap180(r3.a.wind.twdAtGunDeg - r3.a.wind.estimates[0].twdDeg))).toBeLessThan(4);
    expect(biasAngle(lineBias(r3.a.line, r3.a.wind.twdAtGunDeg))).toBeGreaterThanOrEqual(D16_MIN_DEG);
  });
  it('labelled where it is shown: the Report header, the line’s ⓘ and the findings', () => {
    const src = windSource(r2.a.wind);
    expect(src.text).toBe("wind estimated from the fleet's tacks 0:30–3:30 after the gun");
    expect(biasBullets(r2.a)[0]).toMatch(/^Favored end vs the wind at the gun; 5° of wind moves it \d+ m\.$/);
    expect(r2.a.findings.find((f) => f.kind === 'wind')!.text).toMatch(/^Wind estimated from the fleet's tack headings: \d+° 0:30–3:30 after the gun, \d+° on Beat 1, \d+° on Beat 2\./);
  });
});

describe('Cascais: the line bias (D16) and thin data', () => {
  it('R3: pin favoured; USA 833 at the pin is a Went well; a boat at the committee-boat end gets the card, against the median', () => {
    const d = debriefOf(r3.a, r3.m, r3.id('USA 833'))!;
    const p = d.plus.find((x) => x.detector === 'D16')!;
    expect(p.facts.favoured).toBe('pin');
    expect(p.facts.deg as number).toBeGreaterThanOrEqual(D16_MIN_DEG);
    expect(wentText(p)).toMatch(/^Start: pin end favored \d+° \(~\d+ m\) and you started \d+ m toward the pin from the fleet's median start \(≈ \d+ m upwind\)$/);
    const far = r3.a.boats.find((b) => b.start && !b.start.over && b.start.linePosPct > 90 && (b.start.dtlGapS == null || b.start.estDtlM != null))!;
    const c = debriefOf(r3.a, r3.m, far.id)!.found.find((o) => o.kind === 'D16')!;
    expect(c.variant).toBe('unfavoured');
    expect(cardText(rankOpportunities([c], 3)[0] ?? { ...c, score: 0, limit: null }).sentence).toMatch(
      /^Pin favored \d+° \(~\d+ m over the line\)\. You started \d+ m toward the committee boat from the fleet's median start: ≈ \d+ m upwind, about \d+ s at the fleet's [\d.]+ kn up the first beat\.$/,
    );
  });
  it('every boat: a card only D16_MATERIAL_S or more beyond the median toward the committee boat; R2 under D16_MIN_DEG has none', () => {
    const med = medianStartPct(r3.a)!;
    let found = 0;
    let cards = 0;
    for (const b of r3.a.boats) {
      const d = debriefOf(r3.a, r3.m, b.id)!;
      cards += d.cards.filter((c) => c.kind === 'D16').length;
      const o = d.found.find((x) => x.kind === 'D16');
      if (!o) continue;
      found++;
      expect(o.seconds).toBeGreaterThanOrEqual(D16_MATERIAL_S);
      expect(o.confidence).toBe('medium');
      expect(b.start!.linePosPct).toBeGreaterThan(med);
      for (const c of d.cards) if (c.kind === 'D16') expect(c.seconds).toBeGreaterThanOrEqual(MIN_SECONDS.medium);
    }
    // Found on 32 boats (31 with 17 trackers' replayed fixes in). The wind is medium confidence (the weather model 10.1°
    // off, over MODEL_AGREE_DEG), and so are the cards, which then need MIN_SECONDS.medium: 17 in their top 3 (16 on the full feed, also medium; 30 in PR #46's 318.0°,
    // the model 9.9° off). 35 before that, the unfavoured third against Beat 1's wind.
    expect(windSource(r3.a.wind).confidence).toBe('medium');
    expect(found).toBe(32);
    expect(cards).toBe(17);
    for (const b of r2.a.boats) expect(debriefOf(r2.a, r2.m, b.id)!.found.some((x) => x.kind === 'D16')).toBe(false);
  }, 120_000);
  it('R2: USA 833 on thin data (37% on the full feed): never a banked-gains ✓ (with the last run read from the gybes it gives a gain back)', () => {
    const d = debriefOf(r2.a, r2.m, r2.id('USA 833'))!;
    expect(d.ok.some((o) => o.detector === 'D5')).toBe(false);
    const ask = raceAskContext({ a: r2.a, me: r2.a.boats.find((b) => b.sail === 'USA 833')!, deb: d, stories: [], group: { kind: 'leaders' }, head: [] });
    expect(ask.notTheProblem ?? []).not.toContain('Banked gains');
  });
  it('R2: USA 684 on thin data (19% here): "Not judged: banked gains", never ✓, no tracker %', () => {
    const d = debriefOf(r2.a, r2.m, r2.id('USA 684'))!;
    const d5 = d.ok.find((o) => o.detector === 'D5')!;
    expect(d5.thin).toBe(true);
    expect(goodTexts(d5)[0]).toBe('Not judged: banked gains');
    const ask = raceAskContext({ a: r2.a, me: r2.a.boats.find((b) => b.sail === 'USA 684')!, deb: d, stories: [], group: { kind: 'leaders' }, head: [] });
    expect(ask.notJudged).toContain(goodTexts(d5)[0]);
    expect(ask.notTheProblem ?? []).not.toContain('Banked gains');
    expect(sanitizeAskContext(ask)!.notJudged).toEqual(ask.notJudged);
  });
});

describe('D17 over the whole fleet (with coachManoeuvreFleet.test.ts: every committed fixture)', () => {
  // 10 s apart away from the gun and the windward marks: a handful of turns measured, no leg with a fleet reference.
  it('R2 and R3: no D17 card, finding or Went well line', () => {
    expect(d17Tally(r2.a, r2.m)).toEqual({ cards: 0, found: 0, plus: 0 });
    expect(d17Tally(r3.a, r3.m)).toEqual({ cards: 0, found: 0, plus: 0 });
  }, 120_000);
});

describe('D15 fast but going nowhere: quiet on ordinary noise', () => {
  it('fires on few boats of the committed fixtures, and only fast ones with D15_VMG_DROP less VMG', () => {
    for (const data of [j105Race(3), gateRace('j24r5')]) {
      const r = build(data);
      let n = 0;
      for (const b of r.a.boats) {
        for (const o of debriefOf(r.a, r.m, b.id)!.found.filter((x) => x.kind === 'D15')) {
          n++;
          expect(o.facts.sog as number).toBeGreaterThanOrEqual(o.facts.fSog as number);
          expect(o.facts.vmg as number).toBeLessThanOrEqual((o.facts.fVmg as number) * (1 - D15_VMG_DROP));
          expect(cardText({ ...o, score: o.seconds, limit: null }).title).toMatch(/^Fast but not (climbing|going deep) on (Beat|Run) \d$/);
        }
      }
      expect(n).toBeLessThanOrEqual(Math.ceil(r.a.boats.length / 4));
    }
  }, 60_000);
});

describe('ranking and themes for the new cards', () => {
  const opp = (o: Partial<Opportunity>): Opportunity => ({
    kind: 'D15',
    variant: 'upwind',
    t0: 0,
    t1: 600_000,
    seconds: 60,
    secondsLo: 40,
    secondsHi: 80,
    confidence: 'high',
    coverage: 1,
    conf: { boatCov: 1 },
    facts: {},
    refBoats: [],
    ...o,
  });
  it('a penalty turn is still taken first: the leg finding gives up the loop’s stretch', () => {
    const cards = rankOpportunities([opp({}), opp({ kind: 'D12', variant: '360', t0: 100_000, t1: 160_000, seconds: 30, secondsLo: 20, secondsHi: 40 })]);
    expect(cards.find((c) => c.kind === 'D12')!.seconds).toBe(30);
    // 60 s over 600 s, less the loop's 60 s pro rata.
    expect(cards.find((c) => c.kind === 'D15')!.seconds).toBeCloseTo(54, 6);
  });
  it('Regatta themes, labels and tips', () => {
    expect(themeKey('D14', 'wrong-side')).toBe('side');
    expect(themeKey('D15', 'upwind')).toBe('distance');
    expect(themeKey('D16', 'unfavoured')).toBe('line-end');
    for (const k of ['side', 'distance', 'line-end']) expect(themeOf(k).label).not.toBe(k);
    for (const [k, v] of [['D14', 'wrong-side'], ['D15', 'upwind'], ['D16', 'unfavoured']] as const) expect(tipOf(k, v).length).toBeGreaterThan(10);
  });
});
