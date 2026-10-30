import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { RaceNote } from '../src/analysis/types';
import { mapKey, raceNotesKey, startKey } from '../src/ui/captions';
import { startScale } from '../src/ui/charts';
import { capHtml, infoHtml, keyLineHtml, renderKeepOpen, warnChip, type KeyLine } from '../src/ui/info';
import { placesKey } from '../src/ui/places';
import { startSogKey } from '../src/ui/startSog';
import { startSogSeries } from '../src/analysis/startSog';
import { legsTableKey, startTableKey } from '../src/ui/table';
import { c31Race, fixtureRace, m24Race } from './helpers';

const j70 = analyzeRace(fixtureRace());
const c31 = analyzeRace(c31Race());
const m24 = analyzeRace(m24Race());

describe('chips', () => {
  it('renders facts, ⚠ caveats and legend swatches as one list, the ⓘ last', () => {
    const html = capHtml([{ text: 'Line 143 m' }, warnChip('wind est. low', 'why'), { text: 'line extended', swatch: 'ext' }], infoHtml(['A.']));
    expect(html).toMatch(/^<ul class="chips"><li class="chip">Line 143 m<\/li>/);
    expect(html).toContain('<li class="chip warn" title="why"><span aria-hidden="true">⚠ </span><span class="vh">Warning: </span>wind est. low</li>');
    expect(html).toContain('<li class="chip key"><i class="sw-ext" aria-hidden="true"></i>line extended</li>');
    expect(html).toMatch(/<li class="chip-info"><details class="info">.*<\/details><\/li><\/ul>$/);
  });

  it('escapes chip text and titles', () => {
    expect(capHtml([{ text: '<b>', title: '"x"' }], '')).toBe('<ul class="chips"><li class="chip" title="&quot;x&quot;">&lt;b&gt;</li></ul>');
  });
});

describe('the ⓘ disclosure', () => {
  const html = infoHtml(['First bullet.', 'Second <bullet>.']);
  it('is a native <details>, closed by default, named "How to read this"', () => {
    expect(html).toMatch(/^<details class="info"><summary>/);
    expect(html).not.toContain(' open');
    // The ⓘ glyph is hidden from screen readers; the summary's name is the words.
    expect(html).toContain('<summary><span class="info-i" aria-hidden="true">ⓘ</span><span class="info-lbl">How to read this</span></summary>');
    expect(html).toContain('<li>First bullet.</li><li>Second &lt;bullet&gt;.</li>');
  });
  it('can be drawn open (kept open across redraws) and carry a second list', () => {
    expect(infoHtml(['A.'], { open: true })).toMatch(/^<details class="info" open>/);
    expect(infoHtml(['A.'], { more: { title: 'Per boat', items: ['#1 — x.'] } })).toContain('<p class="info-sub">Per boat</p><ul><li>#1 — x.</li></ul>');
    expect(infoHtml(['A.'], { more: { title: 'Per boat', items: [] } })).not.toContain('Per boat');
  });
  it('keyLineHtml puts a key line together', () => {
    const k: KeyLine = { chips: [{ text: 'x' }], bullets: ['y.'] };
    expect(keyLineHtml(k)).toBe(capHtml(k.chips, infoHtml(k.bullets)));
    expect(keyLineHtml(k, true)).toContain('<details class="info" open>');
  });
  it('renderKeepOpen keeps the ⓘ open across a redraw and skips a no-op', () => {
    const state = { html: '', opened: false, writes: 0 };
    const el = {
      querySelector(sel: string) {
        return sel === 'details.info[open]' && state.opened ? {} : null;
      },
      get innerHTML() {
        return state.html;
      },
      set innerHTML(v: string) {
        state.html = v;
        state.writes++;
      },
    } as unknown as HTMLElement;
    const line = (text: string) => (open: boolean) => keyLineHtml({ chips: [{ text }], bullets: ['y.'] }, open);
    renderKeepOpen(el, line('x'));
    expect(state.html).toContain('<details class="info">');
    expect(state.html).not.toContain(' open');
    renderKeepOpen(el, line('x'));
    expect(state.writes).toBe(1);
    state.opened = true;
    renderKeepOpen(el, line('z'));
    expect(state.html).toContain('<details class="info" open>');
    expect(state.html).toContain('>z</li>');
    renderKeepOpen(el, line('z'));
    expect(state.writes).toBe(2);
  });
});

describe('key lines stay short', () => {
  const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
  const keys: [string, KeyLine, number][] = [
    ['start chart', startKey(j70, { scale: startScale(j70), colour: 'speed' }), 6],
    ['map, leg', mapKey(j70, { colour: 'leg' }), 6],
    ['map, rank', mapKey(j70, { colour: 'rank', rankBy: 'leg' }), 6],
    ['map, speed', mapKey(j70, { colour: 'sog', leg: null }), 6],
    ['places', placesKey(j70), 6],
    ['start speed', startSogKey(startSogSeries(c31, 120), 120), 6],
    // The tables carry one more: the Rank line.
    ['start table', startTableKey(c31), 7],
    ['legs table', legsTableKey(j70), 8],
  ];
  for (const [name, k, max] of keys) {
    it(`${name}: at most ${max} bullets of about 12 words`, () => {
      expect(k.bullets.length).toBeLessThanOrEqual(max);
      for (const b of k.bullets) expect(words(b), b).toBeLessThanOrEqual(15);
      expect(k.chips.length).toBeLessThanOrEqual(7);
      for (const c of k.chips) expect(words(c.text), c.text).toBeLessThanOrEqual(6);
    });
  }
});

describe('start chart key line', () => {
  it('chips the facts; the explanations go in the ⓘ; no "line extended" legend', () => {
    const k = startKey(j70, { scale: startScale(j70) });
    // This fixture's J/70s are to scale at Fit: no size chip.
    expect(k.chips.map((c) => c.text)).toEqual([expect.stringMatching(/^Line \d+ m$/), expect.stringMatching(/^Pin fav\. \d+° · \d+ m$/), 'wind est.']);
    expect(k.chips.some((c) => c.swatch === 'ext')).toBe(false);
    const info = k.bullets.join(' ');
    for (const s of ['Bows at the gun', 'meters behind the line', '5° of wind moves it', 'Names: Auto', 'Hulls: J/70, 6.93 m LOA', 'pinch']) expect(info).toContain(s);
  });
  it('a picked not-racing boat gets the "not racing" swatch, here and on the map', () => {
    const id = m24.excluded[0].result.id;
    expect(startKey(m24, { scale: startScale(m24), highlight: id }).chips).toContainEqual({ text: 'not racing', swatch: 'nc' });
    expect(mapKey(m24, { colour: 'leg', highlight: id }).chips).toContainEqual({ text: 'not racing', swatch: 'nc' });
    expect(mapKey(m24, { colour: 'leg' }).chips.some((c) => c.swatch === 'nc')).toBe(false);
  });
});

describe('map key line', () => {
  it('explains the colour mode on show, and only that one', () => {
    expect(mapKey(j70, { colour: 'leg' }).bullets.join(' ')).not.toMatch(/Rank|Boat speed/);
    expect(mapKey(j70, { colour: 'rank', rankBy: 'overall' }).bullets.join(' ')).toContain('Rank: elapsed-time rank over the race');
    const sog = mapKey(j70, { colour: 'sog', leg: null }).bullets.join(' ');
    expect(sog).toContain('5th–95th percentile');
    expect(sog).toContain('Scale: Per leg');
    expect(mapKey(j70, { colour: 'sog', leg: 1 }).bullets.join(' ')).not.toContain('Scale:');
  });
});

describe('race notes key line (Race findings card)', () => {
  const notes: RaceNote[] = [
    { kind: 'not-racing', text: 'n', n: 5 },
    { kind: 'marks-moved', text: 'm', names: ['Gate'] },
    { kind: 'wind-model', text: 'w' },
    { kind: 'leg-order', text: 'o' },
    { kind: 'shortened', text: 's', dropped: ['M2'] },
    { kind: 'wind-assumed', text: 'a', modelDeg: 120 },
    { kind: 'dtl-off', text: 'd', medianM: 6 },
    { kind: 'finish-unranked', text: 'f', boat: '#9', why: 'too short' },
  ];
  it('⚠ for what changes how the numbers read, first; plain chips for the rest; the full sentence as title', () => {
    const k = raceNotesKey({ notes });
    expect(k.chips.map((c) => `${c.warn ? '⚠ ' : ''}${c.text}`)).toEqual([
      '⚠ leg order from tracks',
      '⚠ course shortened',
      '⚠ wind assumed',
      '⚠ Vakaros DTL off vs GPS',
      '⚠ #9 finish not ranked',
      '5 not racing',
      'Gate moved',
      'model wind',
    ]);
    expect(k.chips.map((c) => c.title)).toEqual(['o', 's', 'a', 'd', 'f', 'n', 'm', 'w']);
    expect(k.bullets).toContain('Too little steady upwind sailing (model 120° far off): first leg assumed upwind.');
    expect(k.bullets).toContain('Course treated as shortened (skipping M2).');
    for (const b of k.bullets) expect(b.split(/\s+/).length, b).toBeLessThanOrEqual(15);
  });
  it('renders nothing for a race without notes (the card hides it)', () => {
    expect(raceNotesKey({ notes: [] })).toEqual({ chips: [], bullets: [] });
    expect(keyLineHtml({ chips: [], bullets: [] })).toBe('<ul class="chips"></ul>');
  });
});

describe('index.html key lines', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  it('has a key line under each chart and table, and none of the old paragraphs', () => {
    for (const id of ['start-cap', 'start-sog-cap', 'start-notes', 'map-cap', 'places-cap', 'race-notes', 'legs-notes']) expect(html).toMatch(new RegExp(`id="${id}"[^>]*>|class="capline[^"]*" id="${id}"`));
    for (const old of ['Names: Auto leaves out', 'GPS tracker tracks (bow offset', 'Hover or tap a dot for the place', 'key-notes', 'TWA / VMG are estimates', 'hint-fine', 'class="warnings"']) expect(html).not.toContain(old);
  });
  it('has the touch hint hidden until the app shows it, with a labelled dismiss button', () => {
    expect(html).toContain('<p class="hint touch-hint" id="start-hint" hidden>');
    expect(html).toContain('<button type="button" id="start-hint-dismiss" class="hint-x" aria-label="Dismiss zoom hint" title="Dismiss">×</button>');
    expect(html).not.toContain('aria-describedby="start-hint"');
  });
});
