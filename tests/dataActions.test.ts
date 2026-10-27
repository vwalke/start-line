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
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  const token = (src: string, name: string): string => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(src)![1];
  const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  /** color-mix(in srgb, x p%, y). */
  const mix = (x: string, p: number, y: string): string => {
    const [c, d] = [rgb(x), rgb(y)];
    return `#${c.map((v, i) => Math.round(v * p + d[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
  };
  for (const [scheme, src] of [
    ['day', css],
    ['night', dark],
  ] as const) {
    it(scheme, () => {
      const accent = token(src, 'accent');
      const ink = token(src, 'ink');
      const surface = token(src, 'surface');
      const page = token(src, 'page');
      const actInk = mix(accent, 0.85, ink);
      // Text on the page, a card, the chip at rest and hovered; the pressed chip's text on the accent.
      for (const bg of [page, surface, mix(accent, 0.08, surface), mix(accent, 0.15, surface)]) expect(contrast(actInk, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(surface, accent)).toBeGreaterThanOrEqual(4.5);
      // A selected control: its ink on the neutral tint.
      expect(contrast(ink, mix(ink, 0.12, surface))).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('the tokens are the ones the stylesheet uses', () => {
    expect(css).toContain('--act-ink: color-mix(in srgb, var(--accent) 85%, var(--ink));');
    expect(css).toContain('--act-bg: color-mix(in srgb, var(--accent) 8%, var(--surface));');
    expect(css).toContain('--act-bg-hover: color-mix(in srgb, var(--accent) 15%, var(--surface));');
    expect(css).toContain('--sel-bg: color-mix(in srgb, var(--ink) 12%, var(--surface));');
  });
});
