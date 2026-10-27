import { describe, expect, it } from 'vitest';
import { stripImageMetadata, stripJpeg, stripPng, stripWebp } from '../functions/_feedbackImage';
import { COM, DQT, EXIF_GPS, IDAT, IEND, IHDR, JFIF, SOF0, VP8, XMP, jpeg, png, text, vp8x, webp } from './feedbackFixtures';

const u32le = (b: Uint8Array, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

describe('JPEG metadata', () => {
  it('drops EXIF (GPS), XMP, COM and anything after EOI; keeps JFIF, the tables, the frame and the scan', () => {
    const dirty = jpeg([JFIF, EXIF_GPS, XMP, COM, DQT, SOF0], undefined, 'trailing secrets');
    const out = stripJpeg(dirty)!;
    expect(out).not.toBeNull();
    expect(out).toEqual(jpeg([JFIF, DQT, SOF0]));
    for (const s of ['Exif', 'GPS', 'xmpmeta', 'Vann', 'committee', 'trailing']) expect(text(out)).not.toContain(s);
    expect(stripJpeg(out)).toEqual(out);
  });

  it('keeps an Adobe APP14 (needed to decode CMYK) but not other APP segments', () => {
    const adobe: [number, string] = [0xee, 'Adobe\u0000d\u0000\u0000\u0000\u0000\u0001'];
    const icc: [number, string] = [0xe2, 'ICC_PROFILE\u0000\u0001\u0001desc: Vann iPhone'];
    expect(stripJpeg(jpeg([JFIF, adobe, icc, DQT, SOF0]))).toEqual(jpeg([JFIF, adobe, DQT, SOF0]));
  });

  it('keeps stuffed bytes and restart markers inside the scan, and a second scan with tables between', () => {
    // Scan 1 (a stuffed 0xFF00 and an RST3), a COM, a DHT, scan 2.
    const two = jpeg([JFIF, DQT, SOF0], [1, 0xff, 0x00, 2, 0xff, 0xd3, 3, 0xff, 0xfe, 0, 5, 0x41, 0x42, 0x43, 0xff, 0xc4, 0, 19, 0, ...new Array(16).fill(0), 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 9]);
    const out = stripJpeg(two)!;
    // The COM between the scans is dropped, everything else is kept byte for byte.
    expect(text(out)).not.toContain('ABC');
    expect(out.length).toBe(two.length - 7);
    expect(out.slice(-3)).toEqual(new Uint8Array([9, 0xff, 0xd9]));
  });

  it('refuses what it cannot walk', () => {
    const good = jpeg([JFIF, DQT, SOF0]);
    expect(stripJpeg(good.slice(0, good.length - 2))).toBeNull(); // no EOI
    expect(stripJpeg(good.slice(0, 30))).toBeNull(); // cut inside a segment
    expect(stripJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull(); // no scan
    const bad = good.slice();
    bad[4] = 0xff;
    bad[5] = 0xff; // a length past the end
    expect(stripJpeg(bad)).toBeNull();
    expect(stripJpeg(new Uint8Array([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
  });
});

describe('PNG metadata', () => {
  it('drops tEXt, zTXt, iTXt, eXIf, tIME, iCCP and anything after IEND; keeps critical and safe chunks', () => {
    const safe: [string, number[]][] = [
      ['gAMA', [0, 0, 0xb1, 0x8f]],
      ['sRGB', [0]],
      ['pHYs', [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]],
    ];
    const dirty = png(
      [IHDR, ['tEXt', 'Author\u0000Vann'], ['eXIf', 'MM\u0000*GPSLatitude'], ['iCCP', 'Vann phone\u0000\u0000x'], ...safe, ['tIME', [7, 234, 10, 27, 12, 0, 0]], ['zTXt', 'Comment\u0000\u0000z'], IDAT, ['iTXt', 'XML:com.adobe.xmp\u0000\u0000\u0000\u0000\u0000x'], IEND],
      'after the end',
    );
    const out = stripPng(dirty)!;
    expect(out).toEqual(png([IHDR, ...safe, IDAT, IEND]));
    for (const s of ['tEXt', 'eXIf', 'GPS', 'Vann', 'tIME', 'zTXt', 'iTXt', 'iCCP', 'after']) expect(text(out)).not.toContain(s);
  });

  it('keeps PLTE and tRNS for a palette picture', () => {
    const p = png([IHDR, ['PLTE', [0, 0, 0, 255, 255, 255]], ['tRNS', [0]], IDAT, IEND]);
    expect(stripPng(p)).toEqual(p);
  });

  it('refuses what it cannot walk', () => {
    expect(stripPng(png([IHDR, IDAT]))).toBeNull(); // no IEND
    expect(stripPng(png([IDAT, IHDR, IEND]))).toBeNull(); // IHDR not first
    expect(stripPng(png([IHDR, IEND]))).toBeNull(); // no image data
    expect(stripPng(png([IHDR, ['ABCD', [1]], IDAT, IEND]))).toBeNull(); // unknown critical chunk
    const cut = png([IHDR, IDAT, IEND]);
    expect(stripPng(cut.slice(0, 40))).toBeNull();
    const long = cut.slice();
    long[8] = 0x7f; // IHDR's length far past the end
    expect(stripPng(long)).toBeNull();
  });
});

describe('WebP metadata', () => {
  it('drops EXIF and XMP chunks, clears their VP8X flags and rewrites the RIFF size', () => {
    const dirty = webp([vp8x(0x08 | 0x04 | 0x10), ['ALPH', [0, 1, 2]], VP8, ['EXIF', 'MM\u0000*GPSLatitude 41.49N'], ['XMP ', '<x:xmpmeta>Vann</x:xmpmeta>']]);
    const out = stripWebp(dirty)!;
    expect(out).toEqual(webp([vp8x(0x10), ['ALPH', [0, 1, 2]], VP8]));
    expect(u32le(out, 4)).toBe(out.length - 8);
    for (const s of ['EXIF', 'GPS', 'XMP', 'Vann']) expect(text(out)).not.toContain(s);
  });

  it('leaves a simple (VP8 only) WebP as it is, and drops what follows the RIFF', () => {
    const p = webp([VP8]);
    expect(stripWebp(p)).toEqual(p);
    expect(stripWebp(new Uint8Array([...p, 1, 2, 3]))).toEqual(p);
  });

  it('refuses what it cannot walk', () => {
    expect(stripWebp(webp([vp8x(0)]))).toBeNull(); // no image chunk
    expect(stripWebp(webp([VP8], 4))).toBeNull(); // RIFF size cuts a chunk
    expect(stripWebp(webp([VP8], 1_000))).toBeNull(); // RIFF size past the end
    expect(stripWebp(webp([VP8, vp8x(0)]))).toBeNull(); // VP8X not first
    expect(stripWebp(webp([['VP8X', [0, 0]], VP8]))).toBeNull(); // VP8X too short
  });
});

it('picks the parser by the claimed type', () => {
  expect(stripImageMetadata(png([IHDR, IDAT, IEND]), 'image/png')).not.toBeNull();
  expect(stripImageMetadata(png([IHDR, IDAT, IEND]), 'image/jpeg')).toBeNull();
  expect(stripImageMetadata(webp([VP8]), 'image/gif')).toBeNull();
});
