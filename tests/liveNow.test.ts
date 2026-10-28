import { describe, expect, it } from 'vitest';
import type { Me } from '../src/data/paywall';
import type { LandingEvent } from '../src/data/racesense/types';
import { LIVE_MAX, LIVE_MAX_DAYS, liveDayText, liveEvents, upcomingEvents } from '../src/data/upcoming';
import { liveCardsHtml, showUpcoming } from '../src/landing/landing';

const ms = (iso: string): number => Date.parse(iso);
const NA = 'Qn47enc7fKR7Th1Qj1ZI';
const OFF: Me = { paywall: false };
const OUT: Me = { paywall: true, user: null, entitlements: [], signIn: { email: true, google: true } };

const ev = (eventId: string, title: string, start: string, end = start, extra: Partial<LandingEvent> = {}): LandingEvent => ({
  eventId,
  title,
  startMs: ms(`${start}T00:00:00Z`),
  endMs: ms(`${end}T00:00:00Z`),
  ...extra,
});

// As /api/landing lists it: Oct 28 – Nov 1, 2026.
const northAmericans: LandingEvent = {
  eventId: NA,
  title: '2026 J/70 North Americans',
  startMs: Date.UTC(2026, 9, 28),
  endMs: Date.UTC(2026, 10, 1),
  classLabel: 'J/70',
  venue: 'Annapolis, MD',
};
const winterSeries = ev('m15-winter', 'M15 DUN L Winter Series', '2026-10-16', '2026-12-19');
const ids = (list: LandingEvent[]): string[] => list.map((e) => e.eventId);

describe('liveEvents', () => {
  it('follows the event’s day in New York, first day through last', () => {
    // 8 pm EDT the evening before (already Oct 28 in UTC): not yet.
    expect(liveEvents([northAmericans], ms('2026-10-28T00:00:00Z'))).toEqual([]);
    expect(liveEvents([northAmericans], ms('2026-10-28T03:59:00Z'))).toEqual([]);
    // 00:30 EDT on the first day.
    expect(ids(liveEvents([northAmericans], ms('2026-10-28T04:30:00Z')))).toEqual([NA]);
    // The last day (Nov 1, EST from 2 am) through 11:59 pm.
    expect(ids(liveEvents([northAmericans], ms('2026-11-02T04:59:00Z')))).toEqual([NA]);
    // The day after.
    expect(liveEvents([northAmericans], ms('2026-11-02T05:00:00Z'))).toEqual([]);
  });

  it('the 2026 J/70 North Americans is live on Oct 28 and Oct 29', () => {
    const oct28 = ms('2026-10-28T16:00:00Z'); // noon EDT, its first day
    const oct29 = ms('2026-10-29T16:00:00Z'); // noon EDT
    expect(ids(liveEvents([northAmericans], oct28))).toEqual([NA]);
    expect(liveDayText(northAmericans, oct28)).toBe('Day 1 of 5');
    expect(ids(liveEvents([northAmericans], oct29))).toEqual([NA]);
    expect(liveDayText(northAmericans, oct29)).toBe('Day 2 of 5');
  });

  it('is never in Upcoming at the same time', () => {
    for (const t of ['2026-10-28T03:59:00Z', '2026-10-28T04:00:00Z', '2026-10-30T12:00:00Z', '2026-11-02T05:00:00Z']) {
      const live = liveEvents([northAmericans], ms(t)).length;
      const up = upcomingEvents([northAmericans], ms(t)).length;
      expect(live + up).toBeLessThanOrEqual(1);
    }
  });

  it(`leaves out season series longer than ${LIVE_MAX_DAYS} days`, () => {
    const t = ms('2026-10-29T16:00:00Z');
    expect(liveEvents([winterSeries], t)).toEqual([]);
    const threeWeeks = ev('three-weeks', 'Three Weeks', '2026-10-20', '2026-11-09'); // 21 days
    const longer = ev('longer', 'Longer', '2026-10-20', '2026-11-10'); // 22 days
    expect(ids(liveEvents([threeWeeks, longer], t))).toEqual(['three-weeks']);
  });

  it('a one-day event is live that day, and says Today; a missing end is the first day', () => {
    const one = ev('one', 'One Day', '2026-10-29');
    const noEnd = { ...ev('no-end', 'No End', '2026-10-29'), endMs: NaN };
    const t = ms('2026-10-29T16:00:00Z');
    expect(ids(liveEvents([one, noEnd], t))).toEqual(['no-end', 'one']);
    expect(liveDayText(one, t)).toBe('Today');
    expect(liveEvents([one], ms('2026-10-30T16:00:00Z'))).toEqual([]);
  });

  it('most recently started first, title breaks a tie, at most LIVE_MAX', () => {
    const t = ms('2026-10-29T16:00:00Z');
    const list = Array.from({ length: LIVE_MAX + 2 }, (_, i) => ev(`e${i}`, `Event ${i}`, `2026-10-${20 + i}`, '2026-10-31'));
    const tieA = ev('tie-a', 'Alpha', '2026-10-29');
    const tieB = ev('tie-b', 'Bravo', '2026-10-29');
    const got = liveEvents([...list, tieB, tieA], t);
    expect(got).toHaveLength(LIVE_MAX);
    expect(ids(got).slice(0, 4)).toEqual(['tie-a', 'tie-b', 'e7', 'e6']);
  });
});

describe('the landing page’s Live now', () => {
  const t = ms('2026-10-29T16:00:00Z');

  it('cards: live dot with text, title link, class and venue, dates; escaped; no Notify me', () => {
    const html = liveCardsHtml([northAmericans, winterSeries, ev('x', '<b>Fish & Chips</b> "Cup"', '2026-10-29', '2026-10-29', { venue: 'O’Hare <Lake>' })], OFF, t);
    expect(html).toContain('<span class="land-live-dot" aria-hidden="true"></span>Live · Day 2 of 5');
    expect(html).toContain(`<a href="/?event=${NA}">2026 J/70 North Americans</a>`);
    expect(html).toContain('J/70 · Annapolis, MD');
    expect(html).toContain('Oct 28 – Nov 1');
    expect(html).toContain('&lt;b&gt;Fish &amp; Chips&lt;/b&gt; &quot;Cup&quot;');
    expect(html).toContain('O’Hare &lt;Lake&gt;');
    expect(html).not.toContain('<b>Fish');
    expect(html).not.toContain('Winter Series');
    expect(html).not.toContain('Notify me');
    expect(liveCardsHtml([winterSeries], OUT, t)).toBe('');
  });

  const fakeDoc = () => {
    const make = (id: string) => {
      const list = { innerHTML: '' };
      return { id, list, section: { hidden: true, querySelector: () => list, addEventListener: () => {} } };
    };
    const live = make('land-live');
    const up = make('land-upcoming');
    const doc = { getElementById: (id: string) => [live, up].find((x) => x.id === id)?.section ?? null } as unknown as Document;
    return { doc, live, up };
  };

  it('fills Live now and Upcoming from the one list; each hides when empty', async () => {
    const nextWeek = ev('next', 'Turkey Bowl', '2026-11-05');
    const a = fakeDoc();
    await showUpcoming(a.doc, { landing: async () => ({ events: [northAmericans, nextWeek, winterSeries] }), me: async () => OFF, now: () => t });
    expect(a.live.section.hidden).toBe(false);
    expect(a.live.list.innerHTML).toContain('2026 J/70 North Americans');
    expect(a.up.section.hidden).toBe(false);
    expect(a.up.list.innerHTML).toContain('Turkey Bowl');
    expect(a.up.list.innerHTML).not.toContain('North Americans');

    const b = fakeDoc();
    await showUpcoming(b.doc, { landing: async () => ({ events: [winterSeries] }), me: async () => OFF, now: () => t });
    expect(b.live.section.hidden).toBe(true);
    expect(b.up.section.hidden).toBe(true);

    const c = fakeDoc();
    await showUpcoming(c.doc, { landing: () => Promise.reject(new Error('offline')), me: async () => OFF, now: () => t });
    expect(c.live.section.hidden).toBe(true);
    expect(c.up.section.hidden).toBe(true);
  });
});
