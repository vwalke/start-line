/**
 * Feedback pictures without their metadata: EXIF (camera, GPS, time), XMP, comments and text chunks
 * come out before a picture is stored (functions/_feedback.ts). The page already redraws pictures
 * through a canvas, which drops most of it, but the server doesn't count on that. Each format is
 * walked segment by segment and rebuilt from the parts that are needed to show the image; anything
 * that doesn't parse cleanly is refused (null) rather than stored as sent.
 *
 *   JPEG  keeps APP0 (JFIF), APP14 "Adobe" (needed to decode CMYK), the tables, frames and scans;
 *         drops APP1–APP15 otherwise (EXIF, XMP, ICC, maker notes), COM and anything after EOI.
 *   PNG   keeps the critical chunks and tRNS, gAMA, cHRM, sRGB, pHYs; drops the rest (tEXt, zTXt,
 *         iTXt, eXIf, tIME, iCCP, …) and anything after IEND. An unknown critical chunk is refused.
 *   WebP  keeps VP8X, ICCP, ANIM, ANMF, ALPH, VP8, VP8L; drops EXIF, XMP and unknown chunks, clears
 *         VP8X's EXIF and XMP flags and rewrites the RIFF size.
 */

const u16be = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n));

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** JPEG: the markers up to EOI, with the metadata segments left out. */
export function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let scanned = false;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return null;
    const m = b[i];
    const at = i - 1;
    i++;
    if (m === 0xd9) {
      parts.push(b.subarray(at, i));
      return scanned ? join(parts) : null;
    }
    if (m === 0x00 || m === 0xd8) return null;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      parts.push(b.subarray(at, i));
      continue;
    }
    if (i + 2 > b.length) return null;
    const len = u16be(b, i);
    if (len < 2 || i + len > b.length) return null;
    const end = i + len;
    const app = m >= 0xe0 && m <= 0xef;
    const keep = app ? m === 0xe0 || (m === 0xee && ascii(b, i + 2, 5) === 'Adobe') : m !== 0xfe;
    if (keep) parts.push(b.subarray(at, end));
    i = end;
    if (m === 0xda) {
      // Entropy-coded data runs to the next marker that isn't a stuffed 0xFF00 or a restart.
      let j = i;
      while (j < b.length && !(b[j] === 0xff && j + 1 < b.length && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j >= b.length) return null;
      parts.push(b.subarray(i, j));
      i = j;
      scanned = true;
    }
  }
  return null;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const PNG_SAFE = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'pHYs']);

/** PNG: IHDR first, IEND last, only the chunks that draw the image. */
export function stripPng(b: Uint8Array): Uint8Array | null {
  if (b.length < 8 || !PNG_SIG.every((x, k) => b[k] === x)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let first = true;
  let idat = false;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    if (len > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type)) return null;
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (first !== (type === 'IHDR')) return null;
    first = false;
    const critical = type.charCodeAt(0) < 0x61; // upper case first letter
    if (critical && !PNG_CRITICAL.has(type)) return null;
    if (critical || PNG_SAFE.has(type)) parts.push(b.subarray(i, end));
    if (type === 'IDAT') idat = true;
    i = end;
    if (type === 'IEND') return idat ? join(parts) : null;
  }
  return null;
}

const WEBP_KEEP = new Set(['VP8X', 'ICCP', 'ANIM', 'ANMF', 'ALPH', 'VP8 ', 'VP8L']);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

/** WebP: the RIFF chunks that draw the image, the RIFF size and VP8X flags made to match. */
export function stripWebp(b: Uint8Array): Uint8Array | null {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const riffEnd = u32le(b, 4) + 8;
  if (riffEnd > b.length || riffEnd < 12) return null;
  const parts: Uint8Array[] = [];
  let i = 12;
  let image = false;
  while (i < riffEnd) {
    if (i + 8 > riffEnd) return null;
    const fourcc = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > riffEnd) return null;
    if (fourcc === 'VP8X' && i !== 12) return null;
    if (WEBP_KEEP.has(fourcc)) {
      const chunk = b.slice(i, Math.min(end, riffEnd));
      if (fourcc === 'VP8X') {
        if (size < 10) return null;
        chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
      }
      if (chunk.length & 1) return null;
      parts.push(chunk);
      if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ANMF') image = true;
    }
    i = end;
  }
  if (!image) return null;
  const body = join(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  out.set(body, 12);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

/** The picture without its metadata, or null when it can't be read safely. */
export function stripImageMetadata(bytes: Uint8Array, type: string): Uint8Array | null {
  if (type === 'image/jpeg') return stripJpeg(bytes);
  if (type === 'image/png') return stripPng(bytes);
  if (type === 'image/webp') return stripWebp(bytes);
  return null;
}
