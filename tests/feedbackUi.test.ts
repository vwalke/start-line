import { describe, expect, it } from 'vitest';
import { CONTEXT_BYTES, buildContext, cleanUrl, themeContext, type ContextInput } from '../src/feedback/context';
import { PROBLEMS_MAX, apiPath, createProblemLog, scrub } from '../src/feedback/problems';
import { feedbackSheetHtml, liftFor, sendError, thanksHtml } from '../src/feedback/sheet';
import { fitSize } from '../src/feedback/image';
import { pageState, setPageState } from '../src/feedback/state';
import { APP_COMMIT } from '../src/feedback/build';
import { CONTEXT_MAX_BYTES, FEEDBACK_TYPES, MESSAGE_MAX as SERVER_MESSAGE_MAX } from '../functions/_feedback';
import { MESSAGE_MAX, TYPES } from '../src/feedback/sheet';

const ORIGIN = 'https://recall.walkeforward.com';

const input = (over: Partial<ContextInput> = {}): ContextInput => ({
  href: `${ORIGIN}/regattas?event=E1&div=J70&race=3&t=12.5&trail=all#race`,
  title: 'Recall — race start & leg digest',
  state: { eventId: 'E1', eventTitle: 'Fall Series', division: 'J70', race: 3, tab: 'race', boats: ['USA 833', 'USA 1'], leg: 2, trail: 'all', trackColour: 'sog', loaded: true, boatCount: 18, paywall: true, locked: false, free: true, signedIn: false },
  device: { viewport: [390.4, 844], screen: [390, 844], dpr: 3, userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iOS', touch: true, language: 'en-US', timeZone: 'America/New_York', connection: '4g', referrer: 'https://example.com/?token=abc' },
  theme: { resolved: 'dark', source: 'system', stored: null },
  app: { commit: 'abc1234', builtAt: '2026-10-27T00:00:00Z' },
  problems: [{ kind: 'api', at: '2026-10-27T10:00:00.000Z', text: 'GET /api/regatta?event → 502' }],
  timeOnPageMs: 61_400,
  now: new Date('2026-10-27T10:01:00Z'),
  ...over,
});

describe('feedback context', () => {
  it('carries where, device, theme, app, data and problems', () => {
    const c = buildContext(input());
    expect(c.where).toMatchObject({
      url: `${ORIGIN}/regattas?event=E1&div=J70&race=3&t=12.5&trail=all#race`,
      path: '/regattas',
      query: { event: 'E1', div: 'J70', race: '3', t: '12.5', trail: 'all' },
      hash: '#race',
      route: 'app',
      eventId: 'E1',
      eventTitle: 'Fall Series',
      division: 'J70',
      race: '3',
      tab: 'race',
      boats: ['USA 833', 'USA 1'],
      leg: 2,
      trail: 'all',
      trackColour: 'sog',
    });
    expect(c.device).toEqual({
      viewport: '390×844',
      screen: '390×844',
      dpr: 3,
      userAgent: 'Mozilla/5.0 (iPhone)',
      platform: 'iOS',
      touch: true,
      language: 'en-US',
      timeZone: 'America/New_York',
      connection: '4g',
      referrer: 'https://example.com/',
    });
    expect(c.theme).toEqual({ resolved: 'dark', source: 'system' });
    expect(c.app).toEqual({ commit: 'abc1234', builtAt: '2026-10-27T00:00:00Z' });
    expect(c.data).toEqual({ loaded: true, boatCount: 18, paywall: true, locked: false, free: true, signedIn: false });
    expect(c.problems).toHaveLength(1);
    expect(c.timeOnPageS).toBe(61);
    expect(c.sentAt).toBe('2026-10-27T10:01:00.000Z');
  });

  it('reads the theme as src/theme.ts sets it: data-theme drawn, recall.theme chosen or System', () => {
    // System: data-theme is still set (the pre-paint script resolves it), so the source comes from storage.
    expect(themeContext('dark', null, true)).toEqual({ resolved: 'dark', source: 'system', stored: null });
    expect(themeContext('light', 'garbled', false)).toEqual({ resolved: 'light', source: 'system', stored: 'garbled' });
    // A choice overrides the device.
    expect(themeContext('light', 'light', true)).toEqual({ resolved: 'light', source: 'chosen', stored: 'light' });
    expect(themeContext('dark', 'dark', false)).toEqual({ resolved: 'dark', source: 'chosen', stored: 'dark' });
    // No attribute yet: resolved the same way the page would.
    expect(themeContext(undefined, 'dark', false)).toEqual({ resolved: 'dark', source: 'chosen', stored: 'dark' });
    expect(themeContext(undefined, null, true)).toEqual({ resolved: 'dark', source: 'system', stored: null });
  });

  it('falls back to the URL on the landing page or before the app knows', () => {
    const c = buildContext(input({ href: `${ORIGIN}/`, state: {} }));
    expect(c.where.route).toBe('landing');
    expect(c.data).toEqual({ loaded: false });
    const d = buildContext(input({ href: `${ORIGIN}/regattas?event=E9&div=IC37&race=4`, state: {} }));
    expect(d.where).toMatchObject({ eventId: 'E9', division: 'IC37', race: '4', route: 'app' });
  });

  it('leaves out secret-looking parameters and fragments', () => {
    expect(cleanUrl(`${ORIGIN}/regattas?event=E1&token=abc&buy=x&signin=ok`).url).toBe(`${ORIGIN}/regattas?event=E1&signin=ok`);
    expect(cleanUrl(`${ORIGIN}/api/auth/verify#token=abc`).hash).toBe('');
  });

  it('stays under the size cap, whatever it is handed', () => {
    const big = 'x'.repeat(5_000);
    const c = buildContext(
      input({
        href: `${ORIGIN}/regattas?${Array.from({ length: 60 }, (_, i) => `k${i}=${big}`).join('&')}`,
        title: big,
        state: { eventId: big, eventTitle: big, division: big, boats: Array(50).fill(big), coachGroup: big },
        device: { ...input().device, userAgent: big, platform: big },
        problems: Array.from({ length: 100 }, (_, i) => ({ kind: 'console' as const, at: `t${i}`, text: big })),
      }),
    );
    const bytes = new TextEncoder().encode(JSON.stringify(c)).length;
    expect(bytes).toBeLessThanOrEqual(CONTEXT_BYTES);
    expect(CONTEXT_BYTES).toBeLessThanOrEqual(CONTEXT_MAX_BYTES);
    expect(c.where.boats).toHaveLength(4);
    expect(c.where.eventId).toHaveLength(64);
    expect(c.problems.length).toBeLessThanOrEqual(20);
    expect(Object.keys(c.where.query).length).toBeLessThanOrEqual(30);
  });
});

describe('recent problems', () => {
  it('keeps the last 20, scrubbed', () => {
    const log = createProblemLog();
    for (let i = 0; i < 25; i++) log.add('console', `error ${i}`, new Date(Date.UTC(2026, 9, 27, 10, 0, i)));
    const list = log.list();
    expect(list).toHaveLength(PROBLEMS_MAX);
    expect(list[0]).toEqual({ kind: 'console', at: '2026-10-27T10:00:05.000Z', text: 'error 5' });
    expect(list.at(-1)?.text).toBe('error 24');
    log.add('error', `bad token ${'A'.repeat(43)}\nnext line`);
    expect(log.list().at(-1)?.text).toBe('bad token … next line');
    expect(scrub('x'.repeat(1_000))).not.toContain('x'.repeat(40));
    log.clear();
    expect(log.list()).toEqual([]);
  });

  it('names same-origin /api calls by path and parameter names only', () => {
    expect(apiPath('/api/regatta?event=E1&secret=s', ORIGIN)).toBe('/api/regatta?event&secret');
    expect(apiPath(`${ORIGIN}/api/telemetry/event/E1?after=1&before=2`, ORIGIN)).toBe('/api/telemetry/event/E1?after&before');
    expect(apiPath('/regattas', ORIGIN)).toBeNull();
    expect(apiPath('https://challenges.cloudflare.com/api/x', ORIGIN)).toBeNull();
  });
});

describe('the feedback sheet', () => {
  it('asks a signed-out sender for an email (optional), and not a signed-in one', () => {
    const out = feedbackSheetHtml({ ready: true, signedIn: false, turnstileSiteKey: null }, { mapAvailable: false });
    expect(out).toContain('name="email"');
    expect(out).not.toMatch(/name="email"[^>]*required/);
    expect(out).toContain('so we can reply');
    const inn = feedbackSheetHtml({ ready: true, signedIn: true, turnstileSiteKey: null }, { mapAvailable: false });
    expect(inn).not.toContain('name="email"');
  });

  it('has the four types, a capped required message, one image, the map when there is one, and Turnstile when keyed', () => {
    const out = feedbackSheetHtml({ ready: true, signedIn: false, turnstileSiteKey: 'site' }, { mapAvailable: true });
    for (const label of ['Bug', 'Idea', 'Data looks wrong', 'Other']) expect(out).toContain(`> ${label}</label>`);
    expect(out).toMatch(/<textarea name="message"[^>]*maxlength="4000"[^>]*required/);
    expect(out.match(/type="file"/g)).toHaveLength(1);
    expect(out).not.toContain('multiple');
    expect(out).toContain('Include the map');
    expect(out).toContain('data-fb-turnstile');
    expect(out).toContain('id="feedback-title"');
    const plain = feedbackSheetHtml({ ready: true, signedIn: false, turnstileSiteKey: null }, { mapAvailable: false });
    expect(plain).not.toContain('Include the map');
    expect(plain).not.toContain('data-fb-turnstile');
    expect(feedbackSheetHtml({ ready: false, signedIn: false, turnstileSiteKey: null }, { mapAvailable: true })).toContain("isn't set up");
    expect(thanksHtml()).toContain('Thanks');
  });

  it('agrees with the server on types and the message cap', () => {
    expect(TYPES.map(([v]) => v)).toEqual([...FEEDBACK_TYPES]);
    expect(MESSAGE_MAX).toBe(SERVER_MESSAGE_MAX);
  });

  it('says what went wrong in plain words', () => {
    expect(sendError(400, { message: 'Write a few words first.' })).toBe('Write a few words first.');
    expect(sendError(429, null)).toMatch(/later/);
    expect(sendError(413, {})).toMatch(/smaller image/);
    expect(sendError(0, null)).toMatch(/connection/);
    expect(sendError(500, '<html>')).toMatch(/Try again/);
  });

  it('lifts the floating button clear of controls under it', () => {
    const btn = { top: 780, bottom: 824, left: 334, right: 378 };
    expect(liftFor(btn, [])).toBe(0);
    expect(liftFor(btn, [{ top: 100, bottom: 140, left: 0, right: 390 }])).toBe(0);
    expect(liftFor(btn, [{ top: 790, bottom: 830, left: 0, right: 390 }])).toBe(42);
    expect(liftFor(btn, [{ top: 790, bottom: 830, left: 0, right: 200 }])).toBe(0);
  });
});

describe('feedback odds and ends', () => {
  it('fits images to 1600 px on the long side, never larger', () => {
    expect(fitSize(4032, 3024)).toEqual([1600, 1200]);
    expect(fitSize(800, 600)).toEqual([800, 600]);
    expect(fitSize(1000, 5000)).toEqual([320, 1600]);
    expect(fitSize(0, 10)).toEqual([0, 0]);
  });

  it('reads the page state defensively', () => {
    setPageState(() => ({ eventId: 'E1' }));
    expect(pageState()).toEqual({ eventId: 'E1' });
    setPageState(() => {
      throw new Error('not ready');
    });
    expect(pageState()).toEqual({});
    setPageState(null);
    expect(pageState()).toEqual({});
  });

  it('knows the build it came from', () => {
    expect(APP_COMMIT).toMatch(/^([0-9a-f]{4,40}|dev)$/);
  });
});
