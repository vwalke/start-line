/**
 * A finish inside a hole in a boat's tracker (data/holeFinish.ts), on J/70 North Americans race 6
 * (tests/fixtures/j70nas_r6_finish.json): 314, 151 and 14 are officially placed (21st, 18th, 26th), but their trackers
 * skip the finish, RaceSense has no finish for them and the official times are set aside. Each is timed between the
 * boats placed either side and drawn through the line then. Also the estimator's edge cases, on a made-up approach.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { raceProjection } from '../src/analysis/prepare';
import { crossings, destination, metresFrom } from '../src/data/finishes';
import { holeFinish, HOLE_MAX_KN, lineFix, withLineFix, type HoleFinishInput, type HoleFix } from '../src/data/holeFinish';
import { buildRaceData, type OfficialRaceInput } from '../src/data/racesense/adapter';
import type { LatLon, Line, RaceData, Track } from '../src/data/types';
import { fillRuleOf, fillTrack } from '../src/ui/gapFill';
import type { Fixture } from './helpers';

type J70Fixture = Fixture & { official: OfficialRaceInput; nextGunMs: number | null };
const f = JSON.parse(readFileSync(new URL('./fixtures/j70nas_r6_finish.json', import.meta.url), 'utf8')) as J70Fixture;
const build = (official: OfficialRaceInput | null): RaceData =>
  buildRaceData(f.regatta, { division: 'J70', raceNumber: 6 }, [f.telemetry], { eventId: f.eventId, kind: 'fixture', official, nextGunMs: f.nextGunMs });
const data = build(f.official);
const plain = build(null);
const boat = (d: RaceData, sail: string) => d.boats.find((b) => b.sail === sail)!;
/** EDT wall clock, as the race was sailed. */
const edt = (hms: string): number => Date.parse(`2026-10-30T${hms}Z`) + 4 * 3_600_000;
/** The race's RaceSense finish records, by sail. */
const records = new Map(f.regatta.revisions[0].doc.divisions[0].races![0].finishes!.map((r) => [r.sailNumber, Date.parse(r.finishingTime)]));

/** Distance from `p` to the line segment, m. */
function offLine(p: LatLon, line: Line): number {
  const [bx, by] = metresFrom(line.right, line.left);
  const [px, py] = metresFrom(p, line.left);
  const s = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by)));
  return Math.hypot(px - s * bx, py - s * by);
}

describe('J/70 North Americans race 6: 314, 151 and 14 timed between the boats placed either side', () => {
  const cases: [string, string, string][] = [
    ['314', '209', '901'],
    ['151', '34', '404'],
    ['14', '1562', '40'],
  ];

  it.each(cases)('%s: an estimated finish between %s and %s', (sail, ahead, behind) => {
    const b = boat(data, sail);
    expect(b.finishSource).toBe('estimated');
    expect(b.finishMs!).toBeGreaterThan(boat(data, ahead).finishMs!);
    expect(b.finishMs!).toBeLessThan(boat(data, behind).finishMs!);
  });

  it('314 lands between 209 (15:23:52) and 901 (15:24:04); the race counts three estimated finishes', () => {
    expect(boat(data, '314').finishMs!).toBeGreaterThanOrEqual(edt('15:23:52'));
    expect(boat(data, '314').finishMs!).toBeLessThanOrEqual(edt('15:24:04'));
    expect(data.results).toMatchObject({ places: 'official', times: 'racesense', trackerFinishes: 0, estimatedFinishes: 3 });
  });

  it("151's frozen tracker catching up 911 m in 1 s across the line is no crossing", () => {
    const b = boat(data, '151');
    const fixes = Array.from(b.track.t, (ts, i) => ({ ts, lat: b.track.lat[i], lon: b.track.lon[i] }));
    expect(crossings(fixes, () => data.finishLine!, edt('15:24:50'), edt('15:25:10'))).toEqual([]);
    expect(b.lineCrossMs).toBeUndefined();
  });

  it('official places, codes and points stand; the other boats keep their RaceSense finishes', () => {
    const rows = new Map(f.official.rows.map((r) => [r.rsSail, r]));
    for (const b of data.boats) {
      const r = rows.get(b.sail)!;
      expect([b.officialPlace, b.officialCode, b.officialPoints]).toEqual([r.place, r.code, r.points]);
      if (b.finishSource !== 'estimated') expect([b.finishMs, b.finishSource]).toEqual([records.get(b.sail), 'racesense']);
    }
  });

  it('each track gets one fix on the finish line at its finish time, and the map draws it to there', () => {
    const a = analyzeRace(data);
    const proj = raceProjection(data);
    for (const [sail] of cases) {
      const b = boat(data, sail);
      expect(b.track.finishFixMs).toBe(b.finishMs);
      const i = b.track.t.indexOf(b.finishMs!);
      expect(i).toBeGreaterThan(0);
      expect(b.track.t.length).toBe(boat(plain, sail).track.t.length + 1);
      expect(offLine({ lat: b.track.lat[i], lon: b.track.lon[i] }, data.finishLine!)).toBeLessThan(3);
      // A believable speed to get there, no roll or pitch made up.
      expect(b.track.sog[i]).toBeGreaterThan(4);
      expect(b.track.sog[i]).toBeLessThan(9);
      // Drawn like a finisher: the last leg ends on the line at the finish, and the hole is filled smoothly into it.
      const d = a.drawings.find((x) => x.id === b.id)!;
      const seg = d.segments.at(-1)!;
      expect(seg.t.at(-1)).toBe(b.finishMs);
      const [x, y] = proj.toXY(b.track.lat[i], b.track.lon[i]);
      expect(Math.hypot(seg.x.at(-1)! - x, seg.y.at(-1)! - y)).toBeLessThan(0.01);
      const filled = fillTrack(seg, fillRuleOf(d), true);
      for (let k = 1; k < filled.t.length; k++) {
        if (filled.t[k] < b.finishMs! - 13 * 60_000) continue;
        const v = Math.hypot(filled.x[k] - filled.x[k - 1], filled.y[k] - filled.y[k - 1]) / ((filled.t[k] - filled.t[k - 1]) / 1000);
        expect(v).toBeLessThan(6);
      }
    }
  });

  it("the fix on the line isn't counted as measured: 314's race coverage still has its 9 min hole", () => {
    const r = analyzeRace(data).boats.find((x) => x.sail === '314')!;
    expect(r.finishPos).toBe(21);
    expect(r.maxGapS!).toBeGreaterThan(8 * 60);
  });

  it('boats that cross the line are as they were: same finish, same fixes', () => {
    for (const sail of ['49', '209']) {
      const [b, p] = [boat(data, sail), boat(plain, sail)];
      expect(b.finishMs).toBe(records.get(sail));
      expect(b.finishMs).toBe(p.finishMs);
      expect(b.track.finishFixMs).toBeUndefined();
      expect(Array.from(b.track.t)).toEqual(Array.from(p.track.t));
      expect(Array.from(b.track.lat)).toEqual(Array.from(p.track.lat));
    }
  });

  it('without official results nothing is estimated', () => {
    for (const sail of ['314', '151', '14']) {
      expect(boat(plain, sail).finishMs).toBeNull();
      expect(boat(plain, sail).track.finishFixMs).toBeUndefined();
    }
  });
});

// ---- the estimator on a made-up approach: a boat sailing due east at 6 kn toward a north–south line 1,000 m away.

const KN = 1852 / 3600;
const O: LatLon = { lat: 38.95, lon: -76.42 };
const LINE: Line = { left: destination(O, 0, 50), right: destination(O, 180, 50) };
const T0 = Date.UTC(2026, 9, 30, 19, 0, 0);
const GUN = T0 - 60 * 60_000;
/** Fixes every second for 2 min, ending `outM` west of the line at T0, at `kn`; then `after` (time, metres west of the line) if given. */
function approach(outM = 1000, kn = 6, after: [number, number][] = []): HoleFix[] {
  const fx: HoleFix[] = [];
  for (let s = -120; s <= 0; s++) fx.push({ ts: T0 + s * 1000, ...destination(O, 270, outM - s * kn * KN), sog: kn });
  for (const [ts, m] of after) fx.push({ ts, ...destination(O, 270, m), sog: kn });
  return fx;
}
/** The time a boat at 6 kn takes over `m`, ms. */
const at6 = (m: number): number => (1000 * m) / (6 * KN);
const input = (over: Partial<HoleFinishInput> = {}): HoleFinishInput => ({
  fixes: approach(),
  lineAt: () => LINE,
  gunMs: GUN,
  endMs: T0 + 30 * 60_000,
  from: T0 - 10 * 60_000,
  ahead: null,
  behind: null,
  ...over,
});

describe('holeFinish: the estimator', () => {
  it('no neighbors: the distance at its speed, on the line where its course meets it', () => {
    const e = holeFinish(input())!;
    expect(Math.abs(e.ms - (T0 + at6(1000)))).toBeLessThan(1000);
    expect(offLine(e.at, LINE)).toBeLessThan(0.5);
    expect(Math.hypot(...metresFrom(e.at, O))).toBeLessThan(1);
    expect(e.sogKn).toBeCloseTo(6, 1);
    expect(e.headingDeg).toBeCloseTo(90, 0);
  });

  it('both neighbors: kept between them', () => {
    const e = holeFinish(input({ ahead: T0 + at6(1000) + 20_000, behind: T0 + at6(1000) + 40_000 }))!;
    expect(e.ms).toBe(T0 + Math.round(at6(1000)) + 20_000);
  });

  it('one neighbor only: a one-sided bound', () => {
    const late = T0 + at6(1000) + 60_000;
    expect(holeFinish(input({ ahead: late }))!.ms).toBe(Math.round(late));
    expect(Math.abs(holeFinish(input({ ahead: T0 + 60_000 }))!.ms - (T0 + at6(1000)))).toBeLessThan(1000);
    const early = T0 + at6(1000) - 30_000;
    expect(holeFinish(input({ behind: early }))!.ms).toBe(Math.round(early));
  });

  it('a frozen tracker: timed from the first of the fixes held at one position', () => {
    const held = approach().map((x, _, all) => (x.ts > T0 - 20_000 ? { ...x, lat: all[all.length - 21].lat, lon: all[all.length - 21].lon } : x));
    const e = holeFinish(input({ fixes: held }))!;
    expect(Math.abs(e.ms - (T0 - 20_000 + at6(1000 + 20 * 6 * KN)))).toBeLessThan(1000);
  });

  it('no speed: halfway between the neighbors (both needed)', () => {
    const still = approach().map((x) => ({ ...x, sog: undefined }));
    // Two fixes only: no SOG and too short a stretch for its track's speed.
    const two = still.slice(-2);
    expect(holeFinish(input({ fixes: two, ahead: T0 + 200_000, behind: T0 + 240_000 }))!.ms).toBe(T0 + 220_000);
    expect(holeFinish(input({ fixes: two, ahead: T0 + 200_000 }))).toBeNull();
    // With a minute of fixes, its track's speed stands in for SOG.
    expect(Math.abs(holeFinish(input({ fixes: still }))!.ms - (T0 + at6(1000)))).toBeLessThan(2000);
  });

  it('an unbelievable speed to the line: no estimate', () => {
    // The boat behind finished a minute after the hole began: 1,000 m in a minute is 32 kn.
    expect(holeFinish(input({ behind: T0 + 60_000 }))).toBeNull();
    // Twice its speed is the most…
    expect(holeFinish(input({ behind: T0 + at6(1000) / 2.2 }))).toBeNull();
    expect(holeFinish(input({ behind: T0 + at6(1000) / 1.8 }))).not.toBeNull();
    // …and half the least (the boat ahead finished 20 min later).
    expect(holeFinish(input({ ahead: T0 + 20 * 60_000 }))).toBeNull();
  });

  it("a hole that doesn't span the finish: no estimate", () => {
    // The tracker is back 3 min later, 460 m out, and sails on for 2 min (to ~90 m) while the boats either side finish.
    const sailing: [number, number][] = Array.from({ length: 121 }, (_, s) => [T0 + 180_000 + s * 1000, 460 - s * 6 * KN]);
    const back = approach(1000, 6, sailing);
    expect(holeFinish(input({ fixes: back, ahead: T0 + 200_000, behind: T0 + 210_000 }))).toBeNull();
    // Without neighbors the estimate would fall after the hole ends: kept inside it, the speed doesn't fit.
    expect(holeFinish(input({ fixes: back.slice(0, 122), endMs: T0 + 180_000 }))).toBeNull();
    // A step under CROSS_MAX_GAP_MS is no hole: timed from the fix after it (where the track ends); nor is a hole before the last leg.
    const on: [number, number][] = Array.from({ length: 61 }, (_, s) => [T0 + 100_000 + s * 1000, 830 - s * 6 * KN]);
    const short = holeFinish(input({ fixes: approach(1000, 6, on) }))!;
    expect(Math.abs(short.ms - (T0 + 160_000 + at6(830 - 60 * 6 * KN)))).toBeLessThan(1000);
    expect(holeFinish(input({ from: T0 + 1000 }))).toBeNull();
  });

  it('the tracker back past the line: the speed from the line to it must fit too', () => {
    const past = (m: number, s: number) => approach(1000, 6, [[T0 + at6(1000) + s * 1000, -m]]);
    expect(holeFinish(input({ fixes: past(300, 120) }))).not.toBeNull();
    expect(holeFinish(input({ fixes: past(300, 20) }))).toBeNull();
  });
});

describe('lineFix and withLineFix: a known finish time inside a hole', () => {
  it('a finish inside the hole gets a fix on the line; one at a fix, or one too fast to reach, gets none', () => {
    const fx = approach();
    const fix = lineFix(fx, () => LINE, T0 + at6(1000) + 10_000, T0 - 10 * 60_000)!;
    expect(offLine(fix.at, LINE)).toBeLessThan(0.5);
    expect(lineFix(fx, () => LINE, T0 - 30_000, GUN)).toBeNull();
    expect(lineFix(fx, () => LINE, T0 + (1000 * 1000) / ((HOLE_MAX_KN + 1) * KN), GUN)).toBeNull();
    // Not on the boat's last leg.
    expect(lineFix(fx, () => LINE, T0 + at6(1000), T0 + 1000)).toBeNull();
  });

  it('inserts the fix in time order, marked as placed, with no roll or pitch', () => {
    const tr: Track = {
      t: Float64Array.from([1000, 2000, 300_000]),
      lat: Float64Array.from([1, 2, 3]),
      lon: Float64Array.from([4, 5, 6]),
      sog: Float32Array.from([6, 6, 6]),
      heading: Float32Array.from([90, 90, 90]),
      roll: Float32Array.from([1, 1, 1]),
      pitch: Float32Array.from([2, 2, 2]),
    };
    const out = withLineFix(tr, { ms: 150_000, at: { lat: 2.5, lon: 5.5 }, sogKn: 5, headingDeg: 80 });
    expect(Array.from(out.t)).toEqual([1000, 2000, 150_000, 300_000]);
    expect([out.lat[2], out.lon[2], out.sog[2], out.heading[2]]).toEqual([2.5, 5.5, 5, 80]);
    expect(Number.isNaN(out.roll![2]) && Number.isNaN(out.pitch![2])).toBe(true);
    expect(out.finishFixMs).toBe(150_000);
    expect(withLineFix(tr, { ms: 2000, at: { lat: 0, lon: 0 }, sogKn: 5, headingDeg: 80 })).toBe(tr);
  });
});
