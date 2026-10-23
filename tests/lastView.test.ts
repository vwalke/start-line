import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { RaceListItem } from '../src/data/racesense/adapter';
import {
  LAST_VIEW_KEY,
  applyView,
  clearLastView,
  isTransientError,
  parseLastView,
  pickRace,
  readLastView,
  resolveStart,
  serializeLastView,
  viewForRace,
  writeLastView,
  type LastView,
} from '../src/ui/lastView';
import { m24Race } from './helpers';

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

describe('parseLastView / serializeLastView', () => {
  it('round-trips, with and without nc=all', () => {
    expect(LAST_VIEW_KEY).toBe('recall.lastView');
    expect(parseLastView(serializeLastView(rec))).toEqual(rec);
    const nc: LastView = { ...rec, allCompetitors: true, leg: null, boat: null, sort: null };
    expect(parseLastView(serializeLastView(nc))).toEqual(nc);
    expect(serializeLastView(rec)).not.toContain('allCompetitors');
  });

  it('round-trips the start table sort, and stays readable by the old shape', () => {
    const both: LastView = { ...rec, startSort: { key: 'speed', dir: 'desc' } };
    expect(parseLastView(serializeLastView(both))).toEqual(both);
    expect(serializeLastView(rec)).not.toContain('startSort');
    // A malformed startSort is dropped, not the whole record.
    expect(parseLastView(JSON.stringify({ ...rec, startSort: { key: 'x', dir: 'up' } }))).toEqual(rec);
  });

  it('rejects anything malformed', () => {
    const bad = (patch: Record<string, unknown>): string => JSON.stringify({ ...rec, ...patch });
    for (const raw of [
      null,
      undefined,
      '',
      'not json',
      '[]',
      'null',
      '42',
      bad({ v: 2 }),
      bad({ v: '1' }),
      bad({ eventId: 'ab' }),
      bad({ eventId: '../regatta' }),
      bad({ eventId: 'x'.repeat(65) }),
      bad({ eventId: 7 }),
      bad({ division: '' }),
      bad({ division: 3 }),
      bad({ raceNumber: '4' }),
      bad({ raceNumber: 4.5 }),
      bad({ raceNumber: 0 }),
      bad({ raceNumber: -1 }),
      bad({ raceNumber: null }),
      bad({ leg: -1 }),
      bad({ leg: 1.5 }),
      bad({ leg: '1' }),
      bad({ boat: 5 }),
      bad({ boat: '' }),
      bad({ sort: { key: 'fin', dir: 'up' } }),
      bad({ sort: { key: '', dir: 'asc' } }),
      bad({ sort: 'fin' }),
      bad({ savedAt: 'yesterday' }),
      bad({ allCompetitors: 'all' }),
      JSON.stringify({ ...rec, leg: undefined }),
    ]) {
      expect(parseLastView(raw)).toBeNull();
    }
  });
});

describe('resolveStart', () => {
  it('an explicit event in the URL wins over the saved race', () => {
    const p = resolveStart('?event=other-event&div=J70&race=8', rec);
    expect(p).toEqual({ source: 'url', params: { eventId: 'other-event', want: { division: 'J70', raceNumber: 8 } } });
    expect(resolveStart('?event=m24-worlds-2026', rec)).toEqual({ source: 'url', params: { eventId: 'm24-worlds-2026' } });
    expect(resolveStart('?event=m24-worlds-2026&div=M24&race=5', rec).source).toBe('url');
    expect(resolveStart('?event=m24-worlds-2026&div=M24&race=5', rec)).not.toHaveProperty('view');
  });

  it('the URL naming the saved race also restores its view state', () => {
    expect(resolveStart('?event=m24-worlds-2026&div=M24&race=4&nc=all', rec)).toEqual({
      source: 'url',
      params: { eventId: 'm24-worlds-2026', want: { division: 'M24', raceNumber: 4 }, allCompetitors: true },
      view: { leg: 1, boat: 'b870', sort: { key: 'L0.sog', dir: 'desc' } },
    });
  });

  it('no URL race: the saved one, with its view state and nc', () => {
    expect(resolveStart('', rec)).toEqual({
      source: 'saved',
      params: { eventId: 'm24-worlds-2026', want: { division: 'M24', raceNumber: 4 } },
      view: { leg: 1, boat: 'b870', sort: { key: 'L0.sog', dir: 'desc' } },
    });
    expect(resolveStart('?div=X&race=1', { ...rec, allCompetitors: true }).params).toEqual({
      eventId: 'm24-worlds-2026',
      want: { division: 'M24', raceNumber: 4 },
      allCompetitors: true,
    });
  });

  it('nothing saved: the latest race, as before', () => {
    expect(resolveStart('', null)).toEqual({ source: 'latest', params: { eventId: '' } });
    expect(resolveStart('?nc=all', null)).toEqual({ source: 'latest', params: { eventId: '', allCompetitors: true } });
  });
});

describe('viewForRace', () => {
  const showing = { leg: 2, boat: 'b870', sort: { key: 'fin', dir: 'asc' as const } };
  const race4 = { eventId: rec.eventId, division: 'M24', raceNumber: 4 };
  const race5 = { eventId: rec.eventId, division: 'M24', raceNumber: 5 };

  it('an explicit restore wins, including a reset view', () => {
    const reset = { leg: null, boat: null, sort: null };
    expect(viewForRace(race4, race4, showing, reset)).toEqual(reset);
    expect(viewForRace(null, race5, showing, showing)).toEqual(showing);
  });

  it('keeps the on-screen view when this is the race already showing', () => {
    expect(viewForRace(race4, race4, showing)).toEqual(showing);
  });

  it('starts clean when switching races, or when nothing is on screen yet', () => {
    expect(viewForRace(race4, race5, showing)).toBeUndefined();
    expect(viewForRace(race4, { eventId: 'other-event', division: 'M24', raceNumber: 4 }, showing)).toBeUndefined();
    expect(viewForRace(null, race4, showing)).toBeUndefined();
  });
});

describe('pickRace', () => {
  const race = (division: string, raceNumber: number): RaceListItem => ({
    division,
    raceNumber,
    gunMs: 0,
    finishers: 3,
    finished: true,
    lastFinishMs: null,
  });
  const races = [race('M24', 5), race('M24', 4), race('J70', 4)];

  it('finds the wanted race', () => {
    expect(pickRace(races, { division: 'M24', raceNumber: 4 }, races[0])).toBe(races[1]);
    expect(pickRace(races, { division: 'J70', raceNumber: 4 }, races[0], true)).toBe(races[2]);
  });

  it('falls back to the default (then the first) race for a pick, never for a restore', () => {
    const gone = { division: 'M24', raceNumber: 9 };
    expect(pickRace(races, gone, races[2])).toBe(races[2]);
    expect(pickRace(races, gone, null)).toBe(races[0]);
    expect(pickRace(races, undefined, races[2])).toBe(races[2]);
    expect(pickRace(races, gone, races[2], true)).toBeNull();
    expect(pickRace(races, { division: 'm24', raceNumber: 4 }, races[0], true)).toBeNull();
    expect(pickRace([], gone, null)).toBeNull();
  });
});

describe('applyView', () => {
  const a = analyzeRace(m24Race());
  const boat = a.boats[1].id;
  const nc = a.excluded[0]?.result.id;

  it('keeps a leg, boat and sort column this race has', () => {
    expect(a.legs.length).toBeGreaterThan(0);
    const v = { leg: a.legs.length - 1, boat, sort: { key: 'fin', dir: 'asc' as const } };
    expect(applyView(a, v)).toEqual({ ...v, startSort: null });
    expect(applyView(a, { leg: null, boat: null, sort: null })).toEqual({ leg: null, boat: null, sort: null, startSort: null });
    // Each table's own sort.
    const both = { ...v, sort: { key: 'up.vmg', dir: 'desc' as const }, startSort: { key: 'speed', dir: 'desc' as const } };
    expect(applyView(a, both)).toEqual(both);
  });

  it('restores an old single-table sort onto whichever table now has that column', () => {
    // Records from before the split: one `sort`, no `startSort`.
    for (const key of ['start', 'rc', 'ours', 'late', 'line', 'speed', 'twa']) {
      expect(applyView(a, { leg: null, boat: null, sort: { key, dir: 'asc' } })).toMatchObject({ sort: null, startSort: { key, dir: 'asc' } });
    }
    for (const key of ['fin', 'boat', 'sog', 'L0.sog', 'L1.time', 'dist', 'race']) {
      expect(applyView(a, { leg: null, boat: null, sort: { key, dir: 'desc' } })).toMatchObject({ sort: { key, dir: 'desc' }, startSort: null });
    }
    // A record that went through parse/serialize the old way restores the same.
    const old = parseLastView(JSON.stringify({ ...rec, sort: { key: 'late', dir: 'asc' } }))!;
    expect(old.startSort).toBeUndefined();
    expect(applyView(a, old)).toMatchObject({ sort: null, startSort: { key: 'late', dir: 'asc' } });
    // Each table key is unique: none is in both tables.
    expect(applyView(a, { leg: null, boat: null, sort: null, startSort: { key: 'L0.sog', dir: 'asc' } })).toMatchObject({ sort: { key: 'L0.sog', dir: 'asc' }, startSort: null });
  });

  it('keeps a picked not-racing boat', () => {
    expect(nc).toBeTruthy();
    expect(applyView(a, { leg: null, boat: nc!, sort: null }).boat).toBe(nc);
  });

  it('drops unknown boats, legs and sort columns', () => {
    expect(applyView(a, { leg: a.legs.length, boat: 'nobody', sort: { key: 'L9.sog', dir: 'desc' }, startSort: { key: 'nope', dir: 'asc' } })).toEqual({
      leg: null,
      boat: null,
      sort: null,
      startSort: null,
    });
    expect(applyView(a, { leg: -1, boat, sort: null })).toEqual({ leg: null, boat, sort: null, startSort: null });
  });
});

describe('isTransientError', () => {
  it('retries network trouble and 5xx, not missing data', () => {
    for (const m of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', '503 Service Unavailable for /api/regatta?event=x', '502 Bad Gateway for /api/x', '429 Too Many Requests for /api/x']) {
      expect(isTransientError(m)).toBe(true);
    }
    for (const m of ['404 Not Found for /api/regatta?event=x', '400 Bad Request for /api/x', 'Race 4 not found in M24', 'Regatta has no revisions', 'No start line']) {
      expect(isTransientError(m)).toBe(false);
    }
  });
});

describe('last-view storage', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const stub = (value: unknown): void => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  };
  afterEach(() => {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('writes, reads back and clears', () => {
    const m = new Map<string, string>();
    stub({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v), removeItem: (k: string) => m.delete(k) });
    expect(readLastView()).toBeNull();
    writeLastView(rec);
    expect(m.has(LAST_VIEW_KEY)).toBe(true);
    expect(readLastView()).toEqual(rec);
    m.set(LAST_VIEW_KEY, '{"v":1');
    expect(readLastView()).toBeNull();
    clearLastView();
    expect(m.has(LAST_VIEW_KEY)).toBe(false);
  });

  it('tolerates absent storage', () => {
    stub(undefined);
    expect(readLastView()).toBeNull();
    expect(() => writeLastView(rec)).not.toThrow();
    expect(() => clearLastView()).not.toThrow();
  });

  it('tolerates storage that throws', () => {
    const boom = (): never => {
      throw new Error('SecurityError');
    };
    stub({ getItem: boom, setItem: boom, removeItem: boom });
    expect(readLastView()).toBeNull();
    expect(() => writeLastView(rec)).not.toThrow();
    expect(() => clearLastView()).not.toThrow();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: boom });
    expect(readLastView()).toBeNull();
    expect(() => writeLastView(rec)).not.toThrow();
    expect(() => clearLastView()).not.toThrow();
  });
});

describe('app wiring', () => {
  const app = readFileSync(new URL('../src/ui/app.ts', import.meta.url), 'utf8');

  it('saves when the page is hidden or left, and re-syncs on a bfcache restore', () => {
    expect(app).toMatch(/addEventListener\('visibilitychange'/);
    expect(app).toMatch(/visibilityState === 'hidden'\) save\(\)/);
    expect(app).toMatch(/addEventListener\('pagehide', save\)/);
    expect(app).toMatch(/addEventListener\('pageshow'[\s\S]{0,120}persisted/);
  });

  it('picks races through pickRace (via the paywall-aware startRace), strictly for a restore', () => {
    expect(app).toMatch(/startRace\(races, want, defaultRace\(doc\), \{[^}]*\}, opts\.strict\)/);
    expect(readFileSync(new URL('../src/ui/paywall.ts', import.meta.url), 'utf8')).toContain('pickRace(races, want, defaultRaceFor(races, last, o), strict)');
    expect(app).toMatch(/loadEvent\(id, want, \{ strict: true, view: p\.view \}\)/);
    expect(app).not.toMatch(/\?\? defaultRace\(doc\) \?\? races\[0\]/);
  });

  it('does not replaceState the URL until the race is on screen', () => {
    expect(app).toContain('viewForRace(current, { eventId: id, division, raceNumber }');
    const load = app.slice(app.indexOf('async function loadRace'), app.indexOf('function renderEventOptions'));
    expect(load.indexOf('await show(')).toBeLessThan(load.indexOf('setUrl({ event: id'));
  });

  it('offers a way back to the latest race and a retry', () => {
    expect(app).toContain("'Reopened your last race.'");
    expect(app).toContain("label: 'Latest race'");
    expect(app).toContain('Showing the latest race.');
    expect(app).toContain("label: 'Retry'");
  });
});
