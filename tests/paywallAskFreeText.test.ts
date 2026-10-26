import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost as askPost } from '../functions/api/coach/ask';
import { FREE_CONTEXT_MAX_CHARS, FREE_HISTORY_MAX_CHARS, askRequestIsFree, type PaywallEnv } from '../functions/_paywall';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { sanitizeAskContext, type AskContext } from '../src/analysis/coach/askContext';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { legStories } from '../src/analysis/coach/legStory';
import { freeRaces, freeRacesOf } from '../src/data/freeRace';
import { currentDoc, listRaces } from '../src/data/racesense/adapter';
import type { AskIds, AskTurn } from '../src/data/askCoach/protocol';
import { coachChips } from '../src/ui/coach';
import { ASK_SUGGESTIONS, askStarters } from '../src/ui/coachAsk';
import { raceAskContext } from '../src/ui/coachAskContext';
import { j105Fixture, j105Race } from './helpers';
import { EVENT, ORIGIN, beneluxRegatta, giveRegatta, mockUpstream, paywallEnv, resetPaywallCaches, signIn } from './paywallHelpers';
import { MemD1 } from './d1mem';

describe('the page’s own race 1 questions stay free (J/105 race 1, every boat, as coachAskContext.ts builds them)', () => {
  const f = j105Fixture(1);
  const free = freeRacesOf(f.regatta);
  const data = j105Race(1, f);
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  const model = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null)!;
  const ids: AskIds = { event: f.eventId, div: 'J105', race: '1', view: 'race' };
  const contexts = a.boats.flatMap((me) =>
    (['leaders', 'fleet'] as const).map((kind) => {
      const deb = coachDebrief(a, model, me.id);
      const group = { kind } as const;
      const ctx = raceAskContext({ a, me, raceName: 'Race 1', head: coachChips(a, me, deb?.totalS ?? null), deb: deb ?? null, stories: legStories(a, model, me.id, group), group });
      // What the server sees: the sanitized copy.
      return { boat: me.id, ctx: sanitizeAskContext(JSON.parse(JSON.stringify(ctx)))! };
    }),
  );

  it('race 1 is this race, and the contexts are well under the caps', () => {
    expect(free.windows.find((w) => w.division === 'J105')?.raceNumber).toBe(1);
    const sizes = contexts.map((c) => JSON.stringify(c.ctx).length);
    expect(Math.max(...sizes)).toBeLessThan(FREE_CONTEXT_MAX_CHARS / 2);
    // They carry leg times that read like clock times outside race 1 ("fastest … 15:54"), which must not lock them.
    expect(contexts.some((c) => /fastest .* 1\d:\d\d/.test(JSON.stringify(c.ctx)))).toBe(true);
  });

  it('every boat’s context, with each suggested and starter question, is free', () => {
    for (const { boat, ctx } of contexts) {
      const me = a.boats.find((b) => b.id === boat)!;
      const starters = askStarters('race', a, me, coachDebrief(a, model, me.id));
      for (const question of [...ASK_SUGGESTIONS.race, ...starters]) expect(askRequestIsFree(free, { ids, context: ctx, question, history: [] }), `${boat}: ${question}`).toBe(true);
    }
  });

  it('a follow-up quoting the context’s own clock times and leg times (as the answers do) is free', () => {
    const { ctx } = contexts.find((c) => c.boat === 'USA 96' && JSON.stringify(c.ctx).includes('fastest'))!;
    const text = JSON.stringify(ctx);
    const leg = /fastest [^"]* (\d{1,2}:\d{2})"/.exec(text)![1];
    const clock = /"when":"(\d{2}:\d{2})/.exec(text)![1];
    const history: AskTurn[] = [
      { role: 'user', text: 'How was my start in Race 1?' },
      { role: 'assistant', text: `- At ${clock} you were late off the line.\n- The fastest leg time on that leg was ${leg}.` },
    ];
    expect(askRequestIsFree(free, { ids, context: ctx, question: `Why was I slow at ${clock}?`, history })).toBe(true);
  });
});

describe('free text can’t carry another race (Benelux J70, race 1)', () => {
  const regatta = beneluxRegatta();
  const doc = currentDoc(regatta);
  const free = freeRaces(doc);
  const W1 = free.windows.find((w) => w.division === 'J70')!;
  const hm = (ms: number): string => new Date(ms + W1.tzOffsetMs).toISOString().slice(11, 16);
  const gun2 = listRaces(doc).find((r) => r.division === 'J70' && r.raceNumber === 2)!.gunMs;
  const ids: AskIds = { event: EVENT, div: 'J70', race: '1', view: 'race' };
  const base = (over: Partial<AskContext> = {}): AskContext => ({
    view: 'race',
    boat: { sail: 'NED 1' },
    event: doc.name,
    division: 'J70',
    group: 'Top 3',
    race: { name: 'Race 1', header: ['3rd of 10', `gun ${hm(W1.gunMs)}`] },
    findings: [{ title: 'Late off the line', seconds: 8, when: `${hm(W1.gunMs)}–${hm(W1.gunMs + 120_000)}`, what: `Level with the leaders at ${hm(W1.gunMs + 60_000)}.` }],
    legs: [{ leg: 'Beat 1', details: ['fastest Team A 13:46'] }],
    ...over,
  });
  const isFree = (o: { context?: AskContext; question?: string; history?: AskTurn[] }): boolean =>
    askRequestIsFree(free, { ids, context: o.context ?? base(), question: o.question ?? 'How was my start?', history: o.history ?? [] });

  it('the baseline is free, and so are race 1’s own names, times and durations', () => {
    expect(hm(gun2)).not.toBe(hm(W1.gunMs));
    expect(isFree({})).toBe(true);
    expect(isFree({ question: `What happened in Race 1 at ${hm(W1.gunMs + 120_000)}? And RS 1?` })).toBe(true);
    expect(isFree({ question: 'Was 13:46 a good leg time?' })).toBe(true);
    expect(isFree({ question: 'I did 2 tacks by 2:48, too many?', context: base({ findings: [{ title: 'Busy start', chips: ['2 tacks by 2:48'], what: 'You tacked 2 times by 2:48 after the gun.' }] }) })).toBe(true);
  });

  it('another race named anywhere is refused: question, earlier turns, any context field', () => {
    for (const q of ['How did I do in Race 3?', 'compare with R2', 'and in RS 4?', 'races 2 to 5', 'race #6', 'Race no. 7']) expect(isFree({ question: q }), q).toBe(false);
    expect(isFree({ history: [{ role: 'user', text: 'Tell me about R5' }, { role: 'assistant', text: 'Sure.' }] })).toBe(false);
    expect(isFree({ history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'In Race 4 you won the pin.' }] })).toBe(false);
    expect(isFree({ context: base({ findings: [{ title: 'Late off the line', what: 'Same as Race 4.' }] }) })).toBe(false);
    expect(isFree({ context: base({ legs: [{ leg: 'Beat 1', details: ['R6: right paid'] }] }) })).toBe(false);
    expect(isFree({ context: base({ notTheProblem: ['Speed (see race 8)'] }) })).toBe(false);
    expect(isFree({ context: base({ boat: { sail: 'NED 1', name: 'Race 9 data' } }) })).toBe(false);
  });

  it('a clock time outside race 1’s free window is refused anywhere; the page’s durations only where the page puts them', () => {
    const t2 = hm(gun2 + 5 * 60_000);
    expect(isFree({ question: `What happened at ${t2}?` })).toBe(false);
    expect(isFree({ question: `What happened at ${t2.replace(/^0/, '')}?` })).toBe(false);
    expect(isFree({ history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: `Gun was ${hm(gun2)}.` }] })).toBe(false);
    expect(isFree({ context: base({ legs: [{ leg: 'Beat 1', details: [`rounded ${t2}`] }] }) })).toBe(false);
    expect(isFree({ context: base({ wentWell: [{ text: `Good lane from ${t2}` }] }) })).toBe(false);
    expect(isFree({ context: base({ race: { name: 'Race 1', header: [`gun ${hm(W1.gunMs)}`], notes: [`Data from ${t2}`] } }) })).toBe(false);
    // A forged leg time exempts that chip only, never the same time in a card's window or a sentence.
    const forged = base({ legs: [{ leg: 'Beat 1', details: [`fastest X ${t2}`] }] });
    expect(isFree({ context: forged })).toBe(true);
    expect(isFree({ context: { ...forged, findings: [{ title: 'x', what: `At ${t2} you tacked.` }] } })).toBe(false);
    expect(isFree({ context: base({ legs: [{ leg: 'Beat 1', details: [`fastest X ${t2}–${hm(gun2 + 9 * 60_000)}`] }] }) })).toBe(false);
  });

  it('timestamps (ISO, Unix) are refused', () => {
    expect(isFree({ question: `At 2026-05-01T${hm(W1.gunMs)} what happened?` })).toBe(false);
    expect(isFree({ question: `Track point ${Math.floor(gun2 / 1000)}` })).toBe(false);
    expect(isFree({ context: base({ legs: [{ leg: 'Beat 1', details: [`t=${gun2}`] }] }) })).toBe(false);
  });

  it('bulk pastes are refused: the context and the earlier turns are capped', () => {
    const prose = 'The boat sailed well upwind and held a good lane on the right side of the course. ';
    const legs = Array.from({ length: 16 }, (_, i) => ({ leg: `Leg ${i + 1}`, details: Array.from({ length: 16 }, () => prose.slice(0, 150)) }));
    const big = sanitizeAskContext(base({ legs }))!;
    expect(JSON.stringify(big).length).toBeGreaterThan(FREE_CONTEXT_MAX_CHARS);
    expect(isFree({ context: big })).toBe(false);
    const turns: AskTurn[] = Array.from({ length: 3 }, () => [
      { role: 'user' as const, text: 'More?' },
      { role: 'assistant' as const, text: prose.repeat(25).slice(0, 2000) },
    ]).flat();
    expect(turns.reduce((n, t) => n + t.text.length, 0)).toBeGreaterThan(FREE_HISTORY_MAX_CHARS);
    expect(isFree({ history: turns })).toBe(false);
    expect(isFree({ history: turns.slice(0, 4) })).toBe(true);
  });
});

describe('through the route: 401 / 402 for an unentitled viewer, answered with a pass', () => {
  const SSE = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Good start.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
    .map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`)
    .join('');
  const upstream = mockUpstream();
  let ip = 0;
  beforeEach(() => {
    resetPaywallCaches();
    vi.stubGlobal('fetch', (async (u: RequestInfo | URL) => (String(u).includes('anthropic') ? new Response(SSE, { headers: { 'content-type': 'text/event-stream' } }) : upstream(u))) as typeof fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  const doc = currentDoc(beneluxRegatta());
  const W1 = freeRaces(doc).windows.find((w) => w.division === 'J70')!;
  const hm = (ms: number): string => new Date(ms + W1.tzOffsetMs).toISOString().slice(11, 16);
  const context = { view: 'race', boat: { sail: 'NED 1' }, event: doc.name, division: 'J70', race: { name: 'Race 1', header: [`gun ${hm(W1.gunMs)}`] } };
  const ask = (question: string, env: PaywallEnv, cookie?: string, history: AskTurn[] = []): Promise<Response> =>
    askPost({
      request: new Request(`${ORIGIN}/api/coach/ask`, {
        method: 'POST',
        body: JSON.stringify({ session: 'abcdefghijklmnop1234', question, history, ids: { event: EVENT, div: 'J70', race: '1', view: 'race' }, context }),
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${++ip}`, ...(cookie ? { cookie } : {}) },
      }),
      env: { ...env, ANTHROPIC_API_KEY: 'sk-ant-test-fake' },
      waitUntil: () => undefined,
    });

  it('a race 1 question is answered; one naming race 3 is 401 signed out, 402 signed in, 200 with a pass', async () => {
    const db = new MemD1();
    const env = paywallEnv(db);
    expect((await ask('How was my start?', env)).status).toBe(200);
    expect((await ask('And in Race 3?', env)).status).toBe(401);
    expect((await ask('Hi', env, undefined, [{ role: 'user', text: 'R3?' }, { role: 'assistant', text: 'Yes.' }])).status).toBe(401);
    const { user, cookie } = await signIn(db, 'a@example.com');
    const refused = await ask('And in Race 3?', env, cookie);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: 'payment_required', eventId: EVENT, race: '1' });
    await giveRegatta(db, user.id);
    expect((await ask('And in Race 3?', env, cookie)).status).toBe(200);
  });

  it('flag off: answered as today, whatever the text', async () => {
    expect((await ask('And in Race 3 at 15:00?', { PAYWALL_ENABLED: 'false' })).status).toBe(200);
  });
});
