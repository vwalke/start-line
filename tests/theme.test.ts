import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, THEME_SCRIPT, parseThemePref, resolveTheme } from '../functions/_theme';
import { applyTheme, setThemePref, themePref } from '../src/theme';
import { sheetHtml, themeHtml } from '../src/ui/paywall';
import type { Me } from '../src/data/paywall';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

/** A localStorage holding `stored` (or throwing on read). */
const storage = (stored: string | null | 'throws'): Storage =>
  ({
    getItem: (k: string) => {
      if (stored === 'throws') throw new Error('blocked');
      return k === THEME_KEY ? stored : null;
    },
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }) as unknown as Storage;

/** Run the pre-paint script with a stored value and the device's setting; the data-theme it set. */
const runScript = (code: string, stored: string | null | 'throws', systemDark: boolean | null): string | null => {
  let theme: string | null = null;
  const doc = { documentElement: { setAttribute: (k: string, v: string) => k === 'data-theme' && (theme = v) } };
  const matchMedia = systemDark == null ? undefined : (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' && systemDark });
  const win = { matchMedia };
  new Function('document', 'localStorage', 'window', 'matchMedia', code)(doc, storage(stored), win, matchMedia);
  return theme;
};

describe('theme resolution', () => {
  it('a stored Light or Dark wins over the device; System follows it', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('anything else stored falls back to System', () => {
    for (const raw of [null, undefined, '', 'Dark', 'night', 'system', '1']) expect(parseThemePref(raw)).toBe('system');
    expect(parseThemePref('light')).toBe('light');
    expect(parseThemePref('dark')).toBe('dark');
  });
});

describe('the pre-paint script', () => {
  const inline = html.match(/<script data-theme-script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

  it("is index.html's, in the head, before the stylesheet, the route script and any module", () => {
    expect(squash(inline)).toBe(squash(THEME_SCRIPT));
    const at = html.indexOf('data-theme-script');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(html.indexOf('</head>'));
    expect(at).toBeLessThan(html.indexOf('data-route-script'));
    expect(at).toBeLessThan(html.indexOf('type="module"') === -1 ? Infinity : html.indexOf('type="module"'));
  });

  it('sets data-theme from the stored choice, or the device under System', () => {
    for (const code of [inline, THEME_SCRIPT]) {
      expect(runScript(code, 'dark', false)).toBe('dark');
      expect(runScript(code, 'light', true)).toBe('light');
      expect(runScript(code, null, true)).toBe('dark');
      expect(runScript(code, null, false)).toBe('light');
    }
  });

  it('an invalid stored value, blocked storage or no matchMedia: the device, else light', () => {
    expect(runScript(THEME_SCRIPT, 'purple', true)).toBe('dark');
    expect(runScript(THEME_SCRIPT, 'purple', false)).toBe('light');
    expect(runScript(THEME_SCRIPT, 'throws', true)).toBe('dark');
    expect(runScript(THEME_SCRIPT, null, null)).toBe('light');
  });
});

describe('in the page (src/theme.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const stub = (stored: string | null, systemDark: boolean): { set: ReturnType<typeof vi.fn>; attr: () => string | undefined; store: Record<string, string> } => {
    const store: Record<string, string> = stored == null ? {} : { [THEME_KEY]: stored };
    const attrs: Record<string, string> = {};
    const set = vi.fn((k: string, v: string) => (attrs[k] = v));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => (store[k] = v),
      removeItem: (k: string) => delete store[k],
    });
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' && systemDark, addEventListener: () => {} }));
    vi.stubGlobal('document', { documentElement: { setAttribute: set } });
    return { set, attr: () => attrs['data-theme'], store };
  };

  it('applies the stored choice, and the device under System or an invalid value', () => {
    expect(stub('light', true) && applyTheme()).toBe('light');
    expect(stub('dark', false) && applyTheme()).toBe('dark');
    expect(stub(null, true) && applyTheme()).toBe('dark');
    const s = stub('sepia', false);
    expect(themePref()).toBe('system');
    expect(applyTheme()).toBe('light');
    expect(s.attr()).toBe('light');
  });

  it('saves Light / Dark, clears System, and redraws at once', () => {
    const s = stub(null, false);
    expect(setThemePref('dark')).toBe('dark');
    expect(s.store[THEME_KEY]).toBe('dark');
    expect(s.attr()).toBe('dark');
    expect(setThemePref('system')).toBe('light');
    expect(THEME_KEY in s.store).toBe(false);
    expect(s.attr()).toBe('light');
  });
});

describe('the Theme control in the account sheet', () => {
  const me = {
    paywall: true,
    user: { email: 'a@example.com' },
    entitlements: [],
    devices: { list: [], max: 3 },
    signIn: { email: true, google: true },
  } as unknown as Me;
  const signedOut = { ...me, user: null } as unknown as Me;

  it('System / Light / Dark, the saved one pressed; a plain segmented control, not a data action', () => {
    const h = themeHtml('dark');
    expect(h).toContain('<div class="seg account-theme" role="group" aria-label="Theme">');
    expect([...h.matchAll(/data-value="(\w+)" aria-pressed="(\w+)">(\w+)</g)].map((m) => m.slice(1).join(' '))).toEqual(['system false System', 'light false Light', 'dark true Dark']);
    expect(h).not.toMatch(/\bact\b|act-chip/);
  });

  it('shows signed in and signed out, System by default', () => {
    expect(sheetHtml(me, { mode: 'account' }, () => '')).toContain(themeHtml('system'));
    expect(sheetHtml(me, { mode: 'account' }, () => '', 'light')).toContain(themeHtml('light'));
    expect(sheetHtml(signedOut, { mode: 'signin' }, () => '', 'dark')).toContain(themeHtml('dark'));
  });
});

describe('every Night color follows data-theme, not the media query', () => {
  it('style.css has no prefers-color-scheme left, and the Night tokens sit under :root[data-theme=dark]', () => {
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).toMatch(/:root\[data-theme='dark'\] \{\n {2}color-scheme: dark;/);
  });

  it('the landing hero shows its Day or Night file by the theme', () => {
    expect(html).toContain('<img class="hero-day" src="/landing-hero.svg"');
    expect(html).toContain('<img class="hero-night" src="/landing-hero-night.svg"');
    expect(css).toContain(".land-hero-fig .hero-night, :root[data-theme='dark'] .land-hero-fig .hero-day { display: none; }");
  });
});
