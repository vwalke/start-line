/**
 * Ask Coach's wire contract, shared by the browser (api.ts) and the Pages Functions
 * (functions/_askCoach.ts).
 *
 *   GET  /api/coach/status → AskStatus
 *   POST /api/coach/ask    ← AskRequest (JSON)
 *                          → 200 text/event-stream of AskStreamEvent frames, or a JSON AskFailure
 *
 * Stream events (`event:` name, JSON `data`):
 *   meta  { remaining }                          once, first
 *   delta { text }                               answer text, in order
 *   done  { stop, usage, remaining }             the answer is complete
 *   error { error, message }                     the answer stopped early (an upstream failure)
 */
import type { AskContext } from '../../analysis/coach/askContext';

/** Questions longer than this are refused, characters. */
export const QUESTION_MAX = 500;
/** Earlier messages sent with a question (user and assistant each count one): the last few only. */
export const HISTORY_MAX = 6;
/** Each earlier message is clamped to this, characters. */
export const HISTORY_TEXT_MAX = 2000;
/** The client's chat id: random, URL-safe. */
export const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface AskLimits {
  sessionMax: number;
  dailyMax: number;
  questionMax: number;
  historyMax: number;
}

export interface AskStatus {
  ok: true;
  enabled: boolean;
  limits: AskLimits;
}

export interface AskTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Which race and boat the question is about (as the URL names them). */
export interface AskIds {
  event?: string;
  div?: string;
  race?: string;
  sail?: string;
  group?: string;
  view?: 'race' | 'regatta';
}

export interface AskRequest {
  session: string;
  question: string;
  history?: AskTurn[];
  ids?: AskIds;
  context: AskContext;
}

export type AskErrorCode =
  | 'not-configured'
  | 'bad-request'
  | 'too-long'
  | 'rate-limited-session'
  | 'rate-limited-daily'
  | 'resting'
  | 'busy'
  | 'upstream'
  | 'timeout';

export interface AskFailure {
  ok: false;
  error: AskErrorCode;
  message: string;
}

export interface AskUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type AskStreamEvent =
  | { event: 'meta'; data: { remaining: number } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: { stop: string | null; usage: AskUsage; remaining: number } }
  | { event: 'error'; data: { error: AskErrorCode; message: string } };

/** What the panel says for each failure. */
export const ASK_MESSAGES: Record<AskErrorCode, string> = {
  'not-configured': 'Ask Coach is not set up on this site.',
  'bad-request': "Coach couldn't read that question. Try asking again.",
  'too-long': `Questions can be up to ${QUESTION_MAX} characters.`,
  'rate-limited-session': "That's all the questions for this chat. Change race, boat or view to start a new one.",
  'rate-limited-daily': "You've asked the most questions for today. Try again tomorrow.",
  resting: 'Ask Coach is resting for today. Try again tomorrow.',
  busy: 'Coach is busy right now. Try again in a minute.',
  upstream: "Coach couldn't answer just now. Try again in a minute.",
  timeout: 'Coach took too long to answer. Try again.',
};
