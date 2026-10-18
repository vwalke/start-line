import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { classifyParticipation, nameHint, placeholderSail } from '../src/analysis/participation';
import type { RaceAnalysis } from '../src/analysis/types';
import { buildRaceData } from '../src/data/racesense/adapter';
import type { Boat, RaceData } from '../src/data/types';
import { boatList } from '../src/ui/boats';
import { pickedExcluded, startSnapshot, trackMap } from '../src/ui/charts';
import { parsePickerParams } from '../src/ui/params';
import { startSogRange, trackSogRange } from '../src/ui/sog';
import { metricsTable } from '../src/ui/table';
import { c31Race, fixtureRace, j88Race, m24Race, type Fixture } from './helpers';

const NON_COMPETITORS = ['03', '07', '10', 'SPARE 1'];
const ids = (a: RaceAnalysis): string[] => a.boats.map((b) => b.id).sort();
const excludedIds = (a: RaceAnalysis): string[] => a.excluded.map((e) => e.result.id).sort();
const reasonsOf = (a: RaceAnalysis, id: string): string[] => a.excluded.find((e) => e.result.id === id)?.reasons ?? [];

/** The M24 fixture with its regatta edited first (e.g. to drop a boat's results). */
function m24With(edit: (f: Fixture) => void): RaceData {
  const f = JSON.parse(readFileSync(new URL('./fixtures/m24_r4.json', import.meta.url), 'utf8')) as Fixture;
  edit(f);
  return buildRaceData(f.regatta, { division: 'M24', raceNumber: 4 }, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind });
}
const m24Div = (f: Fixture) => f.regatta.revisions.at(-1)!.doc.divisions[0];

/** Replace one boat in the race data. */
const withBoat = (d: RaceData, id: string, fn: (b: Boat) => Boat): RaceData => ({ ...d, boats: d.boats.map((b) => (b.id === id ? fn(b) : b)) });

/** A boat on its own water (shifted ~600 m) at 2.5× a real boat's speeds: a coach RIB. */
function motorboat(src: Boat, id: string, name: string, dLat = 0.0055): Boat {
  const tr = src.track;
  return {
    ...src,
    id,
    sail: id,
    name,
    bowNumber: undefined,
    finishMs: null,
    entry: undefined,
    track: { ...tr, lat: tr.lat.map((x) => x + dLat), sog: tr.sog.map((v) => v * 2.5) },
  };
}

describe('Melges 24 Worlds race 4: coaches and the spare tracker', () => {
  const data = m24Race();
  const a = analyzeRace(data);

  it('reads the event-wide results from the regatta', () => {
    const e = (id: string) => data.boats.find((b) => b.id === id)!.entry!;
    expect(e('03')).toEqual({ racesWithResults: 13, plausibleFinishes: 0, finishPlausible: null });
    // SPARE 1 "finished" races 4, 7 and 11; 7 and 11 after 1.3 and 2.2 km against the fleet's ~12 km.
    expect(e('SPARE 1')).toMatchObject({ racesWithResults: 13, plausibleFinishes: 1, finishPlausible: true });
    expect(e('870').plausibleFinishes).toBeGreaterThanOrEqual(9);
  });

  it('sets the coaches aside for no results and motorboat speeds', () => {
    expect(excludedIds(a)).toEqual([...NON_COMPETITORS].sort());
    for (const id of ['03', '07', '10']) {
      const r = reasonsOf(a, id);
      expect(r[0]).toBe('No finish in 13 races');
      expect(r.some((x) => /^Motorboat speeds \(max \d+ kt\)$/.test(x))).toBe(true);
      expect(r).toContain('Name suggests a support boat');
    }
  });

  it('sets SPARE 1 aside as a second tracker on 619, which stays ranked', () => {
    expect(reasonsOf(a, 'SPARE 1')).toEqual(['Second tracker on 619 Hot Water']);
    const hw = a.boats.find((b) => b.id === '619')!;
    expect(hw.finishPos).not.toBeNull();
    expect(hw.colorSlot).toBeGreaterThanOrEqual(0);
  });

  it('keeps the non-competitors out of the ranked boats, drawings and findings', () => {
    for (const id of NON_COMPETITORS) {
      expect(a.boats.some((b) => b.id === id)).toBe(false);
      expect(a.drawings.some((d) => d.id === id)).toBe(false);
      expect(a.findings.some((f) => f.boatIds?.includes(id))).toBe(false);
    }
    expect(a.boats).toHaveLength(13);
    for (const e of a.excluded) {
      expect(e.result.colorSlot).toBe(-1);
      expect(e.result.finishPos).toBeNull();
      expect(e.result.legs.every((l) => l == null)).toBe(true);
      expect(e.result.start?.startPlace ?? null).toBeNull();
    }
    expect(a.warnings.at(-1)).toBe('4 boats hidden as not racing (coach boats, spare or second trackers); they are listed at the foot of the boat list.');
  });

  it("doesn't change any rank, leg or finding (same as without those boats in the feed)", () => {
    const b = analyzeRace({ ...data, boats: data.boats.filter((x) => !NON_COMPETITORS.includes(x.id)) });
    expect(b.excluded).toEqual([]);
    expect(ids(a)).toEqual(ids(b));
    const ranks = (x: RaceAnalysis) =>
      x.boats.map((r) => [r.id, r.finishPos, r.colorSlot, r.start?.startPlace, r.start?.dtlM, r.legs.map((l) => l?.rankAtEnd ?? null), r.distNm]);
    expect(ranks(a)).toEqual(ranks(b));
    expect(a.legs).toEqual(b.legs);
    expect(a.legSource).toBe(b.legSource);
    expect(a.wind.twdAtGunDeg).toBe(b.wind.twdAtGunDeg);
    expect(a.marks).toEqual(b.marks);
    expect(a.findings).toEqual(b.findings);
    expect(a.warnings.slice(0, -1)).toEqual(b.warnings);
  });

  it('nc=all keeps everyone as a competitor (the old behaviour)', () => {
    expect(parsePickerParams('?event=X&div=M24&race=4&nc=all')).toEqual({ eventId: 'X', want: { division: 'M24', raceNumber: 4 }, allCompetitors: true });
    expect(parsePickerParams('?nc=other').allCompetitors).toBeUndefined();
    const all = analyzeRace(data, { allCompetitors: true });
    expect(all.excluded).toEqual([]);
    expect(all.boats).toHaveLength(17);
    expect(all.allCompetitors).toEqual({ flagged: 4 });
    expect(boatList(all, null)).toContain('data-nc="auto"');
    expect(all.warnings.join(' ')).not.toMatch(/hidden as not racing/);
  });
});

describe('a name alone never sets a boat aside', () => {
  const data = m24Race();

  it('a real competitor renamed "Coach" stays and keeps its rank', () => {
    const base = analyzeRace(data).boats.find((b) => b.id === '870')!;
    const a = analyzeRace(withBoat(data, '870', (b) => ({ ...b, name: 'Coach' })));
    const r = a.boats.find((b) => b.id === '870')!;
    expect(r.name).toBe('Coach');
    expect(r.finishPos).toBe(base.finishPos);
    expect(r.start?.startPlace).toBe(base.start?.startPlace);
    expect(excludedIds(a)).toEqual([...NON_COMPETITORS].sort());
  });

  it('a "Coach" with no results that sails like the fleet stays (name only)', () => {
    // No finish here or anywhere, and no event results (a .vkx-like source): only the name hints.
    const a = analyzeRace(withBoat(data, '491', (b) => ({ ...b, name: 'Coach Spare RC', finishMs: null, entry: undefined })));
    expect(a.boats.some((b) => b.id === '491')).toBe(true);
    // …and with the event's results saying it never finished, its normal track still keeps it.
    const c = classifyParticipation(withBoat(data, '491', (b) => ({ ...b, name: 'Coach', finishMs: null })));
    expect(c.get('491')!.status).toBe('competitor');
  });

  it('matches whole words and placeholder sails only', () => {
    expect(nameHint({ name: 'Coach Mustang', sail: '10' })).toBe('Name suggests a support boat');
    expect(nameHint({ name: 'Hot Water', sail: '619', bowNumber: 'SPARE 1' })).toBe('Name suggests a support boat');
    expect(nameHint({ name: 'Coachella', sail: '12' })).toBeNull();
    expect(nameHint({ name: 'Marker', sail: 'GBR 7' })).toBeNull();
    expect(placeholderSail('USA 0000')).toBe(true);
    expect(placeholderSail('USA 2222')).toBe(true);
    expect(placeholderSail('001')).toBe(false);
    expect(placeholderSail('0')).toBe(true);
    expect(placeholderSail('77')).toBe(false);
    expect(placeholderSail('NED 7753')).toBe(false);
  });
});

describe('behaviour, not names', () => {
  const data = m24Race();
  const src = data.boats.find((b) => b.id === '491')!;

  it('sets aside a "Coach" motorboat with no results', () => {
    const boat = motorboat(src, 'X1', 'Coach');
    boat.entry = { racesWithResults: 13, plausibleFinishes: 0, finishPlausible: null };
    const a = analyzeRace({ ...data, boats: [...data.boats, boat] });
    expect(reasonsOf(a, 'X1')[0]).toBe('No finish in 13 races');
    expect(reasonsOf(a, 'X1').some((r) => r.startsWith('Motorboat speeds'))).toBe(true);
  });

  it('with too few races to judge results, needs behaviour and a name together', () => {
    const named = motorboat(src, 'X2', 'Coach');
    // Apart from X2, so the two aren't one boat's two trackers.
    const plain = motorboat(src, 'X3', 'Fast Boat', -0.0055);
    const c = classifyParticipation({ ...data, boats: [...data.boats, named, plain] });
    expect(c.get('X2')).toEqual({ status: 'non-competitor', reasons: [expect.stringMatching(/^Motorboat speeds/), 'Name suggests a support boat'] });
    expect(c.get('X3')!.status).toBe('competitor');
  });

  it('keeps a real boat with few results that races normally', () => {
    // 491's other races emptied: one plausible finish in 13 races (low results), but it sails and finishes here.
    const d = m24With((f) => {
      for (const r of m24Div(f).races) if (r.raceNumber !== 4) r.finishes = r.finishes.filter((x) => x.sailNumber !== '491');
    });
    const b = d.boats.find((x) => x.id === '491')!;
    expect(b.entry).toMatchObject({ racesWithResults: 13, plausibleFinishes: 1, finishPlausible: true });
    const a = analyzeRace(d);
    expect(a.boats.find((x) => x.id === '491')!.finishPos).not.toBeNull();
    // Even without its finish here, no behaviour or name signal sets it aside.
    const noFinish = withBoat(d, '491', (x) => ({ ...x, finishMs: null }));
    expect(classifyParticipation(noFinish).get('491')!.status).toBe('competitor');
  });

  it("doesn't rank an implausible finish, but keeps the boat", () => {
    const d = m24With((f) => {
      const r4 = m24Div(f).races.find((r) => r.raceNumber === 4)!;
      r4.finishes.find((x) => x.sailNumber === '491')!.distanceTraveled = 1200;
    });
    const b = d.boats.find((x) => x.id === '491')!;
    expect(b.finishMs).not.toBeNull();
    expect(b.entry!.finishPlausible).toBe(false);
    const a = analyzeRace(d);
    const r = a.boats.find((x) => x.id === '491')!;
    expect(r.finishPos).toBeNull();
    expect(a.warnings.find((w) => w.startsWith('Not ranking'))).toMatch(
      /^Not ranking #491 \(Huzzah\)'s finish: the feed has it sailing 1\.2 km against the fleet's 1\d\.\d km\.$/,
    );
  });
});

describe('picking a boat that is not racing', () => {
  const a = analyzeRace(m24Race());
  const spare = 'SPARE 1';

  it('lists them in a collapsed sidebar group with the reasons', () => {
    const html = boatList(a, null);
    expect(html).toContain('<details class="nc-group"><summary>Not racing (4)</summary>');
    expect(html).toContain('title="#SPARE 1, not racing: Second tracker on 619 Hot Water"');
    expect(html).toContain('data-nc="all"');
    expect(boatList(a, spare)).toContain('<details class="nc-group" open>');
    expect(boatList(analyzeRace(fixtureRace()), null)).not.toContain('nc-group');
  });

  it('draws it grey and dashed only when picked', () => {
    expect(pickedExcluded(a, null)).toBeNull();
    expect(pickedExcluded(a, '870')).toBeNull();
    const nc = pickedExcluded(a, '03')!;
    expect(nc.drawing.segments.map((s) => s.leg)).toEqual(a.legs.map((l) => l.index));
    expect(trackMap(a, null)).not.toContain('trk on nc');
    expect(trackMap(a, '03')).toMatch(/<polyline class="trk on nc"[^>]*stroke="var\(--ink-3\)" stroke-dasharray/);
    // The fit stays the fleet's.
    expect(trackMap(a, '03').slice(0, 120)).toBe(trackMap(a, null).slice(0, 120));
    expect(startSnapshot(a, null)).not.toContain('data-id="03"');
    expect(startSnapshot(a, '03')).toMatch(/<g class="boat[^"]* nc" data-id="03">/);
  });

  it('in Rank, ranks only competitors; a picked non-competitor stays grey and unranked', () => {
    const of = a.boats.filter((b) => b.finishPos != null).length;
    const svg = trackMap(a, '03', null, { colour: 'rank', rankBy: 'overall' });
    expect(svg).toMatch(/<polyline class="trk on nc"[^>]*stroke="var\(--ink-3\)" stroke-dasharray/);
    expect(svg).toContain('not racing');
    expect(svg).not.toMatch(/data-id="03"[^>]*(?:stroke="#[0-9a-f]{6}"|overall #)/);
    expect(svg).toContain(`overall #1 of ${of}`);
    expect(svg).not.toContain(`#1 of ${of + 1}`);
  });

  it('in Boat speed, leaves excluded boats out of the scale and keeps a pick grey and dashed', () => {
    const data = m24Race();
    const without = analyzeRace({ ...data, boats: data.boats.filter((b) => !NON_COMPETITORS.includes(b.id)) });
    expect(trackSogRange(a, null)).toEqual(trackSogRange(without, null));
    for (const l of a.legs) expect(trackSogRange(a, l.index)).toEqual(trackSogRange(without, l.index));
    expect(startSogRange(a)).toEqual(startSogRange(without));
    const svg = trackMap(a, '03', null, { colour: 'sog' });
    expect(svg).toMatch(/<polyline class="trk on nc"[^>]*stroke="var\(--ink-3\)" stroke-dasharray/);
    expect(svg).toContain('not racing');
    expect(svg).not.toMatch(/<g class="sog-trk[^"]*" data-id="03"/);
    const start = startSnapshot(a, '03', undefined, 'speed');
    expect(start).toMatch(/<g class="boat[^"]* nc" data-id="03">/);
    expect(start).toMatch(/<polyline class="trail nc"[^>]*stroke="var\(--ink-3\)"/);
    expect(start).toMatch(/<polyline class="trail nc"[^>]*stroke-dasharray="/);
    expect(start).not.toMatch(/data-id="03"[^>]*sog-fill/);
    const g = start.match(/<g class="boat[^"]* nc" data-id="03">[\s\S]*?<\/g><\/g>/)?.[0] ?? '';
    expect(g).toContain('(not racing)');
    expect(g).not.toContain('sog-fill');
  });

  it('adds one unranked row at the foot of the table, leaving the rest as they were', () => {
    const plain = metricsTable(a, null);
    const picked = metricsTable(a, spare);
    const rows = picked.match(/<tr data-id="[^"]*"/g)!;
    expect(rows).toHaveLength(a.boats.length + 1);
    expect(rows.at(-1)).toBe(`<tr data-id="${spare}"`);
    expect(picked).toContain('<tr data-id="SPARE 1" class="sel nc"');
    expect(picked).toContain('not racing</span>');
    const row = picked.slice(picked.indexOf('<tr data-id="SPARE 1"'));
    expect(row).not.toMatch(/class="ic"/);
    expect(row).not.toContain('>OCS<');
    expect(picked.replace(/<tr data-id="SPARE 1"[\s\S]*?<\/tr>/, '')).toBe(plain);
    // Sorting doesn't move it off the foot.
    const sorted = metricsTable(a, spare, { key: 'boat', dir: 'desc' });
    expect(sorted.match(/<tr data-id="[^"]*"/g)!.at(-1)).toBe(`<tr data-id="${spare}"`);
  });
});

describe('fleets without support boats', () => {
  it.each([
    ['Benelux J70 race 8', fixtureRace],
    ['C31 race 10', () => c31Race()],
    ['J/88 race 5', j88Race],
  ])('%s: nobody is set aside', (_name, race) => {
    const a = analyzeRace(race());
    expect(a.excluded).toEqual([]);
    expect(a.warnings.join(' ')).not.toMatch(/not racing/);
  });
});
