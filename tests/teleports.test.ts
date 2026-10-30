import { describe, expect, it } from 'vitest';
import {
  buildRaceData,
  dropFleetOutliers,
  dropReplayedFixes,
  dropTeleports,
  FLEET_OUTLIER_M,
  metresBetween,
  TELEPORT_KN,
  TELEPORT_MIN_M,
  TELEPORT_RUN_MS,
} from '../src/data/racesense/adapter';
import type { TelemetryPage } from '../src/data/racesense/types';
import { loadFixture } from './helpers';

type Fix = { ts: number; sn: number; sail: string; role: string; lat: number; lon: number; sog: number };
type LatLon = { lat: number; lon: number };

/** `p` moved `north` and `east` metres. */
const moved = (p: LatLon, north: number, east: number): LatLon => ({
  lat: p.lat + north / 111_320,
  lon: p.lon + east / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
});
const fix = (sn: number, ts: number, p: LatLon, sog = 7, role = 'competitor'): Fix => ({ ts, sn, sail: String(sn), role, lat: p.lat, lon: p.lon, sog });
const byTime = (rows: Fix[]): Fix[] => rows.sort((a, b) => a.ts - b.ts);

describe('dropTeleports: J/70 North Americans race 6, 898 out and back', () => {
  // 898's fixes as the feed sent them (ts, lat, lon, SOG): a held fix, 6 fixes ~16.5 km off, then back on its track.
  const HELD = { lat: 38.9580505, lon: -76.4326453 };
  const BAD = { lat: 39.0557421, lon: -76.288261 };
  const BACK = { lat: 38.95772, lon: -76.431571 };
  const real: Fix[] = [
    ...[1793387741900, 1793387743600, 1793387744400, 1793387748900].map((ts) => fix(898, ts, HELD, 7.39)),
    ...[1793387750800, 1793387753500, 1793387755100, 1793387755600, 1793387756300, 1793387757100].map((ts) => fix(898, ts, BAD, 7.39)),
    fix(898, 1793387760800, BACK, 7.4),
    ...[
      [1793387762300, 6.4],
      [1793387763500, 6.4],
      [1793387764200, 5.8],
      [1793387765000, 5.6],
    ].map(([ts, sog]) => fix(898, ts, BACK, sog)),
  ];
  const bad = new Set(real.filter((r) => r.lat === BAD.lat));
  // The boat's path through HELD (at the first fix) and BACK (at its first fix there), before and after.
  const [t0, t1] = [1793387741900, 1793387760800];
  const at = (ts: number): LatLon => {
    const k = (ts - t0) / (t1 - t0);
    return { lat: HELD.lat + k * (BACK.lat - HELD.lat), lon: HELD.lon + k * (BACK.lon - HELD.lon) };
  };
  const rows = (): Fix[] => {
    const out = [...real];
    for (let ts = t0 - 150_000; ts < t0 - 36_500; ts += 2000) out.push(fix(898, ts, at(ts)));
    for (let ts = 1793387766000; ts < 1793387826000; ts += 1000) out.push(fix(898, ts, at(ts)));
    // Five more boats sailing alongside, and a coach boat that makes the same jump (other roles are kept as sent).
    for (let ts = t0 - 150_000; ts < 1793387826000; ts += 1000) {
      for (let k = 1; k <= 5; k++) out.push(fix(100 + k, ts, moved(at(ts), 120 * k, 0)));
      const coach = ts >= 1793387750000 && ts < 1793387757000 ? BAD : moved(at(ts), -300, 0);
      out.push(fix(9, ts, coach, 7, 'coach'));
    }
    return byTime(out);
  };

  it('the fleet and replay filters keep the 6 off fixes: within the fleet distance, and held, not replayed', () => {
    const kept = dropFleetOutliers(dropReplayedFixes(rows()));
    expect(kept.filter((r) => bad.has(r))).toHaveLength(6);
    expect(metresBetween(HELD, BAD)).toBeLessThan(FLEET_OUTLIER_M);
  });

  it('drops the 6 off fixes and keeps every other row, in order', () => {
    const all = dropFleetOutliers(dropReplayedFixes(rows()));
    const kept = dropTeleports(all);
    expect(kept).toEqual(all.filter((r) => !bad.has(r)));
    for (const r of real) if (!bad.has(r)) expect(kept).toContain(r);
    expect(kept.filter((r) => r.role === 'coach')).toEqual(all.filter((r) => r.role === 'coach'));
  });

  it("no fix of 898's is left over 2 km from the course", () => {
    const own = dropTeleports(dropFleetOutliers(dropReplayedFixes(rows()))).filter((r) => r.sn === 898);
    expect(own.length).toBe(rows().filter((r) => r.sn === 898).length - 6);
    for (const r of own) expect(metresBetween(r, HELD)).toBeLessThan(2000);
  });

  it('buildRaceData: the same excursion on a Benelux J/70 track is left out of it', () => {
    const f = loadFixture();
    const page = f.telemetry;
    const col = (n: string): number => page.Fields!.indexOf(n);
    const [ts, sail, lat, lon] = [col('ts'), col('sail_number'), col('latitude'), col('longitude')];
    const own = page.Rows!.filter((r) => r[sail] === '1').sort((a, b) => Number(a[ts]) - Number(b[ts]));
    const i = own.length >> 1;
    const [a, b] = [Number(own[i][ts]), Number(own[i + 1][ts])];
    const off = { lat: Number(own[i][lat]) + (BAD.lat - HELD.lat), lon: Number(own[i][lon]) + (BAD.lon - HELD.lon) };
    const out = [1, 2, 3, 4, 5, 6].map((k) => {
      const r = [...own[i]];
      r[ts] = a + Math.round((k * (b - a)) / 8);
      r[lat] = off.lat;
      r[lon] = off.lon;
      return r;
    });
    const build = (p: TelemetryPage) => buildRaceData(f.regatta, { division: 'J70', raceNumber: 8 }, [p], { eventId: f.eventId, kind: 'fixture', wind: f.wind });
    const clean = build(page).boats.find((x) => x.sail === '1')!.track;
    const track = build({ ...page, Rows: [...page.Rows!, ...out] }).boats.find((x) => x.sail === '1')!.track;
    expect(Array.from(track.t)).toEqual(Array.from(clean.t));
    for (let k = 0; k < track.t.length; k++) expect(metresBetween({ lat: track.lat[k], lon: track.lon[k] }, off)).toBeGreaterThan(10_000);
  });
});

describe('dropTeleports: track ends', () => {
  const T0 = 1_800_000_000_000;
  const HOME = { lat: 38.7, lon: -9.42 };
  /** One boat sailing east at ~7 kn (3.6 m/s), a fix every second for `secs`, from `t`. */
  const sail = (sn: number, t: number, secs: number, from = HOME): Fix[] =>
    Array.from({ length: secs }, (_, s) => fix(sn, t + s * 1000, moved(from, 0, 3.6 * s)));

  it('a leading stale run (DEN 1185: 4 fixes 3.3 km off, then a 0.3 s jump) is dropped', () => {
    const stale = [0, 100, 200, 300].map((dt) => fix(1185, T0 + dt, moved(HOME, 3286, 0), 0.2));
    const live = sail(1185, T0 + 600, 300);
    const kept = dropTeleports([...stale, ...live]);
    expect(kept).toEqual(live);
  });

  it('a trailing stale fix after an impossible step is dropped, alone or repeated', () => {
    const live = sail(1685, T0, 300);
    const last = live[live.length - 1];
    const one = [fix(1685, last.ts + 400, moved(last, 2000, 0))];
    expect(dropTeleports([...live, ...one])).toEqual(live);
    const held = [400, 1400, 2400].map((dt) => fix(1685, last.ts + dt, moved(last, 2000, 0)));
    expect(dropTeleports([...live, ...held])).toEqual(live);
  });

  it('a trailing moving run after a hold and a jump is a catch-up and kept (GER 21: 1,258 m in 0.3 s, then 116 s at 8–11 kn)', () => {
    const live = sail(21, T0, 300);
    const last = live[live.length - 1];
    const held = Array.from({ length: 60 }, (_, s) => fix(21, last.ts + (s + 1) * 1000, last, 9));
    const jumpedTo = moved(last, 0, 1258);
    const tail = sail(21, held[held.length - 1].ts + 300, 116, jumpedTo).map((r) => ({ ...r, sog: 9.5 }));
    const rows = [...live, ...held, ...tail];
    expect(dropTeleports(rows)).toBe(rows);
  });

  it('a leading moving run before a jump is kept', () => {
    const head = sail(7, T0, 30, moved(HOME, 3000, 0));
    const rows = [...head, ...sail(7,head[head.length - 1].ts + 300, 300)];
    expect(dropTeleports(rows)).toBe(rows);
  });

  it('a long run is no stale end: both sides kept', () => {
    const head = sail(1685, T0, TELEPORT_RUN_MS / 1000 + 10, moved(HOME, 5000, 0));
    const rows = [...head, ...sail(1685, head[head.length - 1].ts + 500, 400)];
    expect(dropTeleports(rows)).toBe(rows);
  });
});

describe('dropTeleports: kept as sent', () => {
  const T0 = 1_800_000_000_000;
  const HOME = { lat: 41.01, lon: -71.4 };

  it('a one-way catch-up after a hold (151: ~350 s at one position, then 912 m in 1.3 s) is kept', () => {
    const rows: Fix[] = [];
    let p = HOME;
    let t = T0;
    for (let s = 0; s < 180; s++, t += 1000) rows.push(fix(151, t, (p = moved(HOME, 0, 3.6 * s))));
    for (let s = 0; s < 350; s++, t += 1000) rows.push(fix(151, t, p, 6.5));
    const resumed = moved(p, 0, 912);
    t += 300;
    for (let s = 0; s < 180; s++, t += 1000) rows.push(fix(151, t, moved(resumed, 0, 3.6 * s)));
    expect(metresBetween(rows[529], rows[530]) / 1.3 / (1852 / 3600)).toBeGreaterThan(TELEPORT_KN);
    expect(dropTeleports(rows)).toBe(rows);
  });

  it('normal motion, repeated timestamps at one position, and small steps at no time are kept', () => {
    const rows: Fix[] = [];
    for (let s = 0; s < 300; s++) {
      const p = moved(HOME, 2 * s, 3 * s);
      rows.push(fix(40, T0 + s * 1000, p));
      if (s % 7 === 0) rows.push(fix(40, T0 + s * 1000, p));
      if (s % 11 === 0) rows.push(fix(40, T0 + s * 1000, moved(p, TELEPORT_MIN_M / 10, 0)));
    }
    expect(dropTeleports(rows)).toBe(rows);
    expect(dropTeleports([])).toEqual([]);
  });

  it('a far step at no time between two fixes counts as impossible', () => {
    const live = Array.from({ length: 200 }, (_, s) => fix(40, T0 + s * 1000, moved(HOME, 0, 3 * s)));
    // An off fix at the very time of the one before it, 1 km away, then back on the track a second later.
    const rows = [...live.slice(0, 101), fix(40, live[100].ts, moved(live[100], TELEPORT_MIN_M * 4, 0)), ...live.slice(101)];
    expect(dropTeleports(rows)).toEqual(live);
  });
});
