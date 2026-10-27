/**
 * Recent problems, for the Feedback sheet: the last 20 console errors, uncaught errors, unhandled
 * rejections and failed /api calls (method, path, status, time), in memory only. Installed first thing in
 * main.ts. Never request or response bodies, cookies or headers; query values are dropped and long
 * token-like runs masked.
 */

export type ProblemKind = 'console' | 'error' | 'rejection' | 'api';

export interface Problem {
  kind: ProblemKind;
  /** ISO time. */
  at: string;
  text: string;
}

export const PROBLEMS_MAX = 20;
export const PROBLEM_TEXT_MAX = 300;

/** Long runs that could be a token or a key, masked. */
export const scrub = (s: string): string =>
  s
    .replace(/[A-Za-z0-9_-]{32,}/g, '…')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, PROBLEM_TEXT_MAX);

export interface ProblemLog {
  add(kind: ProblemKind, text: string, at?: Date): void;
  list(): Problem[];
  clear(): void;
}

export function createProblemLog(max = PROBLEMS_MAX): ProblemLog {
  const ring: Problem[] = [];
  return {
    add(kind, text, at = new Date()) {
      ring.push({ kind, at: at.toISOString(), text: scrub(text) });
      if (ring.length > max) ring.splice(0, ring.length - max);
    },
    list: () => ring.map((p) => ({ ...p })),
    clear: () => void (ring.length = 0),
  };
}

/** A same-origin /api URL as `path?names` (query values dropped); null for anything else. */
export function apiPath(input: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(input, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin || !u.pathname.startsWith('/api/')) return null;
  const keys = [...new Set([...u.searchParams.keys()])];
  return scrub(keys.length ? `${u.pathname}?${keys.join('&')}` : u.pathname);
}

const describe = (v: unknown): string => {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

export const problems = createProblemLog();
let installed = false;

/** Listen for errors and failed /api calls (once; browser only). */
export function installProblemLog(log: ProblemLog = problems): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  addEventListener('error', (ev: ErrorEvent) => {
    const where = ev.filename ? ` (${ev.filename.replace(location.origin, '')}:${ev.lineno})` : '';
    log.add('error', `${ev.error ? describe(ev.error) : ev.message}${where}`);
  });
  addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => log.add('rejection', describe(ev.reason)));
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      log.add('console', args.map(describe).join(' '));
    } catch {
      /* never break the console */
    }
    origError(...args);
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = apiPath(url, location.origin);
    try {
      const res = await origFetch(input, init);
      if (path && !res.ok) log.add('api', `${method} ${path} → ${res.status}`);
      return res;
    } catch (e) {
      // An abort is the app moving on, not a problem.
      if (path && !(e instanceof DOMException && e.name === 'AbortError')) log.add('api', `${method} ${path} → failed (${e instanceof Error ? e.name : 'error'})`);
      throw e;
    }
  };
}
