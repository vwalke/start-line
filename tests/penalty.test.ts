import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { sanitizeAskContext } from '../src/analysis/coach/askContext';
import type { PenaltyFinding } from '../src/analysis/coach/penalty';
import type { PenaltyTurn } from '../src/analysis/coach/detectors/penaltyTurn';
import { raceDigest, summarizeRegatta, type RaceDigest, type RegattaRace } from '../src/analysis/coach/regatta';
import { placeChanges } from '../src/analysis/places';
import { finishRank } from '../src/analysis/result';
import { CODES, codeInfo, finishedWithCode, penaltyPlacesOf } from '../src/data/official/codes';
import { parseResults, withOnWater, type OfficialResult, type YsResultReport } from '../src/data/official/yachtscoring';
import { coachChips } from '../src/ui/coach';
import { askPenalty, raceAskContext, regattaAskContext } from '../src/ui/coachAskContext';
import { cardText, coachCardsHtml, penaltyText } from '../src/ui/coachCards';
import { finishShort, penaltiesHtml, penaltyRowText, regattaHtml } from '../src/ui/coachRegatta';
import { codeShort } from '../src/ui/resultText';
import { legStories } from '../src/analysis/coach/legStory';
import { SYSTEM_PROMPT, buildPrompt } from '../functions/_askCoach';
import { ic37LinkedRace, ic37Official, ic37Race } from './helpers';

// ---- codes and points

describe('scoring codes (data/official/codes.ts)', () => {
  it('finished with a penalty: DPI, SCP, ZFP, ZPF, RDG with a finish time; DSQ / UFD / BFD only with one', () => {
    for (const c of ['DPI', 'SCP', 'ZFP', 'ZPF', 'RDG']) {
      expect(codeInfo(c)).toMatchObject({ kind: 'penalty', lost: false });
      expect(finishedWithCode(c, true)).toBe(true);
      expect(finishedWithCode(c, false)).toBe(false);
    }
    for (const c of ['DSQ', 'UFD', 'BFD']) {
      expect(codeInfo(c)).toMatchObject({ kind: 'excluded', lost: true });
      expect(finishedWithCode(c, true)).toBe(true);
      expect(finishedWithCode(c, false)).toBe(false);
    }
  });

  it('not finished / not scored as a finisher: DNF, RET, DNS, DNC, DNE, OCS, NSC, TLE (finish time or not)', () => {
    for (const c of ['DNF', 'RET', 'DNS', 'DNC', 'DNE', 'OCS', 'NSC', 'TLE']) {
      expect(codeInfo(c).lost).toBe(true);
      expect(finishedWithCode(c, true)).toBe(false);
      expect(finishedWithCode(c, false)).toBe(false);
    }
    expect(['DNS', 'DNC', 'DNE'].map((c) => codeInfo(c).kind)).toEqual(['not-started', 'not-started', 'not-started']);
    // The start codes carry the over-the-line figures; Z-flag is a points penalty.
    expect(Object.entries(CODES).filter(([, v]) => v.start).map(([k]) => k).sort()).toEqual(['BFD', 'OCS', 'UFD']);
  });

  it('every code has plain words; an unknown code is a lost result in its own name', () => {
    expect(codeInfo('DPI').meaning).toBe('Discretionary penalty: the protest committee added points instead of disqualifying');
    for (const v of Object.values(CODES)) expect(v.meaning.length).toBeGreaterThan(5);
    expect(codeInfo('xyz')).toEqual({ kind: 'not-finished', meaning: 'Scored XYZ', lost: true });
    expect(codeInfo('dpi').kind).toBe('penalty');
  });

  it('penaltyPlaces: points − on-water place, to 0.1, never below 0', () => {
    expect(penaltyPlacesOf(15, 12)).toBe(3);
    expect(penaltyPlacesOf(13.9, 11)).toBe(2.9);
    expect(penaltyPlacesOf(13, 13)).toBe(0);
    expect(penaltyPlacesOf(8, 12)).toBe(0);
    expect(penaltyPlacesOf(null, 12)).toBeNull();
    expect(penaltyPlacesOf(15, null)).toBeNull();
  });
});

const report = (boats: Record<string, unknown>[]): YsResultReport => ({ data: [{ circleName: 'C', divisions: [{ classes: [{ className: 'K', boats }] }] }] });
const at = (s: number): string => new Date(Date.UTC(2026, 9, 10, 11, 0, 0) + s * 1000).toISOString();
const fin = (sail: string, place: number, el: number, extra: Record<string, unknown> = {}) => ({ sailNumber: sail, finishStatus: 'AOK', placeClass: place, elapsedTime: el, correctedTime: el, finishTime: at(el), ...extra });
const parse = (boats: Record<string, unknown>[]): OfficialResult[] => parseResults(report(boats), { circle: 'C', className: 'K' })!;
const bySail = (rows: OfficialResult[], s: string) => rows.find((r) => r.sail === s)!;

describe('Yachtscoring rows: points on every row, the on-water place of a coded finisher', () => {
  it('keeps points (placeClass) coded or not; a finisher’s place is its points', () => {
    const rows = parse([fin('1', 1, 100), { sailNumber: '9', finishStatus: 'DNF', placeClass: 4 }]);
    expect(bySail(rows, '1')).toMatchObject({ code: null, place: 1, points: 1, onWater: null });
    expect(bySail(rows, '9')).toMatchObject({ code: 'DNF', place: null, points: 4, onWater: null, penaltyPlaces: null });
  });

  it('DPI: the others keep their places; on water by corrected time, penaltyPlaces = points − that', () => {
    const rows = parse([fin('1', 1, 100), fin('2', 2, 110), fin('4', 4, 130), { ...fin('3', 5, 120), finishStatus: 'DPI' }]);
    expect(bySail(rows, '3')).toMatchObject({ code: 'DPI', place: null, points: 5, onWater: 3, penaltyPlaces: 2 });
  });

  it('SCP scores are fractional (13.9): points kept to the decimal, penaltyPlaces 2.9', () => {
    const boats = Array.from({ length: 12 }, (_, i) => fin(String(i + 1), i + 1, 100 + i * 10));
    boats[10] = { ...boats[10], finishStatus: 'SCP', placeClass: 13.9 };
    const r = bySail(parse(boats), '11');
    expect(r).toMatchObject({ points: 13.9, onWater: 11, penaltyPlaces: 2.9 });
  });

  it('DSQ / UFD / BFD with a finish time get an on-water place; without one, none', () => {
    const rows = parse([
      fin('1', 1, 100),
      { ...fin('2', 6, 105), finishStatus: 'UFD' },
      fin('3', 2, 120),
      { sailNumber: '4', finishStatus: 'DSQ', placeClass: 6 },
      { ...fin('5', 6, 90), finishStatus: 'BFD' },
    ]);
    expect(bySail(rows, '2')).toMatchObject({ code: 'UFD', points: 6, onWater: 3 });
    expect(bySail(rows, '4')).toMatchObject({ code: 'DSQ', onWater: null, penaltyPlaces: null });
    expect(bySail(rows, '5')).toMatchObject({ code: 'BFD', onWater: 1, penaltyPlaces: 5 });
  });

  it('OCS, DNF, TLE with a finish time still score as not finishing (no on-water place)', () => {
    const rows = parse([fin('1', 1, 100), { ...fin('2', 4, 90), finishStatus: 'OCS' }, { ...fin('3', 4, 200), finishStatus: 'TLE' }]);
    expect(bySail(rows, '2').onWater).toBeNull();
    expect(bySail(rows, '3').onWater).toBeNull();
  });

  it('equal times share the place; no corrected time → elapsed, then the finish clock', () => {
    const rows = parse([fin('1', 1, 100), fin('2', 2, 110), { ...fin('3', 4, 110), finishStatus: 'DPI' }]);
    expect(bySail(rows, '3').onWater).toBe(2);
    const noCorr = withOnWater([
      { prefix: null, sail: 'a', name: '', code: null, place: 1, points: 1, finishWallMs: null, elapsedS: 50 },
      { prefix: null, sail: 'b', name: '', code: 'DPI', place: null, points: 3, finishWallMs: 1, elapsedS: 40 },
    ]);
    expect(noCorr[1]).toMatchObject({ onWater: 1, penaltyPlaces: 2 });
  });

  it('IC37 R7: USA 016 scored DPI 13 while 13th on the water: no places lost (0, never negative)', () => {
    // R7's order around it (scratch/r7.md): 008 12th 3229 s, USA 016 DPI 3231 s, 028 14th 3268 s.
    const rows = parse([fin('008', 12, 3229), { ...fin('USA 016', 13, 3231), finishStatus: 'DPI' }, fin('028', 14, 3268), ...Array.from({ length: 11 }, (_, i) => fin(`x${i}`, i + 1, 3000 + i))]);
    expect(bySail(rows, 'USA 016')).toMatchObject({ points: 13, onWater: 13, penaltyPlaces: 0 });
  });
});

// ---- IC37 R5 linked: USA 016 DPI

const official = ic37Official();
const linked = ic37LinkedRace(official);
const a = analyzeRace(linked);
const raw = coachRaw(a, linked);
const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null, raw.turns ?? null, raw.overStart ?? null)!;
const boat = (sail: string) => a.boats.find((b) => b.sail === sail)!;
const debrief = (sail: string) => coachDebrief(a, m, boat(sail).id)!;

describe('IC37 R5 with the official link: USA 016, DPI in every race of the regatta', () => {
  it('the official rows: USA 016 DPI, 15 points, 12th on the water by corrected time, +3', () => {
    const r = official.rows.find((x) => x.rsSail === 'USA 016')!;
    expect(r).toMatchObject({ code: 'DPI', place: null, points: 15, onWater: 12, penaltyPlaces: 3 });
    // The other boats keep their places: 1st–11th, 13th–15th, the DPI boat's slot (12th) empty.
    expect(official.rows.filter((x) => x.code == null).map((x) => x.place).sort((p, q) => p! - q!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15]);
  });

  it('the analysis: code DPI, no official place, on-water 12th with its finish, race time and legs; between 11th and 13th', () => {
    const b = boat('USA 016');
    expect(b).toMatchObject({ finishPos: null, finishCode: 'DPI', scoredPoints: 15, onWaterPlace: 12, penaltyPlaces: 3 });
    expect(finishRank(b)).toBe(12);
    expect(b.finishMs).not.toBeNull();
    expect(b.raceTimeS).toBeGreaterThan(3200);
    expect(b.legs.some((l) => l != null)).toBe(true);
    const order = a.boats.map((x) => x.sail);
    expect(order.indexOf('USA 016')).toBe(order.indexOf('USA 019') + 1);
    expect(order.indexOf('USA 22')).toBe(order.indexOf('USA 016') + 1);
    // The places chart's finish column: on the water.
    const pc = placeChanges(a);
    const i = a.boats.indexOf(b);
    expect(pc.boats[i].places[pc.boats[i].places.length - 1]).toBe(12);
    expect(pc.boats[i].dnf).toBe(false);
  });

  it('shows the result: "DPI 15" (header chip, boat list), the places chart keeps the water', () => {
    expect(codeShort(boat('USA 016'))).toBe('DPI 15');
    const chips = coachChips(a, boat('USA 016'));
    expect(chips[0]).toMatchObject({ text: 'DPI 15' });
    expect(chips[0].title).toContain('12th on the water');
    // Behind the winner on the water, like any finisher.
    expect(chips[1].text).toMatch(/s behind/);
  });

  it('its debrief: the penalty card pinned first, "Cost 3 places — 12th on the water, scored 15th"', () => {
    const d = debrief('USA 016');
    expect(d.penalty).toMatchObject({ code: 'DPI', points: 15, onWater: 12, penaltyPlaces: 3, lost: false, over: null, turns: [] });
    const t = penaltyText(d.penalty!, a);
    expect(t.title).toBe('Cost 3 places — 12th on the water, scored 15th');
    expect(t.sentence).toContain('Discretionary penalty: the protest committee added points instead of disqualifying');
    const html = coachCardsHtml(a, d, null);
    const pen = html.indexOf('coach-penalty');
    expect(pen).toBeGreaterThanOrEqual(0);
    expect(html).toContain('12th on the water, scored 15th');
    expect(html).toContain('Smaller than the penalty: what cost time on the water');
    expect(pen).toBeLessThan(html.indexOf('coach-opp'));
    // Pinned, not ranked: no number, no seconds chip.
    expect(html.slice(pen, html.indexOf('</article>', pen))).not.toContain('chip sec');
  });

  it('the ranked cards are the same as without the link (count and kinds); totalS is theirs alone', () => {
    const plain = ic37Race();
    const a0 = analyzeRace(plain);
    const r0 = coachRaw(a0, plain);
    const m0 = buildCoach(a0, r0.wind, r0.crossMs, r0.zones ?? null, r0.heel ?? null, r0.turns ?? null, r0.overStart ?? null)!;
    const d0 = coachDebrief(a0, m0, a0.boats.find((b) => b.sail === 'USA 016')!.id)!;
    const d = debrief('USA 016');
    expect(d0.penalty).toBeNull();
    expect(d.cards.map((c) => `${c.kind}:${c.variant}`)).toEqual(d0.cards.map((c) => `${c.kind}:${c.variant}`));
    expect(d.cards.length).toBe(d0.cards.length);
    expect(d.totalS).toBeCloseTo(d.cards.reduce((s, c) => s + c.seconds, 0), 6);
  });

  it('the race view’s Ask Coach context carries the penalty, and the server keeps it', () => {
    const d = debrief('USA 016');
    const ctx = raceAskContext({ a, me: boat('USA 016'), head: coachChips(a, boat('USA 016')), deb: d, stories: [], group: { kind: 'leaders' } });
    expect(ctx.penalty).toMatchObject({ code: 'DPI', result: 'Cost 3 places — 12th on the water, scored 15th' });
    expect(ctx.penalty!.meaning).toMatch(/Discretionary penalty/);
    expect(sanitizeAskContext(JSON.parse(JSON.stringify(ctx)))!.penalty).toEqual(ctx.penalty);
    // Not a finding.
    expect(ctx.findings!.some((f) => /penalty/i.test(f.title))).toBe(false);
  });

  it('its Ask Coach context text (as the server sends it): the penalty first as the top impact, then the cards numbered in rank order', () => {
    const d = debrief('USA 016');
    const me = boat('USA 016');
    const group = { kind: 'leaders' } as const;
    const ctx = raceAskContext({ a, me, head: coachChips(a, me, d.totalS), deb: d, stories: legStories(a, m, me.id, group), group });
    const p = buildPrompt({ question: 'what was my biggest loss this race?', history: [], ids: {}, context: sanitizeAskContext(JSON.parse(JSON.stringify(ctx)))! });
    expect(p.trimmed).toEqual([]);
    const block = p.system[1].text;
    const lines = block.slice(block.indexOf('<coach_context>\n') + 16).split('\n');
    expect(lines[0]).toBe('Top impact of this race — official penalty: DPI (Discretionary penalty: the protest committee added points instead of disqualifying): Cost 3 places — 12th on the water, scored 15th.');
    expect(lines[1]).toBe("Coach's findings, ranked by Coach, biggest first (time lost on the water, all after the penalty):");
    expect(d.cards.length).toBeGreaterThan(1);
    expect(lines.slice(2, 2 + d.cards.length)).toEqual(ctx.findings!.map((f, i) => `${i + 1}. ${f.title} ${f.secondsChip}${f.confidence !== 'high' ? ` (${f.confidence} confidence)` : ''}`));
    // Coach's rank order is the cards' order (biggest first here).
    expect(ctx.findings!.map((f) => f.title)).toEqual(d.cards.map((c) => cardText(c, a.meta.tzOffsetMs).title));
    expect(SYSTEM_PROMPT).toMatch(/never re-rank them/);
  });

  it('a boat with no code has no penalty card; USA 017 and USA 019 (over early, scored AOK) keep "Over early — cleared"', () => {
    expect(debrief('GBR 015').penalty).toBeNull();
    for (const s of ['USA 017', 'USA 019']) {
      const d = debrief(s);
      expect(d.penalty).toBeNull();
      expect(d.cards.find((c) => c.kind === 'D1')?.variant).toBe('ocs');
      expect(cardText(d.cards.find((c) => c.kind === 'D1')!).title).toMatch(/^Over early — cleared at \+\d+ s$/);
    }
  });
});

// ---- a scored OCS / UFD replaces the 'ocs' card (USA 017, synthetic codes)

const with017 = (status: string, keepFinish: boolean) => {
  const off = ic37Official((bs) => {
    const b = bs.find((x) => x.sailNumber === '017')!;
    b.finishStatus = status;
    b.placeClass = 16;
    if (!keepFinish) {
      b.finishTime = null;
      b.elapsedTime = null;
      b.correctedTime = null;
    }
  });
  const data = ic37LinkedRace(off);
  const an = analyzeRace(data);
  const rw = coachRaw(an, data);
  const mm = buildCoach(an, rw.wind, rw.crossMs, rw.zones ?? null, rw.heel ?? null, rw.turns ?? null, rw.overStart ?? null)!;
  const me = an.boats.find((b) => b.sail === 'USA 017')!;
  return { an, me, d: coachDebrief(an, mm, me.id)! };
};

describe('a scored start code replaces "Over early — cleared" (USA 017, synthetic UFD / OCS)', () => {
  it('UFD with a finish time: the result is lost, it sailed on to 14th; the over-the-line figures on the penalty card; no D1 ocs card', () => {
    const { an, me, d } = with017('UFD', true);
    expect(me).toMatchObject({ finishPos: null, finishCode: 'UFD', onWaterPlace: 14, scoredPoints: 16 });
    expect(d.cards.some((c) => c.kind === 'D1' && c.variant === 'ocs')).toBe(false);
    expect(d.found.some((c) => c.kind === 'D1' && c.variant === 'ocs')).toBe(false);
    const t = penaltyText(d.penalty!, an);
    expect(t.title).toBe('Scored UFD — 16 points; the result is lost');
    expect(t.sentence).toContain('You sailed on to 14th on the water.');
    // PR #32's figures for USA 017: over at the gun, back at ≈ +7 s, recrossed (bow) at ≈ +26 s.
    expect(t.chips[0]).toMatch(/^over \d+ m at gun$/);
    expect(t.chips[1]).toBe('back +7 s');
    expect(t.chips[2]).toMatch(/^recrossed \+2[5-7] s$/);
    expect(t.tip).toMatch(/safe gap to the line/);
    expect(coachCardsHtml(an, d, null)).not.toContain('Over early — cleared');
  });

  it('OCS (no finish time): "Scored OCS — 16 points; the result is lost", with the same figures', () => {
    const { an, me, d } = with017('OCS', false);
    expect(me).toMatchObject({ finishPos: null, finishCode: 'OCS', finishMs: null });
    expect(me.onWaterPlace).toBeUndefined();
    const t = penaltyText(d.penalty!, an);
    expect(t.title).toBe('Scored OCS — 16 points; the result is lost');
    expect(t.chips.join(' ')).toMatch(/over \d+ m at gun back \+7 s recrossed/);
    expect(d.cards.some((c) => c.kind === 'D1' && c.variant === 'ocs')).toBe(false);
  });
});

// ---- the card's wording

const pf = (o: Partial<PenaltyFinding>): PenaltyFinding => ({ code: 'DPI', meaning: 'Discretionary penalty', kind: 'penalty', lost: false, points: 15, onWater: 12, penaltyPlaces: 3, of: 15, over: null, turns: [], ...o });
const meta = { meta: { ...a.meta } };

describe('the penalty card’s wording', () => {
  it('a fractional SCP, no places lost, a single place, redress', () => {
    expect(penaltyText(pf({ code: 'SCP', points: 13.9, onWater: 11, penaltyPlaces: 2.9 }), meta).title).toBe('Cost 2.9 places — 11th on the water, scored 13.9 points');
    expect(penaltyText(pf({ points: 13, onWater: 13, penaltyPlaces: 0 }), meta).title).toBe('No places lost — 13th on the water, scored 13th');
    expect(penaltyText(pf({ points: 13, onWater: 12, penaltyPlaces: 1 }), meta).title).toBe('Cost 1 place — 12th on the water, scored 13th');
    expect(penaltyText(pf({ code: 'RDG', points: 8, onWater: 12, penaltyPlaces: 0 }), meta).title).toBe('Score adjusted — 12th on the water, scored 8th');
  });

  it('lost results: with and without points, with and without an on-water place', () => {
    expect(penaltyText(pf({ code: 'DSQ', kind: 'excluded', lost: true, points: 16, onWater: 2 }), meta)).toMatchObject({ title: 'Scored DSQ — 16 points; the result is lost' });
    expect(penaltyText(pf({ code: 'DSQ', kind: 'excluded', lost: true, points: 16, onWater: 2 }), meta).sentence).toContain('You sailed on to 2nd on the water.');
    expect(penaltyText(pf({ code: 'DNF', kind: 'not-finished', lost: true, points: null, onWater: null }), meta).title).toBe('Scored DNF; the result is lost');
  });

  it('a penalty turn rides on the card: its local time, minutes after the gun and seconds', () => {
    const g = a.meta.gunMs;
    const turn: PenaltyTurn = { t0: g + 18 * 60_000, t1: g + 19 * 60_000, turns: 2, deg: 720, lostS: 44.6, samples: 40, conf: 'medium' };
    const t = penaltyText(pf({ code: 'SCP', turns: [turn] }), meta);
    expect(t.chips).toEqual(['penalty turn 720 at 10:23:01 (+18 min), ≈ 45 s']);
    expect(t.sentence).toContain('a penalty turn (720), about 45 s lost');
    expect(askPenalty(pf({ code: 'SCP', turns: [turn] }), a).chips).toEqual(t.chips);
  });
});

// ---- D12 with no code: a ranked card; on the penalty card with one

describe('penalty turns in the debrief', () => {
  const g = a.meta.gunMs;
  const loop: PenaltyTurn = { t0: g + 20 * 60_000, t1: g + 20 * 60_000 + 55_000, turns: 2, deg: 700, lostS: 48, samples: 50, conf: 'medium' };
  const withTurns = (id: string) => ({ ...m, turns: new Map([[id, [loop]]]) });

  it('no code: a ranked card "Penalty turns (720)" at medium confidence on the feed, not a Regatta theme', () => {
    // The trimmed fixture's tracks end after Beat 1: the loop is put inside it.
    const b = boat('GBR 015');
    const early: PenaltyTurn = { ...loop, t0: g + 150_000, t1: g + 205_000 };
    const mm = { ...m, turns: new Map([[b.id, [early]]]) };
    const d = coachDebrief(a, mm, b.id)!;
    const c = d.found.find((o) => o.kind === 'D12')!;
    expect(c).toMatchObject({ variant: '720', seconds: 48 });
    const card = d.cards.find((x) => x.kind === 'D12');
    expect(card?.confidence).toBe('medium');
    expect(cardText(card!, a.meta.tzOffsetMs).title).toBe('Penalty turns (720)');
    const dg = raceDigest(a, mm, 'GBR 015');
    expect(dg.findings.some((f) => f.kind === 'D12')).toBe(false);
    expect(dg.turns).toEqual({ loops: 1, seconds: 48 });
  });

  it('with a code: on the penalty card, never ranked', () => {
    const d = coachDebrief(a, withTurns(boat('USA 016').id), boat('USA 016').id)!;
    expect(d.penalty!.turns).toEqual([loop]);
    expect(d.found.some((o) => o.kind === 'D12')).toBe(false);
  });
});

// ---- the Regatta view: the Penalties row

const digest = (n: number, finish: RaceDigest['finish'], turns?: RaceDigest['turns']): RegattaRace => ({
  raceNumber: n,
  label: `R${n}`,
  name: `Race ${n}`,
  status: 'done',
  digest: { raceNumber: n, sail: 'USA 016', tracked: true, finish, coverage: 0.95, noData: false, legs: [], findings: [{ theme: 'upwind', kind: 'D6', variant: 'slow', seconds: 40, confidence: 'high' }], ...(turns ? { turns } : {}) },
});
const dpi = (n: number, onWater: number, plus: number) => digest(n, { place: null, code: 'DPI', of: 15, source: 'official', points: onWater + plus, onWater, penaltyPlaces: plus });

describe('Regatta view: the Penalties row', () => {
  const ic37 = [dpi(1, 11, 3), dpi(2, 12, 3), dpi(3, 13, 3), dpi(4, 10, 3), dpi(5, 12, 3), dpi(6, 6, 6), dpi(7, 13, 0), dpi(8, 11, 3)];

  it('"DPI in 8 of 8 races · 24 penalty points · ≈ 24 places"; never a theme, a pattern or a thing to work on', () => {
    const s = summarizeRegatta(ic37);
    expect(s.penalties).toHaveLength(1);
    expect(penaltyRowText(s.penalties[0])).toBe('DPI in 8 of 8 races · 24 penalty points · ≈ 24 places');
    expect(s.findings.map((f) => f.theme)).toEqual(['upwind']);
    expect(s.top.every((t) => !/penalt|DPI/i.test(`${t.theme} ${t.title} ${t.why}`))).toBe(true);
    const html = regattaHtml(s, { running: null, message: '', done: 8, total: 8 });
    expect(html.indexOf('regatta-penalties')).toBeGreaterThan(-1);
    expect(html.indexOf('regatta-penalties')).toBeLessThan(html.indexOf('Top 3 to work on'));
    expect(penaltiesHtml(s)).toContain('<b>DPI</b> in 8 of 8 races');
  });

  it('place rows: the scored result with the on-water place', () => {
    expect(finishShort(ic37[4].digest!.finish)).toBe('DPI 15');
    const s = summarizeRegatta(ic37);
    expect(regattaHtml(s, { running: null, message: '', done: 8, total: 8 })).toContain('<small>of 15 · 12th on the water</small>');
  });

  it('a lost result, penalty turns, and no row at all without either', () => {
    const races = [
      digest(1, { place: 3, code: null, of: 12, source: 'official' }),
      digest(2, { place: null, code: 'UFD', of: 12, source: 'official', points: 13, onWater: 2, penaltyPlaces: 11 }, { loops: 1, seconds: 41.6 }),
      digest(3, { place: null, code: 'DNC', of: 12, source: 'official', points: 13 }),
    ];
    const s = summarizeRegatta(races);
    expect(s.penalties.map(penaltyRowText)).toEqual(['UFD in 1 of 3 races (R2) · 13 points; result lost', 'Penalty turns in 1 of 3 races (R2) · ≈ 42 s']);
    expect(summarizeRegatta([races[0]]).penalties).toEqual([]);
    expect(penaltiesHtml(summarizeRegatta([races[0]]))).toBe('');
  });

  it('the Regatta view’s Ask Coach context lists the penalties', () => {
    const ctx = regattaAskContext({ races: ic37, progress: { running: null, message: '', done: 8, total: 8 }, boat: { sail: 'USA 016', name: 'USA 016' } });
    expect(ctx.regatta!.penalties).toEqual(['DPI in 8 of 8 races · 24 penalty points · ≈ 24 places']);
    expect(ctx.regatta!.places![4].place).toBe('DPI 15 of 15');
    expect(sanitizeAskContext(JSON.parse(JSON.stringify(ctx)))!.regatta!.penalties).toEqual(ctx.regatta!.penalties);
  });
});
