import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { START_SOG_WINDOWS, startSogSeries, type StartSogWindow } from '../src/analysis/startSog';
import type { RaceAnalysis } from '../src/analysis/types';
import { dropFleetOutliers, FLEET_OUTLIER_M, FLEET_OUTLIER_MIN_BOATS, metresBetween, parseTelemetry } from '../src/data/racesense/adapter';
import { startSogChart, startSogClips, startSogKey, startSogLayout } from '../src/ui/startSog';
import { c31r4Fixture, c31r4Race, c31Race, cascaisRace, fixtureRace, j105Race, type Fixture } from './helpers';

const f = c31r4Fixture();
const data = c31r4Race(f);
const a = analyzeRace(data);
const line = { lat: (data.startLine.left.lat + data.startLine.right.lat) / 2, lon: (data.startLine.left.lon + data.startLine.right.lon) / 2 };
const raw = parseTelemetry([f.telemetry]);
const far = (r: { lat: number; lon: number }): boolean => metresBetween(r, line) > FLEET_OUTLIER_M;

describe('dropFleetOutliers: C31 race 4', () => {
  it("drops GER 8's fixes ~233 km off the course and keeps the ones after it rejoins", () => {
    const ger8 = raw.filter((r) => r.role === 'competitor' && r.sail === 'GER 8');
    expect(ger8.filter(far).length).toBe(132);
    expect(Math.max(...ger8.filter(far).map((r) => metresBetween(r, line)))).toBeGreaterThan(230_000);
    const rejoined = ger8.filter((r) => !far(r));
    expect(rejoined.length).toBeGreaterThanOrEqual(10);
    expect(Math.min(...rejoined.map((r) => r.ts)) - data.gunMs).toBeGreaterThan(80_000);

    const b = data.boats.find((x) => x.sail === 'GER 8')!;
    expect([...b.track.t]).toEqual(rejoined.map((r) => r.ts));
    for (let i = 0; i < b.track.t.length; i++) expect(metresBetween({ lat: b.track.lat[i], lon: b.track.lon[i] }, line)).toBeLessThan(2_000);
  });

  it('every other row is untouched: same rows, same values, same order', () => {
    const kept = dropFleetOutliers(raw);
    expect(kept).toEqual(raw.filter((r) => !(r.role === 'competitor' && r.sail === 'GER 8' && far(r))));
    for (const b of data.boats.filter((x) => x.sail !== 'GER 8')) {
      const rows = raw.filter((r) => r.role === 'competitor' && r.sail === b.sail);
      expect(b.track.t.length).toBe(rows.length);
      expect([...b.track.lat]).toEqual(rows.map((r) => r.lat));
      expect([...b.track.lon]).toEqual(rows.map((r) => r.lon));
    }
  });

  it("GER 8's start is no data, not 27 kn 182 km from the line; the other boats' starts stand", () => {
    const g = a.boats.find((x) => x.id === 'GER 8')!;
    expect(g.start).toBeNull();
    const others = a.boats.filter((x) => x.id !== 'GER 8' && x.start);
    expect(others.length).toBeGreaterThanOrEqual(6);
    for (const o of others) {
      expect(o.start!.speedKn).toBeLessThan(12);
      expect(Math.abs(o.start!.dtlM ?? 0)).toBeLessThan(1_000);
    }
  });

  it('drops nothing in the other fixtures (whole fleets, coaches and spares included)', () => {
    for (const file of ['benelux_r8', 'c31_r10', 'm24_r4', 'j88_r5', 'ic37_r5', 'j105_r3', 'cascais_r2', 'gate_m24r5', 'fallbrawl_j105_r3']) {
      const rows = parseTelemetry([(JSON.parse(readFileSync(new URL(`./fixtures/${file}.json`, import.meta.url), 'utf8')) as Fixture).telemetry]);
      expect(dropFleetOutliers(rows), file).toBe(rows);
    }
  });
});

describe('dropFleetOutliers: synthetic fleets', () => {
  const T0 = 1_800_000_000_000;
  const HOME = { lat: 43.26, lon: 6.74 };
  const AWAY = { lat: 43.757, lon: 9.559 };
  /** `n` competitors every second for 2 min, those in `away` at AWAY, plus a mark and a coach boat at AWAY. */
  const fleet = (n: number, away: number[], extra = true) => {
    const rows: { ts: number; sn: number; sail: string; role: string; lat: number; lon: number }[] = [];
    for (let s = 0; s < 120; s++) {
      for (let k = 0; k < n; k++) {
        const p = away.includes(k) ? AWAY : HOME;
        rows.push({ ts: T0 + s * 1000, sn: 100 + k, sail: `B${k}`, role: 'competitor', lat: p.lat + k * 1e-4, lon: p.lon + s * 1e-5 });
      }
      if (extra) {
        rows.push({ ts: T0 + s * 1000, sn: 1, sail: '', role: 'mark', ...AWAY });
        rows.push({ ts: T0 + s * 1000, sn: 2, sail: 'COACH', role: 'coach', ...AWAY });
      }
    }
    return rows;
  };

  it('one boat or three: no fleet to measure against, nothing dropped', () => {
    for (const rows of [fleet(1, [0]), fleet(3, [2]), fleet(FLEET_OUTLIER_MIN_BOATS - 1, [0])]) expect(dropFleetOutliers(rows)).toBe(rows);
  });

  it('a fleet of six drops the far boat only; marks and other roles stay', () => {
    const rows = fleet(6, [3]);
    const kept = dropFleetOutliers(rows);
    expect(kept).toEqual(rows.filter((r) => !(r.role === 'competitor' && r.sail === 'B3')));
    expect(kept.filter((r) => r.role !== 'competitor')).toHaveLength(240);
  });

  it('no majority near the median (a fleet split in two): nothing dropped', () => {
    const rows = fleet(6, [0, 1, 2]);
    expect(dropFleetOutliers(rows)).toBe(rows);
  });

  it('a bucket with too few boats keeps its fixes', () => {
    // Boats 1–5 report only in the first minute; in the second, B0 (away) is alone and kept.
    const rows = fleet(6, [0], false).filter((r) => r.sail === 'B0' || r.ts < T0 + 60_000);
    const kept = dropFleetOutliers(rows);
    const b0 = kept.filter((r) => r.sail === 'B0');
    expect(b0.length).toBe(60);
    expect(Math.min(...b0.map((r) => r.ts))).toBe(T0 + 60_000);
  });
});

describe('start speed axis', () => {
  const speeds = (x: RaceAnalysis, w: 30 | 60 | 120): number[] =>
    startSogSeries(x, w)
      .boats.flatMap((b) => b.runs.flatMap((r) => r.sog))
      .sort((p, q) => p - q);
  /** The key's "off scale" chip, if any. */
  const offScale = (x: RaceAnalysis, w: StartSogWindow) => startSogKey(startSogSeries(x, w), w).chips.find((c) => c.text.includes('off scale'));
  /** A copy with boat `id`'s start speeds replaced by `fn(i, n)`. */
  const withSog = (x: RaceAnalysis, id: string, fn: (i: number, n: number) => number): RaceAnalysis => ({
    ...x,
    drawings: x.drawings.map((d) => (d.id === id ? { ...d, startSog: { t: d.startSog.t, sog: Float32Array.from(d.startSog.sog, (_, i) => fn(i, d.startSog.sog.length)) } } : d)),
  });

  it('one boat at 30–40 kn: the top is the rest of the fleet’s fastest speed; that boat is clipped with a caret and keyed', () => {
    const id = a.boats.find((b) => b.id !== 'GER 8')!.id;
    const bad = withSog(a, id, (i, n) => 30 + (10 * i) / n);
    const rest = { ...a, drawings: a.drawings.filter((d) => d.id !== id) };
    for (const w of START_SOG_WINDOWS) {
      const s = startSogSeries(bad, w);
      expect(s.hi).toBe(speeds(rest, w).at(-1));
      expect(s.hi!).toBeLessThan(12);
      const L = startSogLayout(s);
      expect(L.hi).toBeLessThanOrEqual(12);
      expect(L.y(35)).toBe(L.padT);
      expect(L.y(-3)).toBe(L.y(L.lo));
      const b = s.boats.find((x) => x.id === id)!;
      expect(startSogClips(b, L).length).toBeGreaterThan(0);
      for (const o of s.boats.filter((x) => x.id !== id)) expect(startSogClips(o, L)).toEqual([]);
      expect(offScale(bad, w)).toEqual({ text: '▲ off scale', title: 'Speed above the top of the chart (a tracker glitch)' });
      const g =new RegExp(`<g class="ss-boat" data-id="${id}">.*?</g>`).exec(startSogChart(bad, null, w, {}, s))![0];
      expect(g).toContain('class="ss-clip-mark"');
      // The line itself stays inside the plot.
      for (const m of g.matchAll(/class="ss-line" d="([^"]+)"/g)) for (const [, y] of m[1].matchAll(/[ML][\d.]+ ([\d.]+)/g)) expect(Number(y)).toBeGreaterThanOrEqual(L.padT);
    }
  });

  it("with GER 8's bad fixes left in (fix 2 alone), the axis reads 0–9 kn as without them; GER 8 is clipped and keyed", () => {
    // Under FLEET_OUTLIER_MIN_BOATS boats nothing is dropped: GER 8's start speeds as the feed had them.
    const sails = ['GER 8', 'TUR3150', 'ITA3176'];
    const F = f.telemetry.Fields!;
    const few = { ...f, telemetry: { Fields: F, Rows: f.telemetry.Rows!.filter((r) => r[F.indexOf('role')] !== 'competitor' || sails.includes(String(r[F.indexOf('sail_number')]))) } };
    const rawGer8 = analyzeRace(c31r4Race(few)).drawings.find((d) => d.id === 'GER 8')!;
    expect(Math.max(...rawGer8.startSog.sog)).toBeGreaterThan(30);
    const bad = { ...a, drawings: a.drawings.map((d) => (d.id === 'GER 8' ? { ...d, startSog: rawGer8.startSog } : d)) };
    for (const w of [30, 60] as const) {
      const s = startSogSeries(bad, w);
      const L = startSogLayout(s);
      const clean = startSogLayout(startSogSeries(a, w));
      // The whole fleet's axis is 0–9 kn; these 8 boats' slowest is just over 2 kn.
      expect([L.lo, L.hi]).toEqual([clean.lo, 9]);
      expect(clean.hi).toBe(9);
      expect(startSogClips(s.boats.find((b) => b.id === 'GER 8')!, L).length).toBeGreaterThan(0);
      for (const o of s.boats.filter((b) => b.id !== 'GER 8')) expect(startSogClips(o, L)).toEqual([]);
      expect(startSogChart(bad, null, w)).toContain('class="ss-clip-mark"');
      expect(offScale(bad, w)?.text).toBe('▲ off scale');
      expect(offScale(a, w)).toBeUndefined();
    }
  });

  it('without outliers the top is the fastest speed: nothing clipped, no caret, no "off scale"', () => {
    const races: [string, RaceAnalysis][] = [
      ['cascais r2', analyzeRace(cascaisRace('r2'))],
      ['j105 r2', analyzeRace(j105Race(2))],
      ['c31 r10', analyzeRace(c31Race())],
      ['c31 r4', a],
      ['benelux r8', analyzeRace(fixtureRace())],
    ];
    for (const [name, x] of races) {
      for (const w of START_SOG_WINDOWS) {
        const s = startSogSeries(x, w);
        expect(s.hi, `${name} ${w} s`).toBe(speeds(x, w).at(-1));
        const L = startSogLayout(s);
        for (const b of s.boats) expect(startSogClips(b, L), `${name} ${w} s ${b.id}`).toEqual([]);
        expect(startSogChart(x, null, w)).not.toContain('ss-clip-mark');
        expect(offScale(x, w), `${name} ${w} s`).toBeUndefined();
      }
    }
  });

  it('Cascais race 2: the 120 s axis reaches the fleet’s 9.1 kn (10 kn on the grid)', () => {
    const s = startSogSeries(analyzeRace(cascaisRace('r2')), 120);
    expect(s.hi!).toBeGreaterThan(9);
    expect(startSogLayout(s).hi).toBe(10);
  });
});
