import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { telemetryUnavailable } from '../functions/_lib';
import { cachedJson } from '../src/data/cache';
import { HttpError, TelemetryUnavailableError, fromWire, isTelemetryUnavailable, retrySeconds, telemetryUnavailableFrom, toWire } from '../src/data/loadErrors';
import { isPaywallError } from '../src/data/paywall';
import { isTransientError } from '../src/ui/lastView';
import {
  EVENT_LOAD_FAILED,
  PAUSED_BODY,
  PAUSED_RETRY,
  PAUSED_TITLE,
  PAUSED_TRYING,
  RACE_LIST_FAILED,
  RACE_LOAD_FAILED,
  REOPEN_FAILED,
  classifyLoadError,
  createPausedCard,
  createRetryTimer,
  easternTime,
  pausedCardHtml,
  pausedContext,
  type PausedHost,
} from '../src/ui/telemetryUnavailable';

const TELE = '/api/telemetry/event/abcde12345?after=1792237111000&before=1792238500000&limit=100000&division=J70';
/** 12:10 p.m. EDT on a June Saturday. */
const GUN = Date.parse('2026-06-13T16:10:00Z');

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  warn.mockRestore();
});

/** What cachedJson throws for a response. */
async function thrown(res: Response, url = TELE): Promise<unknown> {
  vi.stubGlobal('fetch', (async () => res) as unknown as typeof fetch);
  try {
    await cachedJson(url, 0);
  } catch (e) {
    return e;
  }
  throw new Error('no error thrown');
}

describe('classifying a failed load', () => {
  it('the proxy’s 503 telemetry_unavailable: a TelemetryUnavailableError with its message and retryAfter, no URL', async () => {
    const e = await thrown(telemetryUnavailable());
    expect(e).toBeInstanceOf(TelemetryUnavailableError);
    expect(isTelemetryUnavailable(e)).toBe(true);
    expect((e as TelemetryUnavailableError).retryAfter).toBe(60);
    expect((e as Error).message).not.toMatch(/\/api\/|after=|503/);
    expect(classifyLoadError(e)).toBe('unavailable');
    // The URL went to the console instead.
    expect(String(warn.mock.calls[0]?.[0])).toContain(TELE);
  });

  it('Cloudflare’s plain-text 502 page: an HttpError whose message is the status alone', async () => {
    const e = await thrown(new Response('error code: 502', { status: 502, statusText: 'Bad Gateway' }));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(502);
    expect((e as Error).message).toBe('502 Bad Gateway');
    expect(classifyLoadError(e)).toBe('other');
    // Still read as transient (a reopen keeps the saved race, with Retry).
    expect(isTransientError((e as Error).message)).toBe(true);
  });

  it('some other 503 JSON is not the feed being unavailable', async () => {
    const e = await thrown(new Response('{"error":"auth_unavailable"}', { status: 503 }));
    expect(e).toBeInstanceOf(HttpError);
    expect(classifyLoadError(e)).toBe('other');
  });

  it('401 / 402 from the paywall still lock the race', async () => {
    for (const [status, statusText] of [
      [401, 'Unauthorized'],
      [402, 'Payment Required'],
      [401, ''],
    ] as const) {
      const e = await thrown(new Response('{"error":"sign_in_required"}', { status, statusText }));
      expect((e as Error).message).not.toContain('/api/');
      expect(isPaywallError((e as Error).message)).toBe(true);
      expect(classifyLoadError(e)).toBe('paywall');
    }
    expect(isPaywallError(new HttpError(404, 'Not Found').message)).toBe(false);
  });

  it('reads the body leniently: a bad retryAfter is a minute', () => {
    expect(telemetryUnavailableFrom({ error: 'telemetry_unavailable', message: 'Paused.', retryAfter: 120 })?.retryAfter).toBe(120);
    expect(telemetryUnavailableFrom({ error: 'telemetry_unavailable' })?.retryAfter).toBe(60);
    expect(telemetryUnavailableFrom({ error: 'Upstream 401' })).toBeNull();
    expect(telemetryUnavailableFrom('error code: 502')).toBeNull();
    expect(retrySeconds(-5)).toBe(60);
    expect(retrySeconds('90')).toBe(90);
    expect(retrySeconds(1e9)).toBe(60);
  });

  it('survives the worker boundary (postMessage keeps plain data only)', () => {
    const back = fromWire(structuredClone(toWire(new TelemetryUnavailableError('Paused.', 90))));
    expect(back).toBeInstanceOf(TelemetryUnavailableError);
    expect((back as TelemetryUnavailableError).retryAfter).toBe(90);
    const plain = fromWire(structuredClone(toWire(new HttpError(402, 'Payment Required'))));
    expect(plain).not.toBeInstanceOf(TelemetryUnavailableError);
    expect(classifyLoadError(plain)).toBe('paywall');
  });

  it('the page’s words for other failures carry no URL, query or status', () => {
    for (const m of [RACE_LOAD_FAILED, EVENT_LOAD_FAILED, RACE_LIST_FAILED, REOPEN_FAILED]) {
      expect(m).not.toMatch(/\/api\/|\?after=|\d{3}|undefined/);
    }
    expect(RACE_LOAD_FAILED).toBe("Couldn't load that race. Try again.");
  });
});

describe('the paused card', () => {
  it('headline, body, icon and Try again; nothing technical', () => {
    const html = pausedCardHtml({ key: 'k', eventName: 'ClubSwan 28 Gold Cup 2026', raceName: 'Race 1', gunMs: GUN });
    expect(html).toContain(PAUSED_TITLE);
    expect(PAUSED_TITLE).toBe('Live tracks are paused');
    expect(html).toContain(PAUSED_BODY.replace("'", '&#39;'));
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-labelledby="paused-title"');
    expect(html).toContain('id="paused-title"');
    expect(html).toMatch(new RegExp(`<button type="button"[^>]*data-paused="retry"[^>]*>${PAUSED_RETRY}</button>`));
    expect(html).toContain('ClubSwan 28 Gold Cup 2026 · Race 1 · Gun 12:10 p.m. ET');
    expect(html).not.toMatch(/\/api\/|after=|\b(401|502|503)\b|error|failed|undefined|⚠|🔒/i);
    expect(html).not.toContain('notice');
  });

  it('escapes the event name', () => {
    expect(pausedCardHtml({ key: 'k', eventName: '<b>Cup</b>' })).toContain('&lt;b&gt;Cup&lt;/b&gt;');
  });

  it('the gun on the Eastern clock, 12-hour with a.m. / p.m.', () => {
    expect(easternTime(GUN)).toBe('12:10 p.m. ET');
    expect(easternTime(Date.parse('2026-01-10T14:05:00Z'))).toBe('9:05 a.m. ET');
    expect(easternTime(Date.parse('2026-07-01T04:00:00Z'))).toBe('12:00 a.m. ET');
  });

  it('leaves out what isn’t known, with no stray dots', () => {
    expect(pausedContext({ eventName: 'Cup', raceName: 'Race 2', gunMs: GUN })).toBe('Cup · Race 2 · Gun 12:10 p.m. ET');
    expect(pausedContext({ eventName: 'Cup', raceName: null, gunMs: GUN })).toBe('Cup · Gun 12:10 p.m. ET');
    expect(pausedContext({ eventName: null, raceName: 'Race 2' })).toBe('Race 2');
    expect(pausedContext({ eventName: ' ', raceName: undefined, gunMs: NaN })).toBe('');
    const bare = pausedCardHtml({ key: 'k' });
    expect(bare).not.toContain('paused-context');
    expect(bare).not.toMatch(/·|undefined|null|NaN/);
  });
});

/** An element stub: innerHTML, hidden, one click listener and the hint. */
function host(): PausedHost & { click(target?: unknown): void; hint: { textContent: string | null } } {
  let listener: ((ev: { target: unknown }) => void) | null = null;
  const hint = { textContent: '' as string | null };
  return {
    innerHTML: '',
    hidden: true,
    hint,
    addEventListener: (_t, fn) => void (listener = fn),
    querySelector: (sel) => (sel === '.paused-hint' ? hint : null),
    click(target = { closest: (s: string) => (s === '[data-paused="retry"]' ? {} : null) }) {
      listener?.({ target });
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('trying again', () => {
  it('the retry timer: one at a time, cleared when asked', () => {
    vi.useFakeTimers();
    const t = createRetryTimer();
    const run = vi.fn();
    t.arm(run);
    t.arm(run);
    t.arm(run, 60);
    vi.advanceTimersByTime(59_999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(t.armed()).toBe(false);
    t.arm(run, 30);
    t.clear();
    vi.advanceTimersByTime(120_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('Try again calls the retry once, and shows a quiet hint while it runs', async () => {
    vi.useFakeTimers();
    const h = host();
    let finish: () => void = () => undefined;
    const retry = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const card = createPausedCard(h, retry);
    card.show({ key: 'e|J70|1', raceName: 'Race 1' });
    expect(h.hidden).toBe(false);
    expect(h.innerHTML).toContain(PAUSED_TITLE);
    h.click();
    h.click(); // a second press while it runs does nothing
    expect(retry).toHaveBeenCalledTimes(1);
    expect(h.hint.textContent).toBe(PAUSED_TRYING);
    // A click anywhere else in the card isn't Try again.
    h.click({ closest: () => null });
    expect(retry).toHaveBeenCalledTimes(1);
    // Still paused: the page shows it again (same race, same card), hint cleared, timer armed again.
    const before = h.innerHTML;
    card.show({ key: 'e|J70|1', raceName: 'Race 1' });
    expect(h.innerHTML).toBe(before);
    expect(h.hint.textContent).toBe('');
    finish();
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('retries on its own at retryAfter (else a minute), never piling up', async () => {
    vi.useFakeTimers();
    const h = host();
    const retry = vi.fn(async () => undefined);
    const card = createPausedCard(h, retry);
    card.show({ key: 'a' }, 90);
    card.show({ key: 'a' }, 90);
    vi.advanceTimersByTime(89_999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    // The retry ended with neither show nor hide: armed again, once.
    await flush();
    vi.advanceTimersByTime(90_000);
    expect(retry).toHaveBeenCalledTimes(2);
    await flush();
    card.show({ key: 'a' });
    vi.advanceTimersByTime(60_000);
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it('hide (loaded, or another race or event) clears the timer', () => {
    vi.useFakeTimers();
    const h = host();
    const retry = vi.fn(async () => undefined);
    const card = createPausedCard(h, retry);
    card.show({ key: 'a' });
    card.hide();
    expect(h.hidden).toBe(true);
    expect(card.key()).toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(retry).not.toHaveBeenCalled();
    h.click();
    expect(retry).not.toHaveBeenCalled();
  });

  it('another race redraws the card; a background tab waits another round', () => {
    vi.useFakeTimers();
    const h = host();
    let hidden = true;
    const retry = vi.fn(async () => undefined);
    const card = createPausedCard(h, retry, { hidden: () => hidden });
    card.show({ key: 'a', raceName: 'Race 1' });
    card.show({ key: 'b', raceName: 'Race 2' });
    expect(card.key()).toBe('b');
    expect(h.innerHTML).toContain('Race 2');
    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
    hidden = false;
    vi.advanceTimersByTime(60_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
