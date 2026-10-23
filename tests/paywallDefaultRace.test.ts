import { describe, expect, it } from 'vitest';
import { defaultRaceFor, startRace } from '../src/ui/paywall';
import { pickRace } from '../src/ui/lastView';
import { freeRacesOf, type FreeRaces } from '../src/data/freeRace';
import { buildRaceList } from '../src/data/raceList';
import { currentDoc, defaultRace } from '../src/data/racesense/adapter';
import { PAYWALL_OFF, type Me } from '../src/data/paywall';
import type { PassView } from '../functions/_entitlements';
import { EVENT, NOW, beneluxRegatta } from './paywallHelpers';

const regatta = beneluxRegatta();
const doc = currentDoc(regatta);
const races = buildRaceList(doc).races;
const last = defaultRace(doc);
const free = freeRacesOf(regatta);
const on = (entitlements: PassView[] = [], user: { email: string } | null = null): Me => ({ paywall: true, user, entitlements, signIn: { email: true, google: false } });
const pass = (p: Partial<PassView>): PassView => ({ scope: 'regatta', eventId: EVENT, startsAt: NOW - 1000, expiresAt: null, seats: null, owner: true, ...p });
const opts = (me: Me, f: FreeRaces = free) => ({ me, free: () => f, eventId: EVENT, now: NOW });
const key = (r: { division: string; raceNumber: number } | null) => (r ? `${r.division}|${r.raceNumber}` : null);

describe('the default race with the paywall', () => {
  const race1 = free.windows.find((w) => w.division === last!.division)!;

  it('the fixture: the latest race is not race 1, and race 1 is listed', () => {
    expect(last).not.toBeNull();
    expect(last!.raceNumber).not.toBe(race1.raceNumber);
    expect(races.some((r) => r.division === race1.division && r.raceNumber === race1.raceNumber)).toBe(true);
  });

  it('paywall off (or /me not answered "on"): the latest race, as before; free races never worked out', () => {
    const never = (): FreeRaces => {
      throw new Error('not needed');
    };
    expect(defaultRaceFor(races, last, { me: PAYWALL_OFF, free: never, eventId: EVENT, now: NOW })).toBe(last);
    expect(startRace(races, undefined, last, { me: PAYWALL_OFF, free: never, eventId: EVENT, now: NOW })).toBe(pickRace(races, undefined, last));
  });

  it('on, no access (signed out, or signed in without a pass): race 1 of that division', () => {
    for (const me of [on(), on([], { email: 'a@example.com' }), on([pass({ eventId: 'someOtherEvent1' })], { email: 'a@example.com' })]) {
      const pick = startRace(races, undefined, last, opts(me));
      expect(key(pick)).toBe(`${race1.division}|${race1.raceNumber}`);
    }
  });

  it('on, with a Regatta Pass for this event, a Season Pass or a Coach seat: the latest race', () => {
    for (const p of [pass({}), pass({ scope: 'season', eventId: null, expiresAt: NOW + 1e9 }), pass({ scope: 'coach', eventId: null, owner: false })]) {
      expect(startRace(races, undefined, last, opts(on([p], { email: 'a@example.com' })))).toBe(last);
    }
    // An expired season is no access.
    expect(key(startRace(races, undefined, last, opts(on([pass({ scope: 'season', eventId: null, expiresAt: NOW - 1 })]))))).toBe(`${race1.division}|${race1.raceNumber}`);
  });

  it('an explicit race= wins, locked or not (the lock card shows); an unlisted one falls back to the default', () => {
    const r5 = races.find((r) => r.division === race1.division && r.raceNumber === 5)!;
    expect(startRace(races, { division: r5.division, raceNumber: 5 }, last, opts(on()))).toBe(r5);
    expect(startRace(races, { division: r5.division, raceNumber: 5 }, last, opts(PAYWALL_OFF))).toBe(r5);
    expect(key(startRace(races, { division: r5.division, raceNumber: 999 }, last, opts(on())))).toBe(`${race1.division}|${race1.raceNumber}`);
    // A restore (strict) never swaps a missing race for another.
    expect(startRace(races, { division: r5.division, raceNumber: 999 }, last, opts(on()), true)).toBeNull();
  });

  it('no free race found (no document windows, or none listed for that division): the existing default', () => {
    expect(startRace(races, undefined, last, opts(on(), { divisions: [], windows: [] }))).toBe(last);
    const elsewhere: FreeRaces = { divisions: free.divisions, windows: free.windows.map((w) => ({ ...w, division: 'Not a division' })) };
    expect(startRace(races, undefined, last, opts(on(), elsewhere))).toBe(last);
    // Nothing finished (no `last`): pickRace's own fallback, the first listed race, or race 1 of its division.
    expect(defaultRaceFor([], null, opts(on()))).toBeNull();
  });
});
