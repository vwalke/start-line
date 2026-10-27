import { describe, expect, it } from 'vitest';
import { buildYsQuery, latestDate, parseRoute, stripPersonal, ysTtl } from '../functions/_lib';
import { awayFromStart, crossings, officialTimesPlausible, trackerFinish, type Fix } from '../src/data/finishes';
import { linkOfficial } from '../src/data/official/link';
import { alignRaces, inferOffset, nameScore, pickClass, type ClassScore } from '../src/data/official/match';
import { matchBoats, sailDigits, sailFullKey, sailKey } from '../src/data/official/sail';
import { parseYsEventId, type YsSource } from '../src/data/official/yachtscoring';
import { parsePickerParams } from '../src/ui/params';
import { parseLastView, resolveStart, serializeLastView, type LastView } from '../src/ui/lastView';
import { raceHead, raceHeadHtml, raceOptionText } from '../src/ui/races';
import type { ListedRace } from '../src/data/raceList';

const H = 3_600_000;
const M = 60_000;

describe('Yachtscoring proxy route', () => {
  it('allows exactly the endpoints Recall reads, numeric ids, known params', () => {
    expect(parseRoute('ys/event')).toEqual({ kind: 'ys', resource: 'search', path: 'event' });
    expect(parseRoute('ys/event/50575')).toMatchObject({ kind: 'ys', resource: 'event' });
    expect(parseRoute('ys/event/50575/races')).toMatchObject({ resource: 'races' });
    expect(parseRoute('ys/event/50575/splits')).toMatchObject({ resource: 'splits' });
    expect(parseRoute('ys/event/50575/result-detail-report')).toMatchObject({ resource: 'results' });
    expect(parseRoute('ys/event/50575/cumulative-result')).toMatchObject({ resource: 'cumulative' });
    expect(parseRoute('ys/event/50575/boats')).toMatchObject({ resource: 'boats' });
    for (const bad of ['ys/event/abc', 'ys/event/0', 'ys/event/50575/owners', 'ys/event/50575/races/1', 'ys/user', 'ys/event/../x']) {
      expect(parseRoute(bad).kind, bad).toBe('error');
    }
  });

  it('drops unknown params and validates the rest', () => {
    const s = buildYsQuery('search', new URLSearchParams('startDate_gte=2026-10-07&startDate_lte=2026-10-19&sort=startDate.desc&size=100&token=x'));
    expect(s.ok && [...s.qs.keys()]).toEqual(['startDate_gte', 'startDate_lte', 'sort', 'size']);
    expect(buildYsQuery('search', new URLSearchParams('size=10')).ok).toBe(false);
    expect(buildYsQuery('search', new URLSearchParams('startDate_gte=2026-01-01&startDate_lte=2026-12-31')).ok).toBe(false);
    expect(buildYsQuery('search', new URLSearchParams('name_contains=<script>')).ok).toBe(false);
    expect(buildYsQuery('search', new URLSearchParams('name_contains=J/105&size=1000')).ok).toBe(false);
    expect(buildYsQuery('results', new URLSearchParams('')).ok).toBe(false);
    const r = buildYsQuery('results', new URLSearchParams('raceNumber=3&x=1'));
    expect(r.ok && r.qs.toString()).toBe('raceNumber=3');
    const e = buildYsQuery('event', new URLSearchParams('include=owners'));
    expect(e.ok && e.qs.toString()).toBe('');
  });

  it('strips owner and crew fields at any depth, keeping boats, sails and places', () => {
    const body = {
      data: [{ circleName: 'J/105 CBC', divisions: [{ classes: [{ boats: [{ sailNumber: '96', name: 'Good Trade', ownerName: 'X', crewList: ['Y'], skipperEmail: 'z@z', placeClass: 2, yachtClub: 'AYC' }] }] }] }],
      hostClub: { name: 'Annapolis Yacht Club' },
    };
    const out = JSON.stringify(stripPersonal(body));
    expect(out).toContain('Good Trade');
    expect(out).toContain('"placeClass":2');
    expect(out).toContain('Annapolis Yacht Club');
    expect(out).not.toMatch(/owner|crew|skipper|yachtClub/i);
  });

  it('caches searches 1 h, quiet (finished) events 7 days, current ones 5 min', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(ysTtl('search', {}, now)).toBe(3600);
    expect(ysTtl('event', { endDate: '2026-10-11T23:59:59.999Z' }, now)).toBe(7 * 86_400);
    expect(ysTtl('races', { rows: [{ startTime: '2026-10-19T11:05:00.000Z' }] }, now)).toBe(300);
    expect(ysTtl('results', { data: [] }, now)).toBe(300);
    expect(latestDate({ a: { finishTime: '2026-10-03T12:00:00Z' }, b: [{ updatedAt: '2026-10-04T00:00:00Z' }] })).toBe(Date.parse('2026-10-04T00:00:00Z'));
  });
});

describe('sail numbers', () => {
  it('normalises the Yachtscoring and RaceSense forms', () => {
    expect(sailKey(null, 'USA 322')).toBe('322');
    expect(sailKey('', ' USA 313')).toBe('313');
    expect(sailKey('Uni', '29')).toBe('29');
    expect(sailKey('None', '407')).toBe('407');
    expect(sailKey('US', '351')).toBe('351');
    expect(sailKey('USA', '0005')).toBe('5');
    expect(sailKey(null, '251-L')).toBe('251L');
    expect(sailDigits(sailKey(null, '251-L'))).toBe('251');
    expect(sailKey('BRA641')).toBe('641');
    expect(sailFullKey('US', '351')).toBe('USA351');
    expect(sailFullKey('Uni', '29')).toBe('');
  });

  it('pairs in tiers and reports what is left on both sides', () => {
    const rs = ['USA 5', 'USA 251', 'USA 351', '29', 'ITA 1474', 'USA 1474', 'USA 999'].map((sail) => ({ sail }));
    const ys = [
      { prefix: 'USA', sail: '0005' },
      { prefix: null, sail: '251-L' },
      { prefix: 'US', sail: '351' },
      { prefix: 'Uni', sail: '29' },
      { prefix: 'ITA', sail: '1474' },
      { prefix: 'USA', sail: '1474' },
      { prefix: '', sail: '42', name: 'Nobody' },
    ];
    const m = matchBoats(rs, ys, (x) => x, (x) => x);
    const pairs = Object.fromEntries(m.pairs.map((p) => [p.a.sail, `${p.b.prefix ?? ''} ${p.b.sail}`.trim()]));
    expect(pairs).toEqual({ 'USA 5': 'USA 0005', 'USA 251': '251-L', 'USA 351': 'US 351', '29': 'Uni 29', 'ITA 1474': 'ITA 1474', 'USA 1474': 'USA 1474' });
    expect(m.pairs.find((p) => p.a.sail === 'USA 251')!.tier).toBe('digits');
    expect(m.onlyA.map((a) => a.sail)).toEqual(['USA 999']);
    expect(m.onlyB.map((b) => b.sail)).toEqual(['42']);
    // Name as the last resort.
    const byName = matchBoats([{ sail: 'X1', name: "Smoke 'n Oakum" }], [{ sail: 'Y9', name: 'SMOKE N OAKUM' }], (x) => x, (x) => x);
    expect(byName.pairs[0].tier).toBe('name');
  });
});

describe('time zone and race alignment', () => {
  it('infers EDT from guns although localGMTOffset says -5', () => {
    const wall = ['2026-10-18T11:05:00Z', '2026-10-18T12:25:00Z', '2026-10-18T14:10:00Z'].map(Date.parse);
    const guns = ['2026-10-18T15:05:01Z', '2026-10-18T16:25:01Z', '2026-10-18T18:10:01Z'].map(Date.parse);
    expect(inferOffset(wall, guns, -4 * H, -5 * H)).toEqual({ offsetMs: -4 * H, matched: 3 });
    // Nothing lines up: the prior wins.
    expect(inferOffset(wall, [Date.parse('2026-10-18T01:00:00Z')], -4 * H, -5 * H).offsetMs).toBe(-4 * H);
  });

  it('matches by gun, not number, then left-overs in order', () => {
    const t = (hhmm: string): number => Date.parse(`2026-10-03T${hhmm}:00Z`);
    // AYC J70: RaceSense 1–2 are official 2–3; official 1 has no RaceSense race.
    const al = alignRaces(
      [
        { raceNumber: 1, gunMs: t('16:55') + 1000 },
        { raceNumber: 2, gunMs: t('18:10') + 1000 },
      ],
      [
        { number: 1, gunMs: t('15:15') },
        { number: 2, gunMs: t('16:55') },
        { number: 3, gunMs: t('18:10') },
      ],
    );
    expect(al.map((a) => [a.rsRace, a.official, a.by])).toEqual([
      [1, 2, 'gun'],
      [2, 3, 'gun'],
    ]);
    // J/105 W1 12:50 is not J/70's 12:55 (5 min > tolerance).
    expect(alignRaces([{ raceNumber: 1, gunMs: t('12:55') }], [{ number: 2, gunMs: t('12:50') }]).filter((a) => a.by === 'gun')).toEqual([]);
    // A postponed race Yachtscoring kept at its scheduled time pairs in order between gun-matched ones.
    const order = alignRaces(
      [
        { raceNumber: 1, gunMs: t('11:05') },
        { raceNumber: 2, gunMs: t('12:40') },
        { raceNumber: 3, gunMs: t('14:05') },
      ],
      [
        { number: 1, gunMs: t('11:05') },
        { number: 2, gunMs: t('12:15') },
        { number: 3, gunMs: t('14:05') },
      ],
    );
    expect(order.find((a) => a.rsRace === 2)).toMatchObject({ official: 2, by: 'order' });
  });

  it('scores names with acronyms and picks a class only with a margin', () => {
    expect(nameScore('2026 J105 CBC', '2026 J/105 Chesapeake Bay Championship')).toBe(1);
    expect(nameScore('2026 AYC FALL SERIES', '2026 AYC Fall Series')).toBe(1);
    expect(nameScore('Cascais J/70 World Championship', '2026 The Bitter Ender')).toBe(0);
    const s = (total: number, sails: number | null = 1): ClassScore => ({ cls: { key: String(total), splitId: null, circle: '', className: '', races: [] }, guns: 1, sails, name: true, total });
    expect(pickClass([s(0.95), s(0.5)])?.total).toBe(0.95);
    expect(pickClass([s(0.95), s(0.9)])).toBeNull();
    expect(pickClass([s(0.7, 0.4)])).toBeNull();
    expect(pickClass([s(0.4)], true)?.total).toBe(0.4);
  });
});

describe('finishes from the tracks and plausible official times', () => {
  // A line along x (lat 0), boats sailing north across it.
  const line = { left: { lat: 0, lon: 0 }, right: { lat: 0, lon: 0.001 } };
  const lineAt = (): typeof line => line;
  const fix = (ts: number, lat: number, stage: string | null = null, rn = 5): Fix => ({ ts, lat, lon: 0.0005, stage, rn });

  it('finds crossings by interpolation and takes the first after the finishing onset', () => {
    const gun = 0;
    const fixes = [fix(9 * M, -0.001, 'in_progress'), fix(10 * M, 0.001, 'in_progress'), fix(39 * M, -0.002, 'in_progress'), fix(40 * M, -0.0005, 'finishing'), fix(41 * M, 0.0005, 'finishing'), fix(42 * M, -0.0005, 'finished')];
    const xs = crossings(fixes, lineAt, gun, 60 * M);
    expect(xs.length).toBe(3);
    expect(xs[1]).toBeCloseTo(40.5 * M, -2);
    expect(trackerFinish(fixes, lineAt, gun, 60 * M, 5)).toBeCloseTo(40.5 * M, -2);
    // Never invented: a track that doesn't cross gets none.
    expect(trackerFinish([fix(1 * M, -0.01, 'in_progress'), fix(50 * M, -0.002, 'finishing')], lineAt, gun, 60 * M, 5)).toBeNull();
  });

  it('marks a tracker that never came near the start and never finished as not in the race', () => {
    const mid = { lat: 0, lon: 0.0005 };
    const far = [fix(-60_000, 0.045), fix(0, 0.045), fix(5 * M, 0.044)];
    expect(awayFromStart(far, mid, 0, false)).toBe('Not near the start (closest 4.9 km) and no finish');
    expect(awayFromStart(far, mid, 0, true)).toBeNull();
    expect(awayFromStart([fix(-60_000, 0.045), fix(2 * M, 0.001)], mid, 0, false)).toBeNull();
    // No fix around the gun: unknown, never excluded.
    expect(awayFromStart([fix(30 * M, 0.045)], mid, 0, false)).toBeNull();
  });

  it('accepts official times within a minute of the tracks, inside the race; rejects placeholders', () => {
    const pairs = [0, 1, 2, 3].map((k) => ({ officialMs: (60 + k) * M, crossings: [(60 + k) * M + 20_000] }));
    expect(officialTimesPlausible(pairs, 0, 120 * M, pairs.map((p) => p.officialMs))).toMatchObject({ ok: true, n: 4, medianS: 20 });
    const off = pairs.map((p) => ({ ...p, crossings: [p.officialMs + 8 * M] }));
    expect(officialTimesPlausible(off, 0, 120 * M, off.map((p) => p.officialMs)).ok).toBe(false);
    // A "finish" after the next gun (J/105 CBC R1: 12:26 local after the 12:25 gun).
    expect(officialTimesPlausible(pairs, 0, 61 * M, pairs.map((p) => p.officialMs))).toMatchObject({ ok: false });
    expect(officialTimesPlausible(pairs.slice(0, 2), 0, 120 * M, [60 * M, 61 * M]).why).toMatch(/too few/);
  });
});

describe('links, overrides and fallback', () => {
  it('reads a pasted Yachtscoring link or number', () => {
    expect(parseYsEventId('https://www.yachtscoring.com/emenu/50575')).toBe(50575);
    expect(parseYsEventId('yachtscoring.com/emenu/50574/results')).toBe(50574);
    expect(parseYsEventId(' 50575 ')).toBe(50575);
    expect(parseYsEventId('https://example.com/50575')).toBeNull();
    expect(parseYsEventId('')).toBeNull();
  });

  it('keeps ys / ysc in the URL params and the saved view; old race= links unchanged', () => {
    expect(parsePickerParams('?event=E&div=J105&race=3&ys=50575&ysc=2004419')).toEqual({ eventId: 'E', want: { division: 'J105', raceNumber: 3 }, ys: 50575, ysc: '2004419' });
    expect(parsePickerParams('?event=E&ys=0&ysc=x')).toEqual({ eventId: 'E', ys: 0 });
    expect(parsePickerParams('?event=E&ys=abc')).toEqual({ eventId: 'E' });
    expect(parsePickerParams('?event=E&div=Open&race=202609111355').want).toEqual({ division: 'Open', raceNumber: 202609111355 });
    const rec: LastView = { v: 1, eventId: 'sxuoKnv1CVM8Swq8L3gZ', division: 'J70', raceNumber: 202610031515, leg: null, boat: null, sort: null, ys: 50574, ysc: 'FS Weekend 1 - Bay Course|J/70', savedAt: 1 };
    const back = parseLastView(serializeLastView(rec));
    expect(back).toEqual(rec);
    expect(resolveStart('', back).params).toMatchObject({ eventId: rec.eventId, want: { division: 'J70', raceNumber: 202610031515 }, ys: 50574 });
    // A record from before this change still parses.
    expect(parseLastView(JSON.stringify({ v: 1, eventId: 'abcde', division: 'J70', raceNumber: 8, leg: null, boat: null, sort: null, savedAt: 1 }))).not.toBeNull();
  });

  it('turns a Yachtscoring failure into an outcome (RaceSense numbering, a ⚠ chip), never a throw', async () => {
    const down: YsSource = {
      searchDates: () => Promise.reject(new Error('502 Bad Gateway for /api/ys/event')),
      searchName: () => Promise.reject(new Error('502')),
      event: () => Promise.reject(new Error('502')),
      races: () => Promise.reject(new Error('502')),
      results: () => Promise.reject(new Error('502')),
    };
    const out = await linkOfficial(down, { meta: { name: 'X', startMs: 0, endMs: 1 }, tzPriorMs: null, divisions: [] });
    expect(out).toEqual({ status: 'error', message: '502 Bad Gateway for /api/ys/event' });
    const race: ListedRace = { division: 'J105', raceNumber: 2, gunMs: Date.parse('2026-10-18T16:25:01Z'), finishers: 16, finished: true, lastFinishMs: null, rsNumber: 2, practice: false, number: 2, numbering: 'racesense', officialNumber: null, finishes: 'racesense' };
    const k = raceHead({ race, official: { status: 'done', outcome: out }, feed: { status: 'idle', used: 0, max: 0, found: 0, exhausted: false } });
    expect(k.chips).toEqual([{ text: 'official results unavailable', warn: true, title: '502 Bad Gateway for /api/ys/event' }]);
    expect(raceOptionText(race, false)).toBe('Race 2 · Sun 12:25');
    const html = raceHeadHtml(k);
    expect(html).toContain('<details class="info">');
    expect(html).toContain('data-ys-form');
  });

  it('shows official-places-only as a plain chip, and the feed check as a progress chip', () => {
    const race: ListedRace = { division: 'J105', raceNumber: 1, gunMs: Date.parse('2026-10-18T15:05:01Z'), finishers: 16, finished: true, lastFinishMs: null, rsNumber: 1, practice: false, number: 1, numbering: 'official', officialNumber: 1, finishes: 'official' };
    const places = raceHead({
      race,
      official: { status: 'done', outcome: { status: 'error', message: 'x' } },
      feed: { status: 'idle', used: 0, max: 0, found: 0, exhausted: false },
      results: { places: 'official', times: 'racesense', trackerFinishes: 0, timesNote: 'placeholders' },
    });
    expect(places.chips.find((c) => c.text.startsWith('official places ·'))).toEqual({ text: 'official places · RaceSense times' });
    const feed = raceHead({ race, official: { status: 'pending' }, feed: { status: 'running', used: 12, max: 48, found: 0, exhausted: false } });
    expect(feed.chips.some((c) => c.text === 'checking for more races 12/48' && !c.warn)).toBe(true);
  });
});
