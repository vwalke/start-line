import { describe, expect, it } from 'vitest';
import { LIVE_SPAN_MS, liveTag, type LiveTagFacts } from '../src/data/live';
import { raceTitleHtml } from '../src/ui/races';

const GUN = Date.parse('2026-10-31T15:25:01Z');
const NOW = GUN + 20 * 60_000;
const m = { eventName: 'J/70 North Americans', boatClass: 'J/70', raceNumber: 8 };
const facts = (f: Partial<LiveTagFacts> = {}): LiveTagFacts => ({ gunMs: GUN, eventOver: false, officialIn: false, officialWanted: true, ...f });
const title = (f: Partial<LiveTagFacts>, now = NOW): string => raceTitleHtml(m, undefined, false, liveTag(facts(f), now));

describe('the race title’s Live tag', () => {
  it('shows on a current race with no official results yet', () => {
    expect(title({})).toBe('<h2>J/70 North Americans · J/70 · Race 8 <span class="live-tag">Live</span></h2>');
    // No Yachtscoring link: still tagged while the race is today's.
    expect(title({ officialWanted: false })).toContain('class="live-tag"');
  });

  it('goes once the race’s official results are linked', () => {
    expect(title({ officialIn: true })).toBe('<h2>J/70 North Americans · J/70 · Race 8</h2>');
  });

  it('never shows on an event that is over, or an old race with no official results to come', () => {
    expect(title({ eventOver: true }, GUN + 30 * 86_400_000)).not.toContain('live-tag');
    expect(title({ eventOver: true, officialWanted: false })).not.toContain('live-tag');
    // A current event's earlier race with no Yachtscoring link: only within the live span of its gun.
    expect(title({ officialWanted: false }, GUN + LIVE_SPAN_MS)).not.toContain('live-tag');
    // …but a linked division's race keeps it while its results are still to come.
    expect(title({}, GUN + LIVE_SPAN_MS)).toContain('live-tag');
  });

  it('keeps the refresh note quiet, after the tag, and no tag before the gun', () => {
    const html = raceTitleHtml(m, undefined, false, true, ' <span class="race-live">updated 11:32</span>');
    expect(html).toMatch(/Live<\/span> <span class="race-live">updated 11:32<\/span><\/h2>$/);
    expect(html.match(/Live/g)).toHaveLength(1);
    expect(liveTag(facts(), GUN - 1)).toBe(false);
  });
});
