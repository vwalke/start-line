import { describe, expect, it } from 'vitest';
import type { CoachModel, RivalLadder } from '../src/analysis/coach';
import { analyzeRace } from '../src/analysis/analyze';
import { rawHoles } from '../src/analysis/rawHoles';
import { startSogSeries } from '../src/analysis/startSog';
import type { BoatDrawing, DrawnTrack, RaceAnalysis, TrackSegment } from '../src/analysis/types';
import { startDtlM } from '../src/analysis/validity';
import { mapKey, startKey } from '../src/ui/captions';
import { boatsAt, scrubFrame, scrubPoints, startScale, startSnapshot, trackMap } from '../src/ui/charts';
import { COACH_BULLETS, coachChips, ladderChart, ladderChips, ladderRuns, ladderTipHtml } from '../src/ui/coach';
import { laneScrub } from '../src/ui/laneSnapshots';
import { laneScrubHtml } from '../src/ui/laneSnapshotsView';
import { filledRanges, legRanges, rotator } from '../src/ui/mapPieces';
import { mapTipLines } from '../src/ui/mapPoints';
import { placesChart, placesKey } from '../src/ui/places';
import { startSogChart, startSogKey } from '../src/ui/startSog';
import { legsNotesHtml, legsTable, startNotesHtml, startTable } from '../src/ui/table';
import { c31Race, fixtureRace, gateRace, ic37Race } from './helpers';

/**
 * No data gaps anywhere (as RaceSense's and Vakaros's own viewers show none): every hole in a boat's track, at any
 * length, is bridged and drawn as the rest of the track; the boats glide across it; the charts run straight on; and
 * nothing on screen talks about gaps. IC37 race 5 is dense, so holes are cut into one boat's track: 10 s (30–40 s after
 * the gun), 8 min (2–10 min after it) and 400 s across its first rounding (a hole where one leg ends and the next
 * begins).
 */
const base = analyzeRace(ic37Race());
const gun = base.meta.gunMs;
const d0 = base.drawings[0];
const id = d0.id;
const round = d0.segments[1].t[0];
const SHORT: [number, number] = [gun + 30_000, gun + 40_000];
const LONG: [number, number] = [gun + 120_000, gun + 600_000];
const ROUND: [number, number] = [round - 200_000, round + 200_000];
const TRAIL: [number, number] = [gun - 50_000, gun - 10_000];
/** Fixes strictly inside one of `holes` dropped. */
function cut<T extends DrawnTrack>(s: T, holes: [number, number][]): T {
  const keep = [...s.t].map((t, i) => (holes.some(([a, b]) => t > a && t < b) ? -1 : i)).filter((i) => i >= 0);
  const pick = <A extends Float32Array | Float64Array>(arr: A): A => (arr.constructor as unknown as { from(x: number[]): A }).from(keep.map((i) => arr[i]));
  const roll = (s as Partial<TrackSegment>).roll;
  return { ...s, t: pick(s.t), x: pick(s.x), y: pick(s.y), sog: pick(s.sog), ...(roll ? { roll: pick(roll) } : {}) };
}
/** The cut track as the feed would have it (every fix once, time order): its holes are what the map reads (BoatDrawing.holes). */
function feedOf(tracks: DrawnTrack[]): ReturnType<typeof rawHoles> {
  const fixes = new Map<number, [number, number, number]>();
  for (const tr of tracks) for (let i = 0; i < tr.t.length; i++) fixes.set(tr.t[i], [tr.x[i], tr.y[i], tr.sog[i]]);
  const ts = [...fixes.keys()].sort((p, q) => p - q);
  return rawHoles(ts, ts.map((t) => fixes.get(t)![0]), ts.map((t) => fixes.get(t)![1]), ts.map((t) => fixes.get(t)![2]), -Infinity);
}
const segments = d0.segments.map((s) => cut(s, [SHORT, LONG, ROUND]));
const trail = cut(d0.trail, [TRAIL]);
const startSog = cut({ ...d0.startSog, x: new Float32Array(d0.startSog.t.length), y: new Float32Array(d0.startSog.t.length) }, [[gun - 50_000, gun - 20_000]]);
const d: BoatDrawing = { ...d0, segments, trail, startSog: { t: startSog.t, sog: startSog.sog }, holes: feedOf([...(d0.pre ? [d0.pre] : []), ...segments]) };
const a: RaceAnalysis = { ...base, drawings: [d, ...base.drawings.slice(1)] };
const rot = rotator(a.wind.twdAtGunDeg);

/** The fixes either side of the hole over `[p, q]` in `trs` (time order), in east/north and map coordinates. */
function ends(trs: DrawnTrack[], [p, q]: [number, number]): { t: [number, number]; en: [[number, number], [number, number]] } {
  const all = trs.flatMap((tr) => [...tr.t].map((t, i): [number, number, number] => [t, tr.x[i], tr.y[i]])).sort((x, y) => x[0] - y[0]);
  const i = all.findIndex(([t]) => t > p) - 1;
  const j = all.findIndex(([t]) => t >= q);
  return { t: [all[i][0], all[j][0]], en: [[all[i][1], all[i][2]], [all[j][1], all[j][2]]] };
}
const xy = (p: [number, number]): string => rot(p).map((v) => v.toFixed(1)).join(',');
const polylines = (svg: string): string[] => svg.match(/<polyline [^>]*>/g) ?? [];
const pointsOf = (p: string): string[] => p.match(/points="([^"]*)"/)![1].split(' ');
/** Whether one polyline of `svg` runs through both `p` and `q` (map coordinates as written). */
const throughBoth = (svg: string, p: string, q: string): boolean => polylines(svg).some((l) => pointsOf(l).includes(p) && pointsOf(l).includes(q));
/** `p` lies between `e0` and `e1`: along the chord strictly inside it, and off it by at most its length. */
function between(p: [number, number], [e0, e1]: [[number, number], [number, number]]): boolean {
  const [vx, vy] = [e1[0] - e0[0], e1[1] - e0[1]];
  const l2 = vx * vx + vy * vy;
  const f = ((p[0] - e0[0]) * vx + (p[1] - e0[1]) * vy) / l2;
  const off = Math.abs((p[0] - e0[0]) * vy - (p[1] - e0[1]) * vx) / Math.sqrt(l2);
  return f > 0 && f < 1 && off <= Math.sqrt(l2);
}
/** Visible wording about gaps, holes, missing data or interpolation. */
const GAP_WORDS = /no data|data gap|tracker gap|telemetry gap|across a gap|a gap in|longest gap|gap at the gun|no fix|interpolat|estimated (section|position|, no fix)|drawn lighter|sections are lighter|left blank|no rounding time|no time at|tracker covered|tracker \d+%|low data|sparse data|Not enough (tracker )?data/i;

describe('every hole is bridged at the normal style: the maps', () => {
  const holes = { SHORT, LONG, ROUND };
  for (const [name, hole] of Object.entries(holes)) {
    const e = ends([...(d.pre ? [d.pre] : []), ...d.segments], hole);

    it(`${name} (${Math.round((e.t[1] - e.t[0]) / 1000)} s): the Race Viewer draws one line from the fix before to the fix after, in every color mode, none lighter or dashed`, () => {
      expect(e.t[1] - e.t[0]).toBeGreaterThan(d.holes!.holeMs);
      for (const svg of [trackMap(a, null, null), trackMap(a, id, null), trackMap(a, id, null, { colour: 'rank' })]) {
        expect(throughBoth(svg, xy(e.en[0]), xy(e.en[1])), svg.length.toString()).toBe(true);
        expect(svg).not.toMatch(/trk-est|stroke-opacity="0\.45"/);
      }
      // Boat speed: the stretch is in the speed bins, not a lighter path of its own.
      const sog = trackMap(a, id, null, { colour: 'sog' });
      expect(sog).not.toMatch(/sog-est|sog-gap/);
      const paths = [...sog.matchAll(/<path class="sog" [^>]*d="([^"]*)"/g)].map((m) => m[1]).join('');
      expect(paths).toContain(xy(e.en[0]));
      expect(paths).toContain(xy(e.en[1]));
    });

    it(`${name}: the boat glides across it, at its middle between the fixes either side (not gone, held or hollow)`, () => {
      const mid = (e.t[0] + e.t[1]) / 2;
      const b = boatsAt(a, id, mid).find((x) => x.id === id)!;
      expect(b).toBeDefined();
      expect([b.hold, b.stale]).toEqual([false, false]);
      expect(between([b.x, b.y], e.en)).toBe(true);
      expect(b.dir).not.toBeNull();
      // Drawn filled, as at any other moment; its tooltip says nothing about a gap.
      const f = scrubFrame(a, id, null, { scrub: true }, { t: mid, win: [mid - 120_000, mid], trailMs: 120_000 });
      const mark = f.dots.match(new RegExp(`<(path|circle) class="dot[^"]*" data-id="${id}"[^>]*>`))![0];
      expect(mark).not.toMatch(/\blost\b|\bhold\b|fill="var\(--surface\)"/);
      const p = scrubPoints(f);
      const tip = mapTipLines(a, p, { kind: 'dot', d: p.dots.findIndex((x) => x.id === id) }).join(' ');
      expect(tip).not.toMatch(GAP_WORDS);
      // The trail runs across the hole: one stroke from just before it to the boat.
      const later = scrubFrame(a, id, null, { scrub: true }, { t: e.t[1] + 10_000, win: [e.t[1] - 110_000, e.t[1] + 10_000], trailMs: 120_000 });
      const tr = later.trails.find((x) => x.id === id)!;
      expect(tr).not.toHaveProperty('est');
      expect(tr.d.join('')).toMatch(/L/);
    });

    it(`${name}: Start Playback and the Coach card maps' lookup have it too`, () => {
      const mid = (e.t[0] + e.t[1]) / 2;
      const ranges = filledRanges(d, true);
      // Some filled-in point strictly inside the hole, from the fix before to the fix after.
      expect(ranges.some((r) => Array.from(r.src.t.subarray(r.lo, r.hi)).some((t) => t > e.t[0] && t < e.t[1]))).toBe(true);
      expect(ranges.every((r) => !('est' in r.src))).toBe(true);
      // The source the drawing was cut from has no point there.
      expect(legRanges(d, true).some((r) => Array.from(r.src.t.subarray(r.lo, r.hi)).some((t) => t > e.t[0] && t < e.t[1]))).toBe(false);
      if (mid - gun <= 180_000) {
        const L = laneScrub(a, { me: id });
        const b = L.frame(Math.round((mid - gun) / 1000)).boats.find((x) => x.id === id)!;
        expect(b.pos).not.toBeNull();
        expect([b.hold, b.stale]).toEqual([false, false]);
        expect(b.trail).toHaveLength(1);
        const html = laneScrubHtml(a, L, Math.round((mid - gun) / 1000));
        expect(html).not.toMatch(/lane-est|\blost\b|in a gap/);
      }
    });
  }

  it('before the first fix and after the last nothing is invented: no boat, no line', () => {
    const first = Math.min(...legRanges(d, true).map((r) => r.src.t[r.lo]));
    expect(boatsAt(a, id, first - 5_000).some((b) => b.id === id)).toBe(false);
    const last = Math.max(...legRanges(d, true).map((r) => r.src.t[r.hi - 1]));
    const ranges = filledRanges(d, true);
    expect(Math.max(...ranges.map((r) => r.src.t[r.hi - 1]))).toBe(last);
    expect(Math.min(...ranges.map((r) => r.src.t[r.lo]))).toBe(first);
  });

  it('Start View - Gun: the trail runs straight on across a 40 s hole, one solid line at the usual opacity', () => {
    const e = ends([d.trail], TRAIL);
    const svg = startSnapshot(a, null);
    expect(throughBoth(svg, xy(e.en[0]), xy(e.en[1]))).toBe(true);
    expect(svg).not.toMatch(/trail-est|stroke-opacity="0\.45"/);
  });

  it('the map key says nothing about lighter or estimated sections; estimated marks keep their own styling', () => {
    const k = mapKey(a, { colour: 'leg' });
    expect([...k.chips.map((c) => c.text), ...k.bullets].join(' ')).not.toMatch(GAP_WORDS);
    expect(k.bullets.join(' ')).not.toMatch(/lighter|estimated section/i);
  });
});

describe('every hole is bridged: the charts', () => {
  it('Start Speed Control: one line per boat across a 30 s hole, no gray dashes, no "no data" in the key; the speed there on that line', () => {
    const s = startSogSeries(a, 60);
    const b = s.boats.find((x) => x.id === id)!;
    expect(b.runs).toHaveLength(1);
    expect(b).not.toHaveProperty('gaps');
    const svg = startSogChart(a, id, 60, {}, s);
    expect(svg).not.toContain('ss-gap');
    const line = svg.match(new RegExp(`data-id="${id}"[\\s\\S]*?class="ss-line" d="([^"]*)"`))![1];
    expect((line.match(/M/g) ?? []).length).toBe(1);
    const k = startSogKey(s, 60);
    expect([...k.chips.map((c) => c.text), ...k.bullets].join(' ')).not.toMatch(GAP_WORDS);
    expect(k.bullets.join(' ')).not.toMatch(/gray dashed/i);
  });

  it('Gap to rivals: the bold line and each thin line run straight across an 8 min stretch without values; no "no data" chip, readout or bullet', () => {
    const pt = (s: number, v: number | null, each: (number | null)[]) => ({ tMs: s * 1000, behindS: v, n: 2, est: v == null ? 0 : 1, each, leg: 0 });
    const points = [pt(0, 3, [2, 4]), pt(10, 3, [2, 4]), ...Array.from({ length: 48 }, (_, k) => pt(20 + 10 * k, null, [null, null])), pt(500, 5, [2, 4]), pt(510, 5, [2, 4])];
    const ra = {
      meta: { gunMs: 0, tzOffsetMs: 0 },
      legs: [{ index: 0, name: 'Beat 1', kind: 'upwind', to: 'Mark 1' }],
      boats: [
        { id: 'me', sail: 'USA 1', name: '#USA 1', finishPos: 1, headingSource: 'device' },
        { id: 'r', sail: 'USA 2', name: '#USA 2' },
        { id: 'q', sail: 'USA 3', name: '#USA 3' },
      ],
    } as unknown as RaceAnalysis;
    const m = { wind: { twdAt: () => 0, t: [0, 60_000, 120_000], ok: [true, true, true] } } as unknown as CoachModel;
    const l = { boat: 'me', group: ['r', 'q'], points, roundings: [], hole: { fromMs: 10_000, toMs: 500_000 } } as unknown as RivalLadder;
    expect(ladderRuns(points, (i) => points[i].behindS)).toEqual([[0, 1, 50, 51]]);
    const svg = ladderChart(ra, m, l, { kind: 'leaders' }, { widthPx: 720 });
    const moves = (cls: string): number => (svg.match(new RegExp(`class="${cls}"[^>]*d="([^"]*)"`))![1].match(/M/g) ?? []).length;
    expect(moves('cl-med')).toBe(1);
    expect(moves('cl-each" data-boat="r')).toBe(1);
    expect(moves('cl-each" data-boat="q')).toBe(1);
    expect(svg).not.toMatch(/cl-nodata|no data/);
    const chips = [...coachChips(ra, ra.boats[0]), ...ladderChips(ra, l, { kind: 'leaders' }, true)];
    expect(chips.map((c) => `${c.text} ${c.title ?? ''}`).join(' ')).not.toMatch(GAP_WORDS);
    expect(chips.some((c) => c.swatch === 'band')).toBe(false);
    // The readout: a value, never "no data", and the boats in the group line without "estimated".
    expect(ladderTipHtml(ra, m, l, { kind: 'leaders' }, 1)).not.toMatch(/no data|estimated/);
    expect(ladderTipHtml(ra, m, l, { kind: 'leaders' }, 20)).not.toMatch(/no data/);
    expect(COACH_BULLETS.join(' ')).not.toMatch(/break|gap of|left blank|not filled in/i);
  });

  it('Rounding & Finish Positions: a boat with no rounding time at a mark is one solid line through it, no gray dashes, no warning', () => {
    const r = analyzeRace(c31Race());
    const svg = placesChart(r, null);
    expect(svg).not.toContain('pc-gap');
    for (const m of svg.matchAll(/class="pc-line" d="([^"]*)"/g)) expect((m[1].match(/M/g) ?? []).length).toBe(1);
    const k = placesKey(r);
    expect(k.chips).toEqual([]);
    expect(k.bullets.join(' ')).not.toMatch(GAP_WORDS);
  });
});

describe('C31 race 10: ITA 78 (a 31.7 s hole across the gun) and GER42 (17 s, no device figure)', () => {
  const r = analyzeRace(c31Race());
  const rg = r.meta.gunMs;
  const by = (sail: string) => r.boats.find((b) => b.sail === sail)!;
  const ita = by('ITA 78');
  const dIta = r.drawings.find((x) => x.id === ita.id)!;

  it("ITA 78's hole is bridged at the normal style: points inside it, nothing lighter, its boat gliding at the gun", () => {
    const raw = legRanges(dIta, true).flatMap((x) => Array.from(x.src.t.subarray(x.lo, x.hi)));
    const ts = [...new Set(raw)].sort((p, q) => p - q);
    const k = ts.findIndex((t, i) => i > 0 && t > rg - 60_000 && t - ts[i - 1] > 30_000);
    const hole: [number, number] = [ts[k - 1], ts[k]];
    expect(Math.round((hole[1] - hole[0]) / 100) / 10).toBe(31.7);
    const filled = filledRanges(dIta, true).flatMap((x) => Array.from(x.src.t.subarray(x.lo, x.hi)));
    expect(filled.filter((t) => t > hole[0] && t < hole[1]).length).toBeGreaterThanOrEqual(30);
    for (const svg of [trackMap(r, null, null), trackMap(r, ita.id, null, { colour: 'sog' }), startSnapshot(r, ita.id)]) expect(svg).not.toMatch(/trk-est|sog-est|trail-est|stroke-opacity="0\.45"/);
    const mid = (hole[0] + hole[1]) / 2;
    const b = boatsAt(r, ita.id, mid).find((x) => x.id === ita.id)!;
    expect([b.hold, b.stale]).toEqual([false, false]);
  });

  it('the start figures: the Vakaros device figure first (ITA 78: 0.4 m); without one, ours across the hole, shown plainly', () => {
    expect(startDtlM(ita.start!)).toBeCloseTo(0.434, 3);
    expect(ita.start!.rank).toEqual({ m: ita.start!.rcDtlM, source: 'vakaros' });
    const ger = by('GER42').start!;
    expect([ger.dtlGapS! > 10, ger.rcDtlM, ger.rank]).toEqual([true, null, null]);
    // The table: GER42's check figure and seconds late plainly, its place at the gun among the rest.
    const html = startTable(r, null);
    const row = html.match(new RegExp(`<tr[^>]*data-id="${by('GER42').id}"[\\s\\S]*?</tr>`))![0];
    expect(row).not.toMatch(/class="gap"|~/);
    expect(row).toContain(ger.dtlM.toFixed(1));
    expect(row).toContain(ger.secsLate.toFixed(1));
    // The start chart: its bow number plain.
    const chart = startSnapshot(r, null);
    expect(chart).not.toMatch(/~-?\d/);
    expect(chart).toContain(`${ger.dtlM.toFixed(1)} m`);
  });

  it('no gap wording anywhere it is shown: chart keys, table keys and notes, the findings', () => {
    const texts = [
      ...startKey(r, { scale: startScale(r) }).chips.map((c) => `${c.text} ${c.title ?? ''}`),
      ...startKey(r, { scale: startScale(r) }).bullets,
      startNotesHtml(r, true),
      legsNotesHtml(r, true),
      legsTable(r, null),
      startTable(r, null),
      ...r.findings.map((f) => f.text),
    ].join(' ');
    expect(texts).not.toMatch(GAP_WORDS);
    expect(texts).not.toContain('class="gap"');
    expect(texts).not.toContain('dq-low');
  });
});

describe('a clean race draws as before', () => {
  // Benelux race 8 and the Viper gate race have no hole in any boat's feed (by its own hole rule).
  for (const [name, race] of [
    ['Benelux race 8', fixtureRace],
    ['Viper race 2', () => gateRace('viperr2')],
  ] as const) {
    it(`${name}: every range is its own source, nothing filled or bridged, so every view draws what it did`, () => {
      const r = analyzeRace(race());
      for (const dd of r.drawings) {
        const plain = legRanges(dd, true);
        const filled = filledRanges(dd, true);
        expect(filled).toHaveLength(plain.length);
        filled.forEach((f, k) => expect([f.src === plain[k].src, f.lo, f.hi]).toEqual([true, plain[k].lo, plain[k].hi]));
      }
    });
  }
});
