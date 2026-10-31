import { describe, expect, it } from 'vitest';
import { keepScroll, type ScrollNode } from '../src/ui/keepScroll';

/** A stand-in element: its scroll offsets clamp to `max` as a browser's do. */
interface Node extends ScrollNode {
  children: Node[];
}
function el(tagName: string, opts: { id?: string; cls?: string; max?: number } = {}, children: Node[] = []): Node {
  let left = 0;
  let top = 0;
  const max = opts.max ?? 10_000;
  return {
    tagName,
    id: opts.id ?? '',
    className: opts.cls ?? '',
    children,
    get scrollLeft() {
      return left;
    },
    set scrollLeft(v: number) {
      left = Math.max(0, Math.min(max, v));
    },
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(max, v));
    },
  };
}

/** The digest as the race view builds it: the boat list (a chip strip inside), the two tables, a chart. */
const boatList = (): Node => el('ASIDE', { id: 'boat-list', cls: 'boatbar' }, [el('DIV', { cls: 'boats-head' }), el('UL', { cls: 'boat-items' })]);
const table = (id: string): Node => el('DIV', { id, cls: 'tablewrap' }, [el('TABLE', { cls: 'metrics' })]);
const digest = (): Node =>
  el('MAIN', { id: 'digest' }, [
    boatList(),
    el('DIV', { id: 'panel-start', cls: 'panel' }, [table('start-table')]),
    el('DIV', { id: 'panel-race', cls: 'panel' }, [el('svg'), table('table')]),
  ]);

describe('a live refresh keeps the boat list and tables scrolled (keepScroll)', () => {
  it('puts back the chip strip, the sidebar and both tables after their contents are rebuilt', () => {
    const root = digest();
    const strip = (r: Node): Node => r.children[0].children[1];
    const legs = (r: Node): Node => r.children[2].children[1];
    const start = (r: Node): Node => r.children[1].children[0];
    strip(root).scrollLeft = 340;
    root.children[0].scrollTop = 120;
    legs(root).scrollLeft = 515;
    start(root).scrollLeft = 80;
    // render(): innerHTML replaced, new elements at 0.
    keepScroll(root, () => {
      root.children = digest().children;
      expect(strip(root).scrollLeft).toBe(0);
    });
    expect(strip(root).scrollLeft).toBe(340);
    expect(root.children[0].scrollTop).toBe(120);
    expect(legs(root).scrollLeft).toBe(515);
    expect(start(root).scrollLeft).toBe(80);
  });

  it('finds an element among same-kind siblings by its place, and leaves alone what is gone or was not scrolled', () => {
    const root = el('MAIN', {}, [el('DIV', { cls: 'tablewrap' }), el('DIV', { cls: 'tablewrap' })]);
    root.children[1].scrollLeft = 200;
    keepScroll(root, () => {
      root.children = [el('DIV', { cls: 'tablewrap' }), el('DIV', { cls: 'tablewrap' })];
    });
    expect(root.children.map((c) => c.scrollLeft)).toEqual([0, 200]);
    // The scrolled one gone after the render: nothing to put back, no error.
    root.children[1].scrollLeft = 90;
    keepScroll(root, () => {
      root.children = [el('DIV', { cls: 'tablewrap' })];
    });
    expect(root.children[0].scrollLeft).toBe(0);
  });

  it('a list grown or shrunk keeps the offset as far as it can (the browser clamps)', () => {
    const root = el('MAIN', {}, [el('UL', { cls: 'boat-items', max: 1000 })]);
    root.children[0].scrollLeft = 900;
    keepScroll(root, () => {
      root.children = [el('UL', { cls: 'boat-items', max: 600 })];
    });
    expect(root.children[0].scrollLeft).toBe(600);
  });

  it('does not look into charts (SVG)', () => {
    const inner = el('g');
    let read = 0;
    Object.defineProperty(inner, 'scrollLeft', {
      get: () => {
        read++;
        return 0;
      },
    });
    const root = el('MAIN', {}, [el('svg', {}, [inner])]);
    keepScroll(root, () => undefined);
    expect(read).toBe(0);
  });
});
