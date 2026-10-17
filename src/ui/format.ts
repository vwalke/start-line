export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const f0 = (x: number | null | undefined): string => (x == null || !Number.isFinite(x) ? '—' : Math.round(x).toString());
export const f1 = (x: number | null | undefined): string => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(1));
export const f2 = (x: number | null | undefined): string => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(2));

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

/** Venue-local clock time. */
export function localTime(ms: number | null, offsetMs: number): string {
  if (ms == null) return '—';
  return new Date(ms + offsetMs).toISOString().slice(11, 19);
}

export function localDate(ms: number, offsetMs: number): string {
  return new Date(ms + offsetMs).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
