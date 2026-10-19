import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { HEEL_MAN_EXCLUDE_MS, heelAt, heelSeries, heelStats, leewardHeel } from '../src/analysis/heel';
import { buildRaceData, dropImuZeroRuns, imuAngle, IMU_ZERO_RUN_MS, parseTelemetry } from '../src/data/racesense/adapter';
import type { TelemetryPage } from '../src/data/racesense/types';
import { applyView } from '../src/ui/lastView';
import { heelCell, legsNotesHtml, legsTable, sortTable, startNotesHtml, startTable } from '../src/ui/table';
import { c31Race, fixtureRace, j88Race, loadFixture, m24Race } from './helpers';

const FIELDS = ['ts', 'sn', 'role', 'sail_number', 'latitude', 'longitude', 'heading', 'sog', 'roll', 'pitch'];

describe('adapter: roll and pitch', () => {
  it('parses roll and pitch, null when missing or at the ±90° clamp', () => {
    const page: TelemetryPage = {
      Fields: FIELDS,
      Rows: [
        [1000, 1, 'competitor', '7', 52.1, 5.1, 30, 6, -12, 3],
        [2000, 1, 'competitor', '7', 52.1, 5.1, 30, 6, null, 4],
        [3000, 1, 'competitor', '7', 52.1, 5.1, 30, 6, 95, -90],
      ],
    };
    const rows = parseTelemetry([page]);
    expect(rows.map((r) => [r.roll, r.pitch])).toEqual([
      [-12, 3],
      [null, 4],
      [null, null],
    ]);
    expect(imuAngle('7')).toBe(7);
    expect(imuAngle('')).toBeNull();
    expect(imuAngle(89)).toBe(89);
  });

  it('tolerates feeds without the columns (no roll on the track)', () => {
    const rows = parseTelemetry([{ Fields: FIELDS.slice(0, 8), Rows: [[1000, 1, 'competitor', '7', 52.1, 5.1, 30, 6]] }]);
    expect(rows[0]).toMatchObject({ roll: null, pitch: null });
    const d = noHeelRace();
    expect(d.boats.every((b) => b.track.roll === undefined && b.track.pitch === undefined)).toBe(true);
  });

  it('carries roll and pitch onto the fixture tracks', () => {
    const b = fixtureRace().boats[0];
    expect(b.track.roll).toBeInstanceOf(Float32Array);
    expect(b.track.roll!.length).toBe(b.track.t.length);
    expect([...b.track.roll!].filter(Number.isFinite).length).toBe(b.track.t.length);
  });

  it('drops long runs of exact 0/0 while moving (no IMU), keeps brief ones and stopped boats', () => {
    const run = (n: number, sog = 5) => Array.from({ length: n }, (_, i) => ({ ts: i * 1000, sog, roll: 0 as number | null, pitch: 0 as number | null }));
    const long = run(IMU_ZERO_RUN_MS / 1000 + 1);
    dropImuZeroRuns(long);
    expect(long.every((r) => r.roll === null && r.pitch === null)).toBe(true);
    const short = run(5);
    dropImuZeroRuns(short);
    expect(short.every((r) => r.roll === 0)).toBe(true);
    const stopped = run(30, 0.5);
    dropImuZeroRuns(stopped);
    expect(stopped.every((r) => r.roll === 0)).toBe(true);
  });
});

describe('leeward heel', () => {
  it('is + to leeward: starboard tack heeled to port (roll < 0), port tack heeled to starboard', () => {
    expect(leewardHeel(-15, 40)).toBe(15);
    expect(leewardHeel(15, -40)).toBe(15);
    expect(leewardHeel(5, 40)).toBe(-5); // to windward
    expect(leewardHeel(0, 40)).toBe(0);
  });

  it('has none where the side is unclear or a value is missing', () => {
    expect(leewardHeel(-15, 10)).toBeNaN();
    expect(leewardHeel(-15, 170)).toBeNaN();
    expect(leewardHeel(NaN, 40)).toBeNaN();
    expect(leewardHeel(-15, NaN)).toBeNaN();
  });
});

describe('heelStats (synthetic track, by hand)', () => {
  // Starboard tack throughout; a 7 s hole between 3 s and 10 s; no roll at 2 s.
  const t = [0, 1000, 2000, 3000, 10_000, 11_000];
  const roll = [-10, -20, NaN, -30, -12, -14];
  const pitch = [2, 2, 2, 2, 4, 4];
  const twa = t.map(() => 40);

  it('time-weights each fix until the next, never across a gap', () => {
    const s = heelStats(heelSeries(t, roll, twa, [], pitch), 0, 11_000);
    // 10° and 20° for 1 s each, 12° for 1 s; the 30° fix sits before the hole and counts for nothing.
    expect(s.heelDeg).toBeCloseTo((10 + 20 + 12) / 3, 9);
    expect(s.heelS).toBeCloseTo(3, 9);
    expect(s.trimDeg).toBeCloseTo((2 + 2 + 2 + 4) / 4, 9);
    expect(s.coverage).toBeCloseTo(3 / 11, 9);
  });

  it('clips to the leg', () => {
    const s = heelStats(heelSeries(t, roll, twa, [], pitch), 500, 10_500);
    expect(s.heelDeg).toBeCloseTo((10 * 0.5 + 20 * 1 + 12 * 0.5) / 2, 9);
    expect(s.coverage).toBeCloseTo(2 / 10, 9);
  });

  it(`leaves out fixes within ${HEEL_MAN_EXCLUDE_MS / 1000} s of a manoeuvre, but they still count as heel data`, () => {
    const s = heelStats(heelSeries(t, roll, twa, [{ tMs: 1500 }], pitch), 0, 11_000);
    expect(s.heelDeg).toBeCloseTo(12, 9);
    expect(s.trimDeg).toBeCloseTo(4, 9);
    expect(s.coverage).toBeCloseTo(3 / 11, 9);
  });

  it('is null with no roll', () => {
    expect(heelStats(heelSeries(t, t.map(() => NaN), twa, []), 0, 11_000)).toMatchObject({ heelDeg: null, trimDeg: null, coverage: 0 });
  });

  it('heel at the gun: the nearest fix with a heel within 2 s, else null', () => {
    const s = heelSeries(t, roll, twa, []);
    expect(heelAt(s, 1400)).toBe(20); // nearest is 1000
    expect(heelAt(s, 2100)).toBe(30); // 2000 has no roll; 3000 is within 2 s and nearer than 1000
    expect(heelAt(s, 6500)).toBeNull();
  });
});

describe('heel on the fixtures', () => {
  const races = { j70: analyzeRace(fixtureRace()), c31: analyzeRace(c31Race()), m24: analyzeRace(m24Race()), j88: analyzeRace(j88Race()) };

  it('most boats heel to leeward upwind (the sign convention holds on real tracks)', () => {
    for (const a of [races.j70, races.c31]) {
      expect(a.hasHeel).toBe(true);
      for (const leg of a.legs.filter((l) => l.kind === 'upwind')) {
        const hs = a.boats.map((b) => b.legs[leg.index]?.heelDeg).filter((h): h is number => h != null);
        expect(hs.filter((h) => h > 0).length).toBeGreaterThan(hs.length / 2);
      }
    }
  });

  it('J/70 upwind heel in a sane range and above its downwind heel', () => {
    for (const b of races.j70.boats) {
      expect(b.upwind!.heelDeg!).toBeGreaterThan(3);
      expect(b.upwind!.heelDeg!).toBeLessThan(25);
      expect(b.upwind!.heelDeg!).toBeGreaterThan(b.downwind!.heelDeg!);
    }
  });

  it('upwind heel pools the beats by heel time', () => {
    for (const b of races.m24.boats) {
      const ups = races.m24.legs.filter((l) => l.kind === 'upwind').map((l) => b.legs[l.index]).filter((l) => l?.heelDeg != null);
      if (!ups.length) continue;
      const W = ups.reduce((s, l) => s + l!.heelS, 0);
      expect(b.upwind!.heelDeg!).toBeCloseTo(ups.reduce((s, l) => s + l!.heelDeg! * l!.heelS, 0) / W, 9);
    }
  });

  it('heel coverage follows the fixes (the lossy C31 feed is flagged low)', () => {
    for (const b of races.j70.boats) for (const l of b.legs) expect(l!.heelCoverage!).toBeGreaterThan(0.95);
    const low = races.c31.boats.flatMap((b) => b.legs).filter((l) => l && l.heelCoverage! < 0.9);
    expect(low.length).toBeGreaterThan(0);
    expect(legsTable(races.c31, null)).toMatch(/class="heel dq-low"[^>]*>⚠ -?\d+\.\d°/);
  });

  it('heel at the gun for boats on a tack at the gun', () => {
    const at = races.j70.boats.map((b) => b.start?.heelAtGunDeg).filter((h): h is number => h != null);
    expect(at.length).toBeGreaterThanOrEqual(4);
    for (const h of at) expect(Math.abs(h)).toBeLessThan(45);
  });
});

describe('heel columns', () => {
  const a = analyzeRace(fixtureRace());

  it('a Heel column per leg and per summary, and Heel @gun on the start table, all sortable', () => {
    const legs = legsTable(a, null);
    for (const l of a.legs) expect(legs).toContain(`data-sort="L${l.index}.heel"`);
    expect(legs).toContain('data-sort="up.heel"');
    expect(legs).toContain('data-sort="dn.heel"');
    expect(startTable(a, null)).toContain('data-sort="s.heel"');
    expect(sortTable(a, 'up.heel')).toBe('legs');
    expect(sortTable(a, 's.heel')).toBe('start');
    expect(legs).toContain('average leeward heel, time-weighted; excludes manoeuvres');
    // Most heel first; null last.
    const sorted = legsTable(a, null, { key: 'up.heel', dir: 'desc' });
    const ids = [...sorted.matchAll(/<tr data-id="([^"]+)"/g)].map((m) => m[1]);
    const want = [...a.boats].sort((x, y) => y.upwind!.heelDeg! - x.upwind!.heelDeg!).map((b) => b.id);
    expect(ids).toEqual(want);
    expect(legsNotesHtml(a)).toContain('Heel: leeward heel');
  });

  it('formats heel with one decimal and flags low heel data', () => {
    expect(heelCell(15.27, 1, 'leg')).toBe('<span class="heel">15.3°</span>');
    expect(heelCell(-2, 0.5, 'leg')).toContain('class="heel dq-low"');
    expect(heelCell(-2, 0.5, 'leg')).toContain('⚠ -2.0°');
    expect(heelCell(null, 1, 'leg')).toBe('—');
  });

  it('hides every heel column when the feed has no roll, with a note; a saved heel sort is dropped', () => {
    const n = analyzeRace(noHeelRace());
    expect(n.hasHeel).toBe(false);
    const html = legsTable(n, null) + startTable(n, null);
    expect(html).not.toMatch(/\.heel"/);
    expect(html).not.toContain('Heel');
    expect(legsNotesHtml(n)).toContain('Heel: not in this feed');
    expect(startNotesHtml(n)).toContain('heel columns are hidden');
    expect(applyView(n, { leg: null, boat: null, sort: { key: 'up.heel', dir: 'desc' }, startSort: { key: 's.heel', dir: 'desc' } })).toMatchObject({ sort: null, startSort: null });
    expect(applyView(a, { leg: null, boat: null, sort: { key: 'up.heel', dir: 'desc' }, startSort: { key: 's.heel', dir: 'asc' } })).toMatchObject({
      sort: { key: 'up.heel', dir: 'desc' },
      startSort: { key: 's.heel', dir: 'asc' },
    });
  });
});

/** The Benelux fixture as an older feed would send it: no roll or pitch columns. */
function noHeelRace() {
  const f = loadFixture();
  const keep = f.telemetry.Fields!.map((k, i) => [k, i] as const).filter(([k]) => k !== 'roll' && k !== 'pitch');
  const page: TelemetryPage = { Fields: keep.map(([k]) => k), Rows: f.telemetry.Rows!.map((r) => keep.map(([, i]) => r[i])) };
  return buildRaceData(f.regatta, { division: 'J70', raceNumber: 8 }, [page], { eventId: f.eventId, kind: 'fixture', wind: f.wind });
}
