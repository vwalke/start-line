/**
 * Merging an uploaded boat log into a race: the boat's public-feed fixes
 * inside the log's span are replaced by the log's (no time shift: the
 * device clock and the feed agree to ~30 ms); feed fixes outside the span,
 * or inside a hole in the log over LOG_HOLE_MS, are kept.
 *
 * Analysis rate: the log is 10 Hz, the feed's boats ~0.2–1 Hz. Fed in at
 * full rate, one boat would outweigh the fleet wherever fixes are pooled
 * (the steady-heading wind estimate, the Coach's minute-by-minute wind) and
 * GPS jitter would lengthen its sailed distance. So the merged track is
 * thinned to START_HZ around the start (the start figures, trail and
 * speed-through-the-start chart want the detail; the feed's own nominal
 * rate is ~5 Hz) and RACE_HZ elsewhere: still far denser than the feed.
 * The upload itself stays at full rate (see compact.ts).
 */
import { START_SOG_POST_MS, START_SOG_PRE_MS } from '../../analysis/types';
import type { Boat, BoatLog, LatLon, Line, RaceData, Track } from '../types';
import { decodePayload, type PayloadTrack } from './compact';
import { sameSail } from './match';

export const START_HZ = 5;
export const RACE_HZ = 1;
/** Kept at START_HZ from this long before the gun… */
export const START_DENSE_PRE_MS = START_SOG_PRE_MS + 10_000;
/** …to this long after it. */
export const START_DENSE_POST_MS = START_SOG_POST_MS + 10_000;
/** A hole in the log longer than this keeps the feed's fixes inside it. */
export const LOG_HOLE_MS = 2_000;
/** Boat timer: a RACE_START within this of the gun is compared with it… */
export const TIMER_SEARCH_MS = 120_000;
/** …and differing by more than this is flagged, s. */
export const TIMER_WARN_S = 3;
/** Line pings: an end this far from the race's start line end is flagged, m. */
export const LINE_WARN_M = 15;
/** Pings used: the latest of each end set within this long before the gun (or up to a minute after). */
export const PING_SEARCH_MS = 30 * 60_000;

/** Indices to keep: ≥ 1/START_HZ apart around the gun, ≥ 1/RACE_HZ elsewhere (50 ms slack for clock jitter). */
export function thinIndices(t: ArrayLike<number>, gunMs: number): Uint32Array {
  const out = new Uint32Array(t.length);
  let n = 0;
  let last = -Infinity;
  const dense = (x: number): boolean => x >= gunMs - START_DENSE_PRE_MS && x <= gunMs + START_DENSE_POST_MS;
  for (let k = 0; k < t.length; k++) {
    const step = (dense(t[k]) ? 1000 / START_HZ : 1000 / RACE_HZ) - 50;
    if (t[k] - last < step && k !== t.length - 1) continue;
    out[n++] = k;
    last = t[k];
  }
  return out.subarray(0, n);
}

const metres = (a: LatLon, b: LatLon): number => {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  return Math.hypot(x, (b.lat - a.lat) * k) * 6_371_000;
};

/** Δ of the log's own race-start timer from the gun, s (+ = the boat's timer hit zero after the gun); null without one near it. */
export function timerDeltaS(log: PayloadTrack, gunMs: number): number | null {
  const near = log.header.timers.filter((e) => e.type === 3 && Math.abs(e.t - gunMs) <= TIMER_SEARCH_MS).sort((a, b) => Math.abs(a.t - gunMs) - Math.abs(b.t - gunMs))[0];
  return near ? (near.t - gunMs) / 1000 : null;
}

/** How far the boat's pinged line ends are from the race's line, m (pin ↔ left, boat ↔ right; either end null when not pinged). */
export function lineEndOffsets(log: PayloadTrack, gunMs: number, line: Line): { pinM: number | null; boatM: number | null } {
  const latest = (end: number): LatLon | null => {
    const p = log.header.pings.filter((x) => x.end === end && x.t <= gunMs + 60_000 && x.t >= gunMs - PING_SEARCH_MS).sort((a, b) => b.t - a.t)[0];
    return p ? { lat: p.lat, lon: p.lon } : null;
  };
  const pin = latest(0);
  const boat = latest(1);
  return { pinM: pin ? metres(pin, line.left) : null, boatM: boat ? metres(boat, line.right) : null };
}

export { sameSail };

/** The boat's track with the log's fixes (thinned for analysis) in place of the feed's inside the log's span. */
export function mergeTrack(feed: Track | null, log: PayloadTrack, gunMs: number): Track {
  const keep = thinIndices(log.t, gunMs);
  const from = log.t[0];
  const to = log.t[log.t.length - 1];
  // The log's holes over LOG_HOLE_MS, where feed fixes stay.
  const inHole = (ts: number): boolean => {
    let lo = 0;
    let hi = log.t.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (log.t[m] < ts) lo = m + 1;
      else hi = m;
    }
    if (lo < log.t.length && log.t[lo] === ts) return false;
    return lo > 0 && lo < log.t.length && log.t[lo] - log.t[lo - 1] > LOG_HOLE_MS;
  };
  const feedKeep: number[] = [];
  const fn = feed?.t.length ?? 0;
  for (let k = 0; k < fn; k++) {
    const ts = feed!.t[k];
    if (ts < from || ts > to || inHole(ts)) feedKeep.push(k);
  }
  const n = keep.length + feedKeep.length;
  const imu = !!(log.heel || feed?.roll);
  const out: Track = {
    t: new Float64Array(n),
    lat: new Float64Array(n),
    lon: new Float64Array(n),
    sog: new Float32Array(n),
    heading: new Float32Array(n),
    ...(imu ? { roll: new Float32Array(n), pitch: new Float32Array(n) } : {}),
  };
  // Two sorted runs: merge by time (a feed fix at a log fix's exact time is dropped).
  let i = 0;
  let j = 0;
  let o = 0;
  while (i < keep.length || j < feedKeep.length) {
    const lt = i < keep.length ? log.t[keep[i]] : Infinity;
    const ft = j < feedKeep.length ? feed!.t[feedKeep[j]] : Infinity;
    if (lt <= ft) {
      const k = keep[i++];
      if (ft === lt) j++;
      out.t[o] = lt;
      out.lat[o] = log.lat[k];
      out.lon[o] = log.lon[k];
      out.sog[o] = log.sog[k];
      out.heading[o] = log.heading ? log.heading[k] : log.cog[k];
      if (out.roll) {
        out.roll[o] = log.heel ? log.heel[k] : NaN;
        out.pitch![o] = log.pitch ? log.pitch[k] : NaN;
      }
    } else {
      const k = feedKeep[j++];
      out.t[o] = ft;
      out.lat[o] = feed!.lat[k];
      out.lon[o] = feed!.lon[k];
      out.sog[o] = feed!.sog[k];
      out.heading[o] = feed!.heading[k];
      if (out.roll) {
        out.roll[o] = feed!.roll ? feed!.roll[k] : NaN;
        out.pitch![o] = feed!.pitch ? feed!.pitch[k] : NaN;
      }
    }
    o++;
  }
  if (o < n) {
    // Dropped duplicates: trim.
    for (const key of ['t', 'lat', 'lon', 'sog', 'heading', 'roll', 'pitch'] as const) {
      const a = out[key];
      if (a) (out as unknown as Record<string, Float64Array | Float32Array>)[key] = a.slice(0, o);
    }
  }
  return out;
}

/** The full-rate copy is kept from this long before the gun to FULL_RATE_POST_MS after it (mergeUploads' own window), ms. */
export const FULL_RATE_PRE_MS = 10 * 60_000;
export const FULL_RATE_POST_MS = 6 * 3_600_000;

/** The log's fixes in the race's window at full rate: positions, and its heel when it has one (Boat.fullRate). */
export function fullRateIn(log: PayloadTrack, gunMs: number): NonNullable<Boat['fullRate']> {
  let i0 = 0;
  while (i0 < log.t.length && log.t[i0] < gunMs - FULL_RATE_PRE_MS) i0++;
  let i1 = i0;
  while (i1 < log.t.length && log.t[i1] <= gunMs + FULL_RATE_POST_MS) i1++;
  return { t: log.t.slice(i0, i1), lat: log.lat.slice(i0, i1), lon: log.lon.slice(i0, i1), ...(log.heel ? { roll: log.heel.slice(i0, i1) } : {}) };
}

export interface UploadInput {
  track: PayloadTrack;
  uploadedAt?: number;
}

/**
 * The race with each uploaded boat's track merged in (by sail number) and
 * its `log` set (the chips' facts: rate, span, timer and line checks). An
 * upload for another race, or not overlapping this one, is ignored.
 */
export function mergeUploads(data: RaceData, uploads: UploadInput[]): RaceData {
  const gun = data.gunMs;
  const boats = [...data.boats];
  for (const up of uploads) {
    const log = up.track;
    const h = log.header;
    const n = log.t.length;
    if (!n || log.t[n - 1] < gun - 10 * 60_000 || log.t[0] > gun + 6 * 3_600_000) continue;
    const idx = boats.findIndex((b) => sameSail(b.sail, h.sail));
    const prev = idx >= 0 ? boats[idx] : null;
    const track = mergeTrack(prev?.track ?? null, log, gun);
    const lineOff = lineEndOffsets(log, gun, data.startLine);
    const info: BoatLog = {
      kind: 'vkx',
      rateHz: h.rateHz,
      fromMs: log.t[0],
      toMs: log.t[n - 1],
      samples: n,
      startHz: START_HZ,
      raceHz: RACE_HZ,
      timerDeltaS: timerDeltaS(log, gun),
      linePinM: lineOff.pinM,
      lineBoatM: lineOff.boatM,
      ...(up.uploadedAt ? { uploadedAt: up.uploadedAt } : {}),
    };
    const fullRate = fullRateIn(log, gun);
    if (prev) boats[idx] = { ...prev, track, log: info, fullRate };
    else {
      boats.push({ id: h.sail, sail: h.sail, name: h.name?.trim() || `#${h.sail}`, bowOffsetM: 0, track, finishMs: null, log: info, fullRate });
    }
  }
  return { ...data, boats };
}

/** mergeUploads from the stored (gzipped) payloads; one that won't decode is skipped. */
export async function mergeUploadBytes(data: RaceData, ups: { bytes: ArrayBuffer; uploadedAt?: number }[]): Promise<RaceData> {
  const decoded: UploadInput[] = [];
  for (const u of ups) {
    try {
      decoded.push({ track: await decodePayload(new Uint8Array(u.bytes)), uploadedAt: u.uploadedAt });
    } catch {
      /* a damaged copy: the race shows the feed for that boat */
    }
  }
  return decoded.length ? mergeUploads(data, decoded) : data;
}

/** The log's caveats as short chip texts (empty when the boat's timer and pinged line agree with the race's). */
export function logWarnings(log: BoatLog): { text: string; why: string }[] {
  const out: { text: string; why: string }[] = [];
  if (log.timerDeltaS != null && Math.abs(log.timerDeltaS) > TIMER_WARN_S) {
    const s = Math.round(log.timerDeltaS);
    out.push({
      text: `boat timer Δ ${s > 0 ? '+' : '−'}${Math.abs(s)}s`,
      why: `The boat's own start timer hit zero ${Math.abs(log.timerDeltaS).toFixed(1)} s ${s > 0 ? 'after' : 'before'} the race committee's gun in the feed: the boat's timer was off (or the gun was recorded late). The track is not shifted.`,
    });
  }
  for (const [m, end] of [
    [log.linePinM, 'pin'],
    [log.lineBoatM, 'committee boat'],
  ] as const) {
    if (m != null && m > LINE_WARN_M) {
      out.push({
        text: `line ${end === 'pin' ? 'pin' : 'boat'} end ${Math.round(m)} m off`,
        why: `The boat pinged the ${end} end ${Math.round(m)} m from where the race committee's line has it: the boat's line-based figures (on its own display) used a different line.`,
      });
    }
  }
  return out;
}
