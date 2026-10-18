import { describe, expect, it } from 'vitest';
import type { LandingEvent } from '../src/data/racesense/types';
import { eventHaystack, filterEvents, matchCountLabel, pickerOptions, searchKeyAction } from '../src/ui/eventSearch';

const ms = (iso: string): number => Date.parse(iso);

const m24: LandingEvent = {
  eventId: 'm24-worlds-2026',
  title: '2026 Melges 24 Worlds',
  classLabel: 'Melges 24',
  division: 'Melges 24',
  venue: 'Harbor Springs, Michigan, United States',
  dateLabel: '17–28 Sep 2026',
  fleetLabel: '54 boats',
  startMs: ms('2026-09-17T12:00:00Z'),
  endMs: ms('2026-09-28T12:00:00Z'),
  capturedRaceTime: null,
};
const multi: LandingEvent = {
  eventId: 'abc123',
  title: 'Charleston Race Week',
  classLabel: 'J/70 · VX One · Melges 24',
  venue: 'Charleston, South Carolina, United States',
  dateLabel: '10–13 Apr 2026',
  fleetLabel: '210 boats',
  startMs: ms('2026-04-10T12:00:00Z'),
  endMs: ms('2026-04-13T12:00:00Z'),
};
const malmo: LandingEvent = {
  eventId: 'sweden-j70',
  title: 'Swedish J/70 Cup',
  classLabel: 'J/70',
  division: 'J70 Open',
  venue: 'Malmö, Sweden',
  startMs: ms('2025-06-05T12:00:00Z'),
  endMs: ms('2025-06-07T12:00:00Z'),
};
const bare: LandingEvent = { eventId: 'xyz-789', title: 'Club Night', venue: '', startMs: ms('2025-11-02T12:00:00Z'), endMs: ms('2025-11-02T12:00:00Z') };

const all = [m24, multi, malmo, bare];
const ids = (q: string): string[] => filterEvents(all, q).map((e) => e.eventId);

describe('eventHaystack', () => {
  it('covers every searchable field plus year and month names', () => {
    const h = eventHaystack(m24);
    for (const w of ['2026 melges 24 worlds', 'harbor springs', '17–28 sep 2026', '54 boats', 'm24-worlds-2026', 'september']) {
      expect(h).toContain(w);
    }
    expect(eventHaystack(malmo)).toContain('malmo');
  });

  it('skips missing dates and empty fields', () => {
    expect(eventHaystack({ eventId: 'x', title: 'X', venue: '', startMs: 0, endMs: 0 })).toBe('x x');
  });
});

describe('filterEvents', () => {
  it('returns the input unchanged for an empty or blank query', () => {
    expect(filterEvents(all, '')).toBe(all);
    expect(filterEvents(all, '   ')).toBe(all);
  });

  it('matches title, venue, division, fleet and event id', () => {
    expect(ids('worlds')).toEqual(['m24-worlds-2026']);
    expect(ids('harbor springs')).toEqual(['m24-worlds-2026']);
    expect(ids('south carolina')).toEqual(['abc123']);
    expect(ids('open')).toEqual(['sweden-j70']);
    expect(ids('210')).toEqual(['abc123']);
    expect(ids('xyz-789')).toEqual(['xyz-789']);
    expect(ids('abc12')).toEqual(['abc123']);
  });

  it('matches classes with or without punctuation, including multi-class labels', () => {
    expect(ids('j70')).toEqual(['abc123', 'sweden-j70']);
    expect(ids('J/70')).toEqual(['abc123', 'sweden-j70']);
    expect(ids('vx one')).toEqual(['abc123']);
    expect(ids('melges')).toEqual(['m24-worlds-2026', 'abc123']);
  });

  it('matches the date label and the year/month from the timestamps', () => {
    expect(ids('sep')).toEqual(['m24-worlds-2026']);
    expect(ids('april')).toEqual(['abc123']);
    expect(ids('june 2025')).toEqual(['sweden-j70']); // no dateLabel: from startMs
    expect(ids('november')).toEqual(['xyz-789']);
    expect(ids('2025')).toEqual(['sweden-j70', 'xyz-789']);
  });

  it('requires every word (AND), in any order', () => {
    expect(ids('melges charleston')).toEqual(['abc123']);
    expect(ids('2026 melges')).toEqual(['m24-worlds-2026', 'abc123']);
    expect(ids('michigan j70')).toEqual([]);
  });

  it('ignores case and diacritics on both sides', () => {
    expect(ids('MALMO')).toEqual(['sweden-j70']);
    expect(ids('malmö')).toEqual(['sweden-j70']);
    expect(filterEvents([{ ...bare, title: 'Regata Cádiz' }], 'CADIZ')).toHaveLength(1);
  });

  it('keeps the input order and returns nothing for no match', () => {
    expect(filterEvents([...all].reverse(), 'united states').map((e) => e.eventId)).toEqual(['abc123', 'm24-worlds-2026']);
    expect(ids('zzz')).toEqual([]);
  });
});

describe('matchCountLabel', () => {
  it('counts all events when there is no query', () => {
    expect(matchCountLabel(48, 48, '')).toBe('48 events');
    expect(matchCountLabel(1, 1, ' ')).toBe('1 event');
  });

  it('counts matches against the total', () => {
    expect(matchCountLabel(3, 48, 'j70')).toBe('3 of 48 events');
    expect(matchCountLabel(1, 48, 'worlds')).toBe('1 of 48 events');
  });

  it('names the query when nothing matches', () => {
    expect(matchCountLabel(0, 48, ' xyz ')).toBe('No events match “xyz”');
  });
});

describe('searchKeyAction', () => {
  it('clears on Escape only when there is a query', () => {
    expect(searchKeyAction('Escape', 'j70', 2)).toBe('clear');
    expect(searchKeyAction('Escape', '', 48)).toBeNull();
  });

  it('picks on Enter only with exactly one match and a non-empty query', () => {
    expect(searchKeyAction('Enter', 'zzz', 0)).toBeNull();
    expect(searchKeyAction('Enter', 'worlds', 1)).toBe('pick');
    expect(searchKeyAction('Enter', 'j70', 2)).toBeNull();
    expect(searchKeyAction('Enter', '', 1)).toBeNull();
    expect(searchKeyAction('Enter', '  ', 1)).toBeNull();
  });

  it('ignores other keys', () => {
    expect(searchKeyAction('a', 'j70', 1)).toBeNull();
    expect(searchKeyAction('ArrowDown', 'j70', 1)).toBeNull();
  });
});

describe('pickerOptions', () => {
  it('lists the matches when the loaded event is among them', () => {
    const { options, matches } = pickerOptions(all, 'j70', 'abc123');
    expect(matches.map((e) => e.eventId)).toEqual(['abc123', 'sweden-j70']);
    expect(options.map((o) => o.label)).toEqual(['Charleston Race Week — 10–13 Apr 2026', 'Swedish J/70 Cup']);
  });

  it('keeps a non-matching loaded event first, marked (current), outside the match count', () => {
    const { options, matches } = pickerOptions(all, 'j70', 'm24-worlds-2026');
    expect(matches).toHaveLength(2);
    expect(options[0]).toEqual({ eventId: 'm24-worlds-2026', label: '2026 Melges 24 Worlds — 17–28 Sep 2026 (current)' });
    expect(options).toHaveLength(3);
  });

  it('holds only the loaded event when nothing matches', () => {
    const { options, matches } = pickerOptions(all, 'zzz', 'xyz-789');
    expect(matches).toEqual([]);
    expect(options).toEqual([{ eventId: 'xyz-789', label: 'Club Night (current)' }]);
    expect(pickerOptions(all, 'zzz', '').options).toEqual([]);
  });
});
