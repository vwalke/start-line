/**
 * Coach phase 4 detectors on synthetic tracks: D9 mark rounding (zone time and exit, the coverage gate,
 * the reference fallbacks, estimated marks) and D8 dirty air (the shadow geometry, the first-6-min window,
 * the density gate, the thresholds, the chip on D3 vs a card of its own).
 */
import { describe, expect, it } from 'vitest';
import type { CoachModel } from '../src/analysis/coach';
import { WENT_WELL_MAX, attachShadow, wentWell } from '../src/analysis/coach/debrief';
import type { CoachCtx } from '../src/analysis/coach/detectors/context';
import { D9_SLOW_S, D9_WIDE_LOA, detectRounding, markType, placesThreshold, roundingPass } from '../src/analysis/coach/detectors/rounding';
import {
  D8_ALONE_S,
  D8_DIST_LOA,
  D8_MIN_SHARE,
  D8_WINDOW_MS,
  beatWindows,
  detectShadow,
  inShadow,
  plumeBearing,
  shadowShare,
} from '../src/analysis/coach/detectors/shadow';
import type { GapPoint } from '../src/analysis/coach/ladder';
import { confidenceOf, type GoodNote, type Opportunity } from '../src/analysis/coach/opportunity';
import { rankOpportunities } from '../src/analysis/coach/rank';
import type { CoachTrack } from '../src/analysis/coach/tracks';
import { bearingVec, type Vec } from '../src/analysis/geo';
import type { BoatResult, LegKind, RaceAnalysis } from '../src/analysis/types';
import { cardText, cardWarnings, coachCardsHtml, wentText } from '../src/ui/coachCards';

const GUN = 1_000_000;
const LOA = 10;
const MARK: Vec = [0, 1000];

/** A track along `wps` at `speeds` (m/s per segment), sampled at `hz`; `marks` are the waypoint indices of the roundings. */
function pathTrack(id: string, wps: Vec[], speeds: number[], hz: number, marks: number[], phase = 0): CoachTrack {
  const seg: { a: Vec; b: Vec; t0: number; dur: number }[] = [];
  let t = 0;
  for (let i = 0; i < wps.length - 1; i++) {
    const L = Math.hypot(wps[i + 1][0] - wps[i][0], wps[i + 1][1] - wps[i][1]);
    seg.push({ a: wps[i], b: wps[i + 1], t0: t, dur: L / speeds[i] });
    t += L / speeds[i];
  }
  const end = t;
  const ts: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let s = phase; s <= end; s += 1 / hz) {
    const g = seg.find((q) => s >= q.t0 && s <= q.t0 + q.dur) ?? seg[seg.length - 1];
    const f = Math.min(1, (s - g.t0) / g.dur);
    ts.push(GUN + Math.round(s * 1000));
    xs.push(g.a[0] + f * (g.b[0] - g.a[0]));
    ys.push(g.a[1] + f * (g.b[1] - g.a[1]));
  }
  const at = marks.map((k) => GUN + Math.round(seg[k].t0 * 1000));
  return { id, t: Float64Array.from(ts), x: Float64Array.from(xs), y: Float64Array.from(ys), bounds: [GUN, ...at, GUN + Math.round(end * 1000)] };
}

/** A clean windward rounding: in from the left, 6 m round the mark, away down the run. */
const clean = (dx = 0): Vec[] => [[-300 + dx, 600], [-6, 1000], [6, 994], [6, 600], [0, 0]];
const cleanSpeeds = [3, 2.5, 3.5, 3.5];
/** Slow and wide: the same approach, then a wide swing 35 m out at 2 m/s. */
const wide: Vec[] = [[-300, 600], [-6, 1000], [35, 985], [35, 600], [0, 0]];
const wideSpeeds = [3, 2, 2.5, 3.5];

const boatOf = (id: string, pos: number | null): BoatResult => ({ id, sail: id, name: `Boat ${id}`, finishPos: pos, legs: [], start: null }) as unknown as BoatResult;

interface WorldOpts {
  kinds?: LegKind[];
  pts?: Vec[];
  tos?: string[];
  marks?: RaceAnalysis['marks'];
  legSource?: RaceAnalysis['legSource'];
  boats: BoatResult[];
  tracks: CoachTrack[];
  leaders?: string[];
  gaps?: CoachCtx['gaps'];
  crossMs?: Record<string, number | null> | null;
  endMs?: number;
}

function world(o: WorldOpts, boat = 'me'): CoachCtx {
  const kinds = o.kinds ?? ['upwind', 'downwind'];
  const a = {
    meta: { gunMs: GUN, tzOffsetMs: 0, raceNumber: 1 },
    legs: kinds.map((kind, i) => ({ index: i, name: `${kind === 'upwind' ? 'Beat' : 'Run'} ${Math.floor(i / 2) + 1}`, kind, to: o.tos?.[i] ?? (i === kinds.length - 1 ? 'Finish' : 'M1') })),
    legSource: o.legSource ?? 'course',
    marks: o.marks ?? [{ name: 'M1', xy: [MARK] }],
    boats: o.boats,
    line: { left: [-150, 0], right: [150, 0], lengthM: 300 },
  } as unknown as RaceAnalysis;
  const m = {
    gunMs: GUN,
    endMs: o.endMs ?? GUN + 3_600_000,
    course: { pts: o.pts ?? [[0, 0], MARK, [0, 0]], kinds },
    wind: { twdAt: () => 0, taAt: () => 84, t: [GUN], twd: [0], ta: [84], n: [99], ok: [true] },
    vmg: [2.5, 3, 2.5, 3],
    tracks: new Map(o.tracks.map((t) => [t.id, t])),
    windExcluded: [],
    crossMs: o.crossMs ?? null,
    zones: null,
  } as unknown as CoachModel;
  return {
    a,
    m,
    boat,
    me: o.boats.find((b) => b.id === boat)!,
    tr: m.tracks.get(boat)!,
    gun: GUN,
    loaM: LOA,
    leaders: o.leaders ?? ['L1', 'L2', 'L3'],
    marksEstimated: false,
    gaps: o.gaps ?? (() => []),
    nameOf: (id) => `Boat ${id}`,
  };
}

const fleetBoats = (): BoatResult[] => [boatOf('L1', 1), boatOf('L2', 2), boatOf('L3', 3), boatOf('F4', 4), boatOf('me', 5), boatOf('F6', 6)];
/** Leaders round cleanly (slightly apart); the fleet too; `me` per `mine`; everyone at `hz` unless `hzOf` says. */
function roundWorld(mine: { wps: Vec[]; speeds: number[] }, hzOf: (id: string) => number, o: Partial<WorldOpts> = {}): CoachCtx {
  const tracks = ['L1', 'L2', 'L3', 'F4', 'F6'].map((id, i) => pathTrack(id, clean(i * 3), cleanSpeeds, hzOf(id), [1], i * 0.37));
  tracks.push(pathTrack('me', mine.wps, mine.speeds, hzOf('me'), [1]));
  return world({ boats: fleetBoats(), tracks, ...o });
}

describe('D9 mark rounding', () => {
  it('mark kinds by the legs into and out of them', () => {
    expect(markType(['upwind', 'downwind', 'upwind', 'downwind'], 0)).toBe('windward');
    expect(markType(['upwind', 'downwind', 'upwind', 'downwind'], 1)).toBe('leeward');
    expect(markType(['upwind', 'reach', 'downwind'], 1)).toBe('offset');
  });

  it('times the 100 m zone from the circle crossings and reads the exit 4 lengths down the next leg', () => {
    const tr = pathTrack('x', clean(), cleanSpeeds, 10, [1]);
    const p = roundingPass(tr, [MARK], [0, -1], 0, GUN, GUN + 3_600_000, LOA)!;
    expect(p.covered).toBe(true);
    expect(p.dMinM).toBeLessThan(8);
    // ≈ 100 m in at 3 m/s, ~13 m round at 2.5, ≈ 94 m out at 3.5.
    expect(p.zoneS).toBeGreaterThan(60);
    expect(p.zoneS).toBeLessThan(70);
    expect(p.exitM!).toBeCloseTo(6, 0);
    expect(p.innerGapS).toBeLessThanOrEqual(0.11);
  });

  it('fires on a slow, wide 10 Hz rounding against the leaders; the card names the mark, the seconds and the lengths', () => {
    const ctx = roundWorld({ wps: wide, speeds: wideSpeeds }, () => 10);
    const r = detectRounding(ctx);
    expect(r.opps).toHaveLength(1);
    const o = r.opps[0];
    expect(o.kind).toBe('D9');
    expect(o.facts.ref).toBe('leaders');
    expect(o.facts.refN).toBe(3);
    expect(o.seconds).toBeGreaterThanOrEqual(D9_SLOW_S);
    expect(o.seconds).toBeCloseTo((o.facts.zoneS as number) - (o.facts.refZoneS as number), 6);
    expect(o.facts.wideLoa as number).toBeGreaterThan(D9_WIDE_LOA);
    expect(confidenceOf(o.conf).level).toBe('high');
    expect(r.evaluated).toEqual(['windward']);
    const [card] = rankOpportunities([o]);
    const t = cardText(card);
    expect(t.title).toBe('Slow windward mark rounding');
    expect(t.sentence).toMatch(/^Windward mark: \d+ s slower than the leaders through the zone, exited 3 lengths wide\.$/);
    expect(t.chips[0]).toMatch(/^\d+ s vs \d+ s in the zone$/);
    expect(`${t.sentence} ${t.chips.join(' ')} ${t.tip}`).not.toMatch(/NaN|undefined|null/);
  });

  it('the same tracks at 0.25 Hz: the zone path is suppressed (no fix every 2 s within 60 m); only the places fallback runs', () => {
    const ctx = roundWorld({ wps: wide, speeds: wideSpeeds }, () => 0.25);
    const r = detectRounding(ctx);
    expect(r.opps.filter((o) => o.facts.mode === 'zone')).toEqual([]);
    expect(r.reads[0].pass!.covered).toBe(false);
    expect(r.reads[0].pass!.innerGapS).toBeGreaterThan(2);
    expect(r.reads[0].places).not.toBeUndefined();
  });

  it('a clean rounding at 10 Hz: no card; ✓ needs two compared roundings; a quick one is ➕ with its seconds', () => {
    const quick = roundWorld({ wps: clean(), speeds: [3, 3.5, 4.5, 3.5] }, () => 10);
    const r = detectRounding(quick);
    expect(r.opps).toEqual([]);
    expect(r.good).toHaveLength(1);
    expect(r.good[0].seconds!).toBeGreaterThanOrEqual(5);
    expect(wentText(r.good[0])).toMatch(/^Windward mark: \d+ s quicker than the top 3 through the zone$/);
  });

  it('leaders without coverage: compared with the boat’s own other roundings of that mark, capped at medium, and the card says so', () => {
    // Two laps: M1 twice (the first slow and wide, the second clean), leeward M2 at the start.
    const lap = (first: Vec[]): Vec[] => [...first.slice(0, 4), [0, 5], [-300, 600], [-6, 1000], [6, 994], [6, 600], [0, 0]];
    const kinds: LegKind[] = ['upwind', 'downwind', 'upwind', 'downwind'];
    const pts: Vec[] = [[0, 0], MARK, [0, 5], MARK, [0, 0]];
    const back = [3.5, 3, ...cleanSpeeds.slice(0, 3), 3.5];
    const tracks = ['L1', 'L2', 'L3', 'F4', 'F6'].map((id, i) => pathTrack(id, lap(clean(i * 3)), [...cleanSpeeds.slice(0, 3), ...back], 0.25, [1, 4, 6], i * 0.37));
    tracks.push(pathTrack('me', lap(wide), [...wideSpeeds.slice(0, 3), ...back], 10, [1, 4, 6]));
    const ctx = world({ boats: fleetBoats(), tracks, kinds, pts, tos: ['M1', 'M2', 'M1', 'Finish'], marks: [{ name: 'M1', xy: [MARK] }, { name: 'M2', xy: [[0, 5]] }] });
    const r = detectRounding(ctx);
    const first = r.opps.find((o) => o.facts.nth === 1)!;
    expect(first.facts.ref).toBe('own');
    expect(first.facts.of).toBe(2);
    const c = confidenceOf(first.conf);
    expect(c).toEqual({ level: 'medium', limit: 'refs' });
    const [card] = rankOpportunities([first]);
    const t = cardText(card);
    expect(t.sentence).toMatch(/^Windward mark, 1st rounding: \d+ s slower than your other windward roundings through the zone/);
    expect(t.chips).toContain('vs your own roundings: no leader data');
    expect(cardWarnings(card, ctx.a)).toEqual(['no leader data']);
  });

  it('no leader data and no other rounding: two other boats with data, capped at low', () => {
    const ctx = roundWorld({ wps: wide, speeds: wideSpeeds }, (id) => (id.startsWith('L') ? 0.25 : 10));
    const o = detectRounding(ctx).opps[0];
    expect(o.facts.ref).toBe('fleet');
    expect(o.facts.refN).toBe(2);
    expect(confidenceOf(o.conf).level).toBe('low');
    expect(cardText(rankOpportunities([o], 3)[0] ?? ({ ...o, score: 0, limit: 'refs' } as never)).chips).toContain('vs 2 boats: no leader data');
  });

  it('marks placed from the fleet’s turns: the zone time is measured but never a card (spec §5); the places fallback stands in, never above medium', () => {
    for (const ctx of [
      roundWorld({ wps: wide, speeds: wideSpeeds }, () => 10, { marks: [{ name: 'M1', xy: [MARK], estimated: true }] }),
      roundWorld({ wps: wide, speeds: wideSpeeds }, () => 10, { marks: [], legSource: 'fleet' }),
    ]) {
      const r = detectRounding(ctx);
      expect(r.reads[0].estimated).toBe(true);
      expect(r.reads[0].dS!).toBeGreaterThanOrEqual(D9_SLOW_S);
      expect(r.opps.filter((o) => o.facts.mode === 'zone')).toEqual([]);
      expect(r.reads[0].places).not.toBeUndefined();
      for (const o of r.opps) expect(['medium', 'low']).toContain(confidenceOf(o.conf).level);
    }
  });
});

// ---- D8

describe('D8 shadow geometry', () => {
  it('the plume: straight downwind, swung toward the stern by half the angle to the wind, at most 20°', () => {
    // Wind from the north: downwind is 180°.
    expect(plumeBearing(0, null)).toBe(180);
    expect(plumeBearing(0, 0)).toBe(180);
    // Starboard close-hauled (320°, 40° off): swung 20° toward its stern (140°) → 160°.
    expect(plumeBearing(0, 320)).toBe(160);
    // Port (40°): toward 220° → 200°.
    expect(plumeBearing(0, 40)).toBe(200);
    // 20° off the wind: 10°.
    expect(plumeBearing(0, 20)).toBe(190);
    // Never more than 20°, however far off the wind.
    expect(plumeBearing(0, 280)).toBe(160);
  });

  const at = (bearing: number, lengths: number): Vec => {
    const v = bearingVec(bearing);
    return [v[0] * lengths * LOA, v[1] * lengths * LOA];
  };
  it('inside 0.5–7 lengths and ±22° of the plume; outside either band is clear air', () => {
    const q: Vec = [0, 0];
    expect(inShadow(at(160, 3), q, 320, 0, LOA)).toBe(true);
    expect(inShadow(at(160, D8_DIST_LOA[0] - 0.1), q, 320, 0, LOA)).toBe(false);
    expect(inShadow(at(160, D8_DIST_LOA[0] + 0.1), q, 320, 0, LOA)).toBe(true);
    expect(inShadow(at(160, D8_DIST_LOA[1] - 0.1), q, 320, 0, LOA)).toBe(true);
    expect(inShadow(at(160, D8_DIST_LOA[1] + 0.1), q, 320, 0, LOA)).toBe(false);
    expect(inShadow(at(160 + 21, 3), q, 320, 0, LOA)).toBe(true);
    expect(inShadow(at(160 - 23, 3), q, 320, 0, LOA)).toBe(false);
    expect(inShadow(at(160 + 23, 3), q, 320, 0, LOA)).toBe(false);
  });
  it('the rotation is toward the stern: a boat on port shadows 200°, not 160°', () => {
    const q: Vec = [0, 0];
    expect(inShadow(at(200, 3), q, 40, 0, LOA)).toBe(true);
    expect(inShadow(at(200, 3), q, 320, 0, LOA)).toBe(false);
    expect(inShadow(at(140, 3), q, 40, 0, LOA)).toBe(false);
    // Straight downwind of a starboard boat is still inside its ±22° (20° off).
    expect(inShadow(at(180, 3), q, 320, 0, LOA)).toBe(true);
  });
});

/** Boats beating on starboard (320° at 3 m/s) in lanes 300 m apart; `me` sits `lengths` down A's plume for its first `inPlumeS` s. */
function shadowWorld(o: { inPlumeS: number; lengths?: number; fleetHz?: number; slope?: number; beats?: number }): CoachCtx {
  const dir = bearingVec(320);
  const v = 3;
  const plume = bearingVec(160);
  const endS = 40 * 60;
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const mk = (id: string, x0: number, hz: number, off?: (s: number) => Vec): CoachTrack => {
    const t: number[] = [];
    const x: number[] = [];
    const y: number[] = [];
    for (let s = 0; s <= endS; s += 1 / hz) {
      const d = off ? off(s) : [0, 0];
      t.push(GUN + Math.round(s * 1000));
      x.push(x0 + dir[0] * v * s + d[0]);
      y.push(dir[1] * v * s + d[1]);
    }
    const legEnd = o.beats === 2 ? [GUN + 15 * 60_000, GUN + 25 * 60_000] : [GUN + 30 * 60_000];
    return { id, t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y), bounds: [GUN, ...legEnd, GUN + endS * 1000] };
  };
  const L = (o.lengths ?? 3) * LOA;
  const tracks = ids.map((id, i) => mk(id, i * 300, o.fleetHz ?? 1));
  // In A's plume for the first inPlumeS, then 150 m off to the right (clear air), side by side.
  tracks.push(mk('me', 0, 1, (s) => (s < o.inPlumeS ? [plume[0] * L, plume[1] * L] : [150, 0])));
  const boats = [...ids, 'me'].map((id, i) => boatOf(id, i + 1));
  const slope = o.slope ?? 0;
  // The gap to the leaders grows `slope` s per s while in the plume.
  const gaps: CoachCtx['gaps'] = (_ids, from, to) => {
    const out: GapPoint[] = [];
    for (let t = from; t <= to; t += 5000) {
      const s = Math.min((t - GUN) / 1000, o.inPlumeS);
      out.push({ tMs: t, behindS: slope * Math.max(0, s), legs: [0] } as unknown as GapPoint);
    }
    return out;
  };
  return world({
    boats,
    tracks,
    kinds: o.beats === 2 ? ['upwind', 'downwind', 'upwind'] : ['upwind', 'downwind'],
    pts: o.beats === 2 ? [[0, 0], MARK, [0, 0], MARK] : [[0, 0], MARK, [0, 0]],
    leaders: ['A', 'B', 'C'],
    gaps,
    endMs: GUN + endS * 1000,
  });
}

describe('D8 dirty air', () => {
  it('the window: the first 6 minutes of each beat, from the crossing on beat 1', () => {
    const ctx = shadowWorld({ inPlumeS: 0, beats: 2 });
    (ctx.m as { crossMs: Record<string, number> }).crossMs = { me: GUN + 7_000 };
    expect(beatWindows(ctx.m, 'me')).toEqual([
      [GUN + 7_000, GUN + 7_000 + D8_WINDOW_MS],
      [GUN + 25 * 60_000, GUN + 25 * 60_000 + D8_WINDOW_MS],
    ]);
  });

  it('a third of the first 6 minutes in a boat’s plume: shadow share ≈ 33 %, the fleet ~0 → fires; the shadowing boat named', () => {
    const ctx = shadowWorld({ inPlumeS: 120, slope: 0.05 });
    const mine = shadowShare(ctx.m, 'me', LOA)!;
    expect(mine.share).toBeGreaterThan(0.3);
    expect(mine.share).toBeLessThan(0.37);
    expect(mine.by).toBe('A');
    const r = detectShadow(ctx);
    expect(r.evaluated).toBe(true);
    expect(r.fleetShare).toBe(0);
    // Δgap ≈ 6 s in the stretch: under D8_ALONE_S → a chip, not a card.
    expect(r.opp).toBeNull();
    expect(r.chip!.facts.byName).toBe('Boat A');
    expect(r.chip!.facts.dgap as number).toBeLessThan(D8_ALONE_S);
  });

  it('under 15 %: no finding, however far above the fleet median', () => {
    const r = detectShadow(shadowWorld({ inPlumeS: 40 }));
    expect(r.share!).toBeLessThan(D8_MIN_SHARE);
    expect(r.chip).toBeNull();
    expect(r.opp).toBeNull();
    expect(r.evaluated).toBe(true);
  });

  it('a card of its own only when the shadowed stretches cost 15 s or more against the leaders', () => {
    const r = detectShadow(shadowWorld({ inPlumeS: 120, slope: 0.2 }));
    expect(r.chip).toBeNull();
    const o = r.opp!;
    expect(o.kind).toBe('D8');
    expect(o.seconds).toBeGreaterThanOrEqual(D8_ALONE_S);
    expect(o.spans!.length).toBeGreaterThanOrEqual(1);
    const [card] = rankOpportunities([o]);
    const t = cardText(card);
    expect(t.title).toBe('Dirty air early on the beats');
    expect(t.sentence).toMatch(/^In the first 6 minutes of the beats you sailed 3\d% of the time in another boat's wind shadow \(fleet 0%\) and lost \d+ s to the top 3 in those stretches\.$/);
    expect(t.chips[0]).toMatch(/^3\d% in dirty air vs fleet 0%$/);
  });

  it('the fleet too sparse to judge (fixes 8 s apart: no short-gap position): not evaluated, no finding', () => {
    const r = detectShadow(shadowWorld({ inPlumeS: 120, slope: 0.2, fleetHz: 0.125 }));
    expect(r).toMatchObject({ evaluated: false, opp: null, chip: null });
  });

  it('the chip rides on D3 (early lane); never a card of its own; nothing to carry it without D3', () => {
    const chip = detectShadow(shadowWorld({ inPlumeS: 120, slope: 0.05 }));
    const d3 = { kind: 'D3', variant: 'lane', t0: GUN, t1: GUN + 300_000, seconds: 20, secondsLo: 15, secondsHi: 25, confidence: 'high', coverage: 1, conf: { boatCov: 1 }, facts: { dgap: 20, tacks: 0 }, refBoats: [] } as unknown as Opportunity;
    const withChip = attachShadow(d3, chip)!;
    expect(withChip.chips!.map((c) => c.kind)).toEqual(['D8']);
    expect(attachShadow(null, chip)).toBeNull();
    const [card] = rankOpportunities([withChip]);
    expect(cardText(card).chips).toContain(`${Math.floor(chip.share! * 100)}% in dirty air vs fleet 0%`);
    expect(rankOpportunities([withChip]).map((c) => c.kind)).toEqual(['D3']);
  });
});

describe('Went well in the race view', () => {
  it('renders at most three lines with the seconds gained; nothing when none', () => {
    const d = {
      cards: [],
      ok: [],
      plus: [
        { kind: 'plus', detector: 'gap', variant: 'leg', facts: { leg: 'Beat 2', gainS: 34, how: 'gap' }, t0: 0, t1: 1, seconds: 34 },
        { kind: 'plus', detector: 'D1', variant: 'cross', facts: { aheadS: 6 }, t0: 0, t1: 1, seconds: 6 },
      ] as GoodNote[],
      totalS: 0,
      raceCov: 1,
      noData: false,
      found: [],
      dirtyAir: { opp: null, chip: null, evaluated: false, share: null, fleetShare: null },
      quality: { D8: false, D9: [] },
    };
    const html = coachCardsHtml({ meta: { gunMs: 0, tzOffsetMs: 0 } } as unknown as RaceAnalysis, d, null, 1);
    expect(html).toContain('<h4>Went well</h4>');
    expect(html).toContain('<li><span class="went-s">+34 s</span> Beat 2: gained 34 s on the top 3</li>');
    expect(html).toContain('<li><span class="went-s">+6 s</span> Start: crossed the line 6 s ahead of the top 3</li>');
    expect(coachCardsHtml({ meta: { gunMs: 0, tzOffsetMs: 0 } } as unknown as RaceAnalysis, { ...d, plus: [] }, null, 1)).not.toContain('Went well');
  });
});

describe('Went well: the rule', () => {
  const note = (detector: GoodNote['detector'], seconds: number, t0: number, t1: number, facts: GoodNote['facts'] = {}): GoodNote => ({ kind: 'plus', detector, variant: 'x', facts, t0, t1, seconds });
  it('the most seconds first, at most 3; one mostly inside a bigger one’s window is the same gain; roundings and the crossing always stand', () => {
    const notes = [
      note('gap', 40, 0, 600, { leg: 'Beat 1' }),
      // The first 5 minutes, inside Beat 1: the same gain told twice.
      note('D3', 20, 10, 310),
      note('D9', 6, 590, 660, { mark: 'Windward mark', nth: 1, of: 1 }),
      note('gap', 35, 600, 1200, { leg: 'Run 1' }),
      note('D1', 7, -5, 10),
      note('gap', 31, 1200, 1800, { leg: 'Beat 2' }),
    ];
    const w = wentWell(notes);
    expect(WENT_WELL_MAX).toBe(3);
    expect(w.map((n) => [n.detector, n.seconds])).toEqual([
      ['gap', 40],
      ['gap', 35],
      ['gap', 31],
    ]);
    // With room: the rounding and the start stay; the first-5-minutes one never does.
    expect(wentWell(notes, 6).map((n) => n.detector)).toEqual(['gap', 'gap', 'gap', 'D1', 'D9']);
    expect(wentWell([])).toEqual([]);
  });
});

// ---- D9's low-resolution fallback

/**
 * A fleet of `n` in single file 20 m apart (6.7 s at 3 m/s), up a 1 km beat and back. `me` (10th) slows to
 * 0.5 m/s for `slowS` seconds from 5 s before its rounding; `boost` boats get 4.5 m/s from 150 s before
 * its rounding to 90 s after; `lane` sets each boat's side across the wind (x, m).
 */
function fileWorld(o: { n: number; slowS?: number; hzOf?: (i: number) => number; boost?: (i: number) => boolean; lane?: (i: number) => number }): CoachCtx {
  const ME = 9;
  const v = 3;
  const rMe = (1000 + 20 * ME) / v; // s: me's rounding without the slowdown
  const speed = (i: number, u: number): number => {
    if (i === ME && o.slowS && u >= rMe - 5 && u < rMe - 5 + o.slowS) return 0.5;
    if (o.boost?.(i) && u >= rMe - 150 && u < rMe + 90) return 4.5;
    return v;
  };
  const tracks: CoachTrack[] = [];
  const finishes: number[] = [];
  for (let i = 0; i < o.n; i++) {
    const hz = o.hzOf?.(i) ?? 0.25;
    const x0 = o.lane?.(i) ?? 0;
    const ts: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    let s = -20 * i;
    let r: number | null = null;
    let f: number | null = null;
    let next = 0;
    for (let k = 0; f == null && k < 30_000; k++) {
      const u = k / 10;
      if (u >= next - 1e-9) {
        ts.push(GUN + Math.round(u * 1000));
        xs.push(x0);
        ys.push(s <= 1000 ? s : 2000 - s);
        next += 1 / hz;
      }
      const sp = speed(i, u);
      const s1 = s + sp * 0.1;
      if (r == null && s < 1000 && s1 >= 1000) r = u + (1000 - s) / sp;
      if (s < 2000 && s1 >= 2000) f = u + (2000 - s) / sp;
      s = s1;
    }
    const id = i === ME ? 'me' : `B${i}`;
    tracks.push({ id, t: Float64Array.from(ts), x: Float64Array.from(xs), y: Float64Array.from(ys), bounds: [GUN, GUN + r! * 1000, GUN + f! * 1000] });
    finishes.push(f!);
  }
  const order = finishes.map((f, i) => ({ f, i })).sort((p, q) => p.f - q.f).map((x) => x.i);
  const leg = (a: number, b: number, rank: number) => ({ startMs: a, endMs: b, timeS: (b - a) / 1000, rankAtEnd: rank, coverage: 1, vmgKn: 5 });
  const boats = tracks.map((tr, i) => {
    const [g, r, f] = tr.bounds as number[];
    return { ...boatOf(tr.id, order.indexOf(i) + 1), finishMs: f, start: { startPlace: i + 1 }, legs: [leg(g, r, i + 1), leg(r, f, 0)] } as unknown as BoatResult;
  });
  boats.sort((p, q) => p.finishPos! - q.finishPos!);
  return world({ boats, tracks, leaders: boats.filter((b) => b.id !== 'me').slice(0, 3).map((b) => b.id), endMs: GUN + 3_000_000 });
}

describe('D9 fallback: places through the rounding on sparse data', () => {
  it('the threshold: max(3, min(5, ceil(5 % of the fleet))) — 3 for small fleets, 5 for ~100 boats', () => {
    expect([6, 20, 60, 61, 80, 81, 100, 250].map(placesThreshold)).toEqual([3, 3, 3, 4, 4, 5, 5, 5]);
  });

  it('0.25 Hz, 100 boats, 60 s slow at the mark: lost 6+ places, a card at medium confidence with the seconds to the boats that passed', () => {
    const ctx = fileWorld({ n: 100, slowS: 60 });
    const r = detectRounding(ctx);
    expect(r.reads[0].pass?.covered ?? false).toBe(false);
    const pl = r.reads[0].places!;
    expect(pl.of).toBe(100);
    expect(pl.threshold).toBe(5);
    expect(pl.before).toBe(10);
    expect(pl.lost).toBeGreaterThanOrEqual(6);
    expect(pl.passers.length).toBe(pl.lost);
    expect(pl.shift).toBeNull();
    const [o] = r.opps;
    expect(o.facts).toMatchObject({ mode: 'places', lost: pl.lost, fleet: 100 });
    // ~50 s lost while slow: the gap to the boats that passed grew by about that.
    expect(o.seconds).toBeGreaterThan(35);
    expect(o.seconds).toBeLessThan(60);
    expect(confidenceOf(o.conf)).toEqual({ level: 'medium', limit: 'refs' });
    expect(r.evaluated).toEqual(['windward']);
    const [card] = rankOpportunities([o]);
    const t = cardText(card);
    expect(t.title).toBe('Lost places at the windward mark');
    expect(t.sentence).toBe(`Windward mark: lost ${pl.lost} places through the rounding, 10th → ${pl.after}th of 100 (sparse data, timing approximate).`);
    expect(t.chips).toEqual([`10th → ${pl.after}th of 100`, `passed by ${pl.lost}`, 'sparse data']);
    expect(cardWarnings(card, ctx.a)).toEqual(['sparse data']);
  });

  it('a 2-place loss does not fire (threshold 5 in a fleet of 100; 3 in a fleet of 20); 3+ does in the fleet of 20', () => {
    for (const n of [100, 20]) {
      const r = detectRounding(fileWorld({ n, slowS: 18 }));
      expect(r.reads[0].places!.lost).toBe(2);
      expect(r.opps).toEqual([]);
      expect(r.evaluated).toEqual(['windward']);
    }
    const r20 = detectRounding(fileWorld({ n: 20, slowS: 32 }));
    expect(r20.reads[0].places!.lost).toBeGreaterThanOrEqual(3);
    expect(r20.opps).toHaveLength(1);
  });

  it('when the boats from the other side all gained through the same rounding: the card says shift, seconds halved, low confidence', () => {
    // Right (x +50) on even indices, left (−50) on odd (the boat, index 9, is left); the right gets more pressure into the mark.
    const ctx = fileWorld({ n: 30, lane: (i) => (i % 2 ? -50 : 50), boost: (i) => i % 2 === 0 });
    const r = detectRounding(ctx);
    const pl = r.reads[0].places!;
    expect(pl.lost).toBeGreaterThanOrEqual(3);
    expect(pl.shift).toMatchObject({ side: 'right' });
    expect(pl.shift!.gain).toBeGreaterThanOrEqual(2);
    const [o] = r.opps;
    expect(o.seconds).toBeCloseTo(Math.max(0, pl.gapS!) * 0.5, 6);
    expect(confidenceOf(o.conf).level).toBe('low');
    const card = { ...o, score: 0, confidence: 'low' as const, limit: 'refs' as const };
    const t = cardText(card);
    expect(t.sentence).toMatch(/Boats coming in from the right \(looking upwind\) gained \d+\.\d places on average through it too: more likely a shift than the rounding\.$/);
    expect(cardWarnings(card, ctx.a)).toEqual(['low confidence', 'likely a shift']);
  });

  it('a fleet tracked too sparsely to place (most places interpolated from the roundings): not judged, not counted', () => {
    // Everyone but the boat a fix every 5 min: their places come from their rounding times only.
    const r = detectRounding(fileWorld({ n: 40, slowS: 60, hzOf: (i) => (i === 9 ? 0.25 : 1 / 300) }));
    const pl = r.reads[0].places!;
    expect(pl.estShare).toBeGreaterThan(0.75);
    expect(r.opps).toEqual([]);
    expect(r.evaluated).toEqual([]);
  });

  it('the 10 Hz zone path takes precedence when coverage allows: no places card', () => {
    // The boat and the leaders tracked at 10 Hz; the rest of the fleet sparse.
    const ctx = fileWorld({ n: 100, slowS: 60, hzOf: (i) => (i < 3 || i === 9 ? 10 : 0.25) });
    const r = detectRounding(ctx);
    expect(r.reads[0].pass!.covered).toBe(true);
    expect(r.reads[0].ref).toBe('leaders');
    expect(r.reads[0].places).toBeUndefined();
    expect(r.opps.map((o) => o.facts.mode)).toEqual(['zone']);
    expect(confidenceOf(r.opps[0].conf).level).toBe('high');
  });
});
