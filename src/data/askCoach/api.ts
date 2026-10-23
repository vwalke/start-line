/**
 * Browser side of Ask Coach (functions/api/coach/*): is it on here, and one question streamed back.
 * Never throws: every failure ends in `onError` with a code the panel words (protocol.ts).
 */
import { readSse } from './sse';
import { ASK_MESSAGES, type AskErrorCode, type AskLimits, type AskRequest, type AskUsage } from './protocol';

export const ASK_BASE = '/api/coach';

/** On, with its limits; or off (not configured, no functions here, or the check failed: the panel stays hidden). */
export type AskAvailability = { enabled: true; limits: AskLimits } | { enabled: false };

export async function askStatus(doFetch: typeof fetch = fetch): Promise<AskAvailability> {
  try {
    const res = await doFetch(`${ASK_BASE}/status`, { headers: { accept: 'application/json' } });
    if (!res.ok) return { enabled: false };
    const j = (await res.json()) as { ok?: unknown; enabled?: unknown; limits?: Partial<AskLimits> };
    if (j.ok !== true || j.enabled !== true || !j.limits) return { enabled: false };
    const n = (x: unknown, d: number): number => (typeof x === 'number' && x > 0 ? x : d);
    const l = j.limits;
    return { enabled: true, limits: { sessionMax: n(l.sessionMax, 10), dailyMax: n(l.dailyMax, 30), questionMax: n(l.questionMax, 500), historyMax: n(l.historyMax, 6) } };
  } catch {
    return { enabled: false };
  }
}

export interface AskHandlers {
  onMeta?(remaining: number): void;
  onDelta(text: string): void;
  onDone(d: { stop: string | null; usage: AskUsage | null; remaining: number | null }): void;
  onError(code: AskErrorCode, message: string): void;
}

const CODES = new Set<string>(Object.keys(ASK_MESSAGES));
const codeOf = (x: unknown, fallback: AskErrorCode): AskErrorCode => (typeof x === 'string' && CODES.has(x) ? (x as AskErrorCode) : fallback);

/** Ask one question; resolves when the answer (or the error) is complete. Aborting `signal` ends it quietly (no callback). */
export async function askCoach(req: AskRequest, h: AskHandlers, opts: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<void> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${ASK_BASE}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(req),
      signal: opts.signal,
    });
  } catch {
    if (!opts.signal?.aborted) h.onError('upstream', "Couldn't reach Coach. Check your connection and try again.");
    return;
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.startsWith('text/event-stream') || !res.body) {
    let body: { error?: unknown; message?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* not JSON */
    }
    const code = codeOf(body.error, res.status === 404 || res.status === 503 ? 'not-configured' : res.status === 401 || res.status === 402 ? 'locked' : res.status === 429 ? 'rate-limited-daily' : 'upstream');
    h.onError(code, ASK_MESSAGES[code]);
    return;
  }
  let finished = false;
  try {
    await readSse(res.body, (e) => {
      if (finished) return;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (e.event === 'meta' && typeof d.remaining === 'number') h.onMeta?.(d.remaining);
      else if (e.event === 'delta' && typeof d.text === 'string') h.onDelta(d.text);
      else if (e.event === 'done') {
        finished = true;
        h.onDone({
          stop: typeof d.stop === 'string' ? d.stop : null,
          usage: (d.usage as AskUsage | undefined) ?? null,
          remaining: typeof d.remaining === 'number' ? d.remaining : null,
        });
      } else if (e.event === 'error') {
        finished = true;
        const code = codeOf(d.error, 'upstream');
        h.onError(code, ASK_MESSAGES[code]);
      }
    });
  } catch {
    if (opts.signal?.aborted) return;
    if (!finished) {
      finished = true;
      h.onError('upstream', 'The answer was cut off. Try again.');
    }
    return;
  }
  if (!finished && !opts.signal?.aborted) h.onError('upstream', 'The answer was cut off. Try again.');
}
