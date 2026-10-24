import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIGHTBOX_ID, startLightbox } from '../src/landing/lightbox';
import { BUDGET, NOT_NAMES, SHOTS, THUMB_H, THUMB_W, filesOf, nameIn, scrub } from '../scripts/landing-thumbs.mjs';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const html = readFileSync(here('../index.html'), 'utf8');
const css = readFileSync(here('../src/style.css'), 'utf8');
const landing = html.slice(html.indexOf('<main id="landing"'), html.indexOf('</main>', html.indexOf('<main id="landing"')) + 7);
const cards = [...landing.matchAll(/<li class="land-card">([\s\S]*?)<\/li>/g)].map((m) => m[1]);

/** A tag's attributes (double-quoted, as index.html writes them). */
const attrsOf = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/\s([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const unescape = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** Width and height from a WebP file's header (lossy VP8, lossless VP8L or extended VP8X). */
function webpSize(b: Buffer): { w: number; h: number } | null {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const v = b.readUInt32LE(21);
    return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
  }
  return null;
}

describe('the feature cards: one thumbnail each (index.html)', () => {
  it('has a card for every shot of scripts/landing-thumbs.mjs, in order', () => {
    expect(cards).toHaveLength(SHOTS.length);
    expect(cards.map((c) => c.match(/<h3>([^<]+)<\/h3>/)?.[1])).toEqual(SHOTS.map((s) => s.card));
  });

  it('every card has exactly one thumbnail button, above its heading, that opens the dialog', () => {
    SHOTS.forEach(({ slug, card }, i) => {
      const c = cards[i];
      const buttons = [...c.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
      expect(buttons, card).toHaveLength(1);
      expect(c.match(/class="land-thumb"/g), card).toHaveLength(1);
      expect(c.indexOf('class="land-thumb"'), card).toBeLessThan(c.indexOf('<h3>'));
      const a = attrsOf(buttons[0]);
      expect(a, card).toMatchObject({ type: 'button', class: 'land-thumb', 'aria-haspopup': 'dialog', 'aria-controls': LIGHTBOX_ID, 'data-full': `/landing/${filesOf(slug).full}` });
      expect(unescape(a['data-caption'] ?? '').length, card).toBeGreaterThan(5);
    });
  });

  it('each thumbnail is a lazy image with 1x and 2x files, its box reserved, and a real description', () => {
    const alts = SHOTS.map(({ slug, card }, i) => {
      const imgs = [...cards[i].matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
      expect(imgs, card).toHaveLength(1);
      const a = attrsOf(imgs[0]);
      const f = filesOf(slug);
      expect(a, card).toMatchObject({
        src: `/landing/${f.thumb}`,
        srcset: `/landing/${f.thumb} 1x, /landing/${f.thumb2x} 2x`,
        width: String(THUMB_W),
        height: String(THUMB_H),
        loading: 'lazy',
        decoding: 'async',
      });
      expect(unescape(a.alt ?? '').trim().length, card).toBeGreaterThan(30);
      return a.alt;
    });
    expect(new Set(alts).size).toBe(alts.length);
  });

  it('loads no full-size image with the page: only the thumbnails are in the markup', () => {
    for (const { slug } of SHOTS) {
      expect(html).not.toContain(`src="/landing/${filesOf(slug).full}"`);
      expect(html).not.toContain(`/landing/${filesOf(slug).full} `);
    }
    expect(landing).toMatch(/<img class="land-lb-img" alt="" \/>/);
  });

  it('keeps the hero as it was', () => {
    expect(landing).toMatch(/<img src="\/landing-hero\.svg" width="\d+" height="\d+" alt="[^"]+" fetchpriority="high" \/>/);
  });

  it('has one lightbox dialog in the landing page, labelled by its caption, with a close button', () => {
    expect(landing.match(/<dialog\b/g)).toHaveLength(1);
    const tag = landing.match(/<dialog\b[^>]*>/)![0];
    expect(attrsOf(tag)).toMatchObject({ id: LIGHTBOX_ID, 'aria-labelledby': 'land-lb-title' });
    expect(landing).toContain('id="land-lb-title"');
    expect(landing).toMatch(/<button type="button" class="land-lb-close" aria-label="Close"/);
  });

  it('animates the lightbox only without prefers-reduced-motion: reduce', () => {
    const at = css.indexOf('@media (prefers-reduced-motion: no-preference)', css.indexOf('.land-lb'));
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf('\n}', at));
    expect(block).toContain('animation: land-lb-in');
    expect(css.replace(block, '').match(/animation:\s*land-lb/g)).toBeNull();
  });
});

describe('the thumbnails and full-size images (public/landing/, from scripts/landing-thumbs.mjs)', () => {
  it('are all there, as WebP at their sizes and within their budgets', () => {
    for (const { slug } of SHOTS) {
      const f = filesOf(slug);
      for (const [name, size, budget] of [
        [f.thumb, { w: THUMB_W, h: THUMB_H }, BUDGET.thumb],
        [f.thumb2x, { w: THUMB_W * 2, h: THUMB_H * 2 }, BUDGET.thumb],
        [f.full, null, BUDGET.full],
      ] as const) {
        const path = here(`../public/landing/${name}`);
        expect(existsSync(path), name).toBe(true);
        expect(statSync(path).size, name).toBeLessThanOrEqual(budget);
        const got = webpSize(readFileSync(path));
        expect(got, name).not.toBeNull();
        if (size) expect(got, name).toEqual(size);
        else expect(got!.w, name).toBeLessThanOrEqual(1280);
      }
    }
  });
});

describe('the screenshot script keeps names out', () => {
  it('drops boat names and personal fields at any depth, keeps sail numbers, and collects what it dropped (but not short codes)', () => {
    const names = new Map<string, string>();
    const doc = {
      deviceSubs: [{ user: 'subscriber' }],
      divisions: [{ name: 'Open', participants: [{ sailNumber: 'USA 1', boatName: 'Sea Dog' }, { sailNumber: 'USA 2', boatName: 'Coach RIB' }] }],
      rows: [{ sailNumber: '42', name: 'Wind Fall', placeClass: 1, ownerName: 'Pat Doe', crew: [{ firstName: 'Alex', lastName: 'Ray', nation: 'USA' }] }],
    };
    expect(scrub(doc, names)).toEqual({
      deviceSubs: [],
      divisions: [{ name: 'Open', participants: [{ sailNumber: 'USA 1' }, { sailNumber: 'USA 2', boatName: 'Coach' }] }],
      rows: [{ sailNumber: '42', placeClass: 1 }],
    });
    expect([...names.keys()].sort()).toEqual(['Alex', 'Alex Ray', 'Coach RIB', 'Pat Doe', 'Sea Dog', 'Wind Fall', 'subscriber']);
    expect(names.get('Sea Dog')).toBe('divisions[].participants[].boatName');
    expect(names.get('Alex Ray')).toBe('rows[].crew[] (first + last)');
  });

  it('looks for a removed name as whole words, case as written, and skips the app’s own one-word words', () => {
    expect(nameIn('Boat report: Pat Doe, USA 833', 'Pat Doe')).toBe(true);
    expect(nameIn('<b>PROGRESS</b>', 'PROGRESS')).toBe(true);
    // The legs table's Prog column title, and a mark rounding: the app's words, not the names.
    expect(nameIn('Beat 1: progress ratio — the straight line', 'PROGRESS')).toBe(false);
    expect(nameIn('Rounded the windward mark 4 s faster', 'Mark')).toBe(false);
    expect(nameIn('Doers and Pat Doering', 'Pat Doe')).toBe(false);
    expect(NOT_NAMES.has('Mark')).toBe(true);
    for (const n of NOT_NAMES) expect(n, n).not.toMatch(/\s/);
  });
});

// ---- the lightbox, on stubs (the repo has no DOM library) -------------------------------------------------------

type Fn = (ev: Event) => void;

class Target {
  ls = new Map<string, Set<Fn>>();
  addEventListener(t: string, f: Fn): void {
    if (!this.ls.has(t)) this.ls.set(t, new Set());
    this.ls.get(t)!.add(f);
  }
  removeEventListener(t: string, f: Fn): void {
    this.ls.get(t)?.delete(f);
  }
  fire(t: string, ev: Record<string, unknown> = {}): void {
    for (const f of [...(this.ls.get(t) ?? [])]) f(ev as unknown as Event);
  }
  count(): number {
    return [...this.ls.values()].reduce((n, s) => n + s.size, 0);
  }
}

class FakeEl extends Target {
  attrs = new Map<string, string>();
  textContent = '';
  alt = '';
  kids: Record<string, FakeEl> = {};
  up: Record<string, FakeEl> = {};
  constructor(private doc: FakeDoc) {
    super();
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  get src(): string {
    return this.attrs.get('src') ?? '';
  }
  set src(v: string) {
    this.attrs.set('src', v);
  }
  querySelector(s: string): FakeEl | null {
    return this.kids[s] ?? null;
  }
  closest(s: string): FakeEl | null {
    return this.up[s] ?? null;
  }
  focus(): void {
    this.doc.activeElement = this;
  }
}

class FakeDialog extends FakeEl {
  open = false;
  showModal(): void {
    if (this.open) throw new Error('InvalidStateError: already open');
    this.open = true;
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.fire('close');
  }
}

class FakeDoc extends Target {
  activeElement: unknown = null;
  documentElement = { style: { overflow: 'scroll' } };
  byId: Record<string, FakeEl> = {};
  thumbs: FakeEl[] = [];
  getElementById(id: string): FakeEl | null {
    return this.byId[id] ?? null;
  }
  querySelectorAll(s: string): FakeEl[] {
    return s === '.land-thumb' ? this.thumbs : [];
  }
}

function setup(withDialog = true) {
  const doc = new FakeDoc();
  const dialog = new FakeDialog(doc);
  const [img, title, line, close, fig] = [0, 1, 2, 3, 4].map(() => new FakeEl(doc));
  dialog.kids = { '.land-lb-img': img, '.land-lb-title': title, '.land-lb-line': line, '.land-lb-close': close };
  if (withDialog) doc.byId[LIGHTBOX_ID] = dialog;
  const thumb = (slug: string, heading: string, alt: string): FakeEl => {
    const btn = new FakeEl(doc);
    btn.setAttribute('data-full', `/landing/${slug}.webp`);
    btn.setAttribute('data-caption', `${heading}: the caption line.`);
    const i = new FakeEl(doc);
    i.alt = alt;
    const h3 = new FakeEl(doc);
    h3.textContent = ` ${heading} `;
    const card = new FakeEl(doc);
    card.kids = { h3 };
    btn.kids = { img: i };
    btn.up = { '.land-card': card };
    return btn;
  };
  doc.thumbs = [thumb('start', 'The start', 'The start chart at the gun.'), thumb('places', 'Place changes', 'The place changes chart.')];
  startLightbox(doc as unknown as Document);
  return { doc, dialog, img, title, line, close, fig, thumbs: doc.thumbs };
}

describe('the lightbox (src/landing/lightbox.ts)', () => {
  it('opens on a thumbnail click with its full image, the description, the card heading and caption; focus on Close', () => {
    const t = setup();
    t.thumbs[0].focus();
    t.thumbs[0].fire('click');
    expect(t.dialog.open).toBe(true);
    expect(t.img.src).toBe('/landing/start.webp');
    expect(t.img.alt).toBe('The start chart at the gun.');
    expect(t.title.textContent).toBe('The start');
    expect(t.line.textContent).toBe('The start: the caption line.');
    expect(t.doc.activeElement).toBe(t.close);
  });

  it('locks the page scroll while open and puts back exactly what was there', () => {
    const t = setup();
    expect(t.doc.documentElement.style.overflow).toBe('scroll');
    t.thumbs[0].fire('click');
    expect(t.doc.documentElement.style.overflow).toBe('hidden');
    t.close.fire('click');
    expect(t.doc.documentElement.style.overflow).toBe('scroll');
    t.doc.documentElement.style.overflow = '';
    t.thumbs[1].fire('click');
    t.dialog.close();
    expect(t.doc.documentElement.style.overflow).toBe('');
  });

  it('closes on the close button, and focus goes back to the thumbnail', () => {
    const t = setup();
    t.thumbs[1].fire('click');
    t.close.fire('click');
    expect(t.dialog.open).toBe(false);
    expect(t.doc.activeElement).toBe(t.thumbs[1]);
  });

  it('closes on Esc (the dialog’s cancel)', () => {
    const t = setup();
    t.thumbs[0].fire('click');
    let prevented = false;
    t.dialog.fire('cancel', { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(t.dialog.open).toBe(false);
    expect(t.doc.activeElement).toBe(t.thumbs[0]);
    expect(t.doc.documentElement.style.overflow).toBe('scroll');
  });

  it('closes on a backdrop click, not on a click on the image or caption', () => {
    const t = setup();
    t.thumbs[0].fire('click');
    t.dialog.fire('click', { target: t.img });
    t.dialog.fire('click', { target: t.fig });
    expect(t.dialog.open).toBe(true);
    t.dialog.fire('click', { target: t.dialog });
    expect(t.dialog.open).toBe(false);
    expect(t.doc.activeElement).toBe(t.thumbs[0]);
  });

  it('shows the next image after another thumbnail, and ignores a click while already open', () => {
    const t = setup();
    t.thumbs[0].fire('click');
    t.thumbs[1].fire('click');
    expect(t.img.src).toBe('/landing/start.webp');
    t.close.fire('click');
    t.thumbs[1].fire('click');
    expect(t.img.src).toBe('/landing/places.webp');
    expect(t.title.textContent).toBe('Place changes');
    t.close.fire('click');
    expect(t.doc.activeElement).toBe(t.thumbs[1]);
  });

  it('does nothing on a page without the dialog', () => {
    const t = setup(false);
    expect(t.thumbs.every((b) => b.count() === 0)).toBe(true);
  });
});
