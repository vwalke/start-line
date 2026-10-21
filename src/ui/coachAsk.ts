/**
 * The Coach tab's Ask Coach panel (optional): a collapsible card under the cards, in both views,
 * shown only when GET /api/coach/status says the feature is on. Suggested questions as chips, a
 * 500-character box, the answer streamed in (plain text: escaped, line breaks and "- " bullets
 * only), Stop, the questions left, and the failures in words.
 *
 * The conversation belongs to what is on screen: a change of view, race, boat or peer group
 * (`setKey`) drops it, with a new chat id, so a new chat starts with the full question allowance.
 *
 * `createAskCoach` holds the state and talks to the server; it never touches the DOM (the app
 * renders `askPanelHtml` once per view and `askLogHtml` on every change), so it is tested as is.
 */
import type { AskContext } from '../analysis/coach/askContext';
import { askCoach, askStatus, type AskAvailability } from '../data/askCoach/api';
import { HISTORY_MAX, QUESTION_MAX, type AskIds, type AskTurn } from '../data/askCoach/protocol';
import type { CoachView } from './coach';
import { esc } from './format';

export const ASK_SUGGESTIONS: Record<CoachView, readonly string[]> = {
  race: ['What cost me the most this race?', 'Where did I gain?', 'How was my start?', 'What should I practice?'],
  regatta: ['How were my starts across the regatta?', 'What keeps costing me time?', 'Where did I gain?', 'What should I practice?'],
};

export const ASK_NOTE = "Answers use only Coach's numbers; AI can make mistakes.";

export interface AskTurnView {
  q: string;
  a: string;
  state: 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
  /** The answer hit the length cap. */
  cut?: boolean;
}

export interface AskPanelState {
  /** null until the status check is back. */
  avail: AskAvailability | null;
  key: string;
  turns: AskTurnView[];
  busy: boolean;
  /** Questions left in this chat (the server's word after each answer; the chat allowance before). */
  remaining: number | null;
}

export interface AskCoach {
  state(): AskPanelState;
  /** Is the feature on here? Asked once; later calls return the first answer. */
  check(): Promise<AskAvailability>;
  /** What is on screen; a different key ends the conversation. */
  setKey(key: string): void;
  ask(question: string, context: AskContext, ids: AskIds): Promise<void>;
  stop(): void;
}

/** A chat id: 24 random URL-safe characters. */
export function newSessionId(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The earlier messages to send: finished answers only, the last HISTORY_MAX. */
export function historyOf(turns: readonly AskTurnView[]): AskTurn[] {
  const out: AskTurn[] = [];
  for (const t of turns) {
    if ((t.state !== 'done' && t.state !== 'stopped') || !t.a.trim()) continue;
    out.push({ role: 'user', text: t.q }, { role: 'assistant', text: t.a });
  }
  return out.slice(-HISTORY_MAX);
}

export function createAskCoach(o: { render: (s: AskPanelState) => void; fetch?: typeof fetch; sessionId?: () => string }): AskCoach {
  const makeId = o.sessionId ?? newSessionId;
  const st: AskPanelState = { avail: null, key: '', turns: [], busy: false, remaining: null };
  let session = makeId();
  let inflight: AbortController | null = null;
  let checking: Promise<AskAvailability> | null = null;
  const render = (): void => o.render(st);
  const allowance = (): number | null => (st.avail?.enabled ? st.avail.limits.sessionMax : null);

  const stop = (): void => {
    inflight?.abort();
    inflight = null;
    const t = st.turns[st.turns.length - 1];
    if (t?.state === 'streaming') t.state = 'stopped';
    st.busy = false;
  };

  return {
    state: () => st,
    check() {
      checking ??= askStatus(o.fetch ?? fetch).then((a) => {
        st.avail = a;
        st.remaining ??= allowance();
        render();
        return a;
      });
      return checking;
    },
    setKey(key) {
      if (key === st.key) return;
      stop();
      st.key = key;
      st.turns = [];
      st.remaining = allowance();
      session = makeId();
      render();
    },
    async ask(question, context, ids) {
      const q = question.trim().slice(0, QUESTION_MAX);
      if (!q || st.busy || !st.avail?.enabled) return;
      const history = historyOf(st.turns);
      const turn: AskTurnView = { q, a: '', state: 'streaming' };
      st.turns.push(turn);
      st.busy = true;
      const ctl = new AbortController();
      inflight = ctl;
      const key = st.key;
      // A reset or stop while this runs: its callbacks fall silent.
      const live = (): boolean => inflight === ctl && st.key === key;
      render();
      await askCoach(
        { session, question: q, history, ids, context },
        {
          onMeta(n) {
            if (!live()) return;
            st.remaining = n;
            render();
          },
          onDelta(text) {
            if (!live()) return;
            turn.a += text;
            render();
          },
          onDone(d) {
            if (!live()) return;
            turn.state = 'done';
            turn.cut = d.stop === 'max_tokens';
            if (d.remaining != null) st.remaining = d.remaining;
          },
          onError(_code, message) {
            if (!live()) return;
            turn.state = 'error';
            turn.error = message;
            if (_code === 'rate-limited-session' || _code === 'rate-limited-daily' || _code === 'resting') st.remaining = 0;
          },
        },
        { signal: ctl.signal, fetch: o.fetch },
      );
      if (inflight === ctl) {
        inflight = null;
        st.busy = false;
        if (turn.state === 'streaming') turn.state = 'done';
        render();
      }
    },
    stop() {
      stop();
      render();
    },
  };
}

/** The panel shows only once the status check says the feature is on (a failed check: never), and with a boat to ask about. */
export const askPanelShown = (s: Pick<AskPanelState, 'avail'>, hasBoat: boolean): boolean => !!s.avail?.enabled && hasBoat;

// ---- HTML

/**
 * Model text as safe HTML: escaped, markdown emphasis and heading marks dropped, "- " / "• " / "* "
 * / "1." lines as a list, other lines as paragraphs. Nothing else is interpreted.
 */
export function answerHtml(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (list.length) out.push(`<ul>${list.map((x) => `<li>${x}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\*\*|__/g, '').replace(/^\s*#{1,6}\s+/, '').trimEnd();
    const m = /^\s*(?:[-•*]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (m) {
      list.push(esc(m[1]));
      continue;
    }
    flush();
    if (line.trim()) out.push(`<p>${esc(line.trim())}</p>`);
  }
  flush();
  return out.join('');
}

export const leftText = (n: number | null): string => (n == null ? '' : n <= 0 ? 'No questions left in this chat' : `${n} ${n === 1 ? 'question' : 'questions'} left in this chat`);

/** The panel's fixed part, for one view: heading, suggestions, the log's slot, the form, the note. */
export function askPanelHtml(view: CoachView, open = false): string {
  const chips = ASK_SUGGESTIONS[view].map((q) => `<li><button type="button" class="chip ask-sug" data-ask-suggest="${esc(q)}">${esc(q)}</button></li>`).join('');
  const what = view === 'regatta' ? 'this regatta' : 'this race';
  return `<details class="coach-ask-box"${open ? ' open' : ''}>
    <summary><h3 id="coach-ask-title">Ask Coach</h3><span class="muted ask-sub">questions about ${what}</span></summary>
    <ul class="chips ask-sugs" aria-label="Suggested questions">${chips}</ul>
    <div class="ask-log" data-ask-log aria-live="polite" aria-busy="false"></div>
    <form class="ask-form" data-ask-form>
      <label class="vh" for="coach-ask-q">Your question about ${what}</label>
      <textarea id="coach-ask-q" data-ask-q rows="2" maxlength="${QUESTION_MAX}" placeholder="Ask about ${what}…" aria-describedby="coach-ask-count"></textarea>
      <div class="ask-row">
        <span class="ask-count muted" id="coach-ask-count" data-ask-count>0/${QUESTION_MAX}</span>
        <span class="ask-left muted" data-ask-left></span>
        <button type="button" class="ask-stop" data-ask-stop hidden>Stop</button>
        <button type="submit" class="ask-send" data-ask-send>Ask</button>
      </div>
    </form>
    <p class="ask-note muted">${esc(ASK_NOTE)}</p>
  </details>`;
}

/** The conversation so far. */
export function askLogHtml(s: AskPanelState): string {
  return s.turns
    .map((t) => {
      const cursor = t.state === 'streaming' ? '<span class="ask-cursor" aria-hidden="true">▍</span>' : '';
      const waiting = t.state === 'streaming' && !t.a ? '<p class="muted">Coach is thinking…</p>' : '';
      const tail =
        t.state === 'stopped'
          ? '<p class="muted ask-end">Stopped.</p>'
          : t.cut
            ? '<p class="muted ask-end">(Answer cut short.)</p>'
            : '';
      const err = t.state === 'error' && t.error ? `<p class="ask-err" role="alert">${esc(t.error)}</p>` : '';
      return `<div class="ask-turn"><p class="ask-q"><span class="vh">You asked: </span>${esc(t.q)}</p><div class="ask-a"><span class="vh">Coach: </span>${waiting}${answerHtml(t.a)}${cursor}${tail}${err}</div></div>`;
    })
    .join('');
}
