/**
 * From a coach's debrief of the J/70 North Americans (races 4–6, sail 1513): what Recall now shows directly.
 * The start fixture is race 6 (tests/fixtures/j70nas_r6_start.json: 1513 and 11 more boats, gun −100 s to +60 s);
 * race 5's two starts are its real RaceSense records (line, guns, stop reason), its earlier attempt's tracks made by
 * moving race 6's to that gun (no telemetry of the stopped start is kept in the repo).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { raceDigest } from '../src/analysis/coach/regatta';
import { placeChanges } from '../src/analysis/places';
import { gunReadout, linePart, startDigest } from '../src/analysis/startSummary';
import type { RaceAnalysis } from '../src/analysis/types';
import { ATTEMPT_MIN_POST_MS, attemptNumbered, attemptRegatta, attemptTitle, attemptWindow, earlierAttempts, parseAttemptParam } from '../src/data/attempts';
import { buildRaceData, currentDoc } from '../src/data/racesense/adapter';
import type { Race, RegattaResponse, Start, TelemetryPage } from '../src/data/racesense/types';
import { attemptNote } from '../src/ui/attemptView';
import { speedPickPlace, speedPickTexts, startSnapshot } from '../src/ui/charts';
import { gunReadoutCells, gunReadoutHtml } from '../src/ui/gunReadout';
import { FAST_PARAM, LEG_PARAM, NO_FOCUS, cardMapHref, cardRoute, focusColouring, focusResume, legFocus, legMapHref, parseMapFocus } from '../src/ui/mapLink';
import { gainLabels, placesChart, segHitsRect } from '../src/ui/places';
import { favoredShort, linePosText, startStripHtml, startThumbSvg, startViewHref } from '../src/ui/startStrip';
import { startPngName, startPngSvg } from '../src/ui/startPng';
import { easternStamp } from '../src/ui/races';
import type { Fixture } from './helpers';
import { m24Race } from './helpers';

const f = JSON.parse(readFileSync(new URL('./fixtures/j70nas_r6_start.json', import.meta.url), 'utf8')) as Fixture;
const REF = { division: 'J70', raceNumber: 6 };
const build = (regatta: RegattaResponse = f.regatta, telemetry: TelemetryPage = f.telemetry) => buildRaceData(regatta, REF, [telemetry], { eventId: f.eventId, kind: 'fixture' });
const r6 = analyzeRace(build());
const raceOf = (regatta: RegattaResponse): Race => currentDoc(regatta).divisions[0].races[0];

describe('regatta start strip (1513, race 6)', () => {
  const s = startDigest(r6, '1513')!;

  it('carries the line, every boat at the gun and 1513 as the Start view measures it', () => {
    expect(s.boats).toHaveLength(r6.boats.filter((b) => b.start && !b.start.awayFromLine).length);
    expect(s.me).toEqual({ dtlM: 2.1, linePct: 2, called: true });
    expect(linePart(s.me!.linePct)).toBe('pin');
    expect(linePart(50)).toBe('middle');
    expect(linePart(90)).toBe('rc');
    expect(linePosText(2)).toBe('Pin end · 2%');
    expect(s.fav.end).toBe('pin');
    expect(favoredShort(s.fav)).toMatch(/^Pin favored \d+°$/);
    expect(favoredShort({ end: 'square', deg: 0, byM: 0 })).toBe('Square line');
    // Small: rounded to 0.1 m.
    expect(JSON.stringify(s).length).toBeLessThan(2000);
  });

  it('draws a hull for every boat, 1513 alike in size, picked out by its class only', () => {
    const svg = startThumbSvg(s, '1513');
    expect(svg.match(/class="hull thumb-boat"/g)).toHaveLength(s.boats.length - 1);
    expect(svg.match(/class="hull thumb-on"/g)).toHaveLength(1);
    expect(svg).toContain('class="startline"');
    expect(svg).toContain('class="pin"');
    expect(svg).toContain('class="rc"');
    // The boat drawn last, on top.
    expect(svg.lastIndexOf('thumb-on')).toBeGreaterThan(svg.lastIndexOf('thumb-boat'));
    // Its sail number beside it, haloed, after the hulls (on top), inside the picture.
    const lbl = /<text class="thumb-lbl" x="([-\d.]+)" y="([-\d.]+)"[^>]*>1513<\/text>/.exec(svg)!;
    expect(lbl).not.toBeNull();
    expect(svg.indexOf('thumb-lbl')).toBeGreaterThan(svg.lastIndexOf('thumb-on'));
    const [vx, vy, vw, vh] = /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);
    expect(Number(lbl[1])).toBeGreaterThan(vx);
    expect(Number(lbl[1])).toBeLessThan(vx + vw);
    expect(Number(lbl[2])).toBeLessThan(vy + vh);
    expect(startThumbSvg(s, 'nobody')).not.toContain('thumb-lbl');
  });

  it('lists each race with its facts and a link to its Start view; OCS only as race control called it', () => {
    const digest = raceDigest(r6, null, '1513');
    expect(digest.start).toEqual(s);
    const search = '?event=Qn47enc7fKR7Th1Qj1ZI&div=J70&race=4&boat=1513&t=30&trail=all&win=0,30';
    const html = startStripHtml([{ raceNumber: 6, label: 'R6', name: 'Race 6', status: 'done', digest }], search);
    expect(html).toContain('href="/regattas/start?event=Qn47enc7fKR7Th1Qj1ZI&amp;div=J70&amp;race=6&amp;boat=1513#start"');
    expect(html).toContain('2.1 m to line');
    expect(html).toContain('Pin end · 2%');
    expect(html).toContain('<span class="ss-ocs">OCS</span>');
    const other = r6.boats.find((b) => b.start && !b.start.over && !b.start.awayFromLine)!;
    const plain = startStripHtml([{ raceNumber: 6, label: 'R6', name: 'Race 6', status: 'done', digest: raceDigest(r6, null, other.sail) }], search);
    expect(plain).not.toMatch(/OCS|\bover\b/i);
    expect(startStripHtml([{ raceNumber: 6, label: 'R6', name: 'Race 6', status: 'running', digest: null }], search)).toBe('');
    expect(startViewHref('?event=E&div=D&nc=all&vs=x', 3, '1513')).toBe('/regattas/start?event=E&div=D&nc=all&race=3&boat=1513#start');
  });
});

describe('gun readout (Vakaros terms), 1513 race 6', () => {
  const me = r6.boats.find((b) => b.sail === '1513')!;
  const r = gunReadout(me)!;

  it('reads SOG, VMG, HDG, TWA and the distance at the gun', () => {
    expect(r.sogKn).toBeCloseTo(4.1, 1);
    expect(r.hdgDeg).toBe(257);
    expect(r.tack).toBe('starboard');
    expect(r.twaDeg).toBeCloseTo(me.start!.twaDeg, 6);
    expect(r.vmgKn).toBeCloseTo(r.sogKn! * Math.cos((r.twaDeg! * Math.PI) / 180), 6);
    expect(r.dtlM).toBeCloseTo(2.09, 2);
  });

  it('labels them as a Vakaros display does, TWA marked estimated, the distance a plain number', () => {
    const cells = gunReadoutCells(r);
    expect(cells.map((c) => c.label)).toEqual(['SOG', 'VMG', 'HDG', 'TWA', 'Dist. to line']);
    expect(cells.map((c) => c.value)).toEqual(['4.1 kn', `${r.vmgKn!.toFixed(1)} kn`, '257°', `${Math.round(r.twaDeg!)}° stbd (est.)`, '2.1 m']);
    const html = gunReadoutHtml(r6, me.id);
    expect(html).toContain('#1513 at the gun');
    expect(html).not.toMatch(/over early|over the line|OCS/i);
    expect(gunReadoutHtml(r6, null)).toBe('');
    expect(gunReadoutCells({ ...r, dtlM: null }).map((c) => c.label)).not.toContain('Dist. to line');
  });

  it('still shows SOG and the distance with no TWA or heading (VMG too when the TWA is known)', () => {
    const noTwaHdg = gunReadout({ start: { ...me.start!, twaDeg: NaN, headingDeg: NaN } })!;
    expect(noTwaHdg).toMatchObject({ sogKn: me.start!.speedKn, vmgKn: null, hdgDeg: null, twaDeg: null, tack: null });
    expect(gunReadoutCells(noTwaHdg).map((c) => c.label)).toEqual(['SOG', 'Dist. to line']);
    const noHdg = gunReadout({ start: { ...me.start!, headingDeg: NaN } })!;
    expect(gunReadoutCells(noHdg).map((c) => c.label)).toEqual(['SOG', 'VMG', 'TWA', 'Dist. to line']);
    const a = { ...r6, boats: r6.boats.map((b) => (b.id === me.id ? { ...b, start: { ...b.start!, twaDeg: NaN, headingDeg: NaN } } : b)) };
    const html = gunReadoutHtml(a, me.id);
    expect(html).toContain('#1513 at the gun');
    expect(html).toContain('<dt>SOG</dt>');
    expect(html).toContain('<dt>Dist. to line</dt>');
    expect(html).not.toContain('<dt>TWA</dt>');
    // Nothing to show at all: no readout.
    expect(gunReadout({ start: { ...me.start!, speedKn: NaN, twaDeg: NaN, headingDeg: NaN, dtlM: NaN, rank: null } })).toBeNull();
  });
});

describe('gain labels on the positions chart', () => {
  it('sit clear of the line and of each other, "±0" left out', () => {
    const pts = [[40, 200], [160, 20], [280, 40], [400, 400], [520, 380]] as [number, number][];
    const gains = [null, 14, -1, -20, 0];
    const since = [null, 0, 1, 2, 3];
    const out = gainLabels(pts, gains, since, 11, { x0: 0, y0: 0, x1: 600, y1: 420 });
    expect(out.map((l) => l.text)).toEqual(['+14', '−1', '−20']);
    for (const l of out) {
      for (let i = 1; i < pts.length; i++) expect(segHitsRect(pts[i - 1], pts[i], l.box)).toBe(false);
      for (const m of out) if (m !== l) expect(l.box.x1 <= m.box.x0 || m.box.x1 <= l.box.x0 || l.box.y1 <= m.box.y0 || m.box.y1 <= l.box.y0).toBe(true);
    }
  });

  it('prints the selected boat’s gains and makes each leg a link to its map view', () => {
    const a = analyzeRace(m24Race());
    const pc = placeChanges(a);
    const bp = pc.boats.find((b) => b.gains.filter((g) => g != null && g !== 0).length >= 2)!;
    const svg = placesChart(a, bp.id, { widthPx: 720, legHref: (leg) => `?leg=${leg + 1}#race` });
    const texts = [...svg.matchAll(/<text class="pc-gain (up|down)"[^>]*>([^<]+)<\/text>/g)].map((m) => m[2]);
    expect(texts).toEqual(bp.gains.filter((g): g is number => g != null && g !== 0).map((g) => (g > 0 ? `+${g}` : `−${-g}`)));
    expect((svg.match(/data-leg-map="/g) ?? []).length).toBe(bp.gains.filter((g) => g != null).length);
    // None without a selection, none without links.
    expect(placesChart(a, null, { widthPx: 720 })).not.toContain('pc-gain');
    expect(placesChart(a, bp.id, { widthPx: 720 })).not.toContain('data-leg-map');
  });
});

describe('a leg’s view on the map', () => {
  const a = analyzeRace(m24Race());
  const gun = a.meta.gunMs;
  const boat = a.boats.find((b) => b.legs[1])!;

  it('parks at the boat’s rounding with the whole trail and the 10 fastest picked out; the link round-trips', () => {
    const f = legFocus(a, boat.id, 1)!;
    expect(f).toMatchObject({ boat: boat.id, vs: [], leg: 1, fast: 10, spans: [[boat.legs[1]!.startMs, boat.legs[1]!.endMs]] });
    const href = legMapHref('?event=E&div=D&race=4', a, boat.id, 1)!;
    expect(href).toMatch(/#race$/);
    const q = href.replace(/#race$/, '');
    const p = new URLSearchParams(q);
    expect([p.get(LEG_PARAM), p.get(FAST_PARAM), p.get('trail'), p.get('boat')]).toEqual(['2', '10', 'all', boat.id]);
    const back = parseMapFocus(q, gun)!;
    expect(back).toMatchObject({ boat: boat.id, vs: [], leg: 1, fast: 10 });
    expect(back.spans[0][0]).toBeLessThanOrEqual(f.spans[0][0]);
    expect(back.spans[0][1]).toBeGreaterThanOrEqual(f.spans[0][1]);
    expect(back.spans[0][1] - f.spans[0][1]).toBeLessThan(1000);
    expect(focusResume(back, q, gun)).toEqual({ t: back.spans[0][1], trail: 'all' });
    expect(Object.keys(NO_FOCUS)).toEqual(expect.arrayContaining([LEG_PARAM, FAST_PARAM]));
    expect(legFocus(a, boat.id, 99)).toBeNull();
    expect(parseMapFocus('?boat=A&win=0,10&leg=0&fast=7', gun)).toEqual({ boat: 'A', vs: [], spans: [[gun, gun + 10_000]] });
  });

  it('is where a side-of-the-course card goes, over the card’s own window', () => {
    const l = boat.legs[1]!;
    // A card window inside the leg (as a rate card trimmed for the start's window has), not the boat's whole leg.
    const t0 = l.startMs + 60_000;
    const t1 = l.endMs - 30_000;
    const other = a.boats.find((b) => b.id !== boat.id)!.id;
    const card = { kind: 'D14' as const, t0, t1, refBoats: [other], facts: { leg: a.legs[1].name } };
    const own = { boat: boat.id, vs: [other], spans: [[t0, t1]] };
    expect(cardRoute(a, boat.id, card, [])).toEqual({ kind: 'focus', focus: { ...own, leg: 1, fast: 10 } });
    const href = cardMapHref('?event=E&div=D&race=4', a, boat.id, card, [])!;
    const p = new URLSearchParams(href.replace(/#race$/, ''));
    expect([p.get('win'), p.get(LEG_PARAM), p.get(FAST_PARAM), p.get('vs')]).toEqual([
      `${Math.floor((t0 - gun) / 1000)},${Math.ceil((t1 - gun) / 1000)}`,
      '2',
      '10',
      other,
    ]);
    // A D14 whose leg isn't found keeps its own window, with no leg's view; so does any other card.
    expect(cardRoute(a, boat.id, { ...card, facts: { leg: 'Nowhere' } }, [])).toEqual({ kind: 'focus', focus: own });
    expect(cardRoute(a, boat.id, { ...card, kind: 'D6' as const }, [])).toEqual({ kind: 'focus', focus: own });
  });

  it('colors by rank on the leg while open and puts the coloring before it back when left', () => {
    const mine = { colour: 'sog' as const, rankBy: 'overall' as const, top: 'all' as const };
    const open = focusColouring(mine, null, { fast: 10 });
    expect(open).toEqual({ now: { colour: 'rank', rankBy: 'leg', top: 10 }, before: mine });
    // Another leg's view on top keeps the coloring from before the first.
    const again = focusColouring(open.now, open.before, { fast: 3 });
    expect(again).toEqual({ now: { colour: 'rank', rankBy: 'leg', top: 3 }, before: mine });
    // Left (closed, another race, back past it) or a card's window without a leg: the coloring before it.
    expect(focusColouring(again.now, again.before, null)).toEqual({ now: mine, before: null });
    expect(focusColouring(again.now, again.before, {})).toEqual({ now: mine, before: null });
    // Nothing replaced: nothing changes.
    expect(focusColouring(mine, null, null)).toEqual({ now: mine, before: null });
  });
});

describe('"12th fastest" on the map', () => {
  it('says the speed rank, not a place, with the leg when it fits', () => {
    expect(speedPickTexts(12, true)).toEqual(['12th fastest on leg', '12th fastest']);
    expect(speedPickTexts(1, false)).toEqual(['1st fastest']);
    expect(speedPickTexts(22, true)[1]).toBe('22nd fastest');
  });

  it('keeps clear of a mark label beside the end, taking another side or the shorter wording', () => {
    const view = { x0: 0, y0: 0, x1: 1000, y1: 1000 };
    const at: [number, number] = [500, 500];
    const free = speedPickPlace(at, speedPickTexts(12, true), 12, 1, view, []);
    expect(free).toMatchObject({ anchor: 'start', text: '12th fastest on leg' });
    // The mark's label right of the mark (as markLabels puts it): the rank goes elsewhere.
    const mark = { x0: 505, y0: 488, x1: 560, y1: 507 };
    const p = speedPickPlace(at, speedPickTexts(12, true), 12, 1, view, [mark]);
    const hit = (b: typeof mark): boolean => b.x0 < mark.x1 && mark.x0 < b.x1 && b.y0 < mark.y1 && mark.y0 < b.y1;
    expect(hit(p.box)).toBe(false);
    expect(p.text).toBe('12th fastest on leg');
  });
});

describe('an earlier start attempt (race 5: stopped at 16:36Z, restarted at 16:53Z)', () => {
  // Race 5's start records as RaceSense has them (lines and guns; the 31 boats it flagged on the stopped start include 1513's neighbors).
  const attempt1: Start = {
    startNumber: 1,
    startTime: Date.parse('2026-10-30T16:36:01Z'),
    startLine: { leftEnd: [38.9494796, -76.419515], rightEnd: [38.9545261, -76.4165139] },
    stopReason: 'abandonment',
    ocsParticipants: ['353', '363', '1029', '1562', '5', '27', '49', '56', '151', '340', '343', '381', '404', '419', '551', '1255', '1518', '303', '641', '169', '209', '231', '684', '1226', '26', '93', '332', '220', '34', '549', '1247'],
    clearedOcs: null,
    startingStats: null,
  };
  const race5: Pick<Race, 'starts'> = { starts: [attempt1, { ...attempt1, startNumber: 2, startTime: Date.parse('2026-10-30T16:53:01Z'), stopReason: 'finished', ocsParticipants: [] }] };

  it('finds it, numbered, and words it as what the feed shows', () => {
    const list = earlierAttempts(race5);
    expect(list).toEqual([{ index: 0, attempt: 1, of: 2, gunMs: Date.parse('2026-10-30T16:36:01Z'), nextGunMs: Date.parse('2026-10-30T16:53:01Z') }]);
    expect(attemptTitle('Race 5', list[0])).toBe('Start 5 · attempt 1 of 2 (restarted)');
    expect(attemptNote(list, -4 * 3_600_000)).toBe(
      "Race control stopped attempt 1 of 2 (gun 12:36:01) and started the race again at 12:53:01. It's here to look at only: results, times, places and the Coach all use the start the race was sailed from.",
    );
    // Race 5's 17 minutes between guns: the usual 130 s before and 5 min after.
    expect(attemptWindow(list[0])).toEqual({ after: list[0].gunMs - 130_000, before: list[0].gunMs + 5 * 60_000 });
    expect(attemptNumbered(list, parseAttemptParam('1'))).toBe(list[0]);
    expect(attemptNumbered(list, parseAttemptParam('x'))).toBeNull();
    // Race 1: the first start, abandoned with no line and sailed the next day, is not one to draw; one start, none.
    expect(earlierAttempts({ starts: [{ ...attempt1, startLine: null }, race5.starts[1]] })).toEqual([]);
    expect(earlierAttempts({ starts: [race5.starts[1]] })).toEqual([]);
  });

  it('numbers the note by the attempt it is about', () => {
    const g = Date.parse('2026-10-30T16:36:01Z');
    const thrice: Pick<Race, 'starts'> = {
      starts: [attempt1, { ...attempt1, startNumber: 2, startTime: g + 10 * 60_000 }, { ...attempt1, startNumber: 3, startTime: g + 20 * 60_000, stopReason: 'finished' }],
    };
    const list = earlierAttempts(thrice);
    expect(list.map((x) => x.attempt)).toEqual([1, 2]);
    expect(attemptNote([list[1]], -4 * 3_600_000)).toBe(
      "Race control stopped attempt 2 of 3 (gun 12:46:01) and started the race again at 12:56:01. It's here to look at only: results, times, places and the Coach all use the start the race was sailed from.",
    );
    expect(attemptNote(list, -4 * 3_600_000)).toMatch(/^Race control stopped attempt 1 of 3 .*Race control stopped attempt 2 of 3 /);
  });

  it('keeps the gun and a minute after it in the window however soon the race was started again', () => {
    const gunMs = Date.parse('2026-10-30T16:36:01Z');
    for (const spacing of [60_000, 120_000]) {
      const w = attemptWindow({ gunMs, nextGunMs: gunMs + spacing });
      expect(w).toEqual({ after: gunMs - 130_000, before: gunMs + ATTEMPT_MIN_POST_MS });
      expect(w.before).toBeGreaterThan(gunMs);
    }
    // Room for more than the minute but less than 5 min: up to the next start's pre-start.
    expect(attemptWindow({ gunMs, nextGunMs: gunMs + 240_000 })).toEqual({ after: gunMs - 130_000, before: gunMs + 110_000 });
    expect(attemptWindow({ gunMs, nextGunMs: gunMs + 17 * 60_000 })).toEqual({ after: gunMs - 130_000, before: gunMs + 5 * 60_000 });
  });

  // Race 6 as if started twice: a stopped start 17 minutes before the real one.
  const SHIFT = 17 * 60_000;
  const twice = structuredClone(f.regatta);
  const real = raceOf(twice).starts[0];
  raceOf(twice).starts = [
    { ...real, startNumber: 1, startTime: (real.startTime as number) - SHIFT, stopReason: 'abandonment', ocsParticipants: ['1513', '226'], startingStats: null },
    { ...real, startNumber: 2 },
  ];

  it('changes nothing of the race: its start, places, times and analysis come from the last start', () => {
    const before = JSON.stringify(f.regatta);
    const a = analyzeRace(build(twice));
    const facts = (x: RaceAnalysis) => x.boats.map((b) => [b.sail, b.finishPos, b.finishMs, b.start?.dtlM, b.start?.over, b.start?.startPlace, b.start?.rank]);
    expect(a.meta.gunMs).toBe(r6.meta.gunMs);
    expect(facts(a)).toEqual(facts(r6));
    expect(a.findings).toEqual(r6.findings);
    attemptRegatta(twice, REF, 0);
    expect(JSON.stringify(f.regatta)).toBe(before);
  });

  it('is analysed on its own with no over-early call in it', () => {
    const at = earlierAttempts(raceOf(twice))[0];
    expect(at).toMatchObject({ index: 0, attempt: 1, of: 2 });
    const reg = attemptRegatta(twice, REF, at.index);
    expect(raceOf(reg).starts).toHaveLength(1);
    expect(raceOf(reg).starts[0]).toMatchObject({ startTime: at.gunMs, ocsParticipants: null, clearedOcs: null });
    expect(raceOf(reg).finishes).toEqual([]);
    // Its tracks: race 6's, moved back to its gun.
    const moved: TelemetryPage = { ...f.telemetry, Rows: f.telemetry.Rows!.map((row) => [(row[0] as number) - SHIFT, ...row.slice(1)]) };
    const att = analyzeRace(build(reg, moved));
    expect(att.meta.gunMs).toBe(at.gunMs);
    expect(att.boats.length).toBeGreaterThan(5);
    expect(att.boats.every((b) => !b.start?.over)).toBe(true);
    const words = JSON.stringify(att.findings) + startSnapshot(att, '1513');
    expect(words).not.toMatch(/OCS|over early|over the line/i);
  });
});

describe('start picture (PNG)', () => {
  it('names the file from the event, race and sail number', () => {
    expect(startPngName('J/70 North Americans', 6, '1513')).toBe('recall-j-70-north-americans-r6-1513-start.png');
  });

  it('holds the whole line, a close-up round the boat and a caption with sail numbers only', () => {
    const { svg, width, height } = startPngSvg(r6, '1513', 'speed', { event: 'J/70 North Americans', division: 'J70', race: 'Race 6' }, 'svg { --ink: #131922; }');
    expect(width).toBe(1200);
    expect(height).toBeGreaterThan(400);
    expect(svg.match(/class="chart start"/g)).toHaveLength(2);
    expect(svg).toContain('J/70 North Americans · J70 · Race 6');
    expect(svg).toContain('#1513 at the gun · 2.1 m to line');
    expect(svg).toContain(`#1513 at the gun · 2.1 m to line · ${easternStamp(r6.meta.gunMs)}`);
    expect(easternStamp(Date.parse('2026-10-30T18:15:01Z'))).toBe('Oct 30, 2026 · 2:15:01 PM ET');
    // Every hull in both panels; the boat marked (accent fill in the picture) in each, the same size as the rest.
    const hulls = 2 * r6.drawings.filter((d) => d.bow && d.courseAtGun != null).length;
    expect((svg.match(/class="hull sog-fill"/g) ?? []).length).toBe(hulls);
    const byBoat = startPngSvg(r6, '1513', 'boat', { event: 'J/70 North Americans', division: 'J70', race: 'Race 6' }, '').svg;
    expect((byBoat.match(/class="hull"/g) ?? []).length).toBe(hulls);
    expect(byBoat.match(/<path data-sel="" class="hull"/g)).toHaveLength(2);
    expect((byBoat.match(/data-sel=""/g) ?? []).length).toBe(2);
    expect(byBoat).toContain('path.hull[data-sel] { fill: var(--accent)');
    // The canvas holds the readout beside the inset, its last value and some padding.
    const ys = [...svg.matchAll(/<text x="\d+" y="(\d+)" class="png-v">/g)].map((m) => Number(m[1]));
    expect(ys).toHaveLength(5);
    expect(height).toBeGreaterThanOrEqual(Math.max(...ys) + 24);
    expect(svg).toContain('<![CDATA[svg { --ink: #131922; }');
    expect(svg).toContain('DIST. TO LINE');
    for (const b of r6.boats) if (b.name !== `#${b.sail}`) expect(svg).not.toContain(b.name);
  });
});
