/**
 * Goldens on RO's (USA 833) own log, J/70 Worlds Cascais, Fri Sep 11 2026.
 * The full 10 MB log is read only when present (VKX_SAMPLE or the run's inputs);
 * the trimmed fixture's goldens always run (vkxMatch / vkxMerge tests).
 */
import { describe, expect, it } from 'vitest';
import { handleUpload } from '../functions/_vkx';
import { coverage } from '../src/analysis/coverage';
import { buildRaceData, currentDoc, listRaces } from '../src/data/racesense/adapter';
import { decodePayload } from '../src/data/vkx/compact';
import { discoverOrphans, withOrphans } from '../src/data/orphans';
import { buildRaceList } from '../src/data/raceList';
import { orphanContexts } from '../src/data/recovery';
import { agreement, coveredRaces, feedFixes, raceWindowsFromDoc, raceWindowsFromListed, type RaceWindow } from '../src/data/vkx/match';
import { regatta, replayProbes } from './recoveryHelpers';
import { mergeUploads } from '../src/data/vkx/merge';
import { parseVkx } from '../src/data/vkx/parse';
import { coverageGain, matchRace, payloadFor } from '../src/data/vkx/plan';
import { MemBucket } from './r2mem';
import { DIV, EVENT, R7_GUN, R7_RO_FINISH, R8_END, R8_GUN, RO, fixtureFetcher, fullVkx, hasFullSample, mockUpstream, vkxFeed, vkxRegatta } from './vkxHelpers';

const edt = (ms: number): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' }).format(ms);

/** Official R8 as the race-recovery work will list it (RaceSense has no such race): gun from the boat's timer, end from FINDINGS. */
const ORPHAN_R8: RaceWindow = { id: 'o-2026-09-11-2', label: 'R8', gunMs: R8_GUN, endMs: R8_END, endKnown: true };

describe('upload windows include races rebuilt by recovery', () => {
  it('lists official R7 and orphan R8 (YYYYMMDDHHMM) so one .vkx covers both', async () => {
    const doc = currentDoc(regatta('rs_j70.json'));
    const replay = replayProbes('j70_probes.json');
    const [ctx] = orphanContexts(doc, buildRaceList(doc), null);
    const res = await discoverOrphans(ctx, replay.fetchRows);
    const found = new Map([['Open', res.found]]);
    const merged = withOrphans(doc, found);
    const list = buildRaceList(merged, { orphans: found });
    const ws = raceWindowsFromListed(list.races, 'Open');
    expect(ws.map((w) => [w.id, w.label])).toEqual(
      expect.arrayContaining([
        ['7', 'R7'],
        ['202609111355', 'R8'],
      ]),
    );
    const r8 = ws.find((w) => w.id === '202609111355')!;
    expect(r8.gunMs).toBe(Date.parse('2026-09-11T13:55:01Z'));
    expect(raceWindowsFromDoc(merged, 'Open').some((w) => w.id === '202609111355')).toBe(true);
  });
});

describe('regatta document: what the app lists for Fri Sep 11 today', () => {
  it('has R7 (gun 08:05:01 EDT) with no finishes — hidden by the race picker — and no R8 that day', () => {
    const doc = currentDoc(vkxRegatta());
    const r7 = listRaces(doc).find((r) => r.raceNumber === 7)!;
    expect(r7.gunMs).toBe(R7_GUN);
    expect(edt(r7.gunMs)).toBe('08:05:01 EDT');
    expect(r7.finishers).toBe(0);
    // app.ts lists only races with finishers, so R7 isn't in the picker on main.
    expect(listRaces(doc).filter((r) => r.finishers > 0).some((r) => r.raceNumber === 7)).toBe(false);
    // RaceSense's race 8 is Saturday's: the day's second race is an orphan.
    const r8 = listRaces(doc).find((r) => r.raceNumber === 8)!;
    expect(new Date(r8.gunMs).toISOString().slice(0, 10)).toBe('2026-09-12');
  });
});

describe.skipIf(!hasFullSample)('golden: the full log', () => {
  // Parse only if this suite actually runs — skipIf still evaluates the factory.
  let cached: ReturnType<typeof parseVkx> | undefined;
  const log = (): ReturnType<typeof parseVkx> => (cached ??= parseVkx(fullVkx()));
  const doc = currentDoc(vkxRegatta());

  it('covers R7 against today’s race list, and R7 + R8 once the orphan R8 is listed', () => {
    expect(coveredRaces(log().pos.t, raceWindowsFromDoc(doc, DIV)).map((c) => c.race.label)).toEqual(['R7']);
    const both = coveredRaces(log().pos.t, raceWindowsFromDoc(doc, DIV, [ORPHAN_R8]));
    expect(both.map((c) => c.race.label)).toEqual(['R7', 'R8']);
    for (const c of both) expect(c.frac).toBeGreaterThan(0.99);
  });

  it('has the boat’s own gun at 08:05:00 EDT (R7) and 09:55:00 EDT (R8)', () => {
    const guns = log().timers.filter((e) => e.name === 'RACE_START').map((e) => edt(e.t));
    expect(guns).toEqual(['08:05:00 EDT', '09:55:00 EDT']);
  });

  it('matches USA 833 in R7 and R8', async () => {
    for (const c of coveredRaces(log().pos.t, raceWindowsFromDoc(doc, DIV, [ORPHAN_R8]))) {
      const m = await matchRace(log(), c, fixtureFetcher());
      if (m.verdict.kind !== 'match') console.log('[vkx golden] verdict', c.race.label, m.verdict.kind, JSON.stringify(m.stats.slice(0, 3)), m.windowsChecked);
      expect(m.verdict.kind).toBe('match');
      if (m.verdict.kind === 'match') {
        expect(m.verdict.boat.sail).toBe(RO.sail);
        expect(m.verdict.boat.sn).toBe(RO.sn);
        console.log(`[vkx golden] ${c.race.label}: USA 833 median ${m.verdict.boat.medianM.toFixed(2)} m over ${m.verdict.boat.n} fixes, ${m.windowsChecked} windows`);
      }
    }
    // Over every fixture fix: USA 833 first, the 4 boats nearest it at the R7 gun far behind.
    const all = agreement(log().pos, feedFixes([vkxFeed()]));
    expect(all[0].sail).toBe(RO.sail);
    expect(all[0].medianM).toBeLessThan(1);
    for (const o of all.slice(1)) expect(o.medianM).toBeGreaterThan(25);
  });

  it('lifts R7 coverage from the feed’s ~23% to ~100%', () => {
    const feedT = Float64Array.from(feedFixes([vkxFeed()]).filter((f) => f.sn === RO.sn).map((f) => f.ts));
    // Seconds holding a fix (FINDINGS' measure): 23.1%.
    const secs = (t: Float64Array, a: number, b: number): number => new Set([...t].filter((x) => x >= a && x < b).map((x) => Math.floor(x / 1000))).size / ((b - a) / 1000);
    const g = Date.parse('2026-09-11T12:05:00Z');
    expect(secs(feedT, g, R7_RO_FINISH)).toBeCloseTo(0.231, 2);
    expect(secs(log().pos.t, g, R7_RO_FINISH)).toBeGreaterThan(0.999);
    // The app's own measure (time between fixes ≤ 5 s apart), as the tables' coverage shows it.
    const app0 = coverage(feedT, R7_GUN, R7_RO_FINISH).coverage;
    const data = buildRaceData(vkxRegatta(), { division: DIV, raceNumber: 7 }, [vkxFeed()], { eventId: EVENT, kind: 'fixture' });
    return (async () => {
      const [c7] = coveredRaces(log().pos.t, raceWindowsFromDoc(doc, DIV, [ORPHAN_R8]));
      const p = await payloadFor(log(), c7, { event: EVENT, div: DIV }, RO, { sha256: 'e'.repeat(64), bytes: log().bytes });
      const merged = mergeUploads(data, [{ track: await decodePayload(p.bytes) }]);
      const tr = merged.boats.find((b) => b.sail === RO.sail)!.track;
      const app1 = coverage(tr.t, R7_GUN, R7_RO_FINISH).coverage;
      console.log(`[vkx golden] R7 coverage: seconds-with-fix ${(secs(feedT, g, R7_RO_FINISH) * 100).toFixed(1)}% → 100%; app measure ${(app0 * 100).toFixed(1)}% → ${(app1 * 100).toFixed(1)}%`);
      expect(app0).toBeLessThan(0.5);
      expect(app1).toBeGreaterThan(0.999);
      // The confirm dialog's figure with the race loaded (exact) and estimated from the check windows.
      const m = await matchRace(log(), c7, fixtureFetcher());
      expect(coverageGain(log(), m, app0)).toMatchObject({ before: app0, beforeExact: true });
      expect(coverageGain(log(), m).after).toBeGreaterThan(0.99);
    })();
  });

  it('makes R7 and R8 payloads of a few hundred kB that the server accepts', async () => {
    const bucket = new MemBucket();
    for (const c of coveredRaces(log().pos.t, raceWindowsFromDoc(doc, DIV, [ORPHAN_R8]))) {
      const p = await payloadFor(log(), c, { event: EVENT, div: DIV }, RO, { sha256: 'e'.repeat(64), bytes: log().bytes });
      console.log(`[vkx golden] ${c.race.label} payload: ${p.n} samples (${((c.toMs - c.fromMs) / 60_000).toFixed(0)} min) → ${(p.bytes.length / 1024).toFixed(0)} KiB gzipped`);
      expect(p.bytes.length).toBeLessThan(600_000);
      const res = await handleUpload(
        { request: new Request('https://recall.example/api/vkx/upload', { method: 'POST', body: p.bytes as BodyInit, headers: { 'content-type': 'application/octet-stream' } }), env: { VKX_BUCKET: bucket } },
        { fetch: mockUpstream(), limiter: null, cache: null },
      );
      expect(res.status).toBe(200);
    }
    expect(bucket.objects.size).toBe(2);
  });
});
