import { describe, expect, it } from 'vitest';
import { allowed, coachCovers, isActive, passViews, passesUnlock, unlocks, type Entitlement } from '../functions/_entitlements';
import { FREE_POST_MS, FREE_PRE_MS, NEXT_GUN_GAP_MS, freeRaces, freeRacesOf, isFreeRace, telemetryIsFree } from '../src/data/freeRace';
import { currentDoc, PRE_START_FETCH_MS, telemetryWindow } from '../src/data/racesense/adapter';
import type { Race, RegattaDoc } from '../src/data/racesense/types';
import { EVENT, NOW, beneluxRegatta } from './paywallHelpers';

const DAY = 86_400_000;
const ent = (over: Partial<Entitlement>): Entitlement => ({
  id: 'e1',
  userId: 'u1',
  scope: 'regatta',
  eventId: EVENT,
  startsAt: NOW - DAY,
  expiresAt: null,
  seats: null,
  revokedAt: null,
  ...over,
});

describe('entitlements', () => {
  it('race 1 is always free, for anyone', () => {
    expect(allowed([], null, { eventId: EVENT, free: true, now: NOW })).toBe(true);
    expect(allowed([], null, { eventId: EVENT, free: false, now: NOW })).toBe(false);
    expect(allowed([], 'u1', { eventId: EVENT, free: false, now: NOW })).toBe(false);
  });

  it('a regatta pass opens its own event only, for its own buyer', () => {
    const e = [ent({})];
    expect(allowed(e, 'u1', { eventId: EVENT, free: false, now: NOW })).toBe(true);
    expect(allowed(e, 'u1', { eventId: 'otherEvent1234', free: false, now: NOW })).toBe(false);
    expect(allowed(e, 'u2', { eventId: EVENT, free: false, now: NOW })).toBe(false);
    expect(allowed(e, 'u1', { eventId: null, free: false, now: NOW })).toBe(false);
  });

  it('a season pass runs from starts_at to expires_at, every event', () => {
    const e = [ent({ scope: 'season', eventId: null, startsAt: NOW - DAY, expiresAt: NOW + DAY })];
    expect(allowed(e, 'u1', { eventId: 'anyEvent1234', free: false, now: NOW })).toBe(true);
    expect(allowed(e, 'u1', { eventId: null, free: false, now: NOW })).toBe(true);
    expect(allowed(e, 'u1', { eventId: EVENT, free: false, now: NOW + DAY })).toBe(false);
    expect(allowed(e, 'u1', { eventId: EVENT, free: false, now: NOW - 2 * DAY })).toBe(false);
    expect(isActive({ startsAt: NOW, expiresAt: NOW + 1, revokedAt: null }, NOW)).toBe(true);
    expect(isActive({ startsAt: NOW, expiresAt: NOW, revokedAt: null }, NOW)).toBe(false);
  });

  it('a revoked pass opens nothing', () => {
    expect(allowed([ent({ revokedAt: NOW - 1 })], 'u1', { eventId: EVENT, free: false, now: NOW })).toBe(false);
    expect(allowed([ent({ scope: 'season', eventId: null, expiresAt: NOW + DAY, revokedAt: NOW - 1 })], 'u1', { eventId: EVENT, free: false, now: NOW })).toBe(false);
  });

  it('a Coach plan covers its owner and the first `seats` members while it runs', () => {
    const plan = ent({ scope: 'coach', eventId: null, userId: 'owner', expiresAt: NOW + DAY, seats: 2, members: ['m1', 'm2', 'm3'] });
    expect(coachCovers(plan, 'owner')).toBe(true);
    expect(coachCovers(plan, 'm2')).toBe(true);
    expect(coachCovers(plan, 'm3')).toBe(false);
    expect(unlocks(plan, 'm1', EVENT, NOW)).toBe(true);
    expect(unlocks(plan, 'm3', EVENT, NOW)).toBe(false);
    expect(unlocks(plan, 'm1', EVENT, NOW + DAY)).toBe(false);
    expect(unlocks({ ...plan, seats: null }, 'm1', EVENT, NOW)).toBe(false);
  });

  it('lists active passes for /api/auth/me and the page decides from them alike', () => {
    const list = [
      ent({ id: 'a' }),
      ent({ id: 'b', scope: 'season', eventId: null, startsAt: NOW - 5 * DAY, expiresAt: NOW - DAY }),
      ent({ id: 'c', scope: 'coach', eventId: null, userId: 'owner', expiresAt: NOW + DAY, seats: 1, members: ['x', 'u1'] }),
    ];
    const views = passViews(list, 'u1', NOW);
    expect(views.map((v) => v.scope)).toEqual(['regatta']);
    expect(passesUnlock(views, EVENT, NOW)).toBe(true);
    expect(passesUnlock(views, 'otherEvent1234', NOW)).toBe(false);
    const season = passViews([ent({ scope: 'season', eventId: null, expiresAt: NOW + DAY })], 'u1', NOW);
    expect(passesUnlock(season, 'otherEvent1234', NOW)).toBe(true);
    expect(passesUnlock(season, 'otherEvent1234', NOW + DAY)).toBe(false);
  });
});

// ---- race 1 and its window

const LINE = { leftEnd: [5, 52] as [number, number], rightEnd: [5.001, 52] as [number, number] };
const T0 = Date.parse('2026-10-17T10:00:00Z');
const MIN = 60_000;

function race(n: number, gun: number, finishes: number[], practice = false): Race {
  return {
    raceNumber: n,
    isPractice: practice,
    starts: [{ startTime: gun, startLine: LINE, stopReason: finishes.length ? 'finished' : null }],
    finishes: finishes.map((t, i) => ({ sailNumber: `S${i}`, finishingTime: new Date(t).toISOString() })),
  };
}

const docOf = (divs: Record<string, Race[]>): RegattaDoc => ({
  name: 'Test Regatta',
  startDate: T0 - DAY,
  endDate: T0 + DAY,
  divisions: Object.entries(divs).map(([name, races]) => ({ name, courses: [], participants: [], races })),
});

describe('free race (race 1) and its telemetry window', () => {
  const doc = currentDoc(beneluxRegatta());
  const free = freeRaces(doc);
  const r1 = telemetryWindow(doc, { division: 'J70', raceNumber: 1 });
  const r2 = telemetryWindow(doc, { division: 'J70', raceNumber: 2 });
  const w = free.windows[0];

  it('is the earliest scored race of each division', () => {
    expect(free.divisions).toEqual(['J70']);
    expect(free.windows.map((x) => [x.division, x.raceNumber])).toEqual([['J70', 1]]);
    expect(isFreeRace(free, 'J70', 1)).toBe(true);
    expect(isFreeRace(free, 'J70', 2)).toBe(false);
    expect(isFreeRace(free, 'Other', 1)).toBe(false);
    // A rebuilt race (its gun minute as its number) is never race 1.
    expect(isFreeRace(free, 'J70', 202610170805)).toBe(false);
  });

  it("covers race 1's own window with margins that stop short of race 2", () => {
    expect(w.after).toBe(r1.after - FREE_PRE_MS);
    expect(w.before).toBe(r1.before + FREE_POST_MS);
    expect(w.before).toBeLessThan(r2.after);
  });

  it("frees race 1's pages (each starts inside, all share its end) and nothing that reaches past it", () => {
    expect(telemetryIsFree(free, 'J70', r1.after, r1.before)).toBe(true);
    expect(telemetryIsFree(free, 'J70', r1.after + 600_000 - 1, r1.before)).toBe(true);
    expect(telemetryIsFree(free, null, r1.after, r1.before)).toBe(true);
    // Race 2, a chunk of it, and a window spanning races 1 and 2.
    expect(telemetryIsFree(free, 'J70', r2.after, r2.before)).toBe(false);
    expect(telemetryIsFree(free, 'J70', r2.after + 60_000, r2.after + 120_000)).toBe(false);
    expect(telemetryIsFree(free, 'J70', r1.after, r2.before)).toBe(false);
    // Boundaries: the window's ends are in, a millisecond past is out.
    expect(telemetryIsFree(free, 'J70', w.after, w.before)).toBe(true);
    expect(telemetryIsFree(free, 'J70', w.after - 1, w.before)).toBe(false);
    expect(telemetryIsFree(free, 'J70', w.after, w.before + 1)).toBe(false);
    expect(telemetryIsFree(free, 'J70', r1.before, r1.before)).toBe(false);
    // An unknown division may carry every division: it must fit every division's window.
    expect(telemetryIsFree(free, 'Nope', r1.after, r1.before)).toBe(true);
    expect(telemetryIsFree(free, 'Nope', r2.after, r2.before)).toBe(false);
  });

  it('frees nothing for a document with no races (or none at all)', () => {
    const none = freeRacesOf({ eventId: 'x', revisions: [] });
    expect(none.windows).toEqual([]);
    expect(telemetryIsFree(none, null, r1.after, r1.before)).toBe(false);
  });

  it('keeps race 1 whole when it has no finishes (window to the next gun less a minute), never race 2', () => {
    const d = docOf({ A: [race(1, T0, []), race(2, T0 + 30 * MIN, [T0 + 75 * MIN])] });
    const f = freeRaces(d);
    const w1 = telemetryWindow(d, { division: 'A', raceNumber: 1 });
    const w2 = telemetryWindow(d, { division: 'A', raceNumber: 2 });
    expect(w1.before).toBe(T0 + 29 * MIN);
    expect(f.windows[0].before).toBe(T0 + 30 * MIN - NEXT_GUN_GAP_MS);
    expect(telemetryIsFree(f, 'A', w1.after, w1.before)).toBe(true);
    expect(telemetryIsFree(f, 'A', w2.after, w2.before)).toBe(false);
  });

  it('skips practice, and the pre-start margin never reaches back into it', () => {
    const d = docOf({ A: [race(1, T0 - 12 * MIN, [T0 - 8 * MIN], true), race(2, T0, [T0 + 40 * MIN]), race(3, T0 + 60 * MIN, [T0 + 100 * MIN])] });
    const f = freeRaces(d);
    expect(f.windows.map((x) => x.raceNumber)).toEqual([2]);
    const practice = telemetryWindow(d, { division: 'A', raceNumber: 1 });
    expect(f.windows[0].after).toBe(Math.max(T0 - PRE_START_FETCH_MS - FREE_PRE_MS, practice.before));
    expect(telemetryIsFree(f, 'A', practice.after, practice.before)).toBe(false);
  });

  it('with several divisions, frees an unfiltered window only inside every division’s race 1', () => {
    const d = docOf({
      A: [race(1, T0, [T0 + 40 * MIN]), race(2, T0 + 60 * MIN, [T0 + 100 * MIN])],
      B: [race(1, T0 + 10 * MIN, [T0 + 50 * MIN]), race(2, T0 + 70 * MIN, [T0 + 110 * MIN])],
    });
    const f = freeRaces(d);
    expect(f.windows.map((x) => `${x.division}${x.raceNumber}`)).toEqual(['A1', 'B1']);
    // A's mark top-up at its gun: inside A's window, but B's race 1 window hasn't begun (B's own
    // window opens 130 s + 5 min before its gun at +10 min).
    expect(telemetryIsFree(f, 'A', T0, T0 + MIN)).toBe(true);
    expect(telemetryIsFree(f, null, T0, T0 + MIN)).toBe(false);
    expect(telemetryIsFree(f, null, T0 + 15 * MIN, T0 + 16 * MIN)).toBe(true);
    // B's race 1 overlaps nothing of A's race 2, but A's race 2 is never free.
    expect(telemetryIsFree(f, 'A', T0 + 60 * MIN, T0 + 61 * MIN)).toBe(false);
    expect(telemetryIsFree(f, 'B', T0 + 45 * MIN, T0 + 50 * MIN)).toBe(true);
  });
});
