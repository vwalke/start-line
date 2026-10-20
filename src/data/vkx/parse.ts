/**
 * Vakaros .vkx boat-log parser (spec: github.com/vakaros/vkx, VKX 1.4; file
 * version byte 0x00–0x05). A .vkx is a stream of rows, each a one-byte key
 * and a fixed-size little-endian payload; every key's size is in ROW_SIZE,
 * so rows we don't use are skipped by length.
 *
 * Fast path: one DataView pass over the ArrayBuffer, with the 0x02
 * position rows (10 Hz, ~230k a day) written straight into typed arrays (no
 * per-row objects). Parsing stops, keeping what it has read, at an unknown
 * key or a truncated row, and says why (`stop`).
 *
 * Orientation: the 0x02 quaternion is the device in the true NED frame. With
 * the config row's "fixed to body frame" bit set (0x08 bit 0) it is the
 * boat's, and ZYX Euler angles give heading (true), heel and trim; checked
 * against the RaceSense feed's heading / roll / pitch for the same device
 * (they agree to the degree: the feed carries these same angles). Heel is
 * + to starboard, as the feed's `roll`.
 */

/** Payload sizes in bytes (key excluded). */
export const ROW_SIZE: Readonly<Record<number, number>> = {
  0x01: 32,
  0x02: 44,
  0x03: 20,
  0x04: 13,
  0x05: 17,
  0x06: 18,
  0x07: 12,
  0x08: 13,
  0x0a: 16,
  0x0b: 16,
  0x0c: 12,
  0x0e: 16,
  0x0f: 16,
  0x10: 12,
  0x20: 13,
  0x21: 52,
  0xfe: 2,
  0xff: 7,
};

/** Newest file format version this parser knows (VKX 1.4). Newer files are read but flagged. */
export const VKX_MAX_VERSION = 5;

export const TIMER_EVENTS = ['RESET', 'START', 'SYNC', 'RACE_START', 'RACE_END'] as const;
export type TimerEventName = (typeof TIMER_EVENTS)[number] | 'UNKNOWN';

export interface VkxTimerEvent {
  t: number;
  type: number;
  name: TimerEventName;
  /** Timer value when the button was hit, s. */
  value: number;
}

export interface VkxLinePing {
  t: number;
  /** 0 = pin (left), 1 = boat (right). */
  end: number;
  lat: number;
  lon: number;
}

export interface VkxDeclination {
  t: number;
  /** Radians. */
  rad: number;
  lat: number;
  lon: number;
}

/** The 0x02 rows, column-wise. */
export interface VkxPositions {
  n: number;
  /** Unix ms UTC. */
  t: Float64Array;
  /** Degrees (from 1e-7 integers, which `latE7`/`lonE7` keep exactly). */
  lat: Float64Array;
  lon: Float64Array;
  latE7: Int32Array;
  lonE7: Int32Array;
  /** m/s. */
  sog: Float32Array;
  /** Course over ground, degrees true 0..360. */
  cog: Float32Array;
  /** From the quaternion (ZYX Euler), degrees: heading true 0..360, heel (+ starboard), trim (+ bow up). NaN when not body-fixed. */
  heading: Float32Array;
  heel: Float32Array;
  pitch: Float32Array;
}

export interface VkxLog {
  /** File format version byte (from the first page header). */
  version: number;
  bytes: number;
  /** Bytes consumed by complete rows. */
  parsedBytes: number;
  /** Row count per key (hex, e.g. "0x02"). */
  counts: Record<string, number>;
  pos: VkxPositions;
  timers: VkxTimerEvent[];
  pings: VkxLinePing[];
  declination: VkxDeclination[];
  /** From the 0x08 config row, if present. */
  config: { rateHz: number; bodyFixed: boolean } | null;
  /** Why parsing stopped before the end of the file, if it did. */
  stop: { reason: 'unknown-key' | 'truncated'; offset: number; key: number; message: string } | null;
  /** A file version newer than VKX_MAX_VERSION (parsed by the 1.4 row table). */
  newerVersion: boolean;
}

export class VkxError extends Error {
  constructor(
    message: string,
    readonly code: 'not-vkx' | 'empty',
  ) {
    super(message);
    this.name = 'VkxError';
  }
}

const DEG = 180 / Math.PI;

/** Quick check: a .vkx starts with a page header (0xFF, version ≤ a sane bound) followed by a known key. */
export function looksLikeVkx(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 16));
  if (b.length < 9 || b[0] !== 0xff || b[1] > 0x20) return false;
  return ROW_SIZE[b[8]] !== undefined;
}

/**
 * Parse a .vkx file. Throws VkxError('not-vkx') when it doesn't start like
 * one, VkxError('empty') with no position rows; otherwise returns what it
 * read, with `stop` set if it had to stop early.
 */
export function parseVkx(buf: ArrayBuffer): VkxLog {
  if (!looksLikeVkx(buf)) throw new VkxError('Not a Vakaros .vkx log (no page header at the start)', 'not-vkx');
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const len = buf.byteLength;
  // Upper bound on position rows; trimmed at the end.
  const cap = Math.floor(len / 45) + 1;
  const t = new Float64Array(cap);
  const latE7 = new Int32Array(cap);
  const lonE7 = new Int32Array(cap);
  const sog = new Float32Array(cap);
  const cog = new Float32Array(cap);
  const qw = new Float32Array(cap);
  const qx = new Float32Array(cap);
  const qy = new Float32Array(cap);
  const qz = new Float32Array(cap);
  const counts = new Uint32Array(256);
  const timers: VkxTimerEvent[] = [];
  const pings: VkxLinePing[] = [];
  const declination: VkxDeclination[] = [];
  let config: VkxLog['config'] = null;
  let version = -1;
  let stop: VkxLog['stop'] = null;
  let n = 0;
  let i = 0;
  const u64 = (o: number): number => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
  while (i < len) {
    const key = bytes[i];
    const size = ROW_SIZE[key];
    if (size === undefined) {
      stop = { reason: 'unknown-key', offset: i, key, message: `Unknown row type 0x${key.toString(16).padStart(2, '0')} at byte ${i}` };
      break;
    }
    const p = i + 1;
    if (p + size > len) {
      stop = { reason: 'truncated', offset: i, key, message: `File ends inside a row at byte ${i} (truncated download?)` };
      break;
    }
    counts[key]++;
    switch (key) {
      case 0x02: {
        t[n] = u64(p);
        latE7[n] = dv.getInt32(p + 8, true);
        lonE7[n] = dv.getInt32(p + 12, true);
        sog[n] = dv.getFloat32(p + 16, true);
        cog[n] = dv.getFloat32(p + 20, true);
        qw[n] = dv.getFloat32(p + 28, true);
        qx[n] = dv.getFloat32(p + 32, true);
        qy[n] = dv.getFloat32(p + 36, true);
        qz[n] = dv.getFloat32(p + 40, true);
        n++;
        break;
      }
      case 0x03:
        declination.push({ t: u64(p), rad: dv.getFloat32(p + 8, true), lat: dv.getInt32(p + 12, true) / 1e7, lon: dv.getInt32(p + 16, true) / 1e7 });
        break;
      case 0x04: {
        const type = bytes[p + 8];
        timers.push({ t: u64(p), type, name: TIMER_EVENTS[type] ?? 'UNKNOWN', value: dv.getInt32(p + 9, true) });
        break;
      }
      case 0x05:
        pings.push({ t: u64(p), end: bytes[p + 8], lat: dv.getFloat32(p + 9, true), lon: dv.getFloat32(p + 13, true) });
        break;
      case 0x08:
        config ??= { bodyFixed: (dv.getUint32(p + 8, true) & 1) === 1, rateHz: bytes[p + 12] };
        break;
      case 0xff:
        if (version < 0) version = bytes[p];
        break;
    }
    i = p + size;
  }
  if (!n) throw new VkxError(stop ? `No position rows before: ${stop.message}` : 'The log has no position rows', 'empty');

  const pos = finishPositions(n, t, latE7, lonE7, sog, cog, qw, qx, qy, qz, config?.bodyFixed !== false);
  const countsOut: Record<string, number> = {};
  counts.forEach((c, k) => {
    if (c) countsOut[`0x${k.toString(16).padStart(2, '0')}`] = c;
  });
  return {
    version,
    bytes: len,
    parsedBytes: i,
    counts: countsOut,
    pos,
    timers,
    pings,
    declination,
    config,
    stop,
    newerVersion: version > VKX_MAX_VERSION,
  };
}

/**
 * Trim to `n`, sort by time if the log isn't already (it is, in practice),
 * drop repeated timestamps, and turn the quaternion into heading / heel / trim.
 */
function finishPositions(
  n0: number,
  t0: Float64Array,
  latE7: Int32Array,
  lonE7: Int32Array,
  sog: Float32Array,
  cogRad: Float32Array,
  qw: Float32Array,
  qx: Float32Array,
  qy: Float32Array,
  qz: Float32Array,
  orient: boolean,
): VkxPositions {
  let order: Uint32Array | null = null;
  for (let k = 1; k < n0; k++) {
    if (t0[k] < t0[k - 1]) {
      order = Uint32Array.from({ length: n0 }, (_, j) => j).sort((a, b) => t0[a] - t0[b] || a - b);
      break;
    }
  }
  const idx = (k: number): number => (order ? order[k] : k);
  // Keep the first row of each timestamp.
  const keep = new Uint32Array(n0);
  let n = 0;
  let last = -Infinity;
  for (let k = 0; k < n0; k++) {
    const j = idx(k);
    if (t0[j] === last) continue;
    last = t0[j];
    keep[n++] = j;
  }
  const out: VkxPositions = {
    n,
    t: new Float64Array(n),
    lat: new Float64Array(n),
    lon: new Float64Array(n),
    latE7: new Int32Array(n),
    lonE7: new Int32Array(n),
    sog: new Float32Array(n),
    cog: new Float32Array(n),
    heading: new Float32Array(n),
    heel: new Float32Array(n),
    pitch: new Float32Array(n),
  };
  for (let k = 0; k < n; k++) {
    const j = keep[k];
    out.t[k] = t0[j];
    out.latE7[k] = latE7[j];
    out.lonE7[k] = lonE7[j];
    out.lat[k] = latE7[j] / 1e7;
    out.lon[k] = lonE7[j] / 1e7;
    out.sog[k] = sog[j];
    const c = cogRad[j] * DEG;
    out.cog[k] = c < 0 ? c + 360 : c >= 360 ? c - 360 : c;
    if (!orient) {
      out.heading[k] = out.heel[k] = out.pitch[k] = NaN;
      continue;
    }
    const w = qw[j];
    const x = qx[j];
    const y = qy[j];
    const z = qz[j];
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * DEG;
    out.heading[k] = yaw < 0 ? yaw + 360 : yaw;
    out.heel[k] = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * DEG;
    out.pitch[k] = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * DEG;
  }
  return out;
}

/** Median spacing of the position rows → nominal rate, Hz (rounded to 0.1). */
export function nominalRateHz(t: ArrayLike<number>): number {
  const n = t.length;
  if (n < 2) return 0;
  const step = Math.max(1, Math.floor(n / 2000));
  const d: number[] = [];
  for (let k = step; k < n; k += step) d.push(t[k] - t[k - 1]);
  d.sort((a, b) => a - b);
  const med = d[d.length >> 1];
  return med > 0 ? Math.round(10_000 / med) / 10 : 0;
}

/** Summary for the UI (no arrays). */
export function logSummary(log: VkxLog): {
  rows: number;
  t0: number;
  t1: number;
  rateHz: number;
  timers: number;
  pings: number;
  version: number;
  stop: string | null;
} {
  return {
    rows: log.pos.n,
    t0: log.pos.t[0],
    t1: log.pos.t[log.pos.n - 1],
    rateHz: log.config?.rateHz || nominalRateHz(log.pos.t),
    timers: log.timers.length,
    pings: log.pings.length,
    version: log.version,
    stop: log.stop?.message ?? null,
  };
}
