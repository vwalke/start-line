import { describe, expect, it } from 'vitest';
import type { AskContext } from '../src/analysis/coach/askContext';
import { askCoach, askStatus } from '../src/data/askCoach/api';
import { QUESTION_MAX, type AskRequest } from '../src/data/askCoach/protocol';
import { sseFrame } from '../src/data/askCoach/sse';
import {
  ASK_NOTE,
  ASK_SUGGESTIONS,
  answerHtml,
  askLogHtml,
  askPanelHtml,
  askPanelShown,
  createAskCoach,
  historyOf,
  leftText,
  newSessionId,
  type AskPanelState,
} from '../src/ui/coachAsk';

const CTX: AskContext = { view: 'race', boat: { sail: 'USA 96' } };
const IDS = { event: 'abcd1234', div: 'J105', race: '1', sail: 'USA 96', view: 'race' as const };
const STATUS_ON = { ok: true, enabled: true, limits: { sessionMax: 10, dailyMax: 30, questionMax: QUESTION_MAX, historyMax: 6 } };

const json = (status: number, b: unknown): Response => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
/** Our event stream, cut into small chunks. */
const sse = (frames: string): Response => {
  const b = new TextEncoder().encode(frames);
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (i >= b.length) return c.close();
        c.enqueue(b.slice(i, (i += 5)));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
};
const answer = (parts: string[], remaining = 9, stop = 'end_turn'): string =>
  sseFrame('meta', { remaining }) + parts.map((t) => sseFrame('delta', { text: t })).join('') + sseFrame('done', { stop, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, remaining });

function server(opts: { status?: () => Response; ask?: (req: AskRequest) => Response } = {}) {
  const asks: AskRequest[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/coach/status')) return opts.status ? opts.status() : json(200, STATUS_ON);
    if (u.endsWith('/api/coach/ask')) {
      const req = JSON.parse(String(init!.body)) as AskRequest;
      asks.push(req);
      return opts.ask ? opts.ask(req) : sse(answer(['Your start ', 'cost ≈ 29 s.']));
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return Object.assign(f, { asks });
}

function coach(f: typeof fetch) {
  const renders: AskPanelState[] = [];
  let n = 0;
  const c = createAskCoach({ fetch: f, render: (s) => renders.push(structuredClone(s)), sessionId: () => `session-id-number-${++n}` });
  return { c, renders };
}

describe('Ask Coach panel: availability', () => {
  it('hidden when the status says off, fails, or is not JSON; shown when on (and a boat is picked)', async () => {
    for (const status of [() => json(200, { ok: true, enabled: false, limits: {} }), () => json(500, {}), () => new Response('<html>', { status: 200 }), () => new Response('', { status: 404 })]) {
      const { c } = coach(server({ status }));
      expect(await c.check()).toEqual({ enabled: false });
      expect(askPanelShown(c.state(), true)).toBe(false);
    }
    const thrower = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await askStatus(thrower)).toEqual({ enabled: false });
    const { c } = coach(server());
    expect(askPanelShown(c.state(), true)).toBe(false); // not known yet: hidden
    await c.check();
    expect(askPanelShown(c.state(), true)).toBe(true);
    expect(askPanelShown(c.state(), false)).toBe(false);
    expect(c.state().remaining).toBe(10);
  });

  it('checks the status once', async () => {
    let n = 0;
    const { c } = coach(
      server({
        status: () => {
          n++;
          return json(200, STATUS_ON);
        },
      }),
    );
    await Promise.all([c.check(), c.check()]);
    await c.check();
    expect(n).toBe(1);
  });

  it('asking while off sends nothing', async () => {
    const f = server({ status: () => json(200, { ok: true, enabled: false }) });
    const { c } = coach(f);
    await c.check();
    await c.ask('Where did I gain?', CTX, IDS);
    expect(f.asks).toHaveLength(0);
  });
});

describe('Ask Coach panel: a conversation', () => {
  it('streams the answer in, then remembers it as history for the next question', async () => {
    const f = server();
    const { c, renders } = coach(f);
    await c.check();
    c.setKey('race#k1#USA 96#top3');
    await c.ask('  What cost me the most this race?  ', CTX, IDS);
    expect(f.asks[0]).toEqual({ session: 'session-id-number-2', question: 'What cost me the most this race?', history: [], ids: IDS, context: CTX });
    // Text arrived in pieces while streaming.
    const streaming = renders.filter((r) => r.turns[0]?.state === 'streaming').map((r) => r.turns[0].a);
    expect(streaming).toContain('Your start ');
    expect(c.state().turns).toEqual([{ q: 'What cost me the most this race?', a: 'Your start cost ≈ 29 s.', state: 'done', cut: false }]);
    expect(c.state().busy).toBe(false);
    expect(c.state().remaining).toBe(9);
    await c.ask('Where did I gain?', CTX, IDS);
    expect(f.asks[1].history).toEqual([
      { role: 'user', text: 'What cost me the most this race?' },
      { role: 'assistant', text: 'Your start cost ≈ 29 s.' },
    ]);
    expect(f.asks[1].session).toBe(f.asks[0].session);
  });

  it('resets on a race, boat, view or group change: no history, a new chat id, the full allowance', async () => {
    const f = server();
    const { c } = coach(f);
    await c.check();
    c.setKey('race#R1#USA 96#top3');
    await c.ask('q1', CTX, IDS);
    c.setKey('race#R1#USA 96#top3'); // the same: nothing changes
    expect(c.state().turns).toHaveLength(1);
    for (const key of ['race#R2#USA 96#top3', 'race#R2#USA 7#top3', 'regatta#R2#USA 7#', 'race#R2#USA 7#near']) {
      c.setKey(key);
      expect(c.state().turns).toEqual([]);
      expect(c.state().remaining).toBe(10);
      await c.ask('q', CTX, IDS);
    }
    expect(new Set(f.asks.map((a) => a.session)).size).toBe(5);
    expect(f.asks.slice(1).every((a) => a.history!.length === 0)).toBe(true);
  });

  it('a reset mid-answer stops it: the old answer never paints into the new chat', async () => {
    const gate: { release: () => void } = { release: () => undefined };
    const f = server({
      ask: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(sseFrame('meta', { remaining: 9 }) + sseFrame('delta', { text: 'old ' })));
              gate.release = () => {
                try {
                  c.enqueue(new TextEncoder().encode(sseFrame('delta', { text: 'late' }) + sseFrame('done', { stop: 'end_turn', remaining: 9 })));
                  c.close();
                } catch {
                  /* cancelled */
                }
              };
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const { c } = coach(f);
    await c.check();
    c.setKey('a');
    const p = c.ask('q', CTX, IDS);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.state().turns[0].a).toBe('old ');
    c.setKey('b');
    gate.release();
    await p;
    expect(c.state().turns).toEqual([]);
    expect(c.state().busy).toBe(false);
  });

  it('stop: ends the answer, keeps what came, and frees the box', async () => {
    let aborted = false;
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/status')) return json(200, STATUS_ON);
      init!.signal!.addEventListener('abort', () => (aborted = true));
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(sseFrame('delta', { text: 'Partial' })));
            init!.signal!.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    const { c } = coach(f);
    await c.check();
    c.setKey('a');
    const p = c.ask('q', CTX, IDS);
    await new Promise((r) => setTimeout(r, 10));
    c.stop();
    await p;
    expect(aborted).toBe(true);
    expect(c.state().turns[0]).toMatchObject({ a: 'Partial', state: 'stopped' });
    expect(c.state().busy).toBe(false);
    expect(historyOf(c.state().turns)).toEqual([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'Partial' },
    ]);
  });

  it('friendly errors: rate limited, resting for today, not configured, cut off, offline', async () => {
    const cases: [Response | (() => Response), RegExp, number | null][] = [
      [json(429, { ok: false, error: 'rate-limited-session', message: 'x' }), /all the questions for this chat/, 0],
      [json(429, { ok: false, error: 'rate-limited-daily', message: 'x' }), /most questions for today/, 0],
      [json(429, { ok: false, error: 'resting', message: 'x' }), /resting for today/, 0],
      [json(503, { ok: false, error: 'not-configured', message: 'x' }), /not set up/, 10],
      [new Response('<html>gateway</html>', { status: 502 }), /couldn't answer/i, 10],
      [sse(sseFrame('meta', { remaining: 4 }) + sseFrame('delta', { text: 'Half' }) + sseFrame('error', { error: 'busy', message: 'x' })), /busy/, 4],
      [sse(sseFrame('delta', { text: 'Half' })), /cut off/, 10],
    ];
    for (const [res, msg, left] of cases) {
      const { c } = coach(server({ ask: () => (typeof res === 'function' ? res() : res.clone()) }));
      await c.check();
      c.setKey('k');
      await c.ask('q', CTX, IDS);
      const t = c.state().turns[0];
      expect(t.state).toBe('error');
      expect(t.error).toMatch(msg);
      expect(c.state().remaining).toBe(left);
      expect(askLogHtml(c.state())).toContain('role="alert"');
    }
    const offline = (async (u: string | URL | Request) => {
      if (String(u).endsWith('/status')) return json(200, STATUS_ON);
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const { c } = coach(offline);
    await c.check();
    await c.ask('q', CTX, IDS);
    expect(c.state().turns[0].error).toMatch(/connection/);
  });

  it('an answer at the length cap is marked cut short', async () => {
    const { c } = coach(server({ ask: () => sse(answer(['Long…'], 9, 'max_tokens')) }));
    await c.check();
    await c.ask('q', CTX, IDS);
    expect(c.state().turns[0].cut).toBe(true);
    expect(askLogHtml(c.state())).toContain('(Answer cut short.)');
  });

  it('askCoach on its own: aborting before the reply calls nothing back', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const calls: string[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return sse(answer(['x']));
    }) as unknown as typeof fetch;
    await askCoach({ session: 's'.repeat(16), question: 'q', context: CTX }, { onDelta: () => calls.push('d'), onDone: () => calls.push('done'), onError: () => calls.push('err') }, { signal: ctl.signal, fetch: f });
    expect(calls).toEqual([]);
  });
});

describe('Ask Coach panel: HTML', () => {
  it('the panel: collapsible, suggestions per view, counter and limit, aria-live log, the note', () => {
    const race = askPanelHtml('race');
    expect(race).toMatch(/^<details class="coach-ask-box">/);
    expect(askPanelHtml('race', true)).toContain('<details class="coach-ask-box" open>');
    for (const q of ASK_SUGGESTIONS.race) expect(race).toContain(`data-ask-suggest="${q.replace(/'/g, '&#39;')}"`);
    expect(ASK_SUGGESTIONS.race.length).toBeGreaterThanOrEqual(3);
    expect(ASK_SUGGESTIONS.regatta).toContain('How were my starts across the regatta?');
    expect(askPanelHtml('regatta')).toContain('questions about this regatta');
    expect(race).toContain(`maxlength="${QUESTION_MAX}"`);
    expect(race).toContain(`0/${QUESTION_MAX}`);
    expect(race).toContain('aria-live="polite"');
    expect(race).toContain('data-ask-stop hidden');
    expect(race).toContain(ASK_NOTE.replace(/'/g, '&#39;'));
    expect(race).toMatch(/<label class="vh" for="coach-ask-q">/);
  });

  it('model text is plain: escaped, bullets and line breaks only', () => {
    const html = answerHtml('**Start** cost you ≈ 29 s.\n\n- Late: <b>+12 s</b>\n• 2 tacks\n1. Foot first\n## Heading\n<script>alert(1)</script> & done');
    expect(html).toBe(
      '<p>Start cost you ≈ 29 s.</p><ul><li>Late: &lt;b&gt;+12 s&lt;/b&gt;</li><li>2 tacks</li><li>Foot first</li></ul><p>Heading</p><p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; done</p>',
    );
    expect(answerHtml('')).toBe('');
  });

  it('the log: question, answer, a cursor while streaming, the questions left', () => {
    const s: AskPanelState = { avail: { enabled: true, limits: STATUS_ON.limits }, key: 'k', busy: true, remaining: 3, turns: [{ q: 'Why <slow>?', a: '', state: 'streaming' }] };
    const html = askLogHtml(s);
    expect(html).toContain('Why &lt;slow&gt;?');
    expect(html).toContain('Coach is thinking…');
    expect(html).toContain('ask-cursor');
    expect(leftText(3)).toBe('3 questions left in this chat');
    expect(leftText(1)).toBe('1 question left in this chat');
    expect(leftText(0)).toBe('No questions left in this chat');
    expect(leftText(null)).toBe('');
  });

  it('chat ids are random and URL-safe', () => {
    const a = newSessionId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(newSessionId()).not.toBe(a);
  });
});
