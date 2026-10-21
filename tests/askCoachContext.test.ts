import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { MAX_CONTEXT_TOKENS, cleanString, contextText, estimateTokens, sanitizeAskContext, type AskContext } from '../src/analysis/coach/askContext';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { legStories } from '../src/analysis/coach/legStory';
import { digestRace, type RegattaRace } from '../src/analysis/coach/regatta';
import { coachChips } from '../src/ui/coach';
import { cardText } from '../src/ui/coachCards';
import { askBoat, raceAskContext, regattaAskContext } from '../src/ui/coachAskContext';
import { SYSTEM_PROMPT, buildPrompt } from '../functions/_askCoach';
import { j105Race } from './helpers';

const GT = 'USA 96';

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
    expect(ctx.race?.notes).toEqual(['Only 2 clear gains with this data']);
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
    expect(JSON.parse(out.text).trimmed).toEqual(out.trimmed);
    expect(JSON.parse(out.text).findings.length).toBe(ctx.findings!.length);
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
    const j = JSON.parse(out.text);
    expect(j.findings.length).toBeGreaterThanOrEqual(2);
  });
});
