import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw, type CoachModel } from '../src/analysis/coach';
import { attachHeel, coachDebrief } from '../src/analysis/coach/debrief';
import { coachCtx, type CoachCtx } from '../src/analysis/coach/detectors/context';
import {
  HEEL_DIFF_DEG,
  HEEL_MIN_SAMPLES,
  HEEL_STEP_MS,
  HEEL_WINDOW_MS,
  detectHeel,
  heelIn,
  heelTracks,
  legHeel,
  type HeelTrack,
} from '../src/analysis/coach/detectors/heel';
import { legStories } from '../src/analysis/coach/legStory';
import { confidenceOf, type GoodNote, type Opportunity } from '../src/analysis/coach/opportunity';
import { rankOpportunities } from '../src/analysis/coach/rank';
import {
  evaluatedThemes,
  gatedTheme,
  raceDigest,
  summarizeRegatta,
  themeKey,
  tipOf,
  wentOf,
  type RaceDigest,
  type RegattaRace,
} from '../src/analysis/coach/regatta';
import type { CoachTrack } from '../src/analysis/coach/tracks';
import { MS_TO_KN, bearingVec, type Vec } from '../src/analysis/geo';
import type { BoatResult, LegKind, RaceAnalysis, StartResult } from '../src/analysis/types';
import type { RaceData } from '../src/data/types';
import { cardHtml, cardText, cardWarnings, goodTexts, wentText } from '../src/ui/coachCards';
import { heelStoryChip, legStoryText } from '../src/ui/coachLegs';
import { c31Race, j105Race, j88Race, m24Race } from './helpers';

/**
 * A synthetic race (as coachDetect.test.ts): wind from 0° all race, a beat north for 900 s, then a run
 * for 900 s; boats sail fixed angles and speeds, tacking or gybing every 60 s. Each boat's heel is
 * given directly, as a function of the seconds after the gun.
 */
const GUN = 1_000_000;
const ROUND = 900_000;
const END = 1_800_000;
const wind = { twdAt: () => 0, taAt: () => 84, t: [GUN, GUN + 60_000], twd: [0, 0], ta: [84, 84], n: [99, 99], ok: [true, true] };

function sail(id: string, twa: [number, number], kn: [number, number], x0 = 0): CoachTrack {
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let p: Vec = [x0, 0];
  for (let ms = 0; ms <= END; ms += 1000) {
    const leg = ms < ROUND ? 0 : 1;
    const side = Math.floor((leg ? ms - ROUND : ms) / 60_000) % 2 ? 1 : -1;
    const heading = leg ? 180 - side * (180 - twa[1]) : side * twa[0];
    t.push(GUN + ms);
    x.push(p[0]);
    y.push(p[1]);
    const d = bearingVec(heading);
    const v = kn[leg] / MS_TO_KN;
    p = [p[0] + d[0] * v, p[1] + d[1] * v];
  }
  return { id, t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y), bounds: [GUN, GUN + ROUND, GUN + END] };
}

/** A heel track: leeward heel `f(s)` (s after the gun) every `stepMs`. */
function heelOf(f: (s: number) => number, stepMs = 1000): HeelTrack {
  const t: number[] = [];
  const lee: number[] = [];
  for (let ms = 0; ms <= END; ms += stepMs) {
    t.push(GUN + ms);
    lee.push(f(ms / 1000));
  }
  return { t: Float64Array.from(t), roll: Float32Array.from(lee), lee: Float32Array.from(lee) };
}

const startOf = (): StartResult => ({ dtlM: 5, secsLate: 1, vToLineMs: 1, linePosPct: 50, speedKn: 6, headingDeg: 0, twaDeg: 40, bow: [0, 0], ocs: false, over: false, lateS: 1, dtlGapS: null }) as StartResult;

const legsOf = () => [{ startMs: GUN, endMs: GUN + ROUND, timeS: 900 } as never, { startMs: GUN + ROUND, endMs: GUN + END, timeS: 900 } as never];

function boatOf(id: string, i: number): BoatResult {
  return {
    id,
    sail: id,
    name: `Boat ${id}`,
    colorSlot: i,
    finishPos: i + 1,
    finishMs: GUN + END + i * 10_000,
    raceTimeS: null,
    sogAvgKn: null,
    distM: null,
    distApprox: false,
    coverage: 1,
    maxGapS: 1,
    start: startOf(),
    legs: legsOf(),
    upwind: null,
    downwind: null,
    headingSource: 'device',
    headingOffDeg: null,
  } as BoatResult;
}

interface Boat {
  id: string;
  twa?: [number, number];
  kn?: [number, number];
  /** Leeward heel by s after the gun; null: no roll data at all. */
  heel?: ((s: number) => number) | null;
  heelStepMs?: number;
}

/** The world: boats in finish order (the first three are the leaders unless `me` is among them). */
function world(list: Boat[], boat = 'me'): { ctx: CoachCtx; a: RaceAnalysis; m: CoachModel } {
  const kinds: LegKind[] = ['upwind', 'downwind'];
  const boats = list.map((b, i) => boatOf(b.id, i));
  const tracks = list.map((b, k) => sail(b.id, b.twa ?? [42, 145], b.kn ?? [6.5, 6], k * 40));
  const heel = new Map<string, HeelTrack>();
  for (const b of list) if (b.heel !== null) heel.set(b.id, heelOf(b.heel ?? (() => 15), b.heelStepMs));
  const a = {
    meta: { gunMs: GUN, tzOffsetMs: 0, raceNumber: 1, division: 'X', boatClass: 'J/105', eventName: 'T', sourceLabel: '', sourceKind: '' },
    line: { left: [-150, 0], right: [150, 0], lengthM: 300, bearingDeg: 90, favored: 'square', favoredByM: 0 },
    legs: kinds.map((kind, i) => ({ index: i, name: kind === 'upwind' ? 'Beat 1' : 'Run 1', kind, to: 'X' })),
    legSource: 'course',
    marks: [],
    boats,
    wind: { method: 'tacks', estimates: [], twdAtGunDeg: 0, model: null },
  } as unknown as RaceAnalysis;
  const m = {
    gunMs: GUN,
    endMs: GUN + END + 60_000,
    course: { pts: [[0, 0], [0, 2000], [0, 0]], kinds },
    wind,
    vmg: [2.5, 3],
    tracks: new Map(tracks.map((t) => [t.id, t])),
    windExcluded: [],
    crossMs: null,
    zones: null,
    heel,
  } as unknown as CoachModel;
  const me = boats.find((b) => b.id === boat)!;
  const ctx: CoachCtx = {
    a,
    m,
    boat,
    me,
    tr: m.tracks.get(boat)!,
    gun: GUN,
    loaM: 10,
    leaders: boats.filter((b) => b.id !== boat).slice(0, 3).map((b) => b.id),
    marksEstimated: false,
    gaps: () => [],
    nameOf: (id) => `Boat ${id}`,
  };
  return { ctx, a, m };
}

const vmg = (twa: number, kn: number): number => kn * Math.cos((twa * Math.PI) / 180);
/** A deterministic ±1° jitter, rounded to whole degrees as the feed's roll is. */
const jitter = (seed: number) => (s: number, base: number): number => Math.round(base + Math.sin(s * 12.9898 + seed * 78.233) * 1);

describe('D11 heel: upwind', () => {
  const others = (o: Partial<Boat> = {}): Boat[] => ['a', 'b', 'c'].map((id) => ({ id, ...o }));
  const fleet = (o: Partial<Boat> = {}): Boat[] => ['d', 'e'].map((id) => ({ id, ...o }));

  it('over-heeled and slower than the top 3: fires "over" with the VMG deficit × the windows as seconds', () => {
    // 20° vs 15°, 6.34 vs 6.5 kn at 42°: 2.5 % slower (under D6's 3 %), over the whole 900 s beat.
    const { ctx } = world([...others({ heel: () => 15 }), { id: 'me', kn: [6.34, 6], heel: () => 20 }, ...fleet()]);
    const l = legHeel(ctx, 0)!;
    expect(l.ref).toBe('leaders');
    expect(l.windows.length).toBe(Math.ceil(900_000 / HEEL_WINDOW_MS));
    expect(l.dHeel).toBeCloseTo(5, 5);
    expect(l.variant).toBe('over');
    const want = ((vmg(42, 6.5) - vmg(42, 6.34)) / vmg(42, 6.5)) * 900;
    const r = detectHeel(ctx);
    expect(r.opps).toHaveLength(1);
    const o = r.opps[0];
    expect(o).toMatchObject({ kind: 'D11', variant: 'over' });
    expect(o.seconds).toBeGreaterThan(want - 4);
    expect(o.seconds).toBeLessThan(want + 4);
    expect(o.secondsLo).toBeLessThan(o.seconds);
    expect(confidenceOf(o.conf).level).toBe('high');
    expect(o.facts).toMatchObject({ leg: 'Beat 1', ref: 'leaders', legKind: 'upwind' });
    expect(o.facts.dVmg as number).toBeCloseTo(0.12, 1);
    // It ranks as a card on its own (D6 didn't fire: 2.5 % vs the fleet).
    const d = coachDebrief(ctx.a, ctx.m, 'me')!;
    expect(d.found.find((x) => x.kind === 'D6')).toBeUndefined();
    expect(d.cards.map((c) => c.kind)).toContain('D11');
    const t = cardText(rankOpportunities([o])[0]);
    expect(t.title).toBe('Over-heeled on Beat 1');
    expect(t.sentence).toBe('Beat 1: you sailed ~5° more heeled than the top 3 and were 0.1 kt slower in VMG.');
    expect(t.chips).toEqual(['heel 20° vs 15° top 3', 'VMG 4.7 vs 4.8 kn', '8 of 8 windows']);
    expect(t.tip).toMatch(/depower|hike/);
    expect(d.quality.D11).toEqual(['upwind', 'downwind']);
  });

  it('a heel difference without a speed loss does not fire (and is no ✓ either)', () => {
    const { ctx } = world([...others({ heel: () => 15 }), { id: 'me', heel: () => 20 }, ...fleet()]);
    const r = detectHeel(ctx);
    expect(legHeel(ctx, 0)!.variant).toBe('over');
    expect(r.opps).toEqual([]);
    expect(r.ok).toBeNull();
    expect(r.plus).toEqual([]);
  });

  it('under-heeled (too flat) in light air: the "under" template and its light-air tip', () => {
    const { ctx } = world([...others({ kn: [5, 5], heel: () => 12 }), { id: 'me', kn: [4.8, 5], heel: () => 7 }, ...fleet({ kn: [5, 5] })]);
    const r = detectHeel(ctx);
    expect(r.opps.map((o) => o.variant)).toEqual(['under']);
    const t = cardText(rankOpportunities(r.opps)[0]);
    expect(t.title).toBe('Too flat on Beat 1');
    expect(t.sentence).toMatch(/^Beat 1: you sailed ~5° flatter than the top 3 and were 0\.\d kt slower in VMG\.$/);
    expect(t.tip).toMatch(/light air/);
    expect(r.opps[0].facts.wind).toBe('light');
  });

  it('flatter and faster: a ➕ Went well, not a card', () => {
    const { ctx } = world([...others({ heel: () => 18 }), { id: 'me', kn: [6.8, 6], heel: () => 13 }, ...fleet()]);
    const r = detectHeel(ctx);
    expect(r.opps).toEqual([]);
    expect(r.plus).toHaveLength(1);
    const p = r.plus[0];
    expect(p).toMatchObject({ kind: 'plus', detector: 'D11', variant: 'under' });
    expect(p.seconds!).toBeGreaterThan(30);
    expect(wentText(p)).toMatch(/^Beat 1: ~5° flatter than the top 3 and 0\.\d kt faster in VMG$/);
    const d = coachDebrief(ctx.a, ctx.m, 'me')!;
    expect(d.plus.some((n) => n.detector === 'D11')).toBe(true);
  });

  it('sparse roll (a reading every 20 s) is not evaluated: no finding, no ✓, no data for the Regatta view', () => {
    const { ctx } = world([...others({ heel: () => 15 }), { id: 'me', kn: [6.0, 6], heel: () => 22, heelStepMs: 20_000 }, ...fleet()]);
    expect(heelIn(ctx.m.heel!.get('me')!, GUN, GUN + HEEL_WINDOW_MS)).toBeNull();
    const r = detectHeel(ctx);
    expect(r.legs).toEqual([]);
    expect(r.opps).toEqual([]);
    expect(r.ok).toBeNull();
    expect(r.evaluated).toEqual([]);
    expect(coachDebrief(ctx.a, ctx.m, 'me')!.quality.D11).toEqual([]);
  });

  it('leaders already on the next leg are not compared in that window (same-clock, same-leg only)', () => {
    const { ctx } = world([...others({ heel: () => 15 }), { id: 'me', kn: [6.34, 6], heel: () => 20 }, ...fleet()]);
    // Beat 1 lasted 30 s for the top 3: every 2-min window of the boat's beat ends after they have rounded.
    for (const id of ctx.leaders) ctx.m.tracks.get(id)!.bounds = [GUN, GUN + 30_000, GUN + END];
    expect(legHeel(ctx, 0)).toBeNull();
  });

  it('no roll for the boat, or for its group: never guessed', () => {
    expect(detectHeel(world([...others({ heel: () => 15 }), { id: 'me', kn: [6, 6], heel: null }, ...fleet()]).ctx).legs).toEqual([]);
    // Leaders and peers (the boats ahead) without roll.
    expect(detectHeel(world([...others({ heel: null }), { id: 'me', kn: [6, 6], heel: () => 22 }, ...fleet()]).ctx).legs).toEqual([]);
  });

  it('whole-degree noise (±1°), even 2° apart, never fires — and is the ✓ when level', () => {
    const level = world([
      ...['a', 'b', 'c'].map((id, k) => ({ id, heel: (s: number) => jitter(k)(s, 15) })),
      { id: 'me', kn: [6.0, 6] as [number, number], heel: (s: number) => jitter(9)(s, 15) },
      ...fleet(),
    ]);
    const r = detectHeel(level.ctx);
    expect(Math.abs(legHeel(level.ctx, 0)!.dHeel)).toBeLessThan(1);
    expect(r.opps).toEqual([]);
    expect(r.ok).toMatchObject({ kind: 'ok', detector: 'D11', variant: 'upwind' });
    expect(goodTexts(r.ok!)).toEqual(['Heel upwind 15° vs top 3 15°']);
    const two = world([
      ...['a', 'b', 'c'].map((id, k) => ({ id, heel: (s: number) => jitter(k)(s, 15) })),
      { id: 'me', kn: [6.0, 6] as [number, number], heel: (s: number) => jitter(9)(s, 17) },
      ...fleet(),
    ]);
    expect(legHeel(two.ctx, 0)!.variant).toBeNull();
    expect(detectHeel(two.ctx).opps).toEqual([]);
    expect(HEEL_DIFF_DEG).toBeGreaterThanOrEqual(3);
    expect(HEEL_MIN_SAMPLES).toBeGreaterThanOrEqual(8);
  });

  it('leaders without roll: the peers (the boats just ahead), capped at medium and saying so', () => {
    // 8th: the top 3 have no roll; 2nd–7th (the peers) do.
    const list: Boat[] = [
      ...['a', 'b', 'c'].map((id) => ({ id, heel: null })),
      ...['d', 'e', 'f', 'g'].map((id) => ({ id, heel: () => 15 })),
      { id: 'me', kn: [6.3, 6], heel: () => 21 },
    ];
    const { ctx } = world(list);
    const l = legHeel(ctx, 0)!;
    expect(l.ref).toBe('peers');
    expect(l.refIds).toEqual(['d', 'e', 'f', 'g']);
    const o = detectHeel(ctx).opps[0];
    expect(o.facts.ref).toBe('peers');
    const c = rankOpportunities([o])[0];
    expect(c.confidence).toBe('medium');
    expect(cardWarnings(c)).toEqual(['no leader heel data']);
    expect(cardText(c).sentence).toMatch(/than the boats near you/);
    expect(cardText(c).chips[0]).toBe('heel 21° vs 15° peers');
  });

  it('on a beat where D6 fired too, D11 is a chip on the D6 card (the same seconds once), not a card', () => {
    // 6.0 vs 6.5 kn: 7.7 % below the fleet (D6) and the leaders (D11).
    const { ctx } = world([...others({ heel: () => 15 }), { id: 'me', kn: [6.0, 6], heel: () => 20 }, ...fleet()]);
    const d = coachDebrief(ctx.a, ctx.m, 'me')!;
    expect(d.found.some((o) => o.kind === 'D11')).toBe(false);
    const d6 = d.cards.find((c) => c.kind === 'D6')!;
    expect(d6.chips?.map((x) => x.kind)).toEqual(['D11']);
    const t = cardText(d6);
    expect(t.chips[0]).toBe('heel 20° vs 15° top 3');
    expect(t.chips).toHaveLength(3);
    expect(t.sentence).toMatch(/, ~5° more heeled than the top 3\.$/);
    expect(cardHtml(d6, 0, ctx.a, false)).toContain('heel 20° vs 15° top 3');
    // attachHeel alone: a D11 on another named leg stays a card (even if the clock were close).
    const h = detectHeel(ctx).opps[0];
    const away = {
      ...h,
      t0: GUN + 2_000_000,
      t1: GUN + 2_100_000,
      spans: [[GUN + 2_000_000, GUN + 2_100_000]] as [number, number][],
      facts: { ...h.facts, leg: 'Beat 2', legs: 'Beat 2' },
    };
    const r = attachHeel([d6 as Opportunity, null], [away]);
    expect(r.heel).toEqual([away]);
    expect(r.angles[0]).toBe(d6);
    // Same named leg, no clock overlap (D6 summed another beat, window align missed): still a chip, not two cards.
    const named = { ...h, t0: GUN + 2_000_000, t1: GUN + 2_100_000, spans: [[GUN + 2_000_000, GUN + 2_100_000]] as [number, number][] };
    const bare = { ...d6, chips: undefined, t0: GUN, t1: GUN + 100_000, spans: [[GUN, GUN + 100_000]] as [number, number][] };
    const r2 = attachHeel([bare, null], [named]);
    expect(r2.heel).toEqual([]);
    expect(r2.angles[0]?.chips?.map((x) => x.kind)).toEqual(['D11']);
  });
});

describe('D11 heel: downwind (lower confidence)', () => {
  const others = (o: Partial<Boat>): Boat[] => ['a', 'b', 'c'].map((id) => ({ id, ...o }));
  const fleet: Boat[] = ['d', 'e'].map((id) => ({ id }));

  it('rolling on the run (heel swinging ±6° vs ±1°) and slower: "rolling", at most medium', () => {
    const { ctx } = world([
      ...others({ heel: (s) => (s < 900 ? 15 : 2 + (Math.round(s) % 2 ? 1 : -1)) }),
      { id: 'me', kn: [6.5, 5.6], heel: (s) => (s < 900 ? 15 : 2 + (Math.round(s / 3) % 2 ? 6 : -6)) },
      ...fleet,
    ]);
    const r = detectHeel(ctx);
    const o = r.opps.find((x) => x.facts.legKind === 'downwind')!;
    expect(o.variant).toBe('rolling');
    expect(o.facts.leg).toBe('Run 1');
    const c = rankOpportunities([o])[0];
    expect(c.confidence).toBe('medium');
    expect(cardWarnings(c)).toEqual(['heel on runs: indicative']);
    const t = cardText(c);
    expect(t.title).toBe('Rolling on Run 1');
    expect(t.chips[0]).toMatch(/^heel ±6° vs ±1° top 3$/);
    expect(t.sentence).toMatch(/^Run 1: your heel swung ±6° vs ±1° for the top 3 and you were 0\.\d kt slower in VMG\.$/);
    expect(r.evaluated).toContain('downwind');
  });

  it('heeled to windward on the run and slower: "windward"', () => {
    const { ctx } = world([...others({ heel: (s) => (s < 900 ? 15 : 2) }), { id: 'me', kn: [6.5, 5.6], heel: (s) => (s < 900 ? 15 : -4) }, ...fleet]);
    const o = detectHeel(ctx).opps.find((x) => x.facts.legKind === 'downwind')!;
    expect(o.variant).toBe('windward');
    expect(cardText(rankOpportunities([o])[0]).title).toBe('Heeled to windward on Run 1');
    expect(cardText(rankOpportunities([o])[0]).sentence).toMatch(/~6° more to windward than the top 3/);
  });

  it('a steady run, level with the leaders: nothing', () => {
    const { ctx } = world([...others({ heel: () => 3 }), { id: 'me', kn: [6.5, 5.6], heel: () => 3 }, ...fleet]);
    expect(detectHeel(ctx).opps.filter((o) => o.facts.legKind === 'downwind')).toEqual([]);
  });
});

describe('D11 in the Regatta view', () => {
  const digest = (n: number, o: Partial<RaceDigest>): RegattaRace => ({
    raceNumber: n,
    label: `R${n}`,
    name: `Race ${n}`,
    status: 'done',
    digest: { raceNumber: n, sail: 'X', tracked: true, finish: null, coverage: 1, noData: false, legs: [], findings: [], evaluated: [], went: [], ...o },
  });
  const heelEval = evaluatedThemes({ D8: false, D9: [], D11: ['upwind'] });
  const over = { theme: 'heel-over', kind: 'D11' as const, variant: 'over', seconds: 20, confidence: 'high' as const };

  it('themes, tips and the gate: the races with heel data are the denominator', () => {
    expect(themeKey('D11', 'over')).toBe('heel-over');
    expect(themeKey('D11', 'under')).toBe('heel-under');
    expect(themeKey('D11', 'rolling')).toBe('heel-down');
    expect(themeKey('D11', 'windward')).toBe('heel-down');
    expect(heelEval).toEqual(['heel-over', 'heel-under']);
    expect(evaluatedThemes({ D8: true, D9: [] })).toEqual(['dirty-air']);
    expect(gatedTheme('heel-over')).toBe(true);
    expect(tipOf('D11', 'over')).toMatch(/hike/);
    expect(tipOf('D11', 'rolling')).toMatch(/Steady/);
  });

  it('"Over-heeled upwind in 3 of 5 races judged" (a 6th race had no roll), with the tip', () => {
    const races = [
      digest(1, { findings: [over], evaluated: heelEval }),
      digest(2, { findings: [{ ...over, seconds: 30 }], evaluated: heelEval }),
      digest(3, { findings: [{ ...over, seconds: 0, confidence: 'medium' }], evaluated: heelEval }),
      digest(4, { evaluated: heelEval }),
      digest(5, { evaluated: heelEval }),
      digest(6, { evaluated: [] }),
    ];
    const s = summarizeRegatta(races);
    const f = s.findings.find((x) => x.theme === 'heel-over')!;
    expect(f).toMatchObject({ races: 3, of: 5, gated: true, label: 'Over-heeled upwind', totalS: 50 });
    const w = s.top.find((x) => x.theme === 'heel-over')!;
    expect(w.pattern).toBe(true);
    expect(w.why).toBe('Over-heeled upwind in 3 of 5 races judged, ~50 s total');
    expect(w.tip).toBe(tipOf('D11', 'over'));
    expect(w.chips).toEqual(['R1 20 s', 'R2 30 s', 'R3 (medium)']);
  });

  it('went well: heel upwind better than the leaders with a VMG gain, of the races with heel data', () => {
    const note: GoodNote = { kind: 'plus', detector: 'D11', variant: 'under', facts: { leg: 'Beat 2', legKind: 'upwind' }, t0: 0, t1: 1, seconds: 18 };
    const went = wentOf({ legs: [] }, note);
    expect(went).toEqual({ family: 'heel:upwind', label: 'Beat 2', seconds: 18 });
    const s = summarizeRegatta([
      digest(1, { went: [went], evaluated: heelEval }),
      digest(2, { went: [{ ...went, seconds: 25, label: 'Beat 1' }], evaluated: heelEval }),
      digest(3, { evaluated: heelEval }),
      digest(4, { evaluated: [] }),
    ]);
    const h = s.went.find((x) => x.family === 'heel:upwind')!;
    expect(h).toMatchObject({ title: 'Heel upwind', races: 2, of: 3, totalS: 43, best: { label: 'R2', what: 'Beat 1', seconds: 25 } });
  });
});

// ---- the committed fixtures (2026 J/105 CBC, J/88 NA R5, M24 Worlds R4, J/70 Benelux R8, C31 R10)

function coachOf(data: RaceData) {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  return { data, a, raw, m: buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null)! };
}

describe('D11 golden: the committed fixtures', () => {
  const m24 = coachOf(m24Race());

  it('heelTracks: every racing boat with roll, at most every HEEL_STEP_MS, leeward-signed (+ upwind)', () => {
    const h = m24.raw.heel!;
    expect(Object.keys(h).sort()).toEqual(m24.a.boats.map((b) => b.id).sort());
    for (const tr of Object.values(h)) {
      const gaps = Array.from(tr.t.slice(1), (x, i) => x - tr.t[i]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(HEEL_STEP_MS - 50);
    }
    // Upwind the fleet heels to leeward: Beat 1's leeward heel is positive for every boat measured.
    const ctx = coachCtx(m24.a, m24.m, '870')!;
    const l = legHeel(ctx, 0)!;
    expect(l.windows.every((w) => w.boat.heel > 5 && w.ref.heel > 5)).toBe(true);
  });

  it('J/105 CBC: the feed has no roll: D11 is never evaluated, and nothing else changes', () => {
    for (const rn of [1, 2, 3] as const) {
      const r = coachOf(j105Race(rn));
      expect(Object.keys(r.raw.heel!)).toEqual([]);
      const d = coachDebrief(r.a, r.m, 'USA 96')!;
      expect(d.found.some((o) => o.kind === 'D11' || o.chips?.some((c) => c.kind === 'D11'))).toBe(false);
      expect(d.quality.D11).toEqual([]);
    }
  });

  it('M24 R4: 491 sailed ~7° flatter than the top 3 on Beat 1 and slower: found; 658 and 615 too flat, on their D6 cards', () => {
    const d491 = coachDebrief(m24.a, m24.m, '491')!;
    const c = d491.found.find((x) => x.kind === 'D11')!;
    expect(c).toMatchObject({ variant: 'under', facts: { leg: 'Beat 1', ref: 'leaders' } });
    expect(c.facts.dHeel as number).toBeLessThan(-6);
    expect(c.seconds).toBeGreaterThan(30);
    expect(c.seconds).toBeLessThan(50);
    // No card since the top 3's line is their mean: the start card's early lane (17 s on it) claims Beat 1's first 5 min.
    // (Its Run 2 heel is a card of its own since that run's wind is read from the gybes: the run's D7 it rode on no longer fires.)
    expect(d491.cards.some((x) => x.kind === 'D11' && x.facts.leg === 'Beat 1')).toBe(false);
    for (const id of ['658', '615']) {
      const d = coachDebrief(m24.a, m24.m, id)!;
      const d6 = d.cards.find((x) => x.kind === 'D6')!;
      const chip = d6.chips!.find((x) => x.kind === 'D11')!;
      expect(chip.facts).toMatchObject({ variant: 'under', leg: 'Beat 1' });
      expect(d.cards.some((x) => x.kind === 'D11' && x.facts.leg === 'Beat 1')).toBe(false);
    }
    // The winner, 870, flatter and faster on Beat 1: a heel ➕.
    expect(detectHeel(coachCtx(m24.a, m24.m, '870')!).plus.map((p) => p.facts.leg)).toEqual(['Beat 1']);
  });

  it('M24 R4: the Regatta digest keeps the heel theme (also when D11 only rides on D6)', () => {
    const r615 = raceDigest(m24.a, m24.m, '615');
    expect(r615.findings.find((f) => f.theme === 'heel-under')).toMatchObject({ kind: 'D11', seconds: 0 });
    expect(r615.evaluated).toEqual(expect.arrayContaining(['heel-over', 'heel-under']));
    const r491 = raceDigest(m24.a, m24.m, '491');
    expect(r491.findings.find((f) => f.theme === 'heel-under')).toMatchObject({ kind: 'D11', seconds: 0 });
  });

  it('M24 R4 leg stories: a heel chip on 491\'s Beat 1, on the closed row (it cost time)', () => {
    const stories = legStories(m24.a, m24.m, '491', { kind: 'leaders' });
    const b1 = stories.find((s) => s.name === 'Beat 1')!;
    expect(b1.heel).toMatchObject({ variant: 'under', ref: 'leaders', fired: true });
    const t = legStoryText(b1, m24.a, '491', { kind: 'leaders' });
    const chip = heelStoryChip(b1.heel!);
    expect(chip).toMatch(/^heel 7° flatter than top 3 · VMG 0\.\d kt slower$/);
    expect(t.summary.map((x) => x.text)).toContain(chip);
    expect(t.lines.flat().map((x) => x.text)).toContain(chip);
    // A boat level with the leaders: no heel chips.
    expect(legStories(m24.a, m24.m, '708', { kind: 'leaders' }).every((s) => s.heel == null)).toBe(true);
  });

  it('J/88 R5 and C31 R10: heel compared, nothing over a card\'s minimum; mostly the ✓', () => {
    for (const data of [j88Race(), c31Race()]) {
      const r = coachOf(data);
      let ok = 0;
      for (const b of r.a.boats) {
        const d = coachDebrief(r.a, r.m, b.id)!;
        expect(d.cards.some((c) => c.kind === 'D11')).toBe(false);
        if (d.ok.some((n) => n.detector === 'D11')) ok++;
        expect(d.quality.D11!.length).toBeGreaterThan(0);
      }
      expect(ok).toBeGreaterThanOrEqual(r.a.boats.length / 2);
    }
  });

  it('an uploaded .vkx log with heel: D11 reads its roll at the full rate', async () => {
    const { mergeUploads, fullRateIn } = await import('../src/data/vkx/merge');
    const data = m24Race();
    const me = data.boats.find((b) => b.id === '491')!;
    const src = me.track;
    // A fake 10 Hz log: positions interpolated, heel the feed's roll + 0.3° (the log's isn't whole degrees).
    const n = Math.floor((src.t[src.t.length - 1] - src.t[0]) / 100);
    const t = new Float64Array(n);
    const lat = new Float64Array(n);
    const lon = new Float64Array(n);
    const heel = new Float32Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      t[i] = src.t[0] + i * 100;
      while (j < src.t.length - 2 && src.t[j + 1] <= t[i]) j++;
      const f = Math.min(1, Math.max(0, (t[i] - src.t[j]) / Math.max(1, src.t[j + 1] - src.t[j])));
      lat[i] = src.lat[j] + f * (src.lat[j + 1] - src.lat[j]);
      lon[i] = src.lon[j] + f * (src.lon[j + 1] - src.lon[j]);
      heel[i] = (Number.isFinite(src.roll![j]) ? src.roll![j] : 0) + 0.3;
    }
    const log = { header: { sail: me.sail, rateHz: 10, timers: [], pings: [] }, t, lat, lon, sog: new Float32Array(n), cog: new Float32Array(n), heading: null, heel, pitch: null };
    expect(fullRateIn(log as never, data.gunMs).roll).toBeInstanceOf(Float32Array);
    const merged = mergeUploads(data, [{ track: log as never }]);
    const b = merged.boats.find((x) => x.id === '491')!;
    expect(b.fullRate!.roll!.length).toBe(b.fullRate!.t.length);
    const h = heelTracks(analyzeRace(merged), merged)['491'];
    const gaps = Array.from(h.t.slice(1, 200), (x, i) => x - h.t[i]);
    expect(Math.min(...gaps)).toBeLessThanOrEqual(110);
    expect(Array.from(h.roll.slice(0, 50)).some((r) => Math.abs(r - Math.round(r)) > 0.2)).toBe(true);
    // Without heel in the log, the full-rate copy has no roll and the merged track's is used.
    expect(fullRateIn({ ...log, heel: null } as never, data.gunMs).roll).toBeUndefined();
  });
});
