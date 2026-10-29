/**
 * Places from the tracker finish (`~`) are explained where they are listed, as an unofficial finish order:
 * Fall Brawl J/70 R3 without official results (tracker finishes), with them (official places), and with them
 * but no official times (official places, tracker times: nothing unofficial shown).
 */
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { analysedFinishes, summarizeRegatta, type RegattaRace } from '../src/analysis/coach/regatta';
import type { RaceAnalysis } from '../src/analysis/types';
import { boatList } from '../src/ui/boats';
import { coachChips, coachGroupHtml } from '../src/ui/coach';
import { regattaPlacesHtml } from '../src/ui/coachRegatta';
import { raceHead } from '../src/ui/races';
import { buildReport } from '../src/ui/report';
import { reportHtml } from '../src/ui/reportView';
import { legsTable, startTable } from '../src/ui/table';
import { fallbrawlOfficial, fallbrawlRace } from './helpers';

const TIP = 'These places come from when each boat&#39;s tracker crossed the finish line, not from official results.';
const NOTE = `<p class="unofficial-note" title="${TIP}">~ Unofficial finish order</p>`;
const PRINTED = `<p class="unofficial-note"><b>~ Unofficial finish order.</b> ${TIP}</p>`;
const head = (a: RaceAnalysis) =>
  raceHead({ race: undefined, official: { status: 'off' }, feed: { status: 'idle', used: 0, max: 0, found: 0, exhausted: false }, results: a.meta.results });
const LEADERS = { kind: 'leaders' } as const;
const report = (a: RaceAnalysis, boat: string, scope: 'race' | 'regatta' = 'race') => {
  const b = a.boats.find((x) => x.id === boat)!;
  const regatta: RegattaRace = {
    raceNumber: 3,
    label: 'R3',
    name: 'Race 3',
    status: 'done',
    digest: { raceNumber: 3, sail: b.sail, tracked: true, finish: analysedFinishes(a).get(b.sail)!, coverage: 0.95, noData: false, legs: [], findings: [] },
  };
  const s = summarizeRegatta([regatta]);
  return { html: reportHtml(buildReport({ a, boat, raceName: 'Race 3', model: null, group: LEADERS, scope, regatta: s })), places: regattaPlacesHtml(s) };
};
/** The Fin column's cells, in table order. */
const finCells = (html: string): string[] => [...html.matchAll(/<td class="[^"]*sticky0[^"]*">(.*?)<\/td>/g)].map((m) => m[1]);

describe('the unofficial finish order', () => {
  const tracker = analyzeRace(fallbrawlRace('j70r3'));
  const official = analyzeRace(fallbrawlRace('j70r3', fallbrawlOfficial('j70r3')));
  // Official places, but no official finish times: the times come from the trackers' crossings.
  const off = fallbrawlOfficial('j70r3');
  const trackerTimes = analyzeRace(fallbrawlRace('j70r3', { ...off, rows: off.rows.map((r) => ({ ...r, finishWallMs: null })) }));
  const first = (a: RaceAnalysis) => a.boats.find((b) => b.finishPos === 1)!;

  it('tracker finishes: ~ places in the boat list, with the note (visible text, its tooltip) and the label', () => {
    expect(tracker.meta.results).toMatchObject({ places: 'tracker' });
    const html = boatList(tracker, null);
    expect(html).toMatch(/<span class="pos">~1<\/span>/);
    expect(html).toContain(NOTE);
    expect(html).toMatch(/finished 1, unofficial"/);
    expect(coachChips(tracker, first(tracker))[0]).toMatchObject({ text: expect.stringMatching(/^~1st of \d+$/), title: 'Unofficial place' });
  });

  it('the Fin column and Coach’s Custom list mark tracker places ~', () => {
    for (const html of [startTable(tracker, null), legsTable(tracker, null)]) {
      const cells = finCells(html);
      expect(cells).toContain('<span title="Unofficial place">~1</span>');
      expect(cells.filter((c) => /^\d+$/.test(c))).toEqual([]);
      expect(html).toContain('~ = unofficial');
    }
    expect(coachGroupHtml(tracker, first(tracker).id, LEADERS, false)).toMatch(/> ~2nd /);
  });

  it('the race report: ~ on the water, the note spelled out under the header; the regatta report and places too', () => {
    const r = report(tracker, first(tracker).id);
    expect(r.html).toMatch(/<dt>On the water<\/dt><dd>~1st of \d+<small>unofficial<\/small><\/dd>/);
    expect(r.html).toContain(`${PRINTED}</header>`);
    expect(r.html.split('Unofficial finish order').length).toBe(2);
    const g = report(tracker, first(tracker).id, 'regatta');
    expect(g.html.split('Unofficial finish order').length).toBe(2);
    expect(g.html).toContain(PRINTED);
    expect(g.places).toContain(NOTE);
    expect(g.places).toContain('title="Race 3: 1st of');
    expect(g.places).toMatch(/, unofficial">/);
  });

  it('a boat with no tracker finish: no ~ and no note in its report', () => {
    const none = tracker.boats.find((b) => b.finishPos == null);
    if (!none) return;
    expect(report(tracker, none.id).html).not.toContain('Unofficial finish order');
  });

  it('official places: no ~ and no note', () => {
    expect(official.meta.results).toMatchObject({ places: 'official' });
    const html = boatList(official, null);
    expect(html).not.toContain('class="pos">~');
    expect(html).not.toContain('Unofficial finish order');
  });

  it('official places with tracker times: nothing unofficial anywhere', () => {
    expect(trackerTimes.meta.results).toMatchObject({ places: 'official', times: 'tracker' });
    const b = first(trackerTimes);
    expect(b.finishSource).toBe('tracker');
    const shown = [
      boatList(trackerTimes, null),
      startTable(trackerTimes, null),
      legsTable(trackerTimes, null),
      coachGroupHtml(trackerTimes, b.id, LEADERS, false),
      JSON.stringify(coachChips(trackerTimes, b)),
      report(trackerTimes, b.id).html,
      ...Object.values(report(trackerTimes, b.id, 'regatta')),
    ];
    // The footer's "Recall · unofficial" is about the app, not the places.
    for (const html of shown.map((h) => h.replace(/<footer class="rp-foot">.*?<\/footer>/, ''))) {
      expect(html).not.toMatch(/unofficial/i);
      expect(html).not.toMatch(/>~\d|~\d+(st|nd|rd|th)/);
    }
    expect(coachChips(trackerTimes, b)[0]).toMatchObject({ text: expect.stringMatching(/^1st of \d+$/), title: 'Official place' });
  });

  it('nothing about tracker finishes in the race banner; "no finishes" still warns', () => {
    const k = head(tracker);
    expect(k.chips.map((c) => c.text).join(' ')).not.toMatch(/tracker|~/);
    expect(k.bullets.join(' ')).not.toMatch(/tracker finish/i);
    const none = raceHead({ race: undefined, official: { status: 'off' }, feed: { status: 'idle', used: 0, max: 0, found: 0, exhausted: false }, results: { places: 'tracker', times: 'tracker', trackerFinishes: 0 } });
    expect(none.chips).toContainEqual(expect.objectContaining({ text: 'no finishes', warn: true }));
    expect(none.bullets).toContain('Neither RaceSense nor the tracks give finishes for this race (no finish-line crossing found).');
  });
});
