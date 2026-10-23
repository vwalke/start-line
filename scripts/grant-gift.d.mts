/** Types for scripts/grant-gift.mjs (the tests import its pure helpers). */
export type GiftScope = 'season' | 'regatta';
export type Parsed =
  | { cmd: 'help' }
  | { cmd: 'list'; db: string; target: 'remote' | 'local'; print: boolean; email: string | null }
  | { cmd: 'revoke'; db: string; target: 'remote' | 'local'; print: boolean; id: string; email?: string; scope?: GiftScope; eventId?: string | null }
  | { cmd: 'grant'; db: string; target: 'remote' | 'local'; print: boolean; id: string; email: string; scope: GiftScope; eventId: string | null; expiresAt: number | null; note: string | null };

export const EMAIL_RE: RegExp;
export const EVENT_ID_RE: RegExp;
export const DB_RE: RegExp;
export const GIFT_ID_RE: RegExp;
export const DEFAULT_DB: string;
export function normEmail(e: string): string;
export function checkEmail(raw: unknown): string;
export function expiryMs(raw: unknown, now: number): number;
export function giftKey(email: string, scope: GiftScope, eventId: string | null): string;
export function giftId(email: string, scope: GiftScope, eventId: string | null): string;
export function sqlString(s: unknown): string;
export function grantSql(o: { email: string; scope: GiftScope; eventId?: string | null; expiresAt?: number | null; now: number; userId?: string }): string;
export function revokeSql(o: { id: string; now: number }): string;
export function listSql(o?: { email?: string | null }): string;
export function parseArgs(argv: string[], now?: number): Parsed;
export function sqlFor(p: Exclude<Parsed, { cmd: 'help' }>, now?: number, userId?: string): string;
export function wranglerArgs(p: { db: string; target: 'remote' | 'local' }, sql: string): string[];
