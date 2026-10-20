/**
 * Full screen for a chart: one overlay element, opened from a card's expand
 * button. The overlay is always a fixed, full-viewport layer (100dvh); where the
 * browser has element fullscreen (Fullscreen API, or its webkit prefix) it is
 * also asked for, and a refusal or no support (iPhone Safari) just leaves the
 * overlay. Opening pushes one history entry (same URL, so the tab hash stays;
 * the state carries FULL_STATE_KEY) so a back gesture closes it; closing any
 * other way (button, Esc, leaving native fullscreen) pops that entry once.
 * The browser objects come in as small interfaces, so tests can pass stubs.
 */

/** The history state marker of the entry pushed on open. */
export const FULL_STATE_KEY = 'recallFull';

type Listener = (ev: Event) => void;
interface Events {
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string, fn: Listener): void;
}

/** The overlay element, as far as fullscreen needs it. */
export interface FsTarget {
  requestFullscreen?: () => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
}

export interface FsDocument extends Events {
  fullscreenElement?: unknown;
  webkitFullscreenElement?: unknown;
  exitFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
}

export interface FsHistory {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | null): void;
  back(): void;
}

/** 'native': the browser's fullscreen; 'overlay': the fixed layer only. */
export type FsMode = 'native' | 'overlay';
export type FsCloseReason = 'button' | 'escape' | 'back' | 'native-exit' | 'api';

export interface FullscreenOptions {
  doc: FsDocument;
  /** Where popstate arrives (window). */
  win: Events;
  history: FsHistory;
  /** The page's URL now (pushed unchanged, hash and all). */
  href: () => string;
  target: FsTarget;
  /** Show the overlay (synchronously: native fullscreen is asked for right after, in the same gesture). */
  onOpen: () => void;
  /** Hide it again; called once per open. */
  onClose: (reason: FsCloseReason) => void;
  /**
   * Once the browser has left native fullscreen (the exit promise settled or
   * fullscreenchange came), or straight after `onClose` for the overlay alone:
   * the time to put back scroll and focus, which Chrome resets on its way out.
   */
  onSettled?: (reason: FsCloseReason) => void;
}

export interface FullscreenController {
  open(): void;
  close(reason?: FsCloseReason): void;
  readonly isOpen: boolean;
  readonly mode: FsMode | null;
  dispose(): void;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** Whether a history state is the one pushed on open. */
export const isFullState = (s: unknown): boolean => isObject(s) && s[FULL_STATE_KEY] === true;

/**
 * Call a Fullscreen API method, swallowing a rejection (or a throw). `onSettled` runs when
 * its promise settles, or at once on a throw; true if it will run (a promise, or a throw).
 */
function quietly(f: (() => Promise<void> | void) | undefined, self: unknown, onSettled?: () => void): boolean {
  if (!f) return false;
  try {
    const p = f.call(self);
    if (p && typeof p.then === 'function') {
      p.then(
        () => onSettled?.(),
        () => onSettled?.(),
      );
      return true;
    }
    return false;
  } catch {
    onSettled?.();
    return true;
  }
}

export function createFullscreen(o: FullscreenOptions): FullscreenController {
  let open = false;
  let mode: FsMode | null = null;
  /** The entry pushed on open is still there (not yet popped by a back, or by us). */
  let pushed = false;
  /** We called history.back(); its popstate is ours, not a user's back. */
  let ownPop = false;
  /** Closed, waiting for the browser to leave native fullscreen before `onSettled`. */
  let settling: FsCloseReason | null = null;
  let lastClose: FsCloseReason = 'api';

  const fsElement = (): unknown => o.doc.fullscreenElement ?? o.doc.webkitFullscreenElement ?? null;
  /** Leave native fullscreen if it's ours; true if that is under way (settle later). */
  const exitNative = (onDone?: () => void): boolean => {
    if (fsElement() !== o.target) return false;
    const f = o.doc.exitFullscreen ?? o.doc.webkitExitFullscreen;
    if (!f) return false;
    // No promise (old webkit): fullscreenchange settles it.
    quietly(f, o.doc, onDone);
    return true;
  };
  function settle(): void {
    if (settling == null) return;
    const r = settling;
    settling = null;
    o.onSettled?.(r);
  }

  function onFsChange(): void {
    const el = fsElement();
    if (el !== o.target) settle();
    if (el === o.target) {
      if (open) mode = 'native';
      else {
        // Granted after we closed: leave again, and settle (scroll, focus) once out.
        settling ??= lastClose;
        if (!exitNative(settle)) settle();
      }
    } else if (open && mode === 'native') close('native-exit');
  }

  /** Put the open marker back (same URL). Used when a close's pending back() lands after a reopen. */
  function pushMarker(): boolean {
    try {
      const s = o.history.state;
      o.history.pushState({ ...(isObject(s) ? s : {}), [FULL_STATE_KEY]: true }, '', o.href());
      return true;
    } catch {
      return false;
    }
  }

  function onPop(): void {
    if (ownPop) {
      ownPop = false;
      // Reopened before this close's back() landed: the entry just went; put it back.
      if (open) pushed = pushMarker();
      return;
    }
    // Any history move while open (Android back, browser back) closes; the entry is already gone.
    if (!open) return;
    pushed = false;
    close('back');
  }

  function onKey(ev: KeyboardEvent): void {
    if (open && ev.key === 'Escape' && !ev.defaultPrevented) {
      ev.preventDefault();
      close('escape');
    }
  }

  function close(reason: FsCloseReason = 'api'): void {
    if (!open) return;
    open = false;
    mode = null;
    settling = lastClose = reason;
    // Ours (even if its fullscreenchange hasn't come yet): settle once the browser is out.
    const exiting = exitNative(settle);
    if (pushed) {
      pushed = false;
      if (reason !== 'back') {
        ownPop = true;
        o.history.back();
      }
    }
    o.onClose(reason);
    // The overlay alone, or the browser already left fullscreen (its own control): settle now.
    if (!exiting) settle();
  }

  const docOn: [string, Listener][] = [
    ['fullscreenchange', onFsChange],
    ['webkitfullscreenchange', onFsChange],
    ['keydown', onKey as Listener],
  ];
  for (const [t, f] of docOn) o.doc.addEventListener(t, f);
  o.win.addEventListener('popstate', onPop as Listener);

  return {
    open(): void {
      if (open) return;
      open = true;
      mode = 'overlay';
      settling = null; // a late settle must not pull focus out of the new overlay
      if (ownPop) {
        // A previous close already called history.back(); that pop will re-push.
        pushed = false;
      } else {
        pushed = pushMarker();
      }
      o.onOpen();
      const t = o.target;
      // A refusal leaves the overlay as it is.
      quietly(t.requestFullscreen ?? t.webkitRequestFullscreen, t);
    },
    close,
    get isOpen() {
      return open;
    },
    get mode() {
      return mode;
    },
    dispose(): void {
      for (const [t, f] of docOn) o.doc.removeEventListener(t, f);
      o.win.removeEventListener('popstate', onPop as Listener);
    },
  };
}

/**
 * Tab inside the overlay: the element to move focus to so it cycles
 * (last → first, first → last with Shift, or into the overlay from
 * outside), or null to let the browser move it.
 */
export function trapFocus<T>(items: readonly T[], active: T | null, shift: boolean): T | null {
  if (!items.length) return null;
  const i = active == null ? -1 : items.indexOf(active);
  if (i < 0) return shift ? items[items.length - 1] : items[0];
  if (shift && i === 0) return items[items.length - 1];
  if (!shift && i === items.length - 1) return items[0];
  return null;
}

interface ScrollWindow {
  readonly scrollX: number;
  readonly scrollY: number;
  scrollTo(x: number, y: number): void;
}
interface Styled {
  style: { position: string; top: string; left: string; right: string; width: string; overflow: string };
}

/**
 * Hold the page still under the overlay: the body is fixed at its scroll offset
 * (iOS Safari ignores overflow: hidden for touch scrolling). `release` puts the
 * styles and the exact scroll position back; `rescroll` the position again
 * (leaving native fullscreen, Chrome resets it after the release).
 */
export interface ScrollLock {
  release(): void;
  rescroll(): void;
}
export function lockScroll(win: ScrollWindow, body: Styled): ScrollLock {
  const x = win.scrollX;
  const y = win.scrollY;
  const keys = ['position', 'top', 'left', 'right', 'width', 'overflow'] as const;
  const before = keys.map((k) => body.style[k]);
  Object.assign(body.style, { position: 'fixed', top: `${-y}px`, left: `${-x}px`, right: '0', width: '100%', overflow: 'hidden' });
  let held = true;
  return {
    release(): void {
      if (held) keys.forEach((k, i) => (body.style[k] = before[i]));
      held = false;
      win.scrollTo(x, y);
    },
    rescroll(): void {
      if (!held && (win.scrollX !== x || win.scrollY !== y)) win.scrollTo(x, y);
    },
  };
}

/** Move `nodes` into `into` (in order), leaving a placeholder each; returns the undo. */
export function moveNodes(nodes: readonly HTMLElement[], into: HTMLElement): () => void {
  const marks = nodes.map((n) => {
    const m = document.createComment('full screen');
    n.replaceWith(m);
    into.append(n);
    return [m, n] as const;
  });
  return () => {
    for (const [m, n] of marks) m.replaceWith(n);
  };
}

/** Make everything but `keep` among `parent`'s children inert and hidden from AT; returns the undo. */
export function inertOthers(parent: HTMLElement, keep: Element): () => void {
  const done: [HTMLElement, string | null][] = [];
  for (const el of parent.children) {
    if (el === keep || !(el instanceof HTMLElement) || el.tagName === 'SCRIPT' || el.inert) continue;
    done.push([el, el.getAttribute('aria-hidden')]);
    el.inert = true;
    el.setAttribute('aria-hidden', 'true');
  }
  return () => {
    for (const [el, aria] of done) {
      el.inert = false;
      if (aria == null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', aria);
    }
  };
}
