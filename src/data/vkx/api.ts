/**
 * Browser side of the boat-log upload API (functions/api/vkx/*), and the
 * delete tokens this browser holds for its own uploads (localStorage).
 */

export const VKX_BASE = '/api/vkx';
const TOKENS_KEY = 'recall.vkxTokens';

/** One upload as GET /api/vkx/list returns it. */
export interface UploadItem {
  race: string;
  sn: number;
  sail: string;
  name: string;
  rateHz: number;
  n: number;
  t0: number;
  t1: number;
  gunMs: number;
  uploadedAt: number;
  size: number;
  sha: string;
  url: string;
}

export type ListResult = { ok: true; uploads: UploadItem[] } | { ok: false; why: string };

/** Why the feature is off, in a few words, from an HTTP status / body. */
function unavailableWhy(status: number, body: unknown): string {
  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err === 'string' && err) return err;
  if (status === 404) return 'This copy of Recall has no upload service (e.g. running without its server functions)';
  return `The upload service answered ${status}`;
}

/** No R2 binding (or no functions): probe once per session so every race load doesn't 503 the console. */
let sessionOff: ListResult | null = null;

const isNoStorage = (status: number, body: unknown): boolean => {
  const code = (body as { code?: unknown } | null)?.code;
  const err = (body as { error?: unknown } | null)?.error;
  return code === 'no-storage' || (status === 503 && typeof err === 'string' && /no storage bound|not set up/i.test(err));
};

/** Tests: forget a cached "uploads unavailable" so the next list is a real probe. */
export function resetVkxSession(): void {
  sessionOff = null;
}

/** The race's uploads; never throws (any failure is `ok: false` with a reason). */
export async function listUploads(event: string, div: string, race: string, opts: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<ListResult> {
  if (!opts.fresh && sessionOff) return sessionOff;
  // fresh=1 (after our own upload/removal) also skips the server's edge cache.
  const url = `${VKX_BASE}/list?${new URLSearchParams({ event, div, race, ...(opts.fresh ? { fresh: '1' } : {}) })}`;
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, why: "You're offline" };
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: opts.signal, ...(opts.fresh ? { cache: 'reload' as const } : {}) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* an HTML 404 page: no functions */
    }
    if (!res.ok || !body || (body as { ok?: unknown }).ok !== true || !Array.isArray((body as { uploads?: unknown }).uploads)) {
      const status = res.ok ? 404 : res.status;
      const out: ListResult = { ok: false, why: unavailableWhy(status, res.ok ? null : body) };
      // Binding missing or no functions: remember it so later races don't probe again.
      if (isNoStorage(status, body) || status === 404) sessionOff = out;
      return out;
    }
    sessionOff = null;
    return { ok: true, uploads: (body as { uploads: UploadItem[] }).uploads };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return { ok: false, why: "Couldn't reach the upload service" };
  }
}

/** An upload's payload bytes (immutable URL: the browser caches it). */
export async function fetchUpload(item: UploadItem, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(item.url, { signal });
  if (!res.ok) throw new Error(`${res.status} for ${item.sail}'s boat log`);
  return res.arrayBuffer();
}

export interface UploadOk {
  ok: true;
  race: string;
  sn: number;
  sail: string;
  sha: string;
  size: number;
  uploadedAt: number;
  token: string;
  prevKept: boolean;
  url: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** POST one gzipped payload. Throws UploadError with the server's reason. */
export async function postUpload(bytes: Uint8Array, replaceToken?: string): Promise<UploadOk> {
  let res: Response;
  try {
    res = await fetch(`${VKX_BASE}/upload`, {
      method: 'POST',
      body: bytes as BodyInit,
      headers: { 'content-type': 'application/octet-stream', ...(replaceToken ? { 'x-replace-token': replaceToken } : {}) },
    });
  } catch {
    throw new UploadError("Couldn't reach the upload service", 0);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!res.ok || body.ok !== true) throw new UploadError(String(body.error ?? `Upload failed (${res.status})`), res.status, typeof body.code === 'string' ? body.code : undefined);
  return body as unknown as UploadOk;
}

export interface UploadKey {
  event: string;
  div: string;
  race: string;
  sn: number;
}

/** Remove an upload with its token. Throws UploadError. */
export async function deleteUpload(k: UploadKey, token: string): Promise<{ restored: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${VKX_BASE}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...k, token }) });
  } catch {
    throw new UploadError("Couldn't reach the upload service", 0);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok !== true) throw new UploadError(String(body.error ?? `Remove failed (${res.status})`), res.status);
  return { restored: !!body.restored };
}

// ---- delete tokens (this browser's own uploads)

export interface HeldToken {
  token: string;
  sha: string;
  at: number;
}

const tokenKey = (k: UploadKey): string => `${k.event}|${k.div}|${k.race}|${k.sn}`;

function readTokens(): Record<string, HeldToken[]> {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === 'object' ? (v as Record<string, HeldToken[]>) : {};
  } catch {
    return {};
  }
}

function writeTokens(all: Record<string, HeldToken[]>): void {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(all));
  } catch {
    /* storage full or disabled: the upload stands, it just can't be removed from here */
  }
}

/** Tokens held for an upload slot, newest first (an older one may still delete a kept `.prev`). */
export function heldTokens(k: UploadKey): HeldToken[] {
  const v = readTokens()[tokenKey(k)];
  return Array.isArray(v) ? v.filter((x) => typeof x?.token === 'string') : [];
}

export function rememberToken(k: UploadKey, t: HeldToken): void {
  const all = readTokens();
  all[tokenKey(k)] = [t, ...(all[tokenKey(k)] ?? []).filter((x) => x.token !== t.token)].slice(0, 4);
  writeTokens(all);
}

export function forgetToken(k: UploadKey, token: string): void {
  const all = readTokens();
  const left = (all[tokenKey(k)] ?? []).filter((x) => x.token !== token);
  if (left.length) all[tokenKey(k)] = left;
  else delete all[tokenKey(k)];
  writeTokens(all);
}
