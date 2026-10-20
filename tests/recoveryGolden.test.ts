/**
 * Race recovery + official results goldens, offline on tests/fixtures/recovery
 * (scripts/make-recovery-fixtures.ts): J/105 CBC ↔ Yachtscoring 50575, AYC Fall Series
 * weekend 1 ↔ 50574, J/70 Worlds Cascais (not on Yachtscoring; Sailti as a test-only golden).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { fleetOnsetFloor, lineFrom, trackerFinish, type MarkSeries } from '../src/data/finishes';
import { linkOfficial, type LinkOutcome } from '../src/data/official/link';
import { sailFullKey, sailKey } from '../src/data/official/sail';
import { discoverOrphans, withOrphans } from '../src/data/orphans';
import { buildRaceList } from '../src/data/raceList';
import { buildRaceData, currentDoc, nextGunMs, parseTelemetry, snFromHex } from '../src/data/racesense/adapter';
import { linkRequest, linksOf, officialFor, orphanContexts, withDoc } from '../src/data/recovery';
import { startFitBox } from '../src/ui/charts';
import { raceHead, raceOptionText, raceTitleHtml } from '../src/ui/races';
import { j105Fixture } from './helpers';
import { finishFixture, fixtureYs, regatta, replayProbes, sailti } from './recoveryHelpers';

const linked = (o: LinkOutcome): Extract<LinkOutcome, { status: 'linked' }> => {
  if (o.status !== 'linked') throw new Error(`not linked: ${JSON.stringify(o)}`);
  return o;
};

describe('J/105 CBC 2026 ↔ Yachtscoring 50575', async () => {
  const doc = currentDoc(regatta('rs_j105.json'));
  const outcome = linked(await linkOfficial(fixtureYs(), linkRequest(doc, { venue: 'Annapolis, MD', startMs: 0, endMs: 0 })));
  const div = outcome.divisions[0];

  it('auto-matches 50575, class J/105 (circle J/105 CBC), EDT although Yachtscoring says -5', () => {
    expect(outcome).toMatchObject({ eventId: 50575, how: 'auto', tzOffsetMs: -4 * 3_600_000, unlinked: [] });
    expect(div.cls).toMatchObject({ circle: 'J/105 CBC', className: 'J/105' });
    expect(div.races.map((a) => [a.rsRace, a.official, a.by, a.deltaMs])).toEqual([
      [1, 1, 'gun', -1000],
      [2, 2, 'gun', -1000],
      [3, 3, 'gun', -1000],
    ]);
  });

  it('pairs all 18 boats, including "USA 322" (no prefix), " USA 313" and "Uni 29"', () => {
    expect(div.boats.pairs).toHaveLength(18);
    expect(div.boats.rsOnly).toEqual([]);
    expect(div.boats.ysOnly).toEqual([]);
    const ys = Object.fromEntries(div.boats.pairs.map((p) => [p.rs, p.ys]));
    expect(ys['USA 322']).toBe('USA 322');
    expect(ys['USA 313']).toBe('USA 313');
    expect(ys['USA 29']).toBe('Uni 29');
  });

  const list = buildRaceList(doc, { links: linksOf(outcome) });
  const raceData = (n: 1 | 3) => {
    const f = j105Fixture(n);
    const listed = list.races.find((r) => r.rsNumber === n)!;
    return buildRaceData(f.regatta, { division: 'J105', raceNumber: n }, [f.telemetry], {
      eventId: f.eventId,
      kind: 'fixture',
      official: officialFor(outcome, listed),
      nextGunMs: nextGunMs(currentDoc(f.regatta), { division: 'J105', raceNumber: n }),
    });
  };

  it('race 1: official places win (Patriot 1, Good Trade 2 with no RaceSense finish, Mirage 3); placeholder times rejected', () => {
    const d = raceData(1);
    const a = analyzeRace(d);
    const pos = Object.fromEntries(a.boats.map((b) => [b.sail, b.finishPos]));
    expect([pos['USA 242'], pos['USA 96'], pos['USA 328']]).toEqual([1, 2, 3]);
    // Exonerated OCS boats (RaceSense flagged them): officially 8th and 10th.
    expect([pos['USA 29'], pos['USA 517']]).toEqual([8, 10]);
    expect(d.boats.find((b) => b.sail === 'USA 29')!.ocs).toBe(false);
    expect(d.results).toMatchObject({ places: 'official', officialNumber: 1 });
    expect(d.results!.times).not.toBe('official');
    expect(d.results!.timesNote).toMatch(/outside the gun-to-next-gun window/);
    // Good Trade has no RaceSense finish: its time is its own finish-line crossing (~), or none.
    expect(['tracker', undefined]).toContain(d.boats.find((b) => b.sail === 'USA 96')!.finishSource);
    const head = raceHead({ race: list.races.find((r) => r.rsNumber === 1), official: { status: 'done', outcome }, feed: { status: 'idle', used: 0, max: 0, found: 0, exhausted: false }, results: d.results });
    expect(head.chips.map((c) => `${c.warn ? '⚠ ' : ''}${c.text}`)).toEqual(['official · YS 50575', expect.stringMatching(/^official places · (RaceSense|tracker) times$/)]);
  });

  it('race 3: Mirage 1st, Juggernaut (USA 322) DSQ', () => {
    const d = raceData(3);
    const a = analyzeRace(d);
    const b = (s: string) => a.boats.find((x) => x.sail === s)!;
    expect(b('USA 328').finishPos).toBe(1);
    const jug = a.boats.find((x) => x.sail === 'USA 322') ?? null;
    if (jug) expect([jug.finishPos, jug.finishCode]).toEqual([null, 'DSQ']);
    expect(d.boats.find((x) => x.sail === 'USA 322')?.officialCode ?? 'DSQ').toBe('DSQ');
    expect(d.results!.times).not.toBe('official');
  });

  it('labels races with the official number (RaceSense numbers are the same here)', () => {
    expect(list.races.map((r) => raceOptionText(r, false))).toEqual(['Race 3 · Sun 14:10', 'Race 2 · Sun 12:25', 'Race 1 · Sun 11:05']);
  });
});

describe('AYC Fall Series 2026 weekend 1 ↔ Yachtscoring 50574', async () => {
  const resp = regatta('rs_aycfs.json');
  const doc = currentDoc(resp);
  const outcome = linked(await linkOfficial(fixtureYs(), linkRequest(doc, { venue: 'Annapolis, MD', startMs: 0, endMs: 0 })));
  const j105 = outcome.divisions.find((d) => d.division === 'J105')!;
  const j70 = outcome.divisions.find((d) => d.division === 'J70')!;

  it('picks circle "FS Weekend 1 - Bay Course", not weekend 2, for both classes', () => {
    expect(outcome.eventId).toBe(50574);
    expect(j105.cls.key).toBe('FS Weekend 1 - Bay Course|J/105');
    expect(j70.cls.key).toBe('FS Weekend 1 - Bay Course|J/70');
  });

  it('J105 RaceSense 1–5 = official 1–5; the bogus race 6 (Oct 13, no line) is hidden', () => {
    expect(j105.races.map((a) => [a.rsRace, a.official, a.by])).toEqual([1, 2, 3, 4, 5].map((n) => [n, n, 'gun']));
    const list = buildRaceList(doc, { links: linksOf(outcome) });
    expect(list.hidden).toEqual([{ division: 'J105', raceNumber: 6, why: 'no recorded start line' }]);
  });

  it('J70 RaceSense 1 = official 2 by gun; official 1 has no RaceSense race', () => {
    expect(j70.races.map((a) => [a.rsRace, a.official])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    expect(j70.officialOnly).toEqual([{ number: 1, gunMs: Date.parse('2026-10-03T15:15:00Z') }]);
  });

  it('pairs "0005" ↔ USA 5, "251-L" ↔ USA 251, "US 351" ↔ USA 351, bare RaceSense "313" and "29"', () => {
    const p70 = Object.fromEntries(j70.boats.pairs.map((p) => [p.rs, p.ys]));
    const p105 = Object.fromEntries(j105.boats.pairs.map((p) => [p.rs, p.ys]));
    expect(p70['USA 5']).toBe('USA 0005');
    expect(p105['USA 251']).toBe('251-L');
    expect(p105['USA 351']).toBe('US 351');
    expect(p105['313']).toBe('USA 313');
    expect(p105['29']).toBe('Uni 29');
    expect([j105.boats.pairs.length, j105.boats.rsOnly, j105.boats.ysOnly]).toEqual([19, [], []]);
    expect([j70.boats.pairs.length, j70.boats.rsOnly, j70.boats.ysOnly]).toEqual([7, [], []]);
  });

  it('rebuilds J/70 official race 1 (Sat 11:15) at its official start: the J70 trackers never left pre_start', async () => {
    const list = buildRaceList(doc, { links: linksOf(outcome) });
    const replay = replayProbes('ayc_probes.json');
    const found = new Map();
    for (const ctx of orphanContexts(doc, list, outcome)) {
      const r = await discoverOrphans(ctx, replay.fetchRows);
      if (r.found.length) found.set(ctx.division, r.found);
    }
    expect(replay.calls.length).toBe(2);
    expect(found.get('J70')).toMatchObject([{ key: 202610031515, gunMs: Date.parse('2026-10-03T15:15:01Z'), gunFrom: 'official', officialNumber: 1 }]);
    const merged = withOrphans(doc, found);
    const listed = buildRaceList(merged, { links: linksOf(outcome), orphans: found }).races.filter((r) => r.division === 'J70');
    expect(listed.map((r) => raceOptionText(r, true)).reverse()).toEqual([
      'J70 · Race 1 · Sat 11:15 · rebuilt',
      'J70 · Race 2 · Sat 12:55 · RS 1',
      'J70 · Race 3 · Sat 14:10 · RS 2',
      'J70 · Race 4 · Sun 11:10 · RS 3',
      'J70 · Race 5 · Sun 12:25 · RS 4',
    ]);
    expect(listed.find((r) => r.officialNumber === 1)!.finishes).toBe('official');
  });

  it('J105 race 1: official places used; official times rejected (all 19 packed into 16:21–16:23Z, minutes off the line crossings)', async () => {
    const f = (await import('./recoveryHelpers')).readJson<{ eventId: string; telemetry: import('../src/data/racesense/types').TelemetryPage }>('ayc_j105_r1.json');
    const list = buildRaceList(doc, { links: linksOf(outcome) });
    const listed = list.races.find((r) => r.division === 'J105' && r.rsNumber === 1)!;
    expect(listed).toMatchObject({ number: 1, numbering: 'official', finishes: 'official' });
    const d = buildRaceData(resp, { division: 'J105', raceNumber: 1 }, [f.telemetry], { kind: 'fixture', official: officialFor(outcome, listed), nextGunMs: nextGunMs(doc, { division: 'J105', raceNumber: 1 }) });
    expect(d.results).toMatchObject({ places: 'official', officialNumber: 1 });
    expect(d.results!.times).not.toBe('official');
    const a = analyzeRace(d);
    const pos = Object.fromEntries(a.boats.map((b) => [sailKey(b.sail), b.finishPos]));
    expect([pos['96'], pos['29'], pos['351'], pos['242']]).toEqual([1, 2, 3, 4]);
  });
});

describe('J/70 Worlds 2026 Cascais (no Yachtscoring event)', async () => {
  const resp = regatta('rs_j70.json');
  const doc = currentDoc(resp);
  const outcome = await linkOfficial(fixtureYs(), linkRequest(doc, { venue: 'Cascais, Portugal', startMs: 0, endMs: 0 }));
  const replay = replayProbes('j70_probes.json');
  const [ctx] = orphanContexts(doc, buildRaceList(doc), null);
  const res = await discoverOrphans(ctx, replay.fetchRows);
  const found = new Map([['Open', res.found]]);
  const merged = withOrphans(doc, found);
  const list = buildRaceList(merged, { orphans: found });

  it('finds no official match (search by dates, then by name)', () => {
    expect(outcome).toMatchObject({ status: 'none', reason: 'no-match' });
  });

  it('recovers official race 4 (Wed, feed race 5 restarted) and 8 (Fri 09:55:00 EDT) within budget', () => {
    expect(res.exhausted).toBe(false);
    expect(res.used).toBeLessThanOrEqual(48);
    expect(res.found.map((f) => [new Date(f.trueGunMs).toISOString(), f.feedRaceNumber, f.how])).toEqual([
      ['2026-09-09T16:20:01.000Z', 5, 'after-last'], // OR4: 12:20:01 EDT (17:20 Lisbon) from the feed: the restart (the ~14:34Z attempt was abandoned)
      ['2026-09-11T13:55:00.000Z', 8, 'after-last'], // OR8: the RO's .vkx timer says 09:55:00 EDT
    ]);
    expect(res.found.map((f) => f.key)).toEqual([202609091620, 202609111355]);
    expect(Math.abs(res.found[1].trueGunMs - Date.parse('2026-09-11T13:55:00Z'))).toBeLessThanOrEqual(2000);
  });

  it('lists 10 races + 1 practice, numbered in order (unofficial), RaceSense numbers kept for transparency', () => {
    expect(list.races.map((r) => raceOptionText(r, false)).reverse()).toEqual([
      'Practice · Mon 09:55 · RS 1',
      'Race 1 · Tue 08:05 · RS 2',
      'Race 2 · Tue 09:55 · RS 3',
      'Race 3 · Wed 08:55 · RS 4 · ~ tracker',
      'Race 4 · Wed 12:20 · rebuilt',
      'Race 5 · Thu 08:50',
      'Race 6 · Thu 11:10',
      'Race 7 · Fri 08:05 · ~ tracker',
      'Race 8 · Fri 09:55 · rebuilt',
      'Race 9 · Sat 08:15 · RS 8',
      'Race 10 · Sat 10:05 · RS 9',
    ]);
    const head = raceHead({ race: list.races.find((r) => r.number === 4), official: { status: 'done', outcome }, feed: { status: 'done', used: res.used, max: 48, found: 2, exhausted: false } });
    expect(head.chips.map((c) => `${c.warn ? '⚠ ' : ''}${c.text}`)).toEqual(['⚠ no official results linked', '⚠ rebuilt from the feed', '⚠ unofficial numbering', '2 races rebuilt']);
  });

  it('relabels the race header with the list (title and RS tag), not only the picker', () => {
    const before = buildRaceList(doc).races.find((r) => r.rsNumber === 9)!;
    const after = list.races.find((r) => r.rsNumber === 9)!;
    const m = { eventName: 'Cascais J/70 World Championship', boatClass: 'J/70', raceNumber: 9 };
    expect(raceTitleHtml(m, before)).toBe('<h2>Cascais J/70 World Championship · J/70 · Race 8 <span class="rs-no">RS 9</span></h2>');
    expect(raceTitleHtml(m, after)).toBe('<h2>Cascais J/70 World Championship · J/70 · Race 10 <span class="rs-no">RS 9</span></h2>');
    expect(raceTitleHtml(m, list.races.find((r) => r.rsNumber === 7))).toContain('· Race 7</h2>');
    // The app re-runs the whole header (title, tag, #race-head chips) whenever the list is relabelled.
    const app = readFileSync(fileURLToPath(new URL('../src/ui/app.ts', import.meta.url)), 'utf8');
    const refresh = app.slice(app.indexOf('function refreshList('), app.indexOf('function reapplyOfficial('));
    expect(refresh).toContain('renderSummary();');
    const summary = app.slice(app.indexOf('function renderSummary('), app.indexOf('function render(): void'));
    expect(summary).toContain('raceTitleHtml(m, listed)');
    expect(summary).toContain('renderRaceHead();');
    const load = app.slice(app.indexOf('async function loadEvent'), app.indexOf('const titleOf'));
    expect(load.indexOf('renderRaceOptions()')).toBeGreaterThan(0);
    expect(load.indexOf('renderRaceOptions()')).toBeLessThan(load.indexOf('const enrichment = enrich('));
    expect(load).toContain('The picker is on screen before official matching or the feed probe');
  });

  it('sets aside boats far from the start in a rebuilt race (official race 4: three DNC boats 4.9 km away)', () => {
    const f = finishFixture('or4');
    const key = res.found[0].key;
    const d = buildRaceData(withDoc(resp, merged), { division: 'Open', raceNumber: key }, [f.atGun!, f.telemetry], { kind: 'fixture', nextGunMs: nextGunMs(merged, { division: 'Open', raceNumber: key }) });
    const away = d.boats.filter((b) => b.notRacing).map((b) => b.sail).sort();
    expect(away).toEqual(['GBR 1591', 'POL 1588', 'TUR 442']);
    for (const b of d.boats.filter((x) => x.notRacing)) expect(b.notRacing).toMatch(/^Not near the start \(closest [4-5]\.\d km\) and no finish$/);
    const a = analyzeRace(d);
    expect(a.excluded.map((e) => e.result.sail).sort()).toEqual(away);
    expect(a.drawings.some((x) => away.includes(x.id))).toBe(false);
    // The Fit view frames the line and the racing boats, not boats 4.9 km off.
    const box = startFitBox(a);
    expect(Math.max(box.x1 - box.x0, box.y1 - box.y0)).toBeLessThan(1500);
  });

  it('analyses a rebuilt race with the existing pipeline (official race 8)', () => {
    const f = finishFixture('or8');
    const key = res.found[1].key;
    const d = buildRaceData(withDoc(resp, merged), { division: 'Open', raceNumber: key }, [f.atGun!, f.telemetry], { kind: 'fixture', nextGunMs: nextGunMs(merged, { division: 'Open', raceNumber: key }) });
    expect(d.gunMs).toBe(Date.parse('2026-09-11T13:55:01Z'));
    expect(d.results).toMatchObject({ places: 'tracker' });
    const a = analyzeRace(d);
    expect(a.boats.length).toBeGreaterThanOrEqual(8);
    expect(a.boats.filter((b) => b.finishSource === 'tracker').length).toBeGreaterThanOrEqual(8);
  });

  // Tracker places against Sailti's official places, over the boats in each fixture.
  const agreement = (label: 'or3' | 'or4' | 'or7' | 'or8') => {
    const f = finishFixture(label);
    const rows = parseTelemetry([f.telemetry]);
    const ser = (hex: string): MarkSeries => {
      const sn = snFromHex(hex);
      const m = rows.filter((r) => r.role === 'mark' && r.sn === sn);
      return { t: m.map((r) => r.ts), lat: m.map((r) => r.lat), lon: m.map((r) => r.lon) };
    };
    const line = lineFrom(ser('0238006457'), ser('0238006427'));
    const bySail = new Map<string, typeof rows>();
    for (const r of rows) if (r.role === 'competitor') (bySail.get(r.sail) ?? bySail.set(r.sail, []).get(r.sail)!).push(r);
    const official = new Map(sailti().map((b) => [sailFullKey(b.sail) || sailKey(b.sail), b.races[f.official - 1]]));
    const pairs: { sail: string; t: number; pts: number }[] = [];
    const floor = fleetOnsetFloor(bySail.values(), f.gunMs, f.feedRaceNumber);
    for (const [sail, fx] of bySail) {
      const t = trackerFinish(fx, line, f.gunMs, f.endMs, f.feedRaceNumber, floor);
      const o = official.get(sailFullKey(sail) || sailKey(sail));
      if (t == null || !o || o.code) continue;
      pairs.push({ sail, t, pts: o.points });
    }
    const rank = (xs: number[]): number[] => {
      const o = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
      const r = new Array<number>(xs.length);
      o.forEach(([, i], k) => (r[i] = k + 1));
      return r;
    };
    const rt = rank(pairs.map((p) => p.t));
    const ro = rank(pairs.map((p) => p.pts));
    const n = pairs.length;
    const exact = rt.filter((x, i) => x === ro[i]).length;
    const within2 = rt.filter((x, i) => Math.abs(x - ro[i]) <= 2).length;
    const spearman = 1 - (6 * rt.reduce((s, x, i) => s + (x - ro[i]) ** 2, 0)) / (n * (n * n - 1));
    const worst = pairs.map((p, i) => ({ sail: p.sail, tracker: rt[i], official: ro[i] })).sort((a, b) => Math.abs(b.tracker - b.official) - Math.abs(a.tracker - a.official))[0];
    return { n, exact, within2, spearman, worst };
  };

  for (const label of ['or3', 'or4', 'or7', 'or8'] as const) {
    it(`tracker places agree with Sailti's official places (${label.toUpperCase()})`, () => {
      const g = agreement(label);
      console.log(`J/70 ${label.toUpperCase()}: n=${g.n} exact=${g.exact} (${((100 * g.exact) / g.n).toFixed(0)}%) ±2=${g.within2} (${((100 * g.within2) / g.n).toFixed(0)}%) spearman=${g.spearman.toFixed(3)} worst=${JSON.stringify(g.worst)}`);
      expect(g.n).toBeGreaterThanOrEqual(40);
      expect(g.spearman).toBeGreaterThanOrEqual(0.95);
      expect(g.within2 / g.n).toBeGreaterThanOrEqual(0.95);
    });
  }
});
