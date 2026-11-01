import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { firstBoot } from '../src/boot';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const html = readFileSync(here('../index.html'), 'utf8');
const main = readFileSync(here('../src/main.ts'), 'utf8');
const code = html.match(/<script data-boot-retry>([\s\S]*?)<\/script>/)?.[1];

const ENTRY = '/assets/index-CoQVDCzS.js';
const NOW = 1_793_000_000_000;

interface FakeScript {
  tagName: 'SCRIPT';
  type: string;
  src: string;
  getAttribute(k: string): string | null;
}
const script = (src: string, type = 'module'): FakeScript => ({ tagName: 'SCRIPT', type, src, getAttribute: (k) => (k === 'src' ? src : null) });

/**
 * index.html's boot-retry script, run against a small fake page: `entrySrc` is the module script's src
 * (vite's built entry, or /src/main.ts in dev), `storage` the tab's sessionStorage (null: it throws).
 */
function page(entrySrc: string, storage: Map<string, string> | null = new Map()) {
  let booted = false;
  let onError: ((e: { target: unknown }) => void) | null = null;
  let capture: unknown;
  const timers: { fn: () => void; ms: number }[] = [];
  const entry = script(entrySrc);
  const added: FakeScript[] = [];
  const document = {
    documentElement: { hasAttribute: (k: string) => k === 'data-booted' && booted },
    // The one selector the script uses: a module script whose src has /assets/index-.
    querySelector: (sel: string) => {
      expect(sel).toBe('script[type=module][src*="/assets/index-"]');
      return [entry, ...added].find((s) => s.type === 'module' && s.src.includes('/assets/index-')) ?? null;
    },
    createElement: (tag: string) => (expect(tag).toBe('script'), script('', '')),
    head: { appendChild: (s: FakeScript) => void added.push(s) },
  };
  const window = {
    addEventListener: (type: string, fn: typeof onError, opt: unknown) => {
      expect(type).toBe('error');
      onError = fn;
      capture = opt;
    },
  };
  const sessionStorage = {
    getItem: (k: string) => {
      if (!storage) throw new Error('SecurityError');
      return storage.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (!storage) throw new Error('SecurityError');
      storage.set(k, v);
    },
  };
  const setTimeout = (fn: () => void, ms: number) => void timers.push({ fn, ms });
  const Date = { now: () => NOW };
  new Function('window', 'document', 'sessionStorage', 'setTimeout', 'Date', code!)(window, document, sessionStorage, setTimeout, Date);
  return {
    added,
    entry,
    timers,
    get capture() {
      return capture;
    },
    boot: () => void (booted = true),
    error: (target: unknown) => onError!({ target }),
    tick: () => timers.forEach((t) => t.fn()),
  };
}

describe("index.html's inline boot-retry script", () => {
  it('is there, in the head, after the route script and before the module entry', () => {
    expect(code).toBeTruthy();
    expect(html.indexOf('data-boot-retry')).toBeGreaterThan(html.indexOf('data-route-script'));
    expect(html.indexOf('data-boot-retry')).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('data-boot-retry')).toBeLessThan(html.indexOf('<script type="module"'));
    // Old-browser safe: no module syntax, arrows, let/const or template strings.
    expect(code).not.toMatch(/\bimport\b|=>|\blet\b|\bconst\b|`/);
  });

  it('loads the entry once more under a new URL when it fails to load, listening in the capture phase', () => {
    const p = page(ENTRY);
    expect(p.capture).toBe(true);
    expect(p.added).toEqual([]);
    p.error(p.entry);
    expect(p.added).toHaveLength(1);
    expect(p.added[0].type).toBe('module');
    expect(p.added[0].src).toBe(`${ENTRY}?r=${NOW}`);
  });

  it('retries once at most: not again on the retry failing, nor on the timer', () => {
    const p = page(ENTRY);
    p.error(p.entry);
    p.error(p.added[0]);
    p.error(p.entry);
    p.tick();
    expect(p.added).toHaveLength(1);
  });

  it("ignores other elements' errors", () => {
    const p = page(ENTRY);
    p.error(script('/assets/app-XYZ.js'));
    p.error({ tagName: 'IMG', getAttribute: () => '/assets/index-x.png' });
    p.error(null);
    expect(p.added).toEqual([]);
  });

  it('retries after ~8 s if the app has not started, and not if it has', () => {
    const slow = page(ENTRY);
    expect(slow.timers.map((t) => t.ms)).toEqual([8000]);
    slow.tick();
    expect(slow.added.map((s) => s.src)).toEqual([`${ENTRY}?r=${NOW}`]);

    const fine = page(ENTRY);
    fine.boot();
    fine.tick();
    fine.error(fine.entry);
    expect(fine.added).toEqual([]);
  });

  it('does nothing in vite dev, where the module is /src/main.ts', () => {
    const p = page('/src/main.ts');
    p.error(p.entry);
    p.tick();
    expect(p.added).toEqual([]);
  });

  it('retries at most once a minute per tab (sessionStorage)', () => {
    const storage = new Map<string, string>();
    page(ENTRY, storage).tick();
    expect(storage.get('recall.bootRetry')).toBe(String(NOW));

    storage.set('recall.bootRetry', String(NOW - 30_000)); // a reload 30 s after a retry
    const again = page(ENTRY, storage);
    again.error(again.entry);
    again.tick();
    expect(again.added).toEqual([]);

    storage.set('recall.bootRetry', String(NOW - 61_000));
    const later = page(ENTRY, storage);
    later.error(later.entry);
    expect(later.added).toHaveLength(1);
  });

  it('still retries once when sessionStorage is blocked', () => {
    const p = page(ENTRY, null);
    p.error(p.entry);
    p.tick();
    expect(p.added).toHaveLength(1);
  });
});

describe('the boot mark (src/boot.ts)', () => {
  it('lets the first copy of main.ts start the page, and no other', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    expect(firstBoot(root)).toBe(true);
    expect(root.dataset.booted).toBe('1');
    expect(firstBoot(root)).toBe(false);
    expect(firstBoot(root)).toBe(false);
  });

  it("is main.ts's first statement, and gates everything else it does", () => {
    const body = main.replace(/^import[^;]*;\n/gm, '').replace(/^\s*\/\/.*\n/gm, '').trim();
    expect(body.startsWith('if (firstBoot(document.documentElement)) start();')).toBe(true);
    // Nothing else at the top level: every call is inside start().
    const top = body.split('\n').filter((l) => /^\S/.test(l));
    expect(top).toEqual(['if (firstBoot(document.documentElement)) start();', 'function start(): void {', '}']);
  });
});
