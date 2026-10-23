/** Types for scripts/sessions.mjs (the tests import its pure helpers). */
type Common = { db: string; target: 'remote' | 'local'; print: boolean; email: string };
export type Parsed =
  | { cmd: 'help' }
  | (Common & { cmd: 'list' })
  | (Common & { cmd: 'set-cap'; cap: number | null })
  | (Common & { cmd: 'revoke'; id: string | null });

export const EMAIL_RE: RegExp;
export const PUBLIC_ID_RE: RegExp;
export const DB_RE: RegExp;
export const DEFAULT_DB: string;
export const MIN_CAP: number;
export const MAX_CAP: number;
export function normEmail(e: string): string;
export function checkEmail(raw: unknown): string;
export function checkCap(raw: unknown): number | null;
export function sqlString(s: unknown): string;
export function listSql(o: { email: string }): string;
export function setCapSql(o: { email: string; cap: number | null }): string;
export function revokeSql(o: { email: string; id?: string | null; now: number }): string;
export function parseArgs(argv: string[]): Parsed;
export function sqlFor(p: Exclude<Parsed, { cmd: 'help' }>, now?: number): string;
export function wranglerArgs(p: { db: string; target: 'remote' | 'local' }, sql: string): string[];
