import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTelemetryQuery } from '../functions/_lib';
import { verifyAgainstFeed } from '../functions/_vkx';
import { telemetryIsFree, type FreeRaces } from '../src/data/freeRace';
import { feedDivision, fetchTelemetry } from '../src/data/racesense/api';
import type { PayloadTrack } from '../src/data/vkx/compact';

describe('feedDivision: the division as teleapi tags its rows', () => {
  it("spaces as '_', dots as '//'; other names unchanged", () => {
    expect(feedDivision('VX One')).toBe('VX_One');
    expect(feedDivision('Female 7.5')).toBe('Female_7//5');
    expect(feedDivision('Melges 24')).toBe('Melges_24');
    expect(feedDivision('E Scow C of C Regatta')).toBe('E_Scow_C_of_C_Regatta');
    expect(feedDivision('ILCA 4.7 Open 2.0')).toBe('ILCA_4//7_Open_2//0');
    for (const name of ['J70', 'J-24', 'M32', 'Open', 'Silver', 'ILCA_6']) expect(feedDivision(name)).toBe(name);
  });
});

describe('the proxy accepts the feed form and nothing more', () => {
  const q = (division: string) => buildTelemetryQuery(new URLSearchParams({ after: '1792237111000', before: '1792238500000', division }));

  it("accepts '_' and the '//' pair, and passes the name on as given", () => {
    for (const d of ['VX_One', 'Female_7//5', 'Melges_24', 'ILCA_4//7_Open_2//0', 'J70', 'VX One', 'J-24', 'X+1', feedDivision('A'.repeat(64))]) {
      const r = q(d);
      expect(r.ok, d).toBe(true);
      if (r.ok) expect(r.qs.get('division')).toBe(d);
    }
  });

  it("rejects a single '/', '../', query and escape characters, quotes and an overlong name", () => {
    for (const d of ['a/b', 'Female_7/5', '../x', 'x/../y', '///x', 'x///', 'a///b', '/x', '//x', 'x?y', 'x&y', 'x%2Fy', 'x%y', 'x"y', "x'y", 'x#y', 'x\\y', 'x<y', 'A'.repeat(81)]) {
      expect(q(d).ok, d).toBe(false);
    }
  });
});

describe('every telemetry query maps the division', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ Fields: ['ts'], Rows: [] }), { status: 200 }))));
  afterEach(() => vi.unstubAllGlobals());

  it('fetchTelemetry asks for the feed tag (the worker, vkx and recovery fetches all go through it)', async () => {
    await fetchTelemetry('feedDivTest1', 'Female 7.5', 1_792_237_111_000, 1_792_238_500_000);
    await fetchTelemetry('feedDivTest2', 'J70', 1_792_237_111_000, 1_792_238_500_000);
    await fetchTelemetry('feedDivTest3', null, 1_792_237_111_000, 1_792_238_500_000);
    const urls = vi.mocked(fetch).mock.calls.map((c) => new URL(String(c[0]), 'https://x.test'));
    expect(urls.map((u) => u.searchParams.get('division'))).toEqual(['Female_7//5', 'J70', null]);
    expect(urls.every((u) => buildTelemetryQuery(u.searchParams).ok)).toBe(true);
  });

  it("the upload's feed check asks for the feed tag", async () => {
    const calls: string[] = [];
    const doFetch = (async (u: string) => {
      calls.push(u);
      return new Response(JSON.stringify({ Fields: ['ts', 'sn'], Rows: [] }));
    }) as unknown as typeof fetch;
    const track = { header: { event: 'oRkxbTpSZPbSkrmKrbj2', div: 'VX One', sn: 1, sail: '1', t0: 1_792_237_111_000, t1: 1_792_237_141_000 } } as unknown as PayloadTrack;
    await verifyAgainstFeed(track, doFetch);
    expect(calls.length).toBeGreaterThan(0);
    for (const u of calls) expect(new URL(u).searchParams.get('division')).toBe('VX_One');
  });

  it("the paywall's free race 1 matches the feed tag to its division", () => {
    const w = { raceNumber: 1, gunMs: 1_000_000, after: 900_000, before: 2_000_000, tzOffsetMs: 0, names: ['Race 1'] };
    const free: FreeRaces = { divisions: ['VX One', 'Female 7.5', 'J70'], windows: [{ ...w, division: 'VX One' }, { ...w, division: 'Female 7.5' }, { ...w, division: 'J70', after: 5_000_000, before: 6_000_000 }] };
    expect(telemetryIsFree(free, 'VX_One', 900_000, 2_000_000)).toBe(true);
    expect(telemetryIsFree(free, 'VX One', 900_000, 2_000_000)).toBe(true);
    expect(telemetryIsFree(free, 'Female_7//5', 900_000, 2_000_000)).toBe(true);
    expect(telemetryIsFree(free, 'VX_One', 900_000, 2_000_001)).toBe(false);
    // An unknown name is every division's window: J70's race 1 is elsewhere.
    expect(telemetryIsFree(free, 'VX__One', 900_000, 2_000_000)).toBe(false);
  });
});
