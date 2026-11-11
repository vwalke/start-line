/**
 * The errors a failed data request throws (data/cache.ts), and how they cross the worker boundary.
 *
 * An HttpError's message is the status alone ("502 Bad Gateway"): never the URL or its query, so a message that
 * reaches the page can't leak one (the URL is logged where the request failed). The status stays first in the
 * message: isPaywallError (401 / 402) and isTransientError (5xx) read it there, also after a postMessage.
 *
 * The telemetry proxy answers 503 `{ error: 'telemetry_unavailable', message, retryAfter }` when the track feed
 * can't be reached (functions/_lib.ts telemetryUnavailable): a TelemetryUnavailableError, which the page shows as
 * "Live tracks are paused" (ui/telemetryUnavailable.ts) and tries again after `retryAfter` seconds.
 */

/** Seconds before trying again when the server didn't say. */
export const DEFAULT_RETRY_S = 60;

export class HttpError extends Error {
  constructor(readonly status: number, statusText = '') {
    super(`${status} ${statusText}`.trimEnd());
    this.name = 'HttpError';
  }
}

export class TelemetryUnavailableError extends Error {
  constructor(message: string, readonly retryAfter = DEFAULT_RETRY_S) {
    super(message);
    this.name = 'TelemetryUnavailableError';
  }
}

/** A 503 body from the telemetry proxy as a TelemetryUnavailableError, else null (any other body). */
export function telemetryUnavailableFrom(body: unknown): TelemetryUnavailableError | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as { error?: unknown; message?: unknown; retryAfter?: unknown };
  if (o.error !== 'telemetry_unavailable') return null;
  const message = typeof o.message === 'string' && o.message.trim() ? o.message.trim() : 'Track data is temporarily unavailable.';
  return new TelemetryUnavailableError(message, retrySeconds(o.retryAfter));
}

/** A sane retry delay in seconds: whole, 10 s to 10 min, else the default. */
export function retrySeconds(v: unknown): number {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 10 && n <= 600 ? Math.round(n) : DEFAULT_RETRY_S;
}

export const isTelemetryUnavailable = (e: unknown): e is TelemetryUnavailableError => e instanceof TelemetryUnavailableError;

/** What the worker posts for an error: its message, and the retry delay when it's the feed being unavailable. */
export interface WireError {
  message: string;
  unavailable?: { retryAfter: number };
}

export function toWire(err: unknown): WireError {
  if (isTelemetryUnavailable(err)) return { message: err.message, unavailable: { retryAfter: err.retryAfter } };
  return { message: err instanceof Error ? err.message : String(err) };
}

export function fromWire(w: WireError): Error {
  return w.unavailable ? new TelemetryUnavailableError(w.message, retrySeconds(w.unavailable.retryAfter)) : new Error(w.message);
}
