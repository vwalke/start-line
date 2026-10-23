import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPS, HERE } from '../src/apps';
import { PRICE_REGATTA as PRICE_FROM_DATA } from '../src/data/price';
import { BUY_PARAM } from '../src/data/paywall';
import { heroFromFixture, type HeroFixture } from '../src/landing/heroFixture';
import { positionAt, simplify } from '../src/landing/hero';
import { LAST_VIEW_KEY as LANDING_KEY, continueLink, startLanding } from '../src/landing/landing';
import { APP_HASHES, REGATTAS_PATH, appPath, routeOf } from '../src/landing/route';
import { BOAT_PARAM, GROUP_PARAM, VIEW_PARAM } from '../src/ui/coach';
import { LAST_VIEW_KEY, parseLastView, resolveStart, serializeLastView, type LastView } from '../src/ui/lastView';
import { VS_PARAM, WIN_PARAM } from '../src/ui/mapLink';
import { NC_PARAM, YSC_PARAM, YS_PARAM, parsePickerParams } from '../src/ui/params';
import { PRICE_REGATTA, hereWithout } from '../src/ui/paywall';
import { REPLAY_PARAM } from '../src/ui/replay';
import { REPORT_HASH, REPORT_PARAM } from '../src/ui/report';
import { TRAIL_PARAM, T_PARAM } from '../src/ui/scrub';
import { TABS } from '../src/ui/tabs';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const html = readFileSync(here('../index.html'), 'utf8');
const hero = readFileSync(here('../public/landing-hero.svg'), 'utf8');
const landing = html.slice(html.indexOf('<main id="landing"'), html.indexOf('</main>', html.indexOf('<main id="landing"')) + 7);
/** The landing page's words, tags stripped. */
const landingText = landing
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<\/?(span|strong|a)\b[^>]*>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

/** Every parameter the app reads from the page URL, by its own constants where it has one. */
const APP_PARAMS = [
  'event',
  'div',
  'race',
  NC_PARAM,
  YS_PARAM,
  YSC_PARAM,
  'coach',
  BOAT_PARAM,
  GROUP_PARAM,
  VIEW_PARAM,
  T_PARAM,
  TRAIL_PARAM,
  REPLAY_PARAM,
  VS_PARAM,
  WIN_PARAM,
  REPORT_PARAM,
  BUY_PARAM,
  'checkout',
  'signin',
  'demo',
];

const DEEP_LINKS = [
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8&nc=all',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8&ys=50934&ysc=PHRF%7CIC37',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8&coach=1#coach',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8&boat=USA%2029&grp=top3&cview=regatta#coach',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=202605141205#race',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8&t=-30&trail=all#race',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8#start',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8#report',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8&report=1',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=3&checkout=success#coach',
  '/?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=3&buy=abc.def',
  '/?signin=expired',
  '/?signin=failed',
  '/?checkout=cancel',
  '/#coach',
  '/#race',
  '/#start',
  '/#report',
];

describe('routeOf: the landing page or the app', () => {
  it('bare / (and /index.html) is the landing page, also with campaign tagging or a page anchor', () => {
    for (const [path, search, hash] of [
      ['/', '', ''],
      ['/index.html', '', ''],
      ['/', '?', ''],
      ['/', '?utm_source=newsletter&utm_campaign=fall', ''],
      ['/', '?fbclid=x&gclid=y&msclkid=z', ''],
      ['/', '', '#pricing'],
      ['/', '', '#'],
    ]) {
      expect(routeOf(path, search, hash), `${path}${search}${hash}`).toBe('landing');
    }
  });

  it('/regattas is the app (the picker), with or without parameters', () => {
    expect(routeOf(REGATTAS_PATH, '', '')).toBe('app');
    expect(routeOf(REGATTAS_PATH, '?event=abcd&div=J70&race=1', '#coach')).toBe('app');
    expect(routeOf('/some/old/path', '', '')).toBe('app');
  });

  it('every parameter the app reads opens the app at /, as does any other non-tracking parameter', () => {
    for (const k of APP_PARAMS) expect(routeOf('/', `?${k}=1`, ''), k).toBe('app');
    expect(routeOf('/', '?utm_source=x&event=abcd', '')).toBe('app');
    expect(routeOf('/', '?somethingnew=1', '')).toBe('app');
    expect(routeOf('/', '?=x', '')).toBe('app');
  });

  it('the app hashes are the tabs and the report', () => {
    expect([...APP_HASHES].sort()).toEqual([...TABS, REPORT_HASH.slice(1)].sort());
    for (const h of APP_HASHES) expect(routeOf('/', '', `#${h}`)).toBe('app');
  });

  it('deep links are unchanged: they open the app and it reads them exactly as before', () => {
    for (const link of DEEP_LINKS) {
      const u = new URL(link, 'https://recall.walkeforward.com');
      expect(routeOf(u.pathname, u.search, u.hash), link).toBe('app');
      // The same URL under /regattas (where the app now lives) is read the same way.
      expect(parsePickerParams(u.search)).toEqual(parsePickerParams(new URL(`${REGATTAS_PATH}${u.search}`, u).search));
    }
    const plan = resolveStart('?event=fDHdPcEOM6mcMRkdXNnj&div=J70&race=8&nc=all&ys=50934&ysc=x', null);
    expect(plan).toEqual({ source: 'url', params: { eventId: 'fDHdPcEOM6mcMRkdXNnj', want: { division: 'J70', raceNumber: 8 }, allCompetitors: true, ys: 50934, ysc: 'x' } });
  });
});

describe("index.html's inline route script", () => {
  const code = html.match(/<script data-route-script>([\s\S]*?)<\/script>/)?.[1];
  const run = (href: string): string | null => {
    const u = new URL(href, 'https://recall.walkeforward.com');
    let route: string | null = null;
    const doc = { documentElement: { setAttribute: (k: string, v: string) => k === 'data-route' && (route = v) } };
    new Function('location', 'document', code!)({ pathname: u.pathname, search: u.search, hash: u.hash }, doc);
    return route;
  };

  it('is there, in the head, before any stylesheet or module', () => {
    expect(code).toBeTruthy();
    expect(html.indexOf('data-route-script')).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('data-route-script')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('makes the same call as routeOf', () => {
    const urls = [
      '/',
      '/index.html',
      '/?',
      '/?utm_source=x',
      '/?utm_medium=a&fbclid=b',
      '/#pricing',
      '/regattas',
      '/regattas?event=abcd',
      '/elsewhere',
      '/?somethingnew=1',
      ...APP_PARAMS.map((k) => `/?${k}=1`),
      ...DEEP_LINKS,
    ];
    for (const href of urls) {
      const u = new URL(href, 'https://recall.walkeforward.com');
      expect(run(href), href).toBe(routeOf(u.pathname, u.search, u.hash));
    }
  });
});

describe('appPath: the app never rewrites its URL to the landing page', () => {
  it('moves a parameterless / to /regattas and leaves everything else alone', () => {
    expect(appPath('https://recall.walkeforward.com/')).toBe('/regattas');
    expect(appPath('https://recall.walkeforward.com/?utm_source=x')).toBe('/regattas?utm_source=x');
    expect(appPath('https://recall.walkeforward.com/?event=abcd&div=J70&race=8#coach')).toBe('/?event=abcd&div=J70&race=8#coach');
    expect(appPath('https://recall.walkeforward.com/#race')).toBe('/#race');
    expect(appPath('https://recall.walkeforward.com/regattas')).toBe('/regattas');
    expect(appPath('/regattas?event=abcd')).toBe('/regattas?event=abcd');
  });

  it('a sign-in or checkout return stays in the app', () => {
    expect(hereWithout('https://recall.walkeforward.com/?checkout=success')).toBe('/regattas');
    expect(hereWithout('https://recall.walkeforward.com/?signin=failed')).toBe('/regattas');
    expect(hereWithout('https://recall.walkeforward.com/regattas?event=x&race=3&buy=a.b#coach')).toBe('/regattas?event=x&race=3#coach');
    expect(hereWithout('https://recall.walkeforward.com/?event=x&race=3&checkout=success#coach')).toBe('/?event=x&race=3#coach');
  });
});

describe('the landing page (index.html #landing)', () => {
  it('is one <main> on show: the digest stays hidden until a race loads', () => {
    expect(html.match(/<main\b[^>]*>/g)).toEqual([expect.stringContaining('id="landing"'), expect.stringMatching(/id="digest"[^>]*\bhidden\b/)]);
  });

  it('leads with Browse regattas, to /regattas', () => {
    expect(landing).toMatch(/<a class="land-btn" href="\/regattas">Browse regattas<\/a>/);
    expect(landing).toMatch(/id="landing-continue"[^>]*href="\/regattas"[^>]*hidden/);
  });

  it('says the first race is free and the regatta is $50, with the price the paywall shows', () => {
    expect(PRICE_REGATTA).toBe(PRICE_FROM_DATA);
    expect(PRICE_REGATTA).toBe('$50');
    expect(landingText).toContain('The first race of every regatta is free.');
    expect(landingText).toContain(`The rest of the regatta is ${PRICE_REGATTA}.`);
    const prices = [...landing.matchAll(/<span data-price="regatta">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(prices.length).toBeGreaterThan(0);
    for (const p of prices) expect(p).toBe(PRICE_REGATTA);
    expect(html).toMatch(/<meta name="description" content="[^"]*The first race of every regatta is free\./);
  });

  it('offers no Season Pass or subscription, and mentions Google as the only sign-in', () => {
    expect(html).not.toMatch(/season/i);
    expect(landingText).toContain('no subscription');
    expect(landingText).not.toMatch(/subscribe|per year|\/yr|annual/i);
    expect(landingText).not.toMatch(/password|e-?mail|magic link/i);
    for (const m of landingText.matchAll(/sign[- ]?in[^.]*/gi)) expect(m[0]).toMatch(/Google/);
  });

  it('describes the post-start view generically and leaves out features that are switched per site', () => {
    expect(landingText).toContain('the first minutes after the gun');
    expect(landingText).not.toMatch(/\b(60|120|180) ?s\b|\+[123]:00|slider/i);
    expect(landingText).not.toMatch(/Ask Coach|\bAI\b/);
  });

  it('says where regattas come from and how to add your own log', () => {
    expect(landingText).toContain('Regattas appear here when Vakaros publishes them on their site.');
    expect(landingText).toMatch(/\.vkx file/);
    expect(landingText).toContain('Uploads are public.');
  });

  it('links the other Walke Forward apps as src/apps.ts has them, and the studio', () => {
    const links = [...landing.matchAll(/<a class="land-app" href="([^"]+)">[\s\S]*?land-app-name">([^<]+)<[\s\S]*?land-app-desc">([^<]+)</g)].map((m) => ({
      href: m[1],
      name: m[2],
      description: m[3].replace(/&amp;/g, '&'),
    }));
    expect(links).toEqual(APPS.filter((a) => a.id !== HERE).map(({ href, name, description }) => ({ href, name, description })));
    for (const a of APPS.filter((x) => x.id !== HERE)) expect(landing).toContain(`src="${a.icon}"`);
    expect(landing).toContain('<a href="https://walkeforward.com/">Walke Forward</a>');
  });

  it('has its headings in order (the masthead h1, then h2 sections, h3 cards)', () => {
    const levels = [...landing.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(2);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    expect(html.indexOf('<h1 class="wordmark">')).toBeLessThan(html.indexOf('<main id="landing"'));
  });

  it('has its SEO and sharing tags', () => {
    expect(html).toMatch(/<title>Recall \| [^<]+<\/title>/);
    expect(html).toContain('<link rel="canonical" href="https://recall.walkeforward.com/" />');
    for (const p of ['og:type', 'og:url', 'og:title', 'og:description', 'og:image', 'og:site_name']) expect(html).toMatch(new RegExp(`<meta property="${p}" content="[^"]+"`));
    for (const n of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) expect(html).toMatch(new RegExp(`<meta name="${n}" content="[^"]+"`));
    expect(html).toContain('content="https://recall.walkeforward.com/icon-512.png"');
  });

  it('the app has a way back to the landing page', () => {
    expect(html).toMatch(/<footer>[\s\S]*<a href="\/">About Recall<\/a>[\s\S]*<\/footer>/);
  });

  it('shows the hero at its own size, with a description', () => {
    const [, w, h] = hero.match(/viewBox="0 0 (\d+) (\d+)"/)!;
    expect(landing).toContain(`<img src="/landing-hero.svg" width="${w}" height="${h}" alt="`);
    const boats = hero.match(/(\d+) boats/)![1];
    expect(landingText).toContain(`${boats} J/105s`);
  });
});

describe('the landing page script', () => {
  const full: LastView = {
    v: 1,
    eventId: 'fDHdPcEOM6mcMRkdXNnj',
    division: 'J70',
    raceNumber: 8,
    leg: null,
    boat: null,
    sort: null,
    tab: 'coach',
    eventTitle: 'Benelux Sailing League Act III',
    raceName: 'Race 8',
    savedAt: 1,
  };

  it('reads the app record: same key, the names it saved', () => {
    expect(LANDING_KEY).toBe(LAST_VIEW_KEY);
    const raw = serializeLastView(full);
    expect(parseLastView(raw)).toEqual(full);
    expect(continueLink(raw)).toEqual({ href: REGATTAS_PATH, label: 'Continue: Benelux Sailing League Act III · J70 · Race 8' });
  });

  /** The record without the names (as written before the landing page). */
  const unnamed = (): LastView => {
    const r = { ...full };
    delete r.eventTitle;
    delete r.raceName;
    return r;
  };

  it('names an older record (no names) by its division and race; a rebuilt race by its division only', () => {
    const old = unnamed();
    expect(continueLink(serializeLastView(old))?.label).toBe('Continue your last race: J70 · Race 8');
    expect(continueLink(serializeLastView({ ...old, raceNumber: 202605141205 }))?.label).toBe('Continue your last race: J70');
  });

  it('offers nothing for a record the app would not reopen', () => {
    for (const raw of [null, '', 'nope', '{}', JSON.stringify({ ...full, v: 2 }), JSON.stringify({ ...full, eventId: 'x' }), JSON.stringify({ ...full, raceNumber: 0 })]) {
      expect(continueLink(raw)).toBeNull();
      if (raw) expect(parseLastView(raw)).toBeNull();
    }
  });

  it('drops malformed names from a record and keeps the rest', () => {
    const raw = JSON.stringify({ ...JSON.parse(serializeLastView(full)), eventTitle: '<b>x</b>', raceName: 7 });
    expect(parseLastView(raw)).toEqual(unnamed());
  });

  describe('startLanding', () => {
    afterEach(() => vi.unstubAllGlobals());
    const fakeDoc = () => {
      const prices = [{ textContent: '?' }, { textContent: '?' }];
      const cont = { href: '/regattas', textContent: 'Continue your last race', hidden: true };
      const doc = { querySelectorAll: () => prices, getElementById: (id: string) => (id === 'landing-continue' ? cont : null) };
      return { doc: doc as unknown as Document, prices, cont };
    };

    it('fills in the price and shows Continue when a race was viewed', () => {
      vi.stubGlobal('localStorage', { getItem: (k: string) => (k === LAST_VIEW_KEY ? serializeLastView(full) : null) });
      const { doc, prices, cont } = fakeDoc();
      startLanding(doc);
      expect(prices.map((p) => p.textContent)).toEqual([PRICE_REGATTA, PRICE_REGATTA]);
      expect(cont).toEqual({ href: REGATTAS_PATH, textContent: 'Continue: Benelux Sailing League Act III · J70 · Race 8', hidden: false });
    });

    it('keeps Continue hidden with nothing saved, or no storage', () => {
      vi.stubGlobal('localStorage', { getItem: () => null });
      const a = fakeDoc();
      startLanding(a.doc);
      expect(a.cont.hidden).toBe(true);
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('denied');
        },
      });
      const b = fakeDoc();
      startLanding(b.doc);
      expect(b.cont.hidden).toBe(true);
    });
  });
});

describe('the hero (public/landing-hero.svg)', () => {
  const f = JSON.parse(readFileSync(here('./fixtures/j105_r3.json'), 'utf8')) as HeroFixture & {
    regatta: { revisions: { doc: { divisions: { participants: { sailNumber: string; boatName?: string; [k: string]: unknown }[] }[] } }[] };
  };
  const participants = f.regatta.revisions.flatMap((r) => r.doc.divisions.flatMap((d) => d.participants));

  it('is current: scripts/landing-hero.mjs output from tests/fixtures/j105_r3.json', () => {
    expect(heroFromFixture(f, 'J105', 3)).toBe(hero);
  });

  it('is small, and drawn for both Day and Night', () => {
    expect(hero.length).toBeLessThan(150 * 1024);
    expect(hero).toContain('@media (prefers-color-scheme:dark)');
    expect(hero).toMatch(/<title id="t">[^<]+<\/title>/);
  });

  it('labels boats by sail number only: no boat, owner or crew names', () => {
    const sails = new Set(participants.map((p) => p.sailNumber));
    const labels = [...hero.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(labels).toContain('Wind');
    const boats = labels.filter((l) => l !== 'Wind');
    expect(boats.length).toBeGreaterThan(0);
    for (const l of boats) expect(sails.has(l), l).toBe(true);
    // Every name-like string in the fixture's participants (boat names and any other text field but the sail number).
    const names = participants.flatMap((p) => Object.entries(p).filter(([k, v]) => k !== 'sailNumber' && k !== 'bowNumber' && typeof v === 'string' && v.trim().length > 2).map(([, v]) => v as string));
    expect(names.length).toBeGreaterThan(0);
    const low = hero.toLowerCase();
    for (const n of names) expect(low.includes(n.toLowerCase()), n).toBe(false);
  });

  it('simplify keeps the ends and drops points within the tolerance', () => {
    expect(simplify([[0, 0], [1, 0.1], [2, 0], [3, 5]], 0.5)).toEqual([[0, 0], [2, 0], [3, 5]]);
    expect(simplify([[0, 0]], 1)).toEqual([[0, 0]]);
  });

  it('positionAt interpolates between close fixes, none across a hole', () => {
    const seg = { x: [0, 10, 20], y: [0, 0, 0], t: [0, 1000, 60_000] };
    expect(positionAt([seg], 500, 30_000)).toEqual([5, 0]);
    expect(positionAt([seg], 30_000, 30_000)).toBeNull();
    expect(positionAt([seg], 70_000, 30_000)).toBeNull();
  });
});
