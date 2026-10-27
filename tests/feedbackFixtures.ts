/**
 * Tiny hand-built pictures for the feedback tests: real container structure (JPEG segments, PNG
 * chunks, WebP RIFF chunks) around placeholder image data, with or without metadata in them.
 */

const bytes = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

export const text = (b: Uint8Array): string => String.fromCharCode(...b);
export const b64 = (b: Uint8Array): string => btoa(text(b));

/** JPEG: SOI, each [marker, payload] segment, SOS with `scan` as its entropy data, EOI, then `trailer`. */
export function jpeg(segments: [number, number[] | string][], scan: number[] = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56], trailer = ''): Uint8Array {
  const out = [0xff, 0xd8];
  for (const [m, p] of segments) {
    const d = typeof p === 'string' ? bytes(p) : p;
    out.push(0xff, m, ...be16(d.length + 2), ...d);
  }
  out.push(0xff, 0xda, ...be16(8), 1, 1, 0, 0, 0x3f, 0, ...scan, 0xff, 0xd9, ...bytes(trailer));
  return new Uint8Array(out);
}

export const JFIF: [number, string] = [0xe0, 'JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000'];
export const DQT: [number, number[]] = [0xdb, [0, ...new Array(64).fill(1)]];
export const SOF0: [number, number[]] = [0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]];
export const EXIF_GPS: [number, string] = [0xe1, 'Exif\u0000\u0000MM\u0000*GPSLatitude 41.49N GPSLongitude 71.31W Canon EOS'];
export const XMP: [number, string] = [0xe1, 'http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta>Vann</x:xmpmeta>'];
export const COM: [number, string] = [0xfe, 'shot on the committee boat'];

/** PNG: the signature and each [type, data] chunk (CRCs are placeholders; nothing checks them). */
export function png(chunks: [string, number[] | string][], trailer = ''): Uint8Array {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const [type, p] of chunks) {
    const d = typeof p === 'string' ? bytes(p) : p;
    out.push(...be32(d.length), ...bytes(type), ...d, 0, 0, 0, 0);
  }
  out.push(...bytes(trailer));
  return new Uint8Array(out);
}

export const IHDR: [string, number[]] = ['IHDR', [...be32(1), ...be32(1), 8, 6, 0, 0, 0]];
export const IDAT: [string, number[]] = ['IDAT', [0x78, 0x9c, 1, 2, 3]];
export const IEND: [string, number[]] = ['IEND', []];

/** WebP: RIFF, WEBP and each [fourcc, data] chunk, padded to even sizes; `riffSize` overrides the header's. */
export function webp(chunks: [string, number[] | string][], riffSize?: number): Uint8Array {
  const body: number[] = [...bytes('WEBP')];
  for (const [fourcc, p] of chunks) {
    const d = typeof p === 'string' ? bytes(p) : p;
    body.push(...bytes(fourcc), ...le32(d.length), ...d, ...(d.length & 1 ? [0] : []));
  }
  return new Uint8Array([...bytes('RIFF'), ...le32(riffSize ?? body.length), ...body]);
}

/** VP8X with the given flags and a 1×1 canvas. */
export const vp8x = (flags: number): [string, number[]] => ['VP8X', [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
export const VP8: [string, number[]] = ['VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]];
