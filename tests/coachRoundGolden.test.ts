/**
 * D9 golden on real data: USA 833's (Relative Obscurity) first windward rounding of J/70 Worlds R7
 * (Fri 11 Sep 2026, ~08:37 EDT), from its own 10 Hz log (tests/fixtures/vkx/ro-r7-windward.json, a
 * 4.5-minute slice of the uploaded .vkx) and from the public feed's fixes of the same boat
 * (tests/fixtures/vkx/feed.json, an exact subset of the log's). The fixtures carry no mark tracker
 * for the windward mark, so the boat's apex stands in for it: this checks the zone timing and the
 * coverage gate, not a comparison with the leaders (none of them is tracked densely there).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { D9_FIX_GAP_S, roundingPass } from '../src/analysis/coach/detectors/rounding';
import { bearingVec, makeProjection } from '../src/analysis/geo';
import { RO, vkxFeed } from './vkxHelpers';

interface Slice {
  t0: number;
  apex: { lat: number; lon: number; t: number };
  t: number[];
  lat: number[];
  lon: number[];
}
const slice = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/vkx/ro-r7-windward.json', import.meta.url)), 'utf8')) as Slice;
const proj = makeProjection({ lat: slice.apex.lat, lon: slice.apex.lon });
const J70_LOA = 6.93;
/** Down the run: the wind (331° at the R7 gun) behind. */
const run = bearingVec(331 + 180);

const track = (t: number[], lat: number[], lon: number[]) => {
  const xy = t.map((_, i) => proj.toXY(lat[i], lon[i]));
  return { t: Float64Array.from(t), x: Float64Array.from(xy.map((p) => p[0])), y: Float64Array.from(xy.map((p) => p[1])) };
};

describe('D9 golden: USA 833, R7 first windward rounding', () => {
  const lo = slice.t0;
  const hi = slice.t0 + slice.t[slice.t.length - 1];
  const log = track(
    slice.t.map((x) => slice.t0 + x),
    slice.lat.map((x) => x / 1e7),
    slice.lon.map((x) => x / 1e7),
  );
  const ts = vkxFeed().Fields!.indexOf('ts');
  const sail = vkxFeed().Fields!.indexOf('sail_number');
  const la = vkxFeed().Fields!.indexOf('latitude');
  const lo_ = vkxFeed().Fields!.indexOf('longitude');
  const rows = vkxFeed()
    .Rows!.filter((r) => r[sail] === RO.sail && Number(r[ts]) >= lo && Number(r[ts]) <= hi)
    .sort((p, q) => Number(p[ts]) - Number(q[ts]));
  const feed = track(
    rows.map((r) => Number(r[ts])),
    rows.map((r) => Number(r[la])),
    rows.map((r) => Number(r[lo_])),
  );

  it('the uploaded 10 Hz log passes the gate (a fix every 0.1 s within 60 m) and times the 100 m zone: ≈ 81 s', () => {
    expect(log.t.length).toBeGreaterThan(2500);
    const p = roundingPass(log, [[0, 0]], run, 0, lo, hi, J70_LOA)!;
    expect(p.covered).toBe(true);
    expect(p.innerGapS).toBeLessThan(0.2);
    expect(p.zoneS).toBeGreaterThan(80);
    expect(p.zoneS).toBeLessThan(83);
    // In 08:36:34, out 08:37:55 EDT.
    expect(new Date(p.tIn - 4 * 3_600_000).toISOString().slice(11, 19)).toBe('08:36:34');
    expect(new Date(p.tOut - 4 * 3_600_000).toISOString().slice(11, 19)).toBe('08:37:55');
  });

  it('the public feed’s fixes of the same boat through the same rounding: suppressed (a 2.4 s gap within 60 m)', () => {
    // The feed happens to be dense here (195 fixes in 4.5 min, ~1.4 s apart), yet not every 2 s at the mark.
    expect(rows.length).toBe(195);
    const p = roundingPass(feed, [[0, 0]], run, 0, lo, hi, J70_LOA)!;
    expect(p.covered).toBe(false);
    expect(p.innerGapS).toBeGreaterThan(D9_FIX_GAP_S);
    expect(p.innerGapS).toBeCloseTo(2.4, 1);
    // Its zone time agrees with the log's to a second: the gate is about trusting it, not about the arithmetic.
    expect(p.zoneS).toBeCloseTo(roundingPass(log, [[0, 0]], run, 0, lo, hi, J70_LOA)!.zoneS, 0);
  });
});
