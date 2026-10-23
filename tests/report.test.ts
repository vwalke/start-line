import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { summarizeRegatta, type RaceDigest, type RegattaRace } from '../src/analysis/coach/regatta';
import type { RaceData } from '../src/data/types';
import { cardText, penaltyText } from '../src/ui/coachCards';
import { MISSING, REPORT_HASH, buildReport, lineThird, longDuration, reportBoatFor, reportFromUrl, reportHref, scoredText, type ReportField, type ReportInput, type ReportModel } from '../src/ui/report';
import { REPORT_NO_BOAT, reportHtml, reportThumb } from '../src/ui/reportView';
import { ic37LinkedRace, ic37Official, j105Race } from './helpers';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

function coachOf(d: RaceData) {
  const a = analyzeRace(d);
  const raw = coachRaw(a, d);
  const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null, raw.turns ?? null, raw.overStart ?? null);
  return { a, m };
}

// IC37 North Americans R5, linked to its official results (the Coach's penalty case): USA 016 DPI, USA 019 over early.
const official = ic37Official();
const ic37 = coachOf(ic37LinkedRace(official));
const LEADERS = { kind: 'leaders' } as const;
const input = (sail: string, extra: Partial<ReportInput> = {}): ReportInput => ({
  a: ic37.a,
  boat: ic37.a.boats.find((b) => b.sail === sail)!.id,
  raceName: 'Race 5',
  model: ic37.m,
  group: LEADERS,
  official,
  ...extra,
});
const fieldOf = (fs: ReportField[], label: string): ReportField => {
  const f = fs.find((x) => x.label === label);
  if (!f) throw new Error(`no field ${label}`);
  return f;
};
/** Every figure the model shows, to look for invented values. */
const allText = (m: ReportModel): string => JSON.stringify(m);

describe('the route: #report or report=1', () => {
  it('opens on the #report hash or report=1 (1 / true / yes), not otherwise', () => {
    expect(reportFromUrl('', REPORT_HASH)).toBe(true);
    expect(reportFromUrl('?event=x', 'report')).toBe(true);
    expect(reportFromUrl('?event=x&report=1', '#coach')).toBe(true);
    expect(reportFromUrl('?report=true', '')).toBe(true);
    expect(reportFromUrl('?report=yes', null)).toBe(true);
    expect(reportFromUrl('?report=0', '#race')).toBe(false);
    expect(reportFromUrl('?report=', '')).toBe(false);
    expect(reportFromUrl('', '#coach')).toBe(false);
    expect(reportFromUrl('', '#reports')).toBe(false);
  });

  it('reportHref: opens on #report, closes back to the tab, and drops report= either way (search untouched)', () => {
    const u = 'https://x.test/?event=VaWTh1uA7TrLejoSFlUn&div=IC37&race=5&boat=USA+016&report=1#coach';
    expect(reportHref(u, true, '#coach')).toBe('https://x.test/?event=VaWTh1uA7TrLejoSFlUn&div=IC37&race=5&boat=USA+016#report');
    expect(reportHref('https://x.test/?event=e&boat=USA+016#report', false, '#race')).toBe('https://x.test/?event=e&boat=USA+016#race');
  });

  it('small formatters: thirds of the line, hours when long', () => {
    expect([10, 50, 80].map(lineThird)).toEqual(['pin end', 'middle', 'RC end']);
    expect(longDuration(3302)).toBe('55:02');
    expect(longDuration(3725)).toBe('1:02:05');
    expect(longDuration(null)).toBe(MISSING);
  });
});

describe('the boat the report shows', () => {
  const a = ic37.a;

  it('the selected boat when set; with the selection cleared, the remembered boat (still in boat=); null when neither sailed', () => {
    expect(reportBoatFor(a, 'USA 016', 'USA 019')).toBe('USA 016');
    expect(reportBoatFor(a, null, 'USA 019')).toBe('USA 019');
    expect(reportBoatFor(a, null, 'USA 999')).toBeNull();
    expect(reportBoatFor(a, null, null)).toBeNull();
    expect(reportBoatFor(a, 'USA 999', 'USA 998')).toBeNull();
  });
});

describe('the scored place in the header', () => {
  const res: Parameters<typeof scoredText>[0] = { finishPos: null };

  it('a points code reads like the Coach: the scored place, then the code and the places it cost', () => {
    expect(scoredText({ ...res, finishCode: 'DPI', scoredPoints: 15, onWaterPlace: 12, penaltyPlaces: 3 }, 15)).toBe('15th (DPI, +3 places)');
    expect(scoredText({ ...res, finishCode: 'SCP', scoredPoints: 9, onWaterPlace: 8, penaltyPlaces: 1 }, 15)).toBe('9th (SCP, +1 place)');
    expect(scoredText({ ...res, finishCode: 'DPI', scoredPoints: 12, onWaterPlace: 12, penaltyPlaces: 0 }, 15)).toBe('12th (DPI)');
  });

  it('a code with no scored place is the code alone; an uncoded boat is unchanged', () => {
    expect(scoredText({ ...res, finishCode: 'DNF', scoredPoints: 16 }, 15)).toBe('DNF');
    expect(scoredText({ ...res, finishCode: 'DSQ', scoredPoints: 16, onWaterPlace: 4 }, 15)).toBe('DSQ');
    expect(scoredText({ ...res, finishPos: 12 }, 15)).toBe('12th of 15');
    expect(scoredText(res, 15)).toBe(MISSING);
  });
});

describe('IC37 R5, USA 016 (DPI): the report', () => {
  const m = buildReport(input('USA 016'));
  const deb = coachDebrief(ic37.a, ic37.m!, 'USA 016')!;

  it('the header: event, division, race, boat; on the water and scored with the code; times; the wind marked estimated', () => {
    expect(m).toMatchObject({ state: 'ready', scope: 'race', event: '2026 IC37 North American Championship', division: 'IC37', race: 'Race 5', sail: 'USA 016', boatName: 'Fair American', groupLabel: 'Top 3' });
    expect(fieldOf(m.header, 'On the water').value).toBe('12th of 15');
    expect(fieldOf(m.header, 'Scored')).toMatchObject({ value: '15th (DPI, +3 places)', warn: true });
    expect(fieldOf(m.header, 'Scored').note).toMatch(/^Discretionary penalty/);
    expect(fieldOf(m.header, 'Race time').value).toBe('55:02');
    expect(fieldOf(m.header, 'Elapsed (official)').value).toMatch(/^\d+:\d\d$/);
    expect(fieldOf(m.header, 'Corrected (official)').value).toMatch(/^\d+:\d\d$/);
    expect(fieldOf(m.header, 'Gun').value).toBe('10:05:01 UTC−4');
    expect(fieldOf(m.header, 'Wind (TWD)').value).toMatch(/^\d+° est\.$/);
    expect(fieldOf(m.header, 'Wind (TWD)').note).toMatch(/^estimated from the fleet's tacks 0:30–3:30 after the gun; (high|medium|low) confidence$/);
    expect(fieldOf(m.header, 'Tracker coverage').value).toMatch(/^\d+%$/);
    // No wind speed anywhere in the data: the one header figure that is —, and it says why.
    expect(m.header.filter((f) => f.value === MISSING).map((f) => f.label)).toEqual(['Wind speed (TWS)']);
    expect(fieldOf(m.header, 'Wind speed (TWS)').note).toBe('no wind speed in the data');
  });

  it('the start: DTL, seconds late, start place, line position, crossing order (Coach’s), not over early', () => {
    const st = ic37.a.boats.find((b) => b.sail === 'USA 016')!.start!;
    expect(fieldOf(m.start, 'Distance to line at gun').value).toBe(`${Math.round(st.rank!.m)} m`);
    expect(fieldOf(m.start, 'Seconds late').value).toBe(`${st.lateS!.toFixed(1)} s`);
    expect(fieldOf(m.start, 'Start place').value).toBe('8th');
    expect(fieldOf(m.start, 'Line position').value).toBe(`${Math.round(st.linePosPct)}% · middle`);
    expect(fieldOf(m.start, 'Over the line').value).toBe('7th of 15');
    expect(fieldOf(m.start, 'Over the line').note).toMatch(/^crossed [+−]\d+ s$/);
    expect(fieldOf(m.start, 'Over early (OCS)').value).toBe('no');
    expect(m.start.every((f) => f.value !== MISSING)).toBe(true);
    // D1 didn't fire; the start card is D3 (the first minutes), with its Coach number and seconds.
    const i = deb.cards.findIndex((c) => c.kind === 'D3');
    expect(m.startVerdict).toMatchObject({ kind: 'card', n: i + 1, text: cardText(deb.cards[i], ic37.a.meta.tzOffsetMs).title });
    expect(m.startVerdict.seconds).toMatch(/s$/);
  });

  it('the legs: one row per leg with its type; places in → out of the fixed fleet; — only where there is no data', () => {
    expect(m.legs.map((l) => [l.name, l.type])).toEqual(ic37.a.legs.map((l) => [l.name, l.kind === 'upwind' ? 'Upwind' : l.kind === 'downwind' ? 'Downwind' : 'Reach']));
    const b1 = m.legs[0];
    expect(b1.places).toBe('8th → 14th');
    expect(b1.change).toBe('lost 6 · of 15');
    expect(b1.time).toMatch(/^~?\d+:\d\d$/);
    expect(b1.vsGroup).toMatch(/^[+−]\d+ s$/);
    expect(b1.sog).toMatch(/^\d+\.\d \/ \d+\.\d$/);
    expect(b1.vmg).toMatch(/^\d+\.\d \/ \d+\.\d$/);
    expect(b1.manoeuvres).toMatch(/^~?\d+ tacks?$/);
    expect(b1.coverage).toMatch(/^\d+%$/);
    // The side reads positions across the fixture's short holes (legStory.ts SIDE_SPAN_S); the leg ends at no gate.
    expect(b1.side).toMatch(/^\d+ m (left|right) · (Left paid|Right paid|no side paid)$/);
    expect(b1.gate).toBe(MISSING);
    expect(b1.lowData).toBe(true);
  });

  it('Coach: the penalty card first, then the findings in coachDebrief’s order with their seconds; work on from their tips', () => {
    expect(m.coach.penalty).toMatchObject({ code: 'DPI', title: penaltyText(deb.penalty!, ic37.a).title });
    expect(m.coach.penalty!.title).toBe('Cost 3 places — 12th on the water, scored 15th');
    expect(m.coach.rankedHead).toBe('Smaller than the penalty: what cost time on the water');
    expect(m.coach.findings.map((f) => f.title)).toEqual(deb.cards.map((c) => cardText(c, ic37.a.meta.tzOffsetMs).title));
    expect(m.coach.findings.map((f) => f.n)).toEqual(deb.cards.map((_, i) => i + 1));
    expect(m.coach.findings.every((f) => /^(≈ \d+ s|\d+–\d+ s)$/.test(f.seconds))).toBe(true);
    expect(m.coach.totalS).toBeCloseTo(deb.totalS, 6);
    expect(m.coach.workOn.length).toBeGreaterThan(0);
    expect(m.coach.workOn.length).toBeLessThanOrEqual(3);
    expect(m.coach.workOn[0]).toBe(cardText(deb.cards[0], 0).tip);
    // The penalty is never a thing to work on.
    expect(m.coach.workOn.some((t) => /penalt|protest/i.test(t))).toBe(false);
  });

  it('penalties (D12) and roundings (D9 / D13): the code with what it cost; no turns; what could be timed', () => {
    expect(m.penalties[0].text).toBe('DPI 15: Discretionary penalty: the protest committee added points instead of disqualifying — Cost 3 places — 12th on the water, scored 15th');
    expect(m.penalties.map((l) => l.text)).toContain('No penalty turns found on the track');
    expect(m.roundings.some((l) => /^Rounding zones? (not )?timed/.test(l.text))).toBe(true);
  });

  it('the same debrief whether the Coach tab’s cached one is passed or the report works it out', () => {
    expect(buildReport(input('USA 016', { deb }))).toEqual(m);
  });

  it('renders: penalty card above the numbered findings, the leg table, the print button, the thumbnail', () => {
    const html = reportHtml(m, { thumb: reportThumb(ic37.a, 'USA 016') });
    expect(html).toContain('data-state="ready"');
    expect(html).toContain('data-report-print');
    expect(html).toContain('Print / Save PDF');
    expect(html).toContain('<h2>USA 016 <span class="rp-name">Fair American</span></h2>');
    const pen = html.indexOf('class="rp-penalty"');
    expect(pen).toBeGreaterThan(-1);
    expect(pen).toBeLessThan(html.indexOf('class="rp-findings"'));
    expect(html.match(/<li class="rp-finding"/g)).toHaveLength(deb.cards.length);
    expect(html.match(/<tbody>[\s\S]*?<\/tbody>/)![0].match(/<tr/g)).toHaveLength(ic37.a.legs.length);
    expect(html).toMatch(/<figure class="rp-thumb"><svg [^>]*class="chart map/);
    expect(html).not.toMatch(/undefined|NaN|null|\[object/);
  });
});

describe('IC37 R5, USA 019 (over early, scored AOK)', () => {
  const m = buildReport(input('USA 019'));
  const deb = coachDebrief(ic37.a, ic37.m!, 'USA 019')!;

  it('the start: over at the gun, cleared at the Coach’s crossing; the over-early card is the start card', () => {
    const over = fieldOf(m.start, 'Over early (OCS)');
    expect(over.value).toMatch(/^cleared \+\d+ s$/);
    expect(over.warn).toBe(true);
    expect(over.note).toMatch(/went back \+\d+ s/);
    const cross = Math.round((ic37.m!.crossMs!['USA 019']! - ic37.a.meta.gunMs) / 1000);
    expect(over.value).toBe(`cleared +${cross} s`);
    expect(fieldOf(m.start, 'Distance to line at gun').value).toMatch(/^over \d+ m$/);
    // Over at the gun: no seconds late or start place (the start table's own —), and it says why.
    expect(fieldOf(m.start, 'Seconds late')).toMatchObject({ value: MISSING, note: 'over at the gun' });
    expect(fieldOf(m.start, 'Start place')).toMatchObject({ value: MISSING, note: 'over at the gun' });
    expect(m.startVerdict).toMatchObject({ kind: 'card', n: 1 });
    expect(m.startVerdict.text).toBe(`Over early — cleared at +${cross} s`);
    expect(m.coach.findings[0]).toMatchObject({ kind: 'D1', title: `Over early — cleared at +${cross} s` });
    expect(m.coach.findings.map((f) => f.title)).toEqual(deb.cards.map((c) => cardText(c, ic37.a.meta.tzOffsetMs).title));
  });

  it('no penalty card (scored AOK): "No official penalty"; the over-early tip is a thing to work on', () => {
    expect(m.coach.penalty).toBeNull();
    expect(fieldOf(m.header, 'Scored').value).toBe('11th of 15');
    expect(m.penalties[0]).toMatchObject({ text: 'No official penalty', kind: 'ok' });
    expect(m.coach.workOn[0]).toMatch(/Hold a safe gap to the line/);
  });
});

describe('sparse and missing data: — and coverage notes, never invented numbers', () => {
  // J/105 CBC R2: Good Trade (USA 96) has a 45 min hole through Run 1 and Beat 2; no official results.
  const j105 = coachOf(j105Race(2));
  const gt = j105.a.boats.find((b) => b.sail === 'USA 96')!;
  const m = buildReport({ a: j105.a, boat: gt.id, model: j105.m, group: LEADERS });

  it('notes the coverage, the place source; no official times; — for what is missing', () => {
    expect(m.state).toBe('ready');
    expect(m.notes.some((n) => /^The tracker covered \d+% of this boat’s race/.test(n))).toBe(true);
    expect(m.notes.some((n) => /^Places: /.test(n))).toBe(true);
    expect(fieldOf(m.header, 'Scored')).toMatchObject({ value: MISSING, note: 'no official results linked' });
    expect(fieldOf(m.header, 'Elapsed (official)')).toMatchObject({ value: MISSING, note: 'no official results' });
    expect(fieldOf(m.header, 'Corrected (official)')).toMatchObject({ value: MISSING, note: 'no official results' });
    expect(fieldOf(m.header, 'Tracker coverage').warn).toBe(true);
    // A leg with no result is all —, apart from places the leg stories estimate (~).
    gt.legs.forEach((l, k) => {
      const row = m.legs[k];
      if (l) return;
      expect([row.time, row.sog, row.vmg, row.manoeuvres, row.coverage]).toEqual([MISSING, MISSING, MISSING, MISSING, MISSING]);
      expect(row.places === MISSING || row.places.includes('~')).toBe(true);
    });
    const html = reportHtml(m);
    expect(html).not.toMatch(/undefined|NaN|null|Infinity|\[object/);
    expect(html).toContain('class="rp-sec-notes"');
  });

  it('while the Coach model is being built: pending, the analysis’ own figures only, nothing guessed', () => {
    const p = buildReport({ ...input('USA 016'), model: undefined });
    expect(p.state).toBe('pending');
    expect(p.coach).toMatchObject({ findings: [], penalty: null, empty: 'Working out the wind and the Coach findings…' });
    expect(fieldOf(p.start, 'Over the line')).toMatchObject({ value: MISSING, note: 'working out the crossings…' });
    expect(p.legs.every((l) => l.places === MISSING && l.vsGroup === MISSING)).toBe(true);
    expect(fieldOf(p.header, 'On the water').value).toBe('12th of 15');
    expect(reportHtml(p)).toContain('data-state="pending"');
  });

  it('official results still being linked: pending, and the page says the places may change', () => {
    const p = buildReport({ ...input('USA 016'), settling: true });
    expect(p.state).toBe('pending');
    expect(p.notes[0]).toBe('Checking for official results: the places may still change.');
    expect(p.coach.findings.length).toBeGreaterThan(0);
  });

  it('no course to measure against (model null): no Coach findings, says so', () => {
    const p = buildReport({ ...input('USA 016'), model: null });
    expect(p.state).toBe('ready');
    expect(p.coach.empty).toMatch(/^No course to measure against/);
    expect(fieldOf(p.start, 'Over the line').value).toBe(MISSING);
  });

  it('no boat selected: a prompt to pick one, and nothing else', () => {
    const p = buildReport({ ...input('USA 016'), boat: null });
    expect(p).toMatchObject({ state: 'no-boat', header: [], legs: [] });
    const html = reportHtml(p);
    expect(html).toContain(REPORT_NO_BOAT);
    expect(html).toContain('data-state="no-boat"');
    expect(html).toMatch(/data-report-print disabled/);
    // A boat that didn't sail this race is the same as none.
    expect(buildReport({ ...input('USA 016'), boat: 'NOPE' }).state).toBe('no-boat');
  });
});

describe('never owner or crew names from Yachtscoring', () => {
  const NAMES = ['Jane Q. Owner', 'Bob Skipperson', 'Crew Member Alpha', 'Helm Personname', 'YS Yacht Sentinel'];
  // The official rows as the proxy might pass them on, with every name-ish field filled in.
  const off = ic37Official((boats) => {
    for (const b of boats as Record<string, unknown>[]) {
      Object.assign(b, { name: NAMES[4], ownerName: NAMES[0], skipper: NAMES[1], crew: [NAMES[2]], helmName: NAMES[3], owner: { firstName: 'Jane', lastName: NAMES[0] } });
    }
  });
  const linked = coachOf(ic37LinkedRace(off));

  it('none of them in the model or the page, for any boat', () => {
    for (const b of linked.a.boats) {
      const m = buildReport({ a: linked.a, boat: b.id, raceName: 'Race 5', model: linked.m, group: LEADERS, official: off });
      const html = reportHtml(m, { thumb: reportThumb(linked.a, b.id) });
      for (const n of NAMES) {
        expect(allText(m)).not.toContain(n);
        expect(html).not.toContain(n);
      }
    }
  });

  it('the boat is named by RaceSense’s sail and boat name', () => {
    const m = buildReport({ a: linked.a, boat: 'USA 016', model: linked.m, group: LEADERS, official: off });
    expect([m.sail, m.boatName]).toEqual(['USA 016', 'Fair American']);
  });
});

describe('the regatta version (Coach view Regatta)', () => {
  const digest = (n: number, finish: RaceDigest['finish'], status: RegattaRace['status'] = 'done'): RegattaRace => ({
    raceNumber: n,
    label: `R${n}`,
    name: `Race ${n}`,
    status,
    digest:
      status === 'done'
        ? { raceNumber: n, sail: 'USA 016', tracked: true, finish, coverage: n === 2 ? 0.5 : 0.95, noData: false, legs: [], findings: [{ theme: 'upwind', kind: 'D6', variant: 'slow', seconds: 40, confidence: 'high' }] }
        : null,
  });
  const races = [
    digest(1, { place: null, code: 'DPI', of: 15, source: 'official', points: 14, onWater: 11, penaltyPlaces: 3 }),
    digest(2, { place: 4, code: null, of: 15, source: 'official' }),
    digest(3, null, 'running'),
  ];

  it('one line per race; pending until every race is analysed; the Regatta view’s penalties', () => {
    const p = buildReport({ ...input('USA 016'), scope: 'regatta', regatta: summarizeRegatta(races) });
    expect(p.state).toBe('pending');
    expect(p.regatta!.rows.map((r) => [r.label, r.place, r.of, r.onWater])).toEqual([
      ['R1', 'DPI 14', '15', '11th'],
      ['R2', '4th', '15', MISSING],
      ['R3', MISSING, MISSING, MISSING],
    ]);
    expect(p.regatta!.rows[1].low).toBe(true);
    expect(p.regatta!.rows[2].status).toBe('not analyzed yet');
    expect(p.regatta!.penalties).toEqual(['DPI in 1 of 2 races (R1) · 3 penalty points · ≈ 3 places']);
    const done = buildReport({ ...input('USA 016'), scope: 'regatta', regatta: summarizeRegatta(races.slice(0, 2)) });
    expect(done.state).toBe('ready');
    const html = reportHtml(done);
    expect(html).toContain('scope-regatta');
    expect(html).toContain('Top 3 to work on');
    expect(html).toContain('aria-pressed="true">Regatta');
  });

  it('without the Regatta view’s data yet: pending, waiting', () => {
    const p = buildReport({ ...input('USA 016'), scope: 'regatta', regatta: null });
    expect(p.state).toBe('pending');
    expect(reportHtml(p)).toContain('Waiting for the races to be analyzed');
  });
});

describe('print CSS and the page', () => {
  const css = readFileSync(here('../src/style.css'), 'utf8');
  const html = readFileSync(here('../index.html'), 'utf8');
  const print = css.slice(css.lastIndexOf('@media print'));

  it('a print block: @page margins, the app chrome hidden, light colours, the report alone', () => {
    expect(print).toMatch(/@page \{ size: auto; margin: \d+mm; \}/);
    for (const sel of ['.masthead', '.controls', '.boatbar', '.wrap > footer', '.rp-bar']) expect(print).toContain(`body.report-on ${sel}`);
    expect(print).toMatch(/body\.report-on \{\s*color-scheme: light;/);
    expect(print).toContain('--surface: #fff');
    // On screen the report stands in for the race header and the tabs.
    expect(css).toContain('body.report-on .content > :not(#report) { display: none !important; }');
  });

  it('index.html has the Report button and the report section (hidden until opened)', () => {
    expect(html).toMatch(/<button type="button" id="report-open" class="report-open"[^>]*>Report<\/button>/);
    expect(html).toMatch(/<section id="report" class="report-wrap" aria-label="Boat report" hidden><\/section>/);
  });
});
