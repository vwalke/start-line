/**
 * Sanity checks on a decoded boat-log payload, run by the Pages Function
 * before anything is stored (and by the client before it uploads, so a
 * user sees the same verdict without a round trip).
 */
import type { PayloadTrack } from './compact';

/** Ids that become R2 key parts: strict, so a key can never escape its prefix. */
export const EVENT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
/** Race id: today's RaceSense race numbers ("7") and future recovered races' ids. */
export const RACE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** Division name as the regatta document has it (it goes into the key base64url-encoded). */
export const DIV_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._+/&()'’,:#-]{0,63}$/u;
/** Base64url of the division name, as stored in keys and URLs. */
export const DIV_KEY_RE = /^[A-Za-z0-9_-]{1,88}$/;
export const SAIL_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,23}$/u;

/** Fastest plausible boat, m/s (≈ 49 kn); a step faster than this (plus GPS slack) is a jump. */
export const MAX_SPEED_MS = 25;
/** Metres of slack on each step before it counts as a jump. */
export const JUMP_SLACK_M = 10;
/** Jumps allowed: GPS glitches happen, a few per race. */
export const MAX_JUMP_FRAC = 0.001;
export const MAX_RATE_HZ = 20;
/** Payload span bounds: a race window is a few minutes to a few hours. */
export const MIN_SPAN_MS = 60_000;
export const MAX_SPAN_MS = 5 * 3_600_000;
/** Timer events / line pings kept in a payload. */
export const MAX_TIMERS = 200;
export const MAX_PINGS = 5_000;

export const EARLIEST_MS = Date.UTC(2015, 0, 1);

/** UTF-8 → base64url (no padding): a division name as one key segment. */
export function divKey(name: string): string {
  const b = new TextEncoder().encode(name);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function divFromKey(key: string): string | null {
  if (!DIV_KEY_RE.test(key)) return null;
  try {
    const s = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

const metres = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * 6_371_000;
};

/** Problems with a decoded payload (empty = fine). `now` bounds the timestamps. */
export function payloadProblems(p: PayloadTrack, now = Date.now()): string[] {
  const h = p.header;
  const out: string[] = [];
  if (!EVENT_ID_RE.test(String(h.event))) out.push('bad event id');
  if (typeof h.div !== 'string' || !DIV_NAME_RE.test(h.div)) out.push('bad division');
  if (!RACE_ID_RE.test(String(h.race))) out.push('bad race id');
  if (!Number.isInteger(h.sn) || h.sn < 1 || h.sn > 0xffffffff) out.push('bad device serial');
  if (typeof h.sail !== 'string' || !SAIL_RE.test(h.sail)) out.push('bad sail number');
  if (h.name != null && (typeof h.name !== 'string' || h.name.length > 64)) out.push('bad boat name');
  if (typeof h.srcSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(h.srcSha256)) out.push('bad source hash');
  if (!Number.isFinite(h.srcBytes) || h.srcBytes < 0) out.push('bad source size');
  if (!(h.rateHz > 0 && h.rateHz <= MAX_RATE_HZ)) out.push('bad logging rate');
  if (out.length) return out;

  const n = p.t.length;
  if (n !== h.n) out.push('sample count differs from the header');
  const t0 = p.t[0];
  const t1 = p.t[n - 1];
  if (t0 !== h.t0 || t1 !== h.t1) out.push('time span differs from the header');
  if (t0 < EARLIEST_MS || t1 > now + 86_400_000) out.push('timestamps out of range');
  const span = t1 - t0;
  if (span < MIN_SPAN_MS) out.push('too short to be a race');
  if (span > MAX_SPAN_MS) out.push('longer than any race window');
  if (!(h.gunMs >= t0 - 3_600_000 && h.gunMs <= t1)) out.push('the gun is not inside the window');
  if (out.length) return out;

  let jumps = 0;
  for (let k = 0; k < n; k++) {
    if (k && !(p.t[k] > p.t[k - 1])) {
      out.push('timestamps not increasing');
      break;
    }
    const la = p.lat[k];
    const lo = p.lon[k];
    if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180) || (la === 0 && lo === 0)) {
      out.push('position out of range');
      break;
    }
    if (!(p.sog[k] >= 0 && p.sog[k] <= MAX_SPEED_MS * (3600 / 1852))) {
      out.push('speed over ground out of range');
      break;
    }
    if (k) {
      const dt = (p.t[k] - p.t[k - 1]) / 1000;
      if (metres(p.lat[k - 1], p.lon[k - 1], la, lo) > MAX_SPEED_MS * dt + JUMP_SLACK_M) jumps++;
    }
  }
  if (jumps > Math.max(3, n * MAX_JUMP_FRAC)) out.push(`${jumps} position jumps faster than ${MAX_SPEED_MS} m/s`);
  const rate = (n - 1) / Math.max(span / 1000, 1e-9);
  if (rate > MAX_RATE_HZ * 1.05) out.push(`sample rate ${rate.toFixed(1)} Hz is over ${MAX_RATE_HZ} Hz`);
  // Gaps make the mean rate lower than the logging rate, never much higher.
  if (rate > h.rateHz * 1.5 + 1) out.push('sample rate differs from the header');

  if (!Array.isArray(h.timers) || h.timers.length > MAX_TIMERS) out.push('bad timer events');
  else if (h.timers.some((e) => !Number.isFinite(e?.t) || !Number.isInteger(e.type) || !Number.isFinite(e.value) || e.t < t0 - 3_600_000 || e.t > t1 + 3_600_000)) {
    out.push('bad timer events');
  }
  if (!Array.isArray(h.pings) || h.pings.length > MAX_PINGS) out.push('bad line pings');
  else if (h.pings.some((e) => !Number.isFinite(e?.t) || !(e.end === 0 || e.end === 1) || !(Math.abs(e.lat) <= 90) || !(Math.abs(e.lon) <= 180))) {
    out.push('bad line pings');
  }
  if (h.declinationRad != null && !(Math.abs(h.declinationRad) <= Math.PI)) out.push('bad declination');
  return out;
}
