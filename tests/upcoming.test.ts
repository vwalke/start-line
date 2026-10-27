import { describe, expect, it, vi } from 'vitest';
import type { Me } from '../src/data/paywall';
import type { LandingEvent, RegattaDoc } from '../src/data/racesense/types';
import { UPCOMING_DAYS, dateRangeText, startsInText, upcomingEvents } from '../src/data/upcoming';
import { showUpcoming, upcomingCardsHtml } from '../src/landing/landing';
import { UNDERWAY_TEXT, eventCardHtml, eventCardView } from '../src/ui/eventCard';
import { pickerOptions } from '../src/ui/eventSearch';
import { createAlerts, eventPath, handleNotify, notifyButtonHtml, notifyHref, withNotify } from '../src/ui/notify';

const DAY = 86_400_000;
const ms = (iso: string): number => Date.parse(iso);
const NOW = ms('2026-10-27T15:00:00Z');
const NA = 'Qn47enc7fKR7Th1Qj1ZI';

const ev = (eventId: string, title: string, start: string, end = start, extra: Partial<LandingEvent> = {}): LandingEvent => ({
  eventId,
  title,
  startMs: ms(start),
  endMs: ms(end),
  ...extra,
});

const northAmericans = ev(NA, '2026 J/70 North Americans', '2026-10-28T00:00:00Z', '2026-11-01T00:00:00Z', { classLabel: 'J/70', venue: 'Annapolis, MD' });
const running = ev('running-1', 'Fall Series', '2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z');
const later = ev('later-1', 'Turkey Bowl', '2026-11-05T00:00:00Z');
const farOff = ev('far-1', 'Midwinters', '2027-02-10T00:00:00Z');

const OFF: Me = { paywall: false };
const OUT: Me = { paywall: true, user: null, entitlements: [], signIn: { email: true, google: true } };
const IN: Me = { paywall: true, user: { email: 'sailor@example.com' }, entitlements: [], signIn: { email: true, google: true } };

describe('upcomingEvents', () => {
  it('keeps events starting within the window, soonest first', () => {
    expect(upcomingEvents([later, farOff, running, northAmericans], NOW).map((e) => e.eventId)).toEqual([NA, 'later-1']);
  });

  it('has exclusive-now and inclusive-end edges', () => {
    const at = (t: number, id: string): LandingEvent => ({ eventId: id, title: id, startMs: t, endMs: t });
    const list = [at(NOW, 'now'), at(NOW + 1, 'next'), at(NOW + UPCOMING_DAYS * DAY, 'edge'), at(NOW + UPCOMING_DAYS * DAY + 1, 'past-edge')];
    expect(upcomingEvents(list, NOW).map((e) => e.eventId)).toEqual(['next', 'edge']);
  });

  it('breaks a tie on the title, and leaves the input alone', () => {
    const b = ev('b', 'Bravo', '2026-10-29T00:00:00Z');
    const a = ev('a', 'Alpha', '2026-10-29T00:00:00Z');
    const input = [b, a];
    expect(upcomingEvents(input, NOW).map((e) => e.title)).toEqual(['Alpha', 'Bravo']);
    expect(input).toEqual([b, a]);
  });
});

describe('startsInText and dateRangeText', () => {
  it('counts calendar days from the viewer’s today', () => {
    expect(startsInText(ms('2026-10-27T20:00:00Z'), NOW, 0)).toBe('Starts today');
    expect(startsInText(ms('2026-10-28T00:00:00Z'), NOW, 0)).toBe('Starts tomorrow');
    expect(startsInText(ms('2026-10-29T00:00:00Z'), NOW, 0)).toBe('Starts in 2 days');
    expect(startsInText(ms('2026-11-09T00:00:00Z'), NOW, 0)).toBe('Starts in 13 days');
  });

  it('uses the viewer’s day: late evening in the US is already "tomorrow" for a UTC-midnight start the next day', () => {
    // 2026-10-28T03:00Z is 11 pm on Oct 27 in New York (UTC−4, offset +240 minutes).
    expect(startsInText(ms('2026-10-29T00:00:00Z'), ms('2026-10-28T03:00:00Z'), 240)).toBe('Starts in 2 days');
    expect(startsInText(ms('2026-10-29T00:00:00Z'), ms('2026-10-28T03:00:00Z'), 0)).toBe('Starts tomorrow');
  });

  it('formats ranges across months, within a month, and one day', () => {
    expect(dateRangeText(northAmericans.startMs, northAmericans.endMs)).toBe('Oct 28 – Nov 1');
    expect(dateRangeText(ms('2026-10-28T00:00:00Z'), ms('2026-10-30T00:00:00Z'))).toBe('Oct 28 – 30');
    expect(dateRangeText(ms('2026-10-28T00:00:00Z'), ms('2026-10-28T00:00:00Z'))).toBe('Oct 28');
    expect(dateRangeText(0, 0)).toBe('');
  });
});

describe('the picker’s Upcoming group', () => {
  const started = [running];
  const upcoming = upcomingEvents([northAmericans, later, farOff], NOW);

  it('lists upcoming events in their own group, with dates and when they start', () => {
    const r = pickerOptions(started, '', '', (id) => id === NA, { events: upcoming, now: NOW, tzOffsetMin: 0 });
    expect(r.options.map((o) => o.eventId)).toEqual(['running-1']);
    expect(r.upcoming).toEqual([
      { eventId: NA, label: '2026 J/70 North Americans — Oct 28 – Nov 1 · Starts tomorrow · Free' },
      { eventId: 'later-1', label: 'Turkey Bowl — Nov 5 · Starts in 9 days' },
    ]);
    expect(r.matches.map((e) => e.eventId)).toEqual(['running-1', NA, 'later-1']);
  });

  it('filters both groups with the search, and keeps an upcoming current event when it doesn’t match', () => {
    const r = pickerOptions(started, 'turkey', NA, undefined, { events: upcoming, now: NOW, tzOffsetMin: 0 });
    expect(r.upcoming.map((o) => o.eventId)).toEqual(['later-1']);
    expect(r.options).toEqual([{ eventId: NA, label: '2026 J/70 North Americans — Oct 28 – Nov 1 · Starts tomorrow (current)' }]);
    expect(r.matches.map((e) => e.eventId)).toEqual(['later-1']);
  });

  it('is unchanged without upcoming events', () => {
    const r = pickerOptions(started, '', '');
    expect(r.upcoming).toEqual([]);
    expect(r.options.map((o) => o.eventId)).toEqual(['running-1']);
  });
});

describe('the event card (no races yet)', () => {
  const doc = (o: Partial<RegattaDoc> = {}): RegattaDoc => ({
    name: '2026 J/70 North Americans',
    startDate: ms('2026-10-28T00:00:00Z'),
    endDate: ms('2026-11-01T00:00:00Z'),
    divisions: [
      {
        name: 'J70',
        boatClass: 'J/70',
        courses: [],
        participants: [
          { sailNumber: 'USA 833', boatName: 'Secret Boat Name' },
          { sailNumber: 'USA 1' },
          { sailNumber: 'USA 1' },
        ],
        races: [],
      },
    ],
    ...o,
  });

  it('before the start: dates, venue, class, entries and when racing starts', () => {
    const v = eventCardView(NA, doc(), northAmericans, NOW);
    expect(v).toEqual({
      eventId: NA,
      title: '2026 J/70 North Americans',
      dates: 'Oct 28 – Nov 1',
      venue: 'Annapolis, MD',
      classLabel: 'J/70',
      entries: 2,
      when: 'Racing starts Wed, Oct 28.',
    });
    const html = eventCardHtml(v, { me: OFF, free: false });
    expect(html).toContain('J/70 · Oct 28 – Nov 1 · Annapolis, MD');
    expect(html).toContain('2 boats entered');
    expect(html).toContain('Racing starts Wed, Oct 28.');
    expect(html).not.toContain('Secret Boat Name');
  });

  it('uses the first scheduled start at the venue when the document has one', () => {
    const d = doc();
    // 02:30 UTC on Oct 30 is 10:30 pm on Oct 29 at the venue (UTC−4).
    d.divisions[0].races = [{ raceNumber: 1, timezoneOffset: -4 * 3_600_000, starts: [{ startTime: ms('2026-10-30T02:30:00Z') }, { startTime: null }], finishes: [] }];
    expect(eventCardView(NA, d, northAmericans, NOW).when).toBe('Racing starts Thu, Oct 29.');
  });

  it('underway: says races show up as they’re posted', () => {
    const v = eventCardView(NA, doc(), northAmericans, ms('2026-10-28T18:00:00Z'));
    expect(v.when).toBe(UNDERWAY_TEXT);
    expect(UNDERWAY_TEXT).toBe("Racing is underway. Races will show up here as they're posted.");
  });

  it('falls back to the landing entry, and never uses gap or no-data wording', () => {
    const v = eventCardView(NA, null, northAmericans, NOW);
    expect(v.title).toBe('2026 J/70 North Americans');
    expect(v.entries).toBe(0);
    const html = eventCardHtml(v, { me: OFF, free: false });
    expect(html).not.toContain('entered');
    for (const w of [/no finished/i, /no data/i, /\bgap\b/i, /missing/i]) expect(html).not.toMatch(w);
  });

  it('shows Free and Notify me with the paywall on, neither with it off', () => {
    const v = eventCardView(NA, doc(), northAmericans, NOW);
    const on = eventCardHtml(v, { me: OUT, free: true });
    expect(on).toContain('<span class="free-tag">Free</span>');
    expect(on).toContain(`data-notify="${NA}"`);
    expect(on).toContain('aria-describedby="event-card-title"');
    expect(on).toContain('>Notify me</button>');
    const off = eventCardHtml(v, { me: OFF, free: false });
    expect(off).not.toContain('free-tag');
    expect(off).not.toContain('Notify me');
  });
});

describe('Notify me', () => {
  it('is hidden with the paywall off', () => {
    expect(notifyButtonHtml(NA, OFF)).toBe('');
    expect(notifyButtonHtml(NA, OUT)).toContain('Notify me');
    expect(notifyButtonHtml('bad id"><x', OUT)).toBe('');
  });

  it('shows the state: Notify me, or Emails on ✓ (which turns them off), and why a change failed', () => {
    expect(notifyButtonHtml(NA, IN, undefined, { on: false })).toContain('>Notify me</button>');
    const on = notifyButtonHtml(NA, IN, undefined, { on: true });
    expect(on).toContain('>Emails on ✓</button>');
    expect(on).toContain('aria-label="Emails on: turn off race emails"');
    expect(notifyButtonHtml(NA, OUT, undefined, { on: true })).toContain('>Notify me</button>');
    expect(notifyButtonHtml(NA, IN, undefined, { on: false, busy: true })).toContain(' disabled>');
    expect(notifyButtonHtml(NA, IN, undefined, { on: false, note: 'Too <many>' })).toContain('<span class="notify-note" role="status">Too &lt;many&gt;</span>');
    expect(notifyButtonHtml(NA, IN, undefined, { on: false }, { quiet: true })).toContain('class="linkish notify-btn notify-quiet"');
  });

  it('signed out: opens sign-in for that event, and nothing else', () => {
    const signIn = vi.fn();
    const alerts = { state: () => ({ on: false }), set: vi.fn(async () => true) };
    expect(handleNotify(NA, OUT, { signIn, alerts })).toBe('signin');
    expect(signIn).toHaveBeenCalledWith(NA);
    expect(alerts.set).not.toHaveBeenCalled();
  });

  it('signed in: turns the emails on, or off when on; `ensure` only ever turns them on; paywall off: nothing', () => {
    const signIn = vi.fn();
    let on = false;
    const alerts = { state: () => ({ on }), set: vi.fn(async () => true) };
    expect(handleNotify(NA, IN, { signIn, alerts })).toBe('notify');
    expect(alerts.set).toHaveBeenLastCalledWith(NA, true);
    on = true;
    handleNotify(NA, IN, { signIn, alerts });
    expect(alerts.set).toHaveBeenLastCalledWith(NA, false);
    handleNotify(NA, IN, { signIn, alerts, ensure: true });
    expect(alerts.set).toHaveBeenCalledTimes(2);
    expect(handleNotify(NA, OFF, { signIn, alerts })).toBe('hidden');
    expect(signIn).not.toHaveBeenCalled();
    expect(alerts.set).toHaveBeenCalledTimes(2);
  });

  it('links: the event, the landing page’s carry-on, and a sign-in’s way back', () => {
    expect(eventPath(NA)).toBe(`/?event=${NA}`);
    expect(notifyHref(NA)).toBe(`/?event=${NA}&notify=1`);
    expect(withNotify(`/?event=${NA}&div=J70&race=3#race`)).toBe(`/?event=${NA}&div=J70&race=3&notify=1#race`);
  });

  it('the store: loads the list signed in, turns emails on and off, and keeps a failure’s message', async () => {
    const calls: { method: string; body?: string }[] = [];
    let list: unknown[] = [];
    const f = vi.fn(async (_u: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', body: init.body as string | undefined });
      if (init.method === 'POST') {
        const id = (JSON.parse(String(init.body)) as { eventId: string }).eventId;
        if (id === 'full-event') return new Response(JSON.stringify({ error: 'too_many', message: 'Race emails are on for 50 regattas already.' }), { status: 409 });
        list = [{ eventId: id, title: '2026 J/70 North Americans', startMs: 1, endMs: 2, createdAt: 3 }];
      }
      if (init.method === 'DELETE') list = [];
      return new Response(JSON.stringify({ ok: true, alerts: list }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = createAlerts(f);
    const seen = vi.fn();
    a.onChange(seen);
    await a.load(OUT);
    expect(f).not.toHaveBeenCalled();
    expect(a.list()).toEqual([]);
    await a.load(IN);
    expect(calls.at(-1)?.method).toBe('GET');
    expect(await a.set(NA, true)).toBe(true);
    expect(a.state(NA)).toEqual({ on: true, busy: false, note: undefined });
    expect(await a.set(NA, false)).toBe(true);
    expect(a.state(NA).on).toBe(false);
    expect(await a.set('full-event', true)).toBe(false);
    expect(a.state('full-event')).toEqual({ on: false, busy: false, note: 'Race emails are on for 50 regattas already.' });
    expect(seen).toHaveBeenCalled();
  });
});

describe('the landing page’s Upcoming regattas', () => {
  it('cards: title link, class and venue, dates, starts-in, Free and Notify me', () => {
    const html = upcomingCardsHtml([farOff, later, running, northAmericans], OUT, NOW, 0);
    expect(html.indexOf('2026 J/70 North Americans')).toBeLessThan(html.indexOf('Turkey Bowl'));
    expect(html).not.toContain('Fall Series');
    expect(html).not.toContain('Midwinters');
    expect(html).toContain(`<a href="/?event=${NA}">2026 J/70 North Americans</a> <span class="free-tag">Free</span>`);
    expect(html).toContain('J/70 · Annapolis, MD');
    expect(html).toContain('Oct 28 – Nov 1 · <strong>Starts tomorrow</strong>');
    expect(html).toContain(`aria-describedby="up-${NA}"`);
  });

  it('paywall off: no Free badge and no Notify me', () => {
    const html = upcomingCardsHtml([northAmericans], OFF, NOW, 0);
    expect(html).not.toContain('free-tag');
    expect(html).not.toContain('Notify me');
  });

  const fakeDoc = () => {
    const list = { innerHTML: '' };
    let click: ((ev: unknown) => void) | null = null;
    const section = { hidden: true, querySelector: () => list, addEventListener: (_: string, fn: (ev: unknown) => void) => (click = fn) };
    const doc = { getElementById: (id: string) => (id === 'land-upcoming' ? section : null) } as unknown as Document;
    return { doc, section, list, click: (id: string) => click?.({ target: { closest: () => ({ dataset: { notify: id } }) } }) };
  };

  it('stays hidden with nothing upcoming, or when the list fails to load', async () => {
    const a = fakeDoc();
    await showUpcoming(a.doc, { landing: async () => ({ events: [running, farOff] }), me: async () => OUT, now: () => NOW });
    expect(a.section.hidden).toBe(true);
    const b = fakeDoc();
    await showUpcoming(b.doc, { landing: () => Promise.reject(new Error('offline')), me: async () => OUT, now: () => NOW });
    expect(b.section.hidden).toBe(true);
  });

  it('signed out: Notify me goes to the event, where the app opens sign-in', async () => {
    const f = fakeDoc();
    const go = vi.fn();
    await showUpcoming(f.doc, { landing: async () => ({ events: [northAmericans] }), me: async () => OUT, now: () => NOW, go });
    expect(f.section.hidden).toBe(false);
    expect(f.list.innerHTML).toContain('Notify me');
    f.click(NA);
    expect(go).toHaveBeenCalledWith(`/?event=${NA}&notify=1`);
  });
});
