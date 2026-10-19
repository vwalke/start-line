/**
 * A second horizontal scrollbar above a wide table: a thin scroller (`mirror`)
 * holding one spacer as wide as the table, kept in step with the table's own
 * scroller (`wrap`) both ways. Hidden when nothing overflows. The mirror is
 * `aria-hidden`: it duplicates the table's own scrolling for pointer users.
 */

/** What the mirror needs from the DOM (a subset of HTMLElement, so it can be faked in tests). */
export interface ScrollEl {
  scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  hidden: boolean;
  addEventListener(type: 'scroll', fn: () => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: 'scroll', fn: () => void, opts?: EventListenerOptions): void;
}

export interface TopScroll {
  /** Re-measure after the table is re-rendered or resized. */
  update(): void;
  /** Drop the scroll listeners and ResizeObserver. The page-lifetime attach does not need this. */
  disconnect(): void;
}

/** Sync `mirror` (with spacer `spacer`) to `wrap`; returns `update` for re-renders. Observes resizes where it can. */
export function attachTopScroll(mirror: ScrollEl, spacer: { style: { width: string } }, wrap: ScrollEl): TopScroll {
  // Each side copies the other's position; the echo finds them equal and stops.
  const follow = (from: ScrollEl, to: ScrollEl): void => {
    if (Math.abs(to.scrollLeft - from.scrollLeft) >= 1) to.scrollLeft = from.scrollLeft;
  };
  const onWrap = (): void => follow(wrap, mirror);
  const onMirror = (): void => follow(mirror, wrap);
  wrap.addEventListener('scroll', onWrap, { passive: true });
  mirror.addEventListener('scroll', onMirror, { passive: true });
  const update = (): void => {
    const over = wrap.scrollWidth - wrap.clientWidth > 1;
    mirror.hidden = !over;
    spacer.style.width = `${wrap.scrollWidth}px`;
    if (over) mirror.scrollLeft = wrap.scrollLeft;
  };
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined' && typeof Element !== 'undefined' && wrap instanceof Element) {
    ro = new ResizeObserver(update);
    ro.observe(wrap);
  }
  return {
    update,
    disconnect(): void {
      wrap.removeEventListener('scroll', onWrap);
      mirror.removeEventListener('scroll', onMirror);
      ro?.disconnect();
    },
  };
}
