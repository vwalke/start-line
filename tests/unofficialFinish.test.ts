/**
 * Places from the tracker finish (`~`) are explained where they are listed, as an unofficial finish order:
 * Fall Brawl J/70 R3, without official results (tracker finishes) and with them (official places).
 */
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { boatList } from '../src/ui/boats';
import { coachChips } from '../src/ui/coach';
import { raceHead } from '../src/ui/races';
import { fallbrawlOfficial, fallbrawlRace } from './helpers';

const NOTE = /<p class="nc-note unofficial-note" title="Official results aren&#39;t posted yet\. These places come from when each boat&#39;s tracker crossed the finish line\.">~ Unofficial finish order<\/p>/;
const head = (a: ReturnType<typeof analyzeRace>) =>
  raceHead({ race: undefined, official: { status: 'off' }, feed: { status: 'idle', used: 0, max: 0, found: 0, exhausted: false }, results: a.meta.results });

describe('the unofficial finish order', () => {
  const tracker = analyzeRace(fallbrawlRace('j70r3'));
  const official = analyzeRace(fallbrawlRace('j70r3', fallbrawlOfficial('j70r3')));

  it('tracker finishes: ~ places in the boat list, with the note and its tooltip', () => {
    expect(tracker.meta.results).toMatchObject({ places: 'tracker' });
    const html = boatList(tracker, null);
    expect(html).toMatch(/<span class="pos">~1<\/span>/);
    expect(html).toMatch(NOTE);
    expect(html).toMatch(/finished 1, unofficial \(tracker finish\)/);
    const first = tracker.boats.find((b) => b.finishPos === 1)!;
    expect(coachChips(tracker, first)[0]).toMatchObject({ text: expect.stringMatching(/^1st of \d+$/), title: 'Unofficial place (tracker finish)' });
  });

  it('official places: no ~ and no note', () => {
    expect(official.meta.results).toMatchObject({ places: 'official' });
    const html = boatList(official, null);
    expect(html).not.toContain('class="pos">~');
    expect(html).not.toContain('Unofficial finish order');
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
