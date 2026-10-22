import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { ROUND_WINDOW_MS, SIDE_MIN_BOATS, classifyRounding, fleetPlaces, legStories, sidePaid, type LegStory } from '../src/analysis/coach/legStory';
import { MS_TO_KN, bearingVec, type Vec } from '../src/analysis/geo';
import type { RaceAnalysis } from '../src/analysis/types';
import type { RaceData } from '../src/data/types';
import { LEG_STORY_BULLETS, groupSecondsChip, legStoriesHtml, legStoryText, placeChip, placesWord } from '../src/ui/coachLegs';
import { legsTable, progressCell, toggleSort } from '../src/ui/table';
import { c31Race, fixtureRace, j105Race, j88Race, m24Race } from './helpers';

const T0 = 5_000_000;

/** Upwind on starboard (course 315°, wind from 0°) to the mark at T0 + 60 s, then `after(s since the mark)` as the course. */
function rounding(after: (s: number) => number, stepMs = 1000) {
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let p: Vec = [0, 0];
  const v = 6 / MS_TO_KN;
  for (let ms = 0; ms <= 180_000; ms += stepMs) {
    t.push(T0 + ms);
    x.push(p[0]);
    y.push(p[1]);
    const s = (ms - 60_000) / 1000;
    const d = bearingVec(s < 0 ? -45 : after(s));
    p = [p[0] + (d[0] * v * stepMs) / 1000, p[1] + (d[1] * v * stepMs) / 1000];
  }
  return { t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y) };
}
const twd0 = (): number => 0;
const MARK = T0 + 60_000;

describe('classifyRounding (gybe-set vs bear-away)', () => {
  it('a gybe onto port within 30 s of the windward mark is a gybe-set', () => {
    expect(classifyRounding(rounding((s) => (s < 8 ? -150 : 150)), twd0, MARK)).toBe('gybe-set');
  });
  it('bearing away on starboard (and gybing later) is a bear-away', () => {
    expect(classifyRounding(rounding(() => -150), twd0, MARK)).toBe('bear-away');
    expect(classifyRounding(rounding((s) => (s < ROUND_WINDOW_MS / 1000 + 20 ? -150 : 150)), twd0, MARK)).toBe('bear-away');
  });
  it('a tack at the mark is not a gybe-set', () => {
    expect(classifyRounding(rounding((s) => (s < 15 ? 45 : 150)), twd0, MARK)).toBe('bear-away');
  });
  it('a sparse track round the mark is unknown', () => {
    expect(classifyRounding(rounding((s) => (s < 8 ? -150 : 150), 20_000), twd0, MARK)).toBeNull();
  });
});

describe('which side paid', () => {
  const rows = (gains: number[]) => gains.map((gain, i) => ({ x: i * 100 - 300, gain }));
  it('the outer thirds by across-wind position: right third gained 2+ places more → right paid', () => {
    const r = sidePaid(rows([-2, -1, 0, 0, 1, 2]))!;
    expect(r).toMatchObject({ verdict: 'right', n: 2, left: -1.5, right: 1.5, effect: 3 });
    expect(sidePaid(rows([3, 2, 0, 0, -1, -2]))!.verdict).toBe('left');
  });
  it('under 1 place apart, or fewer than 6 boats: no verdict', () => {
    expect(sidePaid(rows([0, 1, 0, 0, 0, 0.5]))!.verdict).toBe('none');
    expect(sidePaid(rows([-2, -1, 1, 2]))).toBeNull();
    expect(SIDE_MIN_BOATS).toBe(6);
  });
  it('order of the rows does not matter, only their positions', () => {
    const a = rows([-2, -1, 0, 0, 1, 2]);
    expect(sidePaid([...a].reverse())).toEqual(sidePaid(a));
  });
});

function setup(data: RaceData) {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  return { a, model: buildCoach(a, raw.wind, raw.crossMs)! };
}

describe('leg stories: Good Trade, race 3', () => {
  const { a, model } = setup(j105Race(3));
  const top3 = legStories(a, model, 'USA 96', { kind: 'leaders' });
  const fleet = legStories(a, model, 'USA 96', { kind: 'fleet' });

  it("one story per leg, named as the race's legs, over the group and the boat", () => {
    expect(top3.map((s) => s.name)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(top3[0].set).toEqual(['USA 96', 'USA 328', 'USA 29', 'USA 159']);
    expect(fleet[0].set).toHaveLength(18);
  });
  it('places in the whole fleet, out of all 18 on every leg: Good Trade 2nd → 9th on Beat 1 (Crescendo the top gainer of the group)', () => {
    const s = top3[0];
    expect(s.mine).toMatchObject({ from: 2, to: 9, gain: -7 });
    expect(top3.map((x) => x.placeOf)).toEqual([18, 18, 18, 18]);
    expect(s.gainers[0].id).toBe('USA 159');
    expect(placeChip(s)).toBe('lost 7 · 9th of 18');
    // Against the Top 3: seconds vs their median leg time, not a place among four boats.
    expect(groupSecondsChip(s, { kind: 'leaders' })).toBe(`lost ${Math.round(s.vsGroup!.deltaS)} s vs Top 3`);
    expect(s.vsGroup!.deltaS).toBeGreaterThan(30);
    expect(groupSecondsChip(fleet[0], { kind: 'fleet' })).toBeNull();
    expect(fleet[0].vsGroup).toBeNull();
    // The leg's place at the end is the next leg's at the start.
    for (let k = 1; k < top3.length; k++) expect(top3[k].mine!.from).toBe(top3[k - 1].mine!.to);
  });
  it('the side needs 6 boats: Top 3 falls back to the fleet, and says so', () => {
    for (const s of top3) if (s.side) expect(s.side.fleet).toBe(true);
    for (const s of fleet) if (s.side) expect(s.side.fleet).toBe(false);
  });
  it('runs after a windward mark get the rounding stat; every tracked J/105 bore away (first gybes > 2 min after)', () => {
    expect(fleet[0].rounding).toBeNull();
    const r = fleet[1].rounding!;
    expect(r.gybeSet.n).toBe(0);
    expect(r.bearAway.n).toBeGreaterThanOrEqual(3);
    // Fleet places gained (not re-ranked within the class): a small mean either way.
    expect(Math.abs(r.bearAway.gain!)).toBeLessThan(3);
  });
  it('fastest leg time and the boat’s rank; ⚠ low coverage on the collapsed row', () => {
    const s = fleet[0];
    expect(s.fastest!.id).toBe('USA 328');
    expect(s.myTime!.of).toBeGreaterThan(10);
    expect(s.coverage!).toBeLessThan(0.5);
    const t = legStoryText(s, a, 'USA 96', { kind: 'fleet' });
    expect(t.summary.some((c) => c.cls === 'warn' && /^tracker \d+%$/.test(c.text))).toBe(true);
    expect(t.lines.flat().some((c) => c.text === 'marks est.')).toBe(true);
    expect(placeChip(s)).toMatch(/^(gained \d+|lost \d+|even) · ~?\d+(st|nd|rd|th) of 18$/);
  });
  it('renders collapsed <details> cards under a short heading, chips only, no NaN', () => {
    const html = legStoriesHtml(top3, a, 'USA 96', { kind: 'leaders' });
    expect(html).toContain('<h3 id="coach-legs-title">Leg by leg</h3>');
    expect(html.match(/<details class="card coach-leg" data-leg="\d">/g)).toHaveLength(4);
    expect(html).not.toMatch(/ open>|NaN|undefined|null|held/);
    expect(html).toContain('of 18');
    expect(html).toContain('s vs Top 3');
    // No restating paragraph: the chips and the ⓘ carry it.
    expect(html).not.toContain('class="leg-what"');
    expect(legStoriesHtml(top3, a, 'USA 96', { kind: 'leaders' }, new Set([2]))).toContain('data-leg="2" open>');
    // ⓘ: closed by default.
    expect(html).toContain('<details class="info">');
    for (const b of LEG_STORY_BULLETS) expect(b.split(/\s+/).length).toBeLessThanOrEqual(18);
  });
});

describe('leg story text (templates)', () => {
  const a = { boats: [{ id: 'A', sail: 'A', name: 'Mirage' }, { id: 'B', sail: 'B', name: 'Rocket' }, { id: 'me', sail: 'ME', name: 'Good Trade' }] } as unknown as RaceAnalysis;
  const base: LegStory = {
    leg: 1,
    name: 'Run 1',
    kind: 'downwind',
    set: ['me', 'A', 'B'],
    gainers: [{ id: 'A', gain: 3, from: 5, to: 2 }],
    losers: [{ id: 'B', gain: -2, from: 3, to: 5 }],
    moversFleet: false,
    mine: { id: 'me', gain: 2, from: 4, to: 2 },
    placeOf: 31,
    vsGroup: { deltaS: -12.4, n: 3 },
    side: { verdict: 'right', n: 3, left: -0.7, right: 2.3, effect: 3, mineM: 120, of: 9, fleet: false },
    rounding: { gybeSet: { n: 2, gain: 1.1 }, bearAway: { n: 5, gain: -0.4 }, mine: 'gybe-set', of: 7, fleet: false },
    fastest: { id: 'A', timeS: 754 },
    myTime: { rank: 3, of: 9, timeS: 780 },
    coverage: 0.9,
    marksEstimated: false,
  };
  const g = { kind: 'leaders' as const };
  it('chips: movers (coached boat highlighted), side numbers, rounding, times — no repeated verdict', () => {
    const t = legStoryText(base, a, 'me', g);
    expect(t.lines[0]).toEqual([{ text: '▲ Mirage +3' }, { text: '▼ Rocket −2' }, { text: '▲ you +2', cls: 'me' }].map((c) => ({ cls: undefined, ...c })));
    expect(t.lines[1].map((c) => c.text)).toEqual(['3 furthest right +2.3 places', 'you 120 m right']);
    expect(t.lines[2].map((c) => c.text)).toEqual(['gybe-set 2 of 7 · +1.1', 'bear-away 5 of 7 · −0.4']);
    expect(t.lines[2][0].cls).toBe('me');
    expect(t.lines[3].map((c) => c.text)).toEqual(['fastest Mirage 12:34', 'your leg time 3rd fastest']);
    expect(t.summary.map((c) => c.text)).toEqual(['Right paid', 'gained 2 · 2nd of 31', 'gained 12 s vs Top 3']);
    expect(t.sentence).toBe('');
  });
  it('no restating sentence; an even leg reads "even", never "held N of N"', () => {
    expect(legStoryText(base, a, 'me', g).sentence).toBe('');
    const none = { ...base, side: { ...base.side!, verdict: 'none' as const }, rounding: null, mine: { id: 'me', gain: 0, from: 2, to: 2 }, vsGroup: { deltaS: 0.3, n: 3 } };
    expect(placeChip(none)).toBe('even · 2nd of 31');
    const t = legStoryText(none, a, 'me', g);
    expect(t.summary.map((c) => c.text)).toEqual(['No side paid', 'even · 2nd of 31', 'even with Top 3']);
    expect(JSON.stringify(t)).not.toContain('held');
    expect([placesWord(3), placesWord(-5), placesWord(0)]).toEqual(['gained 3', 'lost 5', 'even']);
    // Near ±3, a custom group: seconds too; an estimated place carries ~ and says why.
    expect(groupSecondsChip({ vsGroup: { deltaS: 7.6, n: 6 } }, { kind: 'near' })).toBe('lost 8 s vs Near ±3');
    const est = legStoryText({ ...base, mine: { id: 'me', gain: -1, from: 4, to: 5, est: true } }, a, 'me', g);
    expect(est.summary.map((c) => c.text)).toContain('lost 1 · ~5th of 31');
    expect(est.lines.flat().some((c) => c.text.startsWith('~ place estimated'))).toBe(true);
  });
  it('the coached boat as a mover reads "you"; one exit only: no place delta', () => {
    const t = legStoryText({ ...base, gainers: [{ id: 'me', gain: 1, from: 4, to: 3 }], mine: { id: 'me', gain: 1, from: 4, to: 3 }, rounding: { ...base.rounding!, gybeSet: { n: 0, gain: null }, bearAway: { n: 7, gain: 0 }, mine: 'bear-away' } }, a, 'me', g);
    expect(t.lines[0][0]).toEqual({ text: '▲ you +1', cls: 'me' });
    expect(t.lines[2].map((c) => c.text)).toEqual(['bear-away 7 of 7']);
  });
  it('a group too small: the fleet chip once; thin tracker: a ⚠ chip on the closed row', () => {
    const t = legStoryText({ ...base, moversFleet: true, side: { ...base.side!, fleet: true }, coverage: 0.15 }, a, 'me', g);
    expect(t.lines.flat().filter((c) => c.text === 'whole fleet: group too small')).toHaveLength(1);
    expect(t.summary.some((c) => c.cls === 'warn' && c.text === 'tracker 15%')).toBe(true);
    const empty = legStoryText({ ...base, coverage: null }, a, 'me', g);
    expect(empty.summary.some((c) => c.cls === 'warn' && c.text === 'no data')).toBe(true);
  });
});

describe('progress ratio (legs table)', () => {
  it('straight line ÷ distance sailed: in (0, 1] on every leg of every fixture, — when missing, ~ across a gap', () => {
    const races: RaceData[] = [fixtureRace(), m24Race(), j88Race(), c31Race(), j105Race(1), j105Race(3)];
    let n = 0;
    for (const data of races) {
      const a = analyzeRace(data);
      for (const b of a.boats) {
        for (const l of b.legs) {
          if (!l || l.progress == null) continue;
          n++;
          expect(l.progress).toBeGreaterThan(0);
          expect(l.progress).toBeLessThanOrEqual(1.05);
        }
      }
      // Upwind legs well under 1 (tacking), runs nearer it.
      const up = a.boats.flatMap((b) => b.legs.filter((l, i) => l && a.legs[i].kind === 'upwind').map((l) => l!.progress!)).filter((x) => x != null);
      if (up.length) expect(up.reduce((s, x) => s + x, 0) / up.length).toBeLessThan(0.9);
    }
    expect(n).toBeGreaterThan(50);
    expect(progressCell(null)).toBe('—');
    expect(progressCell({ progress: null } as never)).toBe('—');
    expect(progressCell({ progress: 0.923, distGapS: null } as never)).toBe('92%');
    expect(progressCell({ progress: 0.7, distGapS: 40 } as never)).toContain('~70%');
  });
  it('a Prog column per leg, ranked, sortable, best first', () => {
    const a = analyzeRace(fixtureRace());
    const sort = toggleSort(a, null, 'L0.prog')!;
    expect(sort).toEqual({ key: 'L0.prog', dir: 'desc' });
    const html = legsTable(a, null, sort);
    expect(html).toContain('data-sort="L0.prog"');
    expect(html).toContain('Prog<br><small>%</small>');
    // Sorted best first.
    const best = [...a.boats].filter((b) => b.legs[0]?.progress != null).sort((p, q) => q.legs[0]!.progress! - p.legs[0]!.progress!)[0];
    expect([...html.matchAll(/<tr data-id="([^"]+)"/g)].map((m) => m[1])[0]).toBe(best.id);
  });
});

describe('leg stories: Good Trade, race 2 (sparse tracker)', () => {
  it('a collapsed row with 15% coverage shows ⚠ tracker N%, not an empty-looking card', () => {
    const { a, model } = setup(j105Race(2));
    const st = legStories(a, model, 'USA 96', { kind: 'leaders' });
    expect(st.every((s) => s.coverage != null && s.coverage < 0.2)).toBe(true);
    for (const s of st) {
      const t = legStoryText(s, a, 'USA 96', { kind: 'leaders' });
      expect(t.summary.some((c) => c.cls === 'warn' && c.text === 'tracker 15%')).toBe(true);
    }
  });
});

describe('leg stories: sanity across the other fixtures', () => {
  const races: [string, () => RaceData][] = [
    ['benelux J70 r8', fixtureRace],
    ['m24 r4', m24Race],
    ['j88 r5', j88Race],
    ['c31 r10', () => c31Race()],
  ];
  for (const [name, mk] of races) {
    it(`${name}: one story per leg for a few boats and every group; sane numbers; renders`, () => {
      const { a, model } = setup(mk());
      const ids = a.boats.filter((_, i) => a.boats.length <= 8 || i % 4 === 0).map((b) => b.id);
      for (const id of ids) {
        for (const g of [{ kind: 'leaders' }, { kind: 'near' }, { kind: 'fleet' }] as const) {
          const st = legStories(a, model, id, g);
          expect(st).toHaveLength(a.legs.length);
          for (const s of st) {
            // Fleet places, one fixed fleet on every leg.
            const n = s.placeOf;
            expect(n).toBe(st[0].placeOf);
            expect(n).toBeGreaterThanOrEqual(a.boats.length);
            for (const m of [...s.gainers, ...s.losers, ...(s.mine ? [s.mine] : [])]) {
              expect(Math.abs(m.gain)).toBeLessThan(n);
              expect(m.from).toBeGreaterThanOrEqual(1);
              expect(m.to).toBeLessThanOrEqual(n);
            }
            if (s.side) expect(['left', 'right', 'none']).toContain(s.side.verdict);
            if (s.fastest) expect(s.fastest.timeS).toBeGreaterThan(30);
            if (s.myTime) expect(s.myTime.rank).toBeLessThanOrEqual(s.myTime.of);
            if (s.rounding) expect(s.rounding.gybeSet.n + s.rounding.bearAway.n).toBe(s.rounding.of);
          }
          expect(legStoriesHtml(st, a, id, g)).not.toMatch(/NaN|undefined|null|held/);
        }
      }
    });
  }
});

describe('fleet places: a fixed fleet when a tracker drops out', () => {
  // Five boats, Beat / Run / Beat. C loses its tracker after M1 but has an official finish; E loses it after
  // M1 and has no finish at all (no code either: the finish fell in the hole).
  const legOf = (s: number, e: number, rank: number) => ({ startMs: s * 1000, endMs: e * 1000, timeS: e - s, rankAtEnd: rank, coverage: 1, vmgKn: 5 });
  const boat = (id: string, start: number, m1: number, m2: number | null, fin: number | null, pos: number | null) => ({
    id,
    sail: id,
    name: `Boat ${id}`,
    finishPos: pos,
    finishMs: fin != null ? fin * 1000 : null,
    start: { startPlace: start },
    legs: [legOf(0, m1, start), m2 != null ? legOf(m1, m2, 0) : null, m2 != null && fin != null ? legOf(m2, fin, 0) : null],
  });
  const a = {
    meta: { gunMs: 0 },
    legs: [
      { index: 0, name: 'Beat 1', kind: 'upwind', to: 'M1' },
      { index: 1, name: 'Run 1', kind: 'downwind', to: 'M2' },
      { index: 2, name: 'Beat 2', kind: 'upwind', to: 'Finish' },
    ],
    legSource: 'course',
    marks: [],
    boats: [boat('A', 1, 600, 1000, 1500, 1), boat('B', 2, 620, 1010, 1510, 2), boat('C', 3, 640, null, 1520, 3), boat('D', 4, 660, 1030, 1530, 4), boat('E', 5, 680, null, null, null)],
  } as unknown as RaceAnalysis;
  const m = { tracks: new Map(), wind: { twdAt: () => 0 } } as unknown as Parameters<typeof legStories>[1];

  it('every boat has a place at every mark, out of the same 5; the dropped boats are interpolated / carried on, marked ~', () => {
    const fp = fleetPlaces(a);
    expect(fp.of).toBe(5);
    for (const col of [0, 1, 2, 3]) expect([...fp.byId.values()].map((r) => r.place[col]).sort()).toEqual([1, 2, 3, 4, 5]);
    // C at M2: between its M1 (640 s) and its finish (1520 s) along the fleet's median splits → ~1012 s, 3rd.
    expect(fp.byId.get('C')).toMatchObject({ place: [3, 3, 3, 3], est: [false, false, true, false] });
    // E: carried on at its own pace from M1 → last at M2 and at the finish.
    expect(fp.byId.get('E')).toMatchObject({ place: [5, 5, 5, 5], est: [false, false, true, true] });
  });
  it('official extras (tracked, not in the results) do not inflate "of N" past the official fleet', () => {
    const off = {
      ...a,
      meta: { gunMs: 0, results: { places: 'official' as const, times: 'official' as const, trackerFinishes: 0, trackNoOfficial: ['E'], officialNoTrack: ['Z'] } },
    } as unknown as RaceAnalysis;
    const fp = fleetPlaces(off);
    // 5 tracked − 1 extra + 1 official-no-track = 5; E is out of the ranking.
    expect(fp.of).toBe(5);
    expect(fp.byId.has('E')).toBe(false);
    expect([...fp.byId.values()].map((r) => r.place[0]).sort((p, q) => p! - q!)).toEqual([1, 2, 3, 4]);
    const st = legStories(off, m, 'A', { kind: 'fleet' });
    expect(st.map((s) => s.placeOf)).toEqual([5, 5, 5]);
    expect(placeChip(st[0])).toBe('even · 1st of 5');
  });

  it('the leg table reads "of 5" on every leg for the boat that dropped out, never "held"', () => {
    for (const g of [{ kind: 'leaders' as const }, { kind: 'fleet' as const }]) {
      const st = legStories(a, m, 'C', g);
      expect(st.map((s) => s.placeOf)).toEqual([5, 5, 5]);
      expect(st.map((s) => placeChip(s))).toEqual(['even · 3rd of 5', 'even · ~3rd of 5', 'even · ~3rd of 5']);
      expect(legStoriesHtml(st, a, 'C', g)).not.toContain('held');
    }
    // Against the Top 3 (A, B, D): Beat 1 in 640 s vs their median 620 s → lost 20 s; no time on Run 1 → no chip.
    const top = legStories(a, m, 'C', { kind: 'leaders' });
    expect(groupSecondsChip(top[0], { kind: 'leaders' })).toBe('lost 20 s vs Top 3');
    expect(groupSecondsChip(top[1], { kind: 'leaders' })).toBeNull();
  });
});
