/** Types for scripts/usage-report.mjs (the tests import its pure helpers). */
export interface Args {
  day: string | null;
  tz: string;
  dataset: string;
  sql: boolean;
  help: boolean;
}
export interface SessionRow {
  session: string;
  event: string;
  device?: string;
  referrer?: string;
  /** Rows Analytics Engine kept (count()); a bounce is a session that kept one. */
  kept?: number | string;
  n: number | string;
}
export interface Summary {
  sessions: number;
  bounced: number;
  bounceRate: number;
  funnel: { step: string; sessions: number; any: number }[];
  devices: [string, number][];
  referrers: [string, number][];
}
export type ReportSql = Record<'sessionCount' | 'sessions' | 'events' | 'races' | 'regattas' | 'signedIn', string>;

export const DEFAULT_DATASET: string;
export const DEFAULT_TZ: string;
export const DATASET_RE: RegExp;
export const DAY_RE: RegExp;
export const FUNNEL: string[];
export const TOP: number;
export const SESSION_ROWS_MAX: number;
export function parseArgs(argv: string[]): Args;
export function zoneOffsetMs(ms: number, tz: string): number;
export function yesterday(now: number, tz: string): string;
export function dayRange(day: string, tz: string): { from: string; to: string };
export function reportSql(o: { day: string; tz?: string; dataset?: string }): ReportSql;
export function summarize(rows: readonly SessionRow[], distinct?: number | string | null): Summary;
export function formatReport(o: {
  day: string;
  tz: string;
  summary: Summary;
  events: { event: string; detail?: string; n: number | string }[];
  races: { event_id: string; race: string; n: number | string }[];
  regattas: { event_id: string; n: number | string }[];
  signedIn: { signed_in: string; n: number | string }[];
}): string;
export function query(sql: string, o: { accountId: string; token: string; fetchImpl?: typeof fetch }): Promise<Record<string, unknown>[]>;
export function main(argv: string[], env?: Record<string, string | undefined>, o?: { log?: (s: string) => void; now?: number; fetchImpl?: typeof fetch }): Promise<void>;
