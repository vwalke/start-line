#!/usr/bin/env node
// Screenshots for the landing page's "What Recall shows" cards (index.html `.land-card`): one shot per card from
// the running app on public RaceSense races, written to public/landing/ as WebP:
//   <slug>-thumb.webp, <slug>-thumb@2x.webp   the card's thumbnail, THUMB_W × THUMB_H css px at 1x and 2x
//   <slug>.webp                                the full-size image the lightbox opens (FULL_W px wide at most)
//
// Usage (Recall's dev or preview server running; it proxies /api to RaceSense and Yachtscoring, so it needs the network):
//   npx vite --port 5173 --strictPort            (or: npm run build && npx vite preview --port 5173)
//   node scripts/landing-thumbs.mjs [--base http://localhost:5173] [--only replay,start] [--out public/landing]
//                                   [--png-dir /tmp/landing-png] [--no-name-check]
// Pick a port Node's fetch allows: undici refuses its "bad ports" (4190 among them), and the script checks the
// server with fetch before it starts. --png-dir keeps the raw captures, a failed shot's too when it got that far.
//
// Playwright is not a dependency of this repo. The script imports playwright-core from PLAYWRIGHT_CORE (a path to
// the package's index.js) when set, else the bare specifier; Chrome comes from CHROME (default /usr/bin/google-chrome):
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.js CHROME=/usr/bin/google-chrome node scripts/landing-thumbs.mjs
//
// No names: sail numbers only. Every RaceSense regatta document and Yachtscoring response the page fetches is
// rewritten in flight. Boat names and Yachtscoring's owner and crew fields are removed (a boat named for its coach
// role becomes "Coach", so the analysis still sets it aside), and the capture CSS hides .bname / .rp-name as well.
// Before each capture the shot's element (text, SVG text and titles, title / aria-label / alt attributes) is
// searched for every removed string (whole words, case-sensitive; one-word strings that are also the app's own
// words, NOT_NAMES, are skipped), and the shot fails if one is found.
//
// Encoding needs no extra tool. Playwright captures a PNG (deviceScaleFactor 2, light theme, reduced motion),
// and a blank page in the same Chrome redraws it on a canvas at the target size and encodes it with
// canvas.toBlob('image/webp', q). q steps down until the file is within its budget.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const THUMB_W = 320;
export const THUMB_H = 200;
const FULL_W = 1280;
const VIEWPORT = { width: 1280, height: 900 };
export const BUDGET = { thumb: 60 * 1024, full: 250 * 1024 };
const QUALITIES = [0.86, 0.8, 0.74, 0.68, 0.62, 0.56, 0.5, 0.44, 0.38];
const WAIT_MS = 180_000;

// ---- the races (public demo events only) ----------------------------------------------------------------------

/** J/70 Worlds, Cascais: Open, RaceSense race 4 (Recall's Race 3); USA 833 for the boat views. */
const CASCAIS = { event: 'oRkxbTpSZPbSkrmKrbj2', div: 'Open', race: '4' };
const CASCAIS_BOAT = 'USA 833';
/** J/105 CBC: race 1 (18 boats, official results from Yachtscoring 50575). */
const J105 = { event: '3McCGTOsVxYFWRvGnl7O', div: 'J105', race: '1' };
/**
 * The debrief and the report: J/105 race 3, USA 343. USA 833's Cascais races are thin (race 4 16% on the live feed;
 * race 3 24% on its fixture, under the Coach's 25% line), so Coach found little. On tests/fixtures/j105_r3.json,
 * a 4 s subsample of the live feed (so a floor for it), USA 343 covers 85% of the race with three cards (D6, D4, D3)
 * and a Went well.
 */
const J105_R3 = { ...J105, race: '3' };
const DEBRIEF_BOAT = 'USA 343';
/**
 * The replay shot: Cascais RaceSense race 3, REPLAY_T s after the gun, 8×, following USA 833 as it rounds the
 * windward mark. Chosen from tests/fixtures/cascais_r3.json, which keeps that race's native rate (holes too) from
 * 75 s before to 165 s after each windward rounding: there 24 of the 25 boats nearest USA 833 have a fix within 3 s
 * (filled hulls) and about 75% of their last minute of trail is drawn, all within ~90 m. The public J/70 feed has
 * frequent 3–6 s holes, so most other moments show many hollow hulls and broken trails (race 4 at 1200 s did).
 */
const CASCAIS_R3 = { ...CASCAIS, race: '3' };
const REPLAY_T = 2095;
/** 2026 IC37 North American Championship, race 4: the start shot (a 274 m line, pin favored, ~18 boats at the gun). */
const IC37_R4 = { event: 'VaWTh1uA7TrLejoSFlUn', div: 'IC37', race: '4' };

/** The app's view preferences (ui/speed.ts, sog.ts, labels.ts, startSog.ts): cleared before every shot. */
const PREF_KEYS = ['recall.trackColour', 'recall.rankBy', 'recall.speedTop', 'recall.sogScale', 'recall.startColour', 'recall.startNames', 'recall.startSogWindow', 'recall.lastView'];

/**
 * One shot per landing card, in the cards' order.
 *   el:     the element captured (an array: the box around all of them, which must fit in the viewport)
 *   thumb:  a tighter element (or the box around several) for the thumbnail (default: the same capture)
 *   thumbClip: instead of `thumb`, a function run in the page that returns the thumbnail's clip rect (css px)
 *   focus:  where the thumbnail's crop sits in the capture, [x, y] from 0 to 1; zoom: crop tighter than cover
 *   hide:   selectors hidden for the capture (parts of the element that aren't what the card describes)
 *   fullMaxH: the full image's tallest (px; cropped from the top)
 *   viewport: this shot's viewport (default VIEWPORT)
 *   afterThumb: with thumbClip, steps run after the thumbnail is taken and before the full image
 */
export const SHOTS = [
  {
    slug: 'replay',
    card: 'Replay the race',
    race: CASCAIS_R3,
    params: { boat: CASCAIS_BOAT, t: String(REPLAY_T), trail: '120' },
    hash: 'race',
    ready: ['#map-chart svg', '#map-full-race:not([hidden])'],
    steps: async (page) => {
      await page.click('#map-zoom button[data-zoom="8"]');
      // Upwind the follow camera keeps the boat a third in from the trailing edge (ui/follow.ts), so the pack sits low
      // with open water ahead: two arrow-key pans (10% of the view each, ui/panzoom.ts KEY_PAN) bring it to the middle.
      await page.focus('#map-chart');
      for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown');
    },
    el: '#panel-race > section.card:first-of-type',
    thumb: '#map-chart',
    hide: ['#map-tip'],
    zoom: 1.25,
  },
  {
    slug: 'track-colors',
    card: 'Track colors',
    race: J105,
    hash: 'race',
    prefs: { 'recall.trackColour': 'sog' },
    ready: ['#map-chart svg', '#map-speed-key:not([hidden])'],
    el: '#panel-race > section.card:first-of-type',
    thumb: '#map-chart',
    hide: ['#map-tip'],
  },
  {
    slug: 'start',
    card: 'The start',
    race: IC37_R4,
    hash: 'start',
    ready: ['#start-chart svg'],
    // Full screen's Fit (ui/charts.ts startFullFrame) fits the line and the bows at the gun to the width and puts
    // spare height below them, so the viewport's height only decides how much water is left under the 60 s tracks.
    // The thumbnail is taken at this height (room for the whole line at 16:10); then `afterThumb` trims it.
    viewport: { width: 1280, height: 800 },
    steps: async (page) => {
      await stable(page, ['#start-chart'], WAIT_MS);
      // Full screen (ui/app.ts): the card's tools go to #fs-tools, the speed key and chip line to #fs-key, the chart
      // to #fs-body. Speed and Auto first: the speed key's row resizes #fs-body, which refits; then Fit.
      await page.click('#start-full');
      await page.waitForSelector('#fs:not([hidden]) #fs-body #start-chart svg', { timeout: WAIT_MS });
      await page.click('#fs-tools button[data-start-colour="speed"]');
      await page.click('#fs-tools button[data-start-names="auto"]');
      await page.waitForSelector('#fs-key #start-speed-key:not([hidden])', { timeout: WAIT_MS });
      await settle(page);
      await page.click('#fs-tools #start-zoom button[data-zoom="1"]');
    },
    // The key and chip row and the chart: not the zoom / color / names bar or Close above them.
    el: ['#fs-key', '#fs-body'],
    /**
     * The thumbnail: the line, its ends and their labels (PIN / RC and the favored-end label) always whole; then as
     * much of the named boats and their tracks as 16:10 holds, centered on them, with no edge through a label.
     * Line and fleet here are much wider than 16:10, so the box is as wide as the line needs and the spare height
     * goes below, where the tracks are.
     */
    thumbClip: ({ w, h }) => {
      const body = document.querySelector('#fs-body').getBoundingClientRect();
      const svg = document.querySelector('#fs-body svg.chart.start');
      const rects = (sel) => [...svg.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((r) => r.width || r.height);
      const boxOf = (rs) => ({
        x0: Math.max(body.left, Math.min(...rs.map((r) => r.left))),
        y0: Math.max(body.top, Math.min(...rs.map((r) => r.top))),
        x1: Math.min(body.right, Math.max(...rs.map((r) => r.right))),
        y1: Math.min(body.bottom, Math.max(...rs.map((r) => r.bottom))),
      });
      const pad = 16;
      const aspect = w / h;
      const line = boxOf(rects('.startline, .pin, .rc, .endlbl, .fav-lbl'));
      const all = boxOf(rects('.startline, .pin, .rc, .endlbl, .fav-lbl, g.boat:not(.nolbl), .trail'));
      const labels = rects('.endlbl, .fav-lbl, g.boat:not(.nolbl) .blbl');
      const need = line.x1 - line.x0 + 2 * pad;
      const width = Math.max(need, Math.min(all.x1 - all.x0 + 2 * pad, (all.y1 - all.y0 + 2 * pad) * aspect));
      // Centered on everything, then moved as little as keeps the line in.
      let x0 = Math.min(Math.max((all.x0 + all.x1) / 2 - width / 2, line.x1 + pad - width), line.x0 - pad);
      let x1 = x0 + width;
      // An edge through a name or end label moves out past it.
      for (let pass = 0, moved = true; moved && pass < 8; pass++) {
        moved = false;
        for (const r of labels) {
          if (r.left < x0 && r.right > x0) [x0, moved] = [r.left - 4, true];
          if (r.left < x1 && r.right > x1) [x1, moved] = [r.right + 4, true];
        }
      }
      let y0 = all.y0 - pad;
      let y1 = y0 + (x1 - x0) / aspect;
      // Inside the chart: shifted back in where it can be, cut where it is bigger.
      const fit = (a, b, lo, hi) => (b - a >= hi - lo ? [lo, hi] : a < lo ? [lo, lo + b - a] : b > hi ? [hi - (b - a), hi] : [a, b]);
      [x0, x1] = fit(x0, x1, body.left, body.right);
      [y0, y1] = fit(y0, y1, body.top, body.bottom);
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    },
    // The full image: the viewport cut down to the lowest track plus the scale bar under it (ui/charts.ts scaleBar
    // sits 8 px off the bottom with its label above), then Fit again, which keeps the same scale and top.
    afterThumb: async (page) => {
      const { bottom, tracks } = await page.evaluate(() => {
        const body = document.querySelector('#fs-body').getBoundingClientRect();
        const rs = [...document.querySelectorAll('#fs-body svg.chart.start .trail')].map((e) => e.getBoundingClientRect()).filter((r) => r.width || r.height);
        return { bottom: body.bottom, tracks: rs.length ? Math.max(...rs.map((r) => r.bottom)) : body.bottom };
      });
      const cut = Math.floor(bottom - (tracks + 40));
      if (cut <= 0) return;
      const vp = page.viewportSize();
      await page.setViewportSize({ width: vp.width, height: Math.max(480, vp.height - cut) });
      await settle(page);
      await page.click('#fs-tools #start-zoom button[data-zoom="1"]');
    },
    hide: ['#fs-rotate'],
  },
  {
    slug: 'around-the-gun',
    card: 'Around the gun',
    race: CASCAIS,
    params: { boat: CASCAIS_BOAT },
    hash: 'start',
    ready: ['#start-chart svg'],
    steps: async (page) => {
      await page.locator('#lane-snapshots').scrollIntoViewIfNeeded();
      await page.waitForSelector('#lane-snapshots .lane-stage svg', { timeout: WAIT_MS });
      await page.$eval('#lane-snapshots .lane-range', (r) => {
        r.value = '0';
        r.dispatchEvent(new Event('input', { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.click('#lane-snapshots .lane-zoom button[data-zoom="4"]');
    },
    el: '#lane-snapshots',
    thumb: '#lane-snapshots .lane-stage',
  },
  {
    slug: 'legs',
    card: 'Leg by leg',
    race: J105,
    hash: 'race',
    ready: ['#table table'],
    el: '#legs-table-card',
    hide: ['#table-top', '#legs-table-card .table-hint'],
    focus: [0, 0],
    zoom: 1.6,
  },
  {
    slug: 'places',
    card: 'Place changes',
    race: J105,
    hash: 'race',
    ready: ['#places-chart svg'],
    el: '#places-card',
    thumb: '#places-chart',
    hide: ['#places-tip'],
  },
  {
    slug: 'debrief',
    card: 'A debrief for your boat',
    race: J105_R3,
    params: { boat: DEBRIEF_BOAT },
    hash: 'coach',
    ready: ['#coach-ladder svg', '#coach-cards .coach-opps'],
    until: () => !document.querySelector('#coach-ladder .coach-none'),
    el: '#panel-coach',
    // The gap chart and, under it, the row of cards (three abreast on a wide screen).
    thumb: ['#coach-ladder-card', '#coach-cards .coach-opps'],
    hide: ['#coach-pick', '#coach-ask', '#coach-regatta', '#coach-legs', '#coach-ladder-tip'],
    focus: [0.5, 0],
    fullMaxH: 1600,
  },
  {
    slug: 'regatta',
    card: 'Your whole regatta',
    race: CASCAIS,
    params: { boat: CASCAIS_BOAT, cview: 'regatta' },
    hash: 'coach',
    ready: ['#coach-regatta:not([hidden]) .rp'],
    until: () => {
      const r = document.querySelector('#coach-regatta');
      return !!r && !r.hidden && !r.querySelector('.busy, [aria-busy="true"]');
    },
    wait: 600_000,
    el: '#coach-regatta',
    focus: [0.5, 0],
    fullMaxH: 1600,
  },
  {
    slug: 'report',
    card: 'A one-page report',
    race: J105_R3,
    params: { boat: DEBRIEF_BOAT },
    hash: 'report',
    // ui/app.ts renderReport: the article's data-state is 'pending' until the official link has settled (none here).
    ready: ['#report:not([hidden]) > article.report[data-state="ready"]'],
    el: '#report',
    focus: [0.5, 0],
    zoom: 1.4,
    fullMaxH: 1600,
  },
  {
    slug: 'official-results',
    card: 'Official results',
    race: J105,
    hash: 'race',
    ready: ['#race-head:not([hidden]) details.info'],
    until: () => /official · YS \d+/.test(document.querySelector('#race-head')?.textContent ?? ''),
    steps: async (page) => {
      await page.$eval('#race-head details.info', (d) => (d.open = true));
    },
    el: ['#summary', '#race-head'],
    hide: ['#report-open'],
    focus: [0, 0],
  },
];

/** The files a shot writes to public/landing/ (the landing page's src, srcset and data-full). */
export const filesOf = (slug) => ({ thumb: `${slug}-thumb.webp`, thumb2x: `${slug}-thumb@2x.webp`, full: `${slug}.webp` });

// ---- arguments ---------------------------------------------------------------------------------------------------

function args(argv) {
  const o = { base: 'http://localhost:5173', only: null, out: join(root, 'public', 'landing'), pngDir: null, nameCheck: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--base') o.base = next().replace(/\/$/, '');
    else if (a === '--only') o.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') o.out = resolve(next());
    else if (a === '--png-dir') o.pngDir = resolve(next());
    else if (a === '--no-name-check') o.nameCheck = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument ${a} (see the top of scripts/landing-thumbs.mjs)`);
  }
  return o;
}

// ---- names out of the data ---------------------------------------------------------------------------------------

/** functions/_lib.ts YS_PERSONAL: keys that name or reach a person (the production proxy removes them; vite's doesn't). */
const PERSONAL = /owner|crew|skipper|helm|captain|email|phone|mobile|contact|firstname|lastname|fullname|person|member|yachtclub|homeport|hometown|biography|photo|avatar|user/i;
/** A boat's name, on an object that has a sail number (RaceSense participants, Yachtscoring result rows). */
const BOAT_NAME = /^(name|boatName|boat_name|yachtName|yacht_name)$/;

/** A person's first and last name fields, for the full name as it would be shown. */
const FIRST = /^(first_?name|given_?name|first)$/i;
const LAST = /^(last_?name|family_?name|surname|last)$/i;

/**
 * The strings in `v` worth looking for on screen, into `names` (each with where it came from): 4+ characters with
 * a word in them (not a country code, id or date), and a person's first and last name joined as well.
 */
function collect(v, names, from) {
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length >= 4 && /\p{L}{2}/u.test(s) && !names.has(s)) names.set(s, from);
  } else if (Array.isArray(v)) v.forEach((x) => collect(x, names, `${from}[]`));
  else if (v && typeof v === 'object') {
    const first = Object.entries(v).find(([k, x]) => FIRST.test(k) && typeof x === 'string')?.[1];
    const last = Object.entries(v).find(([k, x]) => LAST.test(k) && typeof x === 'string')?.[1];
    if (first && last) collect(`${first.trim()} ${last.trim()}`, names, `${from} (first + last)`);
    for (const [k, x] of Object.entries(v)) collect(x, names, `${from}.${k}`);
  }
}

/** `x` without personal fields and boat names (at any depth); every string removed goes into `names`, with its path. */
export function scrub(x, names, path = '') {
  if (Array.isArray(x)) return x.map((v) => scrub(v, names, `${path}[]`));
  if (!x || typeof x !== 'object') return x;
  const boat = 'sailNumber' in x;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    const at = path ? `${path}.${k}` : k;
    if (k === 'deviceSubs') {
      collect(v, names, at);
      out[k] = [];
    } else if (PERSONAL.test(k)) collect(v, names, at);
    else if (boat && BOAT_NAME.test(k)) {
      collect(v, names, at);
      if (typeof v === 'string' && /\bcoach\b/i.test(v)) out[k] = 'Coach';
    } else out[k] = scrub(v, names, at);
  }
  return out;
}

/**
 * One-word strings that are also the app's own words, so not looked for (the data rewrite still removes them):
 *   Mark   a first name, and the app's "Mark roundings", "Mark" (a rounding's title when the mark has no name), mark names
 *   Coach  what a coach boat's name becomes here, and the Coach tab
 * A name of two or more words is always looked for.
 */
export const NOT_NAMES = new Set(['Mark', 'Coach']);

/** Whether `name` is in `text` as a whole word (or words), case as written. */
export function nameIn(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

async function route(context, names, hits) {
  await context.route('**/api/**', async (r) => {
    const u = new URL(r.request().url());
    // Sign-in, payments, Ask Coach and boat-log uploads: off (the page reads a failure as off).
    if (/^\/api\/(auth|billing|coach|vkx)(\/|$)/.test(u.pathname)) return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    const kind = u.pathname === '/api/regatta' ? 'regatta' : u.pathname.startsWith('/api/ys/') ? 'ys' : null;
    if (!kind) return r.continue();
    const res = await r.fetch();
    const type = res.headers()['content-type'] ?? '';
    if (!res.ok() || !type.includes('json')) return r.fulfill({ response: res });
    const body = JSON.stringify(scrub(await res.json(), names));
    hits[kind]++;
    const headers = { ...res.headers() };
    for (const h of ['content-length', 'content-encoding', 'transfer-encoding', 'etag']) delete headers[h];
    return r.fulfill({ status: res.status(), headers, contentType: 'application/json', body });
  });
}

/** The strings of `names` found in the elements (text, SVG text and titles, the attributes a reader or tooltip shows). */
async function namesIn(page, selectors, names) {
  const text = await page.evaluate((selectors) => {
    const parts = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      parts.push(el.textContent ?? '');
      for (const n of [el, ...el.querySelectorAll('*')]) {
        for (const a of ['title', 'aria-label', 'alt', 'aria-valuetext', 'placeholder', 'value', 'data-tip']) {
          const v = n.getAttribute(a);
          if (v) parts.push(v);
        }
      }
    }
    return parts.join('\n');
  }, selectors);
  return [...names].filter(([n]) => !NOT_NAMES.has(n) && nameIn(text, n));
}

// ---- capture -----------------------------------------------------------------------------------------------------

const CAPTURE_CSS = `
*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }
.bname, .rp-name, .map-tip, [role="tooltip"], .touch-hint { display: none !important; }
.tabs, .boatbar { position: static !important; }
`;

function urlOf(base, shot) {
  const q = new URLSearchParams({ event: shot.race.event, div: shot.race.div, race: shot.race.race, ...(shot.params ?? {}) });
  return `${base}/?${q.toString().replace(/\+/g, '%20')}#${shot.hash}`;
}

/** Until the elements' markup stops changing (renders after data arrives, official results relinking the race). */
async function stable(page, selectors, timeout) {
  const t0 = Date.now();
  let last = '';
  let same = 0;
  while (Date.now() - t0 < timeout) {
    const now = await page.evaluate((sels) => sels.map((s) => document.querySelector(s)?.innerHTML.length ?? -1).join(','), selectors);
    same = now === last ? same + 1 : 0;
    last = now;
    if (same >= 3) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`still changing after ${Math.round(timeout / 1000)} s: ${selectors.join(', ')}`);
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(400);
}

/** The PNG of one element, or of the box around several (which has to fit in the viewport). */
async function capture(page, el, vh = VIEWPORT.height) {
  const sels = Array.isArray(el) ? el : [el];
  if (sels.length === 1) return page.locator(sels[0]).first().screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
  const boxOf = () =>
    page.evaluate((s) => {
      const rs = s.map((x) => document.querySelector(x)?.getBoundingClientRect()).filter((r) => r && r.width && r.height);
      if (!rs.length) return null;
      const x0 = Math.min(...rs.map((r) => r.left));
      const y0 = Math.min(...rs.map((r) => r.top));
      return { x: x0, y: y0, width: Math.max(...rs.map((r) => r.right)) - x0, height: Math.max(...rs.map((r) => r.bottom)) - y0 };
    }, sels);
  let box = await boxOf();
  if (!box) throw new Error(`nothing on screen for ${sels.join(' + ')}`);
  if (box.height > vh) throw new Error(`${sels.join(' + ')} is ${Math.round(box.height)} px tall, more than the viewport`);
  if (box.y < 0 || box.y + box.height > vh) {
    await page.evaluate((dy) => window.scrollBy(0, dy), box.y - 8);
    box = await boxOf();
  }
  return page.screenshot({ type: 'png', clip: box, animations: 'disabled', caret: 'hide' });
}

async function shoot(context, o, shot, names, hits) {
  const page = await context.newPage();
  if (shot.viewport) await page.setViewportSize(shot.viewport);
  page.on('pageerror', (e) => console.warn(`  [${shot.slug}] page error: ${e.message}`));
  await page.addInitScript(
    ({ keys, prefs }) => {
      try {
        for (const k of keys) localStorage.removeItem(k);
        for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v);
      } catch {
        /* storage off: the defaults */
      }
    },
    { keys: PREF_KEYS, prefs: shot.prefs ?? {} },
  );
  const wait = shot.wait ?? WAIT_MS;
  try {
    const url = urlOf(o.base, shot);
    console.log(`${shot.slug}: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    for (const sel of shot.ready) await page.waitForSelector(sel, { state: 'attached', timeout: wait });
    if (shot.until) await page.waitForFunction(shot.until, null, { timeout: wait, polling: 500 });
    const els = Array.isArray(shot.el) ? shot.el : [shot.el];
    await stable(page, els, wait);
    if (shot.steps) await shot.steps(page);
    await page.addStyleTag({ content: CAPTURE_CSS + (shot.hide?.length ? `${shot.hide.join(', ')} { display: none !important; }` : '') });
    await page.mouse.move(0, 0);
    await stable(page, els, wait);
    await settle(page);

    // Captured before the checks, so a failed shot's PNGs can still go to --png-dir to look at (never to --out).
    const vh = () => page.viewportSize()?.height ?? VIEWPORT.height;
    let thumb = null;
    if (shot.thumbClip) {
      thumb = await page.screenshot({ type: 'png', clip: await page.evaluate(shot.thumbClip, { w: THUMB_W, h: THUMB_H }), animations: 'disabled', caret: 'hide' });
      if (shot.afterThumb) {
        await shot.afterThumb(page);
        await stable(page, els, wait);
        await settle(page);
      }
    }
    const full = await capture(page, shot.el, vh());
    thumb ??= shot.thumb ? await capture(page, shot.thumb, vh()) : full;
    let error = null;
    if (!hits.regatta) error = 'the regatta document never came through the route, so boat names could not be removed';
    else if (o.nameCheck) {
      const found = await namesIn(page, [...els, ...[shot.thumb ?? []].flat()], names);
      if (found.length) error = `names on screen: ${found.map(([n, from]) => `${JSON.stringify(n)} (removed from ${from})`).join(', ')}`;
    }
    return { full, thumb, error };
  } finally {
    await page.close();
  }
}

// ---- encoding (in Chrome) ----------------------------------------------------------------------------------------

/**
 * `png` redrawn and encoded as WebP at quality `q`. mode 'cover': exactly w × h, cropped at `focus` (zoom > 1 crops
 * tighter); mode 'width': at most w wide (never upscaled), at most maxH tall (cropped from the top).
 */
async function webp(enc, png, spec, q) {
  const b64 = await enc.evaluate(
    async ({ src, spec, q }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      let sx = 0;
      let sy = 0;
      let sw = iw;
      let sh = ih;
      let w;
      let h;
      if (spec.mode === 'cover') {
        w = spec.w;
        h = spec.h;
        const k = Math.max(w / iw, h / ih) * (spec.zoom ?? 1);
        sw = Math.min(iw, w / k);
        sh = Math.min(ih, h / k);
        sx = (iw - sw) * spec.focus[0];
        sy = (ih - sh) * spec.focus[1];
      } else {
        w = Math.min(spec.w, iw);
        const k = w / iw;
        h = Math.round(ih * k);
        if (spec.maxH && h > spec.maxH) {
          h = spec.maxH;
          sh = h / k;
        }
      }
      // Halve in steps first: one big downscale on a canvas aliases fine lines and text.
      let from = img;
      let fx = sx;
      let fy = sy;
      let fw = sw;
      let fh = sh;
      while (fw / 2 >= w && fh / 2 >= h) {
        const c = document.createElement('canvas');
        c.width = Math.round(fw / 2);
        c.height = Math.round(fh / 2);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(from, fx, fy, fw, fh, 0, 0, c.width, c.height);
        from = c;
        fx = 0;
        fy = 0;
        fw = c.width;
        fh = c.height;
      }
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const g = out.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      g.imageSmoothingQuality = 'high';
      g.drawImage(from, fx, fy, fw, fh, 0, 0, w, h);
      const blob = await new Promise((r) => out.toBlob(r, 'image/webp', q));
      if (!blob || blob.type !== 'image/webp') throw new Error('this Chrome cannot encode WebP');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { data: btoa(s), w, h };
    },
    { src: `data:image/png;base64,${png.toString('base64')}`, spec, q },
  );
  return { buf: Buffer.from(b64.data, 'base64'), w: b64.w, h: b64.h };
}

/** The best quality within `budget` bytes (the lowest quality, with a warning, when none is). */
async function encodeWithin(enc, png, spec, budget) {
  let got;
  for (const q of QUALITIES) {
    got = { ...(await webp(enc, png, spec, q)), q };
    if (got.buf.length <= budget) return got;
  }
  return { ...got, over: true };
}

// ---- main --------------------------------------------------------------------------------------------------------

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_CORE)).href : 'playwright-core';
  try {
    const m = await import(spec);
    return m.chromium ?? m.default?.chromium;
  } catch (e) {
    console.error(
      `Could not load playwright-core (${process.env.PLAYWRIGHT_CORE ? `PLAYWRIGHT_CORE=${process.env.PLAYWRIGHT_CORE}` : 'bare import'}): ${e.message}\n` +
        'It is not a dependency of this repo. Point PLAYWRIGHT_CORE at an installed copy, e.g.\n' +
        '  PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.js node scripts/landing-thumbs.mjs',
    );
    process.exit(2);
  }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) {
    console.log('node scripts/landing-thumbs.mjs [--base http://localhost:5173] [--only slug,slug] [--out dir] [--png-dir dir] [--no-name-check]');
    console.log(`slugs: ${SHOTS.map((s) => s.slug).join(', ')}`);
    return;
  }
  const shots = o.only ? SHOTS.filter((s) => o.only.includes(s.slug)) : SHOTS;
  const unknown = (o.only ?? []).filter((s) => !SHOTS.some((x) => x.slug === s));
  if (unknown.length) throw new Error(`Unknown slug ${unknown.join(', ')}; the slugs: ${SHOTS.map((s) => s.slug).join(', ')}`);

  const chromium = await loadPlaywright();
  const executablePath = process.env.CHROME || '/usr/bin/google-chrome';
  const browser = await chromium.launch({ executablePath, headless: true }).catch((e) => {
    console.error(`Could not start Chrome at ${executablePath} (set CHROME): ${e.message}`);
    process.exit(2);
  });
  const failed = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US' });
    /** Every string the route removed, with where it came from. */
    const names = new Map();
    const hits = { regatta: 0, ys: 0 };
    await route(context, names, hits);
    try {
      const probe = await fetch(o.base);
      if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    } catch (e) {
      console.error(`No Recall server at ${o.base} (${e.message}). Start one: npx vite --port 5173 --strictPort`);
      process.exit(2);
    }
    const enc = await browser.newPage();
    await enc.goto('about:blank');
    mkdirSync(o.out, { recursive: true });
    if (o.pngDir) mkdirSync(o.pngDir, { recursive: true });

    for (const shot of shots) {
      let pngs;
      try {
        pngs = await shoot(context, o, shot, names, hits);
      } catch (e) {
        console.error(`  ${shot.slug}: FAILED: ${e.message}`);
        failed.push(shot.slug);
        continue;
      }
      if (o.pngDir) {
        writeFileSync(join(o.pngDir, `${shot.slug}.png`), pngs.full);
        if (pngs.thumb !== pngs.full) writeFileSync(join(o.pngDir, `${shot.slug}-thumb.png`), pngs.thumb);
      }
      if (pngs.error) {
        console.error(`  ${shot.slug}: FAILED: ${pngs.error}${o.pngDir ? ` (the capture is in ${o.pngDir})` : ''}`);
        failed.push(shot.slug);
        continue;
      }
      const cover = { mode: 'cover', focus: shot.focus ?? [0.5, 0.5], zoom: shot.zoom ?? 1 };
      const f = filesOf(shot.slug);
      const files = [
        [f.thumb, pngs.thumb, { ...cover, w: THUMB_W, h: THUMB_H }, BUDGET.thumb],
        [f.thumb2x, pngs.thumb, { ...cover, w: THUMB_W * 2, h: THUMB_H * 2 }, BUDGET.thumb],
        [f.full, pngs.full, { mode: 'width', w: FULL_W, maxH: shot.fullMaxH }, BUDGET.full],
      ];
      for (const [name, png, spec, budget] of files) {
        const got = await encodeWithin(enc, png, spec, budget);
        writeFileSync(join(o.out, name), got.buf);
        console.log(`  ${name.padEnd(34)} ${`${got.w}×${got.h}`.padEnd(10)} q${got.q.toFixed(2)}  ${kb(got.buf.length)}${got.over ? `  OVER the ${kb(budget)} budget` : ''}`);
      }
    }
    console.log(`Removed ${names.size} name strings from ${hits.regatta} regatta and ${hits.ys} Yachtscoring responses.`);
  } finally {
    await browser.close();
  }
  if (failed.length) {
    console.error(`Failed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
