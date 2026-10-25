import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { rawHoles } from '../src/analysis/rawHoles';
import type { BoatDrawing, TrackSegment } from '../src/analysis/types';
import { GUN_GAP_FLAG_S, gapAtGun, startDtlM } from '../src/analysis/validity';
import { startKey } from '../src/ui/captions';
import { segRuns, startScale } from '../src/ui/charts';
import { SHORT_GAP_S, fillRuleOf, fillTrack } from '../src/ui/gapFill';
import { boatAt, filledRanges, rotTrack } from '../src/ui/mapPieces';
import { drawingGapMs, gapRuns } from '../src/ui/mapPoints';
import { boatStale } from '../src/ui/boatShape';
import { c31Race } from './helpers';

/**
 * The maps' gap rules: a hole of SHORT_GAP_S (30 s) or less is filled in (a filled hull on the lighter, solid path), a
 * longer one is a blank break with an outline hull; holes are judged on the feed's own fixes, not the copy thinned
 * to one a second; and "gap at the gun" only where the hole is over GUN_GAP_FLAG_S with no Vakaros figure.
 */

/** A segment at 1 Hz sailing east at 2 m/s from `t0` (ms) for `n` s, minus the fixes strictly inside `holes` (s from t0). */
function seg(n: number, holes: [number, number][] = [], t0 = 0): TrackSegment {
  const s = Array.from({ length: n + 1 }, (_, i) => i).filter((i) => !holes.some(([p, q]) => i > p && i < q));
  return { leg: 0, t: Float64Array.from(s, (i) => t0 + i * 1000), x: Float32Array.from(s, (i) => 2 * i), y: new Float32Array(s.length), sog: Float32Array.from(s, () => 3.9) };
}
const drawingOf = (segments: TrackSegment[], holes?: BoatDrawing['holes']): BoatDrawing => ({ id: 'b', segments, ...(holes ? { holes } : {}) }) as unknown as BoatDrawing;

describe('the 30 s rule: filled up to SHORT_GAP_S, a blank break with an outline hull past it (mapPoints and boatShape alike)', () => {
  const cases = [
    { holeS: 30, filled: true },
    { holeS: 30.5, filled: false },
    { holeS: 31, filled: false },
  ];
  for (const { holeS, filled } of cases) {
    it(`a ${holeS} s hole is ${filled ? 'filled in' : 'a blank break'}`, () => {
      // Fixes at 0 … 40 s and from 40 + holeS s on.
      const s = seg(120, [[40, 40 + holeS]]);
      if (holeS % 1) for (let i = 0; i < s.t.length; i++) if (s.t[i] > 40_000) s.t[i] += 500 - 1000;
      const d = drawingOf([s]);
      expect(s.t.findIndex((t) => t > 40_000) >= 0 && s.t[s.t.findIndex((t) => t > 40_000)] - 40_000).toBe(holeS * 1000);
      expect(drawingGapMs(d)).toBe(SHORT_GAP_S * 1000);
      const [r] = filledRanges(d, false);
      const est = r.src.est;
      const rot = rotTrack(0, r.src);
      const runs = segRuns(rot.x, rot.y, r.src.t, drawingGapMs(d), null, est);
      const mid = 40_000 + (holeS * 1000) / 2;
      const b = boatAt('b', [r], mid, drawingGapMs(d), 0)!;
      if (filled) {
        // One line of fixes either side, the hole between a lighter run of its own; the boat on it, not held, filled.
        expect(est?.some((v) => v === 1)).toBe(true);
        expect(runs.est).toHaveLength(1);
        expect(runs.runs).toHaveLength(2);
        expect(runs.gaps).toBe('');
        expect(gapRuns(r.src.t, drawingGapMs(d))).toHaveLength(1);
        expect(b).toMatchObject({ hold: false, stale: false, est: true });
        expect(b.dir).not.toBeNull();
      } else {
        // Nothing filled, the line broken there; the boat held at its last fix, hollow.
        expect(est).toBeUndefined();
        expect(runs.est).toHaveLength(0);
        expect(runs.runs).toHaveLength(2);
        expect(runs.gaps).not.toBe('');
        expect(gapRuns(r.src.t, drawingGapMs(d))).toHaveLength(2);
        expect(b).toMatchObject({ hold: true, stale: true, lastFix: 40_000 });
        expect(b.est).toBeUndefined();
      }
      expect(boatStale(true, 40_000, mid, holeS * 1000)).toBe(!filled);
    });
  }
});

describe('holes judged on the feed\'s own fixes, not the thinned copy', () => {
  // A ~2 Hz feed (0.6 s steps) with a 1.5 s hole after every 15th fix, 3 minutes long.
  const raw: number[] = [];
  for (let t = 0, k = 0; t <= 180_000; t += k++ % 16 === 15 ? 1500 : 600) raw.push(t);
  const xs = raw.map((t) => t / 500);
  const zeros = raw.map(() => 0);
  /** The analysis's thinning (analyze.ts): a fix kept only 1 s or more after the last kept (and the last one). */
  const thin = (ts: number[]): number[] => {
    const out: number[] = [];
    let last = -Infinity;
    ts.forEach((t, k) => {
      if (t - last < 1000 && k !== ts.length - 1) return;
      last = t;
      out.push(k);
    });
    return out;
  };
  const segOf = (ts: number[], keep: number[]): TrackSegment => ({
    leg: 0,
    t: Float64Array.from(keep, (k) => ts[k]),
    x: Float32Array.from(keep, (k) => ts[k] / 500),
    y: new Float32Array(keep.length),
    sog: Float32Array.from(keep, () => 3.9),
  });

  it('a 2 Hz feed with 1.5 s holes: no breaks and no estimated stretches, where the thinned copy alone has steps over 2 s', () => {
    expect(Math.max(...raw.slice(1).map((t, i) => t - raw[i]))).toBeLessThanOrEqual(1500 + 1e-9);
    const keep = thin(raw);
    const s = segOf(raw, keep);
    // The thinned copy steps over 2 s at those holes (origin/main broke the line there: over max(2 s, 2 × its 1.2 s step)).
    expect(Math.max(...Array.from(s.t).slice(1).map((t, i) => t - s.t[i]))).toBeGreaterThan(2000);
    const holes = rawHoles(raw, xs, zeros, raw.map(() => 3.9), -Infinity);
    expect(holes.at).toHaveLength(0);
    const d = drawingOf([s], holes);
    const [r] = filledRanges(d, false);
    expect(r.src.est).toBeUndefined();
    expect(gapRuns(r.src.t, drawingGapMs(d))).toHaveLength(1);
  });

  it('a real hole is drawn from the feed\'s own fixes either side, even where the thinned copy dropped the one before it', () => {
    // The same feed with a 10 s hole after a fix the thinning drops (one 0.6 s after a kept one).
    const keep0 = new Set(thin(raw));
    const at = raw.find((t, k) => t > 60_000 && !keep0.has(k) && raw[k + 1] - t === 600)!;
    const ts = raw.filter((t) => !(t > at && t < at + 10_000));
    const keep = thin(ts);
    const s = segOf(ts, keep);
    expect(s.t.includes(at)).toBe(false);
    const holes = rawHoles(ts, ts.map((t) => t / 500), ts.map(() => 0), ts.map(() => 3.9), -Infinity);
    expect([...holes.at]).toEqual([at]);
    const filled = fillTrack(s, fillRuleOf(drawingOf([s], holes)), true);
    // The fix before the hole is back, and the filled points run from it to the fix after.
    const i = filled.t.indexOf(at);
    expect(i).toBeGreaterThan(0);
    expect(filled.est![i]).toBe(0);
    expect(filled.est![i + 1]).toBe(1);
    const after = ts.find((t) => t > at)!;
    const j = filled.t.indexOf(after);
    expect(filled.est![j]).toBe(0);
    expect(filled.est![j - 1]).toBe(1);
    expect([...filled.est!].filter((v) => v === 1).length).toBe(Math.ceil((after - at) / 1000) - 1);
  });
});

describe('gap at the gun: only a hole over GUN_GAP_FLAG_S with no Vakaros figure', () => {
  it('the rule', () => {
    expect(GUN_GAP_FLAG_S).toBe(10);
    expect(gapAtGun({ dtlGapS: 10.5, rcDtlM: null })).toBe(true);
    expect(gapAtGun({ dtlGapS: 10, rcDtlM: null })).toBe(false);
    expect(gapAtGun({ dtlGapS: 6, rcDtlM: null })).toBe(false);
    expect(gapAtGun({ dtlGapS: 31.7, rcDtlM: 0.4 })).toBe(false);
    expect(gapAtGun({ dtlGapS: null, rcDtlM: null })).toBe(false);
    // Our figure across a hole gives way to the device's; with no hole, or no device figure, ours.
    expect(startDtlM({ dtlM: -6, dtlGapS: 31.7, rcDtlM: 0.4 })).toBe(0.4);
    expect(startDtlM({ dtlM: -6, dtlGapS: null, rcDtlM: 0.4 })).toBe(-6);
    expect(startDtlM({ dtlM: -3, dtlGapS: 17, rcDtlM: null })).toBe(-3);
  });

  it('C31 race 10: GER42 (17 s hole, stale Vakaros row) is flagged in a plain chip; ITA 78 (32 s hole, device 0.4 m) is not, and starts on the device figure', () => {
    const a = analyzeRace(c31Race());
    const by = (sail: string) => a.boats.find((b) => b.sail === sail)!.start!;
    const ger = by('GER42');
    const ita = by('ITA 78');
    expect([ger.dtlGapS! > GUN_GAP_FLAG_S, ger.rcDtlM]).toEqual([true, null]);
    expect(gapAtGun(ger)).toBe(true);
    expect(ita.dtlGapS!).toBeGreaterThan(30);
    expect(gapAtGun(ita)).toBe(false);
    // Ours puts ITA 78 6 m over across the hole; its start figures are the device's 0.4 m behind.
    expect(ita.dtlM).toBeLessThan(-5);
    expect(startDtlM(ita)).toBeCloseTo(0.434, 3);
    expect(ita.rank).toEqual({ m: ita.rcDtlM, source: 'vakaros' });
    expect(ita.over).toBe(false);
    const chips = startKey(a, { scale: startScale(a) }).chips.filter((c) => /gap at the gun/.test(c.text));
    expect(chips).toEqual([{ text: '1 with a gap at the gun', title: expect.stringContaining('over 10 s') }]);
    expect(chips[0]).not.toHaveProperty('warn');
    // No finding says ITA 78 has a gap at the gun.
    expect(a.findings.some((f) => /ITA 78/.test(f.text) && /gap at the gun/.test(f.text))).toBe(false);
  });
});

describe('C31 race 10 fixture (four boats, full rate near the gun): what is left blank in gun ±60 s', () => {
  it("only ITA 78's hole over 30 s; every shorter hole there is filled in", () => {
    const a = analyzeRace(c31Race());
    const gun = a.meta.gunMs;
    const [w0, w1] = [gun - 60_000, gun + 60_000];
    const blank: string[] = [];
    let filled = 0;
    for (const d of a.drawings) {
      const sail = a.boats.find((b) => b.id === d.id)!.sail;
      const ranges = filledRanges(d, true);
      const ts = [...new Set(ranges.flatMap((r) => Array.from(r.src.t.subarray(r.lo, r.hi))))].sort((p, q) => p - q);
      expect(ts[0]).toBeLessThan(w0);
      expect(ts.at(-1)!).toBeGreaterThan(w1);
      for (let i = 1; i < ts.length; i++) {
        if (ts[i] <= w0 || ts[i - 1] >= w1) continue;
        if (ts[i] - ts[i - 1] > drawingGapMs(d)) blank.push(`${sail} ${Math.round((ts[i] - ts[i - 1]) / 100) / 10} s`);
      }
      for (const r of ranges) for (let i = r.lo; i < r.hi; i++) if (r.src.est?.[i] === 1 && r.src.t[i] > w0 && r.src.t[i] < w1) filled++;
      // Every hole the feed has in the window, up to 30 s, is filled.
      const h = d.holes!;
      for (const t of h.at) {
        const k = h.edges.t.indexOf(t);
        const len = h.edges.t[k + 1] - t;
        if (t < w0 || t > w1 || len > SHORT_GAP_S * 1000) continue;
        const r = ranges.find((x) => x.src.t[x.lo] <= t && x.src.t[x.hi - 1] > t)!;
        const j = Array.from(r.src.t).indexOf(t);
        expect(r.src.est?.[j + 1], `${sail} at ${(t - gun) / 1000} s`).toBe(1);
      }
    }
    expect(blank).toEqual(['ITA 78 31.7 s']);
    expect(filled).toBeGreaterThan(10);
  });
});
