import { describe, expect, it } from 'vitest';
import { currentDoc } from '../src/data/racesense/adapter';
import {
  COVER_MIN,
  MATCH_MIN_POINTS,
  agreement,
  checkDevice,
  checkWindows,
  coveredRaces,
  decideBoat,
  feedFixes,
  logAt,
  raceWindowsFromDoc,
  type RaceWindow,
} from '../src/data/vkx/match';
import { parseVkx, type VkxLog } from '../src/data/vkx/parse';
import { matchRace } from '../src/data/vkx/plan';
import { DIV, R7_GUN, R8_END, R8_GUN, RO, Z, editFeed, fixtureFetcher, trimVkx, vkxFeed, vkxRegatta } from './vkxHelpers';

/** Short "races" the trimmed log covers in full: R7's first 3 minutes, R8's first 3. */
const SHORT: RaceWindow[] = [
  { id: '7', label: 'R7', gunMs: R7_GUN, endMs: Z('12:07:50'), endKnown: false },
  { id: 'o8', label: 'R8', gunMs: R8_GUN, endMs: Z('13:57:50'), endKnown: false },
];

/** The log with its positions moved north by `m` metres. */
function shifted(log: VkxLog, m: number): VkxLog {
  const d = m / 111_195;
  return { ...log, pos: { ...log.pos, lat: log.pos.lat.map((x) => x + d) } };
}

describe('races a log covers', () => {
  const log = parseVkx(trimVkx());

  it('finds both races in one file', () => {
    const c = coveredRaces(log.pos.t, SHORT);
    expect(c.map((x) => x.race.id)).toEqual(['7', 'o8']);
    for (const x of c) expect(x.frac).toBeGreaterThan(0.99);
    // The payload window: 5 min before the gun (cut to the log) to 2 min after the end (cut to the log).
    expect(c[0].fromMs).toBe(log.pos.t[0]);
    expect(c[0].toMs).toBe(Z('12:09:50'));
  });

  it('ignores a race it only partly covers, and one it misses', () => {
    const partial: RaceWindow = { id: '9', label: 'R9', gunMs: Z('12:06:00'), endMs: Z('12:30:00'), endKnown: true };
    const none: RaceWindow = { id: '1', label: 'R1', gunMs: Z('09:00:00'), endMs: Z('10:00:00'), endKnown: true };
    expect(coveredRaces(log.pos.t, [partial, none])).toEqual([]);
    // 2 of 24 minutes: under COVER_MIN.
    expect(COVER_MIN).toBe(0.5);
  });

  it("lists every gunned race of the division, hidden 0-finisher ones included, with estimated ends", () => {
    const doc = currentDoc(vkxRegatta());
    const ws = raceWindowsFromDoc(doc, DIV);
    expect(ws.map((w) => w.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    const r7 = ws.find((w) => w.id === '7')!;
    expect(r7.gunMs).toBe(R7_GUN);
    expect(r7.endKnown).toBe(false);
    // No finishes and a bogus next-day endTime: gun + 2 h.
    expect(r7.endMs).toBe(R7_GUN + 2 * 3_600_000);
    // With the day's second race known (an orphan the race-recovery work will list), R7 ends 5 min before its gun.
    const orphan: RaceWindow = { id: 'o-2026-09-11-2', label: 'R8', gunMs: R8_GUN, endMs: R8_END, endKnown: true };
    const ws2 = raceWindowsFromDoc(doc, DIV, [orphan]);
    expect(ws2.find((w) => w.id === '7')!.endMs).toBe(R8_GUN - 5 * 60_000);
    expect(ws2.map((w) => w.id)).toContain('o-2026-09-11-2');
    expect(raceWindowsFromDoc(doc, 'Nope')).toEqual([]);
  });
});

describe('which boat a log is', () => {
  const log = parseVkx(trimVkx());
  const [c7, c8] = coveredRaces(log.pos.t, SHORT);

  it('matches USA 833 in both races, with a clear margin over the boat 5 m away at the gun', async () => {
    for (const c of [c7, c8]) {
      const m = await matchRace(log, c, fixtureFetcher());
      expect(m.verdict.kind).toBe('match');
      if (m.verdict.kind !== 'match') continue;
      expect(m.verdict.boat.sn).toBe(RO.sn);
      expect(m.verdict.boat.sail).toBe(RO.sail);
      expect(m.verdict.boat.n).toBeGreaterThanOrEqual(MATCH_MIN_POINTS);
      expect(m.verdict.boat.medianM).toBeLessThan(1);
      expect(m.verdict.runnerUp!.medianM).toBeGreaterThan(25);
      expect(m.fixes.every((f) => f.sn === RO.sn)).toBe(true);
    }
  });

  it('rejects the log moved 200 m (an off-course or doctored track)', async () => {
    const m = await matchRace(shifted(log, 200), c7, fixtureFetcher());
    expect(m.verdict.kind).toBe('none');
    if (m.verdict.kind === 'none') expect(m.verdict.reason).toMatch(/No boat's public track follows this log/);
  });

  it("picks the other boat for another boat's track, so it can't be filed under USA 833", () => {
    // A "log" made from ITA 1490's feed fixes, filled in to 10 Hz.
    const fixes = feedFixes([vkxFeed()]).filter((f) => f.sn === 24009 && f.ts >= Z('12:01:00') && f.ts <= Z('12:08:00'));
    const t: number[] = [];
    const lat: number[] = [];
    const lon: number[] = [];
    for (let k = 1; k < fixes.length; k++) {
      const a = fixes[k - 1];
      const b = fixes[k];
      for (let x = a.ts; x < b.ts; x += 100) {
        const f = (x - a.ts) / (b.ts - a.ts);
        t.push(x);
        lat.push(a.lat + f * (b.lat - a.lat));
        lon.push(a.lon + f * (b.lon - a.lon));
      }
    }
    const fake = { t: Float64Array.from(t), lat: Float64Array.from(lat), lon: Float64Array.from(lon) };
    const all = feedFixes([vkxFeed()]);
    const best = agreement(fake, all)[0];
    expect(best.sn).toBe(24009);
    expect(best.sail).toBe('ITA 1490');
    // …and the server's check for USA 833 refuses it.
    const check = checkDevice(fake, all, RO.sn);
    expect(check).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('falls back to a confirmed pick when the boat has too few feed fixes, still requiring agreement', async () => {
    const sparse = editFeed(RO.sn, { keep: (_ts, k) => k % 40 === 0 });
    const m = await matchRace(log, c7, fixtureFetcher(sparse));
    expect(m.verdict.kind).toBe('sparse');
    if (m.verdict.kind === 'sparse') {
      expect(m.verdict.boat.sn).toBe(RO.sn);
      expect(m.verdict.boat.n).toBeLessThan(MATCH_MIN_POINTS);
      expect(m.verdict.candidates.map((x) => x.sn)).toEqual([RO.sn]);
    }
    // Sparse and moved: nothing agrees, so no pick is offered.
    const off = await matchRace(log, c7, fixtureFetcher(editFeed(RO.sn, { keep: (_ts, k) => k % 40 === 0, dLat: 0.001 })));
    expect(off.verdict.kind).toBe('none');
  });

  it('decides on medians and counts', () => {
    const a = (sn: number, n: number, medianM: number) => ({ sn, sail: String(sn), n, medianM });
    expect(decideBoat([a(1, 40, 0.5), a(2, 40, 60)]).kind).toBe('match');
    expect(decideBoat([a(1, 40, 0.5), a(2, 40, 3)]).kind).toBe('sparse'); // two boats agree: the user confirms
    expect(decideBoat([a(1, 12, 0.5)]).kind).toBe('sparse');
    expect(decideBoat([a(1, 3, 0.5)]).kind).toBe('none');
    expect(decideBoat([a(1, 40, 8)]).kind).toBe('none');
    expect(decideBoat([]).kind).toBe('none');
  });

  it('interpolates only between close fixes, and spreads the check windows over the payload', () => {
    const tr = { t: [0, 100, 5000], lat: [0, 1, 2], lon: [0, 0, 0] };
    expect(logAt(tr, 50)!.lat).toBeCloseTo(0.5);
    expect(logAt(tr, 2000)).toBeNull();
    expect(logAt(tr, -1)).toBeNull();
    const w = checkWindows(0, 600_000);
    expect(w).toHaveLength(8);
    expect(w[0]).toEqual({ after: 12_500, before: 62_500 });
    expect(checkWindows(0, 100_000)).toEqual([{ after: 0, before: 100_000 }]);
  });
});
