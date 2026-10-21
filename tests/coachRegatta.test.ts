/**
 * The Coach tab follows the app's race and boat (no pickers of its own), and its Regatta view:
 * every race the race menu offers (practice out, rebuilt and tracker-only races in), analysed one
 * at a time on a worker of its own from a cold start, summed up by analysis/coach/regatta.ts.
 * Offline: J/105 CBC (linked to Yachtscoring 50575) and J/70 Worlds Cascais fixtures, and
 * hand-made digests for the rules.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import {
  LOW_COVERAGE,
  MIN_WEIGHT,
  coverageWeight,
  digestRace,
  raceDigest,
  summarizeRegatta,
  themeKey,
  type FindingDigest,
  type LegDigest,
  type RaceDigest,
  type RaceFinish,
  type RegattaRace,
} from '../src/analysis/coach/regatta';
import type { BoatResult, RaceAnalysis } from '../src/analysis/types';
import { linkOfficial, type OfficialResultRow } from '../src/data/official/link';
import { discoverOrphans, withOrphans } from '../src/data/orphans';
import { buildRaceList } from '../src/data/raceList';
import { buildRaceData, currentDoc, nextGunMs } from '../src/data/racesense/adapter';
import { linkRequest, linksOf, officialFor, orphanContexts, withDoc } from '../src/data/recovery';
import { coachBoatFor, coachNoBoatHtml, coachViewHtml, parseCoachView } from '../src/ui/coach';
import { createRegattaRunner, finishShort, regattaHtml, regattaJobs, regattaPlacesHtml, regattaViewHtml, type RegattaJob, type WorkerPort } from '../src/ui/coachRegatta';
import { parseLastView, resolveStart, serializeLastView, startTab, type LastView } from '../src/ui/lastView';
import { parsePickerParams } from '../src/ui/params';
import { raceOptionText } from '../src/ui/races';
import { TABS, initialTab, parseTab, tabForKey, tabFromHash } from '../src/ui/tabs';
import type { WorkerRequest, WorkerResponse } from '../src/worker';
import { j105Fixture } from './helpers';
import { fixtureYs, regatta, replayProbes } from './recoveryHelpers';

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// ---- hand-made digests

const fin = (place: number | null, of = 20, source: RaceFinish['source'] = 'official', code: string | null = null): RaceFinish => ({ place, code, of, source });
const finding = (kind: FindingDigest['kind'], variant: string, seconds: number): FindingDigest => ({ theme: themeKey(kind, variant), kind, variant, seconds, confidence: 'high' });
const leg = (k: number, kind: LegDigest['kind'], deltaS: number, extra: Partial<LegDigest> = {}): LegDigest => ({ leg: k, name: `${kind === 'upwind' ? 'Beat' : kind === 'downwind' ? 'Run' : 'Reach'} ${k}`, kind, deltaS, rank: 5, of: 20, coverage: 1, timingGap: false, ...extra });
const digest = (n: number, extra: Partial<RaceDigest> = {}): RaceDigest => ({ raceNumber: n, sail: 'USA 833', tracked: true, finish: fin(n), coverage: 1, noData: false, legs: [], findings: [], ...extra });
const done = (n: number, d: Partial<RaceDigest> = {}): RegattaRace => ({ raceNumber: n, label: `R${n}`, name: `Race ${n}`, status: 'done', digest: digest(n, d) });

describe('the Coach panel follows the app: no race chips, no boat select', () => {
  it('its top line is the Race | Regatta toggle only', () => {
    for (const v of ['race', 'regatta'] as const) {
      const html = coachViewHtml(v);
      expect(html).not.toMatch(/<select|data-coach-race|Weekend|coach-boat/);
      expect(html).toContain(`data-coach-view="${v}" aria-pressed="true"`);
    }
    expect(parseCoachView('regatta')).toBe('regatta');
    for (const x of [null, undefined, '', 'race', 'weekend', 'Regatta']) expect(parseCoachView(x)).toBe('race');
  });

  it('the boat is the one selected in the app, if it sailed this race; else a prompt to pick one in the boat list', () => {
    const a = { boats: [{ id: 'A' }, { id: 'B' }] } as RaceAnalysis;
    expect(coachBoatFor(a, 'B')).toBe('B');
    expect(coachBoatFor(a, null)).toBeNull(); // no fallback to the winner any more
    expect(coachBoatFor(a, 'Z')).toBeNull();
    expect(coachNoBoatHtml()).toContain('Pick a boat in the boat list');
  });

  it('index.html and the app: no Coach pickers; the Race menu and the boat selection drive it', () => {
    const html = read('../index.html');
    expect(html).not.toMatch(/coach-boat|coach-races/);
    expect(html).toContain('<section id="coach-regatta" class="card coach-regatta" aria-label="Regatta" hidden></section>');
    expect(html).toContain('<button type="button" role="tab" id="tab-coach" aria-controls="panel-coach" aria-selected="false" tabindex="-1">Coach</button>');
    const app = read('../src/ui/app.ts');
    expect(app).not.toMatch(/data-coach-race|coach-boat|coachPickerHtml|coachRaces|Weekend|coachOn|coachEnabled|coach=1/);
    const coach = app.slice(app.indexOf('function renderCoach('), app.indexOf('function jobsFor('));
    expect(coach).toContain('const boat = coachBoatFor(a, highlight);');
    expect(coach).toContain('coachNoBoatHtml()');
    expect(coach).not.toContain('a.boats[0]');
    // The Race menu loads the race on screen (`analysis`), whose render redraws Coach.
    expect(app.slice(app.indexOf("els.race.addEventListener('change'")).slice(0, 200)).toContain('chooseRace(div, Number(n))');
    expect(app.slice(app.indexOf('  function render(): void'), app.indexOf('// ---- Coach:'))).toContain('renderCoach();');
    expect(read('../src/ui/coach.ts')).not.toMatch(/Weekend|coming later/i);
  });
});

describe('the Coach tab is on for everyone', () => {
  it('three tabs; #coach opens it and keys reach it, no flag needed', () => {
    expect(TABS).toEqual(['start', 'race', 'coach']);
    expect(parseTab('coach')).toBe('coach');
    expect(tabFromHash('#coach')).toBe('coach');
    expect(initialTab('#coach', 'race', false)).toBe('coach');
    expect(tabForKey('race', 'ArrowRight')).toBe('coach');
    expect(tabForKey('coach', 'ArrowRight')).toBe('start');
  });

  it('a saved Coach tab restores without the flag; a stale ?coach=1 is ignored', () => {
    const rec: LastView = { v: 1, eventId: 'event-1234', division: 'J105', raceNumber: 3, leg: null, boat: 'USA 96', sort: null, tab: 'coach', savedAt: 1 };
    expect(parseLastView(serializeLastView(rec))).toEqual(rec);
    expect(startTab('', resolveStart('', rec), rec)).toBe('coach');
    expect(parsePickerParams('?event=event-1234&div=J105&race=3&coach=1')).toEqual(parsePickerParams('?event=event-1234&div=J105&race=3'));
    expect(startTab('', resolveStart('?coach=1', rec), rec)).toBe('coach');
  });

  it('the worker keeps the race on screen without a flag', () => {
    const worker = read('../src/worker.ts');
    expect(worker).not.toMatch(/req\.coach|coach=1/);
    expect(read('../src/style.css')).not.toContain('coach=1');
  });
});

describe('Regatta races: the race menu’s list (J/70 Worlds: practice out, rebuilt and tracker-only in)', async () => {
  const resp = regatta('rs_j70.json');
  const doc = currentDoc(resp);
  const [ctx] = orphanContexts(doc, buildRaceList(doc), null);
  const res = await discoverOrphans(ctx, replayProbes('j70_probes.json').fetchRows);
  const found = new Map([['Open', res.found]]);
  const merged = withOrphans(doc, found);
  const list = buildRaceList(merged, { orphans: found });
  const reg = withDoc(resp, merged);
  const base = { eventId: 'ev', regatta: reg, division: 'Open', sail: 'USA 833' };
  const jobs = regattaJobs(list.races, base);

  it('R1–R10 as the menu numbers them, keyed as the menu (rebuilt by gun minute), no practice', () => {
    expect(jobs.map((j) => j.label)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10']);
    const menu = list.races.filter((r) => !r.practice).reverse();
    expect(jobs.map((j) => j.raceNumber)).toEqual(menu.map((r) => r.raceNumber));
    expect(jobs.map((j) => j.name)).toEqual(menu.map((r) => raceOptionText(r, false).split(' · ')[0]));
    expect(jobs.map((j) => j.raceNumber)).toContain(202609091620);
    expect(jobs.map((j) => j.raceNumber)).toContain(202609111355);
    expect(list.races.find((r) => r.practice)).toBeDefined();
    expect(jobs.some((j) => j.name === 'Practice')).toBe(false);
    // Tracker-only races (RS 4 = Race 3, RS 7 = Race 7) are in.
    expect(jobs.filter((j) => list.races.find((r) => r.raceNumber === j.raceNumber)!.finishes === 'tracker').map((j) => j.label)).toEqual(['R3', 'R4', 'R7', 'R8']);
    for (const j of jobs) expect(j.request).toMatchObject({ eventId: 'ev', division: 'Open', raceNumber: j.raceNumber, sail: 'USA 833', regatta: reg });
  });

  it('the cache key changes with the boat, `nc=all`, the official results and an uploaded log', () => {
    const k = jobs[0].key;
    expect(regattaJobs(list.races, { ...base, sail: 'POR 1' })[0].key).not.toBe(k);
    expect(regattaJobs(list.races, { ...base, allCompetitors: true })[0].key).not.toBe(k);
    expect(regattaJobs(list.races, { ...base, officialOf: () => ({ number: 1, tzOffsetMs: 0, rows: [] }) })[0].key).not.toBe(k);
    const withLog = regattaJobs(list.races, { ...base, logsOf: (r) => (r.raceNumber === jobs[0].raceNumber ? [{ bytes: new ArrayBuffer(1), uploadedAt: 5 }] : []) });
    expect(withLog[0].key).not.toBe(k);
    expect(withLog[1].key).toBe(jobs[1].key);
    expect(withLog[0].request.vkx).toHaveLength(1);
    expect(regattaJobs(list.races, base).map((j) => j.key)).toEqual(jobs.map((j) => j.key));
  });
});

/** A worker double: records requests; the test answers them. */
function fakeWorker() {
  const sent: WorkerRequest[] = [];
  let made = 0;
  const port: WorkerPort = { postMessage: (m) => void sent.push(m), onmessage: null };
  const reply = (msg: WorkerResponse): void => port.onmessage!({ data: msg } as MessageEvent<WorkerResponse>);
  return { make: () => (made++, port), sent, reply, made: () => made };
}

const job = (n: number, sail = 'USA 833'): RegattaJob => ({
  key: `ev|Open|${n}||${sail}|-|`,
  raceNumber: n,
  label: `R${n}`,
  name: `Race ${n}`,
  request: { eventId: 'ev', regatta: {} as never, division: 'Open', raceNumber: n, sail },
});

describe('Regatta runner: lazy, one race at a time, cached (the empty “Weekend” regression)', () => {
  it('a cold start analyses every race, with progress, and the view is never empty', () => {
    const w = fakeWorker();
    let changes = 0;
    const runner = createRegattaRunner(w.make, () => changes++);
    // Nothing until the view wants races; no worker either.
    runner.want([]);
    expect(w.made()).toBe(0);
    const jobs = [job(1), job(2), job(3)];
    runner.want(jobs);
    expect(w.made()).toBe(1);
    expect(w.sent).toHaveLength(1); // one at a time
    expect(w.sent[0]).toMatchObject({ type: 'regatta-race', raceNumber: 1, sail: 'USA 833' });
    expect(runner.races().map((r) => r.status)).toEqual(['running', 'pending', 'pending']);
    // Before any race is back, the view lists every race (Weekend used to be a disabled button with no view at all).
    const cold = regattaViewHtml(runner);
    expect(cold).toContain('Analysing Race 1 (1 of 3)');
    expect((cold.match(/class="rp /g) ?? []).length).toBe(3);
    w.reply({ id: w.sent[0].id, type: 'progress', message: 'Fetched page 2 (40,000 points)…' });
    expect(runner.progress()).toEqual({ running: 'Race 1', message: 'Fetched page 2 (40,000 points)…', done: 0, total: 3 });
    expect(changes).toBe(1);
    w.reply({ id: w.sent[0].id, type: 'regatta-race', digest: digest(1, { findings: [finding('D3', 'slow-start', 20)] }) });
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]).toMatchObject({ raceNumber: 2 });
    // A reply for another id (a stale one) is ignored.
    w.reply({ id: 999, type: 'regatta-race', digest: digest(9) });
    expect(runner.races().map((r) => r.status)).toEqual(['done', 'running', 'pending']);
    w.reply({ id: w.sent[1].id, type: 'error', message: 'HTTP 500' });
    w.reply({ id: w.sent[2].id, type: 'regatta-race', digest: digest(3, { findings: [finding('D3', 'slow-start', 25)] }) });
    expect(runner.races().map((r) => r.status)).toEqual(['done', 'error', 'done']);
    expect(runner.progress()).toEqual({ running: null, message: '', done: 3, total: 3 });
    const html = regattaViewHtml(runner);
    expect(html).toContain('2 of 3 races analysed');
    expect(html).toContain("1 couldn't be loaded");
    expect(html).toContain('Slow at the gun');
    expect(html).toContain('<h4>Top 3 to work on</h4>');
  });

  it('cached for the visit: asking again posts nothing; another boat runs its own, the old race finishing into the cache', () => {
    const w = fakeWorker();
    const runner = createRegattaRunner(w.make, () => {});
    runner.want([job(1), job(2)]);
    w.reply({ id: w.sent[0].id, type: 'regatta-race', digest: digest(1) });
    // Switch boats while race 2 runs for USA 833.
    runner.want([job(1, 'POR 1'), job(2, 'POR 1')]);
    expect(w.sent).toHaveLength(2);
    w.reply({ id: w.sent[1].id, type: 'regatta-race', digest: digest(2) });
    expect(w.sent.slice(2).map((m) => [(m as { raceNumber: number }).raceNumber, (m as { sail: string }).sail])).toEqual([[1, 'POR 1']]);
    w.reply({ id: w.sent[2].id, type: 'regatta-race', digest: digest(1, { sail: 'POR 1' }) });
    w.reply({ id: w.sent[3].id, type: 'regatta-race', digest: digest(2, { sail: 'POR 1' }) });
    // Back to USA 833: both cached, nothing posted (race 2 finished into the cache after the switch).
    runner.want([job(1), job(2)]);
    expect(w.sent).toHaveLength(4);
    expect(runner.races().every((r) => r.status === 'done')).toBe(true);
    expect(w.made()).toBe(1);
  });
});

describe('Regatta summary', () => {
  it('places: official, else the tracker (~), the code; of N; pending and failed races shown', () => {
    const races: RegattaRace[] = [
      done(1, { finish: fin(3, 97) }),
      done(2, { finish: fin(7, 97, 'tracker') }),
      done(3, { finish: fin(null, 97, 'official', 'DNF') }),
      done(4, { tracked: false, finish: fin(12, 97), coverage: null, noData: true }),
      { raceNumber: 5, label: 'R5', name: 'Race 5', status: 'pending', digest: null },
      { raceNumber: 6, label: 'R6', name: 'Race 6', status: 'error', digest: null, error: 'HTTP 500' },
    ];
    const s = summarizeRegatta(races);
    expect([finishShort(fin(3)), finishShort(fin(7, 20, 'tracker')), finishShort(fin(null, 20, 'official', 'DNF')), finishShort(null)]).toEqual(['3rd', '~7th', 'DNF', '—']);
    const html = regattaPlacesHtml(s);
    const items = [...html.matchAll(/<li class="rp ([a-z ]+)" data-race="(\d+)" title="([^"]*)"><b>([^<]*)<\/b> <span class="rp-place">([^<]*)<\/span>(?:<small>of (\d+)<\/small>)?/g)].map((m) => [m[4], m[5], m[6] ?? null, m[3]]);
    expect(items).toEqual([
      ['R1', '3rd', '97', 'Race 1: 3rd of 97, official'],
      ['R2', '~7th', '97', 'Race 2: 7th of 97, tracker finish'],
      ['R3', 'DNF', '97', 'Race 3: DNF, official'],
      ['R4', '12th', '97', 'Race 4: 12th of 97, official, no track'],
      ['R5', '…', null, 'Race 5: not analysed yet'],
      ['R6', '!', null, 'Race 6: couldn&#39;t load: HTTP 500'],
    ]);
    expect(s).toMatchObject({ done: 4, withData: 3, total: 6 });
  });

  it('recurring findings: by weighted seconds, then races — “slow at the gun in 4 of 9 races, ~60 s total”', () => {
    const races = Array.from({ length: 9 }, (_, i) => done(i + 1, { findings: i < 4 ? [finding('D3', 'slow-start', 15)] : i === 4 ? [finding('D4', 'headed', 40)] : [] }));
    // A second slow-start-type finding (D2 rolled) in race 1 sums into the same race, not a fifth.
    races[0].digest!.findings.push(finding('D2', 'rolled', 0));
    const s = summarizeRegatta(races);
    expect(s.findings.map((f) => [f.theme, f.races, f.of, Math.round(f.totalS), Math.round(f.weightedS)])).toEqual([
      ['gun-speed', 4, 9, 60, 60],
      ['shifts', 1, 9, 40, 40],
    ]);
    expect(s.findings[0].raceLabels).toEqual(['R1', 'R2', 'R3', 'R4']);
    expect(s.top[0]).toMatchObject({ title: 'Slow at the gun', why: 'Slow at the gun in 4 of 9 races, ~60 s total', tip: 'Hit the line at full speed. If pinned, foot a length before tacking.' });
    // Same weighted seconds: more races first.
    const tie = summarizeRegatta([done(1, { findings: [finding('D6', 'slow', 30), finding('D7', 'deep', 15)] }), done(2, { findings: [finding('D7', 'hot', 15)] })]);
    expect(tie.findings.map((f) => [f.theme, f.races])).toEqual([
      ['downwind', 2],
      ['upwind', 1],
    ]);
    // The theme's tip is its costliest variant's.
    expect(tie.findings[0].tip).toBe('Sail hotter in the lulls and soak low only in the puffs; gybe on the angle.');
  });

  it('low tracker coverage: shown and marked, counted less; a no-data race adds no findings', () => {
    expect(coverageWeight(1)).toBe(1);
    expect(coverageWeight(LOW_COVERAGE)).toBe(1);
    expect(coverageWeight(0.4)).toBeCloseTo(0.5, 9);
    expect(coverageWeight(0.01)).toBe(MIN_WEIGHT);
    const s = summarizeRegatta([
      done(1, { findings: [finding('D6', 'slow', 50)] }),
      done(2, { coverage: 0.4, findings: [finding('D6', 'high-slow', 100)] }),
      done(3, { coverage: 0.1, noData: true }),
    ]);
    expect(s.rows.map((r) => [r.label, r.low, r.weight])).toEqual([
      ['R1', false, 1],
      ['R2', true, 0.5],
      ['R3', true, MIN_WEIGHT],
    ]);
    expect(s.withData).toBe(2);
    expect(s.findings[0]).toMatchObject({ theme: 'upwind', races: 2, of: 2, totalS: 150, weightedS: 100, lowRaces: 1 });
    expect(s.top[0].why).toBe('Slow upwind in 2 of 2 races, ~150 s total (1 with low tracker data)');
    expect(regattaPlacesHtml(s)).toContain('class="rp done low" data-race="2"');
    expect(regattaHtml(s, { running: null, message: '', done: 3, total: 3 })).toContain('⚠ 2 with low tracker data (marked, counted less)');
  });

  it('legs by type: weighted mean vs the fleet median; best and worst from well-covered legs, a hole-timed leg counted less', () => {
    const s = summarizeRegatta([
      done(1, { legs: [leg(1, 'upwind', 20), leg(2, 'downwind', -10), leg(3, 'upwind', -200, { timingGap: true })] }),
      done(2, { legs: [leg(1, 'upwind', 40), leg(2, 'downwind', 30, { coverage: 0.2 }), leg(3, 'upwind', -5)] }),
    ]);
    const up = s.legs.find((l) => l.kind === 'upwind')!;
    expect(up.legs).toBe(4);
    expect(up.best).toMatchObject({ label: 'R2', leg: 'Beat 3', deltaS: -5, low: false }); // not the −200 s leg timed across a hole
    expect(up.worst).toMatchObject({ label: 'R2', leg: 'Beat 1', deltaS: 40 });
    expect(up.meanS).toBeCloseTo((20 + 40 - 5 - 200 * MIN_WEIGHT) / (3 + MIN_WEIGHT), 9);
    const down = s.legs.find((l) => l.kind === 'downwind')!;
    expect(down.best).toMatchObject({ label: 'R1', deltaS: -10 });
    expect(down.worst).toMatchObject({ label: 'R1', deltaS: -10 }); // the 20 %-covered run is not a "solid" leg
    expect(s.legs.map((l) => l.kind)).toEqual(['upwind', 'downwind']);
  });

  it('top 3 by rules: recurring (2+ races) or ≥ 30 weighted seconds; the costliest leg type unless a finding already says it', () => {
    const s = summarizeRegatta([
      done(1, { findings: [finding('D1', 'late', 20), finding('D4', 'headed', 25)], legs: [leg(1, 'downwind', 30), leg(2, 'upwind', 0)] }),
      done(2, { findings: [finding('D1', 'second-row', 10), finding('D5', 'overstand', 90)], legs: [leg(1, 'downwind', 20), leg(2, 'upwind', 0)] }),
      done(3, { findings: [finding('D10', 'beat', 12)], legs: [leg(1, 'downwind', 25)] }),
    ]);
    expect(s.top.map((t) => t.title)).toEqual(['Gave back gains from a side', 'Runs', 'Starts: late or back at the gun']);
    expect(s.top[1]).toMatchObject({ why: "~25 s lost per run vs the fleet's median, over 3 runs" });
    // One-off and small: not worth working on (shifts 25 s once, the last leg 12 s once).
    expect(s.top.some((t) => /shifts|last leg/i.test(t.title))).toBe(false);
    // A downwind finding that recurs takes the place of the Runs line.
    const s2 = summarizeRegatta([
      done(1, { findings: [finding('D7', 'deep', 40)], legs: [leg(1, 'downwind', 30)] }),
      done(2, { findings: [finding('D7', 'deep', 40)], legs: [leg(1, 'downwind', 30)] }),
    ]);
    expect(s2.top.map((t) => t.title)).toEqual(['Downwind angles and speed']);
    expect(summarizeRegatta([]).top).toEqual([]);
  });

  it('a boat with no track in a race keeps its official result', () => {
    const rows: OfficialResultRow[] = [
      { prefix: 'USA', sail: '833', name: '', code: null, place: 4, finishWallMs: null, elapsedS: null, rsSail: 'USA 833' },
      { prefix: 'USA', sail: '1', name: '', code: null, place: 1, finishWallMs: null, elapsedS: null, rsSail: 'USA 1' },
    ];
    const a = { boats: [{ sail: 'USA 1', id: 'x' } as BoatResult], legs: [], meta: { raceNumber: 4 } } as unknown as RaceAnalysis;
    expect(raceDigest(a, null, 'USA 833', rows)).toEqual({ raceNumber: 4, sail: 'USA 833', tracked: false, finish: fin(4, 2), coverage: null, noData: true, legs: [], findings: [] });
  });
});

describe('Regatta on J/105 CBC (linked: official places), through the worker’s digest', async () => {
  const doc = currentDoc(regatta('rs_j105.json'));
  const outcome = await linkOfficial(fixtureYs(), linkRequest(doc, { venue: 'Annapolis, MD', startMs: 0, endMs: 0 }));
  const list = buildRaceList(doc, { links: linksOf(outcome) });
  const races: RegattaRace[] = ([1, 2, 3] as const).map((n) => {
    const f = j105Fixture(n);
    const off = officialFor(outcome, list.races.find((r) => r.rsNumber === n));
    const ref = { division: 'J105', raceNumber: n };
    const data = buildRaceData(f.regatta, ref, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind, official: off, nextGunMs: nextGunMs(currentDoc(f.regatta), ref) });
    return { raceNumber: n, label: `R${n}`, name: `Race ${n}`, status: 'done', digest: digestRace(analyzeRace(data), data, 'USA 96', off?.rows ?? null) };
  });
  const s = summarizeRegatta(races);

  it('Good Trade: official places 2nd, 6th, 10th of 18 (race 1 with no RaceSense finish)', () => {
    expect(races.map((r) => r.digest!.finish)).toEqual([fin(2, 18), fin(6, 18), fin(10, 18)]);
  });

  it('every race has findings; the trimmed fixtures are all low coverage, so marked and weighted down', () => {
    expect(s.withData).toBe(3);
    expect(s.rows.every((r) => r.low && r.weight < 1 && r.weight >= MIN_WEIGHT)).toBe(true);
    expect(races.every((r) => r.digest!.findings.length > 0)).toBe(true);
    // Downwind recurs (D7 in races 2 and 3).
    expect(s.findings.find((f) => f.theme === 'downwind')).toMatchObject({ races: 2, of: 3, lowRaces: 2 });
    expect(s.findings.map((f) => f.weightedS)).toEqual([...s.findings.map((f) => f.weightedS)].sort((p, q) => q - p));
    expect(s.top.length).toBeGreaterThan(0);
    expect(s.top.length).toBeLessThanOrEqual(3);
    for (const l of s.legs) expect(l.best.deltaS).toBeLessThanOrEqual(l.worst.deltaS);
    const html = regattaHtml(s, { running: null, message: '', done: 3, total: 3 });
    expect(html).toContain('3 of 3 races analysed');
    expect(html).toContain('<h4>Legs by type</h4>');
  });
});
