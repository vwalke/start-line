import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { placeChanges } from '../src/analysis/places';
import type { RaceAnalysis } from '../src/analysis/types';
import { buildRaceData, currentDoc, findRace } from '../src/data/racesense/adapter';
import { boatList } from '../src/ui/boats';
import { raceHead } from '../src/ui/races';
import { scrubWindow } from '../src/ui/scrub';
import { legsTable } from '../src/ui/table';
import { loadFixture } from './helpers';

const ref = { division: 'J70', raceNumber: 8 };

/** Benelux race 8 as if `cutMin` minutes after its gun: no finishes in the feed yet, the fixes up to then. */
function inProgress(cutMin: number, live: boolean): { a: RaceAnalysis; gun: number; lastFix: number } {
  const f = structuredClone(loadFixture());
  const race = findRace(currentDoc(f.regatta), ref).race;
  const gun = race.starts.at(-1)!.startTime!;
  race.finishes = [];
  (race as { endTime?: unknown }).endTime = null;
  for (const s of race.starts) (s as { stopReason?: unknown }).stopReason = null;
  const ts = f.telemetry.Fields!.indexOf('ts');
  f.telemetry.Rows = f.telemetry.Rows!.filter((r) => Number(r[ts]) <= gun + cutMin * 60_000);
  const data = buildRaceData(f.regatta, ref, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind });
  const a = analyzeRace(data, live ? { inProgress: true } : {});
  const racing = new Set(a.boats.filter((b) => b.colorSlot >= 0).map((b) => b.id));
  const lastFix = Math.max(...data.boats.filter((b) => racing.has(b.id)).map((b) => b.track.t[b.track.t.length - 1]));
  return { a, gun, lastFix };
}

const finished = (): RaceAnalysis => {
  const f = loadFixture();
  return analyzeRace(buildRaceData(f.regatta, ref, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind }));
};

describe('a race in progress: the race viewer runs to the newest fix', () => {
  it('before any rounding (the live J/70 NAs race 8 case): the tracks drew nothing after the gun; now to the newest fix', () => {
    const before = inProgress(3, false);
    expect(scrubWindow(before.a).t1).toBe(before.gun);
    const { a, lastFix } = inProgress(3, true);
    expect(a.meta.inProgress).toBe(true);
    expect(scrubWindow(a).t1).toBe(lastFix);
    for (const d of a.drawings) if (a.boats.find((b) => b.id === d.id)!.colorSlot >= 0) expect(d.segments.length).toBeGreaterThan(0);
  });

  it('mid-race: each boat’s open leg is drawn to its own newest fix', () => {
    const { a, lastFix } = inProgress(10, true);
    expect(scrubWindow(a).t1).toBe(lastFix);
    const ends = a.drawings.map((d) => d.segments.at(-1)?.t.at(-1) ?? 0);
    expect(Math.min(...ends.filter((t) => t > 0))).toBeGreaterThan(lastFix - 60_000);
  });

  it('a finished race draws exactly as before', () => {
    const a = finished();
    expect(a.meta.inProgress).toBeUndefined();
    const f = loadFixture();
    const again = analyzeRace(buildRaceData(f.regatta, ref, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind }), { inProgress: false });
    expect(again.drawings).toEqual(a.drawings);
  });
});

describe('a race in progress reads as racing, not DNF', () => {
  const { a } = inProgress(10, true);
  const done = finished();
  const noFinish = (x: RaceAnalysis) => x.boats.filter((b) => b.colorSlot >= 0 && b.finishPos == null && !b.finishCode);

  it('boat list and Fin column: "racing", never DNF', () => {
    expect(noFinish(a).length).toBeGreaterThan(0);
    const list = boatList(a, null);
    expect(list).not.toContain('DNF');
    expect(list).not.toContain('did not finish');
    expect(list).toContain('<span class="pos">racing</span>');
    const table = legsTable(a, null, null);
    expect(table).not.toMatch(/>DNF</);
    expect(table).toContain('racing = no finish yet');
  });

  it('places chart: no boat marked as not finishing', () => {
    expect(placeChanges(a).boats.some((b) => b.dnf)).toBe(false);
  });

  it('race header: no "no finishes" warning while in progress; as before once over', () => {
    const head = (inProgressNow: boolean) =>
      raceHead({ race: undefined, official: { status: 'off' }, feed: { status: 'idle', used: 0, max: 0, found: 0, exhausted: false }, results: a.meta.results, inProgress: inProgressNow });
    expect(a.meta.results).toMatchObject({ places: 'tracker', trackerFinishes: 0 });
    expect(head(true).chips.map((c) => c.text)).not.toContain('no finishes');
    expect(head(false).chips.map((c) => c.text)).toContain('no finishes');
  });

  it('once complete (the flag off) a boat with no finish is a DNF exactly as before', () => {
    const over: RaceAnalysis = { ...a, meta: { ...a.meta, inProgress: false } };
    expect(boatList(over, null)).toContain('<span class="pos">DNF</span>');
    expect(legsTable(over, null, null)).toMatch(/>DNF</);
    expect(placeChanges(over).boats.some((b) => b.dnf)).toBe(true);
    // A finished race's labels don't change.
    const list = boatList(done, null);
    expect(list).not.toContain('racing');
  });
});
