import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLastView, resolveStart, serializeLastView, startTab, type LastView } from '../src/ui/lastView';
import { DEFAULT_TAB, TABS, initialTab, parseTab, tabForKey, tabFromHash, tabHash, withTabHash } from '../src/ui/tabs';

const rec: LastView = {
  v: 1,
  eventId: 'm24-worlds-2026',
  division: 'M24',
  raceNumber: 4,
  leg: 1,
  boat: 'b870',
  sort: { key: 'L0.sog', dir: 'desc' },
  savedAt: 1_760_000_000_000,
};

describe('tab parse / serialize', () => {
  it('names three tabs, Start by default', () => {
    expect(TABS).toEqual(['start', 'race', 'coach']);
    expect(DEFAULT_TAB).toBe('start');
    expect(parseTab('race')).toBe('race');
    expect(parseTab('coach')).toBe('coach');
    for (const bad of [null, undefined, '', 'Race', 'legs', 1, {}]) expect(parseTab(bad)).toBeNull();
  });

  it('reads and writes the hash', () => {
    expect(tabFromHash('#race')).toBe('race');
    expect(tabFromHash('#start')).toBe('start');
    expect(tabFromHash('race')).toBe('race');
    for (const h of ['', '#', '#legs', '#Race', null, undefined]) expect(tabFromHash(h)).toBeNull();
    for (const t of TABS) expect(tabFromHash(tabHash(t))).toBe(t);
  });

  it('sets the hash without touching the race in the query', () => {
    const href = 'https://recall.example/?event=abcd1234&div=J70&race=8&nc=all';
    expect(withTabHash(href, 'race')).toBe(`${href}#race`);
    expect(withTabHash(`${href}#start`, 'race')).toBe(`${href}#race`);
    expect(withTabHash('https://recall.example/', 'start')).toBe('https://recall.example/#start');
  });

  it('arrow keys wrap, Home / End jump, other keys do nothing', () => {
    expect(tabForKey('start', 'ArrowRight')).toBe('race');
    expect(tabForKey('race', 'ArrowRight')).toBe('coach');
    expect(tabForKey('coach', 'ArrowRight')).toBe('start');
    expect(tabForKey('start', 'ArrowLeft')).toBe('coach');
    expect(tabForKey('race', 'Home')).toBe('start');
    expect(tabForKey('start', 'End')).toBe('coach');
    for (const k of ['ArrowUp', 'ArrowDown', 'Enter', 'a']) expect(tabForKey('start', k)).toBeNull();
  });
});

describe('recall.lastView tab', () => {
  it('an old record (no tab) still parses, and serializes without one', () => {
    const old = parseLastView(serializeLastView(rec))!;
    expect(old).toEqual(rec);
    expect(old.tab).toBeUndefined();
    expect(serializeLastView(rec)).not.toContain('"tab"');
  });

  it('round-trips a tab', () => {
    const withTab: LastView = { ...rec, tab: 'race' };
    expect(parseLastView(serializeLastView(withTab))).toEqual(withTab);
  });

  it('drops a bad tab, keeping the rest of the record', () => {
    for (const tab of ['legs', 'RACE', 3, null, {}]) expect(parseLastView(JSON.stringify({ ...rec, tab }))).toEqual(rec);
  });
});

describe('which tab opens', () => {
  const raced: LastView = { ...rec, tab: 'race' };
  const link = '?event=m24-worlds-2026&div=M24&race=4';
  const other = '?event=m24-worlds-2026&div=M24&race=5';

  it('initialTab: hash, else the saved tab when restoring, else Start', () => {
    expect(initialTab('#race', 'start', true)).toBe('race');
    expect(initialTab('#start', 'race', true)).toBe('start');
    expect(initialTab('', 'race', true)).toBe('race');
    expect(initialTab('', 'race', false)).toBe('start');
    expect(initialTab('', undefined, true)).toBe('start');
    expect(initialTab('#bogus', 'race', true)).toBe('race');
  });

  it('a bare launch restores the saved tab; an old record opens Start', () => {
    expect(startTab('', resolveStart('', raced), raced)).toBe('race');
    expect(startTab('', resolveStart('', rec), rec)).toBe('start');
    expect(startTab('', resolveStart('', null), null)).toBe('start');
  });

  it('a hash on the URL beats lastView', () => {
    expect(startTab('#start', resolveStart('', raced), raced)).toBe('start');
    expect(startTab('#race', resolveStart(link, rec), rec)).toBe('race');
    expect(startTab('#race', resolveStart(other, raced), raced)).toBe('race');
  });

  it('a link without a hash behaves as before: Start, or the saved tab only for that same race', () => {
    expect(startTab('', resolveStart(link, raced), raced)).toBe('race');
    expect(startTab('', resolveStart(other, raced), raced)).toBe('start');
    expect(startTab('', resolveStart(link, null), null)).toBe('start');
    // The race in the query is untouched by the tabs.
    expect(resolveStart(link, raced)).toMatchObject({ source: 'url', params: { eventId: 'm24-worlds-2026', want: { division: 'M24', raceNumber: 4 } } });
  });
});

describe('index.html', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const panel = (id: string): string => {
    const start = html.indexOf(`<div id="${id}"`);
    const next = html.indexOf('<div id="panel-', start + 10);
    return html.slice(start, next > 0 ? next : html.indexOf('</main>'));
  };

  it('an accessible tablist: tabs control their panels, Start selected', () => {
    expect(html).toMatch(/<div id="tabs" class="tabs" role="tablist" aria-label="Digest">/);
    expect(html).toContain('id="tab-start" aria-controls="panel-start" aria-selected="true" tabindex="0"');
    expect(html).toContain('id="tab-race" aria-controls="panel-race" aria-selected="false" tabindex="-1"');
    expect(html).toContain('<div id="panel-start" class="panel" role="tabpanel" aria-labelledby="tab-start"');
    expect(html).toMatch(/<div id="panel-race" class="panel" role="tabpanel" aria-labelledby="tab-race" tabindex="-1" hidden>/);
  });

  it('Start: start chart, speed through the start, start findings and table; Race: map, place changes, findings, legs table', () => {
    const start = panel('panel-start');
    const race = panel('panel-race');
    for (const id of ['start-chart', 'start-findings', 'start-sog-chart', 'start-table']) expect(start).toContain(`id="${id}"`);
    for (const id of ['map-chart', 'places-chart', 'race-findings-card', 'race-notes', 'table']) expect(race).toContain(`id="${id}"`);
    for (const id of ['map-chart', 'places-chart', 'legs-table-card']) expect(start).not.toContain(`id="${id}"`);
    for (const id of ['start-chart', 'start-sog-chart', 'start-table-card']) expect(race).not.toContain(`id="${id}"`);
    // The race header and the boat list sit outside the panels (shared by both).
    expect(html.indexOf('id="summary"')).toBeLessThan(html.indexOf('id="tabs"'));
    expect(html.indexOf('id="boat-list"')).toBeLessThan(html.indexOf('id="panel-start"'));
  });
});
