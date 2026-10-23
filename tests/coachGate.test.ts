/**
 * D13 · gate choice, unit by unit on hand-built inputs: the side read and its labelling (looking upwind, from the
 * geometry, never the feed's roles), the traffic excuse, the outlier and penalty-turn skips, the netting against the
 * next beat's side, the ➕ mirror, D9's places as a chip, the wording, and D13 as a moment in the ranking.
 */
import { describe, expect, it } from 'vitest';
import type { Vec } from '../src/analysis/geo';
import type { LegKind, RaceAnalysis } from '../src/analysis/types';
import { GATE_FIX_GAP_S, gateGeoms, sideRead, type GateGeom } from '../src/analysis/coach/gateSides';
import { busy, D13_OUTLIER, judgeGate, windRange, type GateBoat, type GateJudgeInput, type GateRead } from '../src/analysis/coach/detectors/gate';
import { attachGatePlaces } from '../src/analysis/coach/debrief';
import { rankOpportunities } from '../src/analysis/coach/rank';
import type { GoodNote, Opportunity } from '../src/analysis/coach/opportunity';
import { cardText, goodTexts, wentText } from '../src/ui/coachCards';
import type { Card } from '../src/analysis/coach/rank';

/** A race with a beat, a run to a two-buoy gate at `gate` (buoys `pts`, in the feed's order), a beat to `top`. */
function course(pts: Vec[], top: Vec, gate: Vec = [0, 0]): Pick<RaceAnalysis, 'legs' | 'marks' | 'legSource' | 'legPts'> {
  const kinds: LegKind[] = ['upwind', 'downwind', 'upwind', 'downwind'];
  const names = ['W1', 'GATE', 'W2', 'Finish'];
  return {
    legs: kinds.map((kind, i) => ({ index: i, name: `${kind === 'upwind' ? 'Beat' : 'Run'} ${(i >> 1) + 1}`, kind, to: names[i] })) as RaceAnalysis['legs'],
    marks: [
      { name: 'W1', xy: [top] },
      { name: 'GATE', xy: pts },
      { name: 'W2', xy: [top] },
    ],
    legSource: 'course',
    legPts: [[0, -200], top, gate, top, [0, -200]],
  };
}

describe('the side read: looking upwind, from the geometry', () => {
  it('names the buoys left / right looking up the next beat, whatever order the feed lists them in', () => {
    const north = gateGeoms(course([[40, 0], [-40, 0]], [0, 1000]))[0];
    expect(north.leg).toBe(1);
    expect(north.left).toEqual([-40, 0]);
    expect(north.right).toEqual([40, 0]);
    expect(gateGeoms(course([[-40, 0], [40, 0]], [0, 1000]))[0].left).toEqual([-40, 0]);
    // The beat goes south: west is on the right looking up it.
    const south = gateGeoms(course([[40, 0], [-40, 0]], [0, -1000]))[0];
    expect(south.right).toEqual([-40, 0]);
    // Up the beat to the north-east: the buoy to the north-west is on the left.
    const ne = gateGeoms(course([[-30, 30], [30, -30]], [700, 700]))[0];
    expect(ne.left).toEqual([-30, 30]);
  });

  it('only a two-buoy gate, both tracked, from a run into a beat', () => {
    const c = course([[40, 0], [-40, 0]], [0, 1000]);
    expect(gateGeoms({ ...c, marks: c.marks.map((m) => (m.name === 'GATE' ? { ...m, estimated: true } : m)) })).toEqual([]);
    expect(gateGeoms({ ...c, marks: c.marks.map((m) => (m.name === 'GATE' ? { ...m, xy: [[0, 0]] } : m)) })).toEqual([]);
    expect(gateGeoms({ ...c, legSource: 'none' })).toEqual([]);
  });

  const g: GateGeom = { leg: 1, left: [-40, 0], right: [40, 0], centre: [0, 0], up: [0, 1] };
  /** A boat coming down at x = `x` (1 fix per `step` s), round at y = −5, back up. */
  const track = (x: number, step = 1, hole: [number, number] | null = null) => {
    const t: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let s = -120; s <= 120; s += step) {
      if (hole && s > hole[0] && s < hole[1]) continue;
      t.push(1e6 + s * 1000);
      xs.push(x);
      ys.push(Math.abs(s) * 3 - 5);
    }
    return { id: 'b', t: Float64Array.from(t), x: Float64Array.from(xs), y: Float64Array.from(ys) };
  };

  it('the nearer buoy at the closest approach, when it is clearly nearer and the fixes are close enough', () => {
    expect(sideRead(track(-38), g, 1e6)).toMatchObject({ side: 'left' });
    expect(sideRead(track(35), g, 1e6)).toMatchObject({ side: 'right' });
    // Between the buoys: 15 m vs 25 m is not clearly nearer (0.6).
    expect(sideRead(track(-5), g, 1e6)).toBeNull();
    // Nowhere near.
    expect(sideRead(track(-300), g, 1e6)).toBeNull();
    // A fix every 6 s passes; a 10 s hole beside the rounding doesn't.
    expect(sideRead(track(-38, GATE_FIX_GAP_S), g, 1e6)).toMatchObject({ side: 'left' });
    expect(sideRead(track(-38, 1, [20, 31]), g, 1e6)).toBeNull();
  });
});

/** A confirmed gate favouring the right buoy: 6 boats a side, the right 28 s quicker, ~9 s on the beat. */
const gate: Pick<GateRead, 'evaluated' | 'fav' | 'confirmed' | 'medianPassS' | 'empS' | 'beatS' | 'n'> = {
  evaluated: true,
  fav: 'right',
  confirmed: true,
  medianPassS: 230,
  empS: 28,
  beatS: 9,
  n: { left: 6, right: 6 },
};
const boat = (o: Partial<GateBoat> = {}): GateBoat => ({
  id: 'b',
  side: 'left',
  tMs: 100_000,
  dNear: 3,
  dFar: 78,
  tDn: 40_000,
  tUp: 280_000,
  passS: 240,
  placeDn: 5,
  placeUp: 10,
  gained: -5,
  dS: 40,
  nOther: 5,
  traffic: 0,
  trafficS: null,
  ...o,
});
const input = (o: Partial<GateJudgeInput> = {}): GateJudgeInput => ({ turns: [], windRangeDeg: 3, net: () => null, ...o });

describe('judgeGate: who gets the ➖', () => {
  it('the unfavoured buoy, 5 s or more slower than the other side: the side difference (at most its own loss), its range', () => {
    expect(judgeGate(gate, boat(), input())).toMatchObject({ kind: 'card', seconds: 28, lo: 9, hi: 40, level: 'high', shift: false, netS: null });
    expect(judgeGate(gate, boat({ dS: 12 }), input())).toMatchObject({ kind: 'card', seconds: 12, lo: 9, hi: 12 });
    expect(judgeGate(gate, boat({ dS: 4 }), input())).toEqual({ kind: 'none', why: 'not-slower' });
  });

  it('confidence: medium with under 5 boats a side, low when the wind moved 10° around the rounding', () => {
    expect(judgeGate({ ...gate, n: { left: 4, right: 9 } }, boat(), input())).toMatchObject({ kind: 'card', level: 'medium' });
    expect(judgeGate(gate, boat(), input({ windRangeDeg: 12 }))).toMatchObject({ kind: 'card', level: 'low', shift: true });
  });

  it('nothing when the gate is not favoured or not confirmed; not judged without the data', () => {
    expect(judgeGate({ ...gate, fav: null }, boat(), input())).toEqual({ kind: 'none', why: 'not-favoured' });
    expect(judgeGate({ ...gate, confirmed: false }, boat(), input())).toEqual({ kind: 'none', why: 'not-favoured' });
    expect(judgeGate({ ...gate, evaluated: false }, boat(), input())).toEqual({ kind: 'skip' });
    expect(judgeGate(gate, boat({ nOther: 2 }), input())).toEqual({ kind: 'skip' });
    expect(judgeGate(gate, boat({ passS: null, dS: null }), input())).toEqual({ kind: 'skip' });
  });

  it(`a passage over ${D13_OUTLIER} × the median is a stop, not the choice`, () => {
    expect(judgeGate(gate, boat({ passS: 380 }), input())).toEqual({ kind: 'none', why: 'outlier' });
    expect(judgeGate(gate, boat({ passS: 360 }), input()).kind).toBe('card');
  });

  it('a penalty turn (D12) in the passage: no card; one outside it changes nothing', () => {
    expect(judgeGate(gate, boat(), input({ turns: [{ t0: 200_000, t1: 230_000 }] }))).toEqual({ kind: 'none', why: 'turn' });
    expect(judgeGate(gate, boat(), input({ turns: [{ t0: 400_000, t1: 430_000 }] })).kind).toBe('card');
  });

  it('the traffic excuse: 3+ boats rounded the favoured buoy in the 20 s before, and they were no quicker through the passage', () => {
    expect(busy({ traffic: 3, trafficS: -2 })).toBe(true);
    expect(busy({ traffic: 3, trafficS: null })).toBe(true);
    expect(busy({ traffic: 2, trafficS: 0 })).toBe(false);
    // The queue still came out ~40 s ahead (J/24 R2 USA 2607): no excuse.
    expect(busy({ traffic: 4, trafficS: -40 })).toBe(false);
    expect(judgeGate(gate, boat({ traffic: 3, trafficS: -2, dS: 20 }), input())).toMatchObject({ kind: 'ok', variant: 'traffic' });
    expect(judgeGate(gate, boat({ traffic: 3, trafficS: 1, dS: -4, gained: 2 }), input())).toMatchObject({ kind: 'plus', variant: 'traffic', seconds: 4 });
    expect(judgeGate(gate, boat({ traffic: 4, trafficS: -40 }), input()).kind).toBe('card');
  });
});

describe('judgeGate: netting against the next beat, and the ➕ mirror', () => {
  it('the side that paid up the next beat nets its gain against the cost: less ➖, or a ➕ when it more than paid', () => {
    const paid = (gainS: number) => input({ net: () => ({ gainS, side: 'left' }) });
    expect(judgeGate(gate, boat({ dS: 30 }), paid(10))).toMatchObject({ kind: 'card', seconds: 18, netS: -20, beatSide: 'left' });
    const v = judgeGate(gate, boat({ dS: 30 }), paid(10));
    if (v.kind !== 'card') throw new Error('card');
    expect(v.lo).toBeCloseTo(9 * (18 / 28));
    expect(v.hi).toBeCloseTo(30 * (18 / 28));
    expect(judgeGate(gate, boat({ dS: 30 }), paid(40))).toMatchObject({ kind: 'plus', variant: 'net', seconds: 10, netS: 10, beatSide: 'left' });
    // No gain up the beat (or the side didn't pay for it: net() null): the card as it was.
    expect(judgeGate(gate, boat({ dS: 30 }), paid(-5))).toMatchObject({ kind: 'card', seconds: 28, netS: null });
    expect(judgeGate(gate, boat({ dS: 30 }), input())).toMatchObject({ kind: 'card', seconds: 28, netS: null });
  });

  it('the favoured buoy and 2+ places gained between the contours is ➕ (the seconds gained on the other side)', () => {
    expect(judgeGate(gate, boat({ side: 'right', dS: -35, gained: 3 }), input())).toMatchObject({ kind: 'plus', variant: 'fav', seconds: 35 });
    expect(judgeGate(gate, boat({ side: 'right', dS: 2, gained: 2 }), input())).toMatchObject({ kind: 'plus', variant: 'fav', seconds: 9 });
    expect(judgeGate(gate, boat({ side: 'right', dS: -35, gained: 1 }), input())).toEqual({ kind: 'none', why: 'no-gain' });
  });
});

describe('the wind around the rounding', () => {
  it('windRange: the series’ spread over the window, through north', () => {
    expect(windRange((t) => 355 + t / 60_000, 0, 10 * 60_000)).toBeCloseTo(10);
    expect(windRange(() => 300, 0, 10 * 60_000)).toBe(0);
  });
});

const opp = (o: Partial<Opportunity>): Opportunity => ({
  kind: 'D13',
  variant: 'unfavoured',
  t0: 0,
  t1: 240_000,
  seconds: 28,
  secondsLo: 9,
  secondsHi: 40,
  confidence: 'high',
  coverage: 1,
  conf: { boatCov: 1, refCap: 'high' },
  facts: {},
  refBoats: [],
  ...o,
});

describe("D9's places at the same gate: a chip on D13's card", () => {
  const d13 = opp({ facts: { leg: 'Run 1' } });
  const places = opp({ kind: 'D9', variant: 'leeward', seconds: 22, facts: { mode: 'places', leg: 'Run 1', before: 10, after: 18, fleet: 33 } });
  const zone = opp({ kind: 'D9', variant: 'leeward', seconds: 12, facts: { mode: 'zone', leg: 'Run 1' } });
  const other = opp({ kind: 'D9', variant: 'windward', seconds: 15, facts: { mode: 'places', leg: 'Beat 1' } });

  it('moves the sparse-data places at that rounding onto the card; the zone-time card and other marks stay cards', () => {
    const r = attachGatePlaces([d13], [places, zone, other]);
    expect(r.round).toEqual([zone, other]);
    expect(r.gate[0].chips).toEqual([{ kind: 'D9', facts: { ...places.facts, seconds: 22 } }]);
  });

  it('with no D13 card at that gate, D9 keeps its card', () => {
    expect(attachGatePlaces([], [places])).toEqual({ gate: [], round: [places] });
    expect(attachGatePlaces([opp({ facts: { leg: 'Run 2' } })], [places]).round).toEqual([places]);
  });
});

describe('the wording', () => {
  const facts = { mark: 'Leeward gate', nth: 1, of: 1, leg: 'Run 1', side: 'left', fav: 'right', deltaM: 17.2, beatS: 9.1, runS: 5.9, empS: 30.9, ownS: 46.2, gained: -10, traffic: 1, trafficS: -30, nFav: 24, nOther: 9, shift: 0 };
  const card = (f: Record<string, number | string | null>, chips?: Card['chips']): Card => ({ ...opp({ facts: f, chips }), score: 28, limit: null });

  it('the design’s card: the buoy looking upwind, metres, seconds on the beat, the other side’s seconds, places', () => {
    const t = cardText(card(facts));
    expect(t.title).toBe('Unfavored gate mark (left)');
    expect(t.sentence).toBe(
      'Leeward gate: took the left mark (looking upwind) — 17 m further downwind, about 9 s on the beat. Boats rounding the right mark at the same time were 46 s quicker 300 m up the beat; you lost 10 places.',
    );
    expect(t.chips).toEqual(['left mark · 17 m downwind', 'right side 31 s quicker', 'lost 10 places']);
  });

  it('netted, with D9’s places as the third chip', () => {
    const t = cardText(card({ ...facts, netS: -20, beatSide: 'left' }, [{ kind: 'D9', facts: { before: 12, after: 20, fleet: 33 } }]));
    expect(t.sentence).toMatch(/ The left paid up the next beat: net −20 s\.$/);
    expect(t.chips[2]).toBe('12th → 20th of 33 at the mark');
  });

  it('the ➕ and ✓ lines', () => {
    const note = (variant: string, kind: GoodNote['kind'], f: Record<string, number | string | null>): GoodNote => ({ kind, detector: 'D13', variant, facts: { ...facts, ...f }, t0: 0, t1: 1, seconds: 4 });
    expect(wentText(note('net', 'plus', { netS: 4, beatSide: 'left', deltaM: 18, beatS: 6 }))).toBe(
      'Leeward gate: took the left gate (unfavored by ~18 m / 6 s), and the left paid off up the next beat — net +4 s',
    );
    expect(goodTexts(note('traffic', 'ok', { traffic: 4, gained: 0 }))).toEqual(['Leeward gate: favored gate was busy (4 boats ahead) — the clear one was reasonable']);
    expect(wentText(note('fav', 'plus', { side: 'right', gained: 9 }))).toBe('Leeward gate: took the favored right mark (17 m further upwind) and gained 9 places');
  });
});

describe('ranking: D13 is a moment (seconds × confidence), never trimmed as a rate', () => {
  it('keeps its passage against an overlapping shift window (D4), which gives up the overlap instead', () => {
    const gateCard = opp({ t0: 0, t1: 240_000, seconds: 30, secondsLo: 9, secondsHi: 46 });
    const d4 = opp({ kind: 'D4', variant: 'headed', t0: 60_000, t1: 420_000, seconds: 80, secondsLo: 60, secondsHi: 100, conf: { boatCov: 1 } });
    const cards = rankOpportunities([d4, gateCard]);
    expect(cards.find((c) => c.kind === 'D13')!.seconds).toBe(30);
    expect(cards.find((c) => c.kind === 'D4')!.seconds).toBeCloseTo(80 * (180 / 360));
  });

  it('scored by its confidence: low weighs 0.4 and needs 30 s', () => {
    const low = rankOpportunities([opp({ seconds: 31, conf: { boatCov: 1, refCap: 'low' } })]);
    expect(low[0].confidence).toBe('low');
    expect(low[0].score).toBeCloseTo(31 * 0.4);
    expect(rankOpportunities([opp({ seconds: 25, conf: { boatCov: 1, refCap: 'low' } })])).toEqual([]);
  });

  it("high stays high: the wind-series share around the gate is not a conf input (it's interpolated on the run)", () => {
    const high = rankOpportunities([opp({ seconds: 28, conf: { boatCov: 1, refCap: 'high' } })]);
    expect(high[0].confidence).toBe('high');
    expect(high[0].score).toBe(28);
  });
});
