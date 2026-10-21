/**
 * The compact per-race payload an uploaded boat log is stored as (format
 * "RVKX" v1), shared by the browser (encode, decode for the merge) and the
 * Pages Function (decode + validate before storing).
 *
 *   'RVKX' · u8 version · u32 LE header length · header JSON (UTF-8)
 *   then one column per `header.cols` entry: u32 LE byte length · varints
 *
 * Columns are quantised, delta-coded from the previous sample and written as
 * LEB128 varints (signed ones zigzagged), so a 10 Hz sample costs ~9 bytes
 * before gzip. The whole thing is then gzipped (CompressionStream).
 *
 *   t      ms (first delta from header.t0)       exact
 *   lat    1e-7 degrees (the log's own integers) exact
 *   lon    1e-7 degrees                          exact
 *   sog    cm/s                                  ±0.005 m/s
 *   cog    0.1° (delta wrapped to ±180°)         ±0.05°
 *   hdg    0.1° (as cog), from the quaternion    ±0.05°
 *   heel   0.1°                                  ±0.05°
 *   pitch  0.1°                                  ±0.05°
 *
 * hdg / heel / pitch are omitted when the log isn't fixed to the boat.
 */

export const PAYLOAD_MAGIC = 'RVKX';
export const PAYLOAD_VERSION = 1;
export const PAYLOAD_FORMAT = 'recall-vkx';

export type ColName = 't' | 'lat' | 'lon' | 'sog' | 'cog' | 'hdg' | 'heel' | 'pitch';
export const ALL_COLS: readonly ColName[] = ['t', 'lat', 'lon', 'sog', 'cog', 'hdg', 'heel', 'pitch'];
const BASE_COLS: readonly ColName[] = ['t', 'lat', 'lon', 'sog', 'cog'];
const ANGLE_COLS = new Set<ColName>(['cog', 'hdg']);

export interface PayloadTimer {
  t: number;
  type: number;
  value: number;
}

export interface PayloadPing {
  t: number;
  end: number;
  lat: number;
  lon: number;
}

/** The small JSON header. Ids are as the app knows them; the server checks each against a strict pattern. */
export interface PayloadHeader {
  format: typeof PAYLOAD_FORMAT;
  v: typeof PAYLOAD_VERSION;
  event: string;
  /** Division name, as in the regatta document. */
  div: string;
  /** Race id: the RaceSense race number as a string today; any [A-Za-z0-9_-]{1,32}. */
  race: string;
  /** Race gun, ms (the window was cut around it). */
  gunMs: number;
  /** The fleet boat the log matched: its tracker serial (feed `sn`), sail and name. */
  sn: number;
  sail: string;
  name?: string;
  /** Logging rate, Hz (the log's config row, else the median spacing). */
  rateHz: number;
  n: number;
  t0: number;
  t1: number;
  cols: ColName[];
  /** Timer events and line pings inside the window. */
  timers: PayloadTimer[];
  pings: PayloadPing[];
  /** Magnetic declination, radians (the log's latest before the window ends), if any. */
  declinationRad: number | null;
  /** SHA-256 (hex) of the whole source .vkx file, and its size. */
  srcSha256: string;
  srcBytes: number;
}

/** A decoded payload: the header and the samples, in app units (degrees, knots). */
export interface PayloadTrack {
  header: PayloadHeader;
  t: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  /** Knots. */
  sog: Float32Array;
  /** Degrees. */
  cog: Float32Array;
  heading: Float32Array | null;
  heel: Float32Array | null;
  pitch: Float32Array | null;
}

/** Samples to encode: positions as 1e-7 integers (exact), the rest as the log has them. */
export interface PayloadSamples {
  t: ArrayLike<number>;
  latE7: ArrayLike<number>;
  lonE7: ArrayLike<number>;
  /** m/s. */
  sog: ArrayLike<number>;
  /** Degrees. */
  cog: ArrayLike<number>;
  heading?: ArrayLike<number> | null;
  heel?: ArrayLike<number> | null;
  pitch?: ArrayLike<number> | null;
}

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

export const MS_TO_KN = 3600 / 1852;

// ---- varints

class Writer {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private grow(need: number): void {
    if (this.len + need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  /** Unsigned LEB128 for 0 ≤ v < 2^53. */
  uvar(v: number): void {
    this.grow(8);
    while (v >= 0x80) {
      this.buf[this.len++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.len++] = v;
  }
  /** Zigzag then LEB128 (|v| < 2^52). */
  svar(v: number): void {
    this.uvar(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

class Reader {
  pos = 0;
  constructor(
    private readonly b: Uint8Array,
    private readonly end: number,
  ) {}
  uvar(): number {
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 8; k++) {
      if (this.pos >= this.end) throw new PayloadError('Column ends inside a number');
      const byte = this.b[this.pos++];
      v += (byte & 0x7f) * mul;
      if (byte < 0x80) return v;
      mul *= 0x80;
    }
    throw new PayloadError('Number too long');
  }
  svar(): number {
    const u = this.uvar();
    return u % 2 ? -(u + 1) / 2 : u / 2;
  }
}

const wrapDeci = (d: number): number => {
  // Into [-1800, 1800).
  let x = d % 3600;
  if (x >= 1800) x -= 3600;
  if (x < -1800) x += 3600;
  return x;
};

const deci = (deg: number): number => (Number.isFinite(deg) ? Math.round(deg * 10) : 0);
const deciAngle = (deg: number): number => {
  const d = deci(deg) % 3600;
  return d < 0 ? d + 3600 : d;
};

function encodeColumn(name: ColName, s: PayloadSamples, n: number, t0: number): Uint8Array {
  const w = new Writer();
  let prev = 0;
  for (let k = 0; k < n; k++) {
    let q: number;
    switch (name) {
      case 't':
        q = s.t[k];
        if (!(q - (k ? prev : t0) >= 0)) throw new PayloadError('Timestamps must not go backwards');
        w.uvar(q - (k ? prev : t0));
        prev = q;
        continue;
      case 'lat':
        q = s.latE7[k];
        break;
      case 'lon':
        q = s.lonE7[k];
        break;
      case 'sog':
        q = Number.isFinite(s.sog[k]) ? Math.max(0, Math.round(s.sog[k] * 100)) : 0;
        break;
      case 'cog':
        q = deciAngle(s.cog[k]);
        break;
      case 'hdg':
        q = deciAngle(s.heading![k]);
        break;
      case 'heel':
        q = deci(s.heel![k]);
        break;
      case 'pitch':
        q = deci(s.pitch![k]);
        break;
    }
    w.svar(ANGLE_COLS.has(name) ? wrapDeci(q - prev) : q - prev);
    prev = q;
  }
  return w.bytes();
}

/** The uncompressed payload bytes. */
export function encodePayloadRaw(header: Omit<PayloadHeader, 'cols' | 'n' | 't0' | 't1' | 'format' | 'v'>, s: PayloadSamples): Uint8Array {
  const n = s.t.length;
  if (!n) throw new PayloadError('No samples');
  const orient = !!(s.heading && s.heel && s.pitch);
  const cols: ColName[] = orient ? [...ALL_COLS] : [...BASE_COLS];
  const full: PayloadHeader = { format: PAYLOAD_FORMAT, v: PAYLOAD_VERSION, ...header, n, t0: s.t[0], t1: s.t[n - 1], cols };
  const head = new TextEncoder().encode(JSON.stringify(full));
  const bodies = cols.map((c) => encodeColumn(c, s, n, full.t0));
  const total = 9 + head.length + bodies.reduce((a, b) => a + 4 + b.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode(PAYLOAD_MAGIC), 0);
  out[4] = PAYLOAD_VERSION;
  dv.setUint32(5, head.length, true);
  out.set(head, 9);
  let o = 9 + head.length;
  for (const b of bodies) {
    dv.setUint32(o, b.length, true);
    out.set(b, o + 4);
    o += 4 + b.length;
  }
  return out;
}

/** Largest uncompressed payload accepted (a zip bomb guard): ~10 Hz for 8 h at ~10 bytes a sample is under 3 MB. */
export const MAX_RAW_BYTES = 12_000_000;
/** Most samples in one payload: 20 Hz (validate.ts MAX_RATE_HZ) for 5 h (MAX_SPAN_MS) plus 5%; checked before anything is allocated. */
export const MAX_SAMPLES = 378_000;
/** Largest header JSON. */
const MAX_HEADER_BYTES = 256_000;

/** Read just the header (cheap). */
export function readHeader(raw: Uint8Array): { header: PayloadHeader; bodyAt: number } {
  if (raw.length < 9) throw new PayloadError('Payload too short');
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  if (magic !== PAYLOAD_MAGIC) throw new PayloadError('Not a Recall boat-log payload');
  if (raw[4] !== PAYLOAD_VERSION) throw new PayloadError(`Unsupported payload version ${raw[4]}`);
  const hl = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(5, true);
  if (hl > MAX_HEADER_BYTES || 9 + hl > raw.length) throw new PayloadError('Bad header length');
  let header: PayloadHeader;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(9, 9 + hl))) as PayloadHeader;
  } catch {
    throw new PayloadError('Header is not valid JSON');
  }
  if (!header || typeof header !== 'object' || header.format !== PAYLOAD_FORMAT || header.v !== PAYLOAD_VERSION) {
    throw new PayloadError('Header is not a Recall boat-log header');
  }
  if (!Number.isInteger(header.n) || header.n < 1 || header.n > MAX_SAMPLES) throw new PayloadError('Bad sample count');
  if (!Array.isArray(header.cols) || header.cols.some((c) => !ALL_COLS.includes(c)) || new Set(header.cols).size !== header.cols.length) {
    throw new PayloadError('Bad column list');
  }
  for (const c of BASE_COLS) if (!header.cols.includes(c)) throw new PayloadError(`Missing column ${c}`);
  if (!Number.isFinite(header.t0)) throw new PayloadError('Bad t0');
  return { header, bodyAt: 9 + hl };
}

/** Decode uncompressed payload bytes. Throws PayloadError on any inconsistency. */
export function decodePayloadRaw(raw: Uint8Array): PayloadTrack {
  const { header, bodyAt } = readHeader(raw);
  const n = header.n;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const cols = new Map<ColName, Float64Array>();
  let o = bodyAt;
  for (const name of header.cols) {
    if (o + 4 > raw.length) throw new PayloadError(`Column ${name} missing`);
    const bl = dv.getUint32(o, true);
    const start = o + 4;
    const end = start + bl;
    if (end > raw.length) throw new PayloadError(`Column ${name} truncated`);
    // Every sample takes at least a byte: a short column can't hold n samples (and won't make us allocate for them).
    if (bl < n) throw new PayloadError(`Column ${name} too short`);
    const r = new Reader(raw, end);
    r.pos = start;
    const out = new Float64Array(n);
    let prev = name === 't' ? header.t0 : 0;
    for (let k = 0; k < n; k++) {
      if (name === 't') {
        prev += r.uvar();
      } else {
        const d = r.svar();
        prev = ANGLE_COLS.has(name) ? (((prev + d) % 3600) + 3600) % 3600 : prev + d;
      }
      out[k] = prev;
    }
    if (r.pos !== end) throw new PayloadError(`Column ${name} has trailing bytes`);
    cols.set(name, out);
    o = end;
  }
  if (o !== raw.length) throw new PayloadError('Trailing bytes after the columns');
  const t = cols.get('t')!;
  const lat = cols.get('lat')!.map((v) => v / 1e7);
  const lon = cols.get('lon')!.map((v) => v / 1e7);
  const sog = Float32Array.from(cols.get('sog')!, (v) => (v / 100) * MS_TO_KN);
  const cog = Float32Array.from(cols.get('cog')!, (v) => v / 10);
  const f = (c: ColName): Float32Array | null => (cols.has(c) ? Float32Array.from(cols.get(c)!, (v) => v / 10) : null);
  return { header, t, lat, lon, sog, cog, heading: f('hdg'), heel: f('heel'), pitch: f('pitch') };
}

// ---- gzip (CompressionStream: browsers, workers, Node ≥ 18, Cloudflare Workers)

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, max = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadError('Payload too large once unpacked');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const gzip = (b: Uint8Array): Promise<Uint8Array> => pipe(b, new CompressionStream('gzip'));

export async function gunzip(b: Uint8Array, max = MAX_RAW_BYTES): Promise<Uint8Array> {
  if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) throw new PayloadError('Payload is not gzip');
  try {
    return await pipe(b, new DecompressionStream('gzip'), max);
  } catch (e) {
    if (e instanceof PayloadError) throw e;
    throw new PayloadError('Payload is not valid gzip');
  }
}

/** Encode and gzip. */
export async function encodePayload(header: Parameters<typeof encodePayloadRaw>[0], s: PayloadSamples): Promise<Uint8Array> {
  return gzip(encodePayloadRaw(header, s));
}

/** Gunzip and decode. */
export async function decodePayload(gz: Uint8Array): Promise<PayloadTrack> {
  return decodePayloadRaw(await gunzip(gz));
}

export async function sha256Hex(b: Uint8Array | ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  let s = '';
  for (const x of d) s += x.toString(16).padStart(2, '0');
  return s;
}
