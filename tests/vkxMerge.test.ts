import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { coverage } from '../src/analysis/coverage';
import { buildRaceData } from '../src/data/racesense/adapter';
import type { RaceData } from '../src/data/types';
import { decodePayload, type PayloadTrack } from '../src/data/vkx/compact';
import { coveredRaces, type RaceWindow } from '../src/data/vkx/match';
import { LOG_HOLE_MS, RACE_HZ, START_DENSE_POST_MS, START_DENSE_PRE_MS, START_HZ, logWarnings, mergeTrack, mergeUploads, sameSail, thinIndices } from '../src/data/vkx/merge';
import { parseVkx } from '../src/data/vkx/parse';
import { payloadFor } from '../src/data/vkx/plan';
import { DIV, EVENT, R7_GUN, RO, Z, trimVkx, vkxFeed, vkxRegatta } from './vkxHelpers';

const R7_SHORT: RaceWindow = { id: '7', label: 'R7', gunMs: R7_GUN, endMs: Z('12:07:50'), endKnown: false };

async function r7Payload(): Promise<PayloadTrack> {
  const log = parseVkx(trimVkx());
  const [c] = coveredRaces(log.pos.t, [R7_SHORT]);
  const p = await payloadFor(log, c, { event: EVENT, div: DIV }, RO, { sha256: 'b'.repeat(64), bytes: 1 });
  return decodePayload(p.bytes);
}

const r7Data = (): RaceData => buildRaceData(vkxRegatta(), { division: DIV, raceNumber: 7 }, [vkxFeed()], { eventId: EVENT, kind: 'fixture' });

describe('merging a boat log into the race', () => {
  it('replaces the feed fixes inside the log span only', async () => {
    const up = await r7Payload();
    const data = r7Data();
    const before = data.boats.find((b) => b.sail === RO.sail)!.track;
    const merged = mergeUploads(data, [{ track: up, uploadedAt: 1 }]);
    const tr = merged.boats.find((b) => b.sail === RO.sail)!.track;
    const from = up.t[0];
    const to = up.t[up.t.length - 1];
    // Feed fixes outside the span are all still there, unchanged.
    const outside = (t: Float64Array): number[] => [...t].filter((x) => x < from || x > to);
    expect(outside(tr.t)).toEqual(outside(before.t));
    // Inside, every fix is one of the log's.
    const logTimes = new Set(up.t);
    const inside = [...tr.t].filter((x) => x >= from && x <= to);
    expect(inside.every((x) => logTimes.has(x))).toBe(true);
    // Far denser than the feed there (the feed had ~0.5 Hz).
    const feedInside = [...before.t].filter((x) => x >= from && x <= to).length;
    expect(inside.length).toBeGreaterThan(3 * feedInside);
    // Sorted, no repeats.
    for (let k = 1; k < tr.t.length; k++) expect(tr.t[k]).toBeGreaterThan(tr.t[k - 1]);
    // Other boats untouched.
    for (const b of data.boats.filter((x) => x.sail !== RO.sail)) expect(merged.boats.find((x) => x.id === b.id)!.track).toBe(b.track);
    const log = merged.boats.find((b) => b.sail === RO.sail)!.log!;
    expect(log).toMatchObject({ kind: 'vkx', rateHz: 10, startHz: START_HZ, raceHz: RACE_HZ, uploadedAt: 1 });
    expect(log.samples).toBe(up.t.length);
  });

  it('thins to 5 Hz around the start and 1 Hz elsewhere', async () => {
    const up = await r7Payload();
    const keep = thinIndices(up.t, R7_GUN);
    const at = (a: number, b: number): number => [...keep].filter((k) => up.t[k] >= a && up.t[k] < b).length;
    // 60 s well inside the dense window, and 60 s before it.
    expect(at(R7_GUN - 90_000, R7_GUN - 30_000)).toBeGreaterThanOrEqual(295);
    expect(at(R7_GUN - 90_000, R7_GUN - 30_000)).toBeLessThanOrEqual(305);
    // The trimmed log starts 241 s before the gun; the dense window 130 s before it.
    const early = R7_GUN - 235_000;
    expect(early + 60_000).toBeLessThan(R7_GUN - START_DENSE_PRE_MS);
    expect(at(early, early + 60_000)).toBeGreaterThanOrEqual(59);
    expect(at(early, early + 60_000)).toBeLessThanOrEqual(61);
    expect(START_DENSE_POST_MS).toBeGreaterThanOrEqual(20_000);
  });

  it("keeps the feed's fixes inside a hole in the log", async () => {
    const up = await r7Payload();
    // Cut 20 s out of the log.
    const cutA = Z('12:03:00');
    const cutB = Z('12:03:20');
    const keep = [...up.t.keys()].filter((k) => up.t[k] < cutA || up.t[k] > cutB);
    const pick = <T extends Float64Array | Float32Array>(a: T): T => a.constructor === Float64Array ? (Float64Array.from(keep, (k) => a[k]) as T) : (Float32Array.from(keep, (k) => a[k]) as T);
    const holed: PayloadTrack = { ...up, t: pick(up.t), lat: pick(up.lat), lon: pick(up.lon), sog: pick(up.sog), cog: pick(up.cog), heading: pick(up.heading!), heel: pick(up.heel!), pitch: pick(up.pitch!) };
    const feed = r7Data().boats.find((b) => b.sail === RO.sail)!.track;
    const tr = mergeTrack(feed, holed, R7_GUN);
    const feedInHole = [...feed.t].filter((x) => x > cutA && x < cutB);
    expect(feedInHole.length).toBeGreaterThan(0);
    for (const x of feedInHole) expect([...tr.t]).toContain(x);
    expect(cutB - cutA).toBeGreaterThan(LOG_HOLE_MS);
  });

  it('ignores an upload for another time and matches sails loosely', async () => {
    const up = await r7Payload();
    const moved: PayloadTrack = { ...up, t: up.t.map((x) => x + 86_400_000) };
    const data = r7Data();
    expect(mergeUploads(data, [{ track: moved }]).boats.find((b) => b.sail === RO.sail)!.log).toBeUndefined();
    expect(sameSail('USA 833', 'usa833')).toBe(true);
    expect(sameSail('USA 833', 'USA 83')).toBe(false);
  });

  it('runs through the analysis: the boat gets the log, full coverage and a denser start', async () => {
    const up = await r7Payload();
    const data = r7Data();
    const a0 = analyzeRace(data, { allCompetitors: true });
    const a1 = analyzeRace(mergeUploads(data, [{ track: up }]), { allCompetitors: true });
    const b0 = a0.boats.find((b) => b.sail === RO.sail)!;
    const b1 = a1.boats.find((b) => b.sail === RO.sail)!;
    expect(b0.log).toBeUndefined();
    expect(b1.log?.rateHz).toBe(10);
    const d0 = a0.drawings.find((d) => d.id === b0.id)!;
    const d1 = a1.drawings.find((d) => d.id === b1.id)!;
    // Speed through the start: every fix from 2 min before the gun to 20 s after — now 5 Hz.
    expect(d1.startSog.t.length).toBeGreaterThan(600);
    expect(d1.startSog.t.length).toBeGreaterThan(3 * d0.startSog.t.length);
    // Around the gun the feed was relatively good for USA 833 (fixes ≤ 5 s apart), but ~0.6 Hz against the log's 5 Hz.
    const tr1 = mergeUploads(data, [{ track: up }]).boats.find((b) => b.sail === RO.sail)!.track;
    const tr0 = data.boats.find((b) => b.sail === RO.sail)!.track;
    const fixes = (t: Float64Array): number => [...t].filter((x) => x >= R7_GUN - 60_000 && x <= R7_GUN + 20_000).length;
    expect(fixes(tr1.t)).toBeGreaterThan(5 * fixes(tr0.t));
    expect(coverage(tr1.t, R7_GUN - 120_000, R7_GUN + 120_000).coverage).toBe(1);
    expect(b1.start).not.toBeNull();
  });

  it('flags the boat timer and pinged line only when they disagree', async () => {
    const up = await r7Payload();
    const merged = mergeUploads(r7Data(), [{ track: up }]);
    const log = merged.boats.find((b) => b.sail === RO.sail)!.log!;
    // The boat's timer hit zero at 12:05:00.000; RaceSense has the gun at 12:05:01.
    expect(log.timerDeltaS).toBe(-1);
    expect(log.linePinM).not.toBeNull();
    expect(log.lineBoatM).not.toBeNull();
    expect(logWarnings(log)).toEqual([]);
    // A 6 s late timer, and a pin 40 m off, do get chips.
    const off = logWarnings({ ...log, timerDeltaS: 6.2, linePinM: 40 });
    expect(off.map((w) => w.text)).toEqual(['boat timer Δ +6s', 'line pin end 40 m off']);
    expect(logWarnings({ ...log, timerDeltaS: -4 })[0].text).toBe('boat timer Δ −4s');
  });
});
