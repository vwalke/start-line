import { describe, expect, it } from 'vitest';
import { discoverOrphans, flipGun, isOrphanKey, orphanKey, PROBE_CONCURRENCY, scanDays, stageCounts, started, withOrphans, type ProbeRow } from '../src/data/orphans';
import { buildRaceList } from '../src/data/raceList';
import type { Race, RegattaDoc } from '../src/data/racesense/types';

const H = 3_600_000;
const M = 60_000;
const day = (d: number, hh: number, mm = 0): number => Date.UTC(2026, 8, d, hh, mm, 1);
const line = { leftEnd: [38.6, -9.4] as [number, number], rightEnd: [38.61, -9.39] as [number, number] };
const race = (n: number, gun: number, fins: number, extra: Partial<Race> = {}): Race => ({
  raceNumber: n,
  timezoneOffset: 3_600_000_000,
  starts: [{ startTime: gun, startLine: line }],
  finishes: Array.from({ length: fins }, (_, k) => ({ sailNumber: `S${k}`, finishingTime: new Date(gun + H + k * 1000).toISOString() })),
  ...extra,
});
const docOf = (races: Race[], start = day(7, 0), end = day(12, 23)): RegattaDoc => ({
  name: 'Test Worlds',
  startDate: start,
  endDate: end,
  divisions: [{ name: 'Open', courses: [], participants: [], races }],
});

describe('race list: practice, hidden races, numbering', () => {
  it('lists zero-finisher races, calls a lone one on the first day practice and numbers the rest in order', () => {
    const doc = docOf([race(1, day(7, 13, 55), 0), race(2, day(8, 12, 5), 100), race(3, day(8, 13, 55), 95), race(4, day(9, 12, 55), 0), race(5, day(10, 12, 50), 97)]);
    const list = buildRaceList(doc);
    const byRs = Object.fromEntries(list.races.map((r) => [r.rsNumber, r]));
    expect(byRs[1]).toMatchObject({ practice: true, number: null });
    expect([2, 3, 4, 5].map((n) => byRs[n].number)).toEqual([1, 2, 3, 4]);
    expect(byRs[4]).toMatchObject({ numbering: 'ordinal', finishes: 'tracker' });
    expect(list.races.map((r) => r.rsNumber)).toEqual([5, 4, 3, 2, 1]); // newest first
  });

  it('keeps RaceSense numbers when nothing shifts them, and practice needs a later day with finishes', () => {
    const plain = buildRaceList(docOf([race(1, day(8, 12), 10), race(2, day(8, 14), 10)]));
    expect(plain.races.map((r) => [r.number, r.numbering])).toEqual([
      [2, 'racesense'],
      [1, 'racesense'],
    ]);
    // AYC, unlinked: no finishes anywhere, so no practice either.
    const none = buildRaceList(docOf([race(1, day(7, 15), 0), race(2, day(8, 15), 0)]));
    expect(none.races.every((r) => !r.practice)).toBe(true);
    // RaceSense's own flag.
    expect(buildRaceList(docOf([race(1, day(8, 10), 0, { isPractice: true }), race(2, day(8, 12), 5)])).races.find((r) => r.rsNumber === 1)!.practice).toBe(true);
  });

  it('hides a race with no start line or a gun a week after the event (AYC J105 race 6)', () => {
    const doc = docOf([race(1, day(8, 12), 5), race(6, day(15, 22, 12), 0, { starts: [{ startTime: day(15, 22, 12), startLine: null }] }), race(7, day(20, 12), 0)], day(7, 0), day(9, 0));
    const list = buildRaceList(doc);
    expect(list.races.map((r) => r.rsNumber)).toEqual([1]);
    expect([...list.hidden].sort((a, b) => a.raceNumber - b.raceNumber)).toEqual([
      { division: 'Open', raceNumber: 6, why: 'no recorded start line' },
      { division: 'Open', raceNumber: 7, why: 'gun outside the event dates' },
    ]);
  });
});

/** A synthetic feed: race `rn` 'starting' before `gun`, 'in_progress' after (each device flips within 0–3 s of it), 20 devices at 5 Hz. */
function feed(spec: { rn: number; gun: number; from: number; to: number; restartOf?: boolean }[]): (a: number, b: number) => ProbeRow[] {
  return (a, b) => {
    const rows: ProbeRow[] = [];
    for (let t = Math.ceil(a / 200) * 200; t <= b; t += 200) {
      for (let sn = 1; sn <= 20; sn++) {
        const s = [...spec].reverse().find((x) => t >= x.from && t < x.to);
        if (!s) continue;
        const flip = s.gun + ((sn * 150) % 3000) - 200;
        rows.push({ ts: t, sn, sail: `S${sn}`, role: 'competitor', lat: 38.6, lon: -9.4, sog: 5, rn: s.rn, stage: t < flip ? 'starting' : t < s.gun + 60 * M ? 'in_progress' : 'finishing' });
      }
    }
    return rows;
  };
}

describe('orphan races from the feed', () => {
  it('reads the gun from the stage flips (third-earliest device, to the second)', () => {
    const gun = Date.UTC(2026, 8, 11, 13, 55, 0);
    const rows = feed([{ rn: 8, gun, from: gun - 30_000, to: gun + 30_000 }])(gun - 30_000, gun + 30_000);
    expect(flipGun(rows, 8)).toBe(gun);
    expect(started(stageCounts(rows.filter((r) => r.ts > gun + 10_000)), 8)).toBe(true);
    expect(orphanKey(gun)).toBe(202609111355);
    expect(isOrphanKey(202609111355)).toBe(true);
    expect(isOrphanKey(9)).toBe(false);
  });

  it('scans after the last race of a short day, takes the restart and stays in budget', async () => {
    const r4 = Date.UTC(2026, 8, 9, 12, 55, 1);
    const abandoned = Date.UTC(2026, 8, 9, 14, 34, 0);
    const restart = Date.UTC(2026, 8, 9, 16, 21, 0);
    const src = feed([
      { rn: 4, gun: r4 - 1000, from: r4 - 20 * M, to: abandoned - 25 * M },
      { rn: 5, gun: abandoned, from: abandoned - 25 * M, to: restart - 25 * M },
      { rn: 5, gun: restart, from: restart - 25 * M, to: restart + 90 * M },
    ]);
    let calls = 0;
    const listed = [
      { raceNumber: 2, gunMs: Date.UTC(2026, 8, 8, 12, 5, 1) },
      { raceNumber: 3, gunMs: Date.UTC(2026, 8, 8, 13, 55, 1) },
      { raceNumber: 4, gunMs: r4 },
    ];
    expect(scanDays(listed, H)).toEqual([r4]);
    const res = await discoverOrphans({ division: 'Open', listed, tzOffsetMs: H, startDevices: null }, async (a, b) => (calls++, src(a, b)));
    expect(res.found.map((f) => [f.trueGunMs, f.key, f.gunMs - f.trueGunMs, f.how])).toEqual([[restart, 202609091621, 1000, 'after-last']]);
    expect(res.used).toBe(calls);
    expect(res.used).toBeLessThanOrEqual(24);
    expect(res.exhausted).toBe(false);
    // A hard budget: stops, says so, finds nothing it can't confirm.
    const tight = await discoverOrphans({ division: 'Open', listed, tzOffsetMs: H, startDevices: null }, async (a, b) => src(a, b), { budget: 5 });
    expect(tight).toMatchObject({ found: [], used: 5, exhausted: true });
  });

  it('probes an official race RaceSense lacks at its official gun, and rebuilds it as a RaceSense race', async () => {
    const gun = Date.UTC(2026, 9, 3, 15, 15, 0);
    const src = feed([{ rn: 1, gun, from: gun - 20 * M, to: gun + 60 * M }]);
    const res = await discoverOrphans(
      { division: 'J70', listed: [{ raceNumber: 1, gunMs: Date.UTC(2026, 9, 3, 16, 55, 1) }], officialOnly: [{ number: 1, gunMs: gun }], tzOffsetMs: -4 * H, startDevices: null },
      async (a, b) => src(a, b),
    );
    expect(res.used).toBe(1);
    expect(res.found).toMatchObject([{ key: 202610031515, gunMs: gun + 1000, officialNumber: 1, gunFrom: 'feed', how: 'official' }]);
    const doc = withOrphans(docOf([race(1, Date.UTC(2026, 9, 3, 16, 55, 1), 0)], Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 4)), new Map([['Open', res.found]]));
    const rebuilt = doc.divisions[0].races.find((r) => r.raceNumber === 202610031515)!;
    expect(rebuilt.starts[0]).toMatchObject({ startTime: gun + 1000, startLine: line });
    const list = buildRaceList(doc, { orphans: new Map([['Open', res.found]]) });
    expect(list.races.find((r) => r.rsNumber == null)).toMatchObject({ raceNumber: 202610031515, rebuilt: { gunFrom: 'feed' } });
  });

  it('caps probe concurrency at 3 so the budget stays the bound', () => {
    expect(PROBE_CONCURRENCY).toBe(3);
  });
});
