import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { coachRaw } from '../src/analysis/coach';
import { dot, sub, vecBearing, type Vec } from '../src/analysis/geo';
import { raceProjection } from '../src/analysis/prepare';
import { OVER_HORIZON_MS, startReplay, startReplays, type StartReplay } from '../src/analysis/startReplay';
import type { RaceAnalysis } from '../src/analysis/types';
import type { RaceData, Track } from '../src/data/types';
import { scrubFrame } from '../src/ui/charts';
import { mapTipPos } from '../src/ui/mapPoints';
import {
  REPLAY_PARAM,
  replayArrive,
  replayControls,
  replayLabel,
  replayPendFromUrl,
  replayPending,
  replayRaceKey,
  replaySpans,
  replayTitle,
  replayWindow,
  type ReplayPend,
} from '../src/ui/replay';
import { scrubWindow, trailWindow } from '../src/ui/scrub';
import { ic37Race } from './helpers';

/** PR #37 review fixes (findings 1–9), on IC37 R5 and on synthetic tracks laid across its start line. */
const data = ic37Race();
const a = analyzeRace(data);
const raw = coachRaw(a, data);
const gun = a.meta.gunMs;
const idOf = (sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
const replays = startReplays(a, data);
const U019 = idOf('USA 019');
const bowM = data.boats.find((b) => b.id === U019)!.bowOffsetM;
const s = (t: number | null): number => (t == null ? NaN : (t - gun) / 1000);

// ---- Synthetic tracks: the boat at the line's middle, `d(t)` m on the course side (negative: behind), heading to the course side.
const proj = raceProjection(data);
const kx = proj.toXY(proj.origin.lat, proj.origin.lon + 1e-3)[0] / 1e-3;
const ky = proj.toXY(proj.origin.lat + 1e-3, proj.origin.lon)[1] / 1e-3;
const { left, right } = a.line;
const mid: Vec = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
const side: Vec = (() => {
  const v = sub(right, left);
  const l = Math.hypot(v[0], v[1]);
  const n: Vec = [-v[1] / l, v[0] / l];
  return dot(sub(a.legPts![1], left), n) < 0 ? [-n[0], -n[1]] : n;
})();
/** A track with fixes at `ts` (s from the gun), `d(t)` over the line. */
function synth(ts: number[], d: (t: number) => number): Track {
  const n = ts.length;
  const tr: Track = { t: new Float64Array(n), lat: new Float64Array(n), lon: new Float64Array(n), sog: new Float32Array(n).fill(4), heading: new Float32Array(n).fill(vecBearing(side)) };
  ts.forEach((t, i) => {
    const x = mid[0] + side[0] * d(t);
    const y = mid[1] + side[1] * d(t);
    tr.t[i] = gun + t * 1000;
    tr.lat[i] = proj.origin.lat + y / ky;
    tr.lon[i] = proj.origin.lon + x / kx;
  });
  return tr;
}
const range = (from: number, to: number, step: number): number[] => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
/** Linear through (t, d) knots. */
const knots =
  (k: [number, number][]) =>
  (t: number): number => {
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) if (t <= k[i][0]) return k[i - 1][1] + ((t - k[i - 1][0]) / (k[i][0] - k[i - 1][0])) * (k[i][1] - k[i - 1][1]);
    return k[k.length - 1][1];
  };
/** USA 019's replay facts with this track, flagged over (or not) and this DTL at the gun. */
function replayWith(track: Track, opts: { over?: boolean; dtlM?: number } = {}): StartReplay | null {
  const d2: RaceData = { ...data, boats: data.boats.map((b) => (b.id === U019 ? { ...b, track } : b)) };
  const a2: RaceAnalysis = {
    ...a,
    boats: a.boats.map((b) => (b.id === U019 ? { ...b, start: { ...b.start!, over: opts.over ?? true, dtlM: opts.dtlM ?? 2 } } : b)),
  };
  return startReplay(a2, d2, U019, raw.crossMs!);
}

describe('#2 flagged over with no first crossing in the window', () => {
  // Over the line since before gun − 30 s, back at +13.3 s, recrossed at +32.5 s (the antenna).
  const d = knots([
    [-60, 20],
    [0, 20],
    [20, -10],
    [25, -10],
    [45, 30],
  ]);
  it('already over when the window opens: framed from gun − 30 s, over from then, back and recrossed', () => {
    const r = replayWith(synth(range(-60, 120, 1), d))!;
    expect(r).not.toBeNull();
    expect(r.early).toBe(false);
    expect(r.over![0]).toBe(gun - 30_000);
    expect(s(r.wentBackMs)).toBeCloseTo(13.33, 1);
    expect(r.over![1]).toBe(r.wentBackMs);
    // At the bow: before the antenna's +32.5 s.
    expect(s(r.clearedMs)).toBeGreaterThan(25);
    expect(s(r.clearedMs)).toBeLessThan(32.5);
    expect(r.maxOverM!).toBeCloseTo(20 + bowM, 6);
    expect(replayWindow(r)[0]).toBe(gun - 30_000);
    expect(replayLabel(r)).toMatch(new RegExp(`^over ${(20 + bowM).toFixed(1)} m · back \\+13 s · recrossed \\+${Math.round(s(r.clearedMs))} s`));
  });

  it('no fixes before the gun: still a replay, over from its first fix', () => {
    const r = replayWith(synth(range(2, 120, 1), d))!;
    expect(r).not.toBeNull();
    expect(r.firstCrossMs).not.toBeNull(); // startCross's first crossing is its clearing here
    expect(r.over![0]).toBe(gun + 2000);
    expect(s(r.wentBackMs)).toBeCloseTo(13.33, 1);
    expect(r.maxOverM!).toBeCloseTo(d(2) + bowM, 6);
    expect(replayWindow(r)[0]).toBe(gun - 30_000);
  });

  it('not flagged and not early by its track: no replay', () => {
    expect(replayWith(synth(range(-60, 120, 1), d), { over: false })).toBeNull();
  });
});

describe('#3 / #4 / #6 never went back, sparse', () => {
  // Crossed at −6 s (the antenna), on up the course at 2 m/s, never back; fixes every 4 s, none at the gun.
  const d = (t: number): number => 2 * (t + 6);
  const ts = range(-37, 299, 4);
  const r = replayWith(synth(ts, d))!;

  it('metres at the gun (interpolated between the fixes either side), never back', () => {
    expect(r.early).toBe(true);
    expect(r.wentBackMs).toBeNull();
    expect(r.clearedMs).toBeNull();
    expect(ts.includes(0)).toBe(false);
    expect(r.maxOverAtMs).toBe(gun);
    expect(r.maxOverM!).toBeCloseTo(12 + bowM, 6);
    expect(replayLabel(r)).toBe(`over ${(12 + bowM).toFixed(1)} m at the gun · never back`);
  });

  it('the over stretch stops OVER_HORIZON_MS after the gun; no dip', () => {
    expect(r.over).toEqual([r.firstCrossMs, gun + OVER_HORIZON_MS]);
    expect(replaySpans(r)).toEqual({ over: [r.firstCrossMs, gun + OVER_HORIZON_MS], dip: null });
    expect(replayWindow(r)).toEqual([gun - 30_000, gun + OVER_HORIZON_MS + 15_000]);
  });

  it('the DTL at the gun is a floor', () => {
    const f = replayWith(synth(ts, d), { dtlM: -30 })!;
    expect(f.maxOverM).toBe(30);
  });

  it('went back but never recrossed: the dip is bounded too', () => {
    const back = { ...replays.find((x) => x.boat === U019)!, clearedMs: null };
    expect(replaySpans(back).dip).toEqual([back.wentBackMs, back.wentBackMs! + OVER_HORIZON_MS]);
  });

  it('sparse fixes with a return: metres from the fixes and ends, never null', () => {
    // 4 s fixes: crosses ≈ −3 s, 9 m over at +5, back ≈ +8.6 s, recrossed ≈ +23 s.
    const k = knots([
      [-40, -30],
      [-7, -4],
      [1, 5],
      [5, 9],
      [9, -0.4],
      [17, -6],
      [29, 10],
      [60, 40],
    ]);
    const q = replayWith(synth(range(-39, 119, 4), k))!;
    expect(q.early).toBe(true);
    expect(q.wentBackMs).not.toBeNull();
    expect(q.maxOverM!).toBeCloseTo(9 + bowM, 6);
    expect(q.maxOverAtMs).toBe(gun + 5000);
    expect(q.over).toEqual([q.firstCrossMs, q.wentBackMs]);
  });
});

describe('#4 the drawn over stretch never runs on up the course', () => {
  const w = scrubWindow(a);
  const r0 = replays.find((x) => x.boat === U019)!;
  // USA 019 as if it never went back: its drawn track past the gun is drawn red only to gun + OVER_HORIZON_MS.
  const never: StartReplay = { ...r0, wentBackMs: null, clearedMs: null, over: [r0.firstCrossMs!, gun + OVER_HORIZON_MS] };
  const over = (t: number): string => /class="ocs-over" points="([^"]+)"/.exec(scrubFrame(a, U019, null, { replay: never }, { t, win: trailWindow(t, 'all', w) }).tracks)![1];
  it('the same stretch at gun + 4 min as just past the horizon', () => {
    expect(over(gun + 4 * 60_000)).toBe(over(gun + OVER_HORIZON_MS + 1));
    expect(over(gun + 30_000)).not.toBe(over(gun + OVER_HORIZON_MS + 1));
  });
});

describe('#5 flagged, its track not over at the gun', () => {
  // 8 m behind at the gun, closing at 2 m/s: the antenna crosses at +4 s, the bow (4.9 m ahead) at ≈ +1.6 s: not early.
  const d = (t: number): number => 2 * t - 8;
  it('a replay, no over stretch, and the label says so', () => {
    const r = replayWith(synth(range(-40, 120, 1), d), { dtlM: 3 })!;
    expect(r).not.toBeNull();
    expect(r.early).toBe(false);
    expect(r.over).toBeNull();
    expect(r.maxOverM).toBeNull();
    expect(replaySpans(r)).toEqual({ over: null, dip: null });
    expect(replayLabel(r)).toMatch(/^flagged over · track not over at the gun · crossed \+2 s/);
    expect(replayWindow(r)).toEqual([gun - 30_000, r.clearedMs! + 15_000]);
  });
  it('the DTL over at the gun, when it has the bow over', () => {
    const r = replayWith(synth(range(-40, 120, 1), d), { dtlM: -1.5 })!;
    expect(r.over).toBeNull();
    expect(r.maxOverM).toBe(1.5);
    expect(replayLabel(r)).toMatch(/^bow over 1\.5 m at the gun · crossed \+2 s/);
  });
});

describe('#8 the button title follows the facts', () => {
  const r = replays.find((x) => x.boat === U019)!;
  it('went back and recrossed / not recrossed / never back / track not over', () => {
    expect(replayTitle(r, 'USA 019')).toBe("Replay USA 019's start: over early, went back and recrossed");
    expect(replayTitle({ ...r, clearedMs: null }, 'USA 019')).toBe("Replay USA 019's start: over early, went back, not recrossed");
    expect(replayTitle({ ...r, wentBackMs: null, clearedMs: null }, 'USA 019')).toBe("Replay USA 019's start: over early, never went back");
    expect(replayTitle({ ...r, over: null }, 'USA 019')).toBe("Replay USA 019's start: flagged over, its track not over at the gun");
  });
  it('in the control (and, pressed, how to leave it: #7)', () => {
    const never = { ...r, wentBackMs: null, clearedMs: null };
    expect(replayControls(a, [never], U019, null)).toContain('title="Replay USA 019&#39;s start: over early, never went back"');
    expect(replayControls(a, [r], U019, U019)).toContain('aria-pressed="true"');
    expect(replayControls(a, [r], U019, U019)).toContain('(click again to leave it)');
    expect(replayControls(a, [r], U019, null)).toContain('aria-pressed="false"');
  });
});

describe('#1 replay= survives a reload of the same race, and only that race', () => {
  const link = '?event=VaWTh1uA7TrLejoSFlUn&div=IC37&race=5&t=-30&trail=all&replay=USA+019#race';
  const R5 = replayRaceKey('VaWTh1uA7TrLejoSFlUn', 'IC37', 5);
  const R4 = replayRaceKey('VaWTh1uA7TrLejoSFlUn', 'IC37', 4);
  const list = replays;

  it('the deep link names its race', () => {
    expect(replayPendFromUrl(link.replace('#race', ''))).toEqual({ race: R5, boat: 'USA 019' });
    expect(replayPendFromUrl('?t=-30&replay=USA+019')).toEqual({ race: null, boat: 'USA 019' });
    expect(replayPendFromUrl('?event=e&div=IC37&race=5')).toBeNull();
    expect(new URLSearchParams(link.replace('#race', '')).get(REPLAY_PARAM)).toBe('USA 019');
    expect(a.meta.division).toBe('IC37');
    expect(a.meta.raceNumber).toBe(5);
  });

  /**
   * app.ts's wiring as events: openScrub ('shown'), the worker's replays for the analysis on screen (replayArrive;
   * replies for an analysis no longer on screen are dropped first, as askReplays does), openReplay ('opened').
   */
  function app(href: string) {
    let pend: ReplayPend | null = replayPendFromUrl(href.split('#')[0]);
    let onScreen = 0;
    let open: string | null = null;
    return {
      show(race: string): number {
        pend = replayPending(pend, { type: 'shown', race });
        open = null;
        return ++onScreen;
      },
      arrive(load: number, race: string, rs: readonly StartReplay[]): void {
        if (load !== onScreen) return;
        const res = replayArrive(pend, race, rs);
        pend = res.state;
        if (res.open) {
          open = res.open.boat;
          pend = replayPending(pend, { type: 'opened', race, boat: res.open.boat });
        }
      },
      leave(): void {
        pend = replayPending(pend, { type: 'left' });
        open = null;
      },
      get open() {
        return open;
      },
      get url() {
        return pend?.boat ?? null;
      },
    };
  }

  it('reload (reapplyOfficial) before the replays arrive: the second load opens USA 019', () => {
    const x = app(link);
    const first = x.show(R5);
    const second = x.show(R5);
    expect(x.url).toBe('USA 019');
    x.arrive(first, R5, list); // the first analysis's reply, stale
    expect(x.open).toBeNull();
    x.arrive(second, R5, list);
    expect(x.open).toBe(U019);
    expect(x.url).toBe('USA 019');
  });

  it('replays arrive, then the reload: open again once the reload’s replays arrive', () => {
    const x = app(link);
    x.arrive(x.show(R5), R5, list);
    expect(x.open).toBe(U019);
    const second = x.show(R5);
    expect(x.open).toBeNull();
    expect(x.url).toBe('USA 019');
    x.arrive(second, R5, list);
    expect(x.open).toBe(U019);
  });

  it('another race drops it, and coming back does not bring it back', () => {
    const x = app(link);
    const first = x.show(R5);
    x.show(R4);
    expect(x.url).toBeNull();
    x.arrive(first, R5, list);
    const back = x.show(R5);
    x.arrive(back, R5, list);
    expect(x.open).toBeNull();
  });

  it('a deep link for another race than the one shown is dropped', () => {
    const x = app(link);
    x.arrive(x.show(R4), R4, list);
    expect(x.open).toBeNull();
    expect(x.url).toBeNull();
  });

  it('leaving the replay drops it: a later reload does not reopen it', () => {
    const x = app(link);
    x.arrive(x.show(R5), R5, list);
    x.leave();
    expect(x.url).toBeNull();
    x.arrive(x.show(R5), R5, list);
    expect(x.open).toBeNull();
  });

  it('a boat without a replay drops it; a link without its race binds to the first race shown', () => {
    const x = app(link.replace('USA+019', 'USA+027'));
    x.arrive(x.show(R5), R5, list);
    expect(x.open).toBeNull();
    expect(x.url).toBeNull();
    const y = app('?replay=USA+019');
    y.arrive(y.show(R5), R5, list);
    expect(y.open).toBe(U019);
    y.arrive(y.show(R5), R5, list);
    expect(y.open).toBe(U019);
    y.show(R4);
    expect(y.url).toBeNull();
  });

  it('a replay opened by hand survives a reload of its race', () => {
    let p = replayPending(null, { type: 'shown', race: R5 });
    p = replayPending(p, { type: 'opened', race: R5, boat: U019 });
    p = replayPending(p, { type: 'shown', race: R5 });
    expect(replayArrive(p, R5, list).open?.boat).toBe(U019);
  });
});

describe('#9 the map tooltip keeps off the replay label', () => {
  const room = { w: 800, h: 600 };
  const size = { w: 160, h: 60 };
  it('as before with nothing to avoid: above right of the pointer', () => {
    expect(mapTipPos(300, 300, size, room)).toEqual({ left: 312, top: 230 });
    // Flipped left near the right edge, below near the top.
    expect(mapTipPos(700, 30, size, room)).toEqual({ left: 528, top: 46 });
  });
  it('the label above right of the pointer: the tip goes another way, clear of it', () => {
    const label = { left: 280, top: 240, width: 220, height: 16 };
    const p = mapTipPos(300, 300, size, room, label);
    const overlaps = p.left < label.left + label.width && p.left + size.w > label.left && p.top < label.top + label.height && p.top + size.h > label.top;
    expect(overlaps).toBe(false);
    expect(p).toEqual({ left: 312, top: 316 });
  });
  it('nowhere clear: placed as before', () => {
    expect(mapTipPos(300, 300, size, room, { left: 0, top: 0, width: 800, height: 600 })).toEqual({ left: 312, top: 230 });
  });
});
