import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { fullRateTracks, fullRateWants } from '../src/analysis/fullRate';
import { interp } from '../src/analysis/geo';
import type { FullRateTrack } from '../src/analysis/types';
import { startReplay, startReplays, type StartReplay } from '../src/analysis/startReplay';
import { mapBox, scrubFrame, trackMap } from '../src/ui/charts';
import { cardText, secondsChip } from '../src/ui/coachCards';
import { legRanges, rotator, timeRange, type FullRateSet } from '../src/ui/mapPieces';
import {
  REPLAY_PARAM,
  parseReplayParam,
  replayControls,
  replayExtent,
  replayLabel,
  replayLink,
  replayOffer,
  replaySpans,
  replayView,
  replayWindow,
  startReplayLinks,
} from '../src/ui/replay';
import { T_PARAM, TRAIL_PARAM, parseTParam, parseTrail, scrubWindow, trailWindow } from '../src/ui/scrub';
import { viewBox } from '../src/ui/view';
import { ic37Race } from './helpers';

/**
 * Map C: "Replay start" for a boat over early, on IC37 North Americans race 5 (coachStartGolden.test.ts): USA 017
 * and USA 019 were over at the gun (flagged OCS), went back and recrossed; GBR 015, USA 12 and USA 005 crossed
 * within a second of the gun (their bows just over: D1's clean front row); USA 027 started 25 m back.
 */
const data = ic37Race();
const a = analyzeRace(data);
const raw = coachRaw(a, data);
const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null)!;
const gun = a.meta.gunMs;
const idOf = (sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
const replays = startReplays(a, data);
const rep = (sail: string): StartReplay => replays.find((r) => r.boat === idOf(sail))!;
const startCard = (sail: string) => coachDebrief(a, m, idOf(sail))!.cards.find((c) => c.kind === 'D1')!;
const s = (t: number | null): number => (t == null ? NaN : (t - gun) / 1000);

describe('IC37 R5: who gets a replay', () => {
  it('USA 017 and USA 019 (over at the gun, back, recrossed); not the front row, not USA 027', () => {
    expect(replays.map((r) => a.boats.find((b) => b.id === r.boat)!.sail).sort()).toEqual(['USA 017', 'USA 019']);
    for (const sail of ['GBR 015', 'USA 005', 'USA 12', 'USA 027']) expect(startReplay(a, data, idOf(sail))).toBeNull();
    for (const sail of ['USA 017', 'USA 019']) expect(rep(sail)).toMatchObject({ flagged: true, early: true });
  });
});

describe('IC37 R5: replay facts', () => {
  it('USA 017: crossed just before the gun, ≈ 6.4 m over at the bow, back +7.4 s, recrossed +26.2 s', () => {
    const r = rep('USA 017');
    expect(s(r.firstCrossMs)).toBeLessThan(0);
    expect(s(r.firstCrossMs)).toBeGreaterThan(-3);
    expect(s(r.wentBackMs)).toBeCloseTo(7.4, 0);
    expect(s(r.clearedMs)).toBeCloseTo(26.2, 0);
    // The bow (4.9 m ahead of the antenna, along the heading); the antenna got ≈ 4 m over.
    expect(r.maxOverM!).toBeGreaterThan(5.5);
    expect(r.maxOverM!).toBeLessThan(7.5);
    expect(r.maxOverAtMs!).toBeGreaterThan(r.firstCrossMs);
    expect(r.maxOverAtMs!).toBeLessThan(r.wentBackMs!);
  });

  it('USA 019: ≈ 12.1 m over at the bow, back +13.0 s, recrossed +35.1 s', () => {
    const r = rep('USA 019');
    expect(s(r.firstCrossMs)).toBeLessThan(0);
    expect(s(r.wentBackMs)).toBeCloseTo(12.95, 1);
    expect(s(r.clearedMs)).toBeCloseTo(35.05, 1);
    // The antenna got ≈ 9.9 m over; the bow ≈ 12.1 m.
    expect(r.maxOverM!).toBeGreaterThan(11);
    expect(r.maxOverM!).toBeLessThan(13);
  });

  it("matches the Coach's over-early card: cleared = its crossing, lost = its seconds (D1's: the clearing − the front row)", () => {
    for (const sail of ['USA 017', 'USA 019']) {
      const r = rep(sail);
      const c = startCard(sail);
      expect(c.variant).toBe('ocs');
      expect(r.clearedMs).toBe(m.crossMs![idOf(sail)]);
      expect(s(r.clearedMs)).toBe(c.facts.crossS);
      // d1S when merged with D3 (the card's seconds then include it), else the card's own seconds.
      const d1S = (c.facts.d1S as number | undefined) ?? c.seconds;
      expect(r.lostS).toBeCloseTo(d1S, 9);
      const label = replayLabel(r);
      expect(label).toContain(`recrossed +${Math.round(c.facts.crossS as number)} s`);
      expect(cardText(c).chips).toContain(`cleared +${Math.round(c.facts.crossS as number)} s`);
      expect(label).toContain(`≈ ${Math.round(d1S)} s lost vs front row`);
      expect(secondsChip(c)).toBe(`≈ ${Math.round(d1S)} s`);
    }
  });

  it('the label, exactly', () => {
    expect(replayLabel(rep('USA 019'))).toBe('over 12.1 m · back +13 s · recrossed +35 s · ≈ 35 s lost vs front row');
    expect(replayLabel(rep('USA 017'))).toBe('over 6.4 m · back +7 s · recrossed +26 s · ≈ 26 s lost vs front row');
  });

  it('says what is not known', () => {
    const r = rep('USA 019');
    expect(replayLabel({ ...r, clearedMs: null, lostS: null })).toBe('over 12.1 m · back +13 s · not recrossed');
    expect(replayLabel({ ...r, wentBackMs: null, clearedMs: null, maxOverM: null, lostS: null })).toBe('over at the gun · never back');
  });

  it('highlights over the line (first crossing → back) and the dip back (back → recrossed)', () => {
    const r = rep('USA 019');
    expect(replaySpans(r)).toEqual({ over: [r.firstCrossMs, r.wentBackMs], dip: [r.wentBackMs, r.clearedMs] });
    expect(replaySpans({ ...r, wentBackMs: null, clearedMs: null }).over).toEqual([r.firstCrossMs, Infinity]);
  });
});

describe('IC37 R5: framing', () => {
  const fit = mapBox(a, null);
  for (const sail of ['USA 017', 'USA 019']) {
    it(`${sail}: [gun − 30 s, recrossed + 15 s], the line ends and its track then in view, zoomed in`, () => {
      const r = rep(sail);
      expect(replayWindow(r)).toEqual([gun - 30_000, r.clearedMs! + 15_000]);
      const v = replayView(a, r, fit);
      expect(v.k).toBeGreaterThan(1);
      const vb = viewBox(fit, v);
      const view = { x0: vb.x0, y0: vb.y0, x1: vb.x0 + vb.w, y1: vb.y0 + vb.h };
      const inView = ([x, y]: [number, number]): boolean => x >= view.x0 && x <= view.x1 && y >= view.y0 && y <= view.y1;
      // Inside the map's fit box.
      expect(view.x0).toBeGreaterThanOrEqual(fit.x0 - 1e-6);
      expect(view.y0).toBeGreaterThanOrEqual(fit.y0 - 1e-6);
      expect(view.x1).toBeLessThanOrEqual(fit.x1 + 1e-6);
      expect(view.y1).toBeLessThanOrEqual(fit.y1 + 1e-6);
      const rot = rotator(a.wind.twdAtGunDeg);
      expect(inView(rot(a.line.left))).toBe(true);
      expect(inView(rot(a.line.right))).toBe(true);
      const d = a.drawings.find((x) => x.id === r.boat)!;
      const [t0, t1] = replayWindow(r);
      let n = 0;
      for (const g of legRanges(d, true)) {
        const [i0, i1] = timeRange(g.src.t, t0, t1, g.lo, g.hi);
        for (let i = i0; i < i1; i++, n++) expect(inView(rot([g.src.x[i], g.src.y[i]]))).toBe(true);
      }
      expect(n).toBeGreaterThan(30);
      // The extent is what was framed.
      const e = replayExtent(a, r);
      expect(inView([e.x0, e.y0]) && inView([e.x1, e.y1])).toBe(true);
    });
  }
});

describe('replay deep link', () => {
  it('replay=, t=−30 and trail=all, read back by the scrubber parsers; other parameters kept', () => {
    const q = replayLink('?event=e1&div=IC37&race=5&t=200&trail=30', 'USA 019');
    const p = new URLSearchParams(q);
    expect(parseReplayParam(p.get(REPLAY_PARAM))).toBe('USA 019');
    expect(parseTParam(p.get(T_PARAM))).toBe(-30);
    expect(parseTrail(p.get(TRAIL_PARAM))).toBe('all');
    expect(p.get('event')).toBe('e1');
    expect(p.get('race')).toBe('5');
    expect(replayLink('', 'USA 017')).toBe('?t=-30&trail=all&replay=USA+017');
    expect(parseReplayParam('')).toBeNull();
    expect(parseReplayParam(null)).toBeNull();
  });
});

describe('Replay start: the map control and the Start tab links', () => {
  it('offers the selected boat if it qualifies, else (none selected) every one that does', () => {
    expect(replayOffer(replays, null)).toHaveLength(2);
    expect(replayOffer(replays, idOf('USA 019')).map((r) => r.boat)).toEqual([idOf('USA 019')]);
    expect(replayOffer(replays, idOf('USA 027'))).toEqual([]);
    expect(replayControls(a, replays, idOf('USA 027'), null)).toBe('');
    const one = replayControls(a, replays, idOf('USA 019'), idOf('USA 019'));
    expect(one).toContain('>Replay start</button>');
    expect(one).toContain('aria-pressed="true"');
    const all = replayControls(a, replays, null, null);
    expect(all).toMatch(/Replay start:<\/span> <button[^>]*data-replay="USA 01[79]"[^>]*>USA 01[79]<\/button>/);
    expect(all).toContain('>USA 017</button>');
    expect(all).toContain('>USA 019</button>');
  });

  it('the Start tab links to the Race tab replaying that boat', () => {
    const html = startReplayLinks(a, replays, idOf('USA 017'), '?event=e1&race=5');
    expect(html).toContain('href="?event=e1&amp;race=5&amp;t=-30&amp;trail=all&amp;replay=USA+017#race"');
    expect(html).toContain('>Replay start → USA 017</a>');
    expect(startReplayLinks(a, replays, idOf('GBR 015'), '')).toBe('');
  });
});

describe('IC37 R5: the replay drawn while scrubbing', () => {
  const w = scrubWindow(a);
  const frameAt = (r: StartReplay, t: number, replay: StartReplay | null = r, full: FullRateSet | null = null) =>
    scrubFrame(a, r.boat, null, { replay }, { t, win: trailWindow(t, 'all', w), full });
  /** The points of a frame's over-the-line stretch, and a drawn source's fixes (map coordinates, to 0.1 m as drawn). */
  const overPts = (tracks: string): string[] => /class="ocs-over" points="([^"]+)"/.exec(tracks)![1].split(' ');
  const fixesOf = (ranges: ReturnType<typeof legRanges>): Set<string> => {
    const rot = rotator(a.wind.twdAtGunDeg);
    const out = new Set<string>();
    for (const g of ranges) for (let i = g.lo; i < g.hi; i++) out.add(rot([g.src.x[i], g.src.y[i]]).map((v) => v.toFixed(1)).join(','));
    return out;
  };

  for (const sail of ['USA 017', 'USA 019']) {
    it(`${sail}: at recrossed + 5 s, over the line, the dip back, both markers and the label`, () => {
      const r = rep(sail);
      const f = frameAt(r, r.clearedMs! + 5000);
      expect(f.tracks).toContain('class="ocs-over"');
      expect(f.tracks).toContain('class="ocs-dip"');
      expect(f.dots).toContain('class="ocs-mark back"');
      expect(f.dots).toContain('class="ocs-mark clear"');
      expect(f.dots).toContain(`>${replayLabel(r)}</text>`);
      // The highlight under the boats: the dots come after the markers.
      expect(f.dots.indexOf('ocs-mark')).toBeLessThan(f.dots.indexOf('class="boat-at'));
    });

    it(`${sail}: before its first crossing (gun − 10 s), neither stretch nor marker`, () => {
      const r = rep(sail);
      const f = frameAt(r, gun - 10_000);
      expect(f.tracks).not.toContain('ocs-over');
      expect(f.tracks).not.toContain('ocs-dip');
      expect(f.dots).not.toContain('ocs-mark');
      // The label is there throughout the replay.
      expect(f.dots).toContain('class="ocs-lbl"');
    });
  }

  it('draws only up to t: over the line but not yet the dip while still over', () => {
    const r = rep('USA 019');
    const f = frameAt(r, r.wentBackMs! - 2000);
    expect(f.tracks).toContain('ocs-over');
    expect(f.tracks).not.toContain('ocs-dip');
    expect(f.dots).not.toContain('ocs-mark');
    const g = frameAt(r, (r.wentBackMs! + r.clearedMs!) / 2);
    expect(g.tracks).toContain('ocs-dip');
    expect(g.dots).toContain('ocs-mark back');
    expect(g.dots).not.toContain('ocs-mark clear');
  });

  it('the over stretch follows the drawn track: it starts and ends on it (cut at the facts’ times)', () => {
    const r = rep('USA 019');
    const f = frameAt(r, r.clearedMs! + 5000);
    // Its fixes between the ends are the drawn track's own (pre-gun track, then Leg 1).
    const drawn = fixesOf(legRanges(a.drawings.find((x) => x.id === r.boat)!, true));
    const inner = overPts(f.tracks).slice(1, -1);
    expect(inner.length).toBeGreaterThan(5);
    for (const p of inner) expect(drawn.has(p)).toBe(true);
  });

  it('zoomed in on full-rate tracks, it follows those instead', () => {
    const r = rep('USA 019');
    // The IC37 feed is no faster than the drawings (the worker sends none): a 5 Hz track in their place, as a 10 Hz log would be.
    expect(fullRateTracks(data, fullRateWants(a)).some((x) => x.id === r.boat)).toBe(false);
    const d = a.drawings.find((x) => x.id === r.boat)!;
    const src = legRanges(d, true);
    const T = Float64Array.from(src.flatMap((g) => [...g.src.t.subarray(g.lo, g.hi)]));
    const X = Float64Array.from(src.flatMap((g) => [...g.src.x.subarray(g.lo, g.hi)]));
    const Y = Float64Array.from(src.flatMap((g) => [...g.src.y.subarray(g.lo, g.hi)]));
    const ts = Float64Array.from({ length: Math.floor((T[T.length - 1] - T[0]) / 200) }, (_, i) => T[0] + i * 200);
    const tk: FullRateTrack = {
      id: r.boat,
      source: 'log',
      t: ts,
      x: Float32Array.from(ts, (t) => interp(T, X, t)),
      y: Float32Array.from(ts, (t) => interp(T, Y, t)),
      sog: new Float32Array(ts.length).fill(5),
    };
    const full: FullRateSet = new Map([[r.boat, tk]]);
    const f = frameAt(r, r.clearedMs! + 5000, r, full);
    expect(f.tracks).toContain('ocs-dip');
    const drawn = fixesOf(legRanges(d, true, tk));
    const inner = overPts(f.tracks).slice(1, -1);
    // ≈ 14 s over at 5 Hz.
    expect(inner.length).toBeGreaterThan(50);
    for (const p of inner) expect(drawn.has(p)).toBe(true);
  });

  it('nothing for another boat selected, one leg, or no replay', () => {
    const r = rep('USA 019');
    const t = r.clearedMs! + 5000;
    const win = trailWindow(t, 'all', w);
    expect(scrubFrame(a, idOf('USA 017'), null, { replay: r }, { t, win }).tracks).not.toContain('ocs-');
    expect(scrubFrame(a, r.boat, 0, { replay: r }, { t, win }).tracks).not.toContain('ocs-');
    expect(frameAt(r, t, null).tracks).not.toContain('ocs-');
    // The full-race map is never styled.
    expect(trackMap(a, r.boat, null, { replay: r })).not.toContain('ocs-');
  });
});
