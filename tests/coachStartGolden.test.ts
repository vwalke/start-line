import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw, rivalLadder } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { coachCtx } from '../src/analysis/coach/detectors/context';
import { startOrder } from '../src/analysis/coach/detectors/start';
import { rankOpportunities } from '../src/analysis/coach/rank';
import { raceDigest } from '../src/analysis/coach/regatta';
import { classDims, matchClass } from '../src/data/classes';
import { askFinding } from '../src/ui/coachAskContext';
import { cardText, coachCardsHtml, goodTexts, secondsChip, windowChip } from '../src/ui/coachCards';
import { projectCoachTrack } from '../src/analysis/coach/tracks';
import { dot, len, makeProjection, sub, type Vec } from '../src/analysis/geo';
import { startCross } from '../src/analysis/startCross';
import { ic37Race } from './helpers';

/**
 * Coach start detector (D1) against IC37 North Americans race 5 (gun Sat Oct 10 2026 10:05:01 EDT), the case
 * that showed D1 missing second-row starts: USA 027 was 25 m back at the gun and 11th of 15 over the line (13th
 * counting the two OCS boats' early crossings; they start at their recross), 10.5 s after a front row that crossed
 * at the gun, then tacked 3 times in the first 90 s. USA 017 and USA 019 were over early. The fixture is the whole
 * fleet from gun − 60 s to the end of Beat 1 (1–2 s to +6 min, 20 s after), so the start, the D3 after it and a
 * Beat 1 D6 are all measured through the app's own path; the later legs are not in it (nothing asserted there).
 */
const data = ic37Race();
const a = analyzeRace(data);
const raw = coachRaw(a, data);
const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null)!;
const idOf = (sail: string): string => a.boats.find((b) => b.sail === sail)!.id;
const debrief = (sail: string) => coachDebrief(a, m, idOf(sail))!;
const startCard = (sail: string) => debrief(sail).cards.find((c) => c.kind === 'D1');
const startTick = (sail: string) => debrief(sail).ok.find((n) => n.detector === 'D1');
const gun = a.meta.gunMs;

describe('IC37: class dimensions', () => {
  it('IC37 is 11.30 m × 3.65 m under its RaceSense names', () => {
    for (const name of ['IC37', 'IC 37', 'ic-37', 'Melges IC37']) expect(classDims(name)).toEqual({ loaM: 11.3, beamM: 3.65 });
    expect(a.meta.division).toBe('IC37');
    expect(matchClass([a.meta.classLabel, a.meta.boatClass, a.meta.division])!.dims.loaM).toBe(11.3);
    expect(coachCtx(a, m, idOf('USA 027'))!.loaM).toBe(11.3);
  });
});

describe('IC37 R5: the front row', () => {
  const so = startOrder(coachCtx(a, m, idOf('USA 027'))!)!;
  const sails = (cs: { id: string }[]) => cs.map((c) => a.boats.find((b) => b.id === c.id)!.sail);

  it('the first 5 clean crossings, early ones within 3 s included; USA 019 and USA 017 (over at the gun) left out', () => {
    expect(a.boats.filter((b) => b.start?.over).map((b) => b.sail).sort()).toEqual(['USA 017', 'USA 019']);
    expect(sails(so.front)).toEqual(['GBR 015', 'USA 12', 'USA 005', 'USA 008', 'USA 11']);
    // GBR 015 and USA 12 crossed just before the gun: the median (USA 005) is at the gun.
    expect((so.front[0].tMs - gun) / 1000).toBeLessThan(0);
    expect(so.frontMedMs).toBeGreaterThanOrEqual(gun);
    expect((so.frontMedMs - gun) / 1000).toBeLessThan(0.5);
    expect(so.order).toHaveLength(15);
  });
});

describe('IC37 R5: over early (OCS) — USA 017 and USA 019', () => {
  // The app's own geometry: the raw fixes in the start line's projection, the course side toward the first mark.
  const proj = makeProjection({ lat: (data.startLine.left.lat + data.startLine.right.lat) / 2, lon: (data.startLine.left.lon + data.startLine.right.lon) / 2 });
  const { left, right } = a.line;
  const along = sub(right, left);
  const n0: Vec = [-along[1] / len(along), along[0] / len(along)];
  const side: Vec = dot(sub(a.legPts![1], left), n0) < 0 ? [-n0[0], -n0[1]] : n0;
  const cross = (sail: string, bow = true) => {
    const b = data.boats.find((x) => x.sail === sail)!;
    return startCross(projectCoachTrack(b.track, proj), left, right, side, gun, { bowM: bow ? b.bowOffsetM : 0 });
  };
  const s = (t: number | null) => (t == null ? NaN : (t - gun) / 1000);

  it('both flagged OCS by the feed; over at the gun, back, and cleared at their recross', () => {
    for (const sail of ['USA 017', 'USA 019']) expect(a.boats.find((b) => b.sail === sail)!.start).toMatchObject({ ocs: true, over: true });
    // recall-zoom-ocs.py: USA 017 recrossed ≈ +28.0 s. The antenna's crossing (no bow) is +27.8 s; at the bow (4.9 m ahead), +26.2 s.
    const u17 = cross('USA 017');
    expect(u17.early).toBe(true);
    expect(s(u17.firstCrossMs)).toBeLessThan(0);
    expect(s(u17.wentBackMs)).toBeCloseTo(7.4, 0);
    expect(Math.abs(s(cross('USA 017', false).clearedMs) - 28.0)).toBeLessThanOrEqual(2);
    expect(Math.abs(s(u17.clearedMs) - 28.0)).toBeLessThanOrEqual(2);
    // The script had USA 019 at +39.4 s, but it read only the rows tagged race 5 (most of the feed's are tagged 0): the raw
    // fixes cross between +36.5 s (0.7 m short) and +37.0 s (0.3 m over), and the first race-5 row after that is +39.4 s.
    // The antenna's crossing is +36.8 s; at the bow, +35.1 s.
    const u19 = cross('USA 019');
    expect(u19.early).toBe(true);
    expect(s(u19.wentBackMs)).toBeCloseTo(12.9, 0);
    expect(Math.abs(s(cross('USA 019', false).clearedMs) - 36.8)).toBeLessThanOrEqual(1);
    expect(Math.abs(s(u19.clearedMs) - 35.1)).toBeLessThanOrEqual(1);
    // The Coach times their start from the clearing (bow) crossing; the others' crossings are unchanged.
    for (const sail of ['USA 017', 'USA 019']) expect(raw.crossMs[idOf(sail)]).toBe(cross(sail).clearedMs);
    expect(raw.crossMs[idOf('USA 027')]).toBe(cross('USA 027').firstCrossMs);
  });

  it('an "Over early — cleared at +N s" card, seconds = the clearing − the front row; never front row, never ✓', () => {
    const so = startOrder(coachCtx(a, m, idOf('USA 017'))!)!;
    for (const [sail, at, rank] of [['USA 017', 26, 14], ['USA 019', 35, 15]] as const) {
      const c = startCard(sail)!;
      expect(c.variant).toBe('ocs');
      expect(c.seconds).toBeCloseTo((raw.crossMs[idOf(sail)]! - so.frontMedMs) / 1000, 6);
      expect(Math.round(c.facts.crossS as number)).toBe(at);
      const t = cardText(c);
      expect(t.title).toBe(`Over early — cleared at +${at} s`);
      expect(secondsChip(c)).toBe(`≈ ${Math.round(c.seconds)} s`);
      expect(t.chips).toEqual(['over early', `cleared +${at} s`, `${rank}th of 15 over line`]);
      expect(t.sentence).toBe(`You were over at the gun and had to come back; you cleared at +${at} s, about ${Math.round(c.seconds)} s behind the front row.`);
      expect(t.tip).toBe('Hold a safe gap to the line in the last 30 s; a bow out costs far more than a second late.');
      expect(startTick(sail)).toBeUndefined();
      expect(so.front.some((x) => x.id === idOf(sail))).toBe(false);
      expect(c.refBoats).not.toContain(idOf('USA 017'));
      expect(c.refBoats).not.toContain(idOf('USA 019'));
      expect(raceDigest(a, m, sail).findings.find((f) => f.kind === 'D1')).toMatchObject({ theme: 'start', variant: 'ocs' });
    }
  });
});

describe('IC37 R5: start cards', () => {
  it('USA 027: one merged start card ≈ 27 s — 25 m back, 11th of 15, +11 s, then 3 early tacks (16 s more on the chart)', () => {
    const d = debrief('USA 027');
    const c = startCard('USA 027')!;
    expect(c.variant).toBe('second-row');
    expect(c.confidence).toBe('high');
    // 10.8 s after the front row + 16.1 s lost to the top 3 from the crossing to +5 min: the chart's points (Top 3's mean)
    // at either end of D3's window (7.9 s on their median). On the wind ladder (one-minute medians) the second part was
    // 14.0 s (24.9 s in all).
    expect(c.seconds).toBeGreaterThanOrEqual(24);
    expect(c.seconds).toBeLessThanOrEqual(30);
    expect(c.facts.d1S as number).toBeGreaterThan(9);
    expect(c.facts.d1S as number).toBeLessThan(12);
    expect(c.facts.d3S as number).toBeGreaterThan(14);
    expect(c.facts.d3S as number).toBeLessThan(18);
    const [g] = c.gaps!;
    const l = rivalLadder(m, a, idOf('USA 027'), { kind: 'leaders' })!;
    const at = (t: number) => l.points.find((p) => p.tMs === t)!.behindS!;
    expect(c.facts.d3S as number).toBeCloseTo(at(g.t1) - at(g.t0), 9);
    expect(c.t0).toBe(gun - 10_000);
    expect(c.t1).toBe(m.crossMs![idOf('USA 027')]! + 5 * 60_000);
    expect(windowChip(c, a)).toBe('10:04–10:10');
    // D3 no longer stands alone: it is the card's second half.
    expect(d.found.some((o) => o.kind === 'D3')).toBe(false);
    const t = cardText(c, a.meta.tzOffsetMs);
    expect(t.title).toBe('Second-row start');
    expect(t.chips).toEqual(['25 m back at gun', '11th of 15 over line', 'crossed +11 s', '3 early tacks']);
    expect(t.sentence).toMatch(
      /^You were 25 m back at the gun and 11th of 15 over the line; the front row crossed within 1 s of the gun\. Then 3 tacks in the first 9\d s looking for clear air \(the fleet tacked 0–1 times\) cost about 16 s more on the top 3\.$/,
    );
    expect(t.tip).toBe('Set up closer and time the final approach so you hit the line at the gun. From the second row, foot for clear air before tacking.');
    // The seconds chip: the D3 half leans on the wind across ~400 m, so the range shows (⚠ wind est.).
    expect(secondsChip(c)).toMatch(/^\d+–\d+ s$/);
    // The page and Ask Coach carry all four chips.
    const html = coachCardsHtml(a, d, null);
    for (const x of t.chips) expect(html).toContain(x);
    expect(askFinding(c, a).chips).toEqual(t.chips);
    // No ✓ start for it.
    expect(startTick('USA 027')).toBeUndefined();
    expect(html).not.toContain('✓ Start');
  });

  it('USA 22 (late, +10 s, 10th of 15), USA 023 (39 m back) and USA 020 (23 m back, +18 s) get start cards', () => {
    const late = startCard('USA 22')!;
    expect(late.variant).toBe('late'); // 19 m: under 2 lengths (22.6 m); 10 s after the front row
    expect(late.seconds).toBeGreaterThanOrEqual(8);
    expect(late.seconds).toBeLessThanOrEqual(12);
    expect(cardText(late).title).toBe('Late over the line');
    expect(late.facts).toMatchObject({ crossRank: 10, n: 15 });
    const back = startCard('USA 023')!;
    expect(back.variant).toBe('second-row');
    expect(back.seconds).toBeGreaterThanOrEqual(15);
    expect(back.seconds).toBeLessThanOrEqual(22);
    expect(back.facts).toMatchObject({ crossRank: 13, n: 15 });
    const c020 = startCard('USA 020')!;
    expect(c020.variant).toBe('second-row');
    expect(c020.facts.d3S).not.toBeNull(); // merged with its early lane
    expect(c020.seconds).toBeGreaterThanOrEqual(35);
    expect(c020.seconds).toBeLessThanOrEqual(55);
    for (const s of ['USA 22', 'USA 023', 'USA 020']) expect(startTick(s)).toBeUndefined();
  });

  it('USA 020: its Beat 1 D6 (from the gun) no longer hides the start; D6 is trimmed for the start window instead', () => {
    const d = debrief('USA 020');
    const found = d.found.find((o) => o.kind === 'D1')!;
    const d6 = d.found.find((o) => o.kind === 'D6')!;
    // D6's Beat 1 span starts before the start card's window ends.
    expect(d6.t0).toBeLessThan(found.t1);
    expect(d6.t1).toBeGreaterThan(found.t1);
    for (const cards of [d.cards, rankOpportunities(d.found, Infinity)]) {
      const c = cards.find((x) => x.kind === 'D1')!;
      expect(c.seconds).toBeCloseTo(found.seconds, 6); // never trimmed by D6
      const c6 = cards.find((x) => x.kind === 'D6')!;
      expect(c6.t0).toBeGreaterThanOrEqual(found.t1); // its Beat 1 span starts after the start window
      expect(c6.seconds).toBeLessThan(d6.seconds);
    }
    // The Regatta view counts it as a start finding.
    const digest = raceDigest(a, m, 'USA 020');
    expect(digest.findings.find((f) => f.kind === 'D1')).toMatchObject({ theme: 'start', variant: 'second-row' });
    expect(digest.findings.some((f) => f.kind === 'D3')).toBe(false);
  });

  it('the front row gets no start card; the ✓ start only for a genuine front-row start', () => {
    for (const s of ['GBR 015', 'USA 12', 'USA 005', 'USA 11', 'USA 008']) {
      expect(debrief(s).found.some((o) => o.kind === 'D1')).toBe(false);
    }
    // First third over (5 of 15: the OCS boats cross last, at their recross), ≤ 3 s after the front row, ≤ 1 length
    // back, not over at the gun: the front row itself.
    const ticked = a.boats.filter((b) => startTick(b.sail)).map((b) => b.sail).sort();
    expect(ticked).toEqual(['GBR 015', 'USA 005', 'USA 008', 'USA 11', 'USA 12']);
    expect(goodTexts(startTick('USA 12')!)).toEqual(['Start 1 m off the line at the gun']);
    // A ✓ start never sits beside a start card.
    for (const b of a.boats) if (startTick(b.sail)) expect(debrief(b.sail).cards.some((c) => c.kind === 'D1')).toBe(false);
  });

  it('Went well: no "crossed ahead of the top 3" for a boat whose D1 fired', () => {
    for (const s of ['USA 027', 'USA 22', 'USA 023', 'USA 020']) expect(debrief(s).plus.some((n) => n.detector === 'D1')).toBe(false);
  });
});
