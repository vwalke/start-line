/**
 * The context sent with each piece of feedback: where (URL and app state), the device, the theme, the
 * build, recent problems and the race data's state. buildContext is pure (the tests drive it);
 * gatherContext reads the browser. Strings and lists are capped, and the whole thing stays under
 * CONTEXT_BYTES (the oldest problems go first, then the URL's tail). Never cookies, tokens or names:
 * boats are sail numbers only.
 */
import { THEME_KEY, parseThemePref, resolveTheme } from '../theme';
import type { PageState } from './state';
import type { Problem } from './problems';

export const CONTEXT_BYTES = 32_000;
const STR = 300;

export interface ContextInput {
  href: string;
  title?: string;
  state: PageState;
  device: {
    viewport: [number, number];
    screen: [number, number];
    dpr: number;
    userAgent: string;
    platform?: string;
    touch: boolean;
    language?: string;
    timeZone?: string;
    connection?: string;
    referrer?: string;
  };
  theme: { resolved: 'light' | 'dark'; source: 'chosen' | 'system'; stored?: string | null };
  app: { commit: string; builtAt: string | null };
  problems: Problem[];
  timeOnPageMs: number;
  now: Date;
}

export interface FeedbackContext {
  v: 1;
  where: {
    url: string;
    path: string;
    query: Record<string, string>;
    hash: string;
    route: string;
    eventId?: string;
    eventTitle?: string;
    division?: string;
    race?: string;
    tab?: string;
    boats?: string[];
    leg?: number | null;
    coachView?: string;
    coachGroup?: string;
    trail?: string;
    trackColour?: string;
    rankBy?: string;
    playing?: boolean;
    fullScreen?: string | null;
    report?: boolean;
    pageTitle?: string;
  };
  device: {
    viewport: string;
    screen: string;
    dpr: number;
    userAgent: string;
    platform?: string;
    touch: boolean;
    language?: string;
    timeZone?: string;
    connection?: string;
    referrer?: string;
  };
  theme: ContextInput['theme'];
  app: ContextInput['app'];
  data: { loaded: boolean; boatCount?: number; paywall?: boolean; locked?: boolean; free?: boolean; signedIn?: boolean };
  problems: Problem[];
  timeOnPageS: number;
  sentAt: string;
}

/** Query parameters that could carry a secret: never sent. */
const SECRET_PARAM = /token|code|state|secret|key|session|password|buy/i;

const cap = (s: string | undefined | null, n = STR): string | undefined => (s ? s.slice(0, n) : undefined);
const num = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
const drop = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** The URL with any secret-looking query parameter and a token-ish fragment left out. */
export function cleanUrl(href: string): { url: string; path: string; query: Record<string, string>; hash: string } {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { url: cap(href, 2_000) ?? '', path: '', query: {}, hash: '' };
  }
  for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.delete(k);
  if (/token|code|=/i.test(u.hash)) u.hash = '';
  const query: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of u.searchParams) if (n++ < 30) query[k.slice(0, 40)] = v.slice(0, 200);
  return { url: u.href.slice(0, 2_000), path: u.pathname.slice(0, 300), query, hash: u.hash.slice(0, 100) };
}

export function buildContext(i: ContextInput): FeedbackContext {
  const s = i.state;
  const u = cleanUrl(i.href);
  const route = /^\/(index\.html)?$/.test(u.path) && !u.hash && !Object.keys(u.query).length ? 'landing' : 'app';
  const ctx: FeedbackContext = {
    v: 1,
    where: drop({
      ...u,
      route,
      eventId: cap(s.eventId ?? u.query.event, 64),
      eventTitle: cap(s.eventTitle, 120),
      division: cap(s.division ?? u.query.div, 120),
      race: s.race != null ? String(s.race) : cap(u.query.race, 20),
      tab: cap(s.tab ?? (u.hash.slice(1) || undefined), 20),
      boats: s.boats?.filter((b) => typeof b === 'string' && b).slice(0, 4).map((b) => b.slice(0, 20)),
      leg: s.leg,
      coachView: cap(s.coachView, 20),
      coachGroup: cap(s.coachGroup, 40),
      trail: cap(s.trail, 10),
      trackColour: cap(s.trackColour, 10),
      rankBy: cap(s.rankBy, 10),
      playing: s.playing,
      fullScreen: s.fullScreen,
      report: s.report,
      pageTitle: cap(i.title, 120),
    }),
    device: drop({
      viewport: `${Math.round(i.device.viewport[0])}×${Math.round(i.device.viewport[1])}`,
      screen: `${Math.round(i.device.screen[0])}×${Math.round(i.device.screen[1])}`,
      dpr: num(i.device.dpr),
      userAgent: cap(i.device.userAgent, 400) ?? '',
      platform: cap(i.device.platform, 60),
      touch: !!i.device.touch,
      language: cap(i.device.language, 40),
      timeZone: cap(i.device.timeZone, 60),
      connection: cap(i.device.connection, 20),
      referrer: i.device.referrer ? cleanUrl(i.device.referrer).url.slice(0, 300) : undefined,
    }),
    theme: drop({ resolved: i.theme.resolved, source: i.theme.source, stored: cap(i.theme.stored ?? undefined, 20) }),
    app: { commit: cap(i.app.commit, 40) ?? 'dev', builtAt: cap(i.app.builtAt, 40) ?? null },
    data: drop({ loaded: !!s.loaded, boatCount: s.boatCount, paywall: s.paywall, locked: s.locked, free: s.free, signedIn: s.signedIn }),
    problems: i.problems.slice(-20).map((p) => ({ kind: p.kind, at: p.at.slice(0, 30), text: p.text.slice(0, STR) })),
    timeOnPageS: Math.max(0, Math.round(i.timeOnPageMs / 1000)),
    sentAt: i.now.toISOString(),
  };
  // Over the cap (it shouldn't be): the oldest problems go, then the long strings.
  const size = (): number => new TextEncoder().encode(JSON.stringify(ctx)).length;
  while (size() > CONTEXT_BYTES && ctx.problems.length) ctx.problems.shift();
  if (size() > CONTEXT_BYTES) {
    ctx.where.url = ctx.where.url.slice(0, 300);
    ctx.where.query = {};
    ctx.device.userAgent = ctx.device.userAgent.slice(0, 200);
  }
  return ctx;
}

// ---- the browser's side

/**
 * The theme: what the page draws (`<html data-theme>`, kept by src/theme.ts and index.html's pre-paint
 * script) and whether the sailor chose it in the account sheet or it follows the device (System).
 */
export function themeContext(attr: string | undefined, stored: string | null, systemDark: boolean): ContextInput['theme'] {
  const pref = parseThemePref(stored);
  const resolved = attr === 'light' || attr === 'dark' ? attr : resolveTheme(pref, systemDark);
  return { resolved, source: pref === 'system' ? 'system' : 'chosen', stored };
}

export function readTheme(): ContextInput['theme'] {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    /* storage blocked */
  }
  let systemDark = false;
  try {
    systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    /* no media queries */
  }
  return themeContext(document.documentElement.dataset.theme, stored, systemDark);
}

const startedAt = Date.now();

export function deviceInfo(): ContextInput['device'] {
  const nav = navigator as Navigator & { connection?: { effectiveType?: string }; userAgentData?: { platform?: string } };
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* none */
  }
  return {
    viewport: [innerWidth, innerHeight],
    screen: [screen.width, screen.height],
    dpr: devicePixelRatio || 1,
    userAgent: navigator.userAgent,
    platform: nav.userAgentData?.platform || navigator.platform || undefined,
    touch: navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches,
    language: navigator.language,
    timeZone,
    connection: nav.connection?.effectiveType,
    referrer: document.referrer || undefined,
  };
}

export const timeOnPage = (): number => Date.now() - startedAt;
