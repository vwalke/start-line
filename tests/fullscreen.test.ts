import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FULL_STATE_KEY, createFullscreen, isFullState, lockScroll, trapFocus, type FsCloseReason, type FsTarget } from '../src/ui/fullscreen';

type Fn = (ev: Event) => void;

/** Event target stub: listeners by type, and `fire`. */
class Target {
  ls = new Map<string, Set<Fn>>();
  addEventListener(t: string, f: Fn): void {
    if (!this.ls.has(t)) this.ls.set(t, new Set());
    this.ls.get(t)!.add(f);
  }
  removeEventListener(t: string, f: Fn): void {
    this.ls.get(t)?.delete(f);
  }
  fire(t: string, ev: Partial<Event> & Record<string, unknown> = {}): void {
    for (const f of [...(this.ls.get(t) ?? [])]) f(ev as unknown as Event);
  }
  count(): number {
    return [...this.ls.values()].reduce((n, s) => n + s.size, 0);
  }
}

class FakeDoc extends Target {
  fullscreenElement: unknown = null;
  webkitFullscreenElement: unknown = null;
  webkitExitFullscreen?: () => void;
  exits = 0;
  exitFullscreen = (): Promise<void> => {
    this.exits++;
    this.fullscreenElement = null;
    return Promise.resolve();
  };
}

/** History stub: a stack of entries; `back` pops and fires popstate on the window asynchronously (as browsers do). */
class FakeHistory {
  entries: unknown[] = [{ tab: 1 }];
  urls: (string | null | undefined)[] = ['https://x/?race=3#start'];
  i = 0;
  pending: (() => void)[] = [];
  constructor(private win: Target) {}
  get state(): unknown {
    return this.entries[this.i];
  }
  pushState(data: unknown, _t: string, url?: string | null): void {
    this.entries = [...this.entries.slice(0, this.i + 1), data];
    this.urls = [...this.urls.slice(0, this.i + 1), url];
    this.i++;
  }
  back(): void {
    this.pending.push(() => this.userBack());
  }
  /** A back gesture (or the browser's button): the entry changes, then popstate. */
  userBack(): void {
    if (this.i === 0) return;
    this.i--;
    this.win.fire('popstate', { state: this.state } as never);
  }
  flush(): void {
    const p = this.pending;
    this.pending = [];
    for (const f of p) f();
  }
}

function setup(target: FsTarget = {}) {
  const doc = new FakeDoc();
  const win = new Target();
  const history = new FakeHistory(win);
  const log: string[] = [];
  const closes: FsCloseReason[] = [];
  const fs = createFullscreen({
    doc,
    win,
    history,
    href: () => 'https://x/?race=3#start',
    target,
    onOpen: () => log.push('open'),
    onClose: (r) => {
      log.push(`close:${r}`);
      closes.push(r);
    },
    onSettled: (r) => log.push(`settled:${r}`),
  });
  return { doc, win, history, log, closes, fs, target };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('full screen controller', () => {
  it('opens once, pushing one same-URL history entry that keeps the old state and adds the marker', () => {
    const { fs, history, log } = setup();
    fs.open();
    fs.open();
    expect(fs.isOpen).toBe(true);
    expect(log).toEqual(['open']);
    expect(history.entries).toHaveLength(2);
    expect(history.state).toEqual({ tab: 1, [FULL_STATE_KEY]: true });
    expect(isFullState(history.state)).toBe(true);
    expect(isFullState(history.entries[0])).toBe(false);
    expect(history.urls[1]).toBe('https://x/?race=3#start');
  });

  it('the close button closes and pops the pushed entry once; its popstate is not a second close', () => {
    const { fs, history, closes } = setup();
    fs.open();
    fs.close('button');
    fs.close('button');
    expect(fs.isOpen).toBe(false);
    expect(closes).toEqual(['button']);
    expect(history.pending).toHaveLength(1);
    history.flush();
    expect(history.i).toBe(0);
    expect(closes).toEqual(['button']);
  });

  it('Esc closes and pops history; other keys and Esc while closed do nothing', () => {
    const { fs, doc, history, closes } = setup();
    doc.fire('keydown', { key: 'Escape', defaultPrevented: false, preventDefault: () => {} } as never);
    expect(closes).toEqual([]);
    fs.open();
    doc.fire('keydown', { key: 'a', defaultPrevented: false, preventDefault: () => {} } as never);
    expect(fs.isOpen).toBe(true);
    let prevented = false;
    doc.fire('keydown', { key: 'Escape', defaultPrevented: false, preventDefault: () => (prevented = true) } as never);
    expect(prevented).toBe(true);
    expect(closes).toEqual(['escape']);
    history.flush();
    expect(history.i).toBe(0);
  });

  it('back (popstate) closes without popping again: no navigation loop', () => {
    const { fs, history, closes } = setup();
    fs.open();
    history.userBack();
    expect(fs.isOpen).toBe(false);
    expect(closes).toEqual(['back']);
    expect(history.pending).toHaveLength(0);
    expect(history.i).toBe(0);
    // A later popstate with the overlay shut is left alone.
    history.userBack();
    expect(closes).toEqual(['back']);
  });

  it('opens again cleanly after a close, with one entry per open', () => {
    const { fs, history, closes } = setup();
    for (let n = 0; n < 3; n++) {
      fs.open();
      fs.close('button');
      history.flush();
    }
    fs.open();
    history.userBack();
    expect(closes).toEqual(['button', 'button', 'button', 'back']);
    expect(history.i).toBe(0);
  });

  it('reopen before the close\'s back() lands: the leftover pop does not close, and history stays one entry', () => {
    const { fs, history, closes } = setup();
    fs.open();
    fs.close('button');
    fs.open();
    history.flush();
    expect(fs.isOpen).toBe(true);
    expect(closes).toEqual(['button']);
    expect(history.i).toBe(1);
    expect(isFullState(history.state)).toBe(true);
    fs.close('escape');
    history.flush();
    expect(history.i).toBe(0);
    expect(closes).toEqual(['button', 'escape']);
  });

  it('falls back to the overlay when the Fullscreen API is missing', () => {
    const { fs } = setup({});
    fs.open();
    expect(fs.mode).toBe('overlay');
  });

  it('asks for native fullscreen (or the webkit prefix) after showing the overlay', async () => {
    const order: string[] = [];
    const doc = new FakeDoc();
    const win = new Target();
    const target: FsTarget = {
      webkitRequestFullscreen: () => {
        order.push('request');
        doc.fullscreenElement = target;
        doc.fire('fullscreenchange');
      },
    };
    const fs = createFullscreen({ doc, win, history: new FakeHistory(win), href: () => 'u', target, onOpen: () => order.push('open'), onClose: () => {} });
    fs.open();
    expect(order).toEqual(['open', 'request']);
    expect(fs.mode).toBe('native');
    fs.close('button');
    expect(doc.exits).toBe(1);
    await tick();
  });

  it('stays an overlay when requestFullscreen rejects or throws', async () => {
    const rejecting = setup({ requestFullscreen: () => Promise.reject(new Error('denied')) });
    rejecting.fs.open();
    await tick();
    expect(rejecting.fs.isOpen).toBe(true);
    expect(rejecting.fs.mode).toBe('overlay');
    const throwing = setup({
      requestFullscreen: () => {
        throw new TypeError('not allowed');
      },
    });
    throwing.fs.open();
    expect(throwing.fs.isOpen).toBe(true);
    expect(throwing.fs.mode).toBe('overlay');
  });

  it("closes when the browser's own control leaves native fullscreen, popping history once", () => {
    const s = setup();
    s.target.requestFullscreen = () => {
      s.doc.fullscreenElement = s.target;
      s.doc.fire('fullscreenchange');
    };
    s.fs.open();
    expect(s.fs.mode).toBe('native');
    s.doc.fullscreenElement = null;
    s.doc.fire('fullscreenchange');
    expect(s.closes).toEqual(['native-exit']);
    expect(s.doc.exits).toBe(0);
    s.history.flush();
    expect(s.history.i).toBe(0);
    expect(s.closes).toEqual(['native-exit']);
    // The webkit event after the standard one is a no-op.
    s.doc.fire('webkitfullscreenchange');
    expect(s.closes).toEqual(['native-exit']);
  });

  it('leaves native fullscreen if it is granted after the overlay was closed', async () => {
    let grant: () => void = () => {};
    const s = setup();
    s.target.requestFullscreen = () =>
      new Promise<void>((res) => {
        grant = () => {
          s.doc.fullscreenElement = s.target;
          s.doc.fire('fullscreenchange');
          res();
        };
      });
    s.fs.open();
    s.fs.close('button');
    grant();
    await tick();
    expect(s.doc.exits).toBe(1);
    expect(s.closes).toEqual(['button']);
  });

  it('still works without history (pushState throws)', () => {
    const s = setup();
    s.history.pushState = () => {
      throw new Error('SecurityError');
    };
    s.fs.open();
    s.fs.close('escape');
    expect(s.history.pending).toHaveLength(0);
    expect(s.closes).toEqual(['escape']);
  });

  it('overlay alone: settles (scroll and focus back) right after closing', () => {
    const { fs, log } = setup();
    fs.open();
    fs.close('escape');
    expect(log).toEqual(['open', 'close:escape', 'settled:escape']);
  });

  it('native: settles only once the exit promise resolves, after closing, and only once', async () => {
    const s = setup();
    let finish: () => void = () => {};
    s.target.requestFullscreen = () => {
      s.doc.fullscreenElement = s.target;
      s.doc.fire('fullscreenchange');
    };
    // An exit that completes later (as Chrome's does): the element stays fullscreen until then.
    s.doc.exitFullscreen = () => {
      s.doc.exits++;
      return new Promise<void>((res) => {
        finish = () => {
          s.doc.fullscreenElement = null;
          s.doc.fire('fullscreenchange');
          res();
        };
      });
    };
    s.fs.open();
    s.fs.close('escape');
    expect(s.doc.exits).toBe(1);
    expect(s.log).toEqual(['open', 'close:escape']);
    await tick();
    expect(s.log).toEqual(['open', 'close:escape']);
    finish();
    await tick();
    expect(s.log).toEqual(['open', 'close:escape', 'settled:escape']);
  });

  it('native: an exit with no promise (old webkit) settles on the fullscreenchange', () => {
    const s = setup();
    s.target.webkitRequestFullscreen = () => {
      s.doc.webkitFullscreenElement = s.target;
      s.doc.fire('webkitfullscreenchange');
    };
    const doc = s.doc;
    doc.exitFullscreen = undefined as never;
    doc.webkitExitFullscreen = () => {};
    s.fs.open();
    expect(s.fs.mode).toBe('native');
    s.fs.close('button');
    expect(s.log).toEqual(['open', 'close:button']);
    doc.webkitFullscreenElement = null;
    s.doc.fire('webkitfullscreenchange');
    s.doc.fire('fullscreenchange');
    expect(s.log).toEqual(['open', 'close:button', 'settled:button']);
  });

  it("the browser's own exit is already done: settles right after closing", () => {
    const s = setup();
    s.target.requestFullscreen = () => {
      s.doc.fullscreenElement = s.target;
      s.doc.fire('fullscreenchange');
    };
    s.fs.open();
    s.doc.fullscreenElement = null;
    s.doc.fire('fullscreenchange');
    expect(s.log).toEqual(['open', 'close:native-exit', 'settled:native-exit']);
  });

  it('a reopen before the exit settles drops the old settle (focus stays in the new overlay)', async () => {
    const s = setup();
    let finish: () => void = () => {};
    s.target.requestFullscreen = () => {
      s.doc.fullscreenElement = s.target;
      s.doc.fire('fullscreenchange');
    };
    s.doc.exitFullscreen = () => new Promise<void>((res) => (finish = res));
    s.fs.open();
    s.fs.close('button');
    s.fs.open();
    finish();
    await tick();
    expect(s.log.filter((l) => l.startsWith('settled'))).toEqual([]);
  });

  it('dispose removes every listener', () => {
    const s = setup();
    expect(s.doc.count()).toBe(3);
    expect(s.win.count()).toBe(1);
    s.fs.dispose();
    expect(s.doc.count() + s.win.count()).toBe(0);
  });
});

describe('index.html full screen markup', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  it('has an expand button on the start chart, the track map and the place changes chart', () => {
    for (const [id, label] of [
      ['start-full', 'Full screen start chart'],
      ['map-full', 'Full screen Race Viewer'],
      ['places-full', 'Full screen place changes chart'],
    ]) {
      expect(html).toMatch(new RegExp(`<button type="button" class="fs-open" id="${id}" aria-label="${label}" title="Full screen" aria-haspopup="dialog" aria-controls="fs"><svg`));
    }
  });
  it('has one hidden modal overlay outside the page wrapper, with Close and the rotate hint', () => {
    expect(html).toContain('<div id="fs" class="fs" role="dialog" aria-modal="true" aria-label="Full screen chart" hidden>');
    expect(html.indexOf('id="fs"')).toBeGreaterThan(html.indexOf('<footer>'));
    expect(html).toContain('id="fs-close" class="fs-close" aria-label="Close full screen"');
    expect(html).toContain('Rotate to landscape for a bigger view');
    expect(html).toContain('aria-label="Dismiss rotate hint"');
  });
  it('lets the overlay reach the safe area (viewport-fit=cover)', () => {
    expect(html).toContain('content="width=device-width, initial-scale=1.0, viewport-fit=cover"');
  });
});

describe('focus trap', () => {
  const items = ['close', 'fit', '2x', 'chart'];
  it('cycles at the ends and lets the browser move focus in between', () => {
    expect(trapFocus(items, 'chart', false)).toBe('close');
    expect(trapFocus(items, 'close', true)).toBe('chart');
    expect(trapFocus(items, 'fit', false)).toBeNull();
    expect(trapFocus(items, 'fit', true)).toBeNull();
  });
  it('brings focus back in from outside', () => {
    expect(trapFocus(items, 'page', false)).toBe('close');
    expect(trapFocus(items, null, true)).toBe('chart');
    expect(trapFocus([], 'x', false)).toBeNull();
  });
});

describe('scroll lock', () => {
  it('fixes the body at the scroll offset and restores styles and the exact position', () => {
    const scrolls: [number, number][] = [];
    const win = { scrollX: 0, scrollY: 1234.5, scrollTo: (x: number, y: number) => scrolls.push([x, y]) };
    const body = { style: { position: '', top: '', left: '', right: '', width: '', overflow: 'clip' } };
    const lock = lockScroll(win, body);
    expect(body.style).toMatchObject({ position: 'fixed', top: '-1234.5px', width: '100%', overflow: 'hidden' });
    lock.rescroll(); // still held: nothing to put back yet
    expect(scrolls).toEqual([]);
    lock.release();
    expect(body.style).toEqual({ position: '', top: '', left: '', right: '', width: '', overflow: 'clip' });
    expect(scrolls).toEqual([[0, 1234.5]]);
  });

  it('rescroll puts the position back after the browser resets it (leaving native fullscreen)', () => {
    const win = { scrollX: 0, scrollY: 466, scrollTo(x: number, y: number) {
      this.scrollX = x;
      this.scrollY = y;
    } };
    const body = { style: { position: '', top: '', left: '', right: '', width: '', overflow: '' } };
    const lock = lockScroll(win, body);
    lock.release();
    expect(win.scrollY).toBe(466);
    win.scrollY = 0; // Chrome, on its way out of fullscreen
    lock.rescroll();
    expect(win.scrollY).toBe(466);
  });
});
