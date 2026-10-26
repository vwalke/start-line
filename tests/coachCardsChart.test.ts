import { describe, expect, it } from 'vitest';
import { rivalLadder, type CoachModel } from '../src/analysis/coach';
import { D9_SHIFT_SECONDS } from '../src/analysis/coach/detectors/rounding';
import { groupIds } from '../src/analysis/coach/groups';
import { GAP_STEP_MS, gapCourse, groupGap, timeGapSeries } from '../src/analysis/coach/timeGap';
import { COACH_MAX_SPAN_S } from '../src/analysis/coach/tracks';
import type { GapReading, GoodNote, Opportunity } from '../src/analysis/coach/opportunity';
import { median } from '../src/analysis/geo';
import type { RaceAnalysis } from '../src/analysis/types';
import { cardText } from '../src/ui/coachCards';
import { cascaisRace, coachRace, debriefOf, gateRace, j105Race, type CoachRace } from './helpers';

/**
 * The cards read the chart's gap (timeGap.ts groupGap: time at equal course progress, the same points), so a card can
 * never tell another story than the chart: every gap a card or a Went well line read (Opportunity.gaps) is the chart's
 * value at that time for that group (Custom: those boats; the default Top 3 when they are the leaders), and its seconds
 * are the chart's change between the two points.
 */

/** The chart's value at `t` for the reading's group (its bold line) or its `boat` (that boat's thin line). */
function chartAt(r: CoachRace, boat: string, g: GapReading, t: number, group = { kind: 'custom' as const, ids: g.ids }): number | null | undefined {
  const l = rivalLadder(r.m, r.a, boat, group)!;
  const p = l.points.find((q) => q.tMs === t);
  if (!p) return undefined;
  return g.boat != null ? p.each[l.group.indexOf(g.boat)] : p.behindS;
}

/** Whether `g` reads the default chart (Top 3) of `boat`. */
const isTop3 = (a: RaceAnalysis, boat: string, g: GapReading): boolean => {
  const top = groupIds(a.boats, boat, { kind: 'leaders' });
  return g.boat == null && g.ids.length === top.length && g.ids.every((id) => top.includes(id));
};

/** The seconds a card's readings give, by detector (the card's own rule), s. */
function secondsOf(o: Opportunity): number {
  const d = o.gaps!.map((g) => g.g1 - g.g0);
  switch (o.kind) {
    case 'D3':
      return Math.max(0, d[0]);
    case 'D4':
    case 'D5':
      return d[0];
    case 'D8':
      return d.reduce((s, x) => s + x, 0);
    case 'D9':
      return Math.max(0, d[0]) * (o.facts.shiftSide != null ? D9_SHIFT_SECONDS : 1);
    case 'D10':
      return Math.max(0, median(d));
    default:
      throw new Error(`no gap rule for ${o.kind}`);
  }
}

/** The kinds that read the gap: they must say which points (none of them reads another gap). */
const reads = (o: Opportunity): boolean => ['D3', 'D4', 'D5', 'D8', 'D10'].includes(o.kind) || (o.kind === 'D9' && o.facts.mode === 'places') || (o.kind === 'D1' && o.facts.d3S != null);

/** Every reading of the race's debriefs checked against the chart; how many. */
function checkRace(r: CoachRace, boats = r.a.boats.map((b) => b.id)): { readings: number; cards: number } {
  let readings = 0;
  let cards = 0;
  const check = (boat: string, gs: GapReading[]): void => {
    for (const g of gs) {
      readings++;
      expect(g.t1).toBeGreaterThan(g.t0);
      expect(chartAt(r, boat, g, g.t0)).toBe(g.g0);
      expect(chartAt(r, boat, g, g.t1)).toBe(g.g1);
      // The page's default chart, when the card read the top 3: the very same points.
      if (isTop3(r.a, boat, g)) {
        expect(chartAt(r, boat, g, g.t0, { kind: 'leaders' } as never)).toBe(g.g0);
        expect(chartAt(r, boat, g, g.t1, { kind: 'leaders' } as never)).toBe(g.g1);
      }
    }
  };
  for (const boat of boats) {
    const d = debriefOf(r.a, r.m, boat);
    if (!d) continue;
    for (const o of d.found) {
      if (!reads(o)) {
        expect(o.gaps).toBeUndefined();
        continue;
      }
      if (o.kind === 'D9' && !o.gaps) {
        // No chart point near a place read: no seconds.
        expect(o.seconds).toBe(0);
        continue;
      }
      expect(o.gaps?.length).toBeGreaterThan(0);
      check(boat, o.gaps!);
      if (o.kind === 'D1') expect(o.facts.d3S as number).toBeCloseTo(Math.max(0, o.gaps![0].g1 - o.gaps![0].g0), 9);
      else expect(o.seconds).toBeCloseTo(secondsOf(o), 9);
      if (o.kind === 'D5') expect([o.facts.gPeak, o.facts.gTrough]).toEqual([o.gaps![0].g0, o.gaps![0].g1]);
      if (o.kind === 'D3') expect(o.facts.gapEnd).toBe(o.gaps![0].g1);
    }
    // A card shows the detector's seconds, less what a higher card already claims of the same minutes (rank.ts).
    for (const c of d.cards) {
      if (!c.gaps) continue;
      cards++;
      const o = d.found.find((x) => x.kind === c.kind && x.t0 === c.t0 && x.variant === c.variant)!;
      expect(c.gaps).toEqual(o.gaps);
      expect(c.seconds).toBeLessThanOrEqual(o.seconds + 1e-9);
    }
    for (const n of d.plus as GoodNote[]) {
      if (n.detector !== 'gap' && !(n.detector === 'D3' && n.variant === 'lane')) continue;
      expect(n.gaps).toHaveLength(1);
      check(boat, n.gaps!);
      expect(n.seconds).toBeCloseTo(n.gaps![0].g0 - n.gaps![0].g1, 9);
    }
  }
  return { readings, cards };
}

/** Cascais R3 (100 boats): built once for the file. */
const cascais3 = coachRace(cascaisRace('r3'));

describe('the cards read the chart: card seconds = the chart\'s change for the same group, on the fixtures', () => {
  it('J/105 CBC race 3, every boat', () => {
    const { readings, cards } = checkRace(coachRace(j105Race(3)));
    expect(readings).toBeGreaterThan(20);
    expect(cards).toBeGreaterThan(10);
  }, 60_000);

  it('J/24 R2 and Melges 24 R5, every boat', () => {
    for (const key of ['j24r2', 'm24r5'] as const) {
      const { readings, cards } = checkRace(coachRace(gateRace(key)));
      expect(readings).toBeGreaterThan(20);
      expect(cards).toBeGreaterThan(5);
    }
  }, 120_000);

  it('Cascais (J/70 Worlds) R3, every boat', () => {
    const { readings, cards } = checkRace(cascais3);
    expect(readings).toBeGreaterThan(50);
    expect(cards).toBeGreaterThan(20);
  }, 120_000);
});

describe('the Good Trade R3 Beat 2 case (J/105 CBC race 3, 2:56 pm): the card says what the chart says', () => {
  const r = coachRace(j105Race(3));
  const GT = 'USA 96';
  const edt = (hhmmss: string): number => Date.parse(`2026-10-18T${hhmmss}-04:00`);
  /** Official R3 4th–9th: the boats the D5 card compares with (the tracked 5th–10th). */
  const R3_4TH_9TH = ['USA 523', 'USA 242', 'USA 64', 'USA 215', 'USA 250', 'USA 343'];

  it('12.5 s behind at 2:56 pm on the chart and on the card (the wind ladder said 68 s ahead), 98 s behind by 3 pm', () => {
    const c = debriefOf(r.a, r.m, GT)!.cards.find((x) => x.kind === 'D5')!;
    expect(c.refBoats.slice().sort()).toEqual(R3_4TH_9TH.slice().sort());
    const l = rivalLadder(r.m, r.a, GT, { kind: 'custom', ids: R3_4TH_9TH })!;
    const at = (t: number) => l.points.find((p) => p.tMs === t)!.behindS!;
    expect(c.facts.tPeak).toBe(edt('14:56:01'));
    expect(c.facts.gPeak).toBe(at(edt('14:56:01')));
    expect(c.facts.gPeak as number).toBeCloseTo(12.5, 1);
    expect(c.facts.gTrough).toBe(at(c.facts.tTrough as number));
    expect(c.seconds).toBeCloseTo(at(c.facts.tTrough as number) - at(edt('14:56:01')), 9);
    // Behind, so never "up" or "ahead" in the words.
    const t = cardText(c, r.a.meta.tzOffsetMs);
    expect(`${t.sentence} ${t.chips.join(' ')}`).not.toMatch(/ up\b|ahead/);
    expect(t.sentence).toContain('you closed to 12 s behind');
    expect(t.chips).toContain('12 s down → 98 s down');
  });
});

describe('Cascais (J/70 Worlds) R3, USA 833: its cards against its chart', () => {
  const r = cascais3;
  const me = r.a.boats.find((b) => b.sail === 'USA 833')!;
  const d = debriefOf(r.a, r.m, me.id)!;
  const m: CoachModel = r.m;

  it('the leeward gate places finding (D9): its seconds are the chart\'s change for the boats that passed it', () => {
    // Found, no longer in the top 3 (a D12 card and a larger D7 rank above it) since the replayed fixes went.
    const c = d.found.find((x) => x.kind === 'D9' && x.facts.mark === 'Leeward gate')!;
    expect(c.facts.mode).toBe('places');
    const [g] = c.gaps!;
    expect(g.ids).toEqual(c.refBoats);
    const l = rivalLadder(m, r.a, me.id, { kind: 'custom', ids: g.ids })!;
    const at = (t: number) => l.points.find((p) => p.tMs === t)!.behindS!;
    expect(c.seconds).toBeCloseTo(at(g.t1) - at(g.t0), 9);
    // Got 33.2 s for 11 places (36.4 s for 12, on distance to go ÷ the fleet's VMG 36.8 s, with 17 trackers' replayed fixes
    // zig-zagging the fleet: BRA1440 counted among the passers).
    expect(Math.abs(c.seconds - 33.2)).toBeLessThan(1);
  });

  it('the last run (D10): each named boat\'s seconds are its own line on the chart', () => {
    const c = d.cards.find((x) => x.kind === 'D10')!;
    for (const g of c.gaps!) {
      const l = rivalLadder(m, r.a, me.id, { kind: 'custom', ids: g.ids })!;
      const k = l.group.indexOf(g.boat!);
      const at = (t: number) => l.points.find((p) => p.tMs === t)!.each[k]!;
      expect(g.g1 - g.g0).toBeCloseTo(at(g.t1) - at(g.t0), 9);
    }
    // TUR 442 53 s, SWE 1121 29 s; the card's seconds the median of the two. (Before the finish was anchored to the finish
    // times, 70 s and 56 s: at 16:29:21 the lines read 17 s and 55 s, against finishes 1.1 s and 4.2 s ahead. On the wind
    // ladder: 70 s and 35 s.) Both were behind at the window's start (TUR 442 49 s, SWE 1121 11 s): they gained on USA 833
    // and finished ahead, not "further ahead".
    expect(Math.round(c.facts.da as number)).toBe(53);
    expect(Math.round(c.facts.db as number)).toBe(29);
    expect(c.seconds).toBeCloseTo(median(c.gaps!.map((g) => g.g1 - g.g0)), 9);
    expect(c.facts.fromBehind).toBe(2);
    expect(cardText(c, r.a.meta.tzOffsetMs).sentence).toBe('TUR 442 gained 53 s and SWE 1121 29 s on you over the last 6 tracked minutes, and finished ahead.');
  });

  it('at its finish the chart reads TUR 442 and SWE 1121 at their finish margins (1.1 s and 4.2 s), not 17 s and 55 s', () => {
    const ids = ['TUR 442', 'SWE 1121'].map((s) => r.a.boats.find((b) => b.sail === s)!.id);
    const fin = (id: string) => (me.finishMs! - r.a.boats.find((b) => b.id === id)!.finishMs!) / 1000;
    expect(ids.map(fin).map((x) => +x.toFixed(1))).toEqual([1.1, 4.2]);
    const { course, lw } = gapCourse(m);
    const [p] = timeGapSeries(course, lw, m.tracks.get(me.id)!, ids.map((id) => m.tracks.get(id)!), me.finishMs!, me.finishMs!);
    ids.forEach((id, k) => expect(p.each[k]).toBeCloseTo(fin(id), 6));
    // The chart's last point, 16:29:41, 2 s before the finish: 1.5 s and 5.6 s.
    const l = rivalLadder(m, r.a, me.id, { kind: 'custom', ids })!;
    const last = l.points.at(-1)!;
    expect(me.finishMs! - last.tMs).toBeLessThan(GAP_STEP_MS);
    l.group.forEach((id, k) => expect(Math.abs(last.each[k]! - fin(id))).toBeLessThan(1.5));
  });
});

describe('the chart at the finish: each finisher\'s gap to every other is their finish times\' difference', () => {
  /**
   * On every boat whose track covers its finish (its last fix within COACH_MAX_SPAN_S of it), against every other: at the
   * finish time exactly, to float precision (the finish is anchored to the finish times: timeGap.ts FINISH_IN_M); at the
   * chart's last point (≤ GAP_STEP_MS before the finish), within what the boats' last seconds differ by: a median ≤ 1 s
   * and a 90th percentile ≤ 5 s (a boat 10–20 % slower over the last 10 s, 1–2 s; a stall at the line, the tail). Before
   * (the feed's line, no anchor): Cascais R3 USA 833 read 17 s and 55 s 22 s before finishing 1.1 s and 4.2 s behind.
   */
  function checkFinish(r: CoachRace): { pairs: number; lastMed: number; lastP90: number } {
    const { course, lw } = gapCourse(r.m);
    const n = course.kinds.length;
    const covers = r.a.boats.filter((b) => {
      const tr = r.m.tracks.get(b.id);
      const fin = tr?.bounds[n];
      if (b.finishMs == null || fin == null || fin !== b.finishMs) return false;
      const before = [...tr!.t].filter((t) => t <= fin).at(-1);
      return before != null && fin - before <= COACH_MAX_SPAN_S * 1000;
    });
    let pairs = 0;
    const last: number[] = [];
    for (const b of covers) {
      const others = covers.filter((x) => x.id !== b.id);
      const margin = others.map((o) => (b.finishMs! - o.finishMs!) / 1000);
      const [p] = timeGapSeries(course, lw, r.m.tracks.get(b.id)!, others.map((o) => r.m.tracks.get(o.id)!), b.finishMs!, b.finishMs!);
      others.forEach((_, k) => {
        expect(p.each[k]).not.toBeNull();
        expect(Math.abs(p.each[k]! - margin[k])).toBeLessThan(1e-6);
        pairs++;
      });
      const lp = groupGap(r.m, b.id, others.map((o) => o.id), b.finishMs! - GAP_STEP_MS, b.finishMs!).at(-1);
      others.forEach((_, k) => {
        if (lp?.each[k] != null) last.push(Math.abs(lp.each[k]! - margin[k]));
      });
    }
    last.sort((x, y) => x - y);
    return { pairs, lastMed: median(last), lastP90: last[Math.floor(0.9 * (last.length - 1))] };
  }

  it('Cascais R3 (the feed\'s line 158 m from where the fleet finished; 77–384 m on three other fixtures)', () => {
    const c = checkFinish(cascais3);
    expect(c.pairs).toBeGreaterThan(5000);
    expect(c.lastMed).toBeLessThanOrEqual(1);
    expect(c.lastP90).toBeLessThanOrEqual(5);
  }, 120_000);

  it('J/105 R3, J/24 R2, Melges 24 R5, Viper R2', () => {
    for (const race of [coachRace(j105Race(3)), coachRace(gateRace('j24r2')), coachRace(gateRace('m24r5')), coachRace(gateRace('viperr2'))]) {
      const c = checkFinish(race);
      expect(c.pairs).toBeGreaterThan(100);
      expect(c.lastMed).toBeLessThanOrEqual(1);
      expect(c.lastP90).toBeLessThanOrEqual(5);
    }
  }, 120_000);

  it('the line the fleet finished on: fitted 4–12 m from the feed\'s where that holds (J/105 R3: 11 m), 158 m from it on Cascais R3', () => {
    const off = (r: CoachRace): number => {
      const f = gapCourse(r.m).course.finish!;
      const g = r.m.course.finish!;
      return Math.hypot((f.left[0] + f.right[0] - g.left[0] - g.right[0]) / 2, (f.left[1] + f.right[1] - g.left[1] - g.right[1]) / 2);
    };
    expect(off(coachRace(j105Race(3)))).toBeLessThan(15);
    expect(off(cascais3)).toBeGreaterThan(100);
  });
});
