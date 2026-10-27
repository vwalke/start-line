import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { legStories } from '../src/analysis/coach/legStory';
import { startReplays } from '../src/analysis/startReplay';
import { ACT, ACT_CHIP, ACT_KEY, ACT_MORE, ACT_ROW } from '../src/ui/act';
import { boatList } from '../src/ui/boats';
import { legLegend } from '../src/ui/charts';
import { coachGroupHtml, coachViewHtml } from '../src/ui/coach';
import { askPanelHtml } from '../src/ui/coachAsk';
import { coachCardsHtml } from '../src/ui/coachCards';
import { legStoriesHtml } from '../src/ui/coachLegs';
import { infoHtml } from '../src/ui/info';
import { cardMapActions } from '../src/ui/mapLink';
import { replayControls, startReplayLinks } from '../src/ui/replay';
import { contrast } from '../src/ui/speed';
import { legsTable, startTable } from '../src/ui/table';
import { ic37Race } from './helpers';

/**
 * Data actions (ui/act.ts) against quiet controls, on IC37 North Americans race 5: everything that opens or shows
 * real data carries the shared classes and a name; the controls that only change the view never do.
 */
const data = ic37Race();
const a = analyzeRace(data);
const raw = coachRaw(a, data);
const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null)!;
const replays = startReplays(a, data);
const idOf = (sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
const boat = idOf('USA 027');
const deb = coachDebrief(a, m, boat)!;

/** Every element (its opening tag and text) whose class list includes `cls`. */
function tagged(html: string, tag: string, cls: string): { attrs: string; text: string }[] {
  const re = new RegExp(`<${tag}\\b([^>]*\\bclass="[^"]*")([^>]*)>([\\s\\S]*?)</${tag}>`, 'g');
  return [...html.matchAll(re)]
    .filter((x) => new RegExp(`class="(?:[^"]* )?${cls}(?: [^"]*)?"`).test(x[1]))
    .map((x) => ({ attrs: `${x[1]}${x[2]}`, text: x[3].replace(/<[^>]+>/g, '').trim() }));
}
/** A name a screen reader reads: its aria-label, else its text. */
const nameOf = (e: { attrs: string; text: string }): string => /aria-label="([^"]+)"/.exec(e.attrs)?.[1] ?? e.text;
/** Any of the data-action classes. */
const ACT_ANY = /class="(?:[^"]* )?act(?:-(?:chip|row|key|more))?(?: [^"]*)?"/;

describe('data actions: the shared classes', () => {
  it('names the classes once', () => {
    expect(ACT).toBe('act');
    expect(ACT_CHIP).toBe('act act-chip');
    expect([ACT_ROW, ACT_KEY, ACT_MORE]).toEqual(['act-row', 'act-key', 'act-more']);
  });

  it('the boat list: every boat is a named row, its sail number the cue', () => {
    const items = tagged(boatList(a, null), 'button', ACT_ROW);
    expect(items).toHaveLength(a.boats.length);
    for (const it of items) expect(nameOf(it)).toMatch(/^#\S+/);
    expect(boatList(a, null)).toContain(`<b class="sail ${ACT_KEY}">`);
  });

  it('both tables: every row selects its boat, the sail number the cue', () => {
    for (const html of [startTable(a, null), legsTable(a, boat)]) {
      expect(html.match(/<tr data-id="[^"]+" class="act-row(?: sel)?" tabindex="0">/g)).toHaveLength(a.boats.length);
      expect(html).toContain(`<span class="${ACT_KEY}">#USA 027</span>`);
    }
  });

  it("Coach cards: the window chip and Show on map, each named; the facts beside them stay plain chips", () => {
    const html = coachCardsHtml(a, deb, null);
    const chips = tagged(html, 'button', 'act-chip');
    expect(deb.cards.length).toBeGreaterThan(0);
    expect(chips).toHaveLength(deb.cards.length);
    for (const c of chips) expect(nameOf(c)).toMatch(/: show on the gap chart$/);
    expect(html).not.toMatch(/<li class="chip[^"]*\bact\b/);
    const links = cardMapActions(a, boat, deb.cards, replays, '').filter(Boolean);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(tagged(l, 'a', ACT).map(nameOf)).toEqual(['Show on map →']);
  });

  it('Replay start, on the map and on the Start tab', () => {
    expect(replays.length).toBeGreaterThan(0);
    const map = tagged(replayControls(a, replays, null, null), 'button', 'act-chip');
    const start = tagged(startReplayLinks(a, replays, null), 'button', ACT);
    expect(map.map(nameOf)).toEqual(replays.map((r) => a.boats.find((b) => b.id === r.boat)!.sail));
    expect(start.map(nameOf)).toEqual(replays.map((r) => `Replay start → ${a.boats.find((b) => b.id === r.boat)!.sail}`));
  });

  it('the Not racing group: its summary, and both switches as inline actions', () => {
    const one = { ...a, excluded: [{ result: a.boats[0], drawing: {} as never, reasons: ['spare tracker'] }] };
    const html = boatList(one, null);
    expect(html).toContain('<summary class="act-more">Not racing (1)</summary>');
    expect(tagged(html, 'button', ACT).filter((b) => /data-nc=/.test(b.attrs)).map(nameOf)).toEqual(['Show all as competitors']);
    const all = boatList({ ...a, allCompetitors: { flagged: 2 } }, null);
    expect(tagged(all, 'button', ACT).filter((b) => /data-nc=/.test(b.attrs)).map(nameOf)).toEqual(['Hide them']);
    expect(`${html}${all}`).not.toContain('linkish');
  });

  it('Ask Coach: its summary opens onto data, its starter questions are pills', () => {
    const html = askPanelHtml('race', false, ['Why did I lose places on Beat 1?']);
    expect(html).toContain('<summary class="act-more"><h3 id="coach-ask-title">Ask Coach</h3>');
    expect(tagged(html, 'button', 'act-chip').map(nameOf)).toEqual(['Why did I lose places on Beat 1?']);
  });

  it('sections that open onto data: each leg story, Start Playback', () => {
    const stories = legStories(a, m, boat, { kind: 'leaders' });
    const html = legStoriesHtml(stories, a, boat, { kind: 'leaders' });
    expect(html.match(/<summary class="act-more"><span class="leg-name">/g)).toHaveLength(stories.length);
    const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(index).toContain('<summary class="act-more">Start Playback');
    expect(index).toMatch(/id="report-open" class="report-open act act-chip"[^>]*>Report</);
  });
});

describe('quiet controls never look like data', () => {
  it('Coach: vs group, Each boat, Race | Regatta', () => {
    expect(coachGroupHtml(a, boat, { kind: 'leaders' }, true)).not.toMatch(ACT_ANY);
    expect(coachViewHtml('race')).not.toMatch(ACT_ANY);
  });

  it('the leg legend, the ⓘ help, the sort headers', () => {
    expect(legLegend(a, 1)).not.toMatch(ACT_ANY);
    expect(infoHtml(['One line.'])).not.toMatch(ACT_ANY);
    const head = /<thead>[\s\S]*<\/thead>/.exec(legsTable(a, null))![0];
    expect(head).not.toMatch(ACT_ANY);
  });

  it('the tabs, zoom, speed and trail in the page', () => {
    const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const id of ['tabs', 'start-zoom', 'map-zoom', 'map-speed', 'map-trail']) {
      const at = index.indexOf(`id="${id}"`);
      expect(at).toBeGreaterThan(0);
      expect(index.slice(at, index.indexOf('</div>', at))).not.toMatch(ACT_ANY);
    }
  });
});

describe('data-action colours clear WCAG AA in both schemes', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const dark = css.slice(css.indexOf(":root[data-theme='dark'] {"));
  const token = (src: string, name: string): string => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(src)![1];
  const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  /** color-mix(in srgb, x p%, y). */
  const mix = (x: string, p: number, y: string): string => {
    const [c, d] = [rgb(x), rgb(y)];
    return `#${c.map((v, i) => Math.round(v * p + d[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
  };
  /** Light text on a darker fill (not the other way round): the text is the one further from black. */
  const lightOn = (text: string, bg: string): boolean => contrast(text, '#000000') > contrast(bg, '#000000');
  const AA = 4.5;
  const UI = 3;
  for (const [scheme, src] of [
    ['day', css],
    ['night', dark],
  ] as const) {
    const night = scheme === 'night';
    const accent = token(src, 'accent');
    const ink = token(src, 'ink');
    const ink2 = token(src, 'ink-2');
    const surface = token(src, 'surface');
    const page = token(src, 'page');
    const grid = token(src, 'grid');
    const bad = token(src, 'bad');
    const badBg = token(src, 'bad-bg');
    const actInk = mix(accent, 0.85, ink);
    const actLine = mix(actInk, 0.8, surface);
    const actBg = mix(accent, 0.08, surface);
    const actBgHover = mix(accent, 0.15, surface);
    /** Everything an underline (an inline action, a row's sail number) or a pill's ring sits on. */
    const under: Record<string, string> = {
      page,
      surface,
      'a sorted column': mix(accent, night ? 0.18 : 0.11, surface),
      'a hovered row': mix('#7f7f7f', 0.08, surface),
      'a picked boat (card)': mix(accent, 0.12, surface),
      'a picked boat (phone strip)': mix(accent, 0.12, page),
      'a hovered boat': grid,
      'a pill at rest': actBg,
      'a hovered pill': actBgHover,
      'the Ask Coach panel': mix(accent, 0.09, surface),
    };

    it(`${scheme}: text, hovered and pressed`, () => {
      for (const bg of [page, surface, actBg, actBgHover]) expect(contrast(actInk, bg)).toBeGreaterThanOrEqual(AA);
      // Pressed (held down) on the hovered tint.
      expect(contrast(mix(accent, 0.6, ink), actBgHover)).toBeGreaterThanOrEqual(AA);
    });

    it(`${scheme}: the underline at rest, 3:1 on everything it sits on`, () => {
      for (const [where, bg] of Object.entries(under)) expect(contrast(actLine, bg), where).toBeGreaterThanOrEqual(UI);
      // A Coach card's accent edge, on the card.
      expect(contrast(actLine, surface)).toBeGreaterThanOrEqual(UI);
    });

    it(`${scheme}: an on chip is light text on a solid fill, as in Day`, () => {
      const on = night ? mix(accent, 0.75, page) : accent;
      const onInk = night ? ink : surface;
      expect(contrast(onInk, on)).toBeGreaterThanOrEqual(AA);
      expect(lightOn(onInk, on)).toBe(true);
      expect(contrast(on, surface)).toBeGreaterThanOrEqual(UI);
    });

    it(`${scheme}: the over-early Replay start, red and still a pill`, () => {
      for (const bg of [badBg, mix(bad, 0.2, surface)]) expect(contrast(bad, bg)).toBeGreaterThanOrEqual(AA);
      for (const bg of [surface, page]) expect(contrast(mix(bad, 0.75, surface), bg)).toBeGreaterThanOrEqual(UI);
      const on = night ? mix(bad, 0.5, page) : bad;
      const onInk = night ? ink : surface;
      expect(contrast(onInk, on)).toBeGreaterThanOrEqual(AA);
      expect(lightOn(onInk, on)).toBe(true);
    });

    it(`${scheme}: a selected control's ring stands out from an unselected one, its text on the tint`, () => {
      const sel = mix(ink, 0.18, surface);
      expect(contrast(ink, sel)).toBeGreaterThanOrEqual(AA);
      // The ink-2 ring against the unselected button (surface) and the page around it.
      for (const bg of [surface, page, sel]) expect(contrast(ink2, bg)).toBeGreaterThanOrEqual(UI);
    });
  }

  it('the tokens are the ones the stylesheet uses', () => {
    expect(css).toContain('--act-ink: color-mix(in srgb, var(--accent) 85%, var(--ink));');
    expect(css).toContain('--act-line: color-mix(in srgb, var(--act-ink) 80%, var(--surface));');
    expect(css).toContain('--act-bg: color-mix(in srgb, var(--accent) 8%, var(--surface));');
    expect(css).toContain('--act-bg-hover: color-mix(in srgb, var(--accent) 15%, var(--surface));');
    expect(css).toContain('--act-press: color-mix(in srgb, var(--accent) 60%, var(--ink));');
    expect(css).toContain('--act-on: var(--accent);');
    expect(css).toContain('--act-on-ink: var(--surface);');
    expect(dark).toContain('--act-on: color-mix(in srgb, var(--accent) 75%, var(--page));');
    expect(dark).toContain('--act-on-ink: var(--ink);');
    expect(css).toContain('--bad-line: color-mix(in srgb, var(--bad) 75%, var(--surface));');
    expect(css).toContain('--bad-bg-hover: color-mix(in srgb, var(--bad) 20%, var(--surface));');
    expect(css).toContain('--bad-on: var(--bad);');
    expect(dark).toContain('--bad-on: color-mix(in srgb, var(--bad) 50%, var(--page));');
    expect(css).toContain('--sel-bg: color-mix(in srgb, var(--ink) 18%, var(--surface));');
    expect(css).toContain('--sel-line: var(--ink-2);');
    expect(css).toMatch(/\.act-chip\[aria-pressed='true'\] \{ background-color: var\(--chip-on\); [^}]*color: var\(--act-on-ink\); \}/);
    expect(css).toMatch(/\.replay-btn\.act-chip \{ --chip-ink: var\(--bad\); --chip-line: var\(--bad-line\); --chip-bg: var\(--bad-bg\); --chip-bg-hover: var\(--bad-bg-hover\);[^}]*--chip-on: var\(--bad-on\); \}/);
    for (const sel of [".tabs [role='tab'][aria-selected='true']", ".seg button[aria-pressed='true']", ".zoom button[aria-pressed='true']"])
      expect(css).toContain(`${sel} { background: var(--sel-bg); border-color: var(--sel-line); box-shadow: inset 0 0 0 1px var(--sel-line);`);
    expect(css).toMatch(/\.coach-opp \{[^}]*box-shadow: inset 3px 0 0 var\(--act-line\);/);
  });
});

describe('data actions: the stylesheet', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  /** The body of the first rule whose selector is exactly `sel`. */
  const rule = (sel: string, from = 0): string => {
    const at = css.indexOf(`${sel} {`, from);
    expect(at, sel).toBeGreaterThanOrEqual(0);
    return css.slice(at + sel.length + 2, css.indexOf('}', at));
  };
  /** The body of the first `@media (pointer: coarse)` block after `marker`. */
  const coarseAfter = (marker: string): string => {
    const at = css.indexOf('@media (pointer: coarse) {', css.indexOf(marker));
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
    }
    return '';
  };

  it('touch targets grow in the layout: no hit overlay reaching over a neighbour', () => {
    expect(css).not.toMatch(/\.act(?:-more|-chip)?::after/);
    const touch = coarseAfter('---------- data actions');
    expect(touch).toMatch(/\.act:not\(\.act-chip\) \{[^}]*display: inline-flex;[^}]*min-height: 44px;/);
    expect(touch).toMatch(/\.act-chip \{[^}]*border-width: 9px 0;[^}]*min-height: 44px;/);
    expect(touch).toMatch(/details > summary\.act-more \{ min-height: 44px; \}/);
    expect(touch).not.toMatch(/position: absolute/);
    // Report leaves its absolute spot and floats, so the title and gun line wrap round it.
    const report = coarseAfter('.report-open { position: absolute');
    expect(report).toMatch(/\.report-open \{ position: static; float: right;[^}]*min-height: 44px;/);
    expect(report).toContain('.report-open ~ #summary::after { content: \'\'; display: block; clear: both; }');
  });

  it('table rows: a minimum height on the cells, nothing inside clipped', () => {
    expect(coarseAfter('---------- data actions')).toContain('.metrics tbody tr.act-row > td { height: 44px; }');
    const td = rule('.metrics td');
    expect(td).not.toMatch(/overflow|max-height|(?:^|[ ;])height:/);
    expect(css).not.toMatch(/\.metrics (?:td|\.sub|\.act-key)[^{]*\{[^}]*(?:max-height|(?:^|[ ;])height: \d)/);
    expect(rule('.metrics .sub')).toContain('display: block;');
  });

  it('text actions wrap: no nowrap on .act', () => {
    expect(rule('.act')).not.toContain('white-space');
  });

  it('a summary that opens onto data: no marker in any engine, still focusable with a ring', () => {
    expect(rule('.act-more')).toContain('list-style: none;');
    expect(rule('.act-more::marker')).toContain("content: '';");
    expect(rule('.act-more::-webkit-details-marker')).toContain('display: none;');
    expect(rule('.act-more:focus-visible')).toMatch(/outline: 2px solid var\(--accent\);/);
    // The summary itself is never hidden or taken out of reach (only its markers are).
    expect(css).not.toMatch(/\.act-more(?!::)[^{,]*\{[^}]*(?:pointer-events: none|visibility: hidden|display: none|tabindex)/);
  });

  it('Print / Save PDF is a quiet control, not louder than Report', () => {
    const print = rule('.rp-bar .rp-print');
    expect(print).not.toMatch(/accent|background|font-weight/);
    expect(rule('.rp-bar > button')).toContain('background: var(--surface);');
  });
});
