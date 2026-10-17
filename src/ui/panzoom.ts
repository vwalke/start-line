/**
 * Direct manipulation for a chart drawn from a `View` (see view.ts): pinch,
 * drag, double-tap, Ctrl/⌘ + wheel (trackpad pinch), Safari gesture events
 * and keys. Attach to a container that outlives re-renders; the owner keeps
 * the view and re-renders in `setView`. Plain wheel and one-finger vertical
 * swipes are left to the page (the owner sets `touch-action` by zoom).
 */
import { clampView, clientToChart, fitView, K_MAX, pan, zoomAbout, type Box, type ClientRect, type View } from './view';

export interface PanZoomOptions {
  getBox: () => Box | null;
  getView: () => View;
  setView: (v: View) => void;
  /** The drawn element's rect (default: the container's). */
  getRect?: () => ClientRect;
  /** A clean tap (no drag/pinch), after any double-tap handling. */
  onTap?: (ev: PointerEvent) => void;
}

const TAP_SLOP_PX = 6;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;
const KEY_ZOOM = 1.25;
const KEY_PAN = 0.1;

interface Pt {
  x: number;
  y: number;
}

export function attachPanZoom(el: HTMLElement, opts: PanZoomOptions): () => void {
  const rect = opts.getRect ?? (() => el.getBoundingClientRect());
  const pointers = new Map<number, Pt>();
  let start: Pt | null = null; // first pointer's down position
  let moved = false; // dragged past the slop or pinched, this gesture
  let lastTap: { t: number; x: number; y: number } | null = null;
  let lastClick: (Pt & { t: number }) | null = null;
  let lastTouchUp = -Infinity;
  let suppressAt = -Infinity;
  let lastCtrlWheel = -Infinity;
  let gestureScale = 1;

  /** Apply `f` to the current view with the box, then clamp and hand it back. */
  const update = (f: (box: Box, v: View) => View): void => {
    const box = opts.getBox();
    if (box) opts.setView(clampView(box, f(box, opts.getView())));
  };
  const toChart = (box: Box, v: View, x: number, y: number) => clientToChart(box, v, rect(), x, y);
  const zoomAt = (factor: number, x: number, y: number): void =>
    update((box, v) => {
      const [px, py] = toChart(box, v, x, y);
      return zoomAbout(v, factor, px, py);
    });

  function onDown(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (ev.isPrimary) {
      pointers.clear(); // drop any pointer whose up we missed
      suppressAt = -Infinity; // a touch drag may end without a click to swallow
    }
    if (!pointers.size) {
      start = { x: ev.clientX, y: ev.clientY };
      moved = false;
    }
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size > 1) {
      moved = true; // a pinch is never a tap
      for (const id of pointers.keys()) capture(id);
    }
  }

  // Capture only once a drag or pinch starts: a captured pointer's click
  // targets the container, and a clean tap must still reach the boat.
  function capture(id: number): void {
    try {
      if (!el.hasPointerCapture(id)) el.setPointerCapture(id);
    } catch {
      // Pointer already gone; nothing to capture.
    }
  }

  function onMove(ev: PointerEvent): void {
    const prev = pointers.get(ev.pointerId);
    if (!prev) return;
    const cur = { x: ev.clientX, y: ev.clientY };
    pointers.set(ev.pointerId, cur);
    if (!moved && start && Math.hypot(cur.x - start.x, cur.y - start.y) > TAP_SLOP_PX) {
      moved = true;
      capture(ev.pointerId);
    }
    if (!moved) return;
    const others = [...pointers].filter(([id]) => id !== ev.pointerId).map(([, p]) => p);
    if (others.length) {
      // Pinch: zoom about the old midpoint by the finger-distance ratio, then
      // pan so that chart point follows the midpoint.
      const o = others[0];
      const d0 = Math.hypot(prev.x - o.x, prev.y - o.y);
      const d1 = Math.hypot(cur.x - o.x, cur.y - o.y);
      const m0 = { x: (prev.x + o.x) / 2, y: (prev.y + o.y) / 2 };
      const m1 = { x: (cur.x + o.x) / 2, y: (cur.y + o.y) / 2 };
      update((box, v) => {
        const [ax, ay] = toChart(box, v, m0.x, m0.y);
        const z = zoomAbout(v, d0 > 0 && d1 > 0 ? d1 / d0 : 1, ax, ay);
        const [bx, by] = toChart(box, z, m1.x, m1.y);
        return pan(z, ax - bx, ay - by);
      });
    } else if (opts.getView().k > 1) {
      update((box, v) => {
        const [ax, ay] = toChart(box, v, prev.x, prev.y);
        const [bx, by] = toChart(box, v, cur.x, cur.y);
        return pan(v, ax - bx, ay - by);
      });
      if (ev.pointerType === 'mouse') el.classList.add('grabbing');
    }
  }

  function onUp(ev: PointerEvent): void {
    if (!pointers.delete(ev.pointerId)) return;
    if (pointers.size) return;
    el.classList.remove('grabbing');
    start = null;
    if (ev.type === 'pointercancel') return;
    if (moved) {
      suppressAt = performance.now();
      lastTap = null;
      return;
    }
    if (ev.pointerType !== 'mouse') {
      const t = performance.now();
      lastTouchUp = t;
      const dbl = lastTap && t - lastTap.t < DOUBLE_TAP_MS && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < DOUBLE_TAP_PX;
      lastTap = dbl ? null : { t, x: ev.clientX, y: ev.clientY };
      if (dbl) return doubleTap(ev.clientX, ev.clientY);
    }
    opts.onTap?.(ev);
  }

  function doubleTap(x: number, y: number): void {
    if (opts.getView().k >= K_MAX - 1e-9) update((box) => fitView(box));
    else zoomAt(2, x, y);
  }

  function onDblClick(ev: MouseEvent): void {
    // Touch double-taps are handled from pointer events; some browsers also send dblclick.
    if (performance.now() - lastTouchUp < 1000) return;
    ev.preventDefault();
    doubleTap(ev.clientX, ev.clientY);
  }

  function onClick(ev: MouseEvent): void {
    // One click after a drag or pinch is the gesture's end, not a tap.
    if (performance.now() - suppressAt <= 500) {
      suppressAt = -Infinity;
      ev.stopPropagation();
      ev.preventDefault();
      return;
    }
    // Second click of a double-tap/click: the zoom is the action, not a boat toggle.
    const t = performance.now();
    const second =
      lastClick && t - lastClick.t < DOUBLE_TAP_MS && Math.hypot(ev.clientX - lastClick.x, ev.clientY - lastClick.y) < DOUBLE_TAP_PX;
    lastClick = { t, x: ev.clientX, y: ev.clientY };
    if (second) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  }

  function onWheel(ev: WheelEvent): void {
    if (!ev.ctrlKey && !ev.metaKey) return; // plain wheel scrolls the page
    ev.preventDefault();
    lastCtrlWheel = performance.now();
    const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * 400 : ev.deltaY;
    zoomAt(Math.exp(-dy * 0.01), ev.clientX, ev.clientY);
  }

  // Safari (desktop) trackpad pinch: non-standard GestureEvent with a cumulative scale.
  type GestureLike = Event & { scale: number; clientX: number; clientY: number };
  function onGestureStart(ev: Event): void {
    // Always cancel Safari's page pinch-zoom. If pointer events are already
    // driving the pinch (iOS), skip the scale so we don't zoom twice.
    ev.preventDefault();
    if (pointers.size) return;
    gestureScale = 1;
  }
  function onGestureChange(ev: Event): void {
    ev.preventDefault();
    if (pointers.size) return;
    const g = ev as GestureLike;
    const factor = g.scale / gestureScale;
    gestureScale = g.scale;
    if (performance.now() - lastCtrlWheel < 200 || !Number.isFinite(factor) || factor <= 0) return;
    zoomAt(factor, g.clientX, g.clientY);
  }
  function onGestureEnd(ev: Event): void {
    ev.preventDefault();
  }

  // iOS Safari still page-zooms / pointercancels unless native touch is cancelled.
  // Don't preventDefault on one-finger touchstart: that would swallow tap-to-select.
  function onTouchStart(ev: TouchEvent): void {
    if (ev.touches.length >= 2) ev.preventDefault();
  }
  function onTouchMove(ev: TouchEvent): void {
    if (ev.touches.length >= 2 || opts.getView().k > 1) ev.preventDefault();
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const v = opts.getView();
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = arrows[ev.key];
    if (dir) {
      if (v.k <= 1) return; // nothing to pan at Fit; let the page scroll
      update((box, cur) => {
        const w = (box.x1 - box.x0) / cur.k;
        const h = (box.y1 - box.y0) / cur.k;
        return pan(cur, dir[0] * KEY_PAN * w, dir[1] * KEY_PAN * h);
      });
    } else if (ev.key === '+' || ev.key === '=') update((_box, cur) => zoomAbout(cur, KEY_ZOOM, cur.cx, cur.cy));
    else if (ev.key === '-' || ev.key === '_') update((_box, cur) => zoomAbout(cur, 1 / KEY_ZOOM, cur.cx, cur.cy));
    else if (ev.key === '0') update((box) => fitView(box));
    else return;
    ev.preventDefault();
  }

  const on: [string, EventListener, AddEventListenerOptions?][] = [
    ['pointerdown', onDown as EventListener],
    ['pointermove', onMove as EventListener],
    ['pointerup', onUp as EventListener],
    ['pointercancel', onUp as EventListener],
    ['dblclick', onDblClick as EventListener],
    ['click', onClick as EventListener, { capture: true }],
    ['wheel', onWheel as EventListener, { passive: false }],
    ['gesturestart', onGestureStart, { passive: false }],
    ['gesturechange', onGestureChange, { passive: false }],
    ['gestureend', onGestureEnd, { passive: false }],
    ['touchstart', onTouchStart as EventListener, { passive: false }],
    ['touchmove', onTouchMove as EventListener, { passive: false }],
    ['keydown', onKey as EventListener],
  ];
  for (const [type, fn, o] of on) el.addEventListener(type, fn, o);
  return () => {
    for (const [type, fn, o] of on) el.removeEventListener(type, fn, o);
  };
}
