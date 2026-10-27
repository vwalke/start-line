/** Types for scripts/feedback.mjs (the tests import its pure helpers). */
type Common = { db: string; target: 'remote' | 'local'; print: boolean };
export type Parsed =
  | { cmd: 'help' }
  | (Common & { cmd: 'list'; limit: number; since: number | null; type: string | null })
  | (Common & { cmd: 'show'; id: string });

export const DB_RE: RegExp;
export const ID_RE: RegExp;
export const DATE_RE: RegExp;
export const TYPES: string[];
export const DEFAULT_DB: string;
export const DEFAULT_LIMIT: number;
export const MAX_LIMIT: number;
export function sinceMs(raw: unknown): number;
export function listSql(o: { limit?: number; since?: number | null; type?: string | null }): string;
export function showSql(o: { id: string }): string;
export function parseArgs(argv: string[]): Parsed;
export function sqlFor(p: Exclude<Parsed, { cmd: 'help' }>): string;
export function wranglerArgs(p: { db: string; target: 'remote' | 'local' }, sql: string): string[];
export function rowsOf(stdout: string): Record<string, unknown>[];
export function formatShow(row: Record<string, unknown> | undefined): string;
