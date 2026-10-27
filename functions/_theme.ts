/**
 * Recall's color theme: System (the device's light or dark), Light or Dark, picked in the account
 * sheet (src/ui/paywall.ts) and kept in this browser's localStorage. The page carries the result as
 * `<html data-theme="light|dark">`, set before first paint by THEME_SCRIPT (inline in index.html and
 * the sign-in link pages, functions/_auth.ts), and style.css keys every Night color off it.
 * Shared by the app (src/theme.ts) and the Functions, so the two can't drift.
 */
export const THEME_KEY = 'recall.theme';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];

/** A stored choice; anything else (missing, old or garbled) is System. */
export const parseThemePref = (raw: string | null | undefined): ThemePref => (raw === 'light' || raw === 'dark' ? raw : 'system');

/** The theme to draw: the choice, or the device's own with System. */
export const resolveTheme = (pref: ThemePref, systemDark: boolean): Theme => (pref === 'system' ? (systemDark ? 'dark' : 'light') : pref);

/**
 * The pre-paint script: the same decision as parseThemePref + resolveTheme, in plain ES5, run from
 * <head> before the stylesheet applies (tests/theme.test.ts runs it and keeps it in step).
 */
export const THEME_SCRIPT = `(function (d) {
  var p = null;
  try { p = localStorage.getItem('${THEME_KEY}'); } catch (e) {}
  var dark = p === 'dark' || (p !== 'light' && !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  d.setAttribute('data-theme', dark ? 'dark' : 'light');
})(document.documentElement);`;
