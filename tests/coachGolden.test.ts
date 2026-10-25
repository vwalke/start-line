import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { LADDER_STEP_MS, buildCoach, coachWind, rivalLadder, type CoachModel, type RivalLadder } from '../src/analysis/coach';
import { groupIds } from '../src/analysis/coach/groups';
import { gapSeries, type GapPoint } from '../src/analysis/coach/ladder';
import { GROUP_DRAW_HOLE_S } from '../src/analysis/coach/timeGap';
import { COACH_MAX_SPAN_S, type CoachTrack } from '../src/analysis/coach/tracks';
import { coachChips, coachHeadHtml, coachLegendName, ladderBoatColor, ladderChart, ladderChips, ladderLegSpans } from '../src/ui/coach';
import { j105Race } from './helpers';

/**
 * The Good Trade debrief's gap checkpoints (2026 J/105 CBC, Oct 18, EDT = UTC−4), reproduced through
 * the app's own path: the worker's wind from the raw fixes (coachWind), the wind ladder on the drawn
 * tracks (ladder.ts gapSeries: same moment, along the wind; the detectors' gaps). Debrief: R1 about
 * 3 min after the gun ≈ 27–29 s behind Patriot; R3 Beat 2 vs the boats that finished 4th–9th, ≈ 67 s
 * ahead at 2:56 pm → ≈ 116 s behind by 2:59 pm. Tolerance ±10 s.
 *
 * The rival ladder chart compares at equal course progress (timeGap.ts) instead: up each leg's ladder
 * along one wind for the whole leg (its mean), so a shift within the leg isn't credited as it happens.
 * On R3 Beat 2 it has Good Trade behind the 4th–9th boats throughout, closest at 2:56 pm, then losing
 * about 1½ min more by 3 pm in the shift.
 */
const GT = 'USA 96';
const PATRIOT = 'USA 242';
/** Official R3 4th–9th (YachtScoring): Santas Reign Dear, Patriot, Relentless, Constellation, Smoke 'n Oakum, Dragonfly. */
const R3_4TH_9TH = ['USA 523', 'USA 242', 'USA 64', 'USA 215', 'USA 250', 'USA 343'];
const edt = (hhmmss: string): number => Date.parse(`2026-10-18T${hhmmss}-04:00`);

function setup(rn: 1 | 3) {
  const data = j105Race(rn);
  const a = analyzeRace(data);
  const model = buildCoach(a, coachWind(a, data))!;
  return { data, a, model };
}

/** The wind ladder (same moment) of Good Trade to `ids`, every LADDER_STEP_MS from the gun to the last fix. */
const windLadder = (m: CoachModel, ids: string[]): GapPoint[] =>
  gapSeries(m.course, m.wind, m.vmg, m.tracks.get(GT)!, ids.map((id) => m.tracks.get(id)).filter((x): x is CoachTrack => !!x), m.gunMs, m.endMs, LADDER_STEP_MS);

/** The points in the clock minute starting `hhmm` (EDT). */
const inMinute = (l: RivalLadder | GapPoint[], hhmm: string) =>
  ('points' in l ? l.points : l).filter((p) => p.tMs >= edt(`${hhmm}:00`) && p.tMs < edt(`${hhmm}:00`) + 60_000 && p.behindS != null);

describe('Coach golden: the Good Trade debrief checkpoints', () => {
  const r1 = setup(1);
  const r3 = setup(3);

  it('R1: 3 min after the gun (11:05 EDT), Good Trade ≈ 27–29 s behind Patriot (the wind ladder and the chart)', () => {
    const w = windLadder(r1.model, [PATRIOT]);
    // Got 28.6 s (Python prototype on the full data 28.8 s).
    expect(Math.abs(w.find((q) => q.tMs === r1.a.meta.gunMs + 180_000)!.behindS! - 28)).toBeLessThanOrEqual(10);
    // Even at the gun.
    expect(Math.abs(w.find((q) => q.tMs === r1.a.meta.gunMs + 30_000)!.behindS!)).toBeLessThan(5);
    // The chart, at equal progress: 27.6 s at 3 min; 3.6 s at 30 s (Patriot reached each point of the line's
    // first metres a few seconds sooner).
    const l = rivalLadder(r1.model, r1.a, GT, { kind: 'custom', ids: [PATRIOT] })!;
    expect(Math.abs(l.points.find((q) => q.tMs === r1.a.meta.gunMs + 180_000)!.behindS! - 28)).toBeLessThanOrEqual(10);
    expect(Math.abs(l.points.find((q) => q.tMs === r1.a.meta.gunMs + 30_000)!.behindS!)).toBeLessThan(10);
    // Patriot is the R1 winner, so the default group (top 3) leads with him.
    expect(groupIds(r1.a.boats, GT, { kind: 'leaders' })[0]).toBe(PATRIOT);
  });

  it('R3 Beat 2, the wind ladder: ≈ 67 s ahead of the 4th–9th boats at 2:56 pm, ≈ 116 s behind by 2:59 pm', () => {
    expect(r3.a.meta.gunMs).toBe(edt('14:10:01'));
    const l = windLadder(r3.model, R3_4TH_9TH);
    // 2:56 pm: −68.7 s (ahead) at 14:56:01. Python on the full data: −68.4.
    const at256 = inMinute(l, '14:56');
    expect(at256[0].tMs).toBe(edt('14:56:01'));
    expect(at256[0].behindS!).toBeGreaterThanOrEqual(-67 - 10);
    expect(at256[0].behindS!).toBeLessThanOrEqual(-67 + 10);
    // By 2:59 pm: 104 s at 14:59:01, 110 s at 14:59:11, then a hole. Python: 110.9 at 14:59:01.
    const by259 = Math.max(...inMinute(l, '14:59').map((p) => p.behindS!));
    expect(by259).toBeGreaterThanOrEqual(116 - 10);
    expect(by259).toBeLessThanOrEqual(116 + 10);
    // All on Beat 2.
    expect(at256[0].leg).toBe(2);
    expect(r3.a.legs[2].name).toBe('Beat 2');
  });

  it('R3 Beat 2, the chart (equal progress): ≈ 12 s behind the 4th–9th boats at 2:56 pm, ≈ 98 s by 2:59 pm', () => {
    const l = rivalLadder(r3.model, r3.a, GT, { kind: 'custom', ids: R3_4TH_9TH })!;
    expect(l.group).toEqual(R3_4TH_9TH.slice().sort((x, y) => r3.a.boats.findIndex((b) => b.id === x) - r3.a.boats.findIndex((b) => b.id === y)));
    // 12.5 s at 14:56:01 (along the rhumb line it was 24 s); 78.8 s at 14:59:11, 97.7 s at 14:59:51 across two short holes.
    const at256 = inMinute(l, '14:56');
    expect(at256[0].tMs).toBe(edt('14:56:01'));
    expect(Math.abs(at256[0].behindS! - 12)).toBeLessThanOrEqual(10);
    expect(Math.abs(Math.max(...inMinute(l, '14:59').map((p) => p.behindS!)) - 98)).toBeLessThanOrEqual(10);
    expect(at256[0].leg).toBe(2);
  });

  it('R3: after 14:59:11 the thin lines break and the bold line reads across holes of GROUP_DRAW_HOLE_S at most; thin values sit in whole stretches of real fixes of both boats', () => {
    const l = rivalLadder(r3.model, r3.a, GT, { kind: 'custom', ids: R3_4TH_9TH })!;
    const after = l.points.filter((p) => p.tMs > edt('14:59:12') && p.tMs < edt('15:00:06'));
    expect(after.every((p) => p.each.every((g) => g == null))).toBe(true);
    const gt = r3.model.tracks.get(GT)!;
    /** `x` is a fix, or between two at most `span` s apart. */
    const whole = (t: Float64Array, x: number, span = COACH_MAX_SPAN_S): boolean => {
      let i = 0;
      while (i < t.length - 1 && t[i + 1] <= x) i++;
      return t[i] === x || (t[i] < x && i + 1 < t.length && t[i + 1] - t[i] <= span * 1000);
    };
    // Good Trade's fixes there are 21 s and 28 s apart: the bold line reads across them, nothing longer.
    expect(after.every((p) => p.behindS != null && whole(gt.t, p.tMs, GROUP_DRAW_HOLE_S))).toBe(true);
    for (const p of l.points) {
      if (p.behindS != null) expect(whole(gt.t, p.tMs, GROUP_DRAW_HOLE_S)).toBe(true);
      // The group boat got as far as Good Trade is at p.tMs at p.tMs − gap: inside its own fixes then.
      p.each.forEach((g, k) => {
        if (g == null) return;
        expect(whole(gt.t, p.tMs)).toBe(true);
        expect(whole(r3.model.tracks.get(l.group[k])!.t, Math.round(p.tMs - g * 1000))).toBe(true);
      });
    }
  });

  it('the wind: Good Trade (compass replaced by its course) stays out; the R3 shift right on Beat 2 shows (≈ 12° → 24°)', () => {
    expect(r3.model.windExcluded).toEqual([GT]);
    expect(r3.model.wind.twdAt(edt('14:56:01'))).toBeGreaterThan(9);
    expect(r3.model.wind.twdAt(edt('14:56:01'))).toBeLessThan(15);
    expect(r3.model.wind.twdAt(edt('14:59:01'))).toBeGreaterThan(21);
    expect(r3.model.wind.twdAt(edt('14:59:01'))).toBeLessThan(28);
  });

  it('without the worker (drawn ~1 Hz tracks only) the same checkpoints come out close', () => {
    // The ~1 Hz drawing blurs the fleet's tack clusters, so the tack angle (and so whether Good Trade is past the
    // layline at 2:56) shifts: about −55 s there rather than −68. Still the same story.
    const m = buildCoach(r3.a)!;
    const w = windLadder(m, R3_4TH_9TH);
    expect(inMinute(w, '14:56')[0].behindS!).toBeLessThan(-35);
    expect(Math.max(...inMinute(w, '14:59').map((p) => p.behindS!))).toBeGreaterThan(95);
    const m1 = buildCoach(r1.a)!;
    const w1 = windLadder(m1, [PATRIOT]);
    expect(Math.abs(w1.find((q) => q.tMs === r1.a.meta.gunMs + 180_000)!.behindS! - 28)).toBeLessThanOrEqual(10);
    // The chart reads the wind only as each leg's mean direction: within a few seconds with or without the worker.
    const p0 = rivalLadder(m, r3.a, GT, { kind: 'custom', ids: R3_4TH_9TH })!.points;
    const p1 = rivalLadder(r3.model, r3.a, GT, { kind: 'custom', ids: R3_4TH_9TH })!.points;
    expect(p0.length).toBe(p1.length);
    p0.forEach((p, i) => {
      if (p.behindS != null && p1[i].behindS != null) expect(Math.abs(p.behindS - p1[i].behindS!)).toBeLessThan(3);
    });
  });
});

describe('Coach tab on the fixtures', () => {
  const { a, model } = setup(1);
  const gt = a.boats.find((b) => b.id === GT)!;
  const l = rivalLadder(model, a, GT, { kind: 'leaders' })!;

  it('header chips: no tracked finish, gun 11:05 venue time, ⚠ tracker %, the longest hole (a plain chip), ⚠ heading from GPS course', () => {
    const chips = coachChips(a, gt, l);
    const text = chips.map((c) => (c.warn ? `⚠ ${c.text}` : c.text));
    expect(text[0]).toBe('⚠ no tracked finish');
    expect(text[1]).toBe('gun 11:05');
    expect(text.some((t) => /^⚠ tracker \d+%$/.test(t))).toBe(true);
    expect(text.some((t) => /^no data \d\d:\d\d–\d\d:\d\d$/.test(t))).toBe(true);
    expect(text).toContain('⚠ heading from GPS course');
    // One line of chips, the ⓘ closed.
    const html = coachHeadHtml(chips);
    expect(html).toContain('<details class="info">');
    expect(html.match(/<ul class="chips">/g)).toHaveLength(1);
  });

  it('the chart: the median and each group boat, breaks at holes (several runs), roundings, the wind strip', () => {
    const svg = ladderChart(a, model, l, { kind: 'leaders' }, { widthPx: 900 });
    const med = svg.match(/class="cl-med" d="([^"]*)"/)![1];
    expect((med.match(/M/g) ?? []).length).toBeGreaterThan(1);
    expect(svg.match(/class="cl-each"/g)).toHaveLength(l.group.length);
    expect(svg).not.toContain('cl-nodata');
    expect(svg.match(/class="cl-mark"/g)!.length).toBe(l.roundings.length);
    expect(svg).not.toContain('cl-mark-lbl');
    expect(svg).toContain('▲ s ahead');
    expect(svg).toContain('▼ s behind');
    expect(svg).toContain('Wind from, ° (fleet est.)');
    expect(svg).toContain('>11:10<');
    // Phone width still draws.
    expect(ladderChart(a, model, l, { kind: 'leaders' }, { widthPx: 340, each: false })).not.toContain('cl-each');
    const chips = ladderChips(a, l, { kind: 'leaders' }, true);
    expect(chips[0]).toMatchObject({ text: '#USA 96 vs top 3 (mean)', swatch: 'bold' });
    expect(chips.some((c) => c.text === 'no data')).toBe(false);
  });

  it('R3 W/L: one centred leg label per course leg, from the gun to the finish; rounding lines are unlabelled', () => {
    const { a: a3, model: m3 } = setup(3);
    expect(a3.legs.map((x) => x.name)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    const l3 = rivalLadder(m3, a3, GT, { kind: 'leaders' })!;
    const svg = ladderChart(a3, m3, l3, { kind: 'leaders' }, { widthPx: 900 });
    const labels = [...svg.matchAll(/class="cl-leg-lbl"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(svg.match(/class="cl-leg-lbl"/g)).toHaveLength(a3.legs.length);
    expect(svg).not.toMatch(/class="cl-leg-lbl"[^>]*>Windward/);
    expect(svg).not.toMatch(/class="cl-leg-lbl"[^>]*>Leeward/);
    const spans = ladderLegSpans(a3.legs, a3.meta.gunMs, l3.roundings, l3.points[l3.points.length - 1].tMs);
    expect(spans).toHaveLength(4);
    expect(spans[0].fromMs).toBe(a3.meta.gunMs);
    expect(spans[3].toMs).toBe(l3.points[l3.points.length - 1].tMs);
  });

  it('the reference set is the finish-order top 3 on every leg, each with one stable colour', () => {
    const { a: a3, model: m3 } = setup(3);
    const finishers = a3.boats.filter((b) => b.id !== GT && b.finishPos != null).sort((p, q) => p.finishPos! - q.finishPos!);
    const want = finishers.slice(0, 3).map((b) => b.id);
    expect(groupIds(a3.boats, GT, { kind: 'leaders' })).toEqual(want);
    const mid = a3.boats.map((b) => ({ ...b, legs: b.legs.map((x) => (x ? { ...x, rankAtEnd: 1 } : null)) }));
    expect(groupIds(mid, GT, { kind: 'leaders' })).toEqual(want);
    const l3 = rivalLadder(m3, a3, GT, { kind: 'leaders' })!;
    expect(l3.group).toEqual(want);
    expect(l3.points.every((p) => p.each.length === want.length)).toBe(true);
    const svg = ladderChart(a3, m3, l3, { kind: 'leaders' }, { widthPx: 900 });
    const strokes = new Map(
      [...svg.matchAll(/class="cl-each" data-boat="([^"]+)"[^>]*stroke="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    expect([...strokes.keys()]).toEqual(want);
    for (const id of want) expect(strokes.get(id)).toBe(ladderBoatColor(id, want));
    expect(new Set(strokes.values()).size).toBe(want.length);
    const chips = ladderChips(a3, l3, { kind: 'leaders' }, true);
    const named = chips.filter((c) => c.swatch === 'line');
    expect(named.map((c) => c.swatchColor)).toEqual(want.map((id) => ladderBoatColor(id, want)));
    expect(named.map((c) => c.text)).toEqual(want.map((id) => coachLegendName(a3.boats.find((b) => b.id === id)!)));
  });

  it('an empty custom group says what to do instead of drawing', () => {
    const empty = rivalLadder(model, a, GT, { kind: 'custom', ids: [] })!;
    expect(ladderChart(a, model, empty, { kind: 'custom', ids: [] })).toContain('Tick boats under Custom');
  });
});
