/**
 * A finisher drawn through the line (analysis/finishThrough.ts), on J/70 North Americans race 8
 * (tests/fixtures/j70nas_r8_finish.json): the feed drops the whole fleet for up to 44 s around the finishes. 94, 641 and
 * 1226 were drawn to their last fix before their finish time (12–71 m short of the line), held there and gone at their
 * finish; now each sails through the line at its recorded time, through the point the device recorded, on to its next
 * fix. That point is the tracker's when the bow crossed (~2 m short of the line): at the finish time the map's hull has
 * its bow on the line, and the track (the tracker) crosses a second or so later.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { coachTracks } from '../src/analysis/coach/tracks';
import { FINISH_JOIN_MIN_MS, finishStep, withFinishThrough } from '../src/analysis/finishThrough';
import { raceProjection } from '../src/analysis/prepare';
import { destination, metresFrom } from '../src/data/finishes';
import { finishPoint } from '../src/data/holeFinish';
import { currentDoc, buildRaceData, nextGunMs } from '../src/data/racesense/adapter';
import type { RaceData } from '../src/data/types';
import { boatsAt } from '../src/ui/charts';
import { filledRanges } from '../src/ui/mapPieces';
import type { Fixture } from './helpers';

const f = JSON.parse(readFileSync(new URL('./fixtures/j70nas_r8_finish.json', import.meta.url), 'utf8')) as Fixture;
const ref = { division: 'J70', raceNumber: 8 };
const build = (): RaceData =>
  buildRaceData(f.regatta, ref, [f.telemetry], { eventId: f.eventId, kind: 'fixture', nextGunMs: nextGunMs(currentDoc(f.regatta), ref) });
const data = build();
const a = analyzeRace(data);
const proj = raceProjection(data);
const race = currentDoc(f.regatta).divisions[0].races.find((r) => r.raceNumber === 8)!;
const record = (sail: string) => race.finishes!.find((r) => r.sailNumber === sail)!;
const SAILS = ['94', '641', '1226'];

type V = [number, number];
const sub = (p: V, q: V): V => [p[0] - q[0], p[1] - q[1]];
const cross = (p: V, q: V): number => p[0] * q[1] - p[1] * q[0];
/** The finish line in race metres. */
const line = (): [V, V] => {
  const l = data.finishLine!;
  return [proj.toXY(l.left.lat, l.left.lon), proj.toXY(l.right.lat, l.right.lon)];
};
/** Distance from `p` to the finish line segment, m. */
function offLine(p: V): number {
  const [L, R] = line();
  const d = sub(R, L);
  const s = Math.max(0, Math.min(1, ((p[0] - L[0]) * d[0] + (p[1] - L[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2)));
  return Math.hypot(p[0] - L[0] - s * d[0], p[1] - L[1] - s * d[1]);
}
/** When the drawn polyline (t, x, y) first crosses the finish line segment, interpolated; null when it doesn't. */
function crossesAt(t: ArrayLike<number>, x: ArrayLike<number>, y: ArrayLike<number>): number | null {
  const [L, R] = line();
  const d = sub(R, L);
  // Signed side of the line's direction; a point exactly on it counts as reached.
  const side = (i: number): number => cross(d, sub([x[i], y[i]], L));
  for (let i = 1; i < t.length; i++) {
    const s0 = side(i - 1);
    const s1 = side(i);
    if (s0 === 0 && offLine([x[i - 1], y[i - 1]]) < 0.5) return t[i - 1];
    if (s0 * s1 >= 0) continue;
    const k = s0 / (s0 - s1);
    const p: V = [x[i - 1] + k * (x[i] - x[i - 1]), y[i - 1] + k * (y[i] - y[i - 1])];
    if (offLine(p) < 0.5) return t[i - 1] + k * (t[i] - t[i - 1]);
  }
  return null;
}

describe('J/70 North Americans race 8: 94, 641 and 1226 sail through the finish line at their finish times', () => {
  it.each(SAILS)('%s: its finish time is the feed’s, and the feed has no fix within 10 s of it', (sail) => {
    const b = a.boats.find((x) => x.sail === sail)!;
    expect(b.finishMs).toBe(Date.parse(record(sail).finishingTime));
    const tr = data.boats.find((x) => x.sail === sail)!.track;
    const step = finishStep(tr.t, b.finishMs!)!;
    expect(step).not.toBeNull();
    expect(b.finishMs! - tr.t[step.before]).toBeGreaterThan(10_000);
    // Its last fix before the finish is well short of the line (what the map used to stop it at).
    expect(offLine(proj.toXY(tr.lat[step.before], tr.lon[step.before]))).toBeGreaterThan(10);
  });

  it.each(SAILS)('%s: the drawn track runs through the point the device recorded at its finish time, crossing the line just after', (sail) => {
    const b = a.boats.find((x) => x.sail === sail)!;
    const d = a.drawings.find((x) => x.id === b.id)!;
    const pos = record(sail).positionAtFinish!.coordinates;
    const [px, py] = proj.toXY(pos[1], pos[0]);
    expect(d.finish).toEqual({ t: b.finishMs, x: px, y: py });
    const s = d.segments.at(-1)!;
    expect(s.leg).toBe(a.legs.length - 1);
    // The leg runs on past the line to the boat's next fix.
    expect(s.t.at(-1)!).toBeGreaterThan(b.finishMs!);
    // The tracker, its bow ahead of it, is under a bow's length short of the line then and crosses within 2 s.
    const bowM = data.boats.find((x) => x.sail === sail)!.bowOffsetM;
    expect(offLine([px, py])).toBeLessThan(bowM);
    const t = crossesAt(s.t, s.x, s.y);
    expect(t).not.toBeNull();
    expect(t! - b.finishMs!).toBeGreaterThan(0);
    expect(t! - b.finishMs!).toBeLessThanOrEqual(2000);
    // As the map draws it (holes filled: ui/gapFill.ts), too.
    const r = filledRanges(d, false).at(-1)!;
    const tf = crossesAt(r.src.t.subarray(r.lo, r.hi), r.src.x.subarray(r.lo, r.hi), r.src.y.subarray(r.lo, r.hi));
    expect(tf).toBeCloseTo(t!, 0);
  });

  it.each(SAILS)('%s: its boat’s bow crosses the line at its finish time (±1 s), moving (never held) up to it, gone only after its next fix', (sail) => {
    const b = a.boats.find((x) => x.sail === sail)!;
    const d = a.drawings.find((x) => x.id === b.id)!;
    const fin = b.finishMs!;
    const bowM = data.boats.find((x) => x.sail === sail)!.bowOffsetM;
    // The hull's bow, bowM ahead of the tracker along its course (ui/boatShape.ts hullCenterFromBow).
    const bow = (t: number): V => {
      const m = boatsAt(a, null, t).find((x) => x.id === b.id)!;
      const c = (m.cog * Math.PI) / 180;
      return [m.x + Math.sin(c) * bowM, m.y + Math.cos(c) * bowM];
    };
    const [L, R] = line();
    const side = (p: V): number => Math.sign(cross(sub(R, L), sub(p, L)));
    expect(side(bow(fin - 1000))).not.toBe(side(bow(fin + 1000)));
    expect(offLine(bow(fin))).toBeLessThan(1);
    for (let t = fin - 60_000; t <= fin; t += 1000) {
      const m = boatsAt(a, null, t).find((x) => x.id === b.id);
      expect(m, `${sail} at finish − ${(fin - t) / 1000} s`).toBeDefined();
      expect(m!.hold).toBe(false);
      expect(m!.stale).toBe(false);
    }
    const end = d.segments.at(-1)!.t.at(-1)!;
    expect(boatsAt(a, null, end).some((x) => x.id === b.id)).toBe(true);
    expect(boatsAt(a, null, end + 1000).some((x) => x.id === b.id)).toBe(false);
  });

  it('changes no time, place, score, distance, speed or leg figure, and nothing the Coach reads', () => {
    const plain = build();
    for (const b of plain.boats) delete b.finishAt;
    const before = analyzeRace(plain);
    expect(before.drawings.some((d) => d.finish)).toBe(false);
    expect(a.boats).toEqual(before.boats);
    expect(a.legs).toEqual(before.legs);
    expect(a.meta.results).toEqual(before.meta.results);
    expect(coachTracks(a)).toEqual(coachTracks(before));
  });
});

describe('finishStep and withFinishThrough', () => {
  const t = Float64Array.from([0, 1000, 2000, 20_000, 21_000]);
  it('joins a finish between fixes over FINISH_JOIN_MIN_MS apart (or after the last), not one at or near a fix', () => {
    expect(finishStep(t, 10_000)).toEqual({ before: 2, after: 3 });
    expect(finishStep(t, 1500)).toBeNull();
    expect(finishStep(t, 2000)).toBeNull();
    expect(finishStep(t, 21_000 + FINISH_JOIN_MIN_MS + 1)).toEqual({ before: 4, after: null });
    expect(finishStep(t, 21_500)).toBeNull();
    expect(finishStep(t, -1)).toBeNull();
    // A hole over CROSS_MAX_GAP_MS is data/holeFinish.ts's.
    expect(finishStep(Float64Array.from([0, 200_000]), 100_000)).toBeNull();
  });

  it('puts the point in time order (no roll), leaving a track with a fix then as it is', () => {
    const tk = { t, x: Float32Array.from([0, 1, 2, 20, 21]), y: new Float32Array(5), sog: new Float32Array(5).fill(5), roll: new Float32Array(5).fill(3) };
    const out = withFinishThrough(tk, { t: 10_000, x: 9, y: 1 }, 6);
    expect([...out.t]).toEqual([0, 1000, 2000, 10_000, 20_000, 21_000]);
    expect([...out.x]).toEqual([0, 1, 2, 9, 20, 21]);
    expect(out.sog[3]).toBe(6);
    expect(out.roll![3]).toBeNaN();
    expect(withFinishThrough(tk, { t: 2000, x: 9, y: 1 }, 6)).toBe(tk);
  });
});

describe('finishPoint: a finish with no position of the device’s (official or estimated)', () => {
  // A line 100 m long running east; the boat sails north across it in a 20 s hole, angling east.
  const left = { lat: 38.95, lon: -76.44 };
  const line = { left, right: destination(left, 90, 100) };
  const fix = (ts: number, east: number, north: number) => ({ ts, ...destination(destination(left, 90, east), 0, north) });

  it('is where its step across the finish meets the line', () => {
    const fixes = [fix(0, 30, -40), fix(10_000, 32, -20), fix(30_000, 52, 20)];
    const p = finishPoint(fixes, () => line, 20_000)!;
    const [e, n] = metresFrom(p, left);
    expect(n).toBeCloseTo(0, 1);
    expect(e).toBeCloseTo(42, 0);
  });

  it('along its course in when its tracker ends first; null with no fix before or no line', () => {
    const fixes = [fix(0, 30, -60), fix(10_000, 30, -40), fix(20_000, 30, -20)];
    const [e, n] = metresFrom(finishPoint(fixes, () => line, 25_000)!, left);
    expect(n).toBeCloseTo(0, 1);
    expect(e).toBeCloseTo(30, 0);
    expect(finishPoint(fixes, () => line, -1)).toBeNull();
    expect(finishPoint(fixes, () => null, 25_000)).toBeNull();
  });
});
