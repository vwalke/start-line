/**
 * Scroll offsets kept across a re-render that rebuilds elements' contents (a live race's refresh, app.ts swapLive): the
 * boat list's chip strip, the tables' sideways scroll, any scrolled box under `root`. Each scrolled element is found
 * again after `render` by its path from `root` (tag, id, first class and place among such siblings) and put back; one
 * gone stays gone, one now shorter is clamped by the browser. Charts (SVG) aren't looked into.
 */

/** What keepScroll reads of an element (an HTMLElement; a plain object in tests). */
export interface ScrollNode {
  readonly tagName: string;
  readonly id: string;
  readonly className: unknown;
  readonly children: ArrayLike<ScrollNode>;
  scrollLeft: number;
  scrollTop: number;
}

/** "DIV#table", "UL.boat-items": an element's kind among its siblings. */
function sig(n: ScrollNode): string {
  const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/)[0] : '';
  return `${n.tagName}${n.id ? `#${n.id}` : ''}${cls ? `.${cls}` : ''}`;
}

const isSvg = (n: ScrollNode): boolean => n.tagName.toLowerCase() === 'svg';

interface Kept {
  path: { sig: string; nth: number }[];
  left: number;
  top: number;
}

function collect(n: ScrollNode, path: Kept['path'], out: Kept[]): void {
  if (n.scrollLeft || n.scrollTop) out.push({ path, left: n.scrollLeft, top: n.scrollTop });
  const seen = new Map<string, number>();
  for (let i = 0; i < n.children.length; i++) {
    const c = n.children[i];
    const s = sig(c);
    const nth = seen.get(s) ?? 0;
    seen.set(s, nth + 1);
    if (!isSvg(c)) collect(c, [...path, { sig: s, nth }], out);
  }
}

function find(root: ScrollNode, path: Kept['path']): ScrollNode | null {
  let cur: ScrollNode | null = root;
  for (const step of path) {
    let nth = 0;
    let next: ScrollNode | null = null;
    for (let i = 0; i < cur.children.length && !next; i++) {
      const c: ScrollNode = cur.children[i];
      if (sig(c) === step.sig && nth++ === step.nth) next = c;
    }
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** Run `render` with every scroll offset under `root` (root's own included) as it was before. */
export function keepScroll(root: ScrollNode, render: () => void): void {
  const kept: Kept[] = [];
  collect(root, [], kept);
  render();
  for (const k of kept) {
    const n = find(root, k.path);
    if (!n) continue;
    if (n.scrollLeft !== k.left) n.scrollLeft = k.left;
    if (n.scrollTop !== k.top) n.scrollTop = k.top;
  }
}
