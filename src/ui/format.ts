import { compassRound } from '../analysis/geo';

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const f0 = (x: number | null | undefined): string => (x == null || !Number.isFinite(x) ? '—' : Math.round(x).toString());
export const f1 = (x: number | null | undefined): string => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(1));
export const f2 = (x: number | null | undefined): string => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(2));

/** Whole compass degrees, never 360°. */
export const degLabel = (x: number | null | undefined): string =>
  x == null || !Number.isFinite(x) ? '—' : `${compassRound(x)}°`;

/** Signed TWA as S37° / P28°. */
export const twaLabel = (twa: number | null | undefined): string =>
  twa == null || !Number.isFinite(twa) ? '—' : `${twa >= 0 ? 'S' : 'P'}${Math.round(Math.abs(twa))}°`;

export function duration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r === 60 ? `${m + 1}:00` : `${m}:${String(r).padStart(2, '0')}`;
}

export function tzLabel(offsetMs: number): string {
  const h = offsetMs / 3_600_000;
  if (!h) return 'UTC';
  const sign = h > 0 ? '+' : '−';
  const abs = Math.abs(h);
  return `UTC${sign}${Number.isInteger(abs) ? abs : abs.toFixed(1)}`;
}

/** Clock time at a given UTC offset (from a milliseconds-since-epoch instant). */
export function localTime(ms: number | null, offsetMs: number): string {
  if (ms == null) return '—';
  return new Date(ms + offsetMs).toISOString().slice(11, 19);
}

export function localDate(ms: number, offsetMs: number): string {
  return new Date(ms + offsetMs).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Viewer's UTC offset at `ms`, milliseconds east of UTC. */
export function viewerOffsetMs(ms: number): number {
  return -new Date(ms).getTimezoneOffset() * 60_000;
}

/**
 * Gun time for the header: venue clock first, labelled with its offset,
 * then the viewer's local clock when that differs.
 */
export function gunTimeLine(ms: number, venueOffsetMs: number, viewerOff = viewerOffsetMs(ms)): string {
  const venue = `${localDate(ms, venueOffsetMs)} ${localTime(ms, venueOffsetMs)} (venue ${tzLabel(venueOffsetMs)})`;
  if (viewerOff === venueOffsetMs) return `Gun ${venue}`;
  const sameDate = localDate(ms, viewerOff) === localDate(ms, venueOffsetMs);
  const viewerClock = sameDate ? localTime(ms, viewerOff) : `${localDate(ms, viewerOff)} ${localTime(ms, viewerOff)}`;
  return `Gun ${venue} · ${viewerClock} where you are (${tzLabel(viewerOff)})`;
}
