/**
 * The short key line under a chart or table: a row of chips (key facts, ⚠
 * caveats, legend swatches) ending in one "How to read this" disclosure that
 * holds the explanations, closed by default. A native <details>: keyboard,
 * touch and screen readers work without script.
 */
import { esc } from './format';

/** Legend swatches, drawn in CSS (style.css `.sw-*`). */
export type Swatch = 'gap' | 'ext' | 'est' | 'nc' | 'dot' | 'bold' | 'band';

export interface Chip {
  text: string;
  /** A caveat: shown as ⚠ in the warning colour, never only in the ⓘ. */
  warn?: boolean;
  /** A legend swatch drawn before the text. */
  swatch?: Swatch;
  /** Extra detail on hover (never the only place a fact lives). */
  title?: string;
}

/** A chart's or table's key line: its chips and its ⓘ bullets. */
export interface KeyLine {
  chips: Chip[];
  bullets: string[];
}

/** A caveat chip. */
export const warnChip = (text: string, title?: string): Chip => ({ text, warn: true, ...(title ? { title } : {}) });

function chipHtml(c: Chip): string {
  const cls = `chip${c.warn ? ' warn' : ''}${c.swatch ? ' key' : ''}`;
  const sw = c.swatch ? `<i class="sw-${c.swatch}" aria-hidden="true"></i>` : '';
  const warn = c.warn ? '<span aria-hidden="true">⚠ </span><span class="vh">Warning: </span>' : '';
  return `<li class="${cls}"${c.title ? ` title="${esc(c.title)}"` : ''}>${sw}${warn}${esc(c.text)}</li>`;
}

/** The disclosure: ⓘ "How to read this", then the bullets (each plain text) and optional extra list `more`. */
export function infoHtml(bullets: readonly string[], opts: { open?: boolean; more?: { title: string; items: readonly string[] } } = {}): string {
  const items = bullets.map((b) => `<li>${esc(b)}</li>`).join('');
  const more = opts.more?.items.length
    ? `<p class="info-sub">${esc(opts.more.title)}</p><ul>${opts.more.items.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
    : '';
  return `<details class="info"${opts.open ? ' open' : ''}><summary><span class="info-i" aria-hidden="true">ⓘ</span><span class="info-lbl">How to read this</span></summary><div class="info-body"><ul>${items}</ul>${more}</div></details>`;
}

/** The key line: chips, then the ⓘ as the row's last item (it takes the full width when open). */
export function capHtml(chips: readonly Chip[], info: string): string {
  return `<ul class="chips">${chips.map(chipHtml).join('')}${info ? `<li class="chip-info">${info}</li>` : ''}</ul>`;
}

const last = new WeakMap<Element, string>();

/**
 * Render `html(open)` into `el`, keeping its disclosure open if the reader
 * opened it, and leaving the DOM alone when nothing changed (it is re-run on
 * every redraw, including each pan frame).
 */
export function renderKeepOpen(el: HTMLElement, html: (open: boolean) => string): void {
  const next = html(!!el.querySelector('details.info[open]'));
  if (last.get(el) === next) return;
  last.set(el, next);
  el.innerHTML = next;
}

/** The markup of a key line: its chips and its ⓘ (open or closed; none without bullets). */
export const keyLineHtml = (k: KeyLine, open = false): string => capHtml(k.chips, k.bullets.length ? infoHtml(k.bullets, { open }) : '');

/** Render a key line into `el`, keeping its ⓘ open across redraws. */
export const renderKeyLine = (el: HTMLElement, k: KeyLine): void => renderKeepOpen(el, (open) => keyLineHtml(k, open));
