import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FINISH_TAIL_MS, analyzeRace, unfinishedDrawEnd } from '../src/analysis/analyze';
import { FINISH_MAX_SPEED_X, FINISH_MIN_REACH_FRAC, buildRaceData, trackExplainsSpeed } from '../src/data/racesense/adapter';
import type { Finish } from '../src/data/racesense/types';
import type { RaceData } from '../src/data/types';
import type { Fixture } from './helpers';

/**
 * C31 Gold Cup race 2 (tests/fixtures/c31_r2_finish.json): GER 80 crossed the finish line ~8 m inside its end
 * at 11:48:49 UTC, but its device summary says 30.4 kt against the fleet's 14.2 kt; its own track tops out at 14.2 kt.
 */
const load = (): Fixture => JSON.parse(readFileSync(new URL('./fixtures/c31_r2_finish.json', import.meta.url), 'utf8')) as Fixture;
const race2 = (f: Fixture) => f.regatta.revisions.at(-1)!.doc.divisions[0].races[0];
type Cell = string | number | null;
const page = (f: Fixture) => f.telemetry as { Fields: string[]; Rows: Cell[][] };
const finishOf =(f: Fixture, sail: string): Finish => race2(f).finishes.find((x) => x.sailNumber === sail)!;
function build(edit?: (f: Fixture) => void): RaceData {
  const f = load();
  edit?.(f);
  return buildRaceData(f.regatta, { division: 'C31', raceNumber: 2 }, [f.telemetry], { eventId: f.eventId, kind: 'fixture' });
}
const GER80_FINISH = Date.parse(finishOf(load(), 'GER 80').finishingTime);
const iso = (t: number | null | undefined): string | null => (t == null ? null : new Date(t).toISOString().slice(11, 19));
const data0 = build();
const lastDrawn =(a: ReturnType<typeof analyzeRace>, id: string): number => a.drawings.find((d) => d.id === id)!.segments.at(-1)!.t.at(-1)!;

describe('a clean finish with a bad device max speed', () => {
  it('accepts GER 80 at 11:48:49 UTC, between ITA 18249 and GER 66', () => {
    const data = build();
    const b = data.boats.find((x) => x.sail === 'GER 80')!;
    expect(finishOf(load(), 'GER 80').maxSpeed).toBeGreaterThan(30);
    expect(b.entry).toMatchObject({ finishPlausible: true });
    expect(b.entry!.finishNote).toBeUndefined();
    const a = analyzeRace(data);
    expect(a.notes.some((n) => n.kind === 'finish-unranked')).toBe(false);
    const r = a.boats.find((x) => x.sail === 'GER 80')!;
    expect(iso(r.finishMs)).toBe(iso(GER80_FINISH));
    expect(r.raceTimeS).toBeCloseTo(2628.8, 0);
    expect(r.legs.at(-1)).not.toBeNull();
    const pos = (s: string) => a.boats.find((x) => x.sail === s)!.finishPos!;
    expect(pos('GER 80')).toBe(pos('ITA 18249') + 1);
    expect(pos('GER 66')).toBe(pos('GER 80') + 1);
    // An accepted finish is drawn to the finish itself, as before.
    expect(lastDrawn(a, 'GER 80')).toBeLessThanOrEqual(GER80_FINISH);
  });

  it('still rejects a track as fast as the device says (a media RIB)', () => {
    const data = build((f) => {
      const T = page(f);
      const [sail, sog] = [T.Fields.indexOf('sail_number'), T.Fields.indexOf('sog')];
      for (const row of T.Rows) if (row[sail] === 'GER 80') row[sog] = Number(row[sog]) * 2;
    });
    const b = data.boats.find((x) => x.sail === 'GER 80')!;
    expect(b.entry).toMatchObject({ finishPlausible: false, finishNote: "the feed has a max speed of 30 kt against the fleet's 14 kt" });
    expect(analyzeRace(data).boats.find((x) => x.sail === 'GER 80')!.finishPos).toBeNull();
  });

  it('still rejects a tracker that sat on the line all race, jittering across it (a spare on the committee boat)', () => {
    const SPARE = 'SPARE 9';
    const data = build((f) => {
      const T = page(f);
      const ix = Object.fromEntries(T.Fields.map((n, i) => [n, i]));
      const div = f.regatta.revisions.at(-1)!.doc.divisions[0];
      const r = race2(f);
      const ger = finishOf(f, 'GER 80');
      // A full-length device distance, the fast max, and a finish when the fleet's.
      r.finishes.push({ ...ger, sailNumber: SPARE, serialNumber: '0000FFFE', distanceTraveled: 11_300 } as Finish);
      div.participants.push({ sailNumber: SPARE, bowOffsetCm: 0 } as (typeof div.participants)[number]);
      // Its fixes: ±10 m either side of the finish line's middle every 5 s, from the gun to the end.
      const gun = r.starts[0].startTime!;
      const line = data0.finishLine!;
      const mid = { lat: (line.left.lat + line.right.lat) / 2, lon: (line.left.lon + line.right.lon) / 2 };
      const end = Math.max(...T.Rows.map((x) => Number(x[ix.ts])));
      for (let t = gun - 30_000, k = 0; t <= end; t += 5_000, k++) {
        const row: unknown[] = T.Fields.map(() => null);
        Object.assign(row, { [ix.ts]: t, [ix.sn]: 0xfffe, [ix.sail_number]: SPARE, [ix.role]: 'competitor', [ix.latitude]: mid.lat + (k % 2 ? 9e-5 : -9e-5), [ix.longitude]: mid.lon, [ix.sog]: 1, [ix.heading]: 0 });
        T.Rows.push(row as Cell[]);
      }
      T.Rows.sort((p, q) => Number(p[ix.ts]) - Number(q[ix.ts]));
    });
    const s = data.boats.find((x) => x.sail === SPARE)!;
    expect(s.entry).toMatchObject({ finishPlausible: false });
    expect(s.entry!.finishNote).toMatch(/max speed of 30 kt/);
    // GER 80 is unaffected.
    expect(data.boats.find((x) => x.sail === 'GER 80')!.entry).toMatchObject({ finishPlausible: true });
  });

  it('trackExplainsSpeed needs a crossing, a top speed within FINISH_MAX_SPEED_X and FINISH_MIN_REACH_FRAC of the reach', () => {
    const ok = { topKn: 14.2, crossesLine: true, reachM: 2_000 };
    expect(trackExplainsSpeed(ok, 14.2, 2_100)).toBe(true);
    expect(trackExplainsSpeed({ ...ok, crossesLine: false }, 14.2, 2_100)).toBe(false);
    expect(trackExplainsSpeed({ ...ok, topKn: FINISH_MAX_SPEED_X * 14.2 + 0.1 }, 14.2, 2_100)).toBe(false);
    expect(trackExplainsSpeed({ ...ok, reachM: FINISH_MIN_REACH_FRAC * 2_100 - 1 }, 14.2, 2_100)).toBe(false);
    expect(trackExplainsSpeed({ ...ok, topKn: null }, 14.2, 2_100)).toBe(false);
    expect(trackExplainsSpeed(ok, null, 2_100)).toBe(false);
  });
});

describe('drawing the last leg of a boat with no accepted finish', () => {
  // GER 80's finish reported 5 min early: its track doesn't cross then, so the fast device max stands and the
  // finish isn't accepted. Its track runs ~90 s past the line.
  const rejected = (): RaceData =>
    build((f) => {
      finishOf(f, 'GER 80').finishingTime = new Date(GER80_FINISH - 5 * 60_000).toISOString();
    });

  it(`stops FINISH_TAIL_MS (${FINISH_TAIL_MS / 1000} s) past its own crossing of the finish line`, () => {
    const data = rejected();
    const b = data.boats.find((x) => x.sail === 'GER 80')!;
    expect(b.entry!.finishPlausible).toBe(false);
    const a = analyzeRace(data);
    const r = a.boats.find((x) => x.sail === 'GER 80')!;
    expect(r.finishMs).toBeNull();
    expect(r.finishPos).toBeNull();
    const seg = a.drawings.find((d) => d.id === b.id)!.segments.at(-1)!;
    expect(seg.leg).toBe(a.legs.length - 1);
    const end = seg.t.at(-1)!;
    const trackEnd = b.track.t.at(-1)!;
    expect(trackEnd - GER80_FINISH).toBeGreaterThan(60_000);
    // Its own crossing is the device's finish to within a few seconds; the drawn track stops at its last fix by then.
    expect(Math.abs(b.lineCrossMs! - GER80_FINISH)).toBeLessThan(3_000);
    const cut = unfinishedDrawEnd(b, seg.t[0]);
    expect(cut).toBe(b.lineCrossMs! + FINISH_TAIL_MS);
    expect(end).toBeLessThanOrEqual(cut);
    expect(cut - end).toBeLessThan(1_500);
  });

  it('runs to the end of its data when it never crosses the line', () => {
    // Its data ends a minute short of the line.
    const data = build((f) => {
      finishOf(f, 'GER 80').finishingTime = new Date(GER80_FINISH - 5 * 60_000).toISOString();
      const T = page(f);
      const [ts, sail] = [T.Fields.indexOf('ts'), T.Fields.indexOf('sail_number')];
      T.Rows = T.Rows.filter((r) => r[sail] !== 'GER 80' || Number(r[ts]) < GER80_FINISH - 60_000);
    });
    const b = data.boats.find((x) => x.sail === 'GER 80')!;
    expect(b.lineCrossMs).toBeUndefined();
    const a = analyzeRace(data);
    expect(a.boats.find((x) => x.id === b.id)!.finishMs).toBeNull();
    expect(lastDrawn(a, b.id)).toBe(b.track.t.at(-1));
    expect(unfinishedDrawEnd(b, data.gunMs)).toBe(b.track.t.at(-1));
  });

  it('a crossing before the last leg starts is no finish: drawn to the end of its data', () => {
    const b = rejected().boats.find((x) => x.sail === 'GER 80')!;
    expect(unfinishedDrawEnd(b, b.lineCrossMs! + 1)).toBe(b.track.t.at(-1));
  });

  it('an accepted finish carries no crossing of its own', () => {
    expect(data0.boats.every((b) => b.lineCrossMs === undefined)).toBe(true);
  });

  it("leaves the other boats' drawings as they were", () => {
    const a = analyzeRace(rejected());
    const base = analyzeRace(build((f) => (finishOf(f, 'GER 80').maxSpeed = 14)));
    for (const s of ['FRA 3105', 'ITA 18249', 'GER 66']) {
      const id = a.boats.find((x) => x.sail === s)!.id;
      expect(lastDrawn(a, id)).toBe(lastDrawn(base, id));
    }
  });
});
