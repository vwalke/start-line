/**
 * Images for the Feedback sheet, made in the browser: an upload downscaled to at most 1600 px on its
 * long side, and the course map (an SVG) drawn to a picture. Both come out as WebP where the browser
 * can encode it (else JPEG), under IMAGE_BYTES.
 */

export const IMAGE_MAX_PX = 1600;
export const IMAGE_BYTES = 2_000_000;

/** The size to draw `w`×`h` at so its long side is at most `max` (never scaled up). */
export function fitSize(w: number, h: number, max = IMAGE_MAX_PX): [number, number] {
  if (!(w > 0 && h > 0)) return [0, 0];
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

export interface Encoded {
  type: 'image/webp' | 'image/jpeg' | 'image/png';
  data: string;
  bytes: number;
}

const toBlob = (c: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> => new Promise((r) => c.toBlob(r, type, q));

async function base64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Draw `src` at most `max` px wide or tall and encode it under IMAGE_BYTES (smaller and softer until it fits). */
async function encode(src: CanvasImageSource, w: number, h: number, background?: string): Promise<Encoded | null> {
  for (const [max, q] of [
    [IMAGE_MAX_PX, 0.85],
    [IMAGE_MAX_PX, 0.7],
    [1200, 0.7],
    [900, 0.6],
  ] as const) {
    const [cw, ch] = fitSize(w, h, max);
    if (!cw) return null;
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const g = c.getContext('2d');
    if (!g) return null;
    if (background) {
      g.fillStyle = background;
      g.fillRect(0, 0, cw, ch);
    }
    g.drawImage(src, 0, 0, cw, ch);
    // Safari may hand back a PNG for WebP: then JPEG.
    let b = await toBlob(c, 'image/webp', q);
    if (!b || b.type !== 'image/webp') b = await toBlob(c, 'image/jpeg', q);
    if (b && (b.type === 'image/webp' || b.type === 'image/jpeg') && b.size <= IMAGE_BYTES) return { type: b.type, data: await base64(b), bytes: b.size };
  }
  return null;
}

export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

/** An uploaded picture, downscaled; null when the browser can't read it. */
export async function shrinkImage(file: File): Promise<Encoded | null> {
  if (file.size > 40_000_000) return null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    // JPEG has no transparency: a screenshot's clear parts come out white, not black.
    return await encode(bmp, bmp.width, bmp.height, '#ffffff');
  } finally {
    bmp.close();
  }
}

/** Presentation properties copied onto the map's clone (the page's stylesheet doesn't come along into an image). */
const PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
  'visibility',
  'display',
] as const;

/** Elements past this, the map is too big to copy styles over quickly: not captured. */
export const MAP_MAX_ELEMENTS = 25_000;

/**
 * The course map as a picture: the live SVG cloned with its computed styles inlined, drawn on the
 * page's background colour. Null (with the reason) when it can't be done: none shown, too big, or the
 * browser refuses to draw it.
 */
export async function captureMap(svg: SVGSVGElement): Promise<Encoded | string> {
  const all = svg.querySelectorAll('*');
  if (all.length > MAP_MAX_ELEMENTS) return 'the map has too many shapes to copy';
  const box = svg.getBoundingClientRect();
  const vb = svg.viewBox?.baseVal;
  const w = box.width || vb?.width || 0;
  const h = box.height || vb?.height || 0;
  if (!(w > 0 && h > 0)) return 'the map is not on screen';
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const copies = clone.querySelectorAll('*');
  const inline = (from: Element, to: Element): void => {
    const cs = getComputedStyle(from);
    const out: string[] = [];
    for (const p of PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) out.push(`${p}:${v}`);
    }
    (to as SVGElement).setAttribute('style', out.join(';'));
  };
  inline(svg, clone);
  all.forEach((el, i) => inline(el, copies[i]));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // Twice the on-screen size (sharper), within the image cap.
  const [pw, ph] = fitSize(w * 2, h * 2);
  clone.setAttribute('width', String(pw));
  clone.setAttribute('height', String(ph));
  const bg = getComputedStyle(svg.closest('.card') ?? document.body).backgroundColor || '#ffffff';
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return (await encode(img, pw, ph, bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff')) ?? 'the browser could not encode it';
  } catch {
    return 'the browser would not draw it';
  } finally {
    URL.revokeObjectURL(url);
  }
}
