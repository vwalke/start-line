#!/usr/bin/env node
// Renders the Start Line icons from brand/ into public/:
//   favicon.svg / .ico / -32.png    from brand/favicon.svg (the small-size drawing)
//   apple-touch-icon.png            opaque full-bleed square (iOS rounds it)
//   icon-192.png, icon-512.png      the rounded tile as drawn in brand/icon.svg
//   icon-maskable-512.png           full-bleed square, artwork inside the safe zone
//   manifest.webmanifest
//   apps/startline.svg              the app switcher tile
// `--check` regenerates in memory and fails on any stale or missing file (used in CI).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const check = process.argv.includes('--check');

const INK = '#131922';
const CARBON = '#16181c';

const iconSvg = readFileSync(join(root, 'brand', 'icon.svg'), 'utf8');
const faviconSvg = readFileSync(join(root, 'brand', 'favicon.svg'), 'utf8');

// The tile is <g clip-path="url(#tB)"><rect ink/>…artwork…</g>; pull the artwork out
// so the square variants can drop the rounded clip.
const tile = iconSvg.match(/<g clip-path="url\(#tB\)"><rect width="512" height="512" fill="#131922"\/>([\s\S]*)<\/g><\/svg>/);
if (!tile) throw new Error('brand/icon.svg no longer matches the expected tile structure');
const artwork = tile[1];

const svg512 = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="${INK}"/>${body}</svg>`;
const square = svg512(artwork);
// The maskable safe zone is the central circle of radius 40 % (204.8 px at 512). The farthest
// artwork point from the centre is the gold line's left cap (≈ 268 px out), so 0.76 keeps it inside.
const MASKABLE_SCALE = 0.76;
const maskable = svg512(`<g transform="translate(256 256) scale(${MASKABLE_SCALE}) translate(-256 -256)">${artwork}</g>`);

const render = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
const png = (svg, width) => render(svg, width).asPng();

// iOS fills transparent apple-touch-icon pixels with black, so that icon is
// written as an RGB PNG with no alpha channel at all.
function opaquePng(svg, width) {
  const img = render(svg, width);
  const { width: w, height: h, pixels } = img;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (pixels[i + 3] !== 255) throw new Error(`apple-touch-icon pixel ${x},${y} is not opaque`);
      pixels.copy(raw, row + 1 + x * 3, i, i + 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

const manifest = {
  name: 'Start Line',
  short_name: 'Start Line',
  description: 'How your start and each leg went, in one screen. A lean start and leg digest from Vakaros RaceSense public data.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: CARBON,
  background_color: INK,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

const files = [
  ['favicon.svg', Buffer.from(faviconSvg)],
  ['favicon.ico', ico([16, 32, 48].map((size) => ({ size, data: png(faviconSvg, size) })))],
  ['favicon-32.png', png(faviconSvg, 32)],
  ['apple-touch-icon.png', opaquePng(square, 180)],
  ['icon-192.png', png(iconSvg, 192)],
  ['icon-512.png', png(iconSvg, 512)],
  ['icon-maskable-512.png', png(maskable, 512)],
  ['manifest.webmanifest', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ['apps/startline.svg', Buffer.from(iconSvg)],
];

if (check) {
  const problems = files.flatMap(([name, data]) => {
    const path = join(publicDir, name);
    if (!existsSync(path)) return [`public/${name} is missing`];
    return readFileSync(path).equals(data) ? [] : [`public/${name} is stale`];
  });
  if (problems.length) {
    console.error(`Icons out of date. Run npm run icons.\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Icons up to date.');
} else {
  mkdirSync(join(publicDir, 'apps'), { recursive: true });
  for (const [name, data] of files) writeFileSync(join(publicDir, name), data);
  console.log(`Wrote ${files.length} files:\n  ${files.map(([name]) => `public/${name}`).join('\n  ')}`);
}
