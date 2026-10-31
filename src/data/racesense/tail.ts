/**
 * A race in progress, refreshed each minute (ui/live.ts): only the new end of its telemetry is fetched and joined to
 * the pages already held (worker.ts), rather than the whole window again. The tail starts TAIL_OVERLAP_MS before the
 * last fix held, floored to a TAIL_BUCKET_MS boundary so pages open at the same minute share the edge cache's key;
 * rows already held are left out of it, so the joined pages read (parseTelemetry) as one fetch of the whole window.
 */
import type { TelemetryPage } from './types';

/** Fixes uploaded a little late (a tracker catching up) are still picked up within this much of the last one held, ms. */
export const TAIL_OVERLAP_MS = 5 * 60_000;
/** A tail's start is floored to this, ms. */
export const TAIL_BUCKET_MS = 60_000;

export interface Window {
  after: number;
  before: number;
}

/** The latest fix time in the pages, or null with none. */
export function pagesLastTs(pages: readonly TelemetryPage[]): number | null {
  let last: number | null = null;
  for (const p of pages) {
    if (!p?.Fields || !p.Rows) continue;
    const ts = p.Fields.indexOf('ts');
    if (ts < 0) continue;
    for (const r of p.Rows) {
      const t = Number(r[ts]);
      if (Number.isFinite(t) && (last == null || t > last)) last = t;
    }
  }
  return last;
}

/** Where a tail fetch starts: TAIL_OVERLAP_MS before `lastTs`, floored to the bucket, never before the window's start. */
export function tailAfter(lastTs: number | null, win: Window): number {
  if (lastTs == null) return win.after;
  return Math.max(win.after, Math.floor((lastTs - TAIL_OVERLAP_MS) / TAIL_BUCKET_MS) * TAIL_BUCKET_MS);
}

/**
 * Whether pages held for window `held` can be topped up with a tail for `win`: the same start (the gun hasn't moved)
 * and an end no earlier (a first finish shortens a race's window: then it is fetched whole again).
 */
export const canTail = (held: Window, win: Window): boolean => held.after === win.after && win.before >= held.before;

const rowKey = (sn: unknown, role: unknown, ts: unknown): string => `${Number(sn)}|${String(role ?? '')}|${Number(ts)}`;

/**
 * The held pages with a tail's (fetched from `from`) joined on: the tail's rows already held (the overlap, keyed as
 * parseTelemetry keys them) are dropped, so memory doesn't grow by the overlap each minute.
 */
export function joinTail(held: readonly TelemetryPage[], tail: readonly TelemetryPage[], from: number): TelemetryPage[] {
  const seen = new Set<string>();
  for (const p of held) {
    if (!p?.Fields || !p.Rows) continue;
    const [ts, sn, role] = ['ts', 'sn', 'role'].map((n) => p.Fields!.indexOf(n));
    if (ts < 0) continue;
    for (const r of p.Rows) if (Number(r[ts]) > from) seen.add(rowKey(r[sn], r[role], r[ts]));
  }
  const out = held.slice();
  for (const p of tail) {
    if (!p?.Fields || !p.Rows) continue;
    const [ts, sn, role] = ['ts', 'sn', 'role'].map((n) => p.Fields!.indexOf(n));
    const rows = ts < 0 ? p.Rows : p.Rows.filter((r) => !seen.has(rowKey(r[sn], r[role], r[ts])));
    if (rows.length) out.push({ Fields: p.Fields, Rows: rows });
  }
  return out;
}
