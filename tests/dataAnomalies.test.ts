import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { projectTrack, raceProjection } from '../src/analysis/prepare';
import {
  buildRaceData,
  dropFleetOutliers,
  dropReplayedFixes,
  dropSogSpikes,
  liveTracker,
  metresBetween,
  parseTelemetry,
  REPLAY_MIN_SOG_KN,
  SOG_SPIKE_CEIL_KN,
  TRACKER_CELL_DEG,
} from '../src/data/racesense/adapter';
import type { RaceData } from '../src/data/types';
import type { Fixture } from './helpers';

const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture;
const race = (f: Fixture, division: string, raceNumber: number): RaceData => buildRaceData(f.regatta, { division, raceNumber }, [f.telemetry], { eventId: f.eventId, kind: 'fixture' });
const rowsOfFixture = (f: Fixture) => parseTelemetry([f.telemetry]);
type Row = ReturnType<typeof parseTelemetry>[number];

/** Path length and the jumps over 100 m between fixes under 5 s apart, of a track (from `t0` on). */
function pathOf(tr: { t: ArrayLike<number>; lat: ArrayLike<number>; lon: ArrayLike<number> }, t0 = -Infinity): { m: number; jumps: number } {
  let m = 0;
  let jumps = 0;
  for (let i = 1; i < tr.t.length; i++) {
    if (tr.t[i - 1] < t0) continue;
    const d = metresBetween({ lat: tr.lat[i - 1], lon: tr.lon[i - 1] }, { lat: tr.lat[i], lon: tr.lon[i] });
    m += d;
    if (d > 100 && tr.t[i] - tr.t[i - 1] < 5_000) jumps++;
  }
  return { m, jumps };
}

/** Each sail's trackers' rows (competitors). */
function trackersBySail(rows: Row[]): Map<string, Row[][]> {
  const m = new Map<string, Map<number, Row[]>>();
  for (const r of rows) {
    if (r.role !== 'competitor' || !r.sail) continue;
    let s = m.get(r.sail);
    if (!s) m.set(r.sail, (s = new Map()));
    let l = s.get(r.sn);
    if (!l) s.set(r.sn, (l = []));
    l.push(r);
  }
  return new Map([...m].map(([k, v]) => [k, [...v.values()]]));
}

describe('liveTracker: ILCA 6 Worlds Elimination Silver race 1, CZE 212985', () => {
  const f = fixture('anom_stuck');
  const raw = rowsOfFixture(f);
  const [a, b] = trackersBySail(raw).get('CZE 212985')!;
  const idle = a.length > b.length ? a : b;
  const sailing = idle === a ? b : a;
  const data = race(f, 'Silver', 1);
  const cze = data.boats.find((x) => x.sail === 'CZE 212985')!;

  it('the idle tracker has the most rows (the old pick) on a few cells; the other sails the race', () => {
    expect(idle.length).toBe(3457);
    expect(sailing.length).toBe(1776);
    const cells = (rs: Row[]) => new Set(rs.map((r) => `${Math.round(r.lat / TRACKER_CELL_DEG)},${Math.round(r.lon / TRACKER_CELL_DEG)}`)).size;
    expect(cells(idle)).toBeLessThan(10);
    expect(cells(sailing)).toBeGreaterThan(500);
    // Exact positions alone barely tell them apart: the idle one jitters.
    expect(new Set(idle.map((r) => `${r.lat},${r.lon}`)).size).toBeGreaterThan(1_500);
  });

  it("the boat's track is the sailing tracker's: ~7 km like the fleet's, not ~0.3 km ashore", () => {
    expect([...cze.track.t]).toEqual(sailing.map((r) => r.ts));
    const km = pathOf(cze.track).m / 1000;
    expect(km).toBeGreaterThan(6.5);
    for (const o of data.boats.filter((x) => x.sail !== 'CZE 212985')) expect(km / (pathOf(o.track).m / 1000)).toBeLessThan(1.2);
    expect(pathOf({ t: idle.map((r) => r.ts), lat: idle.map((r) => r.lat), lon: idle.map((r) => r.lon) }).m).toBeLessThan(500);
  });

  it('the idle tracker sat still: its 773 repeated positions are all kept (stationary repeats)', () => {
    expect(idle.length - new Set(idle.map((r) => `${r.lat},${r.lon}`)).size).toBe(773);
    expect(dropReplayedFixes(raw)).toBe(raw);
  });

  it('one tracker is taken as it is; ties go to the most rows, then the first', () => {
    const p = (lat: number, lon: number) => ({ lat, lon });
    const one = [p(1, 1)];
    expect(liveTracker([one])).toBe(one);
    expect(liveTracker([])).toBeUndefined();
    const x = [p(1, 1), p(1, 1.001)];
    const y = [p(2, 2), p(2, 2.001), p(2, 2.001)];
    expect(liveTracker([x, y])).toBe(y);
    const z = [p(3, 3), p(3, 3.001)];
    expect(liveTracker([x, z])).toBe(x);
    expect(liveTracker([z, x])).toBe(z);
    expect(liveTracker([y, [p(4, 4), p(4, 4.001), p(4, 4.002)]])![0].lat).toBe(4);
  });
});

describe('dropReplayedFixes: ILCA 6 Worlds Elimination Silver race 3, CHI 199268', () => {
  const f = fixture('anom_replay');
  const raw = rowsOfFixture(f);
  const data = race(f, 'Silver', 3);
  const gun = data.gunMs;
  const W0 = gun + 19 * 60_000;
  const chiRaw = raw.filter((r) => r.sail === 'CHI 199268');
  const chi = data.boats.find((x) => x.sail === 'CHI 199268')!;

  it('the feed zig-zags: one held fix ~1 km off, replayed among the live fixes', () => {
    const t = { t: chiRaw.map((r) => r.ts), lat: chiRaw.map((r) => r.lat), lon: chiRaw.map((r) => r.lon) };
    expect(pathOf(t, W0).jumps).toBeGreaterThan(400);
    expect(pathOf(t, W0).m).toBeGreaterThan(400_000);
  });

  it('drops the 546 replays, keeps the live track (no jump, the fleet’s distance) and every other row', () => {
    const kept = new Set(dropReplayedFixes(raw));
    const gone = raw.filter((r) => !kept.has(r));
    expect(gone.length).toBe(546);
    expect(gone.every((r) => r.sail === 'CHI 199268' && r.sog > REPLAY_MIN_SOG_KN)).toBe(true);
    expect(chi.track.t.length).toBe(chiRaw.length - 546);
    const p = pathOf(chi.track, W0);
    expect(p.jumps).toBe(0);
    const fleet = data.boats.filter((x) => x.sail !== 'CHI 199268').map((x) => pathOf(x.track, W0).m);
    expect(p.m).toBeGreaterThan(0.8 * Math.min(...fleet));
    expect(p.m).toBeLessThan(1.3 * Math.max(...fleet));
    for (const o of data.boats.filter((x) => x.sail !== 'CHI 199268')) expect(o.track.t.length).toBe(raw.filter((r) => r.role === 'competitor' && r.sail === o.sail).length);
  });

  it('the replayed position is kept once, where it was first reported', () => {
    const k = (r: { lat: number; lon: number }) => `${r.lat},${r.lon}`;
    const counts = new Map<string, number>();
    for (const r of chiRaw) counts.set(k(r), (counts.get(k(r)) ?? 0) + 1);
    const [held, n] = [...counts].sort((x, y) => y[1] - x[1])[0];
    expect(n).toBeGreaterThan(500);
    const at = [...chi.track.t].filter((_, i) => k({ lat: chi.track.lat[i], lon: chi.track.lon[i] }) === held);
    expect(at).toEqual([chiRaw.find((r) => k(r) === held)!.ts]);
    expect(at[0]).toBeLessThan(W0);
  });
});

describe('dropReplayedFixes: rules', () => {
  const T0 = 1_800_000_000_000;
  const row = (s: number, lat: number, sog: number, role = 'competitor', sn = 1) => ({ ts: T0 + s * 1000, sn, sail: 'B1', role, lat, lon: 6.74, sog });

  it('a replay while moving goes; a hold (the last kept fix again), a still boat and a missing SOG stay', () => {
    const rows = [row(0, 43.26, 5), row(1, 43.2601, 5), row(2, 43.26, 5), row(3, 43.2602, 5), row(4, 43.2602, 5), row(5, 43.26, 0.8), row(6, 43.26, NaN), row(7, 43.2603, 5), row(8, 43.26, 5), row(9, 43.26, 5)];
    expect(dropReplayedFixes(rows).map((r) => r.ts - T0)).toEqual([0, 1000, 3000, 4000, 5000, 6000, 7000]);
  });

  it('per tracker: another tracker at the same spot is no replay; marks and other roles are never touched', () => {
    const rows = [row(0, 43.26, 5), row(1, 43.2601, 5, 'competitor', 2), row(2, 43.26, 5, 'competitor', 2), row(3, 43.27, 5, 'mark', 9), row(4, 43.28, 5, 'mark', 9), row(5, 43.27, 5, 'mark', 9), row(6, 43.27, 5, 'coach', 8), row(7, 43.29, 5, 'coach', 8), row(8, 43.27, 5, 'coach', 8)];
    expect(dropReplayedFixes(rows)).toBe(rows);
  });

  it('one boat alone is filtered the same (no fleet needed); no rows is no rows', () => {
    const rows = [row(0, 43.26, 5), row(1, 43.2601, 5), row(2, 43.26, 5)];
    expect(dropReplayedFixes(rows)).toHaveLength(2);
    expect(dropReplayedFixes([])).toEqual([]);
  });
});

describe('dropSogSpikes: M15 Gulf Coast race 1, boats 69 and 409', () => {
  const f = fixture('anom_spike');
  const raw = rowsOfFixture(f);
  const data = race(f, 'M15', 1);
  const spikes: Record<string, [number, number]> = { '69': [1_792_861_149_600, 6771.2], '409': [1_792_862_411_900, 1496.4] };

  it('each boat sent one reading of thousands of knots at a good position; only that reading goes', () => {
    for (const [sail, [ts, kn]] of Object.entries(spikes)) {
      const r = raw.find((x) => x.sail === sail && x.ts === ts)!;
      expect(r.sog).toBeCloseTo(kn, 0);
      const b = data.boats.find((x) => x.sail === sail)!;
      const i = [...b.track.t].indexOf(ts);
      expect(i).toBeGreaterThan(0);
      expect(b.track.lat[i]).toBe(r.lat);
      expect([...b.track.sog].filter((s) => !Number.isFinite(s))).toHaveLength(1);
      expect(Number.isNaN(b.track.sog[i])).toBe(true);
      // The analysis fills it from the positions, as any missing SOG: the boat's speed at the time.
      const xy = projectTrack(b.track, raceProjection(data));
      expect(xy.sog[i]).toBeGreaterThan(3);
      expect(xy.sog[i]).toBeLessThan(10);
    }
    for (const b of data.boats) {
      const feed = raw.filter((r) => r.role === 'competitor' && r.sail === b.sail && !(spikes[b.sail]?.[0] === r.ts));
      expect([...b.track.sog].filter(Number.isFinite)).toEqual(feed.map((r) => Math.fround(r.sog)));
    }
  });

  it("69's spike (51 s before the gun) no longer sets the start speed chart", () => {
    const a = analyzeRace(data);
    const d = a.drawings.find((x) => x.id === '69')!;
    expect(Math.max(...d.startSog.sog)).toBeLessThan(12);
  });

  it('a fast boat whose positions agree keeps its readings; a hold mid-reading, a lone fix and marks too', () => {
    const T0 = 1_800_000_000_000;
    // 30 kn = 15.4 m/s north, a fix a second; a 3-fix hold in the middle.
    const dLat = (30 * 0.514444) / 111_195;
    const lats = [0, 1, 2, 2, 2, 5, 6].map((k) => 43 + k * dLat);
    const fast = lats.map((lat, s) => ({ ts: T0 + s * 1000, sn: 1, role: 'competitor', lat, lon: 6.7, sog: 30 }));
    const lone = [{ ts: T0, sn: 2, role: 'competitor', lat: 44, lon: 6.7, sog: 900 }];
    const mark = [0, 1, 2].map((s) => ({ ts: T0 + s * 1000, sn: 3, role: 'mark', lat: 45, lon: 6.7, sog: s === 1 ? 900 : 0 }));
    const rows = [...fast, ...lone, ...mark].sort((x, y) => x.ts - y.ts);
    dropSogSpikes(rows);
    expect(rows.every((r) => Number.isFinite(r.sog))).toBe(true);
    // The same boat's single 900 kn reading while it sails at 30 kn goes.
    const spiked = fast.map((r, i) => ({ ...r, sog: i === 1 ? 900 : 30 }));
    dropSogSpikes(spiked);
    expect(spiked.map((r) => Number.isNaN(r.sog))).toEqual([false, true, false, false, false, false, false]);
  });
});

describe('dropSogSpikes: M32 Worlds race 17, the fleet at ~21 kn', () => {
  const f = fixture('anom_m32');
  const raw = rowsOfFixture(f);
  const data = race(f, 'M32', 17);

  it('keeps every real reading over the ceiling: nothing nulled, ~25 kn as the feed sent it', () => {
    const fast = raw.filter((r) => r.role === 'competitor' && r.sog > 20);
    expect(fast.length).toBeGreaterThan(400);
    expect(raw.filter((r) => r.role === 'competitor' && r.sog > SOG_SPIKE_CEIL_KN).length).toBeGreaterThan(0);
    expect(Math.max(...fast.map((r) => r.sog))).toBeGreaterThan(25);
    for (const b of data.boats) {
      expect([...b.track.sog]).toEqual(raw.filter((r) => r.role === 'competitor' && r.sail === b.sail).map((r) => Math.fround(r.sog)));
    }
    expect(data.boats).toHaveLength(6);
  });
});

describe('clean races come out identical', () => {
  // Whole fleets, coaches and spares included. Known: c31_r4's GER 8 (dropFleetOutliers' case, its held off-course
  // readings gone with it), the gate goldens' 1e-6° rounding making one J/111's two fixes 51 s apart coincide at 1.7 kn,
  // and USA 684's stuck tracker in Cascais races 2 and 3 (a "stuck tracker" finding).
  const CLEAN = [
    'benelux_r8', 'c31_r10', 'c31_r4', 'cascais_r2', 'j105_r1', 'j105_r2', 'j105_r3', 'j88_r5', 'm24_r4', 'ic37_r5',
    'fallbrawl_j70_r1', 'fallbrawl_j70_r3', 'fallbrawl_j105_r3', 'gate_j24r2', 'gate_j24r5', 'gate_j111r5', 'gate_ic37r2', 'gate_m24r5', 'gate_viperr2',
  ];
  const KNOWN_REPLAYS: Record<string, number> = { gate_j111r5: 1 };
  const KNOWN_TRACKER: Record<string, string[]> = { cascais_r2: ['USA 684'] };

  it('no replay dropped, no SOG nulled, the same tracker for every sail', () => {
    for (const file of CLEAN) {
      const raw = rowsOfFixture(fixture(file));
      const kept = dropReplayedFixes(raw);
      expect(raw.length - kept.length, file).toBe(KNOWN_REPLAYS[file] ?? 0);
      if (!KNOWN_REPLAYS[file]) expect(kept, file).toBe(raw);
      const rows = dropFleetOutliers(kept);
      const sog = rows.map((r) => r.sog);
      dropSogSpikes(rows);
      expect(rows.map((r) => r.sog), file).toEqual(sog);
      const changed = [...trackersBySail(rows)].filter(([, devs]) => liveTracker(devs) !== [...devs].sort((x, y) => y.length - x.length)[0]).map(([s]) => s);
      expect(changed, file).toEqual(KNOWN_TRACKER[file] ?? []);
    }
  }, 120_000);

  it('Cascais race 3 (17 replaying trackers, USA 684 stuck) is the known unclean one', () => {
    const raw = rowsOfFixture(fixture('cascais_r3'));
    const kept = new Set(dropReplayedFixes(raw));
    const gone = raw.filter((r) => !kept.has(r));
    expect(new Set(gone.map((r) => r.sail)).size).toBe(17);
    expect(gone.some((r) => r.sail === 'BRA641') && gone.some((r) => r.sail === 'ESP 1283')).toBe(true);
    const changed = [...trackersBySail(raw)].filter(([, devs]) => liveTracker(devs) !== [...devs].sort((x, y) => y.length - x.length)[0]).map(([s]) => s);
    expect(changed).toEqual(['USA 684']);
  }, 60_000);
});
