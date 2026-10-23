import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { MAX_CONTEXT_TOKENS, cleanString, contextText, estimateTokens, penaltyLine, penaltyRowCost, sanitizeAskContext, type AskContext } from '../src/analysis/coach/askContext';
import type { PenaltyRow } from '../src/analysis/coach/regatta';
import { penaltyRowText } from '../src/ui/coachRegatta';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { legStories } from '../src/analysis/coach/legStory';
import { digestRace, type RegattaRace } from '../src/analysis/coach/regatta';
import { coachChips } from '../src/ui/coach';
import { cardText } from '../src/ui/coachCards';
import { askBoat, raceAskContext, regattaAskContext } from '../src/ui/coachAskContext';
import { SYSTEM_PROMPT, buildPrompt } from '../functions/_askCoach';
import { j105Race } from './helpers';

const GT = 'USA 96';
const PENALTY = { code: 'DPI', meaning: 'Discretionary penalty: the protest committee added points instead of disqualifying', result: 'Cost 3 places — 12th on the water, scored 15th' };

function raceCtx(n: 1 | 2 | 3 = 1): { ctx: AskContext; a: ReturnType<typeof analyzeRace>; deb: NonNullable<ReturnType<typeof coachDebrief>> } {
  const data = j105Race(n);
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  const model = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null)!;
  const me = a.boats.find((b) => b.id === GT)!;
  const deb = coachDebrief(a, model, GT)!;
  const group = { kind: 'leaders' } as const;
  const ctx = raceAskContext({ a, me, raceName: `Race ${n}`, head: coachChips(a, me, null, deb.totalS, deb.raceCov), deb, stories: legStories(a, model, GT, group), group });
  return { ctx, a, deb };
}

function regattaCtx(): AskContext {
  const races: RegattaRace[] = ([1, 2, 3] as const).map((n) => {
    const data = j105Race(n);
    return { raceNumber: n, label: `R${n}`, name: `Race ${n}`, status: 'done', digest: digestRace(analyzeRace(data), data, GT) };
  });
  return regattaAskContext({ races, progress: { running: null, message: '', done: 3, total: 3 }, boat: { sail: GT, name: 'Good Trade' }, event: 'J/105 CBC', division: 'J105' });
}

/** contextText's details: the JSON on its last line. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const details = (text: string): any => JSON.parse(text.slice(text.lastIndexOf('\n') + 1));

/** Every key at any depth. */
const keysOf = (x: unknown): string[] =>
  Array.isArray(x) ? x.flatMap(keysOf) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...keysOf(v)]) : [];

describe('Ask Coach context: the Race view', () => {
  const { ctx, a, deb } = raceCtx(1);
  const text = JSON.stringify(ctx);

  it('carries the cards as the page shows them, rounded, with confidence and coverage', () => {
    expect(ctx.view).toBe('race');
    expect(ctx.boat.sail).toBe(GT);
    expect(ctx.group).toBe('Top 3');
    expect(ctx.findings).toHaveLength(deb.cards.length);
    ctx.findings!.forEach((f, i) => {
      const c = deb.cards[i];
      expect(f.title).toBe(cardText(c, a.meta.tzOffsetMs).title);
      expect(f.seconds).toBe(Math.round(c.seconds));
      expect(Number.isInteger(f.coveragePct)).toBe(true);
      expect(['high', 'medium', 'low']).toContain(f.confidence);
      expect(f.what).toBeTruthy();
    });
    // The header as shown, ⚠ caveats marked (this boat's tracker covered 27%: no tracked finish).
    expect(ctx.race?.header).toEqual(expect.arrayContaining(['gun 11:05', '⚠ no tracked finish', '⚠ tracker 27%']));
    // One card in race 1 on the chart's gap (D5's caught-leader card no longer fires: coachShiftGolden).
    expect(ctx.race?.notes).toEqual(['Only 1 clear gain with this data']);
    expect(ctx.legs?.length).toBe(a.legs.length);
    expect(ctx.legs![0].summary?.length).toBeGreaterThan(0);
  });

  it('is already schema-clean (the server keeps it whole) and has no raw timestamps or track arrays', () => {
    expect(sanitizeAskContext(JSON.parse(text))).toEqual(ctx);
    expect(text).not.toMatch(/\d{10,}/);
    expect(keysOf(ctx)).not.toContain('t0');
    expect(text).not.toMatch(/\d\.\d{3,}/);
  });

  it('names boats by sail and boat name only: no owner, crew or skipper fields', () => {
    expect(keysOf(ctx).filter((k) => /owner|crew|skipper|helm|person|email/i.test(k))).toEqual([]);
    expect(askBoat({ sail: '851', name: '#851' })).toEqual({ sail: '851' });
  });

  it('fits the cap untrimmed', () => {
    const out = contextText(ctx);
    expect(out.trimmed).toEqual([]);
    expect(out.tokens).toBeLessThan(MAX_CONTEXT_TOKENS);
    console.info(`[ask-coach] race context J/105 R1 ${GT}: ${out.text.length} chars ≈ ${out.tokens} tokens (chars/3)`);
  });
});

describe('Ask Coach context: the Regatta view', () => {
  const ctx = regattaCtx();

  it('carries places, the top 3 to work on, recurring findings, leg types and went well', () => {
    expect(ctx.view).toBe('regatta');
    expect(ctx.regatta?.places?.map((p) => p.race)).toEqual(['R1', 'R2', 'R3']);
    expect(ctx.regatta?.places?.every((p) => /of \d+/.test(p.place))).toBe(true);
    expect(ctx.regatta?.status).toMatch(/3 of 3 races analysed/);
    expect(ctx.regatta?.workOn?.length).toBeGreaterThan(0);
    expect(ctx.regatta?.recurring?.length).toBeGreaterThan(0);
    expect(ctx.regatta?.recurring?.[0].races).toMatch(/^\d+ of \d+\*?$/);
    expect(ctx.regatta?.legTypes?.length).toBeGreaterThan(0);
  });

  it('is schema-clean and fits the cap', () => {
    const text = JSON.stringify(ctx);
    expect(sanitizeAskContext(JSON.parse(text))).toEqual(ctx);
    expect(text).not.toMatch(/\d{10,}/);
    const out = contextText(ctx);
    expect(out.trimmed).toEqual([]);
    for (const [name, c] of [['race', raceCtx(1).ctx], ['regatta', ctx]] as const) {
      const sys = buildPrompt({ question: 'q', history: [], ids: {}, context: c }).system.map((b) => b.text).join('');
      // Above the model's 512-token minimum, so the prefix is cached.
      expect(estimateTokens(sys)).toBeGreaterThan(512);
      console.info(`[ask-coach] cached prefix (rules + ${name} context): ${sys.length} chars ≈ ${estimateTokens(sys)} tokens; rules alone ≈ ${estimateTokens(SYSTEM_PROMPT)}`);
    }
    console.info(`[ask-coach] regatta context J/105 R1–R3 ${GT}: ${out.text.length} chars ≈ ${out.tokens} tokens (chars/3)`);
  });
});

describe('sanitizeAskContext: a whitelist', () => {
  const base = { view: 'race', boat: { sail: 'USA 96', name: 'Good Trade' } };

  it('needs a view and a boat', () => {
    expect(sanitizeAskContext(null)).toBeNull();
    expect(sanitizeAskContext([])).toBeNull();
    expect(sanitizeAskContext({ view: 'race' })).toBeNull();
    expect(sanitizeAskContext({ view: 'chat', boat: { sail: '1' } })).toBeNull();
    expect(sanitizeAskContext(base)).toEqual(base);
  });

  it('drops unknown fields at every depth, owner and crew included', () => {
    const c = sanitizeAskContext({
      ...base,
      owner: 'Jane Doe',
      crew: ['A', 'B'],
      boat: { sail: 'USA 96', name: 'Good Trade', owner: 'Jane Doe', skipper: 'X' },
      findings: [{ title: 'Late', seconds: 12, helm: 'Y', facts: { secret: 1 } }],
      regatta: { places: [{ race: 'R1', place: '3rd of 20', crewName: 'Z' }], ownerNotes: 'x' },
      trimmed: ['client says'],
      __proto__: { polluted: true },
    });
    expect(c).toEqual({ ...base, findings: [{ title: 'Late', seconds: 12 }], regatta: { places: [{ race: 'R1', place: '3rd of 20' }] } });
    expect(JSON.stringify(c)).not.toMatch(/Jane|owner|crew|skipper|helm|polluted|client says/);
  });

  it('checks types, clamps strings, arrays and numbers', () => {
    const c = sanitizeAskContext({
      ...base,
      findings: [
        { title: 42, seconds: 5 },
        { title: 'x'.repeat(1000), seconds: 12.6, coveragePct: 140, confidence: 'certain', chips: ['a', 7, 'b\n\u0000c'] },
        ...Array.from({ length: 10 }, (_, i) => ({ title: `F${i}`, seconds: -3 })),
      ],
      notTheProblem: 'not a list',
      wentWell: [{ text: 'Beat 2', seconds: Infinity }],
    })!;
    expect(c.findings).toHaveLength(5);
    expect(c.findings![0].title.length).toBe(160);
    expect(c.findings![0].title.endsWith('…')).toBe(true);
    expect(c.findings![0]).toMatchObject({ seconds: 13, coveragePct: 100, chips: ['a', 'b c'] });
    expect(c.findings![0].confidence).toBeUndefined();
    expect(c.findings![1].seconds).toBe(0);
    expect(c.notTheProblem).toBeUndefined();
    expect(c.wentWell).toEqual([{ text: 'Beat 2' }]);
    expect(cleanString('  a\r\n\tb c  ', 10)).toBe('a b c');
  });
});

describe('contextText: under the cap, lowest priority first', () => {
  it('trims leg details first, then more, and says what it left out', () => {
    const { ctx } = raceCtx(1);
    const full = contextText(ctx);
    const cap = Math.floor(full.tokens * 0.8);
    const out = contextText(ctx, cap);
    expect(out.tokens).toBeLessThanOrEqual(cap);
    expect(out.trimmed[0]).toBe('leg details');
    expect(details(out.text).trimmed).toEqual(out.trimmed);
    expect(details(out.text).findings.length).toBe(ctx.findings!.length);
  });

  it('a huge context lands at ~6K tokens with the findings kept', () => {
    const big: AskContext = {
      view: 'regatta',
      boat: { sail: 'USA 1' },
      findings: Array.from({ length: 6 }, (_, i) => ({ title: `Finding ${i}`, seconds: 10 * i, what: 'w'.repeat(400), tip: 't'.repeat(400), chips: Array(6).fill('c'.repeat(160)) })),
      legs: Array.from({ length: 16 }, (_, i) => ({ leg: `Leg ${i}`, summary: Array(6).fill('s'.repeat(160)), details: Array(16).fill('d'.repeat(160)) })),
      notTheProblem: Array(12).fill('n'.repeat(160)),
      regatta: {
        places: Array.from({ length: 40 }, (_, i) => ({ race: `R${i}`, place: '1st of 9', note: 'p'.repeat(160) })),
        recurring: Array.from({ length: 20 }, (_, i) => ({ finding: `F${i}`.padEnd(160, 'f'), races: '1 of 2', where: Array(40).fill('R1') })),
        legTypes: Array.from({ length: 4 }, () => ({ legs: 'Beats', best: 'b'.repeat(160), worst: 'w'.repeat(160) })),
      },
    };
    const clean = sanitizeAskContext(big)!;
    expect(estimateTokens(JSON.stringify(clean))).toBeGreaterThan(MAX_CONTEXT_TOKENS);
    const out = contextText(clean);
    expect(out.tokens).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
    expect(out.trimmed).toContain('leg details');
    expect(out.trimmed).toContain('leg by leg');
    const j = details(out.text);
    expect(j.findings.length).toBeGreaterThanOrEqual(2);
  });

  it('trims the findings beyond the first 2 before any of the penalty, and the cut at the cap keeps the penalty first', () => {
    const turn = 'penalty turn 720 at 10:23:01 (+18 min), ≈ 45 s';
    const big: AskContext = {
      view: 'race',
      boat: { sail: 'USA 016' },
      penalty: { ...PENALTY, chips: [turn] },
      findings: Array.from({ length: 6 }, (_, i) => ({ title: `Finding ${i + 1}`, seconds: 60 - 10 * i, what: 'w'.repeat(400), tip: 't'.repeat(400) })),
    };
    const full = contextText(big);
    const out = contextText(big, Math.floor(full.tokens * 0.5));
    expect(out.trimmed).toContain('findings beyond the first 2');
    expect(out.trimmed).not.toContain('penalty chips');
    expect(out.text.split('\n')[0]).toContain(turn);
    expect(details(out.text).findings.map((f: { rank: number }) => f.rank)).toEqual([1, 2]);
    // A cap too small for anything: cut at the end, the penalty line still first.
    const tiny = contextText(big, 80);
    expect(tiny.tokens).toBeLessThanOrEqual(80);
    expect(tiny.trimmed).toContain('penalty chips');
    expect(tiny.text.startsWith(`Top impact of this race — official penalty: DPI (${PENALTY.meaning}): ${PENALTY.result}.`)).toBe(true);
  });
});

// ---- the order of impact: the penalty first, then the findings in Coach's rank order

describe('contextText: the penalty is the top impact, the findings are numbered in rank order', () => {
  it('the bug report: penalty + one 14 s finding → the penalty line first, labelled the top impact, then "1." the finding', () => {
    const lines = contextText({ view: 'race', boat: { sail: 'USA 016' }, penalty: PENALTY, findings: [{ title: 'Slow upwind on beat 2', seconds: 14 }] }).text.split('\n');
    expect(lines[0]).toBe(`Top impact of this race — official penalty: DPI (${PENALTY.meaning}): Cost 3 places — 12th on the water, scored 15th.`);
    expect(lines[1]).toBe("Coach's findings, ranked by Coach, biggest first (time lost on the water, all after the penalty):");
    expect(lines[2]).toBe('1. Slow upwind on beat 2 ≈ 14 s');
    // The details: no second copy of the penalty, the finding carries its rank.
    const j = details(lines.join('\n'));
    expect(j.penalty).toBeUndefined();
    expect(j.findings).toEqual([{ rank: 1, title: 'Slow upwind on beat 2', seconds: 14 }]);
  });

  it('findings numbered 1..n in the array (Coach) order, chips as shown, confidence when not high', () => {
    const findings = [
      { title: 'Footing too low upwind', seconds: 122, secondsChip: '≈ 122 s', confidence: 'low' as const },
      { title: 'Lost ground after the start', seconds: 40, confidence: 'high' as const },
      { title: 'Slow rounding', seconds: 55, secondsChip: '10–35 s', confidence: 'medium' as const },
    ];
    const text = contextText({ view: 'race', boat: { sail: 'USA 96' }, findings }).text;
    const lines = text.split('\n');
    // No penalty: still labelled as ranked, and Coach's order kept (55 s stays 3rd).
    expect(lines.slice(0, 4)).toEqual([
      "Coach's findings, ranked by Coach, biggest first:",
      '1. Footing too low upwind ≈ 122 s (low confidence)',
      '2. Lost ground after the start ≈ 40 s',
      '3. Slow rounding 10–35 s (medium confidence)',
    ]);
    expect(text).not.toMatch(/penalty/i);
    expect(details(text).findings.map((f: { rank: number; title: string }) => `${f.rank} ${f.title}`)).toEqual(findings.map((f, i) => `${i + 1} ${f.title}`));
  });

  it("the penalty's turns and the rest of its sentence ride on its line; one that cost no places isn't labelled the top impact", () => {
    const turn = 'penalty turn 720 at 10:23:01 (+18 min), ≈ 45 s';
    const p = { ...PENALTY, code: 'SCP', chips: [turn], what: `${PENALTY.meaning}. The track shows a penalty turn (720), about 45 s lost.` };
    expect(penaltyLine(p)).toBe(`Top impact of this race — official penalty: SCP (${PENALTY.meaning}): ${PENALTY.result}. On the track: ${turn}. The track shows a penalty turn (720), about 45 s lost.`);
    const none = contextText({ view: 'race', boat: { sail: 'USA 016' }, penalty: { ...PENALTY, result: 'No places lost — 13th on the water, scored 13th' }, findings: [{ title: 'Slow', seconds: 14 }] }).text;
    expect(none.split('\n')[0]).toMatch(/^Official scoring code of this race \(it cost no places\): DPI/);
    expect(none).not.toContain('Top impact');
    expect(none.split('\n')[1]).toBe("Coach's findings, ranked by Coach, biggest first:");
  });

  it('the Regatta view: the Penalties row first, labelled the top impact, then work-on ranked, recurring in order', () => {
    const text = contextText({
      view: 'regatta',
      boat: { sail: 'USA 016' },
      regatta: {
        status: '8 of 8 races analysed',
        penalties: ['DPI in 8 of 8 races · 24 penalty points · ≈ 24 places'],
        workOn: [{ title: 'Upwind speed', atStakeS: 120, pattern: true }, { title: 'Starts', atStakeS: 60 }],
        recurring: [{ finding: 'Slow upwind', races: '5 of 8' }, { finding: 'Late starts', races: '3 of 8' }],
      },
    }).text;
    const lines = text.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      'Top impact across the regatta — Penalties row (official scoring codes and the places they cost):',
      '- DPI in 8 of 8 races · 24 penalty points · ≈ 24 places',
      'Top things to work on, ranked by Coach, biggest first (after the Penalties row):',
      '1. Upwind speed ~120 s (pattern)',
      '2. Starts ~60 s',
      'Recurring findings: in Coach\'s order, most at stake first (weighted over the regatta); "rank" in the details.',
    ]);
    const j = details(text);
    expect(j.regatta.penalties).toBeUndefined();
    expect(j.regatta.workOn.map((w: { rank: number }) => w.rank)).toEqual([1, 2]);
    expect(j.regatta.recurring.map((w: { rank: number; finding: string }) => `${w.rank} ${w.finding}`)).toEqual(['1 Slow upwind', '2 Late starts']);
    // Penalty turns alone: listed first, but not called an official penalty.
    const turns = contextText({ view: 'regatta', boat: { sail: 'X' }, regatta: { penalties: ['Penalty turns in 1 of 3 races (R2) · ≈ 42 s'] } }).text;
    expect(turns.split('\n')[0]).toBe('Penalties row (penalty turns, no official code):');
  });

  it('a race penalty that cost no places, with a 122 s finding: no "Top impact", the findings first and labelled ranked', () => {
    for (const result of ['No places lost — 13th on the water, scored 13th', 'Score adjusted — 12th on the water, scored 8th']) {
      const text = contextText({ view: 'race', boat: { sail: 'USA 016' }, penalty: { code: 'RDG', result }, findings: [{ title: 'Footing too low upwind', seconds: 122 }] }).text;
      expect(text).not.toContain('Top impact');
      expect(text.split('\n').slice(0, 3)).toEqual([`Official scoring code of this race (it cost no places): RDG: ${result}.`, "Coach's findings, ranked by Coach, biggest first:", '1. Footing too low upwind ≈ 122 s']);
    }
  });

  it('the Regatta view: a Penalties row that cost 0 places is not the top impact; one that cost places is', () => {
    const lead = (penalties: string[]) => contextText({ view: 'regatta', boat: { sail: 'USA 016' }, regatta: { penalties, workOn: [{ title: 'Upwind speed', atStakeS: 120 }] } }).text.split('\n');
    const zero = 'DPI in 1 of 1 races · 0 penalty points · ≈ 0 places';
    // The review's repro: neutral label, work-on without "(after the Penalties row)".
    expect(lead([zero]).slice(0, 4)).toEqual([
      'Penalties row (official scoring codes; the row shows no places lost):',
      `- ${zero}`,
      'Top things to work on, ranked by Coach, biggest first:',
      '1. Upwind speed ~120 s',
    ]);
    expect(lead([zero]).join('\n')).not.toContain('Top impact');
    // Places cost: the top impact, work-on after it.
    const costly = 'DPI in 8 of 8 races · 24 penalty points · ≈ 24 places';
    for (const rows of [[costly], [zero, costly], ['ZFP in 1 of 8 races (R4) · 1 penalty point · ≈ 0.5 places'], ['UFD in 1 of 8 races (R3) · 16 points; result lost']]) {
      const l = lead(rows);
      expect(l[0]).toBe('Top impact across the regatta — Penalties row (official scoring codes and the places they cost):');
      expect(l[1 + rows.length]).toBe('Top things to work on, ranked by Coach, biggest first (after the Penalties row):');
    }
    // Penalty turns alone: label unchanged, never the top impact.
    const turns = lead(['Penalty turns in 1 of 3 races (R2) · ≈ 42 s']);
    expect(turns[0]).toBe('Penalties row (penalty turns, no official code):');
    expect(turns[2]).toBe('Top things to work on, ranked by Coach, biggest first:');
  });

  it("penaltyRowCost reads the UI's own Penalties lines", () => {
    const row = (o: Partial<PenaltyRow>): PenaltyRow => ({ code: 'DPI', meaning: 'm', races: 1, of: 8, raceLabels: ['R3'], lost: false, penaltyPoints: null, places: null, points: null, ...o });
    const cases: [PenaltyRow, boolean][] = [
      [row({ penaltyPoints: 24, places: 24, races: 8, raceLabels: [] }), true],
      [row({ penaltyPoints: 1, places: 0.5 }), true],
      [row({ penaltyPoints: 1, places: 1 }), true],
      [row({ penaltyPoints: 0, places: 0 }), false],
      [row({ penaltyPoints: 2, places: 0.04 }), false], // shown "≈ 0 places"
      [row({ code: 'RDG', points: 8 }), false],
      [row({ code: 'UFD', lost: true, points: 16 }), true],
      [row({ code: 'DNF', lost: true, races: 2, raceLabels: ['R1', 'R2'] }), true],
      [row({ code: 'turns', loops: 2, seconds: 70 }), false],
    ];
    expect(cases.map(([p]) => [penaltyRowText(p), penaltyRowCost(penaltyRowText(p))])).toEqual(cases.map(([p, c]) => [penaltyRowText(p), c]));
  });

  it('the J/105 Regatta context (real summary): its work-on list numbered in the summary order', () => {
    const ctx = regattaCtx();
    const lines = contextText(ctx).text.split('\n');
    const i = lines.indexOf('Top things to work on, ranked by Coach, biggest first:');
    expect(i).toBe(0);
    expect(lines.slice(1, 1 + ctx.regatta!.workOn!.length).map((l) => l.replace(/ ~\d+ s| \(pattern\)/g, ''))).toEqual(ctx.regatta!.workOn!.map((w, k) => `${k + 1}. ${w.title}`));
  });
});
