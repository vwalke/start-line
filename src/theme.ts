/**
 * The color theme in the page (functions/_theme.ts has the rules): read and save the sailor's
 * choice, and keep `<html data-theme>` in step with it, with the device's setting under System,
 * and with a choice made in another tab. index.html's inline script set it before first paint.
 * Every Night color lives in style.css under `:root[data-theme='dark']`, so nothing here re-renders.
 */
import { THEME_KEY, parseThemePref, resolveTheme, type Theme, type ThemePref } from '../functions/_theme';

export { THEME_KEY, THEME_PREFS, parseThemePref, resolveTheme, type Theme, type ThemePref } from '../functions/_theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemDark(): boolean {
  try {
    return globalThis.matchMedia?.(DARK_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

/** The saved choice (System where storage is unavailable or throws). */
export function themePref(): ThemePref {
  try {
    return parseThemePref(globalThis.localStorage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Set `data-theme` from the saved choice and the device; returns the theme drawn. */
export function applyTheme(): Theme {
  const t = resolveTheme(themePref(), systemDark());
  globalThis.document?.documentElement.setAttribute('data-theme', t);
  return t;
}

/** Save a choice (System clears it) and draw it. */
export function setThemePref(p: ThemePref): Theme {
  try {
    if (p === 'system') globalThis.localStorage?.removeItem(THEME_KEY);
    else globalThis.localStorage?.setItem(THEME_KEY, p);
  } catch {
    // blocked storage: the choice holds for this page only
  }
  return applyTheme();
}

/** Follow the device's setting (under System) and a choice made in another tab. Once, at startup. */
export function watchTheme(): void {
  applyTheme();
  try {
    globalThis.matchMedia?.(DARK_QUERY).addEventListener?.('change', () => applyTheme());
  } catch {
    // no media queries: the choice still applies
  }
  globalThis.addEventListener?.('storage', (e: StorageEvent) => {
    if (e.key === THEME_KEY || e.key === null) applyTheme();
  });
}
