/**
 * The estimated finish (data/finishEstimate.ts) on the 2026 Fall Brawl (Annapolis): the course has only the start
 * line's two trackers, RaceSense has no finishes, and the boats finish off the committee boat on the side away from
 * the pin. Also the far end measured up the course axis (data/finishes.ts trackerFinish), and the map's dashed line.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { bowFixes, estimateFinish, EST_MAX_M, EST_MIN_M, EST_SPAN_DEG, fitToCrossings } from '../src/data/finishEstimate';
import { alongDeg, bearingDeg, courseAxisDeg, destination, metresFrom, trackerFinish, type Fix } from '../src/data/finishes';
import { buildRaceData, nextGunMs, currentDoc, type OfficialRaceInput } from '../src/data/racesense/adapter';
import type { Course } from '../src/data/racesense/types';
import type { LatLon, Line, RaceData } from '../src/data/types';
import { raceNotesKey } from '../src/ui/captions';
import { trackMap } from '../src/ui/charts';
import { FALLBRAWL_RACES, fallbrawlFixture, fallbrawlOfficial, fallbrawlRace, type FallBrawlKey, type Fixture } from './helpers';
import { readJson, regatta } from './recoveryHelpers';

const KEYS = Object.keys(FALLBRAWL_RACES) as FallBrawlKey[];
const M = 60_000;
const edt = (ms: number): string => new Date(ms - 4 * 3_600_000).toISOString().slice(11, 19);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The official finishers (placed), in official order, with their UTC times. */
const officialFinishers = (o: OfficialRaceInput): { sail: string; place: number; ms: number }[] =>
  o.rows
    .filter((r) => r.code == null && r.place != null && r.rsSail && r.finishWallMs != null)
    .map((r) => ({ sail: r.rsSail!, place: r.place!, ms: r.finishWallMs! - o.tzOffsetMs }))
    .sort((a, b) => a.place - b.place);

const courseOf = (f: Fixture, key: FallBrawlKey): Course => {
  const div = f.regatta.revisions.at(-1)!.doc.divisions.find((d) => d.name === FALLBRAWL_RACES[key].division)!;
  return div.courses![0];
};
const PIN = '0238006E7E';
const COMMITTEE = '0238006EAB';

describe.each(KEYS)('Fall Brawl %s: the finish off the committee boat', (key) => {
  const official = fallbrawlOfficial(key);
  const fins = officialFinishers(official);
  const data = fallbrawlRace(key);
  const linked = fallbrawlRace(key, official);

  it('without official results: an estimated line; every official finisher crosses it within 10 s, in the official order', () => {
    expect(data.finishLineEstimated).toBe(true);
    const fl = data.finishLine!;
    // Off the committee boat, away from the pin, near the start line's own bearing.
    const start = bearingDeg(data.startLine.left, data.startLine.right);
    const deg = bearingDeg(fl.left, fl.right);
    const lengthM = Math.hypot(...metresFrom(fl.right, fl.left));
    expect(Math.abs(((deg - start + 540) % 360) - 180)).toBeLessThanOrEqual(EST_SPAN_DEG);
    expect(lengthM).toBeGreaterThanOrEqual(EST_MIN_M);
    expect(lengthM).toBeLessThanOrEqual(EST_MAX_M);
    expect(data.results).toMatchObject({ places: 'tracker', times: 'tracker' });

    const bySail = new Map(data.boats.map((b) => [b.sail, b]));
    const gaps = fins.map((f) => {
      const b = bySail.get(f.sail)!;
      expect(b.finishSource, f.sail).toBe('tracker');
      return { ...f, tracker: b.finishMs!, gapS: (b.finishMs! - f.ms) / 1000 };
    });
    const abs = gaps.map((g) => Math.abs(g.gapS));
    console.log(
      `Fall Brawl ${key}: line ${deg.toFixed(0)}° (start line ${start.toFixed(0)}°), ${lengthM.toFixed(0)} m; ${gaps.length} official finishers, ` +
        `|tracker − official| median ${median(abs).toFixed(1)} s, max ${Math.max(...abs).toFixed(1)} s; ` +
        gaps.map((g) => `${g.sail} ${edt(g.ms)} ${g.gapS >= 0 ? '+' : ''}${g.gapS.toFixed(1)}`).join(', '),
    );
    expect(median(abs)).toBeLessThanOrEqual(3);
    expect(Math.max(...abs)).toBeLessThanOrEqual(10);
    // The tracker finishes in the official order, but for boats the committee timed within 2 s of each other
    // (J/105: 215 and 251 at 2:26:53 and :54 pm, 407 and 517 at 2:27:09 and :10).
    const swapped = gaps.flatMap((g, i) => gaps.slice(i + 1).filter((h) => h.tracker < g.tracker).map((h) => [g, h] as const));
    for (const [g, h] of swapped) expect(h.ms - g.ms, `${g.sail} / ${h.sail}`).toBeLessThanOrEqual(2_000);
    if (key !== 'j105r3') expect(swapped).toEqual([]);
    // The race notes say so.
    const a = analyzeRace(data);
    expect(a.finishLineEstimated).toBe(true);
    expect(a.notes.find((n) => n.kind === 'finish-est')?.text).toBe("The finish line isn't in the feed: it's placed off the committee boat from the tracks (est.).");
    expect(raceNotesKey(a).chips.map((c) => c.text)).toContain('finish line est.');
  });

  it('with official results: the official times agree with the estimated line, so they are kept', () => {
    expect(linked.finishLineEstimated).toBe(true);
    const fl = linked.finishLine!;
    console.log(`Fall Brawl ${key} with official times: line ${bearingDeg(fl.left, fl.right).toFixed(0)}°, ${Math.hypot(...metresFrom(fl.right, fl.left)).toFixed(0)} m`);
    expect(linked.results).toMatchObject({ places: 'official', times: 'official', trackerFinishes: 0 });
    expect(linked.results!.timesNote).toBeUndefined();
    const bySail = new Map(linked.boats.map((b) => [b.sail, b]));
    for (const f of fins) expect(bySail.get(f.sail), f.sail).toMatchObject({ finishMs: f.ms, finishSource: 'official', officialPlace: f.place });
  });
});

describe('Fall Brawl: when not to estimate', () => {
  it('falls back to the start line when too few boats cross the estimated one (fixes near the finish dropped)', () => {
    const f = fallbrawlFixture('j70r3');
    const gun = f.regatta.revisions.at(-1)!.doc.divisions.find((d) => d.name === 'J70')!.races.find((r) => r.raceNumber === 3)!.starts.at(-1)!.startTime!;
    const F = Object.fromEntries(f.telemetry.Fields!.map((k, i) => [k, i]));
    const committee = f.telemetry.Rows!.filter((r) => r[F.role] === 'mark' && r[F.sn] === 0x6eab);
    const cb = committee[Math.floor(committee.length / 2)];
    const at = (r: unknown[]): LatLon => ({ lat: Number(r[F.latitude]), lon: Number(r[F.longitude]) });
    // Only three boats keep their fixes within 400 m of the committee boat after 25 min.
    const keep = new Set(['419', '84', '389']);
    f.telemetry.Rows = f.telemetry.Rows!.filter(
      (r) => r[F.role] !== 'competitor' || keep.has(String(r[F.sail_number])) || Number(r[F.ts]) < gun + 25 * M || Math.hypot(...metresFrom(at(r), at(cb))) > 400,
    );
    const d = fallbrawlRace('j70r3', null, f);
    expect(d.finishLine).toBeNull();
    expect(d.finishLineEstimated).toBeUndefined();
    // Exactly what the start line gives: the same data with a tracked mark in the course (no estimate there).
    const g = structuredClone(f);
    courseOf(g, 'j70r3').achievements.push({ type: 'mark', title: 'Windward', deviceRoles: [{ role: 'mark', sn: PIN }] } as Course['achievements'][number]);
    const today = fallbrawlRace('j70r3', null, g);
    expect(d.results).toEqual(today.results);
    expect(d.boats.map((b) => [b.sail, b.finishMs, b.finishSource ?? null])).toEqual(today.boats.map((b) => [b.sail, b.finishMs, b.finishSource ?? null]));
  });

  it('estimates nothing with a finish line or a tracked mark in the course', () => {
    const withFinish = fallbrawlFixture('j70r3');
    courseOf(withFinish, 'j70r3').achievements.push({
      type: 'finishLine',
      title: 'Finish',
      deviceRoles: [
        { role: 'finishLeft', sn: PIN },
        { role: 'finishRight', sn: COMMITTEE },
      ],
    } as Course['achievements'][number]);
    const a = fallbrawlRace('j70r3', null, withFinish);
    expect(a.finishLineEstimated).toBeUndefined();
    expect(a.finishLine).not.toBeNull();

    const withMark = fallbrawlFixture('j70r3');
    courseOf(withMark, 'j70r3').achievements.push({ type: 'mark', title: 'Windward', deviceRoles: [{ role: 'mark', sn: PIN }] } as Course['achievements'][number]);
    const b = fallbrawlRace('j70r3', null, withMark);
    expect(b.course.length).toBe(1);
    expect(b.finishLineEstimated).toBeUndefined();
    expect(b.finishLine).toBeNull();
  });

  it('leaves AYC as it was: it finishes on its start line, so the start line stands', () => {
    const resp = regatta('rs_aycfs.json');
    const ref = { division: 'J105', raceNumber: 1 };
    const f = readJson<Fixture>('ayc_j105_r1.json');
    const d: RaceData = buildRaceData(resp, ref, [f.telemetry], { kind: 'fixture', nextGunMs: nextGunMs(currentDoc(resp), ref) });
    expect(d.finishLine).toBeNull();
    expect(d.finishLineEstimated).toBeUndefined();
    expect(d.results).toEqual({ places: 'tracker', times: 'tracker', trackerFinishes: 19 });
    const s = Object.fromEntries(d.boats.map((b) => [b.sail, Math.round(b.finishMs! / 100) / 10]));
    // As before the estimate (Oct 2026): the first, a middle and the last finisher.
    expect([s['USA 242'], s['USA 96'], s['USA 527']]).toEqual([1791043184.2, 1791043829.8, 1791045551.5]);
  });
});

describe('the far end, up the course axis', () => {
  // The finish line along x at lat 0, 111 m long; the wind from the north (up the course).
  const line: Line = { left: { lat: 0, lon: 0 }, right: { lat: 0, lon: 0.001 } };
  const lineAt = (): Line => line;
  const mid: LatLon = { lat: 0, lon: 0.0005 };
  const p = (east: number, north: number): LatLon => destination(destination(mid, 90, east), 0, north);
  // A boat goes 1.5 km upwind and back, finishes, then sails home 2 km cross-wind (further out than the windward
  // mark, as the crow flies) and crosses the line again on its way back to the harbor.
  const legs: [number, number, number][] = [
    [0, 0, -50],
    [6 * M, 0, 1500],
    [30 * M, 0, 1500],
    [50 * M, 0, -100],
    [55 * M, -2000, -150],
    [70 * M, -2000, -150],
    [80 * M, 0, 100],
  ];
  const fixes: Fix[] = [];
  for (let t = 0; t <= 80 * M; t += 5_000) {
    const i = legs.findIndex((l) => l[0] > t) - 1;
    const [t0, e0, n0] = legs[Math.max(0, i)];
    const [t1, e1, n1] = legs[i < 0 ? legs.length - 1 : i + 1];
    const k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    fixes.push({ ts: t, ...p(e0 + k * (e1 - e0), n0 + k * (n1 - n0)) });
  }
  // It crosses the line (northward-down) once on the way in, ~49.5 min, and again at ~79 min.
  const xIn = 30 * M + ((50 * M - 30 * M) * 1500) / 1600;

  it('finishes on the way in, not on the way home past the windward distance', () => {
    expect(alongDeg(p(-2000, -150), mid, 0)).toBeLessThan(0);
    expect(trackerFinish(fixes, lineAt, 0, 85 * M, null, null, 0)! / M).toBeCloseTo(xIn / M, 1);
    // No wind direction: square to the line, toward where the boat is a minute after the gun.
    expect(courseAxisDeg(line, null, [fixes], 0)).toBeCloseTo(0, 6);
    expect(trackerFinish(fixes, lineAt, 0, 85 * M, null)! / M).toBeCloseTo(xIn / M, 1);
    expect(courseAxisDeg(line, 45, [fixes], 0)).toBe(45);
    expect(courseAxisDeg(line, -90, [fixes], 0)).toBe(270);
  });
});

describe('finishEstimate primitives', () => {
  const o: LatLon = { lat: 38.95, lon: -76.43 };

  it('moves fixes forward to the bow along the course over ground', () => {
    const fx: Fix[] = [0, 1, 2].map((i) => ({ ts: i * 1000, ...destination(o, 200, 3 * i) }));
    const bow = bowFixes(fx, 2.65);
    for (let i = 0; i < 3; i++) expect(alongDeg(bow[i], fx[i], 200)).toBeCloseTo(2.65, 2);
    expect(bowFixes(fx, 0)).toEqual(fx);
  });

  it('fits to the most crossings, ties to the start line bearing; nothing when too few finishers cross', () => {
    // Boats sail south-west across a line from the committee boat on 124°, 20–80 m out.
    const boats = [20, 40, 60, 80].map((m) => {
      const x = destination(o, 124, m);
      return [-30, 30].map((s, i) => ({ ts: i * 20_000 + 10 * M, ...destination(x, 225, s) }));
    });
    const finishOf = (fx: readonly Fix[], la: (t: number) => Line): number | null => {
      const l = la(0);
      const a = alongDeg(fx[0], l.left, 225) < 0 && alongDeg(fx[1], l.left, 225) > 0;
      return a && Math.hypot(...metresFrom(destination(fx[0], 225, 30), l.left)) <= Math.hypot(...metresFrom(l.right, l.left)) + 1 ? 10 * M + 10_000 : null;
    };
    const fit = fitToCrossings(boats, () => o, 124, finishOf)!;
    expect(fit.bearingDeg).toBe(124);
    expect(fit.lengthM).toBeCloseTo(100, -1);
    const all = new Set(['a', 'b', 'c', 'd']);
    const est = estimateFinish({ boats: boats.map((fixes, i) => ({ id: 'abcd'[i], fixes, officialMs: null })), finishers: all, boatAt: () => o, baseDeg: 124, finishOf });
    expect(est?.finishes.size).toBe(4);
    const few = estimateFinish({ boats: boats.slice(0, 2).map((fixes, i) => ({ id: 'ab'[i], fixes, officialMs: null })), finishers: all, boatAt: () => o, baseDeg: 124, finishOf });
    expect(few).toBeNull();
  });
});

describe('the map: an estimated finish line', () => {
  const a = analyzeRace(fallbrawlRace('j70r3'));

  it('draws it dashed and labelled "Finish (est.)"; a real finish line stays plain', () => {
    const svg = trackMap(a, null);
    expect(svg).toMatch(/<line class="finishline est" [^>]*stroke-dasharray="[\d.]+ [\d.]+"\/>/);
    expect(svg).toContain('class="lbl est" text-anchor="start">Finish (est.)</text>');
    const plain = trackMap({ ...a, finishLineEstimated: undefined }, null);
    expect(plain).toContain('<line class="finishline" ');
    expect(plain).not.toContain('Finish (est.)');
    expect(plain).not.toContain('finishline est');
  });
});
